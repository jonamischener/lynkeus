import { Linking } from 'react-native';

import { type Backend, centre } from './backend';
import type { NavigationAdapter } from './navigation';
import type { CoreMethods, Element, PressOptions, Scope, Screen, Target } from './protocol';
import { host } from './registry';
import { recentRequests, requestsInFlight } from './requests';
import { lastSeq, traceSince } from './trace';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// How well an element answers a target: 0 = no, higher = better. Exact text
// on a control beats the same text in a paragraph, and a substring of a
// paragraph is no target at all: its centre lands on whatever word sits there.
export const score = (element: Element, target: Target): number => {
  if ('testId' in target) return element.testId === target.testId ? 4 : 0;
  if ('i' in target) return element.i === target.i ? 4 : 0;
  if (!('text' in target)) return 0;
  const needle = target.text.toLowerCase().trim();
  const haystacks = [element.text, element.accessibilityLabel].filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase().trim());
  const control = element.kind === 'button' || element.kind === 'input';
  if (haystacks.some((h) => h === needle)) return control ? 4 : 3;
  if (control && haystacks.some((h) => h.includes(needle))) return 2;
  return 0;
};

// Hidden belongs to another screen or to no one. An inert label inside a
// pressable is still readable, so it matches; it just cannot act.
const matchable = (e: Element) => !e.hidden || e.hidden === 'inert';

const insideOf = (elements: Element[], e: Element, ancestor: number): boolean => {
  for (let p = e.parent; p !== undefined; p = elements[p]?.parent) if (p === ancestor) return true;
  return false;
};

// Of several rows with a "like" button, the one that goes with a text shares
// the smallest container with it, and within that container is nearest to it.
const pickWithin = (elements: Element[], { within, ...target }: Target & { within: Scope }): Element | undefined => {
  const scope = pick(elements, within);
  if (!scope) return undefined;
  const matches = elements.filter((e) => matchable(e) && score(e, target as Target) > 0);
  const nth = 'nth' in target ? target.nth : undefined;
  let container: Element | undefined = scope;
  while (true) {
    const level: Element | undefined = container;
    const here = level ? matches.filter((e) => e.i === level.i || insideOf(elements, e, level.i)) : matches;
    if (here.length > 0) {
      if (nth !== undefined) return here[nth];
      return here.reduce((best, e) => {
        const d = Math.abs(e.i - scope.i);
        const b = Math.abs(best.i - scope.i);
        return d < b || (d === b && e.i > best.i) ? e : best;
      });
    }
    if (!level) return undefined;
    container = level.parent === undefined ? undefined : elements[level.parent];
  }
};

/**
 * Best match for a target. Reachable elements win; a covered one is returned
 * only when nothing reachable matches: an input under the pressable box that
 * focuses it is still on screen, and a tap at its centre reaches the box, as a
 * finger would. Ties go to the later element, which draws on top.
 */
export const pick = (elements: Element[], target: Target): Element | undefined => {
  if ('x' in target) return undefined;
  if ('within' in target && target.within) return pickWithin(elements, target as Target & { within: Scope });
  if ('nth' in target && target.nth !== undefined) return elements.filter((e) => matchable(e) && score(e, target) > 0)[target.nth];
  let best: Element | undefined;
  let bestRank = 0;
  for (const element of elements) {
    if (!matchable(element)) continue;
    const s = score(element, target);
    if (s === 0) continue;
    const rank = s + (element.covered ? 0 : 10) + (element.hidden === 'inert' ? 0 : 20);
    if (rank >= bestRank) {
      best = element;
      bestRank = rank;
    }
  }
  return best;
};

const describeTarget = (target: Target): string => JSON.stringify(target);

type Point = { x: number; y: number; element?: Element };

// Within a point is the same place: a breathing CTA is not a transition.
const sameFrame = (a: Element, b: Element) =>
  Math.abs(a.frame.x - b.frame.x) < 1 && Math.abs(a.frame.y - b.frame.y) < 1 && Math.abs(a.frame.w - b.frame.w) < 1 && Math.abs(a.frame.h - b.frame.h) < 1;

export type Handlers = {
  [M in keyof CoreMethods]: (params: CoreMethods[M]['params']) => CoreMethods[M]['result'] | Promise<CoreMethods[M]['result']>;
} & {
  debug: (params?: unknown) => unknown;
};

