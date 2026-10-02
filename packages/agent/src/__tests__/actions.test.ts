import { describe, expect, it, jest } from '@jest/globals';

import type { Backend } from '../backend';
import { createHandlers, dispatch } from '../handlers';
import { noNavigation } from '../navigation';
import type { Element } from '../protocol';

const element = (over: Partial<Element>): Element => ({
  i: 0,
  kind: 'button',
  frame: { x: 0, y: 0, w: 100, h: 40 },
  enabled: true,
  depth: 0,
  ...over,
});

const fakeBackend = (elements: Element[]) => {
  const swipeOn = jest.fn(async () => undefined);
  const swipe = jest.fn(async () => undefined);
  const backend: Backend = {
    name: 'fake',
    native: false,
    snapshot: () => ({ elements }),
    commitCount: () => 0,
    window: () => ({ w: 390, h: 844 }),
    press: async () => undefined,
    pressPoint: async () => undefined,
    pressJs: async () => undefined,
    typeText: async () => undefined,
    deleteBackward: async () => undefined,
    dismissKeyboard: async () => undefined,
    submit: async () => undefined,
    swipe,
    swipeOn,
    debug: () => null,
  };
  return { backend, swipeOn, swipe };
};

describe('acting on what the platform does not present', () => {
  const slider = element({ testId: 'slide-to-confirm', hidden: 'inert' });

  it('finds an inert element but refuses to swipe it', async () => {
    const { backend, swipeOn, swipe } = fakeBackend([slider]);
    const handlers = createHandlers(noNavigation, backend);

    const found = (await dispatch(handlers, 'find', { testId: 'slide-to-confirm' })) as Element | null;
    expect(found?.testId).toBe('slide-to-confirm');

    await expect(dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' })).rejects.toThrow(/not presented \(inert\)/);
    expect(swipeOn).not.toHaveBeenCalled();
    expect(swipe).not.toHaveBeenCalled();
  });

  it('swipes the same element once it is presented', async () => {
    const { backend, swipeOn } = fakeBackend([{ ...slider, hidden: undefined }]);
    const handlers = createHandlers(noNavigation, backend);

    await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    expect(swipeOn).toHaveBeenCalledTimes(1);
  });
});
