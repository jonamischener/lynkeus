/** JSON-RPC-shaped messages over a WebSocket the app opens towards the driver; docs/PROTOCOL.md has the prose. */
export const PROTOCOL_VERSION = 1;

export type Frame = { x: number; y: number; w: number; h: number };

export type ElementKind = 'button' | 'input' | 'text' | 'scroll' | 'switch' | 'image' | 'view';

/** Why an element is in the tree but not presented: structural, so a device and a host without layout agree. */
export type HiddenReason =
  /** Hidden from assistive technology, so it is not presented to anyone. */
  | 'a11y'
  /** `pointerEvents: 'none'` on it or an ancestor: no touch can reach it. */
  | 'inert'
  /** Outside the subtree that declared itself modal. */
  | 'behind-modal'
  /** Outside the last full-window layer the app mounted at its root. */
  | 'behind-overlay';

export type Element = {
  /** Position in tree order: later elements draw on top of earlier ones. */
  i: number;
  kind: ElementKind;
  frame: Frame;
  enabled: boolean;
  depth: number;
  testId?: string;
  /** Rendered text for `text` elements, or the label of a button/input. */
  text?: string;
  accessibilityLabel?: string;
  /** Masked (`•`) when the field is a secure entry. */
  value?: string;
  placeholder?: string;
  focused?: boolean;
  /** Index of the nearest listed ancestor, when there is one. */
  parent?: number;
  /** React native tag of the host view. */
  tag?: number;
  /** A touch at its centre would not reach it: something is on top. */
  covered?: boolean;
  /** Not presented at all, and why. A hidden element is not on screen. */
  hidden?: HiddenReason;
  /** Its rect lies outside the window: on screen only after scrolling. */
  offscreen?: boolean;
};

export type Screen = {
  route?: string;
  params?: unknown;
  /** Route names from the root navigator down to the focused screen. */
  path: string[];
  elements: Element[];
  /** React commits since the agent started; a change means the UI re-rendered. */
  commit: number;
  /** Requests in flight, plus whatever the app's `busy` command reports. */
  busy: boolean;
  window: { w: number; h: number };
  /** The layer on top, when the app is presenting one over its screen. */
  presenting?: { i: number; modal: boolean; testId?: string };
  /** Milliseconds spent building this snapshot inside the app. */
  costMs: number;
};

/** Where to look for a target: the element this names, then each container up from it, nearest first. */
export type Scope = { testId: string } | { text: string };
export type Target =
  | { testId: string; nth?: number; within?: Scope }
  | { text: string; nth?: number; within?: Scope }
  | { i: number }
  | { x: number; y: number };

export type PressOptions = {
  /** Finger-down time; a long press is ~600. Default 50. */
  holdMs?: number;
  /** `js` calls the element's onPress directly: no touch, no gesture, no animation wait. Needs a testId and an enabled, uncovered control. */
  mode?: 'native' | 'js';
};

export type SwipeParams = {
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Swipe on an element (a slider, a sheet handle) from its centre rather than across the window. */
  target?: Target;
  /** How far to move, in points; default 60% of the window's extent that way. */
  distance?: number;
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  durationMs?: number;
};

export type WaitForParams = {
  route?: string;
  target?: Target;
  /** Satisfied by whichever of these shows up first. */
  anyOf?: Target[];
  gone?: boolean;
  /** Swipe the nearest scrolling container towards the target until it is in the window. */
  scroll?: boolean;
  timeoutMs?: number;
};

export type TraceEvent = { seq: number; t: number } & (
  | { kind: 'route'; route?: string; path: string[] }
  | { kind: 'request'; method: string; url: string; status?: number; ms?: number; error?: string }
  | { kind: 'store'; store: string; changed: Record<string, { from: unknown; to: unknown }> }
  /** Something the app told its analytics, through `qa.event`. */
  | { kind: 'event'; name: string; props?: Record<string, unknown>; route?: string }
  | { kind: 'command'; method: string; ms: number; error?: string }
  /** The host broke a runaway render loop: `renders` updates in `windowMs`. */
  | { kind: 'stall'; renders: number; windowMs: number; component?: string }
  /** A finger on the screen (device builds mounted with `auto()`), resolved to the element under it. */
  | { kind: 'touch'; x: number; y: number; testId?: string; text?: string; route?: string }
  /** Something threw where nothing caught it, and the screen may be gone. */
  | { kind: 'crash'; message: string; stack?: string; route?: string }
);

export type RequestRecord = {
  id: number;
  method: string;
  url: string;
  status?: number;
  startedAt: number;
  ms?: number;
  error?: string;
};

/** Every method the core answers. Apps add their own through `qa.register`. */
export type CoreMethods = {
  ping: {
    params: undefined;
    result: { pong: true; native: boolean; commands: string[] };
  };
  screen: { params: undefined; result: Screen };
  find: { params: Target; result: Element | null };
  press: {
    params: Target & PressOptions;
    result: { x: number; y: number; element?: Element; mode: 'native' | 'js' };
  };
  type: {
    params: { text: string; target?: Target; clear?: boolean; paste?: boolean; submit?: boolean };
    result: { typed: string; element?: Element };
  };
  swipe: {
    params: SwipeParams;
    result: { from: { x: number; y: number }; to: { x: number; y: number } };
  };
  navigate: {
    params: { name: string; params?: object };
    result: { route: string };
  };
  back: { params: undefined; result: { route?: string } };
  waitFor: {
    params: WaitForParams;
    result: { route?: string; matched?: Target; waitedMs: number };
  };
  idle: {
    /** `after`: a commit count from before the awaited change; quiet only counts once the app has committed past it. */
    params: { quietMs?: number; timeoutMs?: number; after?: number } | undefined;
    result: { commit: number; idle: boolean };
  };
  deepLink: { params: { url: string }; result: { opened: string } };
  requests: {
    params: { since?: number } | undefined;
    result: { inFlight: number; requests: RequestRecord[] };
  };
  trace: {
    params: { since?: number } | undefined;
    result: { last: number; events: TraceEvent[] };
  };
  dismissKeyboard: { params: undefined; result: boolean };
  /** Several calls in one round trip, in order; stops at the first error. */
  batch: {
    params: { calls: { method: string; params?: unknown }[] };
    result: { results: unknown[] };
  };
};

export type Request = { id: number; method: string; params?: unknown };
export type Response = { id: number; result: unknown } | { id: number; error: { message: string; code?: string } };

export type HelloEvent = {
  event: 'hello';
  protocolVersion: number;
  platform: 'ios' | 'android' | string;
  native: boolean;
  commands: string[];
  route?: string;
  app?: Record<string, unknown>;
};
export type NavigationEvent = { event: 'navigation'; route?: string };
/** The driver's first message. `session` is random per driver process, so the app can tell a reconnect (whose resent requests it may have answered) from a new driver reusing request ids. */
export type AuthEvent = { event: 'auth'; session: string; token?: string };
export type AgentEvent = HelloEvent | NavigationEvent;

export * from './run.js';
