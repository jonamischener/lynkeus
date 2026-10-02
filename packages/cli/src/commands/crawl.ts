import fs from 'node:fs';
import path from 'node:path';

import type { Element, Screen } from 'lynkeus-protocol';

import type { Device } from '../device/driver.js';
import type { Flow } from '../flow/types.js';
import { pathOf, problemsOf } from '../knowledge/problems.js';
import { createReturns, RecoveryError } from './crawl/return.js';
import { candidates, controlName, label, layerName, nodeOf, pattern, presented, stateKey, targetOf } from './crawl/state.js';
import { clearOverlayIfShown, type Overlay } from './overlay.js';

export type LoginRecovery = {
  /** Run in order after a reset, with `vars`; the last should land logged in. */
  flows: Flow[];
  vars: Record<string, unknown>;
  /** Shell commands that print a variable, run right before a flow that declares it: a one-time code, a minted session. */
  varCommands?: Record<string, string>;
};

// The one signal about a press's consequences that holds in any app, with no vocabulary.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Transition = {
  from: string;
  fromRoute?: string;
  fromLayer?: string;
  toLayer?: string;
  button: { testId?: string; text?: string };
  to: string;
  toRoute?: string;
  ms: number;
  problems: string[];
  /** The writes the press caused, when it caused any. */
  wrote?: string[];
};

export type CrawlOptions = {
  device: Device;
  outDir: string;
  depth: number;
  maxActions: number;
  neverPress?: RegExp;
  errorCopy?: RegExp;
  /** Without one, an overlay is closed by tapping its backdrop, then by a swipe down. */
  closers?: RegExp;
  backs?: RegExp;
  /** `read-only` (default): a press that makes the app write is reported, never repeated, and not explored past. */
  safety?: 'read-only' | 'anything';
  appId?: string;
  overlay?: Overlay;
  /** How to log in again after a headless host is reset (a crashed screen kills its navigator). */
  login?: LoginRecovery;
  /** Press what the directions say leads here first, and stop on arrival. */
  goal?: string;
  /** What earlier crawls pressed, and what this one learns. */
  memory?: {
    tried: (node: string) => string[];
    record: (node: string, update: { tried?: string[]; seen?: string[]; visited?: boolean }) => void;
    /** Places with controls nobody has pressed, most owed first. */
    unfinished: () => string[];
  };
  directions?: (from: string, to: string) => { press?: string; to: string }[] | null;
  onTransition?: (t: Transition) => void;
  log?: (line: string) => void;
};

