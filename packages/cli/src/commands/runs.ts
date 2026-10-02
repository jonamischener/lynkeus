import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { Screen, TraceEvent } from 'lynkeus-protocol';

import { pairs, splitLine } from '../args.js';
import { anyOf, edgesFile, frontierFile, loadGraph, lynkeusDir, runsDir } from '../config.js';
import { describeScreen } from '../device/driver.js';
import { readJson, stamp, writeJson } from '../files.js';
import { describeDiff, diffScreens } from '../flow/artifacts.js';
import { runFlow } from '../flow/runner.js';
import type { Flow } from '../flow/types.js';
import * as edges from '../knowledge/edges.js';
import { describeEvents, eventsFiles, normalizeEvents, readEvents, resolveEventsFile } from '../knowledge/events.js';
import * as frontier from '../knowledge/frontier.js';
import { checkFunnel, describeEventsDiff, describeFunnel, diffEvents, funnelCoverage, listFunnels, loadFunnel } from '../knowledge/funnels.js';
import { plan } from '../knowledge/plan.js';
import { describeTreeDiff, diffTrees, screenTree } from '../knowledge/tree.js';
import { type Ctx, define } from '../registry.js';
import { execute } from '../runtime.js';
import { parseTarget } from '../targets.js';
import { crawl } from './crawl.js';
import { describeFlake, summarizeRuns } from './flake.js';
import type { Overlay } from './overlay.js';
import { describeEvent, draftFlow } from './record.js';
import { smoke } from './smoke.js';
import { baselinePath, describeSnapshot, snapshot } from './snapshot.js';

const VAR_FLAG = { var: { type: 'list' as const, help: 'a flow variable (repeatable)', value: 'k=v' } };

const OVERLAY_FLAGS = {
  'overlay-when': { type: 'string' as const, help: 'a target the app raises on its own (a lock screen, a rating prompt)', value: 'target' },
  'overlay-flow': { type: 'string' as const, help: 'the flow that clears it', value: 'flow.json' },
};

const overlayOf = (flags: Ctx['flags']): Overlay | undefined =>
  flags['overlay-when'] && flags['overlay-flow']
    ? { when: parseTarget(flags['overlay-when'] as string), flow: readJson<Flow>(flags['overlay-flow'] as string) }
    : undefined;

const varsOf = (flags: Ctx['flags']) => pairs(flags.var as string[] | undefined);

const seconds = (since: number) => Math.round((performance.now() - since) / 1000);

const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');

