// jest buffers console output until a test ends, and the host's test never does.
export const log = (line: string): void => {
  process.stderr.write(`[lynkeus-headless] ${line}\n`);
};

const resetters: Array<() => void> = [];

// What a fresh app must not inherit from the previous case: mocked stores, network rules, the clock.
export const onReset = (fn: () => void): void => {
  resetters.push(fn);
};

export const reset = (): void => {
  for (const fn of resetters) {
    try {
      fn();
    } catch (error) {
      log(`reset: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

export const resolvable = (id: string): boolean => {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
};

// What React Native's InitializeCore does to the global scope and its jest
// preset does not, needed before any app module evaluates.
export const installRuntime = (): void => {
  // react-navigation reads `navigator.product` once, at load, to flush state in
  // a layout effect; without it a RESET of a nested navigator is overwritten
  // by that navigator's own unmount cleanup and the stack stays where it was.
  const g = globalThis as { navigator?: { product?: string } };
  if (g.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { product: 'ReactNative' } });
  } else if (g.navigator.product !== 'ReactNative') {
    Object.defineProperty(g.navigator, 'product', { configurable: true, get: () => 'ReactNative' });
  }
  // The preset answers Dimensions with 750×1334 while the host lays screens out
  // on a phone: a slider sized from Dimensions would never reach its end.
  const { Dimensions } = require('react-native') as { Dimensions: { set?: (dims: Record<string, unknown>) => void } };
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 };
  Dimensions.set?.({ window, screen: window });
};
