/**
 * The analytics contract checked against what a run recorded: not conversion
 * (a scripted run always converts) but that the funnel a dashboard reads still
 * exists in the code, in order, with the properties it needs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson } from '../files.js';
import type { AppEvent, RunEvent } from './events.js';

/** A property is either a type the dashboard needs (`string`, `number`, `boolean`) or a value it filters on. */
export type FunnelStep = { event: string; props?: Record<string, unknown> };
export type Funnel = { name: string; steps: FunnelStep[] };

const funnelsDir = (lynkeusDir: string) => path.join(lynkeusDir, 'funnels');

export const loadFunnel = (lynkeusDir: string, name: string): Funnel => {
  const file = path.join(funnelsDir(lynkeusDir), `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no funnel ${name}: write ${path.relative(process.cwd(), file)}`);
  const funnel = readJson<Funnel>(file);
  return { ...funnel, name: funnel.name ?? name };
};

export const listFunnels = (lynkeusDir: string): Funnel[] => {
  const dir = funnelsDir(lynkeusDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadFunnel(lynkeusDir, f.slice(0, -5)));
};

const TYPES = new Set(['string', 'number', 'boolean']);
const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

const propProblems = (want: Record<string, unknown> = {}, got: Record<string, unknown> = {}): string[] =>
  Object.entries(want).flatMap(([key, expected]) => {
    if (!(key in got)) return [`${key} is missing`];
    const value = got[key];
    if (typeof expected === 'string' && TYPES.has(expected))
      return typeOf(value) === expected ? [] : [`${key} is ${typeOf(value)}, the funnel needs ${expected}`];
    return JSON.stringify(value) === JSON.stringify(expected) ? [] : [`${key} is ${JSON.stringify(value)}, the funnel filters on ${JSON.stringify(expected)}`];
  });

export type FunnelResult = { funnel: string; ok: boolean; steps: { event: string; ok: boolean; at?: number; problem?: string }[] };

export const checkFunnel = (funnel: Funnel, events: (AppEvent | RunEvent)[]): FunnelResult => {
  let cursor = 0;
  const steps = funnel.steps.map((step) => {
    const index = events.findIndex((e, i) => i >= cursor && e.name === step.event);
    if (index === -1) {
      const earlier = events.findIndex((e) => e.name === step.event);
      return { event: step.event, ok: false, problem: earlier === -1 ? 'never happened' : 'happened, but before the step it should follow' };
    }
    cursor = index + 1;
    const at = 'step' in events[index]! ? (events[index] as RunEvent).step : index;
    const problems = propProblems(step.props, events[index]!.props);
    return problems.length ? { event: step.event, ok: false, at, problem: problems.join('; ') } : { event: step.event, ok: true, at };
  });
  return { funnel: funnel.name, ok: steps.every((s) => s.ok), steps };
};

export const describeFunnel = (result: FunnelResult): string =>
  [
    `${result.ok ? '✓' : '✗'} ${result.funnel}`,
    ...result.steps.map(
      (s, i) => `  ${s.ok ? '✓' : '✗'} ${i + 1} ${s.event}${s.at !== undefined ? `  (step ${s.at})` : ''}${s.problem ? `  — ${s.problem}` : ''}`,
    ),
  ].join('\n');

type Shape = Record<string, string>;
const shapeOf = (events: AppEvent[]): Map<string, Shape> => {
  const out = new Map<string, Shape>();
  for (const e of events) {
    const shape = out.get(e.name) ?? {};
    for (const [k, v] of Object.entries(e.props ?? {})) shape[k] = typeOf(v);
    out.set(e.name, shape);
  }
  return out;
};

export type EventsDiff = { added: string[]; lost: string[]; changed: { event: string; changes: string[] }[] };

/** The same case on two builds: events that appeared, disappeared, or changed the shape of their properties. */
export const diffEvents = (before: AppEvent[], after: AppEvent[]): EventsDiff => {
  const a = shapeOf(before);
  const b = shapeOf(after);
  const added = [...b.keys()].filter((n) => !a.has(n)).sort();
  const lost = [...a.keys()].filter((n) => !b.has(n)).sort();
  const changed = [...a.keys()]
    .filter((n) => b.has(n))
    .sort()
    .flatMap((event) => {
      const was = a.get(event)!;
      const now = b.get(event)!;
      const changes = [
        ...Object.keys(now)
          .filter((k) => !(k in was))
          .map((k) => `+${k}`),
        ...Object.keys(was)
          .filter((k) => !(k in now))
          .map((k) => `-${k}`),
        ...Object.keys(was)
          .filter((k) => k in now && was[k] !== now[k])
          .map((k) => `${k} ${was[k]}→${now[k]}`),
      ];
      return changes.length ? [{ event, changes }] : [];
    });
  return { added, lost, changed };
};

export const describeEventsDiff = (diff: EventsDiff): string => {
  const lines = [...diff.added.map((n) => `+ ${n}`), ...diff.lost.map((n) => `- ${n}`), ...diff.changed.map((c) => `~ ${c.event}: ${c.changes.join(', ')}`)];
  return lines.length ? lines.join('\n') : '(same events, same shapes)';
};

/** Across runs: which funnel steps some run produced, and which none did. */
export const funnelCoverage = (funnels: Funnel[], runs: { run: string; events: AppEvent[] }[]) =>
  funnels.map((funnel) => ({
    funnel: funnel.name,
    steps: funnel.steps.map((step) => ({
      event: step.event,
      runs: runs.filter((r) => r.events.some((e) => e.name === step.event)).map((r) => r.run),
    })),
  }));
