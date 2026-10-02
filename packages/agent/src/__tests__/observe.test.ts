import { describe, expect, it } from '@jest/globals';

import { createHandlers, dispatch } from '../handlers';
import { noNavigation } from '../navigation';
import { qa } from '../registry';
import { traceSince } from '../trace';
import type { Backend } from '../backend';

const handlers = createHandlers(noNavigation, {
  name: 'fake',
  native: false,
  snapshot: () => ({ elements: [] }),
  commitCount: () => 0,
  window: () => ({ w: 1, h: 1 }),
} as unknown as Backend);

const storeOf = <T>(initial: T) => {
  let state = initial;
  const listeners = new Set<(s: unknown) => void>();
  return {
    getState: () => state,
    subscribe: (l: (s: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (next: T) => {
      state = next;
      for (const l of listeners) l(state);
    },
  };
};

describe('what every app exposes without writing a command', () => {
  it('events holds what qa.event recorded, in order, and clears on request', async () => {
    await dispatch(handlers, 'events', { clear: true });
    qa.event('checkout_started', { plan: 'pro', seats: 3 });
    qa.event('checkout_completed');
    const events = (await dispatch(handlers, 'events', { clear: true })) as { name: string; props?: object }[];
    expect(events.map((e) => e.name)).toEqual(['checkout_started', 'checkout_completed']);
    expect(events[0]?.props).toEqual({ plan: 'pro', seats: 3 });
    expect(await dispatch(handlers, 'events', undefined)).toEqual([]);
    expect(traceSince().some((e) => e.kind === 'event' && e.name === 'checkout_completed')).toBe(true);
  });

  it('stores lists what is observed and reads one by name, without functions', async () => {
    const session = storeOf({ user: { plan: 'free' }, logout: () => undefined });
    const stop = qa.observe('session', session);
    expect(await dispatch(handlers, 'stores', undefined)).toEqual({ stores: ['session'] });
    session.set({ user: { plan: 'pro' }, logout: () => undefined });
    expect(await dispatch(handlers, 'stores', { name: 'session' })).toEqual({ user: { plan: 'pro' } });
    await expect(dispatch(handlers, 'stores', { name: 'nope' })).rejects.toThrow(/No store observed as "nope"/);
    stop();
  });

  it('an app that keeps its own events can still register over the default', async () => {
    const off = qa.register('events', () => ['from the app']);
    expect(await dispatch(handlers, 'events', undefined)).toEqual(['from the app']);
    off();
    expect(await dispatch(handlers, 'events', undefined)).toEqual([]);
  });
});
