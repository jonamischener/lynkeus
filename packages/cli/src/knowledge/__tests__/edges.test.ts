import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as edges from '../edges.js';

test('a sighting is one appended line; reading merges them and compaction keeps one per edge', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-edges-')), 'edges.jsonl');
  const store = edges.open(file);
  assert.equal(store.record({ from: 'B.Main', to: 'C.Main', via: 'next' }), true);
  assert.equal(store.record({ from: 'A.Main', to: 'B.Main', via: 'open' }), true);
  assert.equal(store.record({ from: 'B.Main', to: 'C.Main', via: 'next' }), false);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(
    edges.load(file).map((e) => [e.from, e.seen]),
    [
      ['B.Main', 2],
      ['A.Main', 1],
    ],
  );

  store.compact();
  assert.deepEqual(
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).from),
    ['A.Main', 'B.Main'],
  );
  assert.equal(edges.prune(file, new Set(['A.Main', 'B.Main'])), 1);
});
