import type { Target } from 'lynkeus-protocol';

export const TARGET_HELP = '#testId | "text" | 12 (index) | 100,200';

/** `#testId`, `12` (an index), `100,200` (a point), anything else a text; `#testId[2]` or `text[2]` is the third match. */
export const parseTarget = (raw: string): Target => {
  const nth = /^(.+)\[(\d+)\]$/.exec(raw);
  if (nth && !/^\d+$/.test(nth[1]!)) {
    const base = parseTarget(nth[1]!);
    if ('testId' in base || 'text' in base) return { ...base, nth: Number(nth[2]) };
  }
  if (raw.startsWith('#')) return { testId: raw.slice(1) };
  if (/^\d+,\d+$/.test(raw)) {
    const [x, y] = raw.split(',').map(Number);
    return { x: x!, y: y! };
  }
  if (/^\d+$/.test(raw)) return { i: Number(raw) };
  return { text: raw };
};

/** A target narrowed to the match nearest another (`--in`) and to a position among the matches (`--nth`). */
export const scopedTarget = (raw: string, flags: { in?: unknown; nth?: unknown }): Target => {
  const target = parseTarget(raw);
  if (!('testId' in target) && !('text' in target)) return target;
  const scope = typeof flags.in === 'string' ? parseTarget(flags.in) : undefined;
  if (scope && !('testId' in scope) && !('text' in scope)) throw new Error('--in takes a #testId or a text');
  return {
    ...target,
    ...(scope ? { within: 'testId' in scope ? { testId: scope.testId } : { text: scope.text } } : {}),
    ...(typeof flags.nth === 'number' ? { nth: flags.nth } : {}),
  };
};

export const isRoute = (raw: string) => /^[A-Z]\w*(\.[A-Z]\w*)*$/.test(raw);

export type Expected = { testId?: string; text?: string; route?: string };

/** What a command was looking for, as `why` reads it. */
export const expectedOf = (raw: string | undefined): Expected | undefined => {
  if (!raw) return undefined;
  if (isRoute(raw)) return { route: raw };
  const t = parseTarget(raw);
  return 'testId' in t ? { testId: t.testId } : 'text' in t ? { text: t.text } : undefined;
};
