import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { render } from '@testing-library/react-native';
import { Component, createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { host, noNavigation, qa, start, traceRecord, type ClientOptions, type NavigationAdapter, type Socket } from 'lynkeus-agent';
import { autoWrapper } from 'lynkeus-agent/auto';
import { WebSocket as NodeWebSocket } from 'ws';

import { headlessBackend } from './backend.js';
import { loadYoga } from './layout.js';
import { listenerCounts } from './mocks/controls.js';
import { installRuntime, log, reset } from './runtime.js';
import type { ReactTestInstance } from './tree.js';

// The host test imports this package before the app's entry.
installRuntime();

export type HostOptions = Omit<ClientOptions, 'navigation' | 'backend' | 'createSocket'> & {
  /** Built after render, when the app's navigation ref exists. */
  navigation?: () => NavigationAdapter;
  window?: { w: number; h: number };
  /** Composites whose string `value` prop is what they draw (default /qr|barcode/i), listed as the element's value. */
  valueComponents?: RegExp;
  /** Controls whose contents move on their own, by testID: their text stops counting as a commit, so `idle` can settle. */
  live?: RegExp;
  /** Keep React.StrictMode. Off by default: production has none, and its double renders double what the host measures. */
  strictMode?: boolean;
};

const FOREVER = 2_147_483_647;

const errorText = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error));

// What the app throws where it catches nothing reaches the trace, so `why` can name the cause.
const recordCrash = (what: string, error: unknown, where = '') => {
  const e = error instanceof Error ? error : undefined;
  const message = e?.message ?? String(error);
  log(`${what}: ${e?.stack ?? message}${where ? `\n  in${where}` : ''}`);
  traceRecord({ kind: 'crash', message: message.slice(0, 500), stack: (e?.stack ?? where).slice(0, 2000) || undefined });
};

// Without it one screen that throws unmounts the whole tree, and the driver
// reads an empty screen with no route and no clue why.
class CrashBoundary extends Component<{ children?: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    recordCrash('render error', error, info.componentStack?.split('\n').slice(1, 4).join('\n'));
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

// React Native's WebSocket is a mock under jest; the agent dials out through Node's.
const nodeSocket = (url: string): Socket => {
  const ws = new NodeWebSocket(url);
  const socket: Socket = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on('open', () => {
    log(`connected to ${url}`);
    socket.onopen?.();
  });
  ws.on('message', (data) => socket.onmessage?.({ data: String(data) }));
  ws.on('close', () => socket.onclose?.());
  ws.on('error', (error) => {
    if (!/ECONNREFUSED/.test(String(error))) log(`socket error: ${String(error)}`);
    socket.onerror?.();
  });
  return socket;
};

// The preset binds requestAnimationFrame to the fake setTimeout current when
// it loaded, so it stays dead after useRealTimers; apps defer navigation and
// overlay dismissal to the next frame, and nothing would ever move.
const useRealFrames = () => {
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: (time: number) => void) => realSetTimeout(() => callback(Date.now()), 0),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (id: ReturnType<typeof setTimeout>) => realClearTimeout(id),
  });
};

const RENDER_LOOP = { max: 2000, windowMs: 5000 };

// An effect and a store that feed each other render without end: on a device
// a frame lets the state settle, under jest nothing does, and React's depth
// limit only trips when the updates nest. Each render logs "An update to X
// inside a test"; past a rate no real screen reaches, throw from inside the
// loop, the only place that still runs, and leave the host to `reset`.
const guardConsole = () => {
  let renders = 0;
  // Monotonic: `lynkeus clock` moves Date, and a window measured on it never
  // closes after a jump backwards.
  let windowStart = performance.now();
  const countRender = (message: string, formatArgs: unknown[]) => {
    const now = performance.now();
    if (now - windowStart > RENDER_LOOP.windowMs) {
      renders = 0;
      windowStart = now;
    }
    if (++renders < RENDER_LOOP.max) return;
    // React passes the component name as the next argument; only a pre-formatted message carries it inline.
    const component = (typeof formatArgs[0] === 'string' ? formatArgs[0] : undefined) ?? /An update to (\S+) inside a test/.exec(message)?.[1];
    const windowMs = Math.round(now - windowStart);
    traceRecord({ kind: 'stall', renders, windowMs, component });
    log(`render loop: ${renders} updates${component ? ` to ${component}` : ''} in ${windowMs}ms; breaking it (the screen is dead until reset)`);
    renders = 0;
    windowStart = now;
    throw new Error(`lynkeus headless broke a render loop${component ? ` in ${component}` : ''}`);
  };
  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      const message = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (level === 'error' && message.includes('inside a test was not wrapped in act')) {
        countRender(message, args.slice(1));
        return; // one line per render is what filled a log to 900 MB
      }
      log(`console.${level}: ${message.slice(0, 2000)}`);
      original(...args);
    };
  }
};

const reportCrashes = (g: { reportError?: (error: unknown) => void }) => {
  process.on('unhandledRejection', (reason) => recordCrash('unhandled rejection', reason));
  process.on('uncaughtException', (error) => recordCrash('uncaught exception', error));
  const reported = g.reportError;
  g.reportError = (error: unknown) => {
    recordCrash('uncaught render error', error);
    reported?.(error);
  };
};

