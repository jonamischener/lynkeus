import { edgeFrom, type ObservedEdge } from './edges.js';
import type { NavigationEdge, RouteName, ScreenGraph, Selector, SourcePath } from './types.js';

// Bounded: through barrels an unbounded closure reaches most of the app and makes every screen look the same.
const closureOf = (graph: ScreenGraph, entry: SourcePath, maxDepth = 2): Set<SourcePath> => {
  const seen = new Set<SourcePath>([entry]);
  let frontier: SourcePath[] = [entry];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: SourcePath[] = [];
    for (const file of frontier) {
      for (const imported of graph.files[file]?.imports ?? []) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        next.push(imported);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return seen;
};

export type Vocabulary = {
  route: RouteName;
  file: SourcePath | null;
  selectors: (Selector & { from: SourcePath })[];
  navigatesTo: (NavigationEdge & { from: SourcePath })[];
  filesConsidered: number;
};

/**
 * A weak guess at what a screen offers, from its file and what it imports
 * directly. One hop only: through barrels the whole component library is two
 * hops from every screen. The running app is the ground truth.
 */
export const vocabularyOf = (graph: ScreenGraph, route: RouteName, maxDepth = 1): Vocabulary | null => {
  const screen = graph.screens[route];
  if (!screen) return null;
  if (!screen.file) {
    return { route, file: null, selectors: [], navigatesTo: [], filesConsidered: 0 };
  }

  const closure = closureOf(graph, screen.file, maxDepth);
  const selectors: (Selector & { from: SourcePath })[] = [];
  const navigatesTo: (NavigationEdge & { from: SourcePath })[] = [];

  for (const file of closure) {
    const facts = graph.files[file];
    if (!facts) continue;
    for (const selector of facts.selectors) selectors.push({ ...selector, from: file });
    for (const edge of facts.navigates) navigatesTo.push({ ...edge, from: file });
  }

  return { route, file: screen.file, selectors, navigatesTo, filesConsidered: closure.size };
};

export type Approach = {
  via: string;
  source: 'static' | 'observed';
  /** The file that declares it, or the place it was walked from. */
  from: string;
  seen?: number;
};

/** The controls that lead to a route, the walked ones first: they beat an inference from source. */
export const pathsTo = (graph: ScreenGraph, destination: RouteName, observed: ObservedEdge[] = []): Approach[] => {
  const approaches: Approach[] = observed
    .filter((edge) => edge.to === destination)
    .map((edge) => ({
      via: edge.via,
      source: 'observed',
      from: edgeFrom(edge),
      seen: edge.seen,
    }));

  for (const [file, facts] of Object.entries(graph.files)) {
    for (const edge of facts.navigates) {
      if (edge.to !== destination || edge.confidence !== 'static') continue;
      if (edge.via.kind === 'unknown') continue;

      const via = edge.via.kind === 'testId' ? edge.via.testId : `<runtime: ${edge.via.expression}>`;
      if (approaches.some((a) => a.via === via)) continue;
      approaches.push({ via, source: 'static', from: file });
    }
  }

  return approaches;
};

export type Affected = { route: RouteName; distance: number; via: SourcePath; through: SourcePath[] };

/** Screens a change can reach, nearest first; `distance` is how many imports separate the screen's file from a changed one. */
export const screensAffectedBy = (graph: ScreenGraph, changedFiles: SourcePath[], maxDepth = 4): Affected[] => {
  const importedBy = new Map<SourcePath, SourcePath[]>();
  for (const [file, facts] of Object.entries(graph.files)) {
    for (const target of facts.imports) {
      const list = importedBy.get(target);
      if (list) list.push(file);
      else importedBy.set(target, [file]);
    }
  }

  const throughBarrel = new Map<SourcePath, SourcePath[]>();
  for (const [file, facts] of Object.entries(graph.files)) {
    for (const barrel of facts.barrels ?? []) {
      const list = throughBarrel.get(barrel);
      if (list) list.push(file);
      else throughBarrel.set(barrel, [file]);
    }
  }

  type Hop = { distance: number; via: SourcePath; through: SourcePath[] };
  const reached = new Map<SourcePath, Hop>();
  let frontier: SourcePath[] = [];
  for (const f of changedFiles) {
    if (!reached.has(f)) {
      reached.set(f, { distance: 0, via: f, through: [] });
      frontier.push(f);
    }
  }
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: SourcePath[] = [];
    for (const file of frontier) {
      const hop = reached.get(file)!;
      // Taking a name through a barrel depends on the barrel only when the barrel itself changed.
      const dependents = hop.distance === 0 ? [...(importedBy.get(file) ?? []), ...(throughBarrel.get(file) ?? [])] : (importedBy.get(file) ?? []);
      for (const dependent of dependents) {
        if (reached.has(dependent)) continue;
        reached.set(dependent, { distance: depth, via: hop.via, through: [...hop.through, file] });
        next.push(dependent);
      }
    }
    frontier = next;
  }

  const affected: Affected[] = [];
  for (const screen of Object.values(graph.screens)) {
    if (!screen.file) continue;
    const hop = reached.get(screen.file);
    if (!hop) continue;
    affected.push({ route: screen.route, distance: hop.distance, via: hop.via, through: hop.through.slice(1) });
  }
  return affected.sort((a, b) => a.distance - b.distance || a.route.localeCompare(b.route));
};
