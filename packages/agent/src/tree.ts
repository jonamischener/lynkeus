import { Dimensions, Platform, TextInput } from 'react-native';

import { centre, type Snapshot } from './backend';
import { kindOf, SCREEN_CONTAINERS } from './hosts';
import { touch } from './native';
import { blocksTouches, isA11yHidden, isUnrendered, layerKindOf, opaqueContainer, resolvePresentation, type Layer } from './presentation';
import type { Element, Frame, HiddenReason } from './protocol';

/*
 * The screen as React knows it, in one tick: the fiber tree from the React
 * DevTools hook, measured through the Fabric shadow tree, with the platform's
 * hit test saying what a touch would reach.
 *
 * Coupled by design to React internals (fiber tags 5/6, the DevTools hook): a
 * React upgrade that changes them yields empty snapshots, not wrong ones, and
 * `debugTree()` reports what the walker can see.
 */

type Fiber = {
  tag: number;
  type: unknown;
  stateNode: unknown;
  memoizedProps: Record<string, unknown> | string | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
};

type DevToolsHook = {
  renderers: Map<number, unknown>;
  getFiberRoots: (rendererId: number) => Set<{ current: Fiber }>;
  onCommitFiberRoot: (...args: unknown[]) => unknown;
};

type HostInstance = {
  node?: unknown;
  canonical?: { publicInstance?: unknown; nativeTag?: number };
};

type FabricUIManager = {
  getBoundingClientRect: (node: unknown, includeTransform: boolean) => readonly [number, number, number, number];
};

const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

const globals = globalThis as Record<string, unknown>;
const hook = (): DevToolsHook | undefined => globals[HOOK_KEY] as DevToolsHook | undefined;
const fabric = (): FabricUIManager | undefined => globals.nativeFabricUIManager as FabricUIManager | undefined;

const rootFibers = (): Fiber[] => {
  const devtools = hook();
  if (!devtools) return [];
  const roots: Fiber[] = [];
  for (const id of devtools.renderers.keys()) {
    for (const root of devtools.getFiberRoots(id)) roots.push(root.current);
  }
  return roots;
};

const props = (fiber: Fiber): Record<string, unknown> => (typeof fiber.memoizedProps === 'object' && fiber.memoizedProps !== null ? fiber.memoizedProps : {});

const isEnabled = (p: Record<string, unknown>): boolean => {
  const state = p.accessibilityState as { disabled?: boolean } | undefined;
  if (state?.disabled) return false;
  return !(p.editable === false || p.disabled === true || p.enabled === false);
};

const instanceOf = (fiber: Fiber): HostInstance | null => fiber.stateNode as HostInstance | null;

// Synchronous, straight from the shadow tree: no bridge round trip per node.
const measure = (fiber: Fiber): Frame | undefined => {
  const instance = instanceOf(fiber);
  const manager = fabric();
  if (!instance?.node || !manager) return undefined;
  try {
    const [x, y, w, h] = manager.getBoundingClientRect(instance.node, true);
    return { x, y, w, h };
  } catch {
    return undefined;
  }
};

const gatherText = (fiber: Fiber | null, out: string[]): void => {
  for (let node = fiber; node; node = node.sibling) {
    if (node.tag === HOST_TEXT && typeof node.memoizedProps === 'string') {
      out.push(node.memoizedProps);
    } else {
      gatherText(node.child, out);
    }
  }
};

const textOf = (fiber: Fiber): string | undefined => {
  const parts: string[] = [];
  gatherText(fiber.child, parts);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 200) : undefined;
};

const firstHost = (fiber: Fiber | null): Fiber | null => {
  let node = fiber;
  while (node && node.tag !== HOST_COMPONENT && node.tag !== HOST_TEXT) {
    node = node.child;
  }
  return node;
};

// Stack and tab containers keep inactive screens mounted; the last child
// whose RNSScreen is still active is the one on top.
const topScreenChild = (container: Fiber): Fiber | null => {
  let top: Fiber | null = null;
  for (let child = container.child; child; child = child.sibling) {
    const host = firstHost(child);
    const isScreen = host?.tag === HOST_COMPONENT && host.type === 'RNSScreen';
    if (!isScreen || props(host).activityState !== 0) top = child;
  }
  return top;
};