export const runsCommands = [
  define({
    name: 'run',
    group: 'runs',
    summary: 'Replay a flow with variables; per-step timing, route and errors',
    positionals: [{ name: 'flow.json', help: 'the flow file', required: true }],
    flags: {
      ...VAR_FLAG,
      screenshots: { type: 'boolean', help: 'one capture per step' },
      diff: { type: 'boolean', help: 'print what changed on screen after each step' },
      events: { type: 'boolean', help: "keep the app's analytics events per step (runs/…/events.jsonl); empties its buffer" },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const flow = readJson<Flow>(ctx.args[0]!);
      ctx.err(`\n${flow.name}\n`);
      let previous: Screen | undefined;
      const report = await runFlow(flow, {
        device,
        vars: varsOf(ctx.flags),
        artifactsRoot: runsDir(ctx.root),
        screenshots: !!ctx.flags.screenshots,
        events: !!ctx.flags.events,
        onStep: (r, i) => {
          const [label, value] = Object.entries(r.step)[0]!;
          ctx.err(
            `  ${r.ok ? '✓' : '✗'} ${String(i + 1).padStart(2)} ${String(r.ms).padStart(6)}ms  ${label} ${JSON.stringify(value).slice(0, 70)}${r.route ? `  → ${r.route}` : ''}${r.error ? `\n       ${r.error}` : ''}`,
          );
          for (const e of r.events ?? []) ctx.err(`       event ${e.name}${e.props ? ` ${JSON.stringify(e.props)}` : ''}`);
          if (ctx.flags.diff && r.screen && previous) {
            const lines = describeDiff(diffScreens(previous, r.screen));
            if (lines !== '(no structural change)') ctx.err(indent(lines, '         '));
          }
          if (r.screen) previous = r.screen;
        },
      });
      const setup = report.steps.filter((r) => 'launch' in r.step).reduce((n, r) => n + r.ms, 0);
      ctx.err(
        `\n  ${report.ok ? 'PASSED' : 'FAILED'} in ${report.totalMs}ms (${report.steps.length}/${flow.steps.length} steps): launch ${setup}ms, driving the app ${report.totalMs - setup}ms${report.dir ? `\n  artifacts: ${report.dir}` : ''}\n`,
      );
      if (!report.ok && device.server.connected) ctx.err(describeScreen(await device.screen()));
      return { text: '', json: { ok: report.ok, steps: report.steps.length, ms: report.totalMs, dir: report.dir }, code: report.ok ? 0 : 1 };
    },
  }),
  define({
    name: 'events',
    group: 'runs',
    summary: 'What the app told its analytics: live, or step by step in a run',
    details:
      'Without `--run`, what the app has recorded so far (its `events` command, left as it is). With `--run <dir>` or `--run last`, the events a `run --events` kept, each with the step and route it happened on.',
    flags: {
      run: { type: 'string', help: 'a run folder, or `last`', value: 'dir' },
      name: { type: 'string', help: 'only events whose name matches', value: 'regex' },
    },
    needs: 'nothing',
    run: async (ctx) => {
      const match = typeof ctx.flags.name === 'string' ? new RegExp(ctx.flags.name) : undefined;
      const wanted = <T extends { name: string }>(list: T[]) => list.filter((e) => !match || match.test(e.name));
      if (ctx.flags.run) {
        const file = resolveEventsFile(runsDir(ctx.root), ctx.flags.run as string);
        if (!file || !fs.existsSync(file)) return { text: 'no events recorded for that run (run a flow with --events)', code: 1 };
        const list = wanted(readEvents(file));
        return { text: describeEvents(list) || '(none)', json: list };
      }
      const list = wanted(normalizeEvents(await (await ctx.device()).command('events')));
      return { text: list.map((e) => `${e.name}${e.props ? ` ${JSON.stringify(e.props)}` : ''}`).join('\n') || '(none)', json: list };
    },
  }),
  define({
    name: 'events diff',
    group: 'runs',
    summary: 'The same flow on two builds: events that appeared, disappeared or changed shape',
    positionals: [
      { name: 'before', help: 'a run folder (main)', required: true },
      { name: 'after', help: 'a run folder (the branch), or `last`', required: true },
    ],
    needs: 'nothing',
    run: async (ctx) => {
      const [a, b] = ctx.args.map((ref) => resolveEventsFile(runsDir(ctx.root), ref));
      if (!a || !b || !fs.existsSync(a) || !fs.existsSync(b)) return { text: 'both runs need events (run the flow with --events)', code: 1 };
      const diff = diffEvents(readEvents(a), readEvents(b));
      return { text: describeEventsDiff(diff), json: diff, code: diff.lost.length || diff.changed.length ? 1 : 0 };
    },
  }),
  define({
    name: 'funnel check',
    group: 'runs',
    summary: 'Did a run produce a funnel: every step, in order, with the properties it needs',
    details:
      'A funnel is `.lynkeus/funnels/<name>.json`: `{ "steps": [{ "event": "signup_started", "props": { "source": "string", "step": "number" } }, { "event": "signup_completed" }] }`. A property names a type the dashboard needs, or a value it filters on. Exit 1 when a step is missing, out of order, or has the wrong shape.',
    positionals: [{ name: 'name', help: 'the funnel', required: true }],
    flags: { run: { type: 'string', help: 'a run folder, or `last`', default: 'last', value: 'dir' } },
    needs: 'nothing',
    run: async (ctx) => {
      const funnel = loadFunnel(lynkeusDir(ctx.root), ctx.args[0]!);
      const file = resolveEventsFile(runsDir(ctx.root), ctx.flags.run as string);
      if (!file || !fs.existsSync(file)) return { text: 'no events recorded for that run (run the flow with --events)', code: 1 };
      const result = checkFunnel(funnel, readEvents(file));
      return { text: describeFunnel(result), json: result, code: result.ok ? 0 : 1 };
    },
  }),
  define({
    name: 'funnel report',
    group: 'runs',
    summary: 'Across the recorded runs: which funnel steps some run produces, and which none does',
    flags: { last: { type: 'number', help: 'how many recent runs', default: 50, value: 'n' } },
    needs: 'nothing',
    run: async (ctx) => {
      const funnels = listFunnels(lynkeusDir(ctx.root));
      if (funnels.length === 0) return { text: 'no funnels under .lynkeus/funnels/', code: 1 };
      const runs = eventsFiles(runsDir(ctx.root))
        .slice(0, ctx.flags.last as number)
        .map((file) => ({ run: path.relative(runsDir(ctx.root), path.dirname(file)), events: readEvents(file) }));
      const coverage = funnelCoverage(funnels, runs);
      const text = coverage
        .map((f) =>
          [
            f.funnel,
            ...f.steps.map((s) => `  ${s.runs.length ? '✓' : '✗'} ${s.event}  ${s.runs.length ? `${s.runs.length} run(s)` : 'no run produces it'}`),
          ].join('\n'),
        )
        .join('\n\n');
      return { text, json: coverage };
    },
  }),
  define({
    name: 'flake',
    group: 'runs',
    summary: 'The same flow n times: how often it passes, and the step and error it dies on',
    positionals: [{ name: 'flow.json', help: 'the flow file', required: true }],
    flags: {
      times: { type: 'number', help: 'how many runs', default: 5, value: 'n' },
      ...VAR_FLAG,
    },
    needs: 'app',
    session: false,
    run: async (ctx) => {
      const device = await ctx.device();
      const flow = readJson<Flow>(ctx.args[0]!);
      const times = ctx.flags.times as number;
      const reports = [];
      for (let i = 1; i <= times; i++) {
        const report = await runFlow(flow, { device, vars: varsOf(ctx.flags) });
        reports.push(report);
        const failed = report.steps.findIndex((r) => !r.ok);
        ctx.err(
          `  ${i}/${times} ${report.ok ? '✓' : '✗'} ${Math.round(report.totalMs)}ms${failed === -1 ? '' : `  step ${failed + 1}: ${report.steps[failed]!.error}`}`,
        );
      }
      const summary = summarizeRuns(reports);
      return { text: describeFlake(flow.name, summary), json: summary, code: summary.passed === summary.runs ? 0 : 1 };
    },
  }),
  define({
    name: 'smoke',
    group: 'runs',
    summary: 'Open every parameter-free route (or the prefixes given) and record what renders',
    positionals: [{ name: 'Route.Prefix', help: 'only routes under these prefixes', rest: true }],
    flags: {
      params: { type: 'string', help: 'route params type map, relative to the app', value: 'file' },
      screenshots: { type: 'boolean', help: 'one capture per screen' },
      ...OVERLAY_FLAGS,
    },
    needs: 'app',
    session: false,
    run: async (ctx) => {
      const graph = ctx.graph();
      const device = await ctx.device();
      const outDir = path.join(runsDir(ctx.root), 'smoke', stamp());
      const started = performance.now();
      const results = await smoke({
        device,
        graph,
        appRoot: ctx.root,
        paramsFile: ctx.flags.params as string | undefined,
        outDir,
        only: ctx.args.length ? ctx.args : undefined,
        screenshots: !!ctx.flags.screenshots,
        overlay: overlayOf(ctx.flags),
        appId: (ctx.flags.app as string | undefined) ?? device.appId ?? undefined,
        errorCopy: anyOf(ctx.config.errorCopy),
        onResult: (r) =>
          ctx.err(
            `  ${r.ok ? '✓' : '✗'} ${String(r.ms).padStart(5)}ms ${r.route.padEnd(36)} ${String(r.elements).padStart(3)} el${r.problems.length ? `  ${r.problems.join('; ')}` : ''}`,
          ),
      });
      const bad = results.filter((r) => !r.ok);
      return {
        text: `\n  ${results.length - bad.length}/${results.length} screens clean in ${seconds(started)}s\n  artifacts: ${outDir}\n`,
        json: results,
        code: bad.length ? 1 : 0,
      };
    },
  }),
  define({
    name: 'crawl',
    group: 'runs',
    summary: 'Press every control it finds, learn where each leads (feeds map paths and plan)',
    details:
      'Finishes a screen before it goes anywhere, so the controls that matter are not lost to whatever the first one opened, and remembers in .lynkeus/frontier.jsonl what it did not get to — a second run continues instead of repeating. `--to` walks towards a route instead of exploring everything. Read-only by default: every press happens, but the moment one makes the app write (a POST, PUT, PATCH or DELETE) the crawl reports it and stops exploring past it, and never presses that control again. Controls that must not be pressed at all go in lynkeus.config.json under crawl.never — lynkeus ships no list of its own, because which controls are irreversible depends on the app.',
    positionals: [{ name: 'Route', help: 'where to start (default: the current screen)' }],
    flags: {
      depth: { type: 'number', help: 'how many screens deep', default: 1, value: 'n' },
      max: { type: 'number', help: 'at most this many presses', default: 80, value: 'n' },
      to: { type: 'string', help: 'walk towards this route and stop on arrival', value: 'Route' },
      fresh: { type: 'boolean', help: 'ignore what earlier runs already pressed' },
      ...OVERLAY_FLAGS,
      'login-flow': { type: 'string', help: 'flows that log in again after a reset, comma-separated', value: 'a.json,b.json' },
      ...VAR_FLAG,
      'var-cmd': { type: 'list', help: 'a variable produced by a shell command when needed (repeatable)', value: "name='cmd'" },
      'press-anything': { type: 'boolean', help: 'keep exploring past a press that wrote (a disposable environment only)' },
      verbose: { type: 'boolean', help: 'print every recovery and decision' },
    },
    needs: 'app',
    session: false,
    run: async (ctx) => {
      const device = await ctx.device();
      const outDir = path.join(runsDir(ctx.root), 'crawl', stamp());
      if (ctx.args[0]) {
        await device.navigate(ctx.args[0]);
        await device.idle({ quietMs: 200, timeoutMs: 2000 });
      }
      const started = performance.now();
      const learned = { added: 0, reinforced: 0 };
      const loginFlow = ctx.flags['login-flow'] as string | undefined;
      const known = edges.open(edgesFile(ctx.root));
      const memory = ctx.flags.fresh ? undefined : frontier.open(frontierFile(ctx.root));
      const graph = loadGraph(ctx.root);
      const rules = ctx.config.crawl;
      try {
        const { transitions, states } = await crawl({
          device,
          outDir,
          depth: ctx.flags.depth as number,
          maxActions: ctx.flags.max as number,
          neverPress: anyOf(rules?.never),
          closers: anyOf(rules?.close),
          backs: anyOf(rules?.back),
          errorCopy: anyOf(ctx.config.errorCopy),
          safety: ctx.flags['press-anything'] ? 'anything' : 'read-only',
          appId: (ctx.flags.app as string | undefined) ?? device.appId ?? undefined,
          overlay: overlayOf(ctx.flags),
          login: loginFlow
            ? {
                flows: loginFlow.split(',').map((f) => readJson<Flow>(f.trim())),
                vars: varsOf(ctx.flags),
                varCommands: pairs(ctx.flags['var-cmd'] as string[] | undefined),
              }
            : undefined,
          goal: ctx.flags.to as string | undefined,
          memory,
          directions: graph ? (from, to) => plan(graph, from, to, known.all()) : undefined,
          log: (line) => ctx.flags.verbose && ctx.err(`    · ${line}`),
          onTransition: (t) => {
            const b = t.button.testId ? `#${t.button.testId}` : JSON.stringify(t.button.text ?? '');
            ctx.err(
              `  ${t.problems.length ? '✗' : '✓'} ${String(t.ms).padStart(5)}ms ${(t.fromRoute ?? '?').padEnd(28)} ${b.padEnd(44)} → ${t.toRoute ?? '?'}${t.problems.length ? `  ${t.problems.join('; ')}` : ''}`,
            );
            // A press that opened a sheet went somewhere even though the route did not change: the layer is the destination.
            if (t.fromRoute && t.toRoute && (t.fromRoute !== t.toRoute || t.fromLayer !== t.toLayer)) {
              const added = known.record({
                from: t.fromRoute,
                to: t.toRoute,
                via: t.button.testId ?? `text:${t.button.text ?? ''}`,
                fromLayer: t.fromLayer,
                toLayer: t.toLayer,
              });
              learned[added ? 'added' : 'reinforced'] += 1;
            }
          },
        });
        const bad = transitions.filter((t) => t.problems.length);
        const screens = Object.keys(states).length;
        return {
          text: `\n  ${transitions.length} transitions, ${screens} screens, ${bad.length} problems in ${seconds(started)}s; learned ${learned.added} new edges (${learned.reinforced} reinforced)\n  artifacts: ${outDir}\n`,
          json: { transitions: transitions.length, screens, problems: bad.length, learned, outDir },
          code: bad.length ? 1 : 0,
        };
      } finally {
        known.compact();
        memory?.compact();
      }
    },
  }),
  define({
    name: 'record',
    group: 'runs',
    summary: 'Watch what a person does in the app; Ctrl-C writes a flow with what each step caused',
    details:
      'Touches are traced on device builds mounted with auto(); a host records routes and requests only. Lines typed on stdin run as commands meanwhile.',
    flags: {
      out: { type: 'string', help: 'where to write the flow', value: 'flow.json' },
      'so-far': { type: 'boolean', help: 'draft from the trace as it stands and stop' },
      screenshots: { type: 'boolean', help: 'one capture per touch, listed in <out>.strip.md' },
    },
    needs: 'app',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const device = await ctx.device();
      const out = (ctx.flags.out as string | undefined) ?? path.join(runsDir(ctx.root), 'record', `${stamp()}.json`);
      const events: TraceEvent[] = [];
      const soFar = !!ctx.flags['so-far'];
      let since = soFar ? 0 : (await device.trace()).last;
      const shots: { step: number; label: string; file: string }[] = [];
      const shotDir = path.join(path.dirname(out), `${path.basename(out, '.json')}-shots`);
      let touches = 0;
      let busy = Promise.resolve();
      const tick = async () => {
        const { events: fresh, last } = await device.trace(since);
        since = last;
        for (const e of fresh) {
          events.push(e);
          const line = describeEvent(e);
          if (line) ctx.err(`  ${line}`);
          if (e.kind !== 'touch' || !ctx.flags.screenshots) continue;
          const n = ++touches;
          const label = e.testId ?? e.text?.slice(0, 24).replace(/[^\w-]+/g, '_') ?? `${e.x}x${e.y}`;
          busy = busy.then(async () => {
            fs.mkdirSync(shotDir, { recursive: true });
            await device.idle({ quietMs: 300, timeoutMs: 2000 }).catch(() => undefined);
            const file = path.join(shotDir, `${String(n).padStart(2, '0')}-${label}.png`);
            await device.screenshot(file);
            shots.push({ step: n, label, file });
          });
        }
      };
      if (!soFar) {
        ctx.err(`recording; use the app, then Ctrl-C to write ${out}`);
        const timer = setInterval(() => void tick().catch(() => undefined), 300);
        const rl = readline.createInterface({ input: process.stdin });
        rl.on('line', (line) => {
          if (!line.trim()) return;
          busy = busy.then(async () => {
            const av = line.trim().startsWith('[') ? (JSON.parse(line) as string[]) : splitLine(line);
            const r = await execute(av, { ...ctx, attached: true });
            ctx.err(r.text ?? (r.code ? `  ✗ ${r.error ?? 'failed'}` : ''));
          });
        });
        await new Promise<void>((resolve) => {
          process.once('SIGINT', () => resolve());
          rl.once('close', () => resolve());
        });
        clearInterval(timer);
      }
      await tick().catch(() => undefined);
      await busy;
      const flow = draftFlow(events, path.basename(out, '.json'));
      writeJson(out, flow);
      const lines: string[] = [];
      if (shots.length) {
        const strip = `${out.replace(/\.json$/, '')}.strip.md`;
        fs.writeFileSync(
          strip,
          [`# ${flow.name}`, '', ...shots.map((s) => `${s.step}. \`${s.label}\`\n\n![${s.label}](${path.relative(path.dirname(strip), s.file)})\n`)].join('\n'),
        );
        lines.push(`${shots.length} screenshots → ${strip}`);
      }
      lines.push(`${flow.steps.length} steps → ${out}`);
      if (!events.some((e) => e.kind === 'touch'))
        lines.push('(no touches were traced: touches are recorded on device builds mounted with auto(); a host records routes and requests only)');
      return { text: lines.join('\n'), json: { out, steps: flow.steps.length, screenshots: shots.length } };
    },
  }),
  define({
    name: 'snapshot',
    group: 'runs',
    summary: 'A baseline for a screen: its tree (diffed like code) and, on a simulator, its pixels',
    details:
      'The tree is the screen as nested lines of meaning: kinds, labels, testIDs, values, states, no geometry. A renamed heading or a lost button is a changed line; a font hint is nothing. `--pixels` adds a screenshot compared with a red-on-grey diff. Baselines live under .lynkeus/snapshots/; what differs goes under runs/.',
    positionals: [{ name: 'name', help: 'the baseline name, e.g. onboarding-hero', required: true }],
    flags: {
      update: { type: 'boolean', help: 'the change is intended: overwrite the baseline' },
      pixels: { type: 'boolean', help: 'also compare a screenshot (simulator)' },
      tolerance: { type: 'number', help: 'pixels allowed to differ, as a fraction', default: 0.001, value: 'ratio' },
      'no-freeze': { type: 'boolean', help: 'do not pin the status bar before the screenshot' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const name = ctx.args[0]!;
      await device.idle({ quietMs: 300, timeoutMs: 3000 }).catch(() => undefined);
      const lines: string[] = [];
      let code = 0;
      const tree = screenTree(await device.screen());
      const treeFile = baselinePath(lynkeusDir(ctx.root), name).replace(/\.png$/, '.tree.txt');
      if (ctx.flags.update || !fs.existsSync(treeFile)) {
        fs.mkdirSync(path.dirname(treeFile), { recursive: true });
        fs.writeFileSync(treeFile, tree);
        lines.push(`${name}: tree baseline written → ${treeFile}`);
      } else {
        const d = diffTrees(fs.readFileSync(treeFile, 'utf8'), tree);
        if (d.added.length || d.removed.length) {
          const dir = path.join(runsDir(ctx.root), 'snapshots', stamp());
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${path.basename(treeFile, '.tree.txt')}.actual.tree.txt`), tree);
          lines.push(
            `${name}: the tree differs from the baseline (${d.removed.length} line(s) gone, ${d.added.length} new):`,
            describeTreeDiff(d),
            `  actual: ${dir}`,
            '  accept with --update if the change is intended',
          );
          code = 1;
        } else lines.push(`${name}: tree matches the baseline (${d.same} lines)`);
      }
      if (ctx.flags.pixels) {
        if (!ctx.flags['no-freeze']) await device.freezeChrome().catch(() => undefined);
        const tmp = path.join(os.tmpdir(), `lynkeus-snapshot-${Date.now()}.png`);
        await device.screenshot(tmp);
        const result = snapshot(lynkeusDir(ctx.root), name, fs.readFileSync(tmp), {
          update: !!ctx.flags.update,
          tolerance: ctx.flags.tolerance as number,
          runsDir: runsDir(ctx.root),
        });
        fs.rmSync(tmp, { force: true });
        lines.push(describeSnapshot(name, result));
        if (result.status === 'mismatch') code = 1;
      }
      return { text: lines.join('\n'), json: { name, code }, code };
    },
  }),
];
