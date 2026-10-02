import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import { stamp } from '../files.js';

export type Comparison = {
  width: number;
  height: number;
  total: number;
  different: number;
  ratio: number;
  sizeMismatch?: { a: [number, number]; b: [number, number] };
  /** The baseline faded to grey with the differing pixels in red, when there are any. */
  diff?: Buffer;
};

export const comparePng = (a: Buffer, b: Buffer, channelThreshold = 24): Comparison => {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) {
    return {
      width: pa.width,
      height: pa.height,
      total: pa.width * pa.height,
      different: pa.width * pa.height,
      ratio: 1,
      sizeMismatch: { a: [pa.width, pa.height], b: [pb.width, pb.height] },
    };
  }
  const out = new PNG({ width: pa.width, height: pa.height });
  let different = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i]! - pb.data[i]!), Math.abs(pa.data[i + 1]! - pb.data[i + 1]!), Math.abs(pa.data[i + 2]! - pb.data[i + 2]!));
    if (d > channelThreshold) {
      different += 1;
      out.data[i] = 255;
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      out.data[i + 3] = 255;
    } else {
      out.data[i] = 128 + (pa.data[i]! >> 1);
      out.data[i + 1] = 128 + (pa.data[i + 1]! >> 1);
      out.data[i + 2] = 128 + (pa.data[i + 2]! >> 1);
      out.data[i + 3] = 255;
    }
  }
  const total = pa.width * pa.height;
  return { width: pa.width, height: pa.height, total, different, ratio: different / total, diff: different ? PNG.sync.write(out) : undefined };
};

export const baselinePath = (lynkeusDir: string, name: string): string => path.join(lynkeusDir, 'snapshots', `${name.replace(/[^\w.-]+/g, '-')}.png`);

export type SnapshotResult = { status: 'baseline' | 'match' | 'mismatch'; baseline: string; comparison?: Comparison; diffFile?: string };

export const snapshot = (
  lynkeusDir: string,
  name: string,
  capture: Buffer,
  options: { update?: boolean; tolerance?: number; runsDir: string },
): SnapshotResult => {
  const baseline = baselinePath(lynkeusDir, name);
  if (options.update || !fs.existsSync(baseline)) {
    fs.mkdirSync(path.dirname(baseline), { recursive: true });
    fs.writeFileSync(baseline, capture);
    return { status: 'baseline', baseline };
  }
  const comparison = comparePng(fs.readFileSync(baseline), capture);
  const tolerance = options.tolerance ?? 0.001;
  if (comparison.ratio <= tolerance) return { status: 'match', baseline, comparison };
  const dir = path.join(options.runsDir, 'snapshots', stamp());
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(baseline, '.png');
  fs.writeFileSync(path.join(dir, `${stem}.actual.png`), capture);
  const diffFile = path.join(dir, `${stem}.diff.png`);
  if (comparison.diff) fs.writeFileSync(diffFile, comparison.diff);
  return { status: 'mismatch', baseline, comparison, diffFile };
};

export const describeSnapshot = (name: string, r: SnapshotResult): string => {
  if (r.status === 'baseline') return `${name}: baseline written → ${r.baseline}`;
  const c = r.comparison!;
  if (r.status === 'match') return `${name}: matches the baseline (${c.different} of ${c.total} pixels differ, ${(c.ratio * 100).toFixed(3)}%)`;
  if (c.sizeMismatch)
    return `${name}: size changed ${c.sizeMismatch.a.join('×')} → ${c.sizeMismatch.b.join('×')} (a different device or orientation?); actual next to ${r.diffFile}`;
  return `${name}: differs from the baseline: ${c.different} of ${c.total} pixels (${(c.ratio * 100).toFixed(2)}%)\n  diff: ${r.diffFile}\n  accept with --update if the change is intended`;
};