const onScreen = (frame: Frame, window: { w: number; h: number }): boolean =>
  frame.w > 0 && frame.h > 0 && frame.x < window.w && frame.y < window.h && frame.x + frame.w > 0 && frame.y + frame.h > 0;

// Hidden elements cannot be reached anyway, so only presented controls are asked about.
const markCovered = (elements: Element[]): void => {
  const controls = elements.filter((e) => e.hidden === undefined && (e.kind === 'button' || e.kind === 'input') && e.tag !== undefined);
  if (controls.length === 0) return;
  const chains = touch.hitTest(controls.map(centre));
  if (!chains) return;
  controls.forEach((e, index) => {
    if (chains[index]?.includes(e.tag as number)) delete e.covered;
    else e.covered = true;
  });
};

/**
 * Moves each element to where its native view stands. An element with no view
 * of its own (flattened away) moves by what its nearest listed ancestor moved.
 */
export const moveToViews = (elements: Element[], frameOf: (tag: number) => number[] | null | undefined): void => {
  const moved = new Map<number, { dx: number; dy: number }>();
  for (const e of elements) {
    const frame = e.tag === undefined ? undefined : frameOf(e.tag);
    if (!frame) continue;
    const [x = 0, y = 0, w = 0, h = 0] = frame;
    moved.set(e.i, { dx: x - e.frame.x, dy: y - e.frame.y });
    e.frame = { x, y, w, h };
  }
  for (const e of elements) {
    if (moved.has(e.i)) continue;
    for (let parent = e.parent; parent !== undefined; parent = elements[parent]?.parent) {
      const by = moved.get(parent);
      if (by) {
        e.frame = { ...e.frame, x: e.frame.x + by.dx, y: e.frame.y + by.dy };
        break;
      }
    }
  }
};

// On Android a view can stand somewhere other than where the shadow tree puts
// it (a status bar lower, in an app that draws under it), and a touch goes to
// where the view is.
const placeAsViews = (elements: Element[]): void => {
  if (Platform.OS !== 'android') return;
  const tags = elements.flatMap((e) => (e.tag === undefined ? [] : [e.tag]));
  const frames = touch.frames(tags);
  if (!frames) return;
  const byTag = new Map(tags.map((tag, index) => [tag, frames[index]]));
  moveToViews(elements, (tag) => byTag.get(tag));
};

type Walk = {
  depth: number;
  inButton: boolean;
  owner?: number;
  hidden?: HiddenReason;
  /** Still a direct child of the app's root, so a full-size view is a layer. */
  rootAttached: boolean;
};

export const snapshotElements = (): Snapshot => {
  const { width, height } = Dimensions.get('window');
  const window = { w: width, h: height };
  const focusedInput = TextInput.State.currentlyFocusedInput();
  const elements: Element[] = [];
  const layers: Layer[] = [];

  const walkChildren = (parent: Fiber, at: Walk) => {
    for (let node = parent.child; node; node = node.sibling) walk(node, at);
  };

  const walk = (node: Fiber, at: Walk) => {
    if (node.tag !== HOST_COMPONENT) {
      walkChildren(node, at);
      return;
    }
    const name = String(node.type);
    const p = props(node);

    if (isUnrendered(name, p)) return;
    if (SCREEN_CONTAINERS.has(name)) {
      const top = topScreenChild(node);
      if (top) walk(top, at);
      return;
    }

    const hidden = at.hidden ?? (isA11yHidden(p) ? 'a11y' : blocksTouches(p) ? 'inert' : undefined);
    const layer = layerKindOf(name, p, at.rootAttached);
    const inside: Walk = {
      ...at,
      hidden,
      rootAttached: at.rootAttached && layer === null && !opaqueContainer(name, p),
    };

    const kind = kindOf(name, p);
    const testId = typeof p.testID === 'string' ? p.testID : undefined;
    const label = typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : undefined;
    const meaningful =
      layer !== null ||
      testId !== undefined ||
      label !== undefined ||
      kind === 'button' ||
      kind === 'input' ||
      kind === 'switch' ||
      (kind === 'text' && !at.inButton);

    if (!meaningful) {
      walkChildren(node, inside);
      return;
    }

    const frame = measure(node);
    if (!frame || !onScreen(frame, window)) {
      if (kind !== 'text') walkChildren(node, inside);
      return;
    }

    const element: Element = {
      i: elements.length,
      kind,
      frame,
      enabled: isEnabled(p),
      depth: at.depth,
      testId,
      accessibilityLabel: label,
      parent: at.owner,
      tag: instanceOf(node)?.canonical?.nativeTag,
      hidden,
    };
    if (kind === 'input') {
      const value = p.text ?? p.value ?? p.defaultValue;
      // A masked field stays masked here too: the agent learns the length, not the secret.
      if (typeof value === 'string' && value.length > 0) {
        element.value = p.secureTextEntry ? '•'.repeat(value.length) : value;
      }
      if (typeof p.placeholder === 'string') element.placeholder = p.placeholder;
      if (focusedInput && instanceOf(node)?.canonical?.publicInstance === focusedInput) element.focused = true;
    } else if (kind !== 'view') {
      element.text = textOf(node);
    }
    elements.push(element);
    if (layer) layers.push({ i: element.i, kind: layer, testId });

    // A button's text is its label, so its descendants are not listed again
    // unless they identify themselves.
    if (kind !== 'text') {
      walkChildren(node, {
        ...inside,
        depth: at.depth + 1,
        inButton: at.inButton || kind === 'button',
        owner: element.i,
      });
    }
  };

  for (const root of rootFibers()) {
    walkChildren(root, { depth: 0, inButton: false, rootAttached: true });
  }
  placeAsViews(elements);
  const presenting = resolvePresentation(elements, layers);
  markCovered(elements);
  return { elements, presenting };
};

