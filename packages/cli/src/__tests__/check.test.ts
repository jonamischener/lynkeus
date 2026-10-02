import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffGraphs, newFindings } from '../commands/check.js';
import { mapCheckWorkflow } from '../commands/map.js';
import { summarizeRuns } from '../commands/flake.js';
import type { FlowReport } from '../flow/types.js';
import type { ScreenGraph } from '../knowledge/types.js';

const graph = (screens: Record<string, string | null>, files: Record<string, { selectors?: string[]; navigates?: string[] }>): ScreenGraph =>
  ({
    app: 'x',
    root: '/x',
    extractedAt: '',
    warnings: [],
    screens: Object.fromEntries(Object.entries(screens).map(([route, file]) => [route, { route, component: route, file, declaredIn: 'nav.tsx' }])),
    files: Object.fromEntries(
      Object.entries(files).map(([file, f]) => [
        file,
        {
          selectors: (f.selectors ?? []).map((id) => ({ id, line: 1 })),
          navigates: (f.navigates ?? []).map((to) => ({ to, line: 1, confidence: 'static', via: { kind: 'unknown' } })),
          imports: [],
        },
      ]),
    ),
  }) as unknown as ScreenGraph;

test('a graph diff names routes, navigations and testIDs that changed', () => {
  const base = graph({ A: 'a.tsx', B: 'b.tsx' }, { 'a.tsx': { selectors: ['go-b'], navigates: ['B'] }, 'b.tsx': { selectors: ['submit'] } });
  const head = graph({ A: 'a.tsx', B: 'b.tsx', C: 'c.tsx' }, { 'a.tsx': { selectors: ['go-b', 'go-c'], navigates: ['B', 'C'] }, 'b.tsx': {}, 'c.tsx': {} });
  const d = diffGraphs(base, head);
  assert.deepEqual(d.routesAdded, ['C']);
  assert.deepEqual(d.edgesAdded, [{ from: 'A', to: 'C' }]);
  assert.deepEqual(d.selectorsAdded, [{ file: 'a.tsx', id: 'go-c' }]);
  assert.deepEqual(d.selectorsRemoved, [{ file: 'b.tsx', id: 'submit' }]);
});

test('lint findings already in the baseline are not new', () => {
  const f1 = { finding: { rule: 'unlabeled-control', severity: 'warn' as const, element: 3, message: 'button without a label' }, testId: 'x' };
  const f2 = { finding: { rule: 'small-target', severity: 'warn' as const, element: 4, message: '20×20' }, testId: 'y' };
  const fresh = newFindings({ A: [{ rule: 'unlabeled-control', testId: 'x', message: 'button without a label' }] }, 'A', [f1, f2]);
  assert.deepEqual(fresh, [f2]);
});

test('flake runs are summarised by the step and error they died on', () => {
  const ok = (ms: number): FlowReport => ({ name: 'f', ok: true, totalMs: ms, vars: {}, steps: [{ step: { press: { testId: 'a' } }, ok: true, ms: 1 }] });
  const bad = (err: string): FlowReport => ({
    name: 'f',
    ok: false,
    totalMs: 900,
    vars: {},
    steps: [
      { step: { press: { testId: 'a' } }, ok: true, ms: 1 },
      { step: { waitFor: { route: 'A' } }, ok: false, ms: 1, error: err },
    ],
  });
  const s = summarizeRuns([ok(100), bad('Timed out waiting for A (on Z)'), ok(300), bad('Timed out waiting for A (on Y)')]);
  assert.equal(s.passed, 2);
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0]!.times, 2);
  assert.equal(s.failures[0]!.step, 2);
  assert.match(s.failures[0]!.what, /waitFor/);
});

test('the map check workflow diffs against the pull request base and keeps one comment', () => {
  const yml = mapCheckWorkflow(2);
  assert.match(yml, /lynkeus map check --base origin\/\$\{\{ github\.base_ref \}\} --depth 2/);
  assert.match(yml, /--edit-last/);
  assert.match(yml, /pull-requests: write/);
});
