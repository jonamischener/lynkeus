import type { NavigationAdapter } from './navigation';
import { event, observe, readEvents, readStores } from './observe';
import { readProfile } from './profile';

type Handler = (params: unknown) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler>();
// What every app answers until it registers its own.
const defaults = new Map<string, Handler>([
  ['events', readEvents],
  ['stores', readStores],
  ['profile', readProfile],
]);

const register = (name: string, handler: Handler): (() => void) => {
  if (!/^[a-zA-Z][\w.-]*$/.test(name)) throw new Error(`Invalid command name "${name}"`);
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
};

const commands = (): string[] => [...new Set([...handlers.keys(), ...defaults.keys()])].sort();

const get = (name: string): Handler | undefined => handlers.get(name) ?? defaults.get(name);

let navigation: NavigationAdapter | undefined;

/**
 * What the app adds to the agent: `qa.register(name, fn)` for commands only it
 * can run, `qa.observe(name, store)` to put a store in the trace, and
 * `qa.event(name, props)` from wherever it reports to its analytics.
 *
 * Two command names mean something to drivers: `reset` (leave the app as
 * freshly installed) and `busy` (true while its data layer has work in flight).
 */
export const qa = {
  register,
  unregister: (name: string): void => {
    handlers.delete(name);
  },
  commands,
  /** Remembered by <Lynkeus> even when the agent is disabled, so a host can read it after render. */
  setNavigation: (adapter: NavigationAdapter | undefined): void => {
    navigation = adapter;
  },
  observe,
  event,
};

const hostState: { claimed: boolean; started: boolean; onReset?: () => void | Promise<void> } = { claimed: false, started: false };

/**
 * For whatever speaks for the app instead of the agent's own socket: the
 * headless runner, a jest test.
 */
export const host = {
  /** Take over: <Lynkeus> and auto() will not open a socket. */
  claim: (): void => {
    hostState.claimed = true;
  },
  claimed: (): boolean => hostState.claimed,
  /** What a reset must do beyond the app's own `reset` command, such as remounting the tree. */
  onReset: (fn: (() => void | Promise<void>) | undefined): void => {
    hostState.onReset = fn;
  },
  runReset: (): void | Promise<void> => hostState.onReset?.(),
  navigation: (): NavigationAdapter | undefined => navigation,
  get,
  commands,
  /** Only one client per process: the first <Lynkeus>/auto() to start owns the socket. */
  start: (): boolean => {
    if (hostState.started) return false;
    hostState.started = true;
    return true;
  },
  stop: (): void => {
    hostState.started = false;
  },
};
