import assert from 'node:assert/strict';
import { test } from 'node:test';

import { simulatorArgv } from '../commands/device.js';
import { draftFlow } from '../commands/record.js';
import type { TraceEvent } from 'lynkeus-protocol';

const ev = (partial: Record<string, unknown>, seq: number): TraceEvent => ({ seq, t: seq * 100, ...partial }) as unknown as TraceEvent;

test('a recording becomes presses with what each one caused', () => {
  const flow = draftFlow([
    ev({ kind: 'route', route: 'First.Screen', path: ['First.Screen'] }, 1),
    ev({ kind: 'touch', x: 10, y: 20, testId: 'primary-button', route: 'First.Screen' }, 2),
    ev({ kind: 'request', method: 'GET', url: 'http://x/api/items', status: 200, ms: 40 }, 3),
    ev({ kind: 'route', route: 'Second.Screen', path: ['Second.Screen'] }, 4),
    ev({ kind: 'touch', x: 10, y: 20, text: 'Second option', route: 'Second.Screen' }, 5),
    ev({ kind: 'store', store: 'session', changed: { step: { from: 1, to: 2 } } }, 6),
    ev({ kind: 'touch', x: 5, y: 5, route: 'Second.Screen' }, 7),
  ]);
  assert.deepEqual(flow.steps, [
    { press: { testId: 'primary-button' } },
    { waitFor: { route: 'Second.Screen', timeoutMs: 10000 } },
    { note: 'requests: GET /api/items 200' },
    { press: { text: 'Second option' } },
    { note: 'stores changed: session.step' },
    { note: 'touch at 5,5 on Second.Screen hit nothing lynkeus could name' },
  ]);
});

test('device subcommands map to simctl and adb', () => {
  assert.deepEqual(simulatorArgv('ios', 'UDID', 'permissions', ['grant', 'camera'], 'com.example.myapp')[0], {
    bin: 'xcrun',
    args: ['simctl', 'privacy', 'UDID', 'grant', 'camera', 'com.example.myapp'],
  });
  assert.deepEqual(simulatorArgv('ios', 'UDID', 'appearance', ['dark'])[0]!.args, ['simctl', 'ui', 'UDID', 'appearance', 'dark']);
  assert.deepEqual(simulatorArgv('ios', 'UDID', 'location', ['-34.6,-58.4'])[0]!.args, ['simctl', 'location', 'UDID', 'set', '-34.6,-58.4']);
  assert.equal(simulatorArgv('ios', 'UDID', 'language', ['de-DE'], 'com.example.myapp').length, 2);
  assert.deepEqual(simulatorArgv('android', 'emu', 'permissions', ['grant', 'camera'], 'com.example.myapp')[0]!.args, [
    '-s',
    'emu',
    'shell',
    'pm',
    'grant',
    'com.example.myapp',
    'android.permission.CAMERA',
  ]);
  assert.throws(() => simulatorArgv('ios', 'UDID', 'permissions', ['grant', 'camera']), /--app/);
  assert.throws(() => simulatorArgv('ios', 'UDID', 'appearance', ['blue']), /light\|dark/);
});
