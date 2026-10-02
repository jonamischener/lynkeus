import { installRuntime, log, resolvable } from '../runtime.js';
import { connectivityControls, installControls, netControls, pathOf } from './controls.js';
import {
  asyncStorage,
  biometrics,
  deviceInfo,
  fastImage,
  imagePicker,
  inAppReview,
  keychain,
  localize,
  mmkv,
  pagerView,
  safeAreaContext,
  video,
  visionCamera,
  webView,
  worklets,
  type DeviceVersion,
  type LocaleDefault,
  type MockFactory,
} from './factories.js';

// jest injects `jest` as a module-scoped local, not onto globalThis.
declare const jest: { doMock(name: string, factory: () => unknown): void; requireMock(name: string): Record<string, unknown> };

export type InstallOptions = {
  /** Modules to leave alone, to mock yourself. */
  skip?: string[];
  /** Module name → factory. Wins over the default and applies even when the module is not installed. */
  overrides?: Record<string, MockFactory>;
  /** 'real' swaps jest's banned fetch for Node's own, fenced by `networkHosts`. */
  network?: 'real' | 'banned';
  /** Hosts real network and sockets may reach; anything else is refused at once. Default: local hosts only. */
  networkHosts?: string[];
  /**
   * What `WebSocket` is: 'stub' (default) connects and stays silent, 'real' is
   * Node's `ws` fenced by `networkHosts`, 'none' leaves jest's undefined. A
   * realtime layer that throws on connect can unwind a login.
   */
  websocket?: 'stub' | 'real' | 'none';
  /**
   * reanimated's mock completes withTiming/withSpring synchronously, so an
   * overlay that flips a store on completion animates again in the same tick,
   * forever. 'deferred' (default) moves completions to the next tick; 'sync'
   * leaves the mock as the app registered it.
   */
  animations?: 'deferred' | 'sync';
  /** Default 9.9.9 / 9999 / iOS. */
  deviceVersion?: DeviceVersion;
  /** Default US / en-US / en. */
  locale?: LocaleDefault;
  /** What Linking.getInitialURL answers: the deep link the app was opened with. */
  initialUrl?: string | null;
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '10.0.2.2'];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

// A hosted app must not reach third parties (analytics, auth providers): refuse
// fast and say so once per host.
const hostFence = (hosts: string[], kind: string) => {
  const allowed = new Set(hosts);
  const refused = new Set<string>();
  return (url: string): string | undefined => {
    const host = hostOf(url);
    if (!host || allowed.has(host)) return undefined;
    if (!refused.has(host)) {
      refused.add(host);
      log(`${kind}: refused ${host} (not in networkHosts)`);
    }
    return host;
  };
};

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;

const fencedFetch = (fetchImpl: Fetch, hosts: string[]): Fetch => {
  const refuse = hostFence(hosts, 'network');
  return (input, init) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string } | null)?.url ?? String(input));
    const refused = refuse(url);
    if (refused) return Promise.reject(new Error(`lynkeus headless: network to ${refused} is off (networkHosts)`));
    if (connectivityControls.offline()) return Promise.reject(new TypeError('Network request failed'));
    const method = String((init as { method?: string } | undefined)?.method ?? (input as { method?: string } | null)?.method ?? 'GET').toUpperCase();
    const rule = netControls.match(method, url);
    if (rule?.lost) {
      const lost = (response?: unknown) => {
        log(`network: lost the answer to ${method} ${url} (${(response as { status?: number } | undefined)?.status ?? 'no answer'})`);
        throw new TypeError('Network request failed');
      };
      return fetchImpl(input, init).then(lost, () => lost());
    }
    if (rule) return netControls.respond(rule, (globalThis as unknown as { Response: Parameters<typeof netControls.respond>[1] }).Response);
    const result = fetchImpl(input, init);
    if (!netControls.recording()) return result;
    return result.then(async (response) => {
      const r = response as { clone: () => { text: () => Promise<string> }; status: number };
      try {
        netControls.record({ method, path: pathOf(url), status: r.status, body: await r.clone().text() });
      } catch {
        // a body that cannot be read twice is not worth failing the request for
      }
      return response;
    });
  };
};

