import { describe, expect, it } from '@jest/globals';

import { pick, score } from '../handlers';
import type { Element } from '../protocol';

const el = (over: Partial<Element>): Element => ({
  i: 0,
  kind: 'view',
  frame: { x: 0, y: 0, w: 10, h: 10 },
  enabled: true,
  depth: 0,
  ...over,
});

describe('score', () => {
  it('matches testId exactly', () => {
    expect(score(el({ testId: 'a' }), { testId: 'a' })).toBe(4);
    expect(score(el({ testId: 'ab' }), { testId: 'a' })).toBe(0);
  });

  it('prefers exact text on a control over the same text in a paragraph', () => {
    const button = el({ kind: 'button', text: 'Continue' });
    const paragraph = el({ kind: 'text', text: 'Continue' });
    expect(score(button, { text: 'continue' })).toBeGreaterThan(score(paragraph, { text: 'continue' }));
  });

  it('never targets a substring inside a paragraph', () => {
    const paragraph = el({ kind: 'text', text: 'By tapping Submit you accept the terms' });
    expect(score(paragraph, { text: 'accept' })).toBe(0);
    const button = el({ kind: 'button', text: 'Submit via email' });
    expect(score(button, { text: 'submit' })).toBe(2);
  });
});

describe('pick', () => {
  it('prefers the one a touch reaches when two share a testId', () => {
    const elements = [el({ i: 0, testId: 'slide', kind: 'button' }), el({ i: 1, testId: 'slide', kind: 'button', hidden: 'inert' })];
    expect(pick(elements, { testId: 'slide' })?.i).toBe(0);
  });

  it('takes the nth of several controls sharing a testId, in tree order, skipping hidden ones', () => {
    const elements = [
      el({ i: 0, kind: 'input', testId: 'field', value: 'street' }),
      el({ i: 1, kind: 'input', testId: 'field', hidden: 'behind-modal' }),
      el({ i: 2, kind: 'input', testId: 'field', value: 'city' }),
      el({ i: 3, kind: 'input', testId: 'field', value: 'zip' }),
    ];
    expect(pick(elements, { testId: 'field', nth: 1 })?.i).toBe(2);
    expect(pick(elements, { testId: 'field', nth: 5 })).toBeUndefined();
  });

  it('prefers reachable elements and takes the later of equal scores', () => {
    const elements = [
      el({ i: 0, kind: 'button', testId: 'go' }),
      el({ i: 1, kind: 'button', testId: 'go' }),
      el({ i: 2, kind: 'button', testId: 'go', covered: true }),
    ];
    expect(pick(elements, { testId: 'go' })?.i).toBe(1);
  });

  it('still finds a covered element when nothing reachable matches', () => {
    const otp = el({ i: 3, kind: 'input', testId: 'hidden-input', covered: true });
    expect(pick([el({ kind: 'button', text: 'Paste' }), otp], { testId: 'hidden-input' })).toBe(otp);
  });

  it('returns nothing for a point target', () => {
    expect(pick([el({ testId: 'x' })], { x: 1, y: 1 })).toBeUndefined();
  });
});

describe('a target within a scope', () => {
  const el = (i: number, over: Partial<Element>): Element => ({ i, kind: 'view', frame: { x: 0, y: i * 10, w: 100, h: 10 }, enabled: true, depth: 0, ...over });
  const feed: Element[] = [
    el(0, { testId: 'feed' }),
    el(1, { testId: 'row', parent: 0 }),
    el(2, { kind: 'text', text: 'hi from Ana', parent: 1 }),
    el(3, { kind: 'button', testId: 'like-message-button', parent: 1 }),
    el(4, { testId: 'row', parent: 0 }),
    el(5, { kind: 'text', text: 'hi from Beto', parent: 4 }),
    el(6, { kind: 'button', testId: 'like-message-button', parent: 4 }),
  ];

  it('takes the match in the smallest container around the scope', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Beto' } })?.i).toBe(6);
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Ana' } })?.i).toBe(3);
  });

  it('with rows that are not listed, takes the match nearest the scope in tree order', () => {
    const flat = feed.map((e) => (e.parent === 1 || e.parent === 4 ? { ...e, parent: 0 } : e)).filter((e) => e.testId !== 'row');
    expect(pick(flat, { testId: 'like-message-button', within: { text: 'hi from Ana' } })?.i).toBe(3);
    expect(pick(flat, { testId: 'like-message-button', within: { text: 'hi from Beto' } })?.i).toBe(6);
  });

  it('counts nth inside the scope', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { testId: 'feed' }, nth: 1 })?.i).toBe(6);
  });

  it('finds nothing when the scope is not there', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Carla' } })).toBeUndefined();
  });
});
