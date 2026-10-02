import type { RequestRecord } from './protocol';
import { record as trace } from './trace';

const KEEP = 200;
const SENSITIVE = /(token|key|secret|code|otp|password|pin|session|auth)=[^&#]*/gi;

const records: RequestRecord[] = [];
let nextId = 1;
let inFlight = 0;
let installed = false;

// Query strings are kept for their shape (page, filters), never for secrets.
export const redactUrl = (url: string): string => url.replace(SENSITIVE, '$1=…');

// Method, URL, status and duration only: never headers, never bodies.
const track = (method: string, url: string) => {
  const record: RequestRecord = { id: nextId++, method, url: redactUrl(url), startedAt: Date.now() };
  inFlight += 1;
  records.push(record);
  if (records.length > KEEP) records.shift();
  return (status: number, error?: unknown) => {
    inFlight -= 1;
    record.status = status;
    record.ms = Date.now() - record.startedAt;
    if (status === 0) record.error = error instanceof Error ? error.message : 'network error or aborted';
    trace({ kind: 'request', method: record.method, url: record.url, status, ms: record.ms, error: record.error });
  };
};

// Node hosts have a native fetch and no XMLHttpRequest.
const trackFetch = (): void => {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== 'function') return;
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const finish = track(method.toUpperCase(), url);
    try {
      const response = await original(input, init);
      finish(response.status);
      return response;
    } catch (error) {
      finish(0, error);
      throw error;
    }
  }) as typeof fetch;
};

// In React Native every request, fetch included, goes through XMLHttpRequest.
const trackXhr = (): void => {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const opened = new WeakMap<XMLHttpRequest, [method: string, url: string]>();
  proto.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    opened.set(this, [args[0], String(args[1])]);
    return open.apply(this, args);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    const request = opened.get(this);
    if (request) {
      const finish = track(...request);
      this.addEventListener('loadend', () => finish(this.status));
    }
    return send.apply(this, args);
  } as typeof proto.send;
};

export const trackRequests = (): void => {
  if (installed) return;
  installed = true;
  if (typeof XMLHttpRequest === 'undefined') trackFetch();
  else trackXhr();
};

export const recentRequests = (since?: number): RequestRecord[] => (since === undefined ? [...records] : records.filter((r) => r.id > since));

export const requestsInFlight = (): number => inFlight;
