import assert from 'node:assert/strict';
import { test } from 'node:test';

import { screensAffectedBy } from '../query.js';
import type { ScreenGraph } from '../types.js';

const graph = {
  app: 'test',
  root: 'Root',
  extractedAt: '',
  warnings: [],
  screens: {
    'A.Main': { route: 'A.Main', component: 'A', file: 'app/a.tsx', declaredIn: 'nav.tsx' },
    'B.Main': { route: 'B.Main', component: 'B', file: 'app/b.tsx', declaredIn: 'nav.tsx' },
  },
  files: {
    'app/a.tsx': { imports: ['app/shared.tsx'] },
    'app/b.tsx': { imports: [] },
    'app/shared.tsx': { imports: [] },
  },
} as unknown as ScreenGraph;

test('a changed screen file is affected at distance 0', () => {
  const r = screensAffectedBy(graph, ['app/a.tsx']);
  assert.deepEqual(
    r.map((x) => [x.route, x.distance]),
    [['A.Main', 0]],
  );
});
test('a shared file reaches its importer at distance 1, naming the changed file', () => {
  const r = screensAffectedBy(graph, ['app/shared.tsx']);
  assert.deepEqual(
    r.map((x) => [x.route, x.distance, x.via]),
    [['A.Main', 1, 'app/shared.tsx']],
  );
});
test('results are nearest first', () => {
  const g = {
    ...graph,
    screens: { ...graph.screens, 'C.Main': { route: 'C.Main', component: 'C', file: 'app/c.tsx', declaredIn: 'nav.tsx' } },
    files: { ...graph.files, 'app/c.tsx': { imports: ['app/a.tsx'] } },
  } as unknown as ScreenGraph;
  const r = screensAffectedBy(g, ['app/shared.tsx']);
  assert.deepEqual(
    r.map((x) => [x.route, x.distance]),
    [
      ['A.Main', 1],
      ['C.Main', 2],
    ],
  );
});
test('an unrelated change affects nothing', () => {
  assert.deepEqual(screensAffectedBy(graph, ['app/unrelated.tsx']), []);
});
test('a barrel reaches who imports through it only when the barrel itself changed', () => {
  const g = {
    ...graph,
    files: {
      'app/a.tsx': { imports: ['app/hooks/useThing.ts'], barrels: ['app/hooks/index.ts'] },
      'app/b.tsx': { imports: ['app/hooks/useOther.ts'], barrels: ['app/hooks/index.ts'] },
      'app/hooks/index.ts': { imports: ['app/hooks/useThing.ts', 'app/hooks/useOther.ts'] },
      'app/hooks/useThing.ts': { imports: [] },
      'app/hooks/useOther.ts': { imports: [] },
    },
  } as unknown as ScreenGraph;
  assert.deepEqual(
    screensAffectedBy(g, ['app/hooks/useThing.ts']).map((x) => x.route),
    ['A.Main'],
  );
  assert.deepEqual(
    screensAffectedBy(g, ['app/hooks/index.ts']).map((x) => x.route),
    ['A.Main', 'B.Main'],
  );
});
