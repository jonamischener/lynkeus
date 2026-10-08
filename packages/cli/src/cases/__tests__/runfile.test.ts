import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { RUN_SCHEMA, type RunCase, type RunManifest } from 'lynkeus-protocol';

import { parseCase } from '../format.js';
import { RunFile, toRunCase } from '../runfile.js';
import type { CaseReport } from '../runner.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-run-'));
const c = parseCase(
  [
    '---',
    'id: pay',
    'title: Paying a friend',
    'description: The money leaves one wallet and reaches the other.',
    '---',
    'setup:',
    '  - create_user: { as: a }',
    'steps:',
    '  - app.press: "#send"',
    '  - app.see: Sent',
    '',
  ].join('\n'),
  path.join(root, 'cases', 'pay.md'),
);
const report = (result: CaseReport['result']): CaseReport => ({
  id: 'pay',
  title: 'Paying a friend',
  file: path.join(root, 'cases', 'pay.md'),
  result,
  ms: 1200,
  steps: [
    { step: 'create_user as: a', status: 'passed', ms: 300 },
    { step: 'app.press #send', status: 'passed', ms: 40 },
    result === 'passed'
      ? { step: 'app.see Sent', status: 'passed', ms: 5 }
      : { step: 'app.see Sent', status: 'failed', ms: 3000, error: 'not on screen: Sent' },
  ],
  events: [{ name: 'Tap - Send', props: { amount: 10 }, step: 2, route: 'Pay.Main' }],
  ...(result === 'failed' ? { evidence: { why: 'the transfer was refused' } } : {}),
});
const lines = (dir: string) =>
  fs
    .readFileSync(path.join(dir, 'cases.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunCase);

test('a case becomes a line that says where each step and event belongs', () => {
  const line = toRunCase(c, { report: report('passed'), attempt: 1, startedAt: new Date('2026-01-02T03:04:05Z') }, root);
  assert.equal(line.file, path.join('cases', 'pay.md'));
  assert.equal(line.description, 'The money leaves one wallet and reaches the other.');
  assert.equal(line.startedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(
    line.steps.map((s) => s.section),
    ['setup', 'steps', 'steps'],
  );
  assert.deepEqual(line.steps[1]?.events, [{ origin: 'app', name: 'Tap - Send', props: { amount: 10 }, route: 'Pay.Main' }]);
  assert.equal(line.steps[0]?.events, undefined);
});

test('a run keeps every attempt and counts a case by its last one', () => {
  const dir = path.join(root, 'run');
  const run = new RunFile(dir, root, new Date('2026-01-02T03:00:00Z'));
  const started = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as RunManifest;
  assert.deepEqual(started, { schema: RUN_SCHEMA, startedAt: '2026-01-02T03:00:00.000Z' });

  run.add(c, { report: report('failed'), attempt: 1, startedAt: new Date() });
  run.add(c, { report: report('passed'), attempt: 2, startedAt: new Date() });
  run.finish({ platform: 'ios', native: false }, new Date('2026-01-02T03:01:00Z'));

  assert.deepEqual(
    lines(dir).map((l) => [l.attempt, l.result, l.evidence?.why]),
    [
      [1, 'failed', 'the transfer was refused'],
      [2, 'passed', undefined],
    ],
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as RunManifest;
  assert.equal(manifest.finishedAt, '2026-01-02T03:01:00.000Z');
  assert.equal(manifest.platform, 'ios');
  assert.equal(manifest.native, false);
  assert.deepEqual(manifest.totals, { cases: 1, passed: 1, failed: 0, unsupported: 0, retried: 1 });
});
