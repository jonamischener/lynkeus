import type { FlowReport } from '../flow/types.js';

export type FlakeSummary = {
  runs: number;
  passed: number;
  msMedian: number;
  failures: { step: number; what: string; error: string; times: number }[];
};

const stepLabel = (r: FlowReport, i: number): string => {
  const s = r.steps[i]?.step;
  if (!s) return '?';
  const [key] = Object.keys(s);
  const v = (s as Record<string, unknown>)[key!];
  return `${key}${typeof v === 'object' && v ? ` ${JSON.stringify(v).slice(0, 60)}` : ''}`;
};

export const summarizeRuns = (reports: FlowReport[]): FlakeSummary => {
  const failures = new Map<string, FlakeSummary['failures'][number]>();
  for (const r of reports) {
    if (r.ok) continue;
    const i = r.steps.findIndex((s) => !s.ok);
    const error = (r.steps[i]?.error ?? 'unknown')
      .replace(/\(on [^)]*\)/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const key = `${i}|${error}`;
    const f = failures.get(key) ?? { step: i + 1, what: stepLabel(r, i), error, times: 0 };
    f.times += 1;
    failures.set(key, f);
  }
  const ms = reports.map((r) => r.totalMs).sort((a, b) => a - b);
  return {
    runs: reports.length,
    passed: reports.filter((r) => r.ok).length,
    msMedian: ms[Math.floor(ms.length / 2)] ?? 0,
    failures: [...failures.values()].sort((a, b) => b.times - a.times),
  };
};

export const describeFlake = (name: string, s: FlakeSummary): string => {
  const lines = [`${name}: passed ${s.passed}/${s.runs} (median ${Math.round(s.msMedian / 1000)}s)`];
  if (s.passed === s.runs) lines.push('  no failure in this sample; if it fails elsewhere, the difference is the environment (load, data, a parallel runner)');
  for (const f of s.failures) lines.push(`  ${f.times}× at step ${f.step} (${f.what}): ${f.error}`);
  if (s.failures.length > 1) lines.push('  more than one failure shape: not one flake but several, or a screen that fails in different ways when slow');
  return lines.join('\n');
};
