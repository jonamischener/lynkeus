import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Screen } from 'lynkeus-protocol';

import { describeScreen } from '../device/driver.js';
import { parseTarget, scopedTarget } from '../targets.js';

test('a #-prefixed string is a testId', () => {
  assert.deepEqual(parseTarget('#next-button'), { testId: 'next-button' });
});
test('an x,y pair is a point', () => {
  assert.deepEqual(parseTarget('100,200'), { x: 100, y: 200 });
});
test('a bare integer is an index', () => {
  assert.deepEqual(parseTarget('12'), { i: 12 });
});
test('anything else is text', () => {
  assert.deepEqual(parseTarget('Some label'), { text: 'Some label' });
});
test('a testId that contains a comma is still a testId, not a point', () => {
  assert.deepEqual(parseTarget('#a,b'), { testId: 'a,b' });
});

test('describeScreen prints the value a QR image carries', () => {
  const screen = {
    route: 'X',
    path: ['X'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [{ i: 0, kind: 'image', frame: { x: 0, y: 0, w: 168, h: 169 }, enabled: true, depth: 0, accessibilityLabel: 'qr', value: 'QR-TEST-0001' }],
  } as unknown as Screen;
  assert.match(describeScreen(screen), /image .*value="QR-TEST-0001"/);
});
test('describeScreen lists a view with a testID and leaves plain layout out', () => {
  const screen = {
    route: 'X',
    path: ['X'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [
      { i: 0, kind: 'view', frame: { x: 0, y: 0, w: 390, h: 844 }, enabled: true, depth: 0 },
      { i: 1, kind: 'view', frame: { x: 0, y: 0, w: 390, h: 400 }, enabled: true, depth: 1, testId: 'intro-page-advances' },
    ],
  } as unknown as Screen;
  const text = describeScreen(screen);
  assert.match(text, /view +#intro-page-advances/);
  assert.doesNotMatch(text, /^0? ?view$/m);
});
test('describeScreen leaves out what is not presented, counts it, and lists it with --all', () => {
  const el = (i: number, over: object) => ({ i, kind: 'button', frame: { x: 0, y: 0, w: 100, h: 40 }, enabled: true, depth: 0, ...over });
  const screen = {
    route: 'X',
    path: ['X'],
    commit: 7,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 3,
    elements: [
      el(0, { testId: 'tab-a', hidden: 'a11y' }),
      el(1, { testId: 'behind', hidden: 'behind-overlay' }),
      el(2, { testId: 'slide', hidden: 'inert' }),
      el(3, { testId: 'close', enabled: false }),
    ],
  } as unknown as Screen;
  const text = describeScreen(screen);
  assert.equal(text.split('\n')[0] ?? '', 'X · 2 hidden: 1 a11y, 1 behind-overlay');
  assert.doesNotMatch(text, /#tab-a|#behind/);
  assert.match(text, /^button #slide ~inert$/m);
  assert.match(text, /^button #close !disabled$/m);
  assert.match(describeScreen(screen, { all: true }), /#behind ~behind-overlay/);
  assert.match(describeScreen(screen, { frames: true }), /#slide ~inert @50,20$/m);
  assert.match(describeScreen(screen, { verbose: true }).split('\n')[0] ?? '', /commit=7 3ms/);
});
test("describeScreen leaves a button's icon out", () => {
  const screen = {
    route: 'X',
    path: ['X'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [
      { i: 0, kind: 'button', frame: { x: 0, y: 0, w: 100, h: 40 }, enabled: true, depth: 0, testId: 'open' },
      { i: 1, kind: 'view', frame: { x: 0, y: 0, w: 20, h: 20 }, enabled: true, depth: 1, testId: 'SvgArrow', parent: 0 },
      { i: 2, kind: 'view', frame: { x: 0, y: 50, w: 20, h: 20 }, enabled: true, depth: 0, testId: 'page-marker' },
    ],
  } as unknown as Screen;
  assert.doesNotMatch(describeScreen(screen), /SvgArrow/);
  assert.match(describeScreen(screen), /#page-marker/);
  assert.match(describeScreen(screen, { all: true }), /SvgArrow/);
});
test('describeScreen gives an index only to what cannot be named apart', () => {
  const el = (i: number, over: object) => ({ i, kind: 'button', frame: { x: 0, y: 0, w: 100, h: 40 }, enabled: true, depth: 0, ...over });
  const screen = {
    route: 'X',
    path: ['X'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [
      el(0, { testId: 'save' }),
      el(1, { testId: 'like' }),
      el(2, { testId: 'like' }),
      el(3, { kind: 'text', text: 'Hello' }),
      el(4, { kind: 'view', testId: 'marker', accessibilityLabel: 'marker' }),
      el(5, {}),
    ],
  } as unknown as Screen;
  assert.deepEqual(describeScreen(screen).split('\n').slice(1), [
    'button #save',
    '1 button #like',
    '2 button #like',
    'text "Hello"',
    'view #marker',
    '5 button',
  ]);
});
test('a [n] suffix picks the nth match of a testId or text', () => {
  assert.deepEqual(parseTarget('#field[2]'), { testId: 'field', nth: 2 });
  assert.deepEqual(parseTarget('Ciudad[0]'), { text: 'Ciudad', nth: 0 });
});
test('--in and --nth narrow a target', () => {
  assert.deepEqual(scopedTarget('#like-message-button', { in: 'hi from Ana' }), { testId: 'like-message-button', within: { text: 'hi from Ana' } });
  assert.deepEqual(scopedTarget('#like-message-button', { in: '#feed', nth: 2 }), { testId: 'like-message-button', within: { testId: 'feed' }, nth: 2 });
  assert.deepEqual(scopedTarget('100,200', { in: '#feed' }), { x: 100, y: 200 });
});
