import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Flakes } from '../flakes.js';
import type { CaseReport } from '../runner.js';

const report = (result: CaseReport['result'], retried = false): CaseReport & { retried?: boolean } => ({
  id: 'pay',
  file: 'pay.md',
  result,
  ms: 10,
  steps: result === 'failed' ? [{ step: 'app.see Sent', status: 'failed', ms: 3000, error: 'not on screen: Sent\nmore' }] : [],
  retried,
});

test('the ledger keeps each run and calls a case flaky when its runs disagree', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json');
  const first = new Flakes(file);
  first.note(report('passed'));
  first.note(report('passed'));
  assert.deepEqual(first.flaky(['pay']), []);
  first.save();

  const second = new Flakes(file);
  second.note(report('passed', true));
  second.note(report('failed'));
  assert.deepEqual(second.flaky(['pay']), ['⚠ pay is flaky: 2 of its last 4 runs failed or needed a second chance']);
  second.save();

  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.pay.runs, 4);
  assert.equal(kept.pay.failed, 1);
  assert.equal(kept.pay.retried, 1);
  assert.equal(kept.pay.last.at(-1).error, 'not on screen: Sent');
});
