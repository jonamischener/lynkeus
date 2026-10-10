/**
 * Runs a case's setup, then its steps, stopping at the first that fails. The
 * app is driven through the terminal's own commands on one connection; the
 * backend is prepared and read through the project's fixtures. How this app
 * logs in or what a user is belongs to the project, as macros and fixtures.
 */
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Element, Screen, Target, TraceEvent } from 'lynkeus-protocol';

import { type Device, describeScreen } from '../device/driver.js';
import { type AppEvent, normalizeEvents, type RunEvent } from '../knowledge/events.js';
import { type Base, type Command, find } from '../registry.js';
import { execute } from '../runtime.js';
import { isRoute, parseTarget, scopedTarget } from '../targets.js';
import type { Fixtures, FixturesConfig } from './fixtures.js';
import { type Case, dig, interpolate, matcherOf, matches, type Scope, type Step, stepOf, type StepValue } from './format.js';

export type CasesConfig = {
  /** The folder of the file that declared this, set when the configuration is read. */
  base?: string;
  /** Where cases live (default `cases`). */
  dir?: string;
  /** Where the flows a case runs live (default `flows`). */
  flows?: string;
  /** The long-lived command that answers fixture steps, as JSON lines. */
  fixtures?: FixturesConfig;
  /** The fixture `assert` reads the backend through (default `inspect`). */
  inspect?: string;
  /** `{ "user": "user_id" }` turns `user: u` into `user_id: <u.user_id>`, and gives a step that names no user the latest one. */
  refs?: Record<string, string>;
  /** Steps this project adds: `{ "app.login": [...] }`. Inside, `{{param.x}}` is what the case passed. */
  macros?: Record<string, unknown[]>;
  /** What the app may put in the way of a step and the steps that get past it; a step whose own words match `unless` is about it, and is left alone. */
  interruptions?: { see: string; do: unknown[]; unless?: string }[];
};

/** What a host's analytics capture saw a step send: the SDK it went to and the event. */
export type SentEvent = { provider: string; name: string; props?: Record<string, unknown> };

/** `unsupported`: the host the case ran on has no such thing to do (a real device has no mocked responses), which says nothing about the app. */
export type StepReport = {
  step: string;
  status: 'passed' | 'failed' | 'skipped' | 'unsupported';
  ms: number;
  error?: string;
  /** A frame of the screen once the step was done, an absolute path. */
  screenshot?: string;
  /** The second of the case's film at which the step began. */
  videoS?: number;
  /** What the step made the app send its analytics SDKs, where the host captures them. */
  sent?: SentEvent[];
};
export type CaseReport = {
  id: string;
  title?: string;
  file: string;
  /** `unsupported`: a step could not be done on this host, so the case proved nothing here; it did not fail. */
  result: 'passed' | 'failed' | 'unsupported';
  ms: number;
  steps: StepReport[];
  /** When a step failed: the screen, the requests since the mark, and why. */
  evidence?: { screen?: string; requests?: string[]; why?: string };
  /** What the app told its analytics, each with the step that caused it, when the run asked for it. */
  events?: RunEvent[];
  /** The case's film, an absolute path, where the host films. */
  video?: string;
  /** Why it failed, read as rules from the screen, the requests and the trace (`lynkeus why`). */
  diagnosis?: string[];
};

/** Where a case keeps what it can show of itself: a frame per step, a film. Each is taken only where the host can. */
export type Evidence = { dir: string; screenshots?: boolean; video?: { fps: number } };

export type RunOptions = {
  base: Base;
  config: CasesConfig;
  fixtures?: Fixtures;
  dry?: boolean;
  events?: boolean;
  evidence?: Evidence;
  log?: (line: string) => void;
  /** The case's setup, already run by `case prepare`: the case starts from here. */
  prepared?: Prepared;
  /** Run only the setup and hand what it left to `keep`, for a case that will run later. */
  setupOnly?: { keep: (prepared: Prepared) => void };
};

/** What a case's setup leaves for its steps: the aliases and what they answered, and what ran. */
export type Prepared = { scope: Scope; latest: Record<string, unknown>; ran: string[]; steps: StepReport[] };

/** A setup made only of the project's fixtures can run before the case, with no app attached. */
export const preparable = (c: Case, config: CasesConfig): boolean =>
  c.setup.length > 0 &&
  c.setup.every((step) => !step.on && !step.verb.startsWith('app.') && !config.macros?.[step.verb] && step.verb !== 'exec' && step.verb !== 'assert');