const startHost = async (make: () => ReactElement, options: HostOptions) => {
  host.claim();
  log('rendering the app');
  let rendered = await render(make());
  let resets = 0;
  // A reset wipes the mocked native state and mounts the app again: a process
  // that never relaunches still gets a fresh tree, and a dead navigator a way back.
  host.onReset(async () => {
    resets += 1;
    reset();
    try {
      // Rendering again before the unmount settles leaves an empty tree.
      await rendered.unmount();
    } catch (error) {
      log(`reset: unmount failed (${error instanceof Error ? error.message : String(error)})`);
    }
    rendered = await render(make());
    log('reset: app re-rendered');
  });
  qa.register('memory', () => {
    // With --expose-gc, measure what survives a collection.
    (globalThis as { gc?: () => void }).gc?.();
    const m = process.memoryUsage();
    // One fiber root per live tree; more than one after resets is a leak.
    const hook = (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: { renderers: Map<number, unknown>; getFiberRoots: (id: number) => Set<unknown> } })
      .__REACT_DEVTOOLS_GLOBAL_HOOK__;
    let roots = 0;
    if (hook) for (const id of hook.renderers.keys()) roots += hook.getFiberRoots(id).size;
    return {
      heapUsedMb: Math.round(m.heapUsed / 1048576),
      heapTotalMb: Math.round(m.heapTotal / 1048576),
      rssMb: Math.round(m.rss / 1048576),
      resets,
      roots,
      listeners: listenerCounts(),
      commands: qa.commands().length,
    };
  });
  // V8 writes it; anything that reads .heapsnapshot can diff two of them.
  qa.register('heap', (params) => {
    const where = (params as { out?: string } | undefined)?.out ?? path.join(os.tmpdir(), `lynkeus-${Date.now()}.heapsnapshot`);
    (globalThis as { gc?: () => void }).gc?.();
    const file = v8.writeHeapSnapshot(where);
    log(`heap snapshot: ${file}`);
    return { file };
  });
  log(
    `rendered; navigation adapter ${host.navigation() ? 'registered by <Lynkeus>' : 'missing'}; dialing ws://${options.host ?? '127.0.0.1'}:${options.port ?? 8123}`,
  );
  const yoga = await loadYoga(log);
  log(yoga ? 'layout: Yoga loaded (approximate real coordinates)' : 'layout: none (synthetic frames)');
  const backend = headlessBackend(() => rendered.container as unknown as ReactTestInstance, {
    window: options.window,
    yoga,
    valueComponents: options.valueComponents,
    live: options.live,
  });
  // A remount registers a new adapter (a new navigation ref): resolve it on every call.
  const current = (): NavigationAdapter => options.navigation?.() ?? host.navigation() ?? noNavigation;
  const navigation: NavigationAdapter = {
    isReady: () => current().isReady(),
    currentRoute: () => current().currentRoute(),
    path: () => current().path(),
    navigate: (name, params) => current().navigate(name, params),
    canGoBack: () => current().canGoBack(),
    goBack: () => current().goBack(),
    resetToRoot: () => current().resetToRoot?.(),
    resetTo: (name, params) => current().resetTo?.(name, params),
    subscribe: (listener) => current().subscribe(listener),
  };
  return start({
    // Node resolves `localhost` to ::1 first; the driver listens on IPv4.
    host: '127.0.0.1',
    ...options,
    navigation,
    backend,
    createSocket: nodeSocket,
    onError: (error, context) => log(`${context}: ${errorText(error)}`),
  });
};

// Hosts the app for a driver from a jest test that ends only on the `exit` command or a signal.
export const hostApp = (makeApp: () => ReactElement, options: HostOptions = {}): void => {
  const g = globalThis as {
    it?: (name: string, fn: () => Promise<void>, timeout?: number) => void;
    jest?: { setTimeout: (ms: number) => void; useRealTimers?: () => void };
    reportError?: (error: unknown) => void;
  };
  if (!g.it) throw new Error('hostApp must be called from a jest test file');
  // The app reads StrictMode off the react module when it renders.
  if (!options.strictMode) (require('react') as { StrictMode: unknown }).StrictMode = Fragment;
  // An app mounted with `auto()` has no <Lynkeus> of its own: host it under the root a device build gets.
  const make = (): ReactElement => {
    const Root = autoWrapper();
    return createElement(CrashBoundary, null, Root ? createElement(Root, null, makeApp()) : makeApp());
  };
  g.jest?.setTimeout(FOREVER);
  // Reconnects, waits and pacing are all timers; fake ones would freeze the host.
  g.jest?.useRealTimers?.();
  useRealFrames();
  guardConsole();
  reportCrashes(g);
  g.it(
    'hosts the app for lynkeus',
    async () => {
      const done = new Promise<void>((resolve) => {
        qa.register('exit', () => {
          setTimeout(resolve, 50);
          return true;
        });
        process.on('SIGTERM', () => resolve());
        process.on('SIGINT', () => resolve());
      });
      let stop: () => void;
      try {
        stop = await startHost(make, options);
      } catch (error) {
        log(`failed to start: ${errorText(error)}`);
        throw error;
      }
      log('hosting; waiting for a driver (press Ctrl-C or call the exit command to stop)');
      await done;
      stop();
    },
    FOREVER,
  );
};
