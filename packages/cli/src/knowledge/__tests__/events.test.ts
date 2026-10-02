import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Device } from '../../device/driver.js';
import { runFlow } from '../../flow/runner.js';
import { eventsFile, normalizeEvents, readEvents } from '../events.js';

test('an app buffer that says properties reads as props', () => {
  assert.deepEqual(normalizeEvents([{ name: 'a', properties: { x: 1 } }, { name: 'b', props: { y: 2 } }, { nope: true }]), [
    { name: 'a', props: { x: 1 } },
    { name: 'b', props: { y: 2 } },
  ]);
});

test('a run with events keeps each one with the step and route that caused it', async () => {
  let buffer: unknown[] = [{ name: 'app_opened' }];
  const routes = ['Checkout.Main', 'Checkout.Confirm'];
  let step = 0;
  const device = {
    server: { connected: true },
    press: async () => {
      buffer.push({ name: step === 0 ? 'checkout_started' : 'checkout_confirmed', properties: { step } });
      step += 1;
    },
    screen: async () => ({ route: routes[step - 1], path: [], elements: [], commit: 0, busy: false, window: { w: 1, h: 1 }, costMs: 0 }),
    command: async (name: string, params?: { clear?: boolean }) => {
      assert.equal(name, 'events');
      const out = buffer;
      if (params?.clear) buffer = [];
      return out;
    },
  } as unknown as Device;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-events-'));
  const report = await runFlow(
    { name: 'checkout', steps: [{ press: { testId: 'start' } }, { press: { testId: 'confirm' } }] },
    { device, artifactsRoot: root, events: true },
  );
  assert.deepEqual(readEvents(eventsFile(report.dir!)), [
    { name: 'checkout_started', props: { step: 0 }, step: 1, route: 'Checkout.Main' },
    { name: 'checkout_confirmed', props: { step: 1 }, step: 2, route: 'Checkout.Confirm' },
  ]);
});
