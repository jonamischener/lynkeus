import type { TraceEvent } from 'lynkeus-protocol';

export type Visit = {
  route: string;
  at: number;
  /** How long the screen stayed on top. */
  ms: number;
  requests: number;
  requestMs: number;
  errors: number;
  slowest?: { method: string; path: string; ms: number };
  /** From arriving to the end of the opening burst of requests. */
  quietAfterMs: number;
  stalls: number;
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

// This long with no request ends the opening burst: later polling does not count against arriving.
const QUIET_GAP_MS = 1500;

export const visitsFrom = (events: TraceEvent[]): Visit[] => {
  const visits: Visit[] = [];
  let current: Visit | null = null;
  let burstEnd = 0;
  let burstOver = false;
  const close = (endT: number) => {
    if (current) current.ms = Math.max(0, endT - current.at);
  };
  for (const e of events) {
    if (e.kind === 'route') {
      close(e.t);
      current = { route: e.route ?? e.path.join('/') ?? '?', at: e.t, ms: 0, requests: 0, requestMs: 0, errors: 0, quietAfterMs: 0, stalls: 0 };
      visits.push(current);
      burstEnd = e.t;
      burstOver = false;
      continue;
    }
    if (!current) continue;
    if (e.kind === 'request') {
      current.requests += 1;
      const ms = e.ms ?? 0;
      current.requestMs += ms;
      if ((e.status ?? 0) >= 400 || e.error) current.errors += 1;
      if (!current.slowest || ms > current.slowest.ms) current.slowest = { method: e.method, path: pathOf(e.url), ms };
      // A request event is stamped when it ends.
      const start = e.t - ms;
      if (!burstOver && start - burstEnd > QUIET_GAP_MS) burstOver = true;
      if (!burstOver) {
        burstEnd = Math.max(burstEnd, e.t);
        current.quietAfterMs = Math.max(current.quietAfterMs, burstEnd - current.at);
      }
    } else if (e.kind === 'stall') {
      current.stalls += 1;
    }
  }
  const last = events[events.length - 1];
  if (last) close(last.t);
  return visits;
};

export type RouteSummary = {
  route: string;
  visits: number;
  requests: number;
  requestMs: number;
  quietAfterMs: number;
  errors: number;
  stalls: number;
  slowest?: Visit['slowest'];
};

/** Per route, averaged over its visits, the costliest arrival first. */
export const summarize = (visits: Visit[]): RouteSummary[] => {
  const by = new Map<string, RouteSummary>();
  for (const v of visits) {
    const s = by.get(v.route) ?? { route: v.route, visits: 0, requests: 0, requestMs: 0, quietAfterMs: 0, errors: 0, stalls: 0 };
    s.visits += 1;
    s.requests += v.requests;
    s.requestMs += v.requestMs;
    s.quietAfterMs += v.quietAfterMs;
    s.errors += v.errors;
    s.stalls += v.stalls;
    if (v.slowest && (!s.slowest || v.slowest.ms > s.slowest.ms)) s.slowest = v.slowest;
    by.set(v.route, s);
  }
  return [...by.values()]
    .map((s) => ({
      ...s,
      requests: Math.round(s.requests / s.visits),
      requestMs: Math.round(s.requestMs / s.visits),
      quietAfterMs: Math.round(s.quietAfterMs / s.visits),
    }))
    .sort((a, b) => b.quietAfterMs - a.quietAfterMs || b.requests - a.requests);
};

export const describePerf = (summary: RouteSummary[]): string => {
  if (summary.length === 0) return '(no screen visits in the trace yet)';
  const lines = ['route                              visits  req/visit  req ms   quiet after  errors  stalls  slowest'];
  for (const s of summary) {
    const slow = s.slowest ? `${s.slowest.method} ${s.slowest.path.split('?')[0]} ${s.slowest.ms}ms` : '';
    lines.push(
      `${s.route.padEnd(34)} ${String(s.visits).padStart(6)}  ${String(s.requests).padStart(9)}  ${String(s.requestMs).padStart(6)}   ${String(s.quietAfterMs).padStart(9)}ms  ${String(s.errors).padStart(6)}  ${String(s.stalls).padStart(6)}  ${slow}`,
    );
  }
  return lines.join('\n');
};
