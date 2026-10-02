/**
 * The screen as nested lines of meaning (kinds, labels, testIDs, values,
 * states) and no geometry: a spacing tweak changes nothing, a renamed heading
 * or a lost button is a changed line. Diffed like code.
 */
import type { Element, Screen } from 'lynkeus-protocol';

const quote = (s: string) => JSON.stringify(s);

const node = (e: Element): string => {
  const parts: string[] = [e.kind];
  const label = e.text ?? e.accessibilityLabel;
  if (label) parts.push(quote(label.length > 80 ? `${label.slice(0, 77)}…` : label));
  if (e.testId) parts.push(`#${e.testId}`);
  if (e.value !== undefined && e.value !== '') parts.push(`value=${quote(e.value)}`);
  if (e.placeholder) parts.push(`placeholder=${quote(e.placeholder)}`);
  const state = [!e.enabled ? 'disabled' : '', e.covered ? 'covered' : '', e.hidden ?? '', e.focused ? 'focused' : ''].filter(Boolean);
  if (state.length) parts.push(`[${state.join(' ')}]`);
  return parts.join(' ');
};

const meaningful = (e: Element): boolean => e.kind !== 'view' || e.accessibilityLabel !== undefined || e.testId !== undefined;

export const screenTree = (screen: Screen): string => {
  const lines = [`- screen ${screen.route ?? '?'}${screen.path.length > 1 ? ` (${screen.path.join(' > ')})` : ''}`];
  // Relative to the nearest listed ancestor, so the layout views left out leave no gaps.
  const level = new Map<number, number>();
  for (const e of screen.elements) {
    const parentLevel = e.parent !== undefined && e.parent >= 0 ? (level.get(e.parent) ?? 0) : 0;
    if (!meaningful(e)) {
      level.set(e.i, parentLevel);
      continue;
    }
    const mine = parentLevel + 1;
    level.set(e.i, mine);
    lines.push(`${'  '.repeat(mine)}- ${node(e)}`);
  }
  return `${lines.join('\n')}\n`;
};

export type TreeDiff = { added: string[]; removed: string[]; same: number };

/** The lines only one side has. */
export const diffTrees = (before: string, after: string): TreeDiff => {
  const a = before.split('\n').filter(Boolean);
  const b = after.split('\n').filter(Boolean);
  const countA = new Map<string, number>();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  const added: string[] = [];
  let same = 0;
  for (const l of b) {
    const n = countA.get(l) ?? 0;
    if (n > 0) {
      countA.set(l, n - 1);
      same += 1;
    } else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, n] of countA) for (let i = 0; i < n; i++) removed.push(l);
  return { added, removed, same };
};

export const describeTreeDiff = (d: TreeDiff): string => {
  if (!d.added.length && !d.removed.length) return '  (the tree did not change)';
  return [...d.removed.map((l) => `- ${l.trim()}`), ...d.added.map((l) => `+ ${l.trim()}`)].map((l) => `  ${l}`).join('\n');
};
