/**
 * An app running the agent. The screen is the React tree the app hands over and
 * touches are synthesized inside its process, so an action costs milliseconds;
 * only launching, screenshots and the status bar go through simctl or adb.
 */
import { AgentServer } from 'lynkeus-client';
import type { CoreMethods, Screen, TraceEvent } from 'lynkeus-protocol';

import { portFromEnv } from '../config.js';
import { withoutHost } from '../knowledge/problems.js';
import type { DeviceInfo } from './devices.js';
import { lifecycleFor, type PlatformLifecycle } from './platform.js';

export class Device {
  info: DeviceInfo;
  readonly server: AgentServer;

  #lifecycle: PlatformLifecycle;
  #appId: string | null;
  #resolving?: Promise<DeviceInfo>;

  constructor(info: DeviceInfo, options: { server?: AgentServer; appId?: string | null; resolving?: Promise<DeviceInfo> } = {}) {
    this.info = info;
    this.#resolving = options.resolving;
    // The app serves commands only to a driver that presents its token; without one, anything on the loopback could drive a dev build.
    this.server = options.server ?? new AgentServer({ token: process.env.LYNKEUS_TOKEN, port: portFromEnv() });
    this.#lifecycle = lifecycleFor(info.platform);
    this.#appId = options.appId ?? null;
  }

  /** The device as the OS knows it: reading the screen needs none of it; launching, screenshots and OS commands do. */
  async resolved(): Promise<DeviceInfo> {
    if (this.#resolving) {
      this.info = await this.#resolving;
      this.#resolving = undefined;
    }
    return this.info;
  }

  get appId(): string | null {
    return this.#appId;
  }

  async stop(): Promise<void> {
    await this.server.close();
  }

  async launchApp(appId: string, options: { fresh?: boolean } = {}): Promise<void> {
    this.#appId = appId;
    await this.server.listen();
    await this.#lifecycle.launchApp((await this.resolved()).id, appId, options.fresh ?? true);
    await this.server.waitForApp();
  }

  async openUrl(url: string): Promise<void> {
    await this.server.call('deepLink', { url });
  }

  /** Pins the clock, battery and radios so a pixel baseline survives the calendar. */
  async freezeChrome(): Promise<void> {
    await this.#lifecycle.freezeChrome((await this.resolved()).id);
  }

  async screenshot(destination: string): Promise<void> {
    await this.#lifecycle.screenshot((await this.resolved()).id, destination);
  }

  screen(): Promise<Screen> {
    return this.server.call('screen');
  }

  press(params: CoreMethods['press']['params']): Promise<CoreMethods['press']['result']> {
    return this.server.call('press', params);
  }

  type(params: CoreMethods['type']['params']): Promise<CoreMethods['type']['result']> {
    return this.server.call('type', params);
  }

  swipe(params: CoreMethods['swipe']['params']): Promise<CoreMethods['swipe']['result']> {
    return this.server.call('swipe', params);
  }

  back(): Promise<CoreMethods['back']['result']> {
    return this.server.call('back');
  }

  async navigate(name: string, params?: object): Promise<void> {
    await this.server.call('navigate', { name, params });
  }

  // The agent's own timeout governs; the transport waits a little longer so it hears the agent's answer.
  waitFor(params: CoreMethods['waitFor']['params']): Promise<CoreMethods['waitFor']['result']> {
    return this.server.call('waitFor', params, (params.timeoutMs ?? 5000) + 2000);
  }

  idle(params?: CoreMethods['idle']['params']): Promise<CoreMethods['idle']['result']> {
    return this.server.call('idle', params, (params?.timeoutMs ?? 3000) + 2000);
  }

  requests(since?: number): Promise<CoreMethods['requests']['result']> {
    return this.server.call('requests', { since });
  }

  trace(since?: number): Promise<CoreMethods['trace']['result']> {
    return this.server.call('trace', { since });
  }

  /** A command the app registered with `qa.register`. */
  command<T = unknown>(name: string, params?: unknown): Promise<T> {
    return this.server.call<T>(name, params);
  }
}

const quote = (value: string) => JSON.stringify(value);