type Pressable = {
  onPress?: (event: unknown) => void;
  onClick?: (event: unknown) => void;
};

// The nearest onPress/onClick at or above the host element with this testID.
export const pressHandlerFor = (testId: string): ((event: unknown) => void) | undefined => {
  let found = null as Fiber | null;
  const visit = (fiber: Fiber | null) => {
    for (let node = fiber; node && !found; node = node.sibling) {
      if (node.tag === HOST_COMPONENT && props(node).testID === testId) {
        found = node;
        return;
      }
      visit(node.child);
    }
  };
  for (const root of rootFibers()) {
    visit(root.child);
    if (found) break;
  }
  for (let node: Fiber | null = found; node; node = node.return) {
    const p = props(node) as Pressable;
    if (typeof p.onPress === 'function') return p.onPress;
    if (typeof p.onClick === 'function') return p.onClick;
  }
  return undefined;
};

let commits = 0;
let subscribed = false;

// React resolves `onCommitFiberRoot` on the hook at every commit, so wrapping
// it counts commits without depending on the hook's event names.
export const trackCommits = (): void => {
  if (subscribed) return;
  const devtools = hook();
  if (!devtools) return;
  const original = devtools.onCommitFiberRoot;
  if (typeof original !== 'function') return;
  devtools.onCommitFiberRoot = (...args) => {
    commits += 1;
    return original.apply(devtools, args);
  };
  subscribed = true;
};

export const commitCount = (): number => commits;

export const debugTree = () => {
  const roots = rootFibers();
  const hostTypes: Record<string, number> = {};
  let measurable = 0;
  let total = 0;
  const visit = (fiber: Fiber | null) => {
    for (let node = fiber; node; node = node.sibling) {
      if (node.tag === HOST_COMPONENT) {
        total += 1;
        const name = String(node.type);
        hostTypes[name] = (hostTypes[name] ?? 0) + 1;
        if (measure(node)) measurable += 1;
      }
      visit(node.child);
    }
  };
  for (const root of roots) visit(root.child);
  const { elements, presenting } = snapshotElements();
  const hiddenBy: Record<string, number> = {};
  for (const { hidden } of elements) if (hidden) hiddenBy[hidden] = (hiddenBy[hidden] ?? 0) + 1;
  return {
    hookPresent: hook() !== undefined,
    fabricPresent: fabric() !== undefined,
    nativePresent: touch.available(),
    roots: roots.length,
    hostNodes: total,
    measurable,
    hostTypes,
    presented: elements.filter((e) => e.hidden === undefined).length,
    hiddenBy,
    presenting,
  };
};
