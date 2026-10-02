import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { View } from 'react-native';

import { hostApp } from '../index.js';

// hostApp installs the guard on console.error the moment it is called, before
// the never-ending test it registers with `it` runs. Handing it a stub `it`
// gives the guard without a socket or a rendered app.
const RENDER_LOOP = { max: 2000, windowMs: 5000 };
const originalError = jest.fn();
const originalWarn = console.warn;
const originalIt = (globalThis as unknown as { it: unknown }).it;

const actWarning = (component: string) => console.error('Warning: An update to %s inside a test was not wrapped in act(...)', component);
const warnTimes = (n: number, component = 'Screen') => {
  for (let i = 0; i < n; i++) actWarning(component);
};

beforeAll(() => {
  // The guard measures its window on performance.now(); fake timers move it.
  jest.useFakeTimers();
  console.error = originalError as unknown as typeof console.error;
  (globalThis as unknown as { it: unknown }).it = jest.fn();
  hostApp(() => createElement(View), {});
  (globalThis as unknown as { it: unknown }).it = originalIt;
});

afterAll(() => {
  console.warn = originalWarn;
  jest.useRealTimers();
});

beforeEach(() => {
  originalError.mockClear();
  jest.advanceTimersByTime(RENDER_LOOP.windowMs + 1);
});

describe('render loop guard', () => {
  it('swallows act warnings under the cap without reaching the console', () => {
    expect(() => warnTimes(RENDER_LOOP.max - 1)).not.toThrow();
    expect(originalError).not.toHaveBeenCalled();
  });

  it('breaks the loop on the cap, naming the component', () => {
    warnTimes(RENDER_LOOP.max - 1, 'Loop');
    expect(() => actWarning('Loop')).toThrow('lynkeus headless broke a render loop in Loop');
  });

  it('starts counting again after breaking a loop', () => {
    expect(() => warnTimes(RENDER_LOOP.max)).toThrow();
    expect(() => warnTimes(RENDER_LOOP.max - 1)).not.toThrow();
  });

  it('starts counting again once the window has passed', () => {
    warnTimes(RENDER_LOOP.max - 1);
    jest.advanceTimersByTime(RENDER_LOOP.windowMs + 1);
    expect(() => warnTimes(RENDER_LOOP.max - 1)).not.toThrow();
  });

  it('reads the component name out of a pre-formatted message', () => {
    const preformatted = () => console.error('An update to Dead inside a test was not wrapped in act(...)');
    for (let i = 0; i < RENDER_LOOP.max - 1; i++) preformatted();
    expect(preformatted).toThrow(/in Dead/);
  });

  it('breaks the loop without a name when the message carries none', () => {
    const anonymous = () => console.error('inside a test was not wrapped in act(...)');
    for (let i = 0; i < RENDER_LOOP.max - 1; i++) anonymous();
    expect(anonymous).toThrow(/^lynkeus headless broke a render loop$/);
  });

  it('passes every other console.error through to the original', () => {
    console.error('boom');
    expect(originalError).toHaveBeenCalledWith('boom');
  });
});
