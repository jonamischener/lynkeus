import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Fixtures } from '../cases/fixtures.js';
import { readCases } from '../cases/format.js';
import { type CaseReport, runCase } from '../cases/runner.js';
import { CONFIG, EXAMPLE_CASE, FIXTURES, FORMAT } from '../cases/templates.js';
import { configFile } from '../config.js';
import { readJson, writeJson } from '../files.js';
import { eventsFile } from '../knowledge/events.js';
import { define } from '../registry.js';

const startHost = async (root: string, err: (line: string) => void): Promise<ChildProcess> => {
  // Its own process group: the host starts a test runner of its own, and stopping one without the other leaves an app dialing in.
  const host = spawn(process.execPath, [process.argv[1]!, 'headless', 'start'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const tail = (n: number) => output.trim().split('\n').slice(-n).join(' · ');
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error(`the host did not come up within 180 s: ${tail(3)}`)), 180_000);
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4000);
      if (/waiting for a driver/.test(output)) settle();
      else if (/Test suite failed/.test(output)) settle(new Error(`the host failed to start: ${tail(5)}`));
    };
    host.stdout?.on('data', read);
    host.stderr?.on('data', read);
    host.once('exit', (code) => settle(new Error(`the host exited (${code}): ${tail(3)}`)));
  });
  err('host: up');
  return host;
};

const stopGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
};

const describe = (report: CaseReport): string => {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const s of report.steps) counts[s.status] += 1;
  const lines = [
    `${report.result === 'passed' ? '✅ PASSED' : '❌ FAILED'}  ✅ ${counts.passed}${counts.failed ? `  ❌ ${counts.failed}` : ''}${counts.skipped ? `  ⏭️ ${counts.skipped}` : ''}  — ${(report.ms / 1000).toFixed(1)}s`,
  ];
  if (report.evidence?.screen) lines.push('— screen at the failure:', ...report.evidence.screen.split('\n').map((l) => `    ${l}`));
  if (report.evidence?.requests?.length) lines.push('— requests:', ...report.evidence.requests.map((l) => `    ${l}`));
  if (report.evidence?.why) lines.push('— why:', ...report.evidence.why.split('\n').map((l) => `    ${l}`));
  return lines.join('\n');
};

export const caseCommands = [
  define({
    name: 'case run',
    group: 'runs',
    summary: 'Run cases: setup through fixtures, steps against the app, the evidence when one fails',
    details:
      'A case is a markdown file with `setup`, `steps` and `expected` (`lynkeus case init` writes an example and the reference). Without files, every case in `cases.dir`. A failed case runs once more before it counts as failed, unless `--once`. `--host` hosts the app in Node for the run.',
    positionals: [{ name: 'files', help: 'case files (default: every .md under cases.dir)', rest: true }],
    flags: {
      host: { type: 'boolean', help: 'start `headless start` for the run and stop it after' },
      once: { type: 'boolean', help: 'no second chance for a case that fails' },
      report: { type: 'string', help: 'append one JSON line per case', value: 'file' },
      events: { type: 'string', help: 'keep what the app told its analytics, per case, as <dir>/<case id>/events.jsonl', value: 'dir' },
      'dry-run': { type: 'boolean', help: 'parse and list the steps without running them' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      const home = config.base ?? ctx.root;
      const dir = path.resolve(home, config.dir ?? 'cases');
      const files = ctx.args.length
        ? ctx.args.map((f) => path.resolve(f))
        : fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.md') && !/^(README|FORMAT|CATALOG)\.md$/i.test(f) && !f.startsWith('.'))
              .sort()
              .map((f) => path.join(dir, f))
          : [];
      if (files.length === 0) return { text: `no cases under ${path.relative(ctx.root, dir) || '.'}; \`lynkeus case init\` writes one`, code: 1 };
      const cases = files.flatMap(readCases);
      const dry = !!ctx.flags['dry-run'];
      const events = typeof ctx.flags.events === 'string';
      const host = ctx.flags.host && !dry ? await startHost(ctx.root, ctx.err) : undefined;
      const fixtures = config.fixtures && !dry ? new Fixtures(config.fixtures, home) : undefined;
      const stop = () => {
        fixtures?.close();
        if (host?.pid) stopGroup(host.pid);
      };
      const interrupted = () => {
        stop();
        process.exit(130);
      };
      process.once('SIGINT', interrupted);
      process.once('SIGTERM', interrupted);
      const reports: (CaseReport & { retried?: boolean })[] = [];
      try {
        for (const c of cases) {
          ctx.err(`▶ ${c.id}${c.title ? ` — ${c.title}` : ''}`);
          let report: CaseReport & { retried?: boolean } = await runCase(c, { base: ctx, config, fixtures, dry, events, log: ctx.err });
          ctx.err(describe(report));
          if (report.result === 'failed' && !ctx.flags.once && !dry) {
            ctx.err(`  retrying ${c.id} once`);
            report = { ...(await runCase(c, { base: ctx, config, fixtures, events, log: ctx.err })), retried: true };
            ctx.err(describe(report));
          }
          if (events && report.events) {
            const out = path.resolve(ctx.flags.events as string, c.id);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(eventsFile(out), report.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
          }
          reports.push(report);
          if (ctx.flags.report) fs.appendFileSync(path.resolve(ctx.flags.report as string), `${JSON.stringify(report)}\n`);
        }
      } finally {
        stop();
      }
      const passed = reports.filter((r) => r.result === 'passed').length;
      const summary = [
        ...reports.map((r) => `${r.result === 'passed' ? '✅' : '❌'} ${r.id}${r.retried && r.result === 'passed' ? '  ⚠ passed on retry' : ''}`),
        `${passed}/${reports.length} passed`,
      ].join('\n');
      return { text: summary, json: reports, code: passed === reports.length ? 0 : 1 };
    },
  }),
  define({
    name: 'case init',
    group: 'runs',
    summary: 'Write an example case, the reference of the format and a fixtures server to start from',
    flags: { force: { type: 'boolean', help: 'overwrite what is there' } },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const dir = path.resolve(ctx.root, ctx.config.cases?.dir ?? 'cases');
      fs.mkdirSync(dir, { recursive: true });
      const notes: string[] = [];
      const write = (file: string, content: string) => {
        if (fs.existsSync(file) && !ctx.flags.force) return notes.push(`kept ${path.relative(ctx.root, file)}`);
        fs.writeFileSync(file, content);
        notes.push(`wrote ${path.relative(ctx.root, file)}`);
      };
      write(path.join(dir, 'example.md'), EXAMPLE_CASE);
      write(path.join(dir, 'README.md'), FORMAT);
      write(path.join(dir, 'fixtures.mjs'), FIXTURES);
      const file = configFile(ctx.root);
      if (ctx.config.cases && !ctx.flags.force) notes.push('kept cases in lynkeus.config.json');
      else {
        const current = fs.existsSync(file) ? readJson<Record<string, unknown>>(file) : {};
        writeJson(file, { ...current, cases: { ...CONFIG, dir: path.relative(ctx.root, dir) } });
        notes.push('added cases to lynkeus.config.json');
      }
      notes.push('next: `lynkeus case run cases/example.md --dry-run`, then make fixtures.mjs talk to your backend');
      return { text: notes.join('\n'), json: { dir } };
    },
  }),
];
