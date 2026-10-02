/**
 * What is left to press, kept between crawls as `frontier.jsonl`: per place
 * the agent has stood, which controls were pressed and which are still owed,
 * so the next run picks up where the last one's budget ran out. Stored the way
 * edges.jsonl is: appended while a run lasts, merged on read, sorted at the end.
 */
import { appendJsonl, readJsonl, today, writeJsonl } from '../files.js';

export type Visited = {
  /** A route, or a layer open over one (`Settings.Main#account-button`). */
  node: string;
  tried: string[];
  /** Controls seen here and not pressed yet. */
  left: string[];
  /** A place only ever seen from outside still owes a first visit. */
  visited: boolean;
  last: string;
};

export type FrontierUpdate = { tried?: string[]; seen?: string[]; visited?: boolean };

const merge = (into: Visited, row: Visited) => {
  const tried = new Set([...into.tried, ...row.tried]);
  into.tried = [...tried].sort();
  into.left = [...new Set([...into.left, ...row.left])].filter((c) => !tried.has(c)).sort();
  into.visited ||= row.visited;
  if (row.last > into.last) into.last = row.last;
};

const add = (byNode: Map<string, Visited>, row: Visited) => {
  let found = byNode.get(row.node);
  if (!found) {
    found = { node: row.node, tried: [], left: [], visited: false, last: '' };
    byNode.set(row.node, found);
  }
  merge(found, row);
};

const merged = (rows: Visited[]): Map<string, Visited> => {
  const byNode = new Map<string, Visited>();
  for (const row of rows) add(byNode, row);
  return byNode;
};

const save = (file: string, rows: Visited[]) =>
  writeJsonl(
    file,
    [...rows].sort((a, b) => a.node.localeCompare(b.node)),
  );

export const load = (file: string): Visited[] => [...merged(readJsonl<Visited>(file)).values()];

/** Places that still owe something, the never-visited first: what they offer is unknown, which is worth more than a known remainder. */
export const unfinished = (rows: Visited[]): Visited[] =>
  rows.filter((r) => !r.visited || r.left.length > 0).sort((a, b) => Number(a.visited) - Number(b.visited) || b.left.length - a.left.length);

/** The frontier in a file, kept in memory while a crawl adds to it. */
export const open = (file: string) => {
  const rows = merged(readJsonl<Visited>(file));
  let appended = false;
  return {
    tried: (node: string): string[] => rows.get(node)?.tried ?? [],
    record: (node: string, update: FrontierUpdate): void => {
      const row: Visited = { node, tried: update.tried ?? [], left: update.seen ?? [], visited: update.visited === true, last: today() };
      appendJsonl(file, row);
      appended = true;
      add(rows, row);
    },
    unfinished: (): string[] => unfinished([...rows.values()]).map((r) => r.node),
    compact: () => {
      if (appended) save(file, load(file));
    },
  };
};

export const prune = (file: string, routes: Set<string>): number => {
  const before = load(file);
  if (before.length === 0) return 0;
  const after = before.filter((r) => routes.has(r.node.split('#')[0]!));
  save(file, after);
  return before.length - after.length;
};