export const createHandlers = (navigation: NavigationAdapter, backend: Backend): Handlers => {
  const elements = () => backend.snapshot().elements;

  const busy = async (): Promise<boolean> => {
    if (requestsInFlight() > 0) return true;
    const custom = host.get('busy');
    if (!custom) return false;
    try {
      return (await custom(undefined)) === true;
    } catch {
      return false;
    }
  };

  const screen = async (): Promise<Screen> => {
    const started = Date.now();
    const { elements, presenting } = backend.snapshot();
    const route = navigation.currentRoute();
    return {
      route: route?.name,
      params: route?.params,
      path: navigation.path(),
      elements,
      commit: backend.commitCount(),
      busy: await busy(),
      window: backend.window(),
      presenting,
      costMs: Date.now() - started,
    };
  };

  const find = (target: Target): Element | null => pick(elements(), target) ?? null;

  const presented = (target: Target): Element => {
    const element = find(target);
    if (!element) throw new Error(`No element matches ${describeTarget(target)}`);
    if (element.hidden) throw new Error(`${describeTarget(target)} is not presented (${element.hidden})`);
    return element;
  };

  const pointOf = (target: Target): Point => {
    if ('x' in target) return { x: target.x, y: target.y };
    const element = presented(target);
    return { ...centre(element), element };
  };

  const inWindow = (e: Element) => {
    const { w, h } = backend.window();
    const { x, y } = centre(e);
    return !e.offscreen && x >= 0 && y >= 0 && x <= w && y <= h;
  };

  // An element still sliding in would be tapped where it was. Two identical
  // measurements 40 ms apart mean it has landed.
  const settled = async (target: Target, timeoutMs = 600): Promise<Point> => {
    const deadline = Date.now() + timeoutMs;
    let previous = pointOf(target);
    while (Date.now() < deadline) {
      await sleep(40);
      const current = pointOf(target);
      if (!current.element || (previous.element && sameFrame(current.element, previous.element))) return current;
      previous = current;
    }
    return previous;
  };

  const pressNative = async (target: Target, holdMs: number) => {
    let point = await settled(target);
    // With the keyboard up, a tap outside the field only dismisses it (the
    // scroll view swallows it): close it first and measure again once the layout moves back.
    if (point.element?.kind !== 'input' && elements().some((e) => e.focused)) {
      await backend.dismissKeyboard();
      await sleep(300);
      point = await settled(target);
    }
    if (point.element) await backend.press(point.element, holdMs);
    else await backend.pressPoint(point.x, point.y, holdMs);
    return { ...point, mode: 'native' as const };
  };

  // No touch, no gesture recogniser, no settle wait; but a disabled or covered
  // control stays unreachable, or the UI's own gates would mean nothing.
  const pressJs = async (target: Target) => {
    const element = presented(target);
    if (!element.enabled) throw new Error(`${describeTarget(target)} is disabled`);
    if (element.covered) throw new Error(`${describeTarget(target)} is covered`);
    await backend.pressJs(element);
    return { ...centre(element), element, mode: 'js' as const };
  };

  const press = async ({ mode, holdMs, ...rest }: Target & PressOptions) => {
    const target = rest as Target;
    if (mode === 'js') return pressJs(target);
    // A finger cannot reach what is outside the window, so bring it in first. A host's
    // geometry is only an estimate, so there the case has to ask for it (`wait --scroll`).
    const known = 'x' in target || !backend.native ? undefined : find(target);
    if (known && !known.hidden && !inWindow(known)) await waitFor({ target, scroll: true, timeoutMs: 5000 });
    return pressNative(target, holdMs ?? 50);
  };

  const type = async (params: CoreMethods['type']['params']) => {
    let element: Element | undefined;
    if (params.target) {
      const found = find(params.target);
      if (found?.kind === 'input' && found.hidden === 'inert') {
        element = found;
      } else {
        element = (await pressNative(params.target, 50)).element;
        // The keyboard needs a frame to attach to the field before it accepts input.
        await sleep(80);
      }
    }
    if (params.clear) {
      const current = elements().find((e) => e.focused)?.value ?? element?.value ?? '';
      if (current.length > 0) await backend.deleteBackward(current.length, element);
    }
    if (params.paste) {
      await backend.typeText(params.text, element);
    } else {
      // A controlled input formats on every change, and keys faster than a commit race the formatter.
      for (const char of params.text) {
        await backend.typeText(char, element);
        await sleep(25);
      }
    }
    if (params.submit) await backend.submit(element);
    return { typed: params.text, element };
  };

  const swipe = async (params: CoreMethods['swipe']['params']) => {
    const { w: width, h: height } = backend.window();
    const durationMs = params.durationMs ?? 250;
    if (params.target) {
      const element = presented(params.target);
      const direction = params.direction ?? 'up';
      const distance = params.distance ?? (direction === 'up' || direction === 'down' ? height : width) * 0.6;
      const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
      const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
      // A touch that leaves the window is cancelled: slide the whole drag back inside rather than cut it short.
      const inset = 8;
      const along = (start: number, delta: number, size: number) => Math.min(Math.max(start, inset - Math.min(delta, 0)), size - inset - Math.max(delta, 0));
      const middle = centre(element);
      const from = { x: along(middle.x, dx, width), y: along(middle.y, dy, height) };
      const to = { x: from.x + dx, y: from.y + dy };
      if (backend.swipeOn) await backend.swipeOn(element, dx, dy);
      else await backend.swipe(from, to, durationMs);
      return { from, to };
    }
    const presets = {
      up: { from: { x: width / 2, y: height * 0.7 }, to: { x: width / 2, y: height * 0.3 } },
      down: { from: { x: width / 2, y: height * 0.3 }, to: { x: width / 2, y: height * 0.7 } },
      left: { from: { x: width * 0.8, y: height / 2 }, to: { x: width * 0.2, y: height / 2 } },
      right: { from: { x: width * 0.2, y: height / 2 }, to: { x: width * 0.8, y: height / 2 } },
    };
    const preset = params.direction ? presets[params.direction] : undefined;
    const from = params.from ?? preset?.from;
    const to = params.to ?? preset?.to;
    if (!from || !to) throw new Error('swipe needs a direction, a target, or from/to points');
    await backend.swipe(from, to, durationMs);
    return { from, to };
  };

  // Towards an element that is known but outside the window, or onwards when it
  // has not rendered yet; over its own scroller when it has one.
  const swipeTowards = async (all: Element[], target: Element | undefined, back: boolean) => {
    const win = backend.window();
    let scroller: Element | undefined;
    for (let p = target?.parent; p !== undefined && !scroller; p = all[p]?.parent) if (all[p]?.kind === 'scroll') scroller = all[p];
    scroller ??= all.filter((e) => e.kind === 'scroll' && !e.hidden).sort((a, b) => b.frame.w * b.frame.h - a.frame.w * a.frame.h)[0];
    const box = scroller?.frame ?? { x: 0, y: 0, w: win.w, h: win.h };
    const left = Math.max(box.x, 0);
    const top = Math.max(box.y, 0);
    const right = Math.min(box.x + box.w, win.w);
    const bottom = Math.min(box.y + box.h, win.h);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const dx = (right - left) * 0.3;
    const dy = (bottom - top) * 0.3;
    const at = target ? centre(target) : undefined;
    // The finger travels along the target's own row or column: a drag anywhere
    // else on the scroller may belong to something else (a pager of tabs).
    if (at && (at.x < 0 || at.x > win.w) && at.y >= 0 && at.y <= win.h) {
      const forward = at.x > win.w;
      await backend.swipe({ x: cx + (forward ? dx : -dx), y: at.y }, { x: cx + (forward ? -dx : dx), y: at.y }, 250);
      return;
    }
    const up = at === undefined ? back : at.y < 0;
    const x = at === undefined ? cx : Math.min(Math.max(at.x, left + 1), right - 1);
    await backend.swipe({ x, y: cy + (up ? -dy : dy) }, { x, y: cy + (up ? dy : -dy) }, 250);
  };

  const waitFor = async (params: CoreMethods['waitFor']['params']) => {
    let swipes = 0;
    let lastSwipe = 0;
    // A target that is not mounted yet gives no direction: go down until the
    // list stops moving, then back up, and give up when that stops moving too.
    let back = false;
    let before = '';
    const shape = (all: Element[]) => all.map((e) => `${e.testId ?? e.text ?? ''}@${Math.round(e.frame.y)}`).join('|');
    const started = Date.now();
    const deadline = started + (params.timeoutMs ?? 5000);
    while (true) {
      const route = navigation.currentRoute()?.name;
      const routeOk = params.route === undefined || route === params.route;
      const all = params.target || params.anyOf ? elements() : [];
      const found = params.target ? pick(all, params.target) : undefined;
      const present = params.target ? found !== undefined && !(params.scroll && !inWindow(found)) : true;
      const targetOk = params.gone ? !present : present;
      const matched = params.anyOf?.find((t) => pick(all, t) !== undefined);
      const anyOk = !params.anyOf || matched !== undefined;
      if (routeOk && targetOk && anyOk) return { route, matched, waitedMs: Date.now() - started };
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${params.route ?? ''} ${params.target ? describeTarget(params.target) : ''}${params.gone ? ' to disappear' : ''} (on ${route})`,
        );
      }
      // A device scroller keeps moving after the finger lifts; a host's stops at once.
      if (params.scroll && params.target && !params.gone && swipes < 30 && Date.now() - lastSwipe > (backend.native ? 400 : 50)) {
        if (!found && swipes > 0 && shape(all) === before) {
          if (back) swipes = 30;
          back = true;
        }
        before = shape(all);
        await swipeTowards(all, found, back);
        swipes += 1;
        lastSwipe = Date.now();
        continue;
      }
      await sleep(40);
    }
  };

  // Gives up quietly: a screen with a ticking clock never settles, and that is information, not a failure.
  const idle = async (params: CoreMethods['idle']['params']) => {
    const quietMs = params?.quietMs ?? 150;
    const after = params?.after;
    const deadline = Date.now() + (params?.timeoutMs ?? 3000);
    let lastCommit = backend.commitCount();
    let quietSince = Date.now();
    let arrived = after === undefined || lastCommit > after;
    while (Date.now() < deadline) {
      await sleep(30);
      const commit = backend.commitCount();
      if (after !== undefined && commit > after) arrived = true;
      if (commit !== lastCommit || (await busy())) {
        lastCommit = commit;
        quietSince = Date.now();
      } else if (arrived && Date.now() - quietSince >= quietMs) {
        return { commit, idle: true };
      }
    }
    return { commit: backend.commitCount(), idle: false };
  };

  const handlers: Handlers = {
    ping: () => ({ pong: true, native: backend.native, commands: host.commands() }),
    screen,
    find,
    press,
    type,
    swipe,
    navigate: (params) => {
      navigation.navigate(params.name, params.params);
      return { route: params.name };
    },
    back: () => {
      if (!navigation.canGoBack()) throw new Error('Nothing to go back to');
      navigation.goBack();
      return { route: navigation.currentRoute()?.name };
    },
    waitFor,
    idle,
    deepLink: async (params) => {
      await Linking.openURL(params.url);
      return { opened: params.url };
    },
    requests: (params) => ({ inFlight: requestsInFlight(), requests: recentRequests(params?.since) }),
    trace: (params) => ({ last: lastSeq(), events: traceSince(params?.since) }),
    dismissKeyboard: async () => {
      await backend.dismissKeyboard();
      return true;
    },
    debug: (params) => backend.debug(params),
    batch: async (params) => {
      const results: unknown[] = [];
      for (const call of params.calls) results.push(await dispatch(handlers, call.method, call.params, navigation));
      return { results };
    },
  };
  return handlers;
};

/** Core methods first, then whatever the app registered. Unknown names fail loudly. */
export const dispatch = async (handlers: Handlers, method: string, params: unknown, navigation?: NavigationAdapter): Promise<unknown> => {
  const core = (handlers as Record<string, (p: unknown) => unknown>)[method];
  if (core) return (await core(params)) ?? null;
  const custom = host.get(method);
  // The app resets its own stores; the agent adds what only it reaches: the
  // host's mocked native state and the navigation stack.
  if (method === 'reset') {
    const result = custom ? ((await custom(params)) ?? null) : null;
    await host.runReset();
    navigation?.resetToRoot?.();
    return result;
  }
  if (custom) return (await custom(params)) ?? null;
  throw new Error(`Unknown method ${method}`);
};
