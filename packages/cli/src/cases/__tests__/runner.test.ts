import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { driveCommands } from '../../commands/drive.js';
import { osCommands } from '../../commands/os.js';
import type { Device } from '../../device/driver.js';
import { type Base, find, register } from '../../registry.js';
import { Fixtures } from '../fixtures.js';
import { parseCase } from '../format.js';
import { argvFor, missingFixtures, newSince, runCase } from '../runner.js';
import { FIXTURES } from '../templates.js';

register([...driveCommands, ...osCommands]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-cases-'));
fs.writeFileSync(path.join(root, 'fixtures.mjs'), FIXTURES);
const fixtures = new Fixtures({ command: 'node fixtures.mjs' }, root);
after(() => fixtures.close());

type Call = { method: string; params: unknown };

// An app with one button that, pressed, shows the points the fixtures hold.
const fakeApp = () => {
  const calls: Call[] = [];
  let shown = 'Hello';
  const screen = () => ({
    route: 'Profile.Main',
    path: ['Profile.Main'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [
      { i: 0, kind: 'button', testId: 'refresh', enabled: true, depth: 0, frame: { x: 0, y: 0, w: 100, h: 40 } },
      { i: 1, kind: 'text', text: shown, enabled: true, depth: 0, frame: { x: 0, y: 50, w: 100, h: 20 } },
    ],
  });
  const server = {
    connected: true,
    call: async (method: string, params: { testId?: string }) => {
      calls.push({ method, params });
      if (method === 'find') return screen().elements.find((e) => e.testId === params.testId) ?? null;
      return null;
    },
  };
  const device = {
    server,
    screen: async () => screen(),
    trace: async () => ({ last: 0, events: [{ seq: 1, t: 0, kind: 'request', method: 'GET', url: 'http://x/api/points', status: 200 }] }),
    press: async (params: unknown) => {
      calls.push({ method: 'press', params });
      shown = '25 points';
      return { x: 0, y: 0, mode: 'native' };
    },
    waitFor: async () => ({ waitedMs: 0 }),
    idle: async () => ({ settled: true }),
    command: async (name: string) => (name === 'events' ? [{ name: 'points_viewed', properties: { points: 25 } }] : {}),
  } as unknown as Device;
  const base: Base = {
    root,
    config: {},
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  return { base, calls };
};

const config = { refs: { user: 'user_id' }, inspect: 'inspect' };

test('a case prepares the backend, drives the app and reads both', async () => {
  const c = parseCase(
    `---
id: gift
---
setup:
  - create_user: { as: u, name: "Ana" }
steps:
  - app.see: { text: "Hello" }
  - give_points: { user: u, points: 25 }
  - app.press: "#refresh"
  - app.see: { text: "25 points", request: "GET /api/points", event: points_viewed, props: { points: 25 } }
  - app.see: { text: "Hello", absent: true }
  - assert: { user: u, path: points, equals: 25 }
  - assert: { path: name, equals: "Ana" }
`,
    'gift.md',
  );
  const { base, calls } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => [s.status, s.error]),
    Array(8).fill(['passed', undefined]),
  );
  assert.equal(calls.filter((x) => x.method === 'press').length, 1);
});

test('the first step that fails stops the case and leaves the evidence', async () => {
  const c = parseCase('---\nid: red\n---\nsteps:\n  - app.see: { text: "Goodbye", timeoutMs: 200 }\n  - app.press: "#refresh"\n', 'red.md');
  const { base, calls } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'failed');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['failed', 'skipped'],
  );
  assert.match(report.steps[0]!.error!, /not on screen: "Goodbye"/);
  assert.match(report.evidence!.screen!, /button #refresh/);
  assert.equal(calls.filter((x) => x.method === 'press').length, 0);
});

test('an optional press of something that is not there is skipped, not failed', async () => {
  const c = parseCase('---\nid: opt\n---\nsteps:\n  - app.press: { target: "#dismiss", optional: true }\n', 'opt.md');
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { waitFor: () => Promise<never> }).waitFor = async () => {
    throw new Error('Timed out');
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped'],
  );
});

