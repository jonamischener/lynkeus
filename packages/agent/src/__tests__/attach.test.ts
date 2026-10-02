import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Backend } from '../backend';
import { type Socket, start } from '../client';
import { noNavigation } from '../navigation';

const backend = {
  name: 'fake',
  native: false,
  snapshot: () => ({ elements: [] }),
  commitCount: () => 0,
  window: () => ({ w: 390, h: 844 }),
} as unknown as Backend;

const dialer = () => {
  const dials: number[] = [];
  const sockets: Socket[] = [];
  const createSocket = (): Socket => {
    dials.push(Date.now());
    const socket: Socket = { readyState: 0, send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
    sockets.push(socket);
    return socket;
  };
  const refuse = () => sockets[sockets.length - 1]?.onclose?.();
  return { dials, sockets, createSocket, refuse };
};

describe('dialing the driver', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('dials every 100 ms for three seconds, then backs off to the ceiling while nobody listens', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket });
    for (let i = 0; i < 36; i++) {
      d.refuse();
      jest.runOnlyPendingTimers();
    }
    const gaps = d.dials.slice(1).map((t, i) => t - d.dials[i]!);
    expect(gaps.slice(0, 30)).toEqual(Array(30).fill(100));
    expect(gaps.slice(30)).toEqual([100, 200, 400, 800, 1500, 1500]);
    stop();
  });

  it('starts fast again after a link that was up drops', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket });
    for (let i = 0; i < 34; i++) {
      d.refuse();
      jest.runOnlyPendingTimers();
    }
    d.sockets[d.sockets.length - 1]?.onopen?.();
    const before = Date.now();
    d.refuse();
    jest.runOnlyPendingTimers();
    expect(d.dials[d.dials.length - 1]! - before).toBe(100);
    stop();
  });
});