/** What a buffer holds that it did not before, whichever end it grows from. */
export const newSince = (before: AppEvent[], now: AppEvent[]): AppEvent[] => {
  if (now.length < before.length) return now;
  if (now.length === before.length) return [];
  const same = (a: AppEvent[], b: AppEvent[]) => JSON.stringify(a) === JSON.stringify(b);
  const extra = now.length - before.length;
  if (same(now.slice(0, before.length), before)) return now.slice(before.length);
  if (same(now.slice(extra), before)) return now.slice(0, extra).reverse();
  return now;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(exec);

const label = (step: Step): string => {
  const value = step.value;
  if (value === null || value === undefined) return step.verb;
  const text =
    typeof value === 'object'
      ? Object.entries(value)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join(', ')
      : String(value);
  return `${step.verb} ${text}`.slice(0, 140);
};

const FLAG_NAMES: Record<string, string> = {
  within: 'in',
  advanceMs: 'advance',
  timeoutMs: 'timeout',
  delayMs: 'delay',
  durationMs: 'duration',
  holdMs: 'hold',
};

/** `wait` holds when the case passed it; `method=phone` when it passed that value. */
const holds = (condition: string, param: Record<string, unknown>, ran: Set<string> = new Set()): boolean => {
  if (condition.startsWith('ran:')) return ran.has(condition.slice(4));
  const [name, value] = condition.split('=', 2);
  const given = param[name!];
  if (value !== undefined) return String(given) === value;
  return given !== undefined && given !== null && given !== false && given !== 'none';
};

/** A step's value as the argv of the command it names: what matches a positional by name goes in place, the rest are flags. */
export const argvFor = (command: Command, value: StepValue): string[] => {
  const argv = command.name.split(' ');
  if (value === null || value === undefined) return argv;
  if (typeof value === 'string' && command.flags?.[value]?.type === 'boolean') return [...argv, `--${value}`];
  if (typeof value !== 'object' || Array.isArray(value)) return [...argv, ...(Array.isArray(value) ? value.map(String) : [String(value)])];
  const given = { ...(value as Record<string, unknown>) };
  const positionals = command.positionals ?? [];
  // A case says `target` or `request` where a command may call its first argument something else.
  const first = positionals[0]?.name;
  for (const alias of ['target', 'request', 'route', 'url', 'state', 'text']) {
    if (first && !(first in given) && alias in given && !positionals.some((p) => p.name === alias) && !(alias in (command.flags ?? {}))) {
      given[first] = given[alias];
      delete given[alias];
      break;
    }
  }
  for (const p of positionals) {
    if (!(p.name in given)) {
      if (positionals.slice(positionals.indexOf(p) + 1).some((later) => later.name in given)) throw new Error(`${command.name} needs ${p.name}`);
      break;
    }
    const v = given[p.name];
    argv.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
    delete given[p.name];
  }
  for (const [key, v] of Object.entries(given)) {
    const flag = FLAG_NAMES[key] ?? key;
    if (!(flag in (command.flags ?? {}))) throw new Error(`${command.name} has no ${key}`);
    if (v === false || v === undefined || v === null) continue;
    if (v === true) argv.push(`--${flag}`);
    else if (Array.isArray(v)) for (const item of v) argv.push(`--${flag}`, String(item));
    else argv.push(`--${flag}`, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return argv;
};

const presented = (screen: Screen): Element[] => screen.elements.filter((e) => !e.hidden || e.hidden === 'inert');
const textOf = (e: Element) => e.text ?? e.value ?? e.accessibilityLabel ?? '';

const requestMatches = (event: TraceEvent, wanted: string, status?: number): boolean => {
  if (event.kind !== 'request') return false;
  const [method, route] = wanted.includes(' ') ? wanted.split(/\s+/, 2) : ['*', wanted];
  let pathname = event.url;
  try {
    pathname = new URL(event.url).pathname;
  } catch {
    pathname = event.url.split('?')[0]!;
  }
  if (method !== '*' && event.method.toUpperCase() !== method!.toUpperCase()) return false;
  if (!pathname.endsWith(route!)) return false;
  return status === undefined ? true : event.status === status;
};

const BUILT_IN = ['press', 'type', 'swipe', 'see', 'requests', 'wait', 'nav', 'call', 'run', 'events', 'event'];

const unknownStep = (step: Step, config: CasesConfig): string | undefined => {
  if (config.macros?.[step.verb] || !step.verb.startsWith('app.')) return undefined;
  const name = step.verb.slice(4);
  if (BUILT_IN.includes(name)) return undefined;
  const command = find(name) ?? find(`os ${name}`);
  if (!command) return `${step.verb} is not a step: lynkeus has no command ${name}, and the project declares no macro for it`;
  try {
    argvFor(command, step.value);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

/**
 * The fixtures a case names that the project's server did not list. A macro's
 * own steps are the project's to keep right; these are the ones written in the case.
 */
export const missingFixtures = (c: Case, config: CasesConfig, known: string[]): string[] => {
  const names = [...c.setup, ...c.steps].flatMap((step) => {
    if (step.verb.startsWith('app.') || config.macros?.[step.verb] || step.verb === 'exec') return [];
    return [step.verb === 'assert' ? (config.inspect ?? 'inspect') : step.verb];
  });
  return [...new Set(names)].filter((name) => !known.includes(name));
};

/** What the app or its host answers to a method it does not have; the name is what it lacks. */
export const lacking = (message: string): string | undefined => /Unknown method (\S+)/.exec(message)?.[1];

export const runCase = async (c: Case, options: RunOptions): Promise<CaseReport> => {
  const { base, config } = options;
  const log = options.log ?? (() => undefined);
  const scope: Scope = structuredClone(options.prepared?.scope ?? {});
  const ran = new Set<string>(options.prepared?.ran ?? []);
  const latest: Record<string, unknown> = structuredClone(options.prepared?.latest ?? {});
  const started = Date.now();
  const steps: StepReport[] = [];
  let mark: number | undefined;
  let why: string | undefined;
  const recorded: RunEvent[] = [];
  let buffer: AppEvent[] = [];
  // Read, never emptied: a case may be asserting on the buffer.
  const collect = async (index: number) => {
    if (!options.events) return;
    const d = await base.device().catch(() => undefined);
    if (!d?.server.connected) return;
    const now = normalizeEvents(await d.command('events').catch(() => []));
    const route = (await d.screen().catch(() => undefined))?.route;
    for (const e of newSince(buffer, now)) recorded.push({ ...e, step: index, route });
    buffer = now;
  };

  const device = () => base.device();
  const sinceMark = async (): Promise<TraceEvent[]> => (await (await device()).trace(mark)).events;
  const cli = async (argv: string[]) => {
    const outcome = await execute(argv, base);
    if (outcome.error || outcome.code !== 0) {
      why = outcome.why;
      throw new Error(outcome.error || outcome.text || `${argv.join(' ')} failed`);
    }
    return outcome;
  };

  const withRefs = (params: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...params };
    for (const [param, field] of Object.entries(config.refs ?? {})) {
      const alias = out[param];
      delete out[param];
      if (typeof alias === 'string') {
        if (!(alias in scope)) throw new Error(`no alias '${alias}'`);
        const found = dig(scope[alias], field);
        if (found === undefined) throw new Error(`alias '${alias}' has no ${field}`);
        out[field] = found;
      } else if (!(field in out) && latest[field] !== undefined) out[field] = latest[field];
    }
    return out;
  };

  const fixture = async (name: string, value: StepValue): Promise<void> => {
    if (!options.fixtures) throw new Error(`${name} is not a step lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)`);
    const given = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
    const as = typeof given.as === 'string' ? given.as : undefined;
    delete given.as;
    const answer = await options.fixtures.call(name, withRefs(given));
    if (as) scope[as] = answer;
    for (const field of Object.values(config.refs ?? {})) if (answer[field] !== undefined) latest[field] = answer[field];
  };

  // What the backend answered, until a step that can change it.
  const inspected = new Map<string, Record<string, unknown>>();

  const assert = async (value: StepValue): Promise<void> => {
    const params = (value ?? {}) as Record<string, unknown>;
    const matcher = matcherOf(params);
    if (!matcher || typeof params.path !== 'string') throw new Error('assert needs a path and a matcher (equals, includes, gte, …)');
    if (!options.fixtures) throw new Error('assert reads the backend through fixtures, and the project declares none');
    const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'path' && !(k in matcher)));
    // `section` is the part of the answer the path reads: a server that works its answer out part by part
    // need only do that part. Asserts in a row on the same section read one answer.
    const ask = withRefs({ ...rest, section: params.path.split('.')[0] });
    const key = JSON.stringify(ask);
    let answer = inspected.get(key);
    if (!answer) {
      answer = await options.fixtures.call(config.inspect ?? 'inspect', ask);
      inspected.set(key, answer);
    }
    const got = dig(answer, params.path);
    if (!matches(got, matcher)) throw new Error(`${params.path} is ${JSON.stringify(got)}`);
  };

  const targetIn = (params: Record<string, unknown>): Target | undefined => {
    const raw = typeof params.target === 'string' ? params.target : params.testId ? `#${String(params.testId)}` : undefined;
    return raw === undefined ? undefined : scopedTarget(raw, { in: params.within, nth: params.nth });
  };

  /** Every condition a `see` names, read off one screen and the trace since the mark; what is missing, or nothing. */
  const seen = async (params: Record<string, unknown>): Promise<string | undefined> => {
    const d = await device();
    const screen = await d.screen();
    const elements = presented(screen);
    if (typeof params.route === 'string' && screen.route !== params.route) return `on ${screen.route ?? 'no route'}, not ${params.route}`;
    if ('layer' in params) {
      const open = screen.presenting;
      const wanted = params.layer;
      const ok = wanted === true ? !!open : wanted === false ? !open : !!open && `${open.testId ?? ''}`.includes(String(wanted));
      if (!ok) return wanted === false ? 'a layer is open' : `no layer${wanted === true ? '' : ` ${String(wanted)}`} is open`;
    }
    const target = targetIn(params);
    const text = typeof params.text === 'string' ? params.text : undefined;
    if (target) {
      const found = (await d.server.call('find', target)) as Element | null;
      if (!found || (found.hidden && found.hidden !== 'inert')) return `not on screen: ${JSON.stringify(target)}`;
      if (text !== undefined && !textOf(found).includes(text) && !elements.some((e) => e.parent === found.i && textOf(e).includes(text))) {
        return `${JSON.stringify(target)} says ${JSON.stringify(textOf(found))}, not ${JSON.stringify(text)}`;
      }
    } else if (text !== undefined && !elements.some((e) => textOf(e).includes(text))) return `not on screen: ${JSON.stringify(text)}`;
    if (typeof params.request === 'string') {
      const status = typeof params.status === 'number' ? params.status : undefined;
      if (!(await sinceMark()).some((e) => requestMatches(e, params.request as string, status))) return `not requested since the mark: ${params.request}`;
    }
    if (typeof params.event === 'string') {
      const wanted = (params.props ?? params.properties ?? {}) as Record<string, unknown>;
      const events = normalizeEvents(await d.command('events'));
      const hit = events.some((e) => e.name === params.event && Object.entries(wanted).every(([k, v]) => String(e.props?.[k]) === String(v)));
      if (!hit) return `no ${params.event} event${Object.keys(wanted).length ? ` with ${JSON.stringify(wanted)}` : ''}`;
    }
    return undefined;
  };

  /**
   * A device, and a host that draws like one, lists what is in the window: what
   * a step looks for may be further down the page. This scrolls the window
   * itself, most of a screenful at a time, until `there` holds or the screen
   * stops changing; then back up in short pulls (at the top of a sheet a short
   * pull springs back, where a long one would drag the sheet shut).
   */
  const scrollTo = async (there: () => Promise<boolean>): Promise<boolean> => {
    const d = await device();
    if (!d.server.hello?.native) return false;
    const { w, h } = (await d.screen()).window;
    const x = Math.round(w / 2);
    const listing = async () => JSON.stringify(presented(await d.screen()).map((e) => [e.testId, textOf(e), Math.round(e.frame.y)]));
    const pull = async (from: number, to: number, times: number): Promise<boolean> => {
      let before: string | undefined;
      for (let i = 0; i < times; i++) {
        if (await there()) return true;
        const now = await listing();
        if (now === before) return false;
        before = now;
        await execute(['swipe', '--from', `${x},${from}`, '--to', `${x},${to}`], base);
        await d.idle({ quietMs: 150, timeoutMs: 1500 }).catch(() => undefined);
      }
      return there();
    };
    if (await pull(Math.round(h * 0.75), Math.round(h * 0.3), 12)) return true;
    const middle = Math.round(h * 0.5);
    return pull(middle, middle + 110, 30);
  };

  const see = async (value: StepValue): Promise<void> => {
    const params = typeof value === 'string' ? { target: value } : ((value ?? {}) as Record<string, unknown>);
    const absent = params.absent === true;
    const wait = typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000;
    const deadline = Date.now() + wait;
    const hard = Date.now() + Math.max(wait, 12_000);
    // Where the listing is what the window shows, something missing gets three more looks before the
    // deadline counts: a short wait (it may be arriving), a scroll (it may be further down), and a long
    // wait (a carousel shows it a few seconds from now, and a host with its own clock gets there fast).
    const what = targetIn(params) ?? (typeof params.text === 'string' ? ({ text: params.text } as Target) : undefined);
    let looks = absent || !what || !(await device()).server.hello?.native ? 3 : 0;
    while (true) {
      await interrupted(value);
      const missing = await seen(params);
      if (absent ? missing !== undefined : missing === undefined) return;
      if (looks < 3 && what && missing?.startsWith('not on screen')) {
        const d = await device();
        looks += 1;
        if (looks === 1) await d.waitFor({ target: what, timeoutMs: 1500 }).catch(() => undefined);
        else if (looks === 2) {
          if (await scrollTo(async () => (await seen(params)) === undefined)) return;
        } else await d.waitFor({ target: what, timeoutMs: 20_000 }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline && Date.now() < hard && (await (await device()).screen()).busy) {
        await sleep(150);
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(absent ? `still there: ${label({ verb: '', value: { ...params, absent: undefined } as StepValue }).trim()}` : missing!);
      await sleep(150);
    }
  };

  const waitForRequest = async (params: Record<string, unknown>): Promise<void> => {
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 10_000;
    const deadline = Date.now() + timeoutMs;
    const status = typeof params.status === 'number' ? params.status : undefined;
    while (true) {
      const events = await sinceMark();
      const hit = events.some(
        (e) => requestMatches(e, String(params.request), status) && (status !== undefined || (e.kind === 'request' && String(e.status).startsWith('2'))),
      );
      if (hit) return;
      if (Date.now() > deadline) throw new Error(`no ${status ?? '2xx'} ${String(params.request)} within ${timeoutMs} ms`);
      await sleep(300);
    }
  };

  const press = async (value: StepValue): Promise<'skipped' | undefined> => {
    const params = typeof value === 'string' ? { target: value } : ((value ?? {}) as Record<string, unknown>);
    const target = targetIn(params);
    if (!target) throw new Error('app.press needs a target');
    const d = await device();
    if (params.optional === true) {
      // Decided once the app has gone quiet: what it presses (a one-time question, a promo) arrives a moment
      // after the screen before it, and a fast host gets here first.
      await d.idle({ quietMs: 150, timeoutMs: 1000 }).catch(() => undefined);
      const there = await d.waitFor({ target, timeoutMs: 300 }).then(
        () => true,
        () => false,
      );
      if (!there) return 'skipped';
    }
    // Not listed at all: arriving, or further down a page that only lists its window. A short wait, then
    // a scroll, rather than spending the whole deadline on something that is below the fold.
    const listed = async () => !!(await d.server.call('find', target));
    if (!(await listed())) {
      await d.waitFor({ target, timeoutMs: 500 }).catch(() => undefined);
      if (!(await listed())) await scrollTo(listed);
    }
    // The control may still be disabled while what it depends on loads. The waits go through the app,
    // so a host with its own clock moves it on instead of standing still while this one sleeps.
    const deadline = Date.now() + (typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000);
    const hard = Date.now() + 15_000;
    let was: string | undefined;
    while (Date.now() < hard && 'testId' in target) {
      const found = (await d.server.call('find', target)) as Element | null;
      // Covered or still moving is often for a moment (a screen or button sliding in, a sheet still
      // closing), and a press then lands on whatever covers it or where the control no longer is.
      const at = found ? JSON.stringify(found.frame) : undefined;
      if (found?.enabled && !found.covered && at === was) break;
      was = at;
      if (Date.now() > deadline && !(await d.screen()).busy) break;
      await d.idle({ quietMs: 50, timeoutMs: 200 }).catch(() => undefined);
    }
    const { optional: _optional, timeoutMs: _timeout, ...rest } = params;
    await cli(argvFor(find('press')!, rest as StepValue));
    return undefined;
  };

  const call = async (params: Record<string, unknown> | undefined): Promise<void> => {
    if (!params?.command) throw new Error('app.call needs a command');
    const d = await device();
    const deadline = Date.now() + (typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000);
    const expect = (params.expect ?? {}) as Record<string, unknown>;
    for (;;) {
      const answer = await d.command(String(params.command), params.params);
      if (typeof params.as === 'string') scope[params.as] = answer;
      const miss = Object.entries(expect).find(([p, wanted]) => {
        const got = dig(answer, p);
        return wanted === null ? got !== undefined && got !== null : String(got) !== String(wanted);
      });
      if (!miss) return;
      if (Date.now() > deadline)
        throw new Error(`${String(params.command)}: ${miss[0]} is ${JSON.stringify(dig(answer, miss[0]))}, expected ${JSON.stringify(miss[1])}`);
      await sleep(250);
    }
  };

  // A host that keeps its own clock lets an animation finish before it answers. A phone runs on the
  // wall's and keeps moving after the last render, so only there is a pause worth its time; and a case's
  // `on: device` steps are written for that phone.
  const onWallClock = (d: Device) => !!d.server.hello?.native && !d.server.hello.commands?.includes('clock');

  let handling = false;
  const interrupted = async (value: StepValue): Promise<void> => {
    if (handling || !config.interruptions?.length) return;
    const d = await device();
    const about = JSON.stringify(value ?? '');
    for (const one of config.interruptions) {
      if (one.unless && new RegExp(one.unless, 'i').test(about)) continue;
      const target = parseTarget(one.see);
      const found = (await d.server.call('find', target).catch(() => null)) as Element | null;
      if (!found || found.hidden) continue;
      handling = true;
      try {
        for (const raw of one.do) await perform(stepOf(raw));
      } catch (error) {
        const still = (await d.server.call('find', target).catch(() => null)) as Element | null;
        if (still && !still.hidden) throw error;
      } finally {
        handling = false;
      }
    }
  };

  const app = async (name: string, value: StepValue): Promise<'skipped' | undefined> => {
    const params = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    const d = await device();
    mark ??= (await d.trace()).last;
    switch (name) {
      case 'press': {
        await interrupted(value);
        const outcome = await press(value);
        // One touch, one render: the next step reads what this one caused.
        await d.idle({ quietMs: 50, timeoutMs: 400 }).catch(() => undefined);
        return outcome;
      }
      case 'type':
      case 'swipe':
        await interrupted(value);
        await cli(argvFor(find(name)!, value));
        // A pager on a device keeps moving after the finger lifts, and swallows a swipe sent into that momentum.
        if (name === 'swipe' && onWallClock(d)) await d.idle({ quietMs: 700, timeoutMs: 8000 }).catch(() => undefined);
        return undefined;
      case 'see':
        await see(value);
        return undefined;
      case 'requests':
        mark = (await d.trace()).last;
        return undefined;
      case 'wait': {
        if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) await sleep(Number(value));
        else if (params?.request) await waitForRequest(params);
        else {
          if (config.interruptions?.length) {
            const asked: Record<string, unknown> = typeof value === 'string' ? { what: value } : { ...(params ?? {}) };
            const deadline = Date.now() + (typeof asked.timeoutMs === 'number' ? asked.timeoutMs : 10_000);
            for (;;) {
              await interrupted(value);
              const left = deadline - Date.now();
              const outcome = await execute(argvFor(find('wait')!, { ...asked, timeoutMs: Math.max(Math.min(left, 1000), 100) } as StepValue), base);
              if (!outcome.error && outcome.code === 0) break;
              if (Date.now() >= deadline) {
                why = outcome.why;
                throw new Error(outcome.error ?? outcome.text ?? 'wait failed');
              }
            }
          } else await cli(argvFor(find('wait')!, value));
          // A screen that just arrived on a device is still sliding in, which no render shows: a press then lands on the one it left.
          const what = typeof value === 'string' ? value : String(params?.what ?? '');
          if (onWallClock(d) && isRoute(what)) await d.idle({ quietMs: 700, timeoutMs: 8000 }).catch(() => undefined);
        }
        return undefined;
      }
      case 'nav': {
        const route = typeof value === 'string' ? value : String(params?.route);
        await cli(argvFor(find('nav')!, value));
        await d.waitFor({ route, timeoutMs: 8000 });
        await d.idle({ quietMs: 300, timeoutMs: 8000 });
        return undefined;
      }
      case 'call':
        await call(params);
        return undefined;
      case 'run': {
        const flow = typeof value === 'string' ? value : String(params?.flow);
        const file = path.isAbsolute(flow) ? flow : path.resolve(config.base ?? base.root, config.flows ?? 'flows', flow);
        const vars = Object.entries((params?.vars ?? {}) as Record<string, unknown>).flatMap(([k, v]) => ['--var', `${k}=${String(v)}`]);
        await cli(['run', file, ...vars]);
        return undefined;
      }
      case 'events':
        await collect(steps.length + 1);
        await d.command('events', { clear: true });
        buffer = [];
        return undefined;
      case 'event':
        await see({ ...(params ?? {}), event: typeof value === 'string' ? value : params?.name, name: undefined } as StepValue);
        return undefined;
      default: {
        const command = find(name) ?? find(`os ${name}`);
        if (!command) throw new Error(`app.${name} is not a step: lynkeus has no command ${name}, and the project declares no macro for it`);
        await cli(argvFor(command, value));
        return undefined;
      }
    }
  };

  const shell = async (value: StepValue): Promise<void> => {
    const params = typeof value === 'string' ? { run: value } : ((value ?? {}) as Record<string, unknown>);
    const { stdout } = await run(String(params.run), { cwd: config.base ?? base.root, env: process.env, timeout: 120_000 });
    if (typeof params.as !== 'string') return;
    const json = /\{[\s\S]*\}/.exec(stdout)?.[0];
    scope[params.as] = json ? JSON.parse(json) : { out: stdout.trim() };
  };

  const macro = async (steps: unknown[], value: StepValue): Promise<void> => {
    const given = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
    // A parameter that names an alias is that alias: `as: u` makes `{{param.as.user_id}}` the user's.
    const param = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, typeof v === 'string' && v in scope ? scope[v] : v]));
    const outer = scope.param;
    scope.param = param;
    try {
      for (const raw of steps) {
        const entry = raw as Record<string, unknown>;
        if ('do' in entry) {
          const all = (v: unknown) => (Array.isArray(v) ? v : [v]).map(String);
          if ('when' in entry && !all(entry.when).every((c) => holds(c, param, ran))) continue;
          if ('unless' in entry && all(entry.unless).some((c) => holds(c, param, ran))) continue;
          if ('on' in entry && !(await runsHere(String(entry.on)))) continue;
          await perform(stepOf(entry.do));
        } else await perform(stepOf(entry));
      }
    } finally {
      scope.param = outer;
    }
  };

  /**
   * `device`, `headless`, a platform, or `has:<command>` for a host whose app
   * registered that command (a hosted build often has commands a store build
   * does not); `!` in front turns any of them around. One case then carries the
   * way each host does a thing, and runs on all of them.
   */
  const runsHere = async (on: string): Promise<boolean> => {
    if (on.startsWith('!')) return !(await runsHere(on.slice(1)));
    const hello = (await device()).server.hello;
    const phone = onWallClock(await device());
    if (on === 'device') return phone;
    if (on === 'headless') return !phone;
    if (on.startsWith('has:')) return !!hello?.commands?.includes(on.slice(4));
    return hello?.platform === on;
  };

  const perform = async (step: Step): Promise<'skipped' | undefined> => {
    if (step.on && !(await runsHere(step.on))) return 'skipped';
    ran.add(step.verb);
    if (!['assert', 'app.see', 'app.wait'].includes(step.verb)) inspected.clear();
    const value = interpolate(step.value, scope);
    const custom = config.macros?.[step.verb];
    if (custom) {
      await macro(custom, value);
      return undefined;
    }
    if (step.verb.startsWith('app.')) return app(step.verb.slice(4), value);
    if (step.verb === 'assert') return void (await assert(value));
    if (step.verb === 'exec') return void (await shell(value));
    return void (await fixture(step.verb, value));
  };

  if (options.events && !options.dry) {
    const d = await base.device().catch(() => undefined);
    if (d?.server.connected) buffer = normalizeEvents(await d.command('events').catch(() => []));
  }

  const evidence = options.dry ? undefined : options.evidence;
  const offers = async (command: string) => !!(await base.device().catch(() => undefined))?.server.hello?.commands?.includes(command);
  const film = evidence?.video && (await offers('record')) ? path.join(evidence.dir, 'video.mp4') : undefined;
  // Asked only when the run keeps events: it is a call per step.
  const capturing = !options.dry && !!options.events && (await offers('analytics'));
  if (evidence) fs.mkdirSync(evidence.dir, { recursive: true });
  let filming = false;
  if (film && evidence?.video) {
    const d = await device();
    filming = await d.command('record', { path: film, fps: evidence.video.fps }).then(
      () => true,
      () => false,
    );
  }
  // What the app sent before the case began is not the case's.
  if (capturing) await (await device()).command('analytics', { take: true }).catch(() => undefined);
  const frameAt = async (): Promise<number | undefined> => {
    if (!filming || !evidence?.video) return undefined;
    const answer = (await (await device()).command('record', { frames: true }).catch(() => undefined)) as { frames?: number } | undefined;
    return typeof answer?.frames === 'number' ? Math.round((answer.frames / evidence.video.fps) * 100) / 100 : undefined;
  };
  // What a step leaves for a report: the frame after it and what it sent. Nothing here may fail the case.
  const record = async (report: StepReport, index: number, startedAt: number | undefined) => {
    if (startedAt !== undefined) report.videoS = startedAt;
    const d = await device().catch(() => undefined);
    if (!d?.server.connected) return;
    if (capturing) {
      const raw = (await d.command('analytics', { take: true }).catch(() => [])) as { sdk?: string; name?: string; properties?: Record<string, unknown> }[];
      const sent = (Array.isArray(raw) ? raw : []).flatMap((e) =>
        e?.name ? [{ provider: String(e.sdk ?? 'unknown'), name: String(e.name), ...(e.properties ? { props: e.properties } : {}) }] : [],
      );
      if (sent.length > 0) report.sent = sent;
    }
    if (evidence?.screenshots) {
      // A step may end mid-transition (a screen fading in, the splash fading out): the frame is of where the
      // step left the app, so two runs' frames of the same step show the same screen.
      // Long enough for what arrives after a short delay; a screen that never settles (an animation that
      // keeps going) is noted as such, and its frame is of a moment, not of a state.
      const settled = await d.idle({ quietMs: 700, timeoutMs: 3000 }).then(
        (r) => r.idle,
        () => false,
      );
      const file = path.join(
        evidence.dir,
        `${String(index).padStart(2, '0')}-${report.step
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 48)
          .replace(/^-|-$/g, '')}.png`,
      );
      const taken = (await offers('screenshot'))
        ? await d.command('screenshot', { path: file }).then(
            () => true,
            () => false,
          )
        : (await execute(['screenshot', file], base)).code === 0;
      if (taken && fs.existsSync(file)) {
        report.screenshot = file;
        // What each pixel shows: comparing two runs' frames needs to tell the data they were given (a name,
        // a balance) from how it was drawn.
        const screen = await d.screen().catch(() => undefined);
        if (screen) fs.writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ ...screen, settled }));
      }
    }
  };

  let failed = false;
  let unsupported = false;
  if (options.prepared) {
    steps.push(...options.prepared.steps);
    log(`  ⚡ setup made ahead (${options.prepared.steps.length} steps)`);
  }
  const todo = options.setupOnly ? c.setup : options.prepared ? c.steps : [...c.setup, ...c.steps];
  for (const step of todo) {
    const text = label(step);
    if (failed || unsupported) {
      steps.push({ step: text, status: 'skipped', ms: 0 });
      continue;
    }
    if (options.dry) {
      const unknown = unknownStep(step, config);
      steps.push({ step: text, status: unknown ? 'failed' : 'passed', ms: 0, ...(unknown ? { error: unknown } : {}) });
      if (unknown) log(`  ❌ ${text}  — ${unknown}`);
      continue;
    }
    const t0 = Date.now();
    const at = step.verb.startsWith('app.') || config.macros?.[step.verb] ? await frameAt() : undefined;
    try {
      const outcome = await perform(step);
      if (step.verb.startsWith('app.') || config.macros?.[step.verb]) await collect(steps.length + 1);
      const done: StepReport = { step: text, status: outcome === 'skipped' ? 'skipped' : 'passed', ms: Date.now() - t0 };
      steps.push(done);
      log(`  ${outcome === 'skipped' ? '⏭️' : '✅'} ${text}  (${Date.now() - t0}ms)`);
      if ((evidence || capturing) && outcome !== 'skipped' && (step.verb.startsWith('app.') || config.macros?.[step.verb]))
        await record(done, steps.length, at);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = lacking(message);
      if (missing) {
        // Not the app's doing: the rest of the case would be standing on a step that never happened.
        unsupported = true;
        steps.push({ step: text, status: 'unsupported', ms: Date.now() - t0, error: `this host has no ${missing}` });
        log(`  🚫 ${text}  — this host has no ${missing}`);
        continue;
      }
      failed = true;
      const broke: StepReport = { step: text, status: 'failed', ms: Date.now() - t0, error: message };
      steps.push(broke);
      log(`  ❌ ${text}  — ${message.split('\n')[0]}  (${Date.now() - t0}ms)`);
      if (evidence || capturing) await record(broke, steps.length, at);
    }
  }

  if (options.setupOnly && !failed) options.setupOnly.keep({ scope, latest, ran: [...ran], steps });
  if (options.dry) failed = steps.some((s) => s.status === 'failed');
  const report: CaseReport = {
    id: c.id,
    title: c.title,
    file: c.file,
    result: failed ? 'failed' : unsupported ? 'unsupported' : 'passed',
    ms: Date.now() - started,
    steps,
  };
  if (options.events) report.events = recorded;
  if (filming) {
    await (await device()).command('record', { stop: true }).catch(() => undefined);
    if (film && fs.existsSync(film)) report.video = film;
  }
  if (failed && !options.dry && !options.setupOnly) {
    const d = await device().catch(() => undefined);
    // A step that failed on its own reading of the screen left no reasons; ask for them.
    if (!why && d?.server.connected) why = (await execute(['why'], base).catch(() => undefined))?.text || undefined;
    if (d?.server.connected) {
      const screen = await d.screen().catch(() => undefined);
      const events = await d.trace(mark).catch(() => undefined);
      report.evidence = {
        screen: screen ? describeScreen(screen, { limit: 40 }) : undefined,
        requests: events?.events.flatMap((e) => (e.kind === 'request' ? [`${e.status ?? '…'} ${e.method} ${e.url}`] : [])).slice(-8),
        why,
      };
    }
    const reasons = (why ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*•\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (reasons.length > 0) report.diagnosis = reasons;
  }
  return report;
};