export const describeTrace = (events: TraceEvent[]): string => {
  if (events.length === 0) return '(no events)';
  const t0 = events[0]!.t;
  const rel = (t: number) => `+${String(t - t0).padStart(6)}ms`;
  return events
    .map((e) => {
      if (e.kind === 'route') return `${rel(e.t)}  route    ${e.route ?? '?'}  (${e.path.join(' > ')})`;
      if (e.kind === 'request')
        return `${rel(e.t)}  request  ${String(e.status ?? '…').padStart(3)} ${e.method.padEnd(5)} ${withoutHost(e.url)}${e.error ? `  (${e.error})` : ''}`;
      if (e.kind === 'stall')
        return `${rel(e.t)}  stall    render loop broken: ${e.renders} updates${e.component ? ` to ${e.component}` : ''} in ${e.windowMs}ms`;
      if (e.kind === 'touch')
        return `${rel(e.t)}  touch    ${e.testId ? `#${e.testId}` : e.text ? JSON.stringify(e.text) : `${e.x},${e.y}`}  on ${e.route ?? '?'}`;
      if (e.kind === 'crash') return `${rel(e.t)}  crash    ${e.message}`;
      if (e.kind === 'event') return `${rel(e.t)}  event    ${e.name}${e.props ? ` ${JSON.stringify(e.props)}` : ''}`;
      if (e.kind === 'store')
        return `${rel(e.t)}  store    ${e.store}: ${Object.entries(e.changed)
          .map(([k, v]) => `${k} ${JSON.stringify(v.from)}→${JSON.stringify(v.to)}`)
          .join(', ')}`;
      return `${rel(e.t)}  command  ${e.method} ${e.ms}ms${e.error ? `  ✗ ${e.error}` : ''}`;
    })
    .join('\n');
};

type DescribeOptions = {
  limit?: number;
  /** Also what the platform is not presenting: behind a layer, out of the accessibility tree. */
  all?: boolean;
  /** Each element's centre, in points. */
  frames?: boolean;
  /** The commit count and the read's cost in the header. */
  verbose?: boolean;
};

export const describeScreen = (screen: Screen, options: DescribeOptions = {}): string => {
  const { limit = 80, all = false, frames = false, verbose = false } = options;
  const layer = screen.presenting ? ` +${screen.presenting.modal ? 'modal' : 'overlay'}${screen.presenting.testId ? `#${screen.presenting.testId}` : ''}` : '';
  // Plain views are layout; one that names itself (a testID, a label) is content.
  const named = screen.elements.filter((e) => e.kind !== 'view' || e.accessibilityLabel !== undefined || e.testId !== undefined);
  // What sits inside a button is the button: its icon is not something else to read or press.
  const insideButton = (e: Screen['elements'][number]) => {
    for (let p = e.parent; p !== undefined; p = screen.elements[p]?.parent) if (screen.elements[p]?.kind === 'button') return true;
    return false;
  };
  // An inert control is still read, even though it cannot be touched.
  const listed = all ? named : named.filter((e) => (!e.hidden || e.hidden === 'inert') && !(e.kind === 'view' && insideButton(e)));
  const counts = new Map<string, number>();
  if (!all) for (const e of named) if (e.hidden && e.hidden !== 'inert') counts.set(e.hidden, (counts.get(e.hidden) ?? 0) + 1);
  const hiddenTotal = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const hiddenNote = hiddenTotal ? ` · ${hiddenTotal} hidden: ${[...counts].map(([reason, n]) => `${n} ${reason}`).join(', ')}` : '';
  const stats = verbose ? ` commit=${screen.commit}${screen.busy ? ' busy' : ''} ${screen.costMs}ms` : screen.busy ? ' busy' : '';
  // The path says which navigators hold the route; alone, it only repeats it.
  const trail = screen.path.join(' > ');
  const header = `${screen.route ?? '?'}${trail === screen.route ? '' : ` (${trail})`}${layer}${stats}${hiddenNote}`;
  // An index is how to point at what has no name of its own, or shares it: a control
  // with a testID nothing else carries is pointed at by that.
  const nameOf = (e: Screen['elements'][number]) => (e.testId ? `#${e.testId}` : (e.text ?? e.accessibilityLabel));
  const uses = new Map<string, number>();
  for (const e of listed) {
    const name = nameOf(e);
    if (name !== undefined) uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const lines = listed.slice(0, limit).map((e) => {
    const id = e.testId ? ` #${e.testId}` : '';
    const name = nameOf(e);
    const index = name !== undefined && uses.get(name) === 1 ? '' : `${e.i} `;
    // A label that only repeats the testID says nothing new.
    const label = (e.text ?? e.accessibilityLabel) === e.testId ? undefined : (e.text ?? e.accessibilityLabel);
    const value =
      e.kind === 'input'
        ? ` value=${quote(e.value ?? '')}${e.placeholder ? ` placeholder=${quote(e.placeholder)}` : ''}${e.focused ? ' *focused' : ''}`
        : e.value !== undefined
          ? ` value=${quote(e.value)}` // a QR's encoded string, say
          : '';
    const state = `${e.enabled ? '' : ' !disabled'}${e.covered ? ' ~covered' : ''}${e.hidden ? ` ~${e.hidden}` : ''}`;
    const at = frames ? ` @${Math.round(e.frame.x + e.frame.w / 2)},${Math.round(e.frame.y + e.frame.h / 2)}` : '';
    return `${index}${e.kind}${id}${label ? ` ${quote(label)}` : ''}${value}${state}${at}`;
  });
  const rest = listed.length - lines.length;
  return [header, ...lines, rest > 0 ? `… ${rest} more` : ''].filter(Boolean).join('\n');
};
