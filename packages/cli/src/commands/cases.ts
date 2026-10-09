import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Fixtures } from '../cases/fixtures.js';
import { readCases } from '../cases/format.js';
import { type CaseReport, missingFixtures, preparable, runCase } from '../cases/runner.js';
import { CONFIG, EXAMPLE_CASE, FIXTURES, FORMAT } from '../cases/templates.js';
import { configFile } from '../config.js';
import { readJson, writeJson } from '../files.js';
import { Ahead } from '../cases/ahead.js';
import { Flakes } from '../cases/flakes.js';
import { RunFile } from '../cases/runfile.js';
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
  const counts = { passed: 0, failed: 0, skipped: 0, unsupported: 0 };
  for (const s of report.steps) counts[s.status] += 1;
  const headline = { passed: '✅ PASSED', failed: '❌ FAILED', unsupported: '🚫 NOT ON THIS HOST' }[report.result];
  const lines = [
    `${headline}  ✅ ${counts.passed}${counts.failed ? `  ❌ ${counts.failed}` : ''}${counts.unsupported ? `  🚫 ${counts.unsupported}` : ''}${counts.skipped ? `  ⏭️ ${counts.skipped}` : ''}  — ${(report.ms / 1000).toFixed(1)}s`,
  ];
  if (report.evidence?.screen) lines.push('— screen at the failure:', ...report.evidence.screen.split('\n').map((l) => `    ${l}`));
  if (report.evidence?.requests?.length) lines.push('— requests:', ...report.evidence.requests.map((l) => `    ${l}`));
  if (report.evidence?.why) lines.push('— why:', ...report.evidence.why.split('\n').map((l) => `    ${l}`));
  return lines.join('\n');
};

/** The share of the machine's CPU that sat idle over the next 300 ms. */
const idleShare = async (): Promise<number> => {
  const total = () =>
    os.cpus().reduce(
      (sum, cpu) => {
        const t = cpu.times;
        return { idle: sum.idle + t.idle, all: sum.all + t.idle + t.user + t.sys + t.nice + t.irq };
      },
      { idle: 0, all: 0 },
    );
  const before = total();
  await new Promise((r) => setTimeout(r, 300));
  const after = total();
  return after.all > before.all ? (after.idle - before.idle) / (after.all - before.all) : 1;
};

