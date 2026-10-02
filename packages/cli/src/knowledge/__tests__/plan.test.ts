import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ObservedEdge } from '../edges.js';
import { describePlan, plan } from '../plan.js';
import type { ScreenGraph } from '../types.js';

const graph = (routes: string[]): ScreenGraph => ({
  app: 'test',
  root: '/tmp',
  extractedAt: '2026-01-01',
  screens: Object.fromEntries(routes.map((route) => [route, { route, component: route, file: null, declaredIn: 'nav.tsx' }])),
  files: {},
  warnings: [],
});

const edge = (e: Partial<ObservedEdge> & Pick<ObservedEdge, 'from' | 'to' | 'via'>): ObservedEdge => ({ seen: 1, last: '2026-01-01', ...e });

test('a sheet is a place the directions can reach', () => {
  const steps = plan(graph(['Settings.Main', 'Account.Delete']), 'Settings.Main', 'Account.Delete', [
    edge({ from: 'Settings.Main', to: 'Settings.Main', via: 'account-button', toLayer: 'account-button' }),
    edge({ from: 'Settings.Main', to: 'Account.Delete', via: 'delete-account-button', fromLayer: 'account-button' }),
  ]);

  assert.deepEqual(
    steps?.map((s) => [s.from, s.press, s.to]),
    [
      ['Settings.Main', 'account-button', 'Settings.Main#account-button'],
      ['Settings.Main#account-button', 'delete-account-button', 'Account.Delete'],
    ],
  );
  assert.match(describePlan(steps!), /opens a layer/);
});

test('what a screen offers does not apply while a sheet covers it', () => {
  const steps = plan(graph(['Settings.Main', 'Profile.Edit']), 'Settings.Main#account-button', 'Profile.Edit', [
    edge({ from: 'Settings.Main', to: 'Profile.Edit', via: 'profile-button' }),
  ]);

  assert.equal(steps, null);
});

test('asking for a route accepts arriving with something open over it', () => {
  const steps = plan(graph(['Settings.Main', 'Checkout.Main']), 'Settings.Main', 'Checkout.Main', [
    edge({ from: 'Settings.Main', to: 'Checkout.Main', via: 'send-button', toLayer: 'send-button' }),
  ]);

  assert.deepEqual(
    steps?.map((s) => s.to),
    ['Checkout.Main#send-button'],
  );
});
