/**
 * The structure of each route the last time it was read, under
 * .lynkeus/screens/, and in changes.jsonl every testID that appeared,
 * disappeared or moved since: a suite that never asserts on an element still
 * tells you the day it vanished.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Screen } from 'lynkeus-protocol';

import { diffScreens } from '../flow/artifacts.js';
import { appendJsonl, readJsonl, today } from '../files.js';

type Frame = { x: number; y: number; w: number; h: number };
type Stored = { route: string; path: string[]; seen: number; date: string; elements: Screen['elements']; frames?: Record<string, Frame> };

export type ScreenChange = { route: string; date: string; added: string[]; removed: string[]; changedText: string[]; moved?: string[] };

// Sub-pixel rounding and font hinting move an element a point or two without any layout change.
const GEOMETRY_TOLERANCE = 4;

const presented = (e: Screen['elements'][number]) => !e.hidden || e.hidden === 'inert';

const framesOf = (screen: Screen): Record<string, Frame> => {
  const out: Record<string, Frame> = {};
  for (const e of screen.elements.filter(presented)) {
    if (!e.testId || !e.frame || out[e.testId]) continue;
    out[e.testId] = { x: Math.round(e.frame.x), y: Math.round(e.frame.y), w: Math.round(e.frame.w), h: Math.round(e.frame.h) };
  }
  return out;
};

export const diffGeometry = (before: Record<string, Frame>, after: Record<string, Frame>, tolerance = GEOMETRY_TOLERANCE): string[] => {
  const lines: string[] = [];
  for (const [id, a] of Object.entries(after)) {
    const b = before[id];
    if (!b) continue;
    const moved = Math.abs(a.x - b.x) > tolerance || Math.abs(a.y - b.y) > tolerance;
    const resized = Math.abs(a.w - b.w) > tolerance || Math.abs(a.h - b.h) > tolerance;
    const collapsed = (a.w === 0 || a.h === 0) && b.w > 0 && b.h > 0;
    if (collapsed) lines.push(`#${id} collapsed to ${a.w}×${a.h} (was ${b.w}×${b.h})`);
    else if (moved && resized) lines.push(`#${id} moved (${b.x},${b.y})→(${a.x},${a.y}) and resized ${b.w}×${b.h}→${a.w}×${a.h}`);
    else if (moved) lines.push(`#${id} moved (${b.x},${b.y})→(${a.x},${a.y})`);
    else if (resized) lines.push(`#${id} resized ${b.w}×${b.h}→${a.w}×${a.h}`);
  }
  return lines;
};

const dirOf = (lynkeusDir: string) => path.join(lynkeusDir, 'screens');
const fileOf = (lynkeusDir: string, route: string) => path.join(dirOf(lynkeusDir), `${route.replace(/[^\w.-]/g, '_')}.json`);
const changesFile = (lynkeusDir: string) => path.join(dirOf(lynkeusDir), 'changes.jsonl');

const strip = (screen: Screen): Screen['elements'] =>
  screen.elements.filter(presented).map((e) => {
    const { frame: _frame, ...rest } = e as Screen['elements'][number] & { frame?: unknown };
    return rest as Screen['elements'][number];
  });

const label = (e: Screen['elements'][number]) => `${e.kind}${e.testId ? ` #${e.testId}` : ''}${e.text ? ` ${JSON.stringify(e.text.slice(0, 60))}` : ''}`;

/** Stores the screen under its route and returns what changed since the previous read. */
export const record = (lynkeusDir: string, screen: Screen): ScreenChange | null => {
  if (!screen.route) return null;
  fs.mkdirSync(dirOf(lynkeusDir), { recursive: true });
  const file = fileOf(lynkeusDir, screen.route);
  const date = today();
  const elements = strip(screen);
  let previous: Stored | null = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8')) as Stored;
  } catch {}
  const frames = framesOf(screen);
  const next: Stored = { route: screen.route, path: screen.path, seen: (previous?.seen ?? 0) + 1, date, elements, frames };
  fs.writeFileSync(file, JSON.stringify(next, null, 1));
  if (!previous) return null;
  const diff = diffScreens({ ...screen, elements: previous.elements }, { ...screen, elements });
  // Texts carry values that change every run; only a testID appearing or disappearing is worth a line.
  const added = diff.added.filter((e) => e.testId).map(label);
  const removed = diff.removed.filter((e) => e.testId).map(label);
  const moved = previous.frames ? diffGeometry(previous.frames, frames) : [];
  if (added.length === 0 && removed.length === 0 && moved.length === 0) return null;
  const change: ScreenChange = {
    route: screen.route,
    date,
    added,
    removed,
    moved,
    changedText: diff.changedText.map((c) => `#${c.after.testId}: ${JSON.stringify(c.before.text ?? '')} → ${JSON.stringify(c.after.text ?? '')}`).slice(0, 10),
  };
  appendJsonl(changesFile(lynkeusDir), change);
  return change;
};

export type Observed = {
  route: string;
  path: string[];
  seen: number;
  date: string;
  testIds: string[];
};

/** What runs have seen, by route: the routes and interpolated testIDs a static parser cannot find. */
export const observed = (lynkeusDir: string): Map<string, Observed> => {
  const out = new Map<string, Observed>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dirOf(lynkeusDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files) {
    let stored: Stored;
    try {
      stored = JSON.parse(fs.readFileSync(path.join(dirOf(lynkeusDir), file), 'utf8')) as Stored;
    } catch {
      continue;
    }
    if (!stored.route) continue;
    const testIds: string[] = [];
    for (const e of stored.elements ?? []) {
      if (!e.testId || e.hidden) continue;
      if (!testIds.includes(e.testId)) testIds.push(e.testId);
    }
    out.set(stored.route, { route: stored.route, path: stored.path ?? [], seen: stored.seen ?? 1, date: stored.date, testIds });
  }
  return out;
};

export const changes = (lynkeusDir: string, last = 50): ScreenChange[] => readJsonl<ScreenChange>(changesFile(lynkeusDir)).slice(-last);

export const describeChange = (c: ScreenChange): string =>
  [
    `${c.date}  ${c.route}`,
    ...c.added.map((a) => `    + ${a}`),
    ...c.removed.map((r) => `    - ${r}`),
    ...(c.moved ?? []).map((m) => `    ⇢ ${m}`),
    ...c.changedText.map((t) => `    ~ ${t}`),
  ].join('\n');
