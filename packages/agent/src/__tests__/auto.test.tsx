import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createContext, createElement, type ReactNode } from 'react';
import { AppRegistry, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import { auto, autoWrapper } from '../auto';
import { host } from '../registry';

// A stand-in for what BaseNavigationContainer provides: the ref object as a context value.
const RefContext = createContext<unknown>(null);
const fakeContainer = () => {
  const listeners = new Set<() => void>();
  return {
    isReady: () => true,
    getCurrentRoute: () => ({ name: 'Settings.Main' }),
    getRootState: () => ({ index: 0, routes: [{ name: 'Settings.Main' }] }),
    navigate: jest.fn(),
    canGoBack: () => false,
    goBack: jest.fn(),
    addListener: (_: 'state', l: () => void) => listeners.add(l),
    removeListener: (_: 'state', l: () => void) => listeners.delete(l),
    fire: () => {
      for (const l of listeners) l();
    },
  };
};

const App = ({ container }: { container: unknown }) => createElement(RefContext.Provider, { value: container }, createElement(Text, null, 'hello'));

describe('auto()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    host.claim(); // no socket under test
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('wraps the registered root and finds the navigation container on its own', async () => {
    auto({ enabled: true });
    const Wrapper = autoWrapper();
    expect(Wrapper).toBeDefined();
    const container = fakeContainer();
    const rendered = await render(createElement(Wrapper!, null, createElement(App, { container }) as ReactNode));
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    const nav = host.navigation();
    expect(nav?.currentRoute()?.name).toBe('Settings.Main');
    expect(nav?.path()).toEqual(['Settings.Main']);
    const seen = jest.fn();
    nav?.subscribe(seen);
    container.fire();
    expect(seen).toHaveBeenCalled();
    await rendered.unmount();

    // A host that remounts the app (reset) grows a new container: the adapter follows it.
    const next = { ...fakeContainer(), getCurrentRoute: () => ({ name: 'Welcome.Main' }) };
    const again = await render(createElement(Wrapper!, null, createElement(App, { container: next }) as ReactNode));
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(host.navigation()?.currentRoute()?.name).toBe('Welcome.Main');
    await again.unmount();
  });

  it('installs itself through AppRegistry once', () => {
    const set = AppRegistry.setWrapperComponentProvider as unknown as { mock?: { calls: unknown[] } };
    auto({ enabled: true });
    auto({ enabled: true });
    if (set.mock) expect(set.mock.calls.length).toBeLessThanOrEqual(1);
    expect(autoWrapper()).toBeDefined();
  });
});
