import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lintScreen } from '../lint.js';
import type { Screen } from 'lynkeus-protocol';

const screen = (elements: Partial<Screen['elements'][number]>[]): Screen =>
  ({
    path: ['Root'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: elements.map((e, i) => ({ i, kind: 'view', frame: { x: 0, y: 0, w: 100, h: 50 }, enabled: true, depth: 0, ...e })) as Screen['elements'],
  }) as Screen;

test('an unlabeled button is flagged', () => {
  const f = lintScreen(screen([{ kind: 'button' }]));
  assert.equal(f.filter((x) => x.rule === 'unlabeled-control').length, 1);
});
test('a labeled button is not', () => {
  const f = lintScreen(screen([{ kind: 'button', testId: 'ok' }]));
  assert.equal(f.filter((x) => x.rule === 'unlabeled-control').length, 0);
});
test('an icon-only small target warns, a labeled one (a tab item) is info', () => {
  const f = lintScreen(
    screen([
      { kind: 'button', testId: 'icon', frame: { x: 0, y: 0, w: 24, h: 24 } },
      { kind: 'button', testId: 'tab', text: 'HOME', frame: { x: 0, y: 0, w: 26, h: 16 } },
    ]),
  );
  const small = f.filter((x) => x.rule === 'small-target');
  assert.equal(small.find((x) => x.message.includes('icon'))?.severity, 'warn');
  assert.equal(small.find((x) => x.message.includes('tab'))?.severity, 'info');
});
test('an untranslated i18n key is flagged, real copy is not', () => {
  const f = lintScreen(
    screen([
      { kind: 'text', text: 'profile.settings.title' },
      { kind: 'text', text: 'Settings' },
    ]),
  );
  assert.equal(f.filter((x) => x.rule === 'untranslated').length, 1);
});
test('the theme-[object Object] duplicate testId is caught', () => {
  const f = lintScreen(
    screen([
      { kind: 'button', testId: 'theme-[object Object]-radio', frame: { x: 0, y: 0, w: 24, h: 24 } },
      { kind: 'button', testId: 'theme-[object Object]-radio', frame: { x: 0, y: 100, w: 24, h: 24 } },
    ]),
  );
  assert.equal(f.filter((x) => x.rule === 'duplicate-testid').length, 1);
});
test('a covered interactive element is info, a covered view is nothing', () => {
  const f = lintScreen(
    screen([
      { kind: 'button', testId: 'under', covered: true },
      { kind: 'view', covered: true },
    ]),
  );
  assert.equal(f.filter((x) => x.rule === 'covered-control').length, 1);
});
test('an element drawn past the window is flagged', () => {
  const f = lintScreen(screen([{ kind: 'text', text: 'wide', frame: { x: 300, y: 0, w: 200, h: 20 } }]));
  assert.equal(f.filter((x) => x.rule === 'offscreen').length, 1);
});
