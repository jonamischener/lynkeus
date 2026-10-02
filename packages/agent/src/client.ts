import { LogBox, Platform } from 'react-native';

import type { Backend } from './backend';
import { fabricBackend } from './backends/fabric';
import { createHandlers, dispatch } from './handlers';
import type { NavigationAdapter } from './navigation';
import { type AgentEvent, type AuthEvent, type HelloEvent, PROTOCOL_VERSION, type Request, type Response } from './protocol';
import { host } from './registry';
import { trackRequests } from './requests';
import { record as trace } from './trace';

export type ClientOptions = {
  navigation: NavigationAdapter;
  /** Where the driver listens. Default: localhost:8123 (10.0.2.2 on the Android emulator). */
  host?: string;
  port?: number;
  /**
   * When set, the driver must open with this token before any command is
   * served: a per-machine secret keeps other local processes from driving the app.
   */
  token?: string;
  /** Free-form description sent in `hello` (name, version, environment). */
  app?: Record<string, unknown>;
  /** The longest wait between dials. For 3 s after a link drops (or the app starts) it dials every 100 ms; then each wait doubles up to this. Default 1500. */
  reconnectMs?: number;
  /** Where the app runs; the device/Fabric backend by default. */
  backend?: Backend;
  /** How to open the socket; the global WebSocket by default. */
  createSocket?: (url: string) => Socket;
  /** Where failures inside the link go (hosts log them; the app stays quiet). */
  onError?: (error: unknown, context: string) => void;
};

// Typed locally so a Node `@types` in the workspace cannot shadow it.
export type Socket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

const OPEN = 1;
const EAGER_MS = 3000;
const REPLAY_WINDOW = 64;
// Reads would drown the timeline; only actions are worth a line.
const UNTRACED = new Set(['screen', 'find', 'trace', 'requests', 'ping', 'debug', 'idle', 'waitFor', 'busy']);

const openSocket = (url: string): Socket => new (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket(url);

/** The app end of the link: dials the driver, retries quietly while nobody listens, serves requests. Returns a stop function. */
export const start = (options: ClientOptions): (() => void) => {
  trackRequests();
  const { navigation } = options;
  const backend = options.backend ?? fabricBackend();
  const handlers = createHandlers(navigation, backend);
  const url = `ws://${options.host ?? (Platform.OS === 'android' ? '10.0.2.2' : 'localhost')}:${options.port ?? 8123}`;
  const maxDelay = options.reconnectMs ?? 1500;
  const eager = Math.min(100, maxDelay);
  let delay = eager;
  let eagerUntil = Date.now() + EAGER_MS;
  let socket: Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const send = (message: Response | AgentEvent) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  const hello = (): HelloEvent => ({
    event: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    platform: Platform.OS,
    native: backend.native,
    commands: host.commands(),
    route: navigation.currentRoute()?.name,
    app: options.app,
  });

  // The driver resends in-flight requests verbatim after a reconnect. One the
  // app already ran (only the reply was lost) answers from the recorded reply:
  // a press is not idempotent. Keyed by driver session, since every driver
  // numbers its requests from 1.
  const replies = new Map<string, Response>();
  let session = '';

  const serve = async (request: Request) => {
    const key = `${session}:${request.id}`;
    const seen = replies.get(key);
    if (seen) {
      send(seen);
      return;
    }
    const started = Date.now();
    let reply: Response;
    try {
      const result = await dispatch(handlers, request.method, request.params, navigation);
      if (!UNTRACED.has(request.method)) trace({ kind: 'command', method: request.method, ms: Date.now() - started });
      reply = { id: request.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace({ kind: 'command', method: request.method, ms: Date.now() - started, error: message });
      options.onError?.(error, request.method);
      reply = { id: request.id, error: { message } };
    }
    replies.set(key, reply);
    if (replies.size > REPLAY_WINDOW) replies.delete(replies.keys().next().value as string);
    send(reply);
  };

  const connect = () => {
    if (stopped) return;
    const ws = (options.createSocket ?? openSocket)(url);
    socket = ws;
    let authenticated = options.token === undefined;
    // hello goes out on the driver's auth event, which always arrives first.
    ws.onopen = () => {
      delay = eager;
      eagerUntil = Number.POSITIVE_INFINITY;
      try {
        // An automation session must not fight the LogBox pill for the screen.
        LogBox.ignoreAllLogs?.(true);
      } catch (error) {
        options.onError?.(error, 'hello');
      }
    };
    ws.onmessage = (message) => {
      let parsed: Request | AuthEvent;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if ('event' in parsed) {
        if (parsed.event !== 'auth') return;
        if (parsed.session !== session) {
          replies.clear();
          session = parsed.session;
        }
        if (options.token === undefined || parsed.token === options.token) {
          authenticated = true;
          send(hello());
        }
        return;
      }
      if (!authenticated) {
        send({ id: parsed.id, error: { message: 'Not authenticated', code: 'unauthenticated' } });
        return;
      }
      void serve(parsed);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      if (eagerUntil === Number.POSITIVE_INFINITY) eagerUntil = Date.now() + EAGER_MS;
      timer = setTimeout(connect, delay);
      if (Date.now() >= eagerUntil) delay = Math.min(delay * 2, maxDelay);
    };
    // Nobody listening is the normal case; stay quiet and retry.
    ws.onerror = () => {};
  };

  const unsubscribe = navigation.subscribe(() => {
    const route = navigation.currentRoute()?.name;
    trace({ kind: 'route', route, path: navigation.path() });
    send({ event: 'navigation', route });
  });
  connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    socket?.close();
  };
};
