import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Screen } from 'lynkeus-protocol';

import { diffGeometry, record } from '../screens.js';

const f = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

test('drift within the tolerance is not a change', () => {
  assert.deepEqual(diffGeometry({ a: f(10, 10, 100, 40) }, { a: f(12, 8, 102, 41) }), []);
});
test('a move past the tolerance is reported with both positions', () => {
  assert.deepEqual(diffGeometry({ a: f(10, 10, 100, 40) }, { a: f(10, 60, 100, 40) }), ['#a moved (10,10)→(10,60)']);
});
test('a resize is reported', () => {
  assert.deepEqual(diffGeometry({ a: f(0, 0, 100, 40) }, { a: f(0, 0, 100, 80) }), ['#a resized 100×40→100×80']);
});
test('an element that collapsed to zero is named as such', () => {
  assert.deepEqual(diffGeometry({ a: f(0, 0, 100, 40) }, { a: f(0, 0, 100, 0) }), ['#a collapsed to 100×0 (was 100×40)']);
});
test('elements only on one side are not geometry changes', () => {
  assert.deepEqual(diffGeometry({ a: f(0, 0, 1, 1) }, { b: f(0, 0, 1, 1) }), []);
});

test('a recorded screen keeps what is presented, not what another tab or a covered screen holds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-screens-'));
  const el = (i: number, testId: string, hidden?: string) => ({ i, kind: 'button', frame: f(0, i * 50, 100, 40), enabled: true, depth: 0, testId, hidden });
  const screen = (elements: object[]) =>
    ({ route: 'Settings.Main', path: ['Settings.Main'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements }) as unknown as Screen;
  record(dir, screen([el(0, 'save'), el(1, 'other-tab', 'a11y'), el(2, 'slide', 'inert')]));
  const change = record(dir, screen([el(0, 'save'), el(2, 'slide', 'inert')]));
  assert.equal(change, null);
});
