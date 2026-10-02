import type { TraceEvent } from 'lynkeus-protocol';

import type { Flow, FlowStep } from '../flow/types.js';

import { pathOf } from '../knowledge/problems.js';

/** One press per touch and, after each, what it caused: the route it led to, the requests and the stores it changed. */
export const draftFlow = (events: TraceEvent[], name = 'recorded'): Flow => {
  const steps: FlowStep[] = [];
  let lastRoute: string | undefined;
  let pending: { requests: string[]; stores: string[]; route?: string } | null = null;
  const flush = () => {
    if (!pending) return;
    if (pending.route) steps.push({ waitFor: { route: pending.route, timeoutMs: 10000 } });
    if (pending.requests.length) steps.push({ note: `requests: ${[...new Set(pending.requests)].join(', ')}` });
    if (pending.stores.length) steps.push({ note: `stores changed: ${[...new Set(pending.stores)].join(', ')}` });
    pending = null;
  };
  for (const e of events) {
    if (e.kind === 'touch') {
      flush();
      if (e.testId) steps.push({ press: { testId: e.testId } });
      else if (e.text) steps.push({ press: { text: e.text } });
      else steps.push({ note: `touch at ${e.x},${e.y} on ${e.route ?? '?'} hit nothing lynkeus could name` });
      pending = { requests: [], stores: [] };
      lastRoute = e.route ?? lastRoute;
    } else if (e.kind === 'route') {
      if (pending && e.route && e.route !== lastRoute) pending.route = e.route;
      lastRoute = e.route ?? lastRoute;
    } else if (e.kind === 'request' && pending) {
      pending.requests.push(`${e.method} ${pathOf(e.url)}${e.status ? ` ${e.status}` : ''}`);
    } else if (e.kind === 'store' && pending) {
      pending.stores.push(`${e.store}.${Object.keys(e.changed).join(',')}`);
    }
  }
  flush();
  return { name, steps };
};

export const describeEvent = (e: TraceEvent): string | undefined => {
  if (e.kind === 'touch') return `touch  ${e.testId ? `#${e.testId}` : e.text ? JSON.stringify(e.text) : `${e.x},${e.y}`}  on ${e.route ?? '?'}`;
  if (e.kind === 'route') return `route  ${e.route ?? '?'}`;
  if (e.kind === 'request') return `req    ${e.status ?? '…'} ${e.method} ${pathOf(e.url)}${e.ms ? ` ${e.ms}ms` : ''}`;
  if (e.kind === 'store') return `store  ${e.store}: ${Object.keys(e.changed).join(', ')}`;
  return undefined;
};
