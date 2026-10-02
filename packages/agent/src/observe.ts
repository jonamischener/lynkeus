import { record } from './trace';

type Store = { getState(): unknown; subscribe(listener: (state: unknown) => void): () => void };
type AppEvent = { t: number; name: string; props?: Record<string, unknown>; route?: string };

const KEEP = 500;
const stores = new Map<string, Store>();
const buffer: AppEvent[] = [];

// Enough of a store to assert on, never a function or an unbounded graph.
const plain = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length}]` : '{…}';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => plain(v, depth + 1));
  if (value instanceof Map) return plain(Object.fromEntries(value), depth);
  if (value instanceof Set) return plain([...value], depth);
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const p = plain(v, depth + 1);
    if (p !== undefined) out[k] = p;
  }
  return out;
};

// Objects are reduced to their size so secrets and payloads never land in the trace.
const summarise = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  return Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`;
};

/**
 * Expose a store (anything with getState/subscribe): the trace records which
 * top-level keys change, and the `stores` command reads its state.
 *
 * Call it before the app subscribes to the store itself. Stores notify in
 * subscription order and stop at the first listener that throws, so an app
 * listener failing under a host would otherwise hide the change from the trace.
 */
export const observe = (name: string, store: Store): (() => void) => {
  stores.set(name, store);
  let previous = store.getState() as Record<string, unknown> | undefined;
  const unsubscribe = store.subscribe((next) => {
    const current = next as Record<string, unknown> | undefined;
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})])) {
      if (previous?.[key] !== current?.[key]) changed[key] = { from: summarise(previous?.[key]), to: summarise(current?.[key]) };
    }
    previous = current;
    if (Object.keys(changed).length > 0) record({ kind: 'store', store: name, changed });
  });
  return () => {
    unsubscribe();
    if (stores.get(name) === store) stores.delete(name);
  };
};

export const event = (name: string, props?: Record<string, unknown>, route?: string): void => {
  const entry: AppEvent = { t: Date.now(), name, ...(props ? { props: plain(props) as Record<string, unknown> } : {}), ...(route ? { route } : {}) };
  buffer.push(entry);
  if (buffer.length > KEEP) buffer.shift();
  record({ kind: 'event', name, props: entry.props, route });
};

/** `events`: oldest first; `{ clear: true }` empties the buffer after reading. */
export const readEvents = (params: unknown): AppEvent[] => {
  const out = [...buffer];
  if ((params as { clear?: boolean } | undefined)?.clear) buffer.length = 0;
  return out;
};

/** `stores`: the observed names, or one store's state by `{ name }`. */
export const readStores = (params: unknown): unknown => {
  const name = (params as { name?: string } | undefined)?.name;
  if (!name) return { stores: [...stores.keys()].sort() };
  const store = stores.get(name);
  if (!store) throw new Error(`No store observed as "${name}"; observed: ${[...stores.keys()].join(', ') || 'none'}`);
  return plain(store.getState());
};
