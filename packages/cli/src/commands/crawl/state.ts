import { createHash } from 'node:crypto';

import type { Element, Screen, Target } from 'lynkeus-protocol';

const layerOf = (s: Screen) => s.presenting?.testId ?? (s.presenting?.modal ? 'modal' : 'overlay');

/**
 * What makes a screen a different screen: its route, the layer over it and the
 * set of controls it offers. A set because carousels and lists repeat testIDs
 * and animate; hashed rather than truncated, because cutting a long list made
 * two screens look identical and the crawl never went inside the second.
 */
export const stateKey = (s: Screen) => {
  const ids = [
    ...new Set(
      presented(s)
        .filter((e) => e.kind === 'button' && e.testId && !e.covered)
        .map((e) => e.testId),
    ),
  ]
    .sort()
    .join(',');
  return `${s.route ?? '?'}${s.presenting ? `+${layerOf(s)}` : ''}|${createHash('sha1').update(ids).digest('hex').slice(0, 12)}`;
};

/** Another tab, or the screen a sheet covers, is mounted but out of a finger's reach. */
export const presented = (s: Screen): Element[] => s.elements.filter((e) => !e.hidden);

/** A sheet has no route, so it is named after the control that opened it: that is also how to get back into it. */
export const layerName = (s: Screen, openedBy?: string): string | undefined => (s.presenting ? (openedBy ?? layerOf(s)) : undefined);

export const controlName = (e: Element): string => e.testId ?? `text:${e.text ?? ''}`;

/** Where the agent stands; a sheet that mounted a beat after the press still belongs to itself, not to the screen under it. */
export const nodeOf = (s: Screen, layer?: string): string => {
  const here = layer ?? (s.presenting ? (s.presenting.testId ?? 'overlay') : undefined);
  return `${s.route ?? '?'}${here ? `#${here}` : ''}`;
};

/** A control by the name the frontier and the edges record it under. */
export const targetFor = (control: string): Target => (control.startsWith('text:') ? { text: control.slice(5) } : { testId: control });

export const targetOf = (e: Element): Target => targetFor(controlName(e));

// List rows carry their record id in the testID; one row per pattern is enough to learn where rows lead.
export const pattern = (e: Element) => (e.testId ?? e.text ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}|\d+/gi, '*');

const words = (e: Element) => `${e.testId ?? ''} ${e.text ?? ''}`;

/**
 * The controls worth pressing. A closer or a back control leads to where the
 * crawl came from, not somewhere new; without an app's own list of back
 * controls, a small one in the top-left corner is taken for one.
 */
export const candidates = (s: Screen, neverPress?: RegExp, backs?: RegExp, closers?: RegExp): Element[] => {
  const seen = new Set<string>();
  const corner = (e: Element) => e.frame.x < s.window.w / 4 && e.frame.y < s.window.h / 8 && e.frame.w < s.window.w / 4;
  return presented(s).filter((e) => {
    if (e.kind !== 'button' || !e.enabled || e.covered || !(e.testId || e.text)) return false;
    if (neverPress?.test(words(e)) || closers?.test(words(e)) || (backs ? backs.test(words(e)) : corner(e))) return false;
    const key = pattern(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const label = (e: Element) => ({ testId: e.testId, text: e.text?.slice(0, 40) });

export const isCloser = (e: Element, closers: RegExp) => e.kind === 'button' && e.enabled && !e.covered && closers.test(words(e));
