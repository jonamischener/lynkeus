import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarize, visitsFrom } from '../perf.js';
import type { TraceEvent } from 'lynkeus-protocol';

const ev = (partial: Record<string, unknown>, seq: number): TraceEvent => ({ seq, ...partial }) as unknown as TraceEvent;
const trace: TraceEvent[] = [
  ev({ kind: 'route', route: 'First.Main', path: ['First.Main'], t: 1000 }, 1),
  ev({ kind: 'request', method: 'GET', url: 'http://x/api/a', status: 200, ms: 120, t: 1130 }, 2),
  ev({ kind: 'request', method: 'GET', url: 'http://x/api/b?limit=100', status: 500, ms: 900, t: 1920 }, 3),
  // Polling long after arrival is not part of what the screen cost to open.
  ev({ kind: 'request', method: 'GET', url: 'http://x/api/a', status: 200, ms: 50, t: 4000 }, 8),
  ev({ kind: 'stall', renders: 50, windowMs: 100, t: 1500 }, 4),
  ev({ kind: 'route', route: 'Second.Main', path: ['Second.Main'], t: 5000 }, 5),
  ev({ kind: 'request', method: 'GET', url: 'http://x/api/c', status: 200, ms: 40, t: 5045 }, 6),
  ev({ kind: 'command', method: 'press', ms: 5, t: 5100 }, 7),
];

test('a visit counts its requests, errors, stalls and when it went quiet', () => {
  const [home, pay] = visitsFrom(trace);
  assert.equal(home!.route, 'First.Main');
  assert.equal(home!.requests, 3);
  assert.equal(home!.errors, 1);
  assert.equal(home!.stalls, 1);
  assert.equal(home!.quietAfterMs, 920); // the 900 ms request ended at +920; the poll at +3950 came after a quiet gap
  assert.deepEqual(home!.slowest, { method: 'GET', path: '/api/b?limit=100', ms: 900 });
  assert.equal(home!.ms, 4000);
  assert.equal(pay!.requests, 1);
});
test('the summary averages per route and puts the slowest screen first', () => {
  const s = summarize(visitsFrom(trace));
  assert.deepEqual(
    s.map((r) => r.route),
    ['First.Main', 'Second.Main'],
  );
  assert.equal(s[0]!.quietAfterMs, 920);
});
test('events before any route are ignored', () => {
  assert.deepEqual(visitsFrom([ev({ kind: 'request', method: 'GET', url: 'http://x/a', ms: 1, t: 1 }, 1)]), []);
});