/** The case files named, or every case under the cases directory; a sentence when there are none. */
const caseFiles = (args: string[], home: string, casesDir: string | undefined): string[] | string => {
  const dir = path.resolve(home, casesDir ?? 'cases');
  const files = args.length
    ? args.map((f) => path.resolve(f))
    : fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md') && !/^(README|FORMAT|CATALOG)\.md$/i.test(f) && !f.startsWith('.'))
          .sort()
          .map((f) => path.join(dir, f))
      : [];
  return files.length > 0 ? files : `no cases under ${path.relative(home, dir) || '.'}; \`lynkeus case init\` writes one`;
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
      out: { type: 'string', help: 'write the run as a directory a report can read: run.json and cases.jsonl, a line per attempt', value: 'dir' },
      screenshots: { type: 'boolean', help: 'with --out: a frame of the screen after every step of the app' },
      video: { type: 'boolean', help: 'with --out: film each case, where the host films (the step says at what second it began)' },
      'video-fps': { type: 'number', help: 'frames per second of the film', default: 30, value: 'n' },
      flakes: { type: 'string', help: 'the ledger of how each case did across runs (default .lynkeus/flakes.json)', value: 'file' },
      prepared: { type: 'string', help: 'where `case prepare` leaves setups made ahead; a case found there skips its setup', value: 'dir' },
      'dry-run': { type: 'boolean', help: 'parse and list the steps without running them' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      const home = config.base ?? ctx.root;
      const files = caseFiles(ctx.args, home, config.dir);
      if (typeof files === 'string') return { text: files, code: 1 };
      const cases = files.flatMap(readCases);
      const dry = !!ctx.flags['dry-run'];
      const out = typeof ctx.flags.out === 'string' && !dry ? new RunFile(path.resolve(ctx.flags.out), ctx.root) : undefined;
      if ((ctx.flags.screenshots || ctx.flags.video) && !out)
        return { text: '--screenshots and --video keep what they take in the run directory: add --out <dir>', code: 2 };
      const evidenceOf = (id: string, attempt: number) =>
        out && (ctx.flags.screenshots || ctx.flags.video)
          ? {
              dir: out.evidenceDir(id, attempt),
              screenshots: !!ctx.flags.screenshots,
              ...(ctx.flags.video ? { video: { fps: Number(ctx.flags['video-fps'] ?? 30) } } : {}),
            }
          : undefined;
      const ahead = typeof ctx.flags.prepared === 'string' && !dry ? new Ahead(path.resolve(ctx.flags.prepared)) : undefined;
      const ledger = dry ? undefined : new Flakes(path.resolve(ctx.root, typeof ctx.flags.flakes === 'string' ? ctx.flags.flakes : '.lynkeus/flakes.json'));
      // A run file files each event under its step, so it needs them collected.
      const events = typeof ctx.flags.events === 'string' || out !== undefined;
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
        // A case that names a fixture the server does not have fails halfway, after it has changed the backend. Better not to start.
        const described = await fixtures?.describe();
        if (described) {
          const missing = cases.flatMap((c) => missingFixtures(c, config, described.commands).map((name) => `${c.id}: no fixture ${name}`));
          if (missing.length > 0) return { text: [...missing, `the fixtures command answers: ${described.commands.join(', ')}`].join('\n'), code: 1 };
        }
        for (const c of cases) {
          ctx.err(`▶ ${c.id}${c.title ? ` — ${c.title}` : ''}`);
          let startedAt = new Date();
          ahead?.start(c);
          let report: CaseReport & { retried?: boolean } = await runCase(c, {
            base: ctx,
            config,
            fixtures,
            dry,
            events,
            evidence: evidenceOf(c.id, 1),
            log: ctx.err,
            prepared: ahead?.take(c),
          });
          ctx.err(describe(report));
          out?.add(c, { report, attempt: 1, startedAt });
          if (report.result === 'failed' && !ctx.flags.once && !dry) {
            ctx.err(`  retrying ${c.id} once`);
            startedAt = new Date();
            report = { ...(await runCase(c, { base: ctx, config, fixtures, events, evidence: evidenceOf(c.id, 2), log: ctx.err })), retried: true };
            ctx.err(describe(report));
            out?.add(c, { report, attempt: 2, startedAt });
          }
          ledger?.note(report);
          if (typeof ctx.flags.events === 'string' && report.events) {
            const out = path.resolve(ctx.flags.events as string, c.id);
            fs.mkdirSync(out, { recursive: true });
            fs.writeFileSync(eventsFile(out), report.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
          }
          reports.push(report);
          if (ctx.flags.report) fs.appendFileSync(path.resolve(ctx.flags.report as string), `${JSON.stringify(report)}\n`);
        }
        if (out) {
          const hello = (await ctx.device().catch(() => undefined))?.server.hello;
          out.finish({ platform: hello?.platform, native: hello?.native });
        }
      } finally {
        stop();
      }
      const count = (result: CaseReport['result']) => reports.filter((r) => r.result === result).length;
      const unsupported = count('unsupported');
      const summary = [
        ...reports.map(
          (r) => `${{ passed: '✅', failed: '❌', unsupported: '🚫' }[r.result]} ${r.id}${r.retried && r.result === 'passed' ? '  ⚠ passed on retry' : ''}`,
        ),
        `${count('passed')}/${reports.length} passed${unsupported ? `, ${unsupported} cannot run on this host` : ''}`,
        ...(ledger ? ledger.flaky(reports.map((r) => r.id)) : []),
      ].join('\n');
      ledger?.save();
      // A case this host cannot run is not a failure of the app; only a failed case fails the run.
      return { text: summary, json: reports, code: count('failed') === 0 ? 0 : 1 };
    },
  }),
  define({
    name: 'case prepare',
    group: 'runs',
    summary: 'Run the setup of cases ahead of them, so each starts at its first step',
    details:
      'For a suite that starts `case run --prepared <dir>` once per case: start this first, with the same cases in the order they will run, and leave it running. It runs every setup made only of the project fixtures and leaves what each produced in <dir>; a case that starts before its setup is ready runs its own, and this skips it. It asks the fixtures server for a lower priority (`lynkeus.ahead`), so it takes what the running cases leave of the machine.',
    positionals: [{ name: 'files', help: 'case files, in the order they will run (default: every .md under cases.dir)', rest: true }],
    flags: {
      prepared: { type: 'string', help: 'where to leave the setups (emptied first)', value: 'dir', default: '.lynkeus/prepared' },
      jobs: { type: 'number', help: 'setups made at once', value: 'n', default: 1 },
      ahead: { type: 'number', help: 'setups kept ready and not yet taken, at most', value: 'n', default: 4 },
      idle: { type: 'number', help: 'start a setup only while at least this share of the CPU is idle (0 to 1)', value: 'share', default: 0.25 },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      if (!config.fixtures) return { text: 'the project declares no fixtures (cases.fixtures in lynkeus.config.json): nothing to prepare', code: 1 };
      const declared = config.fixtures;
      const home = config.base ?? ctx.root;
      const files = caseFiles(ctx.args, home, config.dir);
      if (typeof files === 'string') return { text: files, code: 1 };
      const cases = files.flatMap(readCases).filter((c) => preparable(c, config));
      const ahead = new Ahead(path.resolve(ctx.root, String(ctx.flags.prepared ?? '.lynkeus/prepared')));
      ahead.clear();
      const limit = Math.max(1, Number(ctx.flags.ahead ?? 4));
      const idle = Number(ctx.flags.idle ?? 0.25);
      let next = 0;
      let made = 0;
      let skipped = 0;
      const worker = async () => {
        const fixtures = new Fixtures(declared, home);
        await fixtures.ahead();
        try {
          for (let c = cases[next++]; c; c = cases[next++]) {
            // Far enough ahead, or the machine busy: a setup made then only takes the CPU from the cases
            // running now, and the suite gains nothing from having it early.
            while (!ahead.started(c) && (ahead.waiting() >= limit || (await idleShare()) < idle));
            if (ahead.started(c)) {
              skipped++;
              continue;
            }
            const done = c;
            await runCase(done, { base: ctx, config, fixtures, setupOnly: { keep: (p) => ahead.keep(done, p) } });
            made++;
          }
        } finally {
          fixtures.close();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Number(ctx.flags.jobs ?? 2)) }, worker));
      return { text: `${made} setups made ahead, ${skipped} cases had started first`, json: { made, skipped } };
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
