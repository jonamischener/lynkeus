/**
 * Directions: the shortest known way from one place to another, as the
 * controls to press. A place is a route, or a layer open over one
 * (`Settings.Main#account-button`), named after the control that opened it
 * because pressing that control is the only way back in. Observed edges are
 * tried before static ones.
 */
import { edgeFrom, edgeTo, type ObservedEdge, splitNode } from './edges.js';
import { vocabularyOf } from './query.js';
import type { ScreenGraph } from './types.js';

export type PlanStep = {
  from: string;
  to: string;
  /** The testID to press; without one, a hint for whoever looks at the screen. */
  press?: string;
  hint?: string;
  /** The step leaves a sheet or dialog open rather than changing route. */
  opens?: string;
  source: 'observed' | 'static';
};

type Move = { to: string; press?: string; hint?: string; opens?: string; source: 'observed' | 'static' };

const movesFrom = (graph: ScreenGraph, node: string, observed: ObservedEdge[]): Move[] => {
  const moves: Move[] = observed.map((e) => ({
    to: edgeTo(e),
    press: e.via.startsWith('text:') ? undefined : e.via,
    hint: e.via.startsWith('text:') ? e.via : undefined,
    opens: e.toLayer !== e.fromLayer ? e.toLayer : undefined,
    source: 'observed',
  }));
  // Source knows routes, not what a route has open: a static edge only applies where nothing covers the screen.
  const { route, layer } = splitNode(node);
  if (layer !== undefined) return moves;
  const vocabulary = vocabularyOf(graph, route, 1);
  for (const edge of vocabulary?.navigatesTo ?? []) {
    if (edge.confidence !== 'static' || !graph.screens[edge.to]) continue;
    if (moves.some((m) => m.to === edge.to)) continue;
    moves.push({
      to: edge.to,
      press: edge.via.kind === 'testId' ? edge.via.testId : undefined,
      hint:
        edge.via.kind === 'dynamicTestId'
          ? `testId built at runtime: ${edge.via.expression}`
          : edge.via.kind === 'unknown'
            ? `navigated from ${edge.from}:${edge.line} without a visible trigger`
            : undefined,
      source: 'static',
    });
  }
  return moves;
};

/** Breadth-first over places. A bare route as the destination accepts arriving with something open over it. */
export const plan = (graph: ScreenGraph, from: string, to: string, observed: ObservedEdge[] = [], maxDepth = 6): PlanStep[] | null => {
  const byNode = new Map<string, ObservedEdge[]>();
  for (const e of observed) {
    const list = byNode.get(edgeFrom(e));
    if (list) list.push(e);
    else byNode.set(edgeFrom(e), [e]);
  }
  const arrived = (node: string) => node === to || splitNode(node).route === to;
  if (arrived(from)) return [];
  const previous = new Map<string, PlanStep>();
  const queue: string[] = [from];
  const depth = new Map<string, number>([[from, 0]]);
  while (queue.length) {
    const node = queue.shift()!;
    const d = depth.get(node) ?? 0;
    if (d >= maxDepth) continue;
    for (const move of movesFrom(graph, node, byNode.get(node) ?? [])) {
      if (previous.has(move.to) || move.to === from) continue;
      previous.set(move.to, { from: node, to: move.to, press: move.press, hint: move.hint, opens: move.opens, source: move.source });
      depth.set(move.to, d + 1);
      if (arrived(move.to)) {
        const steps: PlanStep[] = [];
        for (let at: string | undefined = move.to; at && at !== from; at = previous.get(at)?.from) {
          steps.unshift(previous.get(at)!);
        }
        return steps;
      }
      queue.push(move.to);
    }
  }
  return null;
};

export const describePlan = (steps: PlanStep[]): string =>
  steps
    .map(
      (s, i) =>
        `${i + 1}. ${s.from} → ${s.to}   ${s.press ? `press #${s.press}` : `(${s.hint ?? 'look at the screen'})`}${s.opens ? '  (opens a layer)' : ''}   [${s.source}]`,
    )
    .join('\n');