export const crawl = async (options: CrawlOptions): Promise<{ transitions: Transition[]; states: Record<string, Screen> }> => {
  const { device, memory } = options;
  const readOnly = (options.safety ?? 'read-only') === 'read-only';
  fs.mkdirSync(options.outDir, { recursive: true });
  const transitions: Transition[] = [];
  const states: Record<string, Screen> = {};
  const explored = new Set<string>();
  const wrote = new Set<string>();
  const walked = new Set<string>();
  let actions = 0;
  let reached = false;
  let start: string | undefined;
  const goTo = async (route: string | undefined): Promise<void> => {
    const target = route ?? start;
    if (target) await device.navigate(target);
    else await device.back();
  };
  const { dead, recover, settle, revive, restore } = createReturns({ device, options, goTo });

  const report = (transition: Transition, t0: number) => {
    transition.ms = Math.round(performance.now() - t0);
    transitions.push(transition);
    options.onTransition?.(transition);
  };

  /** With a goal, whatever the directions say leads towards it goes first. */
  const ordered = (buttons: Element[], next: string | undefined): Element[] => {
    const toward = next ? buttons.filter((b) => b.testId === next) : [];
    if (toward.length === 0) return buttons;
    options.log?.(`towards ${options.goal}: press ${next} first`);
    return [...toward, ...buttons.filter((b) => !toward.includes(b))];
  };

  const explore = async (origin: Screen, depth: number, layer?: string): Promise<void> => {
    const key = stateKey(origin);
    if (explored.has(key) || depth > options.depth || reached) return;
    explored.add(key);
    states[key] = origin;
    const node = nodeOf(origin, layer);
    const all = candidates(origin, options.neverPress, options.backs, options.closers);
    // Only a testID is promised to a later run: a control known by its text may render differently next time.
    memory?.record(node, { seen: all.filter((b) => b.testId).map(controlName), visited: true });
    const done = new Set(memory?.tried(node) ?? []);
    const next = options.goal && options.directions ? options.directions(node, options.goal)?.[0]?.press : undefined;
    const buttons = ordered(
      all.filter((b) => !done.has(controlName(b))),
      next,
    );
    const found = new Map<string, { button: Element; layer?: string }>();
    options.log?.(
      `explore ${origin.route ?? '?'}${layer ? ` +${layer}` : ''} depth ${depth}: ${buttons.length} buttons ` +
        `(${origin.elements.filter((e) => e.hidden).length} hidden, ${presented(origin).filter((e) => e.covered).length} covered)`,
    );
    for (const button of buttons) {
      if (actions >= options.maxActions || reached) return;
      if (readOnly && wrote.has(pattern(button))) continue;
      const t0 = performance.now();
      const transition: Transition = { from: key, fromRoute: origin.route, fromLayer: layer, button: label(button), to: '', ms: 0, problems: [] };
      try {
        if (!device.server.connected) {
          await recover();
          if (!(await restore(origin, layer))) return;
        }
        const before = await device.requests();
        const present = await device.waitFor({ target: targetOf(button), timeoutMs: 800 }).then(
          () => true,
          () => false,
        );
        if (!present) {
          options.log?.(`skip ${controlName(button)}: no longer on screen`);
          continue;
        }
        actions++;
        await device.press(targetOf(button));
        const after = await settle();
        transition.to = stateKey(after);
        transition.toRoute = after.route;
        // A press made inside a layer that is still up stays in it; one that raised a layer names it.
        transition.toLayer = layerName(after, origin.presenting ? layer : controlName(button));
        const { requests } = await device.requests(before.requests.at(-1)?.id);
        transition.problems.push(...problemsOf(after, requests, options.errorCopy));
        const writes = requests.filter((r) => WRITE_METHODS.has(r.method.toUpperCase()));
        if (writes.length) {
          transition.wrote = [...new Set(writes.map((r) => `${r.method} ${pathOf(r.url)}`))];
          wrote.add(pattern(button));
        }
        report(transition, t0);
        memory?.record(node, { tried: [controlName(button)] });
        if (options.goal && after.route === options.goal) {
          options.log?.(`reached ${options.goal}`);
          reached = true;
          return;
        }
        if (transition.to === key) continue;
        if (transition.wrote && readOnly) {
          options.log?.(`stop here: pressing ${controlName(button)} wrote (${transition.wrote.join(', ')})`);
        } else if (next !== undefined && button.testId === next) {
          // Getting somewhere in particular: follow the directions now instead of sweeping this screen first.
          await explore(after, depth + 1, transition.toLayer);
        } else if (!explored.has(transition.to) && !found.has(transition.to)) {
          found.set(transition.to, { button, layer: transition.toLayer });
        }
        if (after.route) memory?.record(nodeOf(after, transition.toLayer), {});
        if (!device.server.connected) await recover();
        if (!(await restore(origin, layer))) {
          await goTo(origin.route);
          await device.idle({ quietMs: 200, timeoutMs: 1500 });
        }
      } catch (error) {
        if (error instanceof RecoveryError) throw error;
        transition.problems.push(error instanceof Error ? error.message : String(error));
        report(transition, t0);
        if (!device.server.connected) await recover().catch(() => undefined);
        if (!(await restore(origin, layer).catch(() => false))) await goTo(origin.route).catch(() => undefined);
      }
    }

    // The whole screen is swept before going into what it opened: depth-first from the first control would
    // spend the budget inside it. Layers go first: one only exists while this screen holds it open, while a
    // route stays reachable by name.
    const queue = [...found].sort(([, a], [, b]) => Number(b.layer !== undefined) - Number(a.layer !== undefined));
    for (const [to, { button, layer: into }] of queue) {
      if (reached) return;
      if (actions >= options.maxActions || explored.has(to)) continue;
      if (!(await restore(origin, layer).catch(() => false))) return;
      const target = targetOf(button);
      const back = await device
        .waitFor({ target, timeoutMs: 800 })
        .then(() => device.press(target))
        .then(() => settle())
        .catch(() => undefined);
      if (!back) continue;
      // What is there now, not what was: a banner may have rotated since the sweep.
      await explore(back, depth + 1, into);
      if (!device.server.connected) await recover().catch(() => undefined);
    }
  };

  /** A route can be jumped to; a layer is opened again from the route under it, the way the edge that found it says. */
  const walkTo = async (node: string): Promise<Screen | undefined> => {
    const [route, layer] = node.split('#');
    if (!route) return undefined;
    const jump = async () => {
      await device.navigate(route).catch(() => undefined);
      await device.idle({ quietMs: 200, timeoutMs: 2000 });
      return settle();
    };
    await revive();
    let now = await jump();
    if (now.route !== route) {
      // A dead navigator answers every jump with the same nothing; one reset is the difference between resuming and not.
      if (!dead(now)) return undefined;
      await revive();
      now = await jump();
      if (now.route !== route) return undefined;
    }
    if (!layer) return now;
    for (const step of options.directions?.(route, node) ?? []) {
      if (!step.press) return undefined;
      const press = step.press;
      const ok = await device
        .waitFor({ target: { testId: press }, timeoutMs: 1000 })
        .then(() => device.press({ testId: press }))
        .then(
          () => true,
          () => false,
        );
      if (!ok) return undefined;
      now = await settle();
    }
    return now.presenting ? now : undefined;
  };

  await clearOverlayIfShown(device, options.overlay);
  const first = await revive();
  start = first.route;
  await explore(first, 0);

  // The budget is per run and the app is bigger than one: what is left goes back in the frontier, and what
  // is still reachable gets walked to while there is budget.
  while (!reached && actions < options.maxActions) {
    const next = memory?.unfinished().find((node) => !walked.has(node));
    if (!next) break;
    walked.add(next);
    options.log?.(`resuming at ${next}`);
    const there = await walkTo(next);
    if (!there) {
      options.log?.(`could not get back to ${next}`);
      continue;
    }
    await explore(there, 0, next.split('#')[1]);
  }
  fs.writeFileSync(path.join(options.outDir, 'transitions.json'), JSON.stringify({ transitions, states }, null, 2));
  return { transitions, states };
};
