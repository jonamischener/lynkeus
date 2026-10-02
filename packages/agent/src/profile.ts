/**
 * What React spent rendering per commit, from the Profiler auto() puts around
 * the app. Nothing is kept until `profile { action: 'start' }`.
 */
type Commit = { route?: string; ms: number };

const LIMIT = 5000;
let commits: Commit[] = [];
let recording = false;

export const recordCommit = (actualDuration: number, route?: string): void => {
  if (!recording) return;
  commits.push({ route, ms: actualDuration });
  if (commits.length > LIMIT) commits = commits.slice(-LIMIT);
};

const round = (n: number) => Math.round(n * 10) / 10;

export const readProfile = (params: unknown): unknown => {
  const { action } = (params ?? {}) as { action?: 'start' | 'stop' };
  if (action === 'start') {
    commits = [];
    recording = true;
    return { recording };
  }
  if (action === 'stop') recording = false;
  let ms = 0;
  const routes: Record<string, { commits: number; ms: number; maxMs: number }> = {};
  for (const c of commits) {
    ms += c.ms;
    const key = c.route ?? '?';
    const r = routes[key] ?? { commits: 0, ms: 0, maxMs: 0 };
    routes[key] = r;
    r.commits += 1;
    r.ms += c.ms;
    r.maxMs = Math.max(r.maxMs, c.ms);
  }
  for (const r of Object.values(routes)) {
    r.ms = round(r.ms);
    r.maxMs = round(r.maxMs);
  }
  return { recording, commits: commits.length, ms: round(ms), routes };
};
