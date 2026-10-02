import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';

import { comparePng, snapshot } from '../commands/snapshot.js';

const png = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint(x, y);
      p.data[i] = r;
      p.data[i + 1] = g;
      p.data[i + 2] = b;
      p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
};

test('pixels that moved are counted and painted into a diff', () => {
  const a = png(10, 10, () => [255, 255, 255]);
  const b = png(10, 10, (x, y) => (x < 2 && y < 2 ? [0, 0, 0] : [250, 250, 250]));
  const c = comparePng(a, b);
  assert.equal(c.different, 4); // the 250 vs 255 shade stays under the channel threshold
  assert.equal(c.ratio, 0.04);
  assert.ok(c.diff);
  const d = PNG.sync.read(c.diff!);
  assert.deepEqual([d.data[0], d.data[1], d.data[2]], [255, 0, 0]);
});

test('a first capture is the baseline; a small change matches; a big one writes a diff', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-snap-'));
  const lynkeusDir = path.join(root, '.lynkeus');
  const runsDir = path.join(lynkeusDir, 'runs');
  const white = png(20, 20, () => [255, 255, 255]);
  assert.equal(snapshot(lynkeusDir, 'card', white, { runsDir }).status, 'baseline');
  const nearly = png(20, 20, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255]));
  assert.equal(snapshot(lynkeusDir, 'card', nearly, { runsDir, tolerance: 0.01 }).status, 'match');
  const half = png(20, 20, (x) => (x < 10 ? [0, 0, 0] : [255, 255, 255]));
  const r = snapshot(lynkeusDir, 'card', half, { runsDir });
  assert.equal(r.status, 'mismatch');
  assert.ok(fs.existsSync(r.diffFile!));
  assert.equal(snapshot(lynkeusDir, 'card', half, { runsDir, update: true }).status, 'baseline');
  assert.equal(snapshot(lynkeusDir, 'card', half, { runsDir }).status, 'match');
  const other = png(30, 20, () => [255, 255, 255]);
  assert.ok(snapshot(lynkeusDir, 'card', other, { runsDir }).comparison?.sizeMismatch);
});
