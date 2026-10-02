import fs from 'node:fs';
import path from 'node:path';

import type { Element, Screen } from 'lynkeus-protocol';

import { stamp } from '../files.js';

export const runDir = (root: string, flowName: string): string => {
  const slug = flowName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const dir = path.join(root, slug, stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const stepFile = (dir: string, index: number, extension: string) => path.join(dir, `step-${String(index).padStart(2, '0')}.${extension}`);

const key = (e: Element) => `${e.kind}|${e.testId ?? ''}|${e.text ?? e.accessibilityLabel ?? ''}`;

export type ScreenDiff = {
  route: { before?: string; after?: string; changed: boolean };
  added: Element[];
  removed: Element[];
  changedText: { before: Element; after: Element }[];
};

/** Structural difference between two screens: no geometry, so layout jitter is not a change. */
export const diffScreens = (before: Screen, after: Screen): ScreenDiff => {
  const beforeByKey = new Map(before.elements.map((e) => [key(e), e]));
  const afterByKey = new Map(after.elements.map((e) => [key(e), e]));
  const added = after.elements.filter((e) => !beforeByKey.has(key(e)));
  const removed = before.elements.filter((e) => !afterByKey.has(key(e)));

  // Same identity (testId) but different text: a value or a label changed.
  const changedText: ScreenDiff['changedText'] = [];
  const removedById = new Map(removed.filter((e) => e.testId).map((e) => [e.testId!, e]));
  for (const e of added) {
    const previous = e.testId ? removedById.get(e.testId) : undefined;
    if (previous) changedText.push({ before: previous, after: e });
  }
  const paired = new Set(changedText.flatMap((c) => [c.before, c.after]));
  return {
    route: { before: before.route, after: after.route, changed: before.route !== after.route },
    added: added.filter((e) => !paired.has(e)),
    removed: removed.filter((e) => !paired.has(e)),
    changedText,
  };
};

const label = (e: Element) => `${e.kind} ${e.testId ? `#${e.testId}` : ''} ${e.text ? JSON.stringify(e.text.slice(0, 60)) : ''}`.trim();

export const describeDiff = (diff: ScreenDiff): string => {
  const lines: string[] = [];
  if (diff.route.changed) lines.push(`route ${diff.route.before ?? '?'} → ${diff.route.after ?? '?'}`);
  for (const c of diff.changedText) lines.push(`~ ${label(c.before)} → ${JSON.stringify(c.after.text ?? '')}`);
  for (const e of diff.added) lines.push(`+ ${label(e)}`);
  for (const e of diff.removed) lines.push(`- ${label(e)}`);
  return lines.length ? lines.join('\n') : '(no structural change)';
};
