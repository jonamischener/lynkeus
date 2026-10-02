import type { TraceEvent } from './protocol';

const KEEP = 500;
const events: TraceEvent[] = [];
let nextSeq = 1;

// Omit over a union keeps only the shared keys; distributing it keeps each kind's own fields.
type Distribute<T> = T extends unknown ? Omit<T, 'seq' | 't'> : never;

export const record = (event: Distribute<TraceEvent>): void => {
  events.push({ seq: nextSeq++, t: Date.now(), ...event } as TraceEvent);
  if (events.length > KEEP) events.shift();
};

export const traceSince = (since?: number): TraceEvent[] => (since === undefined ? [...events] : events.filter((e) => e.seq > since));

export const lastSeq = (): number => nextSeq - 1;