test('a macro is the steps a project gave a name to, with what the case passed', async () => {
  const c = parseCase(
    '---\nid: m\n---\nsetup:\n  - create_user: { as: u }\nsteps:\n  - app.enter: { as: u, then: "#refresh" }\n  - app.enter: { as: u }\n',
    'm.md',
  );
  const { base, calls } = fakeApp();
  const macros = {
    'app.enter': [{ assert: { user_id: '{{param.as.user_id}}', path: 'user_id', matches: '^u_' } }, { when: 'then', do: { 'app.press': '{{param.then}}' } }],
  };
  const report = await runCase(c, { base, config: { ...config, macros }, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  assert.equal(calls.filter((x) => x.method === 'press').length, 1);
});

test("a step that is neither the app's nor a declared fixture says so", async () => {
  const c = parseCase('---\nid: f\n---\nsteps:\n  - teleport: { to: "moon" }\n', 'f.md');
  const { base } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.match(report.steps[0]!.error!, /no fixture teleport/);
});

test('a step becomes the argv of the command it names', () => {
  assert.deepEqual(argvFor(find('type')!, { text: 'ana', target: '#search', submit: true }), ['type', 'ana', '#search', '--submit']);
  assert.deepEqual(argvFor(find('wait')!, { target: '#row-25', scroll: true, timeoutMs: 9000 }), ['wait', '#row-25', '--scroll', '--timeout', '9000']);
  assert.deepEqual(argvFor(find('press')!, { target: '#like', within: 'hi from Ana' }), ['press', '#like', '--in', 'hi from Ana']);
  assert.deepEqual(argvFor(find('mock')!, { request: 'POST /pay', lost: true, times: 1 }), ['mock', 'POST /pay', '--lost', '--times', '1']);
  assert.deepEqual(argvFor(find('swipe')!, { from: '10,20', to: '10,300', durationMs: 300 }), [
    'swipe',
    '--from',
    '10,20',
    '--to',
    '10,300',
    '--duration',
    '300',
  ]);
  assert.deepEqual(argvFor(find('mock')!, 'clear'), ['mock', '--clear']);
  assert.throws(() => argvFor(find('press')!, { target: '#x', sideways: true }), /press has no sideways/);
});

test('what a buffer gained is found whichever end it grows from', () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  const c = { name: 'c' };
  assert.deepEqual(newSince([a], [a, b, c]), [b, c]);
  assert.deepEqual(newSince([a], [c, b, a]), [b, c]);
  assert.deepEqual(newSince([a, b], [a, b]), []);
  assert.deepEqual(newSince([a, b], [c]), [c]);
});

test('a run that asks for events keeps each with the step that caused it', async () => {
  const c = parseCase('---\nid: ev\n---\nsteps:\n  - app.see: { text: "Hello" }\n  - app.press: "#refresh"\n', 'ev.md');
  const { base } = fakeApp();
  const device = await base.device();
  let buffer: object[] = [];
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async () => buffer;
  const press = device.press.bind(device);
  (device as unknown as { press: typeof device.press }).press = async (p) => {
    buffer = [{ name: 'refreshed', properties: { by: 'button' } }, ...buffer];
    return press(p);
  };
  const report = await runCase(c, { base, config, fixtures, events: true });
  assert.deepEqual(report.events, [{ name: 'refreshed', props: { by: 'button' }, step: 2, route: 'Profile.Main' }]);
});

test('what the app puts in the way of a step is dealt with before it, unless the step is about it', async () => {
  const { base, calls } = fakeApp();
  const interruptions = [{ see: '#refresh', unless: 'refresh', do: [{ 'app.press': '#refresh' }] }];
  const c = parseCase('---\nid: t\n---\nsteps:\n  - app.see: { testId: refresh }\n  - app.see: { text: "25 points" }\n', 't.md');
  const report = await runCase(c, { base, config: { ...config, interruptions }, fixtures });
  assert.equal(report.result, 'passed');
  assert.equal(calls.filter((call) => call.method === 'press').length > 0, true);
});

test('a dry run names the step nobody answers and the argument a command does not take', async () => {
  const { base } = fakeApp();
  const c = parseCase('---\nid: t\n---\nsteps:\n  - app.teleport: somewhere\n  - app.clock: { sideways: 1 }\n  - app.clock: { advanceMs: 1000 }\n', 't.md');
  const report = await runCase(c, { base, config, fixtures, dry: true });
  assert.equal(report.result, 'failed');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['failed', 'failed', 'passed'],
  );
});

test('a step kept to a device is skipped on a host, and one kept to the host runs there', async () => {
  const { base, calls } = fakeApp();
  const c = parseCase(
    '---\nid: t\n---\nsteps:\n  - on: device\n    do:\n      - app.press: "#nowhere"\n  - on: headless\n    do: { app.press: "#refresh" }\n  - app.see: { text: "25 points" }\n',
    't.md',
  );
  assert.equal(c.steps[0]!.on, 'device');
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped', 'passed', 'passed'],
  );
  assert.equal(calls.filter((call) => call.method === 'press').length, 1);
});

test('a step the host cannot do stops the case without failing it', async () => {
  const c = parseCase(
    `---
id: stores
---
steps:
  - app.see: { text: "Hello" }
  - app.call: { command: stores }
  - app.see: { text: "25 points" }
`,
    'stores.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async (name) => {
    throw new Error(`Unknown method ${name}`);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'unsupported');
  assert.deepEqual(
    report.steps.map((s) => [s.status, s.error]),
    [
      ['passed', undefined],
      ['unsupported', 'this host has no stores'],
      ['skipped', undefined],
    ],
  );
  assert.equal(report.evidence, undefined);
});

test('the fixtures server says what it answers, and a case that names anything else is caught', async () => {
  const described = await fixtures.describe();
  assert.ok(described?.commands.includes('create_user'));
  const c = parseCase(
    `---
id: gift
---
setup:
  - create_user: { as: u }
  - grant_badge: { user: u }
steps:
  - app.see: { text: "Hello" }
  - assert: { user: u, path: points, equals: 0 }
`,
    'gift.md',
  );
  assert.deepEqual(missingFixtures(c, config, described?.commands ?? []), ['grant_badge']);
  assert.deepEqual(missingFixtures(c, { ...config, inspect: 'look' }, described?.commands ?? []), ['grant_badge', 'look']);
});

test('a fixtures server that does not describe itself is left unchecked', async () => {
  fs.writeFileSync(path.join(root, 'old.mjs'), FIXTURES.replace("command === 'lynkeus.describe'", 'false'));
  const old = new Fixtures({ command: 'node old.mjs' }, root);
  try {
    assert.equal(await old.describe(), undefined);
  } finally {
    old.close();
  }
});
