import fs from 'node:fs';
import path from 'node:path';

import { lynkeusDir } from '../config.js';
import { describeScreen, describeTrace } from '../device/driver.js';
import { readJson, writeJson } from '../files.js';
import { describeFindings, lintScreen } from '../knowledge/lint.js';
import { describePerf, summarize, visitsFrom } from '../knowledge/perf.js';
import * as screens from '../knowledge/screens.js';
import { screenTree } from '../knowledge/tree.js';
import { define } from '../registry.js';
import { whyFor } from '../runtime.js';
import { expectedOf, isRoute, parseTarget, scopedTarget, TARGET_HELP } from '../targets.js';
import { type LintBaseline, newFindings } from './check.js';

const SCOPE_FLAGS = {
  in: { type: 'string' as const, help: 'the match nearest this target', value: 'target' },
  nth: { type: 'number' as const, help: 'the nth match, from 0', value: 'n' },
};

export const driveCommands = [
  define({
    name: 'screen',
    mcp: 'core',
    mcpOmit: ['record', 'tree', 'verbose', 'frames'],
    mcpDetails: 'One line per element: index, kind, #testId, label, value, state (!disabled ~covered ~inert). The header counts what is not presented.',
    group: 'drive',
    summary: 'Route, path and every element on screen, in ms',
    details:
      'One line per element: index, kind, #testId, label, value and state (`!disabled`, `~covered`, `~inert`). What the platform is not presenting is left out and counted in the header; `--all` lists it. `--frames` adds each centre in points; `--verbose` the commit count and cost. `--tree` prints nested lines with no geometry: the form to diff. `--record` keeps the structure under .lynkeus/screens/ and notes what changed since the last read.',
    flags: {
      tree: { type: 'boolean', help: 'as a tree of meaning, without frames' },
      record: { type: 'boolean', help: 'keep it under .lynkeus/screens/ and report changes (or LYNKEUS_RECORD_SCREENS=1)' },
      all: { type: 'boolean', help: 'also list what is not presented' },
      frames: { type: 'boolean', help: 'with each centre, in points' },
      verbose: { type: 'boolean', help: 'commit count and read cost in the header' },
    },
    needs: 'app',
    run: async (ctx) => {
      const screen = await (await ctx.device()).screen();
      if (ctx.flags.record || process.env.LYNKEUS_RECORD_SCREENS === '1') {
        const change = screens.record(lynkeusDir(ctx.root), screen);
        if (change) ctx.err(`screen changed since last read:\n${screens.describeChange(change)}`);
      }
      const options = { all: Boolean(ctx.flags.all), frames: Boolean(ctx.flags.frames), verbose: Boolean(ctx.flags.verbose) };
      return { text: ctx.flags.tree ? screenTree(screen) : describeScreen(screen, options), json: screen };
    },
  }),
  define({
    name: 'press',
    mcp: 'core',
    mcpOmit: ['hold', 'js', 'nth'],
    group: 'drive',
    summary: 'A finger on an element',
    positionals: [{ name: 'target', help: TARGET_HELP, required: true }],
    flags: {
      ...SCOPE_FLAGS,
      hold: { type: 'number', help: 'hold for this long', value: 'ms' },
      js: { type: 'boolean', help: 'call onPress directly instead of a synthesized touch' },
      settle: { type: 'boolean', help: 'wait for the app to stop committing, then print the screen' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const result = await device.press({
        ...scopedTarget(ctx.args[0]!, ctx.flags),
        holdMs: ctx.flags.hold as number | undefined,
        mode: ctx.flags.js ? 'js' : undefined,
      });
      if (!ctx.flags.settle) return { json: result };
      await device.idle({ quietMs: 200, timeoutMs: 3000 }).catch(() => undefined);
      return { text: describeScreen(await device.screen()), json: result };
    },
  }),
  define({
    name: 'type',
    mcp: 'core',
    mcpOmit: ['paste', 'nth'],
    group: 'drive',
    summary: 'Type into the focused input, or tap a target first',
    positionals: [
      { name: 'text', help: 'what to type', required: true },
      { name: 'target', help: `tap this first: ${TARGET_HELP}` },
    ],
    flags: {
      ...SCOPE_FLAGS,
      paste: { type: 'boolean', help: 'insert at once instead of key by key' },
      submit: { type: 'boolean', help: 'then the return key (onSubmitEditing)' },
      clear: { type: 'boolean', help: 'clear the field first' },
    },
    needs: 'app',
    run: async (ctx) => ({
      json: await (await ctx.device()).type({
        text: ctx.args[0]!,
        target: ctx.args[1] ? scopedTarget(ctx.args[1], ctx.flags) : undefined,
        paste: !!ctx.flags.paste,
        clear: !!ctx.flags.clear,
        submit: !!ctx.flags.submit,
      }),
    }),
  }),
  define({
    name: 'swipe',
    group: 'drive',
    summary: 'A drag; on a target, drives its gesture (a slider, a sheet)',
    details:
      'On a target the drag starts at its centre, which a wide control cannot always afford: a slider needing 80% of its width would end off-screen, and a touch that leaves the screen is cancelled. `--from`/`--to` place both ends, in points.',
    positionals: [
      { name: 'direction', help: 'up | down | left | right (omit when giving --from/--to)' },
      { name: 'target', help: TARGET_HELP },
    ],
    flags: {
      distance: { type: 'number', help: 'how far, in points', value: 'pt' },
      from: { type: 'string', help: 'where the finger lands, as x,y', value: 'x,y' },
      to: { type: 'string', help: 'where it lifts, as x,y', value: 'x,y' },
      duration: { type: 'number', help: 'how long the drag takes, ms', value: 'ms' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const durationMs = ctx.flags.duration as number | undefined;
      const point = (flag: 'from' | 'to') => {
        const [x, y] = (ctx.flags[flag] as string).split(',').map((n) => Number(n.trim()));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--${flag} must be two numbers, as x,y`);
        return { x: x!, y: y! };
      };
      if (ctx.flags.from || ctx.flags.to) {
        if (!ctx.flags.from || !ctx.flags.to) throw new Error('--from and --to go together');
        return { json: await device.server.call('swipe', { from: point('from'), to: point('to'), durationMs }) };
      }
      const direction = ctx.args[0] as 'up' | 'down' | 'left' | 'right';
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('swipe needs a direction (up, down, left or right), or --from and --to');
      if (ctx.args[1]) {
        const distance = ctx.flags.distance as number | undefined;
        return { json: await device.server.call('swipe', { direction, target: parseTarget(ctx.args[1]), distance, durationMs }) };
      }
      await device.swipe({ direction });
      return { json: { direction } };
    },
  }),
  define({
    name: 'back',
    group: 'drive',
    summary: 'Pop the current route',
    needs: 'app',
    run: async (ctx) => ({ json: await (await ctx.device()).back() }),
  }),
  define({
    name: 'nav',
    group: 'drive',
    summary: 'Jump straight to a route (a teleport, not a user action)',
    positionals: [
      { name: 'route', help: 'e.g. Settings.Main', required: true },
      { name: 'params', help: 'JSON params' },
    ],
    needs: 'app',
    run: async (ctx) => {
      await (await ctx.device()).navigate(ctx.args[0]!, ctx.args[1] ? JSON.parse(ctx.args[1]) : undefined);
      return { json: { route: ctx.args[0] } };
    },
  }),
  define({
    name: 'wait',
    mcp: 'core',
    mcpOmit: ['nth'],
    group: 'drive',
    summary: 'Until a route or element appears (or leaves), or a number of ms',
    positionals: [{ name: 'what', help: `Route | ${TARGET_HELP} | 800 (ms)`, required: true }],
    flags: {
      ...SCOPE_FLAGS,
      gone: { type: 'boolean', help: 'until it leaves the screen' },
      scroll: { type: 'boolean', help: 'scroll until it is in the window' },
      timeout: { type: 'number', help: 'give up after', default: 10000, value: 'ms' },
    },
    needs: 'app',
    run: async (ctx) => {
      const raw = ctx.args[0]!;
      if (/^\d+$/.test(raw)) {
        await new Promise((r) => setTimeout(r, Number(raw)));
        return { json: { waitedMs: Number(raw) } };
      }
      return {
        json: await (await ctx.device()).waitFor({
          ...(isRoute(raw) ? { route: raw } : { target: scopedTarget(raw, ctx.flags) }),
          gone: ctx.flags.gone ? true : undefined,
          scroll: ctx.flags.scroll ? true : undefined,
          timeoutMs: ctx.flags.timeout as number,
        }),
      };
    },
  }),
  define({
    name: 'screenshot',
    group: 'drive',
    summary: 'What the screen looks like right now, written to a file',
    details: 'A device or simulator only: a host renders nothing to capture.',
    positionals: [{ name: 'file', help: 'where to write the png', required: true }],
    needs: 'app',
    run: async (ctx) => {
      const file = path.resolve(ctx.args[0]!);
      await (await ctx.device()).screenshot(file);
      return { text: file, json: { file } };
    },
  }),
  define({
    name: 'see',
    group: 'drive',
    summary: 'Assert a route or element is on screen now (exit 1 if not)',
    positionals: [{ name: 'what', help: `Route | ${TARGET_HELP}`, required: true }],
    flags: {
      absent: { type: 'boolean', help: 'assert it is not there' },
      within: { type: 'number', help: 'allow it this long to appear', default: 0, value: 'ms' },
    },
    needs: 'app',
    run: async (ctx) => {
      const raw = ctx.args[0]!;
      const device = await ctx.device();
      try {
        const result = await device.waitFor({
          ...(isRoute(raw) ? { route: raw } : { target: parseTarget(raw) }),
          gone: ctx.flags.absent ? true : undefined,
          timeoutMs: Math.max(1, ctx.flags.within as number),
        });
        return { text: `${ctx.flags.absent ? 'gone' : 'on screen'}: ${raw}`, json: result };
      } catch {
        return { text: `${ctx.flags.absent ? 'still on screen' : 'not on screen'}: ${raw}`, json: { ok: false }, code: 1 };
      }
    },
  }),
  define({
    name: 'idle',
    group: 'drive',
    summary: 'Until the app stops committing: data arrived, animations done',
    details:
      'A screen that has not started looks exactly like one that has finished — both are quiet. `--after <commit>`, given the commit count from before whatever was supposed to happen, waits for the app to commit past it first.',
    flags: {
      quiet: { type: 'number', help: 'no commit for this long counts as settled', default: 300, value: 'ms' },
      timeout: { type: 'number', help: 'give up after (the answer says whether it settled)', default: 5000, value: 'ms' },
      after: { type: 'number', help: 'a commit count from before: quiet only counts once the app has committed past it', value: 'commit' },
    },
    needs: 'app',
    run: async (ctx) => ({
      json: await (await ctx.device()).idle({
        quietMs: ctx.flags.quiet as number,
        timeoutMs: ctx.flags.timeout as number,
        after: ctx.flags.after as number | undefined,
      }),
    }),
  }),
  define({
    name: 'requests',
    group: 'drive',
    summary: 'The HTTP requests the app made: method, path, status, ms',
    flags: { last: { type: 'number', help: 'how many', default: 30, value: 'n' } },
    needs: 'app',
    run: async (ctx) => {
      const result = await (await ctx.device()).requests();
      const list = result.requests.slice(-(ctx.flags.last as number));
      const lines = [
        `in flight: ${result.inFlight}`,
        ...list.map(
          (r) => `${String(r.status ?? '…').padStart(4)} ${String(r.ms ?? '').padStart(6)}ms ${r.method.padEnd(6)} ${r.url}${r.error ? `  (${r.error})` : ''}`,
        ),
      ];
      return { text: lines.join('\n'), json: { inFlight: result.inFlight, requests: list } };
    },
  }),
  define({
    name: 'trace',
    group: 'drive',
    summary: 'What happened, in order: routes, requests, store diffs, touches, commands',
    flags: {
      since: { type: 'number', help: 'only after this seq (from a previous trace)', value: 'seq' },
      last: { type: 'number', help: 'how many', default: 60, value: 'n' },
    },
    needs: 'app',
    run: async (ctx) => {
      const result = await (await ctx.device()).trace(ctx.flags.since as number | undefined);
      const events = result.events.slice(-(ctx.flags.last as number));
      ctx.err(`last seq ${result.last}`);
      return { text: describeTrace(events), json: { last: result.last, events } };
    },
  }),
  define({
    name: 'call',
    mcp: 'core',
    group: 'drive',
    summary: 'An app command registered with qa.register (reset, busy, …)',
    positionals: [
      { name: 'command', help: 'its name', required: true },
      { name: 'params', help: 'JSON params' },
    ],
    needs: 'app',
    run: async (ctx) => ({ json: await (await ctx.device()).command(ctx.args[0]!, ctx.args[1] ? JSON.parse(ctx.args[1]) : undefined) }),
  }),
  define({
    name: 'hello',
    group: 'drive',
    summary: 'What the app said about itself: platform, native, registered commands',
    needs: 'app',
    run: async (ctx) => {
      const { language, locale } = ctx.config;
      const hello = { ...(await ctx.device()).server.hello, ...(language || locale ? { locale: { language, ...locale } } : {}) };
      return { text: JSON.stringify(hello, null, 2), json: hello };
    },
  }),
  define({
    name: 'launch',
    group: 'drive',
    summary: 'Relaunch the app and wait for the agent',
    positionals: [{ name: 'bundleId', help: 'or --app' }],
    flags: { clean: { type: 'boolean', help: "run the app's reset command first, if it is attached" } },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const appId = ctx.args[0] ?? (ctx.flags.app as string | undefined) ?? ctx.config.app;
      if (!appId) throw new Error('launch needs a bundle id (argument, --app, or app in lynkeus.config.json)');
      if (ctx.flags.clean) await device.command('reset').catch(() => undefined);
      await device.launchApp(appId, { fresh: true });
      await device.idle({ quietMs: 200, timeoutMs: 3000 }).catch(() => undefined);
      const screen = await device.screen();
      return { text: describeScreen(screen), json: screen };
    },
  }),
  define({
    name: 'why',
    mcp: 'core',
    mcpOmit: ['route'],
    mcpDetails: 'Runs by itself after a failed step.',
    group: 'drive',
    summary: 'Why the last thing failed: screen, requests and trace read as rules',
    details: 'Runs by itself after a failed press, wait, type, swipe or nav. Give it what you were looking for to sharpen the answer.',
    positionals: [{ name: 'target', help: `what was expected: Route | ${TARGET_HELP}` }],
    flags: { route: { type: 'string', help: 'the route that was expected', value: 'Route' } },
    needs: 'app',
    run: async (ctx) => {
      const expected = { ...expectedOf(ctx.args[0]), ...(ctx.flags.route ? { route: ctx.flags.route as string } : {}) };
      return (await whyFor(ctx, Object.keys(expected).length ? expected : undefined)) || '(no evidence available)';
    },
  }),
  define({
    name: 'lint',
    group: 'drive',
    summary: 'Unlabeled controls, small targets, untranslated keys, covered or clipped elements',
    flags: {
      strict: { type: 'boolean', help: 'exit 1 on any warning' },
      save: { type: 'string', help: "keep this screen's findings in a baseline file", value: 'file' },
      baseline: { type: 'string', help: 'print only what is new against a baseline file', value: 'file' },
    },
    needs: 'app',
    run: async (ctx) => {
      const screen = await (await ctx.device()).screen();
      const { lint, lintBaseline } = ctx.config;
      let findings = lintScreen(screen, { i18nKeyPatterns: lint?.i18nKeyPatterns?.map((p) => new RegExp(p, 'i')), minTouchTarget: lint?.minTouchTarget });
      const route = screen.route ?? '?';
      const withIds = findings.map((finding) => ({ finding, testId: screen.elements[finding.element]?.testId }));
      const lines: string[] = [];
      const save = ctx.flags.save as string | undefined;
      const baselineFile = (ctx.flags.baseline as string | undefined) ?? lintBaseline;
      if (save) {
        const baseline = fs.existsSync(save) ? readJson<LintBaseline>(save) : {};
        baseline[route] = withIds.map((f) => ({ rule: f.finding.rule, testId: f.testId, message: f.finding.message }));
        writeJson(save, baseline);
        lines.push(`saved ${findings.length} finding(s) for ${route} → ${save}`);
      } else if (baselineFile && fs.existsSync(baselineFile)) {
        findings = newFindings(readJson<LintBaseline>(baselineFile), route, withIds).map((f) => f.finding);
        lines.push(findings.length ? `${findings.length} new against ${baselineFile}:` : `nothing new on ${route} against ${baselineFile}`);
      }
      lines.push(describeFindings(findings, screen.route));
      return { text: lines.join('\n'), json: findings, code: ctx.flags.strict && findings.some((f) => f.severity === 'warn') ? 1 : 0 };
    },
  }),
  define({
    name: 'perf',
    group: 'drive',
    summary: 'Per screen: requests on arrival, time to quiet, errors, stalls, the slowest call',
    flags: {
      since: { type: 'number', help: 'only after this trace seq', value: 'seq' },
      last: { type: 'number', help: 'only the last n trace events', value: 'n' },
    },
    needs: 'app',
    run: async (ctx) => {
      const { events } = await (await ctx.device()).trace(ctx.flags.since as number | undefined);
      const summary = summarize(visitsFrom(ctx.flags.last ? events.slice(-(ctx.flags.last as number)) : events));
      return { text: describePerf(summary), json: summary };
    },
  }),
  define({
    name: 'profile',
    group: 'drive',
    summary: 'What React spent rendering, per route, measured by the Profiler auto() mounts',
    details:
      '`profile start` clears and starts recording, `profile` reports what was recorded since, `profile stop` reports and stops. Recording is off until started, so an app that never asks pays nothing.',
    positionals: [{ name: 'action', help: 'start | stop (omit to report)' }],
    needs: 'app',
    run: async (ctx) => {
      const action = ctx.args[0];
      if (action !== undefined && action !== 'start' && action !== 'stop') return { text: `profile: unknown action ${action} (start | stop)`, code: 2 };
      const result = await (await ctx.device()).command<{
        recording: boolean;
        commits?: number;
        ms?: number;
        routes?: Record<string, { commits: number; ms: number; maxMs: number }>;
      }>('profile', action ? { action } : {});
      if (action === 'start') return { text: 'profile: recording', json: result };
      const routes = Object.entries(result.routes ?? {})
        .sort(([, a], [, b]) => b.ms - a.ms)
        .map(([route, r]) => `  ${route}: ${r.ms} ms in ${r.commits} commits (slowest ${r.maxMs} ms)`);
      const head = `profile: ${result.ms ?? 0} ms in ${result.commits ?? 0} commits${result.recording ? '' : ' (not recording)'}`;
      return { text: [head, ...routes].join('\n'), json: result };
    },
  }),
];