// Connects on the next tick and never delivers; `offline` is a socket opened in airplane mode.
class SilentWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = SilentWebSocket.CONNECTING;
  protocol = '';
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  private failing = false;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  static offline(url: string): SilentWebSocket {
    const socket = new SilentWebSocket(url);
    socket.failing = true;
    socket.readyState = SilentWebSocket.CLOSED;
    return socket;
  }

  constructor(readonly url: string) {
    setTimeout(() => {
      if (this.failing) {
        this.emit('error', { type: 'error', message: 'offline' });
        this.emit('close', { type: 'close', code: 1006, reason: 'offline', wasClean: false });
        return;
      }
      this.readyState = SilentWebSocket.OPEN;
      this.emit('open', { type: 'open' });
    }, 0);
  }

  send() {}

  close() {
    if (this.readyState === SilentWebSocket.CLOSED) return;
    this.readyState = SilentWebSocket.CLOSED;
    this.emit('close', { type: 'close', code: 1000, reason: '', wasClean: true });
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  private emit(type: 'open' | 'error' | 'close', event: unknown) {
    this[`on${type}`]?.(event);
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

type SocketClass = new (url: string, protocols?: string | string[], options?: unknown) => unknown;

// A socket to production would be worse than a stray fetch, since it stays
// open. A refused host gets the silent stub, so the realtime layer sees
// "connected" and nothing more.
const fencedWebSocket = (Real: SocketClass, hosts: string[]) => {
  const refuse = hostFence(hosts, 'websocket');
  // A client compares readyState against the constants on the class it was
  // handed, so the fence must carry them.
  return class FencedWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    // biome-ignore-start lint/correctness/noConstructorReturn: the fence hands back the real socket, a stub or a dead one
    constructor(url: string, protocols?: string | string[], options?: unknown) {
      if (refuse(url)) return new SilentWebSocket(url) as unknown as FencedWebSocket;
      if (connectivityControls.offline()) return SilentWebSocket.offline(url) as unknown as FencedWebSocket;
      const socket = new Real(url, protocols, options) as FencedWebSocket;
      connectivityControls.track(socket);
      return socket;
    }
    // biome-ignore-end lint/correctness/noConstructorReturn: the fence hands back the real socket, a stub or a dead one
  };
};

const installWebSocket = (mode: InstallOptions['websocket'], hosts: string[]) => {
  const g = globalThis as { WebSocket?: unknown };
  if (mode === 'real' && resolvable('ws')) {
    g.WebSocket = fencedWebSocket((require('ws') as { WebSocket: SocketClass }).WebSocket, hosts);
    log(`websocket: real (ws, fenced to ${hosts.join(', ')})`);
  } else if (mode === 'real') {
    g.WebSocket = SilentWebSocket;
    log('websocket: "real" requested but `ws` is not installed; stub instead');
  } else if (mode === 'stub' && g.WebSocket === undefined) {
    g.WebSocket = SilentWebSocket;
    log('websocket: stub (connects, never delivers)');
  }
};

// jest's sandbox shadows fetch with a rejecting stub, and even `Function()`
// resolves globals inside it. vm.runInThisContext evaluates in the process
// context, the one path out to Node's own fetch (undici), which handles
// Request objects and streams where node-fetch v2 does not.
const installRealNetwork = (hosts: string[]) => {
  const g = globalThis as Record<string, unknown>;
  const vm = require('node:vm') as typeof import('node:vm');
  const outer = (name: string): unknown => {
    try {
      return vm.runInThisContext(`globalThis.${name}`);
    } catch {
      return undefined;
    }
  };
  const native = outer('fetch');
  if (typeof native === 'function') {
    g.fetch = fencedFetch(native as Fetch, hosts);
    for (const name of ['Headers', 'Request', 'Response', 'FormData']) {
      const value = outer(name);
      if (typeof value === 'function') g[name] = value;
    }
    log(`network: real (native fetch, node ${process.versions.node})`);
    return;
  }
  if (!resolvable('node-fetch')) {
    log('network: "real" requested but neither native fetch nor node-fetch is available; leaving fetch as-is');
    return;
  }
  const nodeFetch = require('node-fetch');
  g.fetch = fencedFetch(nodeFetch.default ?? nodeFetch, hosts);
  g.Headers ??= nodeFetch.Headers;
  g.Request ??= nodeFetch.Request;
  g.Response ??= nodeFetch.Response;
  log('network: real (node-fetch fallback)');
};

// requireMock returns the very object later requires receive, so patching it reaches the app.
const registeredMock = (name: string): Record<string, unknown> | undefined => {
  if (!resolvable(name)) return undefined;
  try {
    return jest.requireMock(name);
  } catch {
    return undefined;
  }
};

// NetInfo's mock reports wifi forever and never calls a listener; route it
// through the host's connectivity so `network off` reaches every subscriber.
const installNetInfo = () => {
  const mock = registeredMock('@react-native-community/netinfo');
  if (!mock) return;
  for (const target of [mock, mock.default]) {
    if (!target || typeof target !== 'object') continue;
    Object.assign(target, {
      addEventListener: (listener: (state: unknown) => void) => {
        listener(connectivityControls.netInfo());
        return connectivityControls.subscribe(listener);
      },
      fetch: async () => connectivityControls.netInfo(),
      refresh: async () => connectivityControls.netInfo(),
    });
  }
  log('netinfo: follows `network on|off`');
};

const deferAnimationCompletions = () => {
  const mock = registeredMock('react-native-reanimated');
  if (!mock) return;
  const patched = ['withTiming', 'withSpring', 'withDecay', 'withDelay', 'withSequence', 'withRepeat'].filter((name) => {
    const original = mock[name];
    if (typeof original !== 'function') return false;
    mock[name] = (...args: unknown[]) => {
      const at = args.findIndex((a) => typeof a === 'function');
      if (at === -1) return original(...args);
      const callback = args[at] as (...a: unknown[]) => void;
      const deferred = [...args];
      deferred[at] = (...callbackArgs: unknown[]) => setTimeout(() => callback(...callbackArgs), 0);
      return original(...deferred);
    };
    return true;
  });
  if (patched.length) log(`animations: completions deferred to the next tick (${patched.join(', ')})`);
};

// Call at the top of the headless entry, before the app is required. Returns the modules it mocked.
export const installDefaultMocks = (options: InstallOptions = {}): string[] => {
  if (typeof jest === 'undefined') throw new Error('installDefaultMocks must run under jest (lynkeus headless).');
  installRuntime();
  const skip = new Set(options.skip ?? []);
  const overrides = options.overrides ?? {};
  const hosts = options.networkHosts ?? LOCAL_HOSTS;

  // Applied only when the module resolves in the project. Reanimated and
  // gesture-handler are left out: their jest story is a babel plugin and a
  // setup file, and reanimated's mock lacks newer APIs.
  const defaults: Record<string, MockFactory> = {
    'react-native-mmkv': mmkv,
    'react-native-keychain': keychain,
    'react-native-device-info': deviceInfo(options.deviceVersion),
    'react-native-safe-area-context': safeAreaContext,
    'react-native-localize': localize(options.locale),
    '@react-native-async-storage/async-storage': asyncStorage,
    'react-native-worklets': worklets,
    'react-native-pager-view': pagerView,
    'react-native-video': video,
    'react-native-fast-image': fastImage,
    'react-native-biometrics': biometrics,
    'react-native-in-app-review': inAppReview,
    'react-native-webview': webView,
    'react-native-vision-camera': visionCamera,
    'react-native-image-picker': imagePicker,
  };

  const installed: string[] = [];
  for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
    if (skip.has(name)) continue;
    const factory = overrides[name] ?? (resolvable(name) ? defaults[name] : undefined);
    if (!factory) continue;
    jest.doMock(name, factory);
    installed.push(name);
  }

  if (options.network === 'real') installRealNetwork(hosts);
  installControls(options.initialUrl ?? null);
  if ((options.animations ?? 'deferred') === 'deferred') deferAnimationCompletions();
  installNetInfo();
  installWebSocket(options.websocket ?? 'stub', hosts);

  log(`mocked: ${installed.sort().join(', ') || '(none detected)'}`);
  return installed;
};
