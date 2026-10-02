import type { Finding } from '../knowledge/lint.js';
import type { ScreenGraph } from '../knowledge/types.js';

export type GraphDiff = {
  routesAdded: string[];
  routesRemoved: string[];
  edgesAdded: { from: string; to: string }[];
  edgesRemoved: { from: string; to: string }[];
  selectorsAdded: { file: string; id: string }[];
  selectorsRemoved: { file: string; id: string }[];
};

const edgesOf = (g: ScreenGraph): Set<string> => {
  const fileRoute = new Map<string, string>();
  for (const s of Object.values(g.screens)) if (s.file) fileRoute.set(s.file, s.route);
  const out = new Set<string>();
  for (const [file, facts] of Object.entries(g.files)) {
    const from = fileRoute.get(file) ?? file;
    for (const n of facts.navigates) if (n.confidence === 'static') out.add(`${from} ${n.to}`);
  }
  return out;
};

const selectorsOf = (g: ScreenGraph): Set<string> => {
  const out = new Set<string>();
  for (const [file, facts] of Object.entries(g.files)) for (const s of facts.selectors) out.add(`${file} ${s.id}`);
  return out;
};

const minus = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort();
const pair = (s: string) => {
  const [from, to] = s.split(' ');
  return { from: from!, to: to! };
};
const selector = (s: string) => {
  const { from, to } = pair(s);
  return { file: from, id: to };
};

export const diffGraphs = (base: ScreenGraph, head: ScreenGraph): GraphDiff => {
  const br = new Set(Object.keys(base.screens));
  const hr = new Set(Object.keys(head.screens));
  const be = edgesOf(base);
  const he = edgesOf(head);
  const bs = selectorsOf(base);
  const hs = selectorsOf(head);
  return {
    routesAdded: minus(hr, br),
    routesRemoved: minus(br, hr),
    edgesAdded: minus(he, be).map(pair),
    edgesRemoved: minus(be, he).map(pair),
    selectorsAdded: minus(hs, bs).map(selector),
    selectorsRemoved: minus(bs, hs).map(selector),
  };
};

/** Lint findings per route, as `lynkeus lint --save` writes them. */
export type LintBaseline = Record<string, { rule: string; testId?: string; message: string }[]>;

type LintedFinding = { finding: Finding; testId?: string };

const key = (rule: string, testId: string | undefined, message: string) => `${rule}|${testId ?? ''}|${message}`;

export const newFindings = (baseline: LintBaseline, route: string, findings: LintedFinding[]): LintedFinding[] => {
  const seen = new Set((baseline[route] ?? []).map((b) => key(b.rule, b.testId, b.message)));
  return findings.filter((f) => !seen.has(key(f.finding.rule, f.testId, f.finding.message)));
};

export const describeGraphDiff = (d: GraphDiff): string => {
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(`  ${title}`, ...items.map((i) => `    ${i}`));
  };
  list('routes added', d.routesAdded);
  list('routes removed', d.routesRemoved);
  const edge = (e: { from: string; to: string }) => `${e.from} → ${e.to}`;
  const selector = (s: { file: string; id: string }) => `#${s.id}  (${s.file})`;
  list('navigations added', d.edgesAdded.map(edge));
  list('navigations removed', d.edgesRemoved.map(edge));
  list('testIDs added', d.selectorsAdded.map(selector));
  list('testIDs removed', d.selectorsRemoved.map(selector));
  return lines.length ? lines.join('\n') : '  (the screen graph did not change)';
};
