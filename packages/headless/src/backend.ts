import { Children } from 'react';
import { act, fireEvent } from '@testing-library/react-native';
import type { Backend, Element, HiddenReason, Snapshot } from 'lynkeus-agent';
import { HOST_SCROLL, HOST_TEXT, isPressable as isHostPressable, kindOf, SCREEN_CONTAINERS } from 'lynkeus-agent/hosts';
import {
  blocksTouches,
  flatStyle,
  isA11yHidden,
  isUnrendered,
  layerKindOf,
  opaqueContainer,
  resolvePresentation,
  type Layer,
} from 'lynkeus-agent/presentation';

import { computeLayout, type LayoutIndex, type Rect, type YogaModule } from './layout.js';
import { log } from './runtime.js';
import { fiberName, textOf, topScreenChild, type Fiber, type ReactTestInstance } from './tree.js';

type Point = { x: number; y: number };
type Handler = (event: unknown) => void;

// React Native's own components, which wrap a host without saying why it is there.
const RN_PRIMITIVES =
  /^(View|Text|TextInput|ScrollView|FlatList|VirtualizedList|Image|Pressable|Touchable\w*|Animated.*|AnimatedComponent|anonymous|ForwardRef.*)$/;

// The composite that owns onPress is not in RNTL's host tree; find it up the
// fiber chain as the device backend does, stopping at the next host above.
const pressHandlerOf = (instance: ReactTestInstance): Handler | undefined => {
  const own = instance.unstable_fiber ?? null;
  const chain: string[] = [];
  for (let fiber = own; fiber; fiber = fiber.return) {
    chain.push(fiberName(fiber));
    const onPress = fiber.memoizedProps?.onPress;
    if (typeof onPress === 'function') {
      log(`press: onPress on ${fiberName(fiber)} (chain ${chain.join(' < ')})`);
      return onPress as Handler;
    }
    if (fiber !== own && typeof fiber.type === 'string') break;
  }
  const p = instance.props;
  log(
    `press: no onPress in fiber chain ${chain.join(' < ') || '(no fiber)'}; own props ${Object.keys(p)
      .filter((k) => k.startsWith('on'))
      .join(',')}`,
  );
  if (typeof p.onPress === 'function') return p.onPress as Handler;
  if (typeof p.onClick === 'function') return p.onClick as Handler;
  return undefined;
};

// Under the test renderer Pressability also leaves the responder handlers on
// the host View, and a bare onPress means a mocked pressable.
const isPressable = (name: string, p: Record<string, unknown>): boolean =>
  isHostPressable(name, p) || typeof p.onPress === 'function' || typeof p.onResponderRelease === 'function';

const isEnabled = (p: Record<string, unknown>): boolean =>
  p.disabled !== true && p.editable !== false && !(p.accessibilityState as { disabled?: boolean } | undefined)?.disabled;

const isPager = (node: ReactTestInstance) => node.props.testID === 'pager-view';

const scrollsAlong = (node: ReactTestInstance, horizontal: boolean): boolean =>
  isPager(node) ? (node.props.orientation !== 'vertical') === horizontal : HOST_SCROLL.has(node.type) && (node.props.horizontal === true) === horizontal;

const contains = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

const centre = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

type Pager = { props: { children?: unknown }; state: { page: number }; setPage: (page: number) => void };

const pagerOf = (host: ReactTestInstance): Pager | undefined => {
  if (!isPager(host)) return undefined;
  for (let f = host.unstable_fiber ?? null; f; f = f.return) {
    const node = f.stateNode as Partial<Pager> | null;
    if (node && typeof node.setPage === 'function' && node.state) return node as Pager;
  }
  return undefined;
};

export type BackendOptions = {
  window?: { w: number; h: number };
  yoga?: YogaModule | null;
  /** Composites whose string `value` prop is what they draw (a QR, a barcode), listed as the element's value. Default /qr|barcode/i. */
  valueComponents?: RegExp;
  /** Controls whose contents change on their own, by testID: their text does not count as a commit. */
  live?: RegExp;
};

export const headlessBackend = (root: () => ReactTestInstance, options: BackendOptions = {}): Backend => {
  const { window = { w: 390, h: 844 }, yoga = null, valueComponents = /qr|barcode/i, live } = options;
  let instances: ReactTestInstance[] = [];
  let commits = 0;
  let lastShape = '';
  let layoutShape = '';
  let layoutRects: LayoutIndex | null = null;
  const scrollOffsets = new WeakMap<ReactTestInstance, Point>();
  let scrolled = false;

  let focused: ReactTestInstance | null = null;
  // A field under pointerEvents="none" is focused through its pressable; RNTL
  // drops events on it, so keys go straight to its onChangeText.
  let focusedInert = false;
  // Uncontrolled inputs keep what was typed to themselves.
  let typedSinceFocus = '';

  // The composite above a host that draws its `value` (a QR) hands it to its
  // first host only.
  const valueCarrier = (node: ReactTestInstance, claimed: Set<Fiber>): string | undefined => {
    for (let f = node.unstable_fiber?.return ?? null; f && typeof f.type !== 'string'; f = f.return) {
      const value = f.memoizedProps?.value;
      if (typeof value !== 'string' || claimed.has(f) || !valueComponents.test(fiberName(f))) continue;
      claimed.add(f);
      return value;
    }
    return undefined;
  };

  const scrolledBy = (instance: ReactTestInstance): Point => {
    const shift = { x: 0, y: 0 };
    if (!scrolled) return shift;
    for (let n = instance.parent; n; n = n.parent) {
      const offset = scrollOffsets.get(n);
      if (offset) {
        shift.x += offset.x;
        shift.y += offset.y;
      }
    }
    return shift;
  };

  // idle and waitFor poll every few tens of ms and Yoga is the expensive part,
  // so its rects are reused until the listed shape changes.
  const applyLayout = (elements: Element[], shape: string): void => {
    if (!yoga) return;
    if (shape !== layoutShape || !layoutRects) {
      try {
        layoutRects = computeLayout(yoga, root(), window);
      } catch {
        layoutRects = null;
      }
      layoutShape = shape;
    }
    const rects = layoutRects;
    if (!rects) return;
    // What Yoga could not place keeps its synthetic frame and stays out of
    // occlusion: a window-wide phantom would cover everything under it.
    const placed: boolean[] = [];
    for (const [i, element] of elements.entries()) {
      const instance = instances[i]!;
      const rect = rects.get(instance);
      if (!rect || (rect.w === 0 && rect.h === 0)) continue;
      const shift = scrolledBy(instance);
      element.frame = { x: Math.round(rect.x - shift.x), y: Math.round(rect.y - shift.y), w: Math.round(rect.w), h: Math.round(rect.h) };
      placed[i] = true;
    }
    for (const element of elements) {
      const c = centre(element.frame);
      if (c.x < 0 || c.y < 0 || c.x > window.w || c.y > window.h) element.offscreen = true;
    }
    // Elements are in pre-order, so an element's descendants are the run right
    // after it; whatever follows that run and is larger sits on top of it,
    // whatever its kind (a bottom sheet is a scroll view, a backdrop a button).
    const subtreeEnd = elements.map((e) => e.i);
    for (let i = elements.length - 1; i >= 0; i--) {
      const parent = elements[i]!.parent;
      if (parent !== undefined) subtreeEnd[parent] = Math.max(subtreeEnd[parent]!, subtreeEnd[i]!);
    }
    for (const element of elements) {
      const area = element.frame.w * element.frame.h;
      if (element.hidden || element.offscreen || !placed[element.i] || area === 0) continue;
      const c = centre(element.frame);
      for (let j = subtreeEnd[element.i]! + 1; j < elements.length; j++) {
        const other = elements[j]!;
        if (other.hidden || !placed[j] || other.frame.w * other.frame.h <= area) continue;
        if (contains(other.frame, c)) {
          element.covered = true;
          break;
        }
      }
    }
  };

  const snapshot = (): Snapshot => {
    const elements: Element[] = [];
    const layers: Layer[] = [];
    const claimed = new Set<Fiber>();
    instances = [];
    const walk = (node: ReactTestInstance, depth: number, parent: number | undefined, inherited: HiddenReason | undefined, rootAttached: boolean) => {
      const { type, props: p } = node;
      if (isUnrendered(type, p)) return;
      if (SCREEN_CONTAINERS.has(type)) {
        const top = topScreenChild(node);
        if (top) walk(top, depth, parent, inherited, rootAttached);
        return;
      }
      const hidden = inherited ?? (isA11yHidden(p) ? 'a11y' : blocksTouches(p) ? 'inert' : undefined);
      const layer = layerKindOf(type, p, rootAttached);
      const inside = rootAttached && layer === null && !opaqueContainer(type, p);
      const kind = kindOf(type, p, isPressable);
      const testId = typeof p.testID === 'string' ? p.testID : undefined;
      const label = typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : undefined;
      const value = valueCarrier(node, claimed);
      const listed =
        layer !== null ||
        value !== undefined ||
        testId !== undefined ||
        label !== undefined ||
        kind === 'button' ||
        kind === 'input' ||
        kind === 'switch' ||
        (kind === 'text' && elements[parent ?? -1]?.kind !== 'button');
      if (!listed) {
        for (const child of node.children) if (typeof child !== 'string') walk(child, depth, parent, hidden, inside);
        return;
      }
      const i = elements.length;
      const element: Element = {
        i,
        kind,
        // Without layout, a column in tree order keeps ordering and centres distinct.
        frame: { x: 0, y: i * 10, w: window.w, h: 10 },
        enabled: isEnabled(p),
        depth,
        testId,
        accessibilityLabel: label,
        parent,
        tag: i + 1,
        hidden,
      };
      if (value !== undefined) {
        element.kind = 'image';
        element.accessibilityLabel ??= 'qr';
        element.value = value;
      }
      if (kind === 'input') {
        const text = p.value ?? p.defaultValue;
        if (typeof text === 'string' && text.length > 0) element.value = p.secureTextEntry ? '•'.repeat(text.length) : text;
        if (typeof p.placeholder === 'string') element.placeholder = p.placeholder;
        if (focused === node) element.focused = true;
      } else if (kind !== 'view') {
        element.text = textOf(node) || undefined;
      }
      elements.push(element);
      instances.push(node);
      if (layer) layers.push({ i, kind: layer, testId });
      if (kind === 'text') return;
      for (const child of node.children) if (typeof child !== 'string') walk(child, depth + 1, i, hidden, inside);
    };
    walk(root(), 0, undefined, undefined, true);
    const presenting = resolvePresentation(elements, layers);
    // Commits are not observable from here; a changed tree is the next best
    // signal. A live control keeps its identity in the shape but not its
    // contents, or a ticking clock would never let the screen look idle.
    const shape = elements
      .map(
        (e) => `${e.kind}|${e.testId ?? ''}|${live && e.testId !== undefined && live.test(e.testId) ? '~' : `${e.text ?? ''}|${e.value ?? ''}`}|${e.enabled}`,
      )
      .join('\n');
    applyLayout(elements, shape);
    if (shape !== lastShape) {
      commits += 1;
      lastShape = shape;
    }
    return { elements, presenting };
  };

  const instanceFor = (element: Element) => {
    const instance = instances[element.i];
    if (!instance) throw new Error(`Element ${element.i} is gone; take a new screen`);
    return instance;
  };

  const focus = (instance: ReactTestInstance, inert: boolean) => {
    focused = instance;
    focusedInert = inert;
    typedSinceFocus = String(instance.props.value ?? '');
  };

  const focusedInput = (target?: Element): ReactTestInstance => {
    if (target?.kind === 'input' && target.hidden === 'inert') {
      const instance = instances[target.i];
      if (instance && instance !== focused) focus(instance, true);
    }
    if (!focused) throw new Error('No focused text input');
    return focused;
  };

  const currentValue = (input: ReactTestInstance) => (typeof input.props.value === 'string' ? input.props.value : typedSinceFocus);

  const edit = async (target: Element | undefined, change: (value: string) => string) => {
    const input = focusedInput(target);
    const next = change(currentValue(input));
    typedSinceFocus = next;
    const onChangeText = input.props.onChangeText as ((text: string) => void) | undefined;
    if (focusedInert && onChangeText) await act(() => onChangeText(next));
    else await fireEvent.changeText(input as never, next);
  };

  const press = async (element: Element) => {
    const instance = instanceFor(element);
    if (element.kind === 'input') {
      focus(instance, false);
      await fireEvent(instance as never, 'focus');
      return;
    }
    const handler = pressHandlerOf(instance);
    if (!handler) {
      await fireEvent.press(instance as never);
      return;
    }
    await act(() => {
      handler({ nativeEvent: { pageX: 0, pageY: 0, locationX: 0, locationY: 0, timestamp: Date.now() }, persist: () => undefined });
    });
  };

  // How far the content reaches along the scroll axis: the farthest edge of anything inside.
  const contentExtent = (scroller: ReactTestInstance, frame: Point, horizontal: boolean): number => {
    const rects = layoutRects;
    if (!rects) return Number.POSITIVE_INFINITY;
    let far = 0;
    const visit = (node: ReactTestInstance) => {
      const rect = rects.get(node);
      if (rect) far = Math.max(far, horizontal ? rect.x + rect.w - frame.x : rect.y + rect.h - frame.y);
      for (const child of node.children) if (typeof child !== 'string') visit(child);
    };
    for (const child of scroller.children) if (typeof child !== 'string') visit(child);
    return far;
  };

  // Estimated rects can run past the last page; a paged scroller ends where its pages do.
  const pageCount = (scroller: ReactTestInstance): number => {
    let node = scroller;
    while (node.children.length === 1 && typeof node.children[0] !== 'string') node = node.children[0]!;
    return Math.max(node.children.filter((c) => typeof c !== 'string').length, 1);
  };

  // The deepest scroller on the axis whose rect holds the point; without layout, the deepest mounted.
  const scrollerAt = (point: Point, horizontal: boolean): ReactTestInstance | undefined => {
    let found: ReactTestInstance | undefined;
    const visit = (node: ReactTestInstance) => {
      if (isUnrendered(node.type, node.props)) return;
      if (scrollsAlong(node, horizontal)) {
        const rect = layoutRects?.get(node);
        if (!rect || rect.w === 0 || rect.h === 0 || contains(rect, point)) found = node;
      }
      for (const child of node.children) if (typeof child !== 'string') visit(child);
    };
    visit(root());
    return found;
  };

  const turnPage = async (pager: Pager, delta: Point) => {
    const pages = Children.count(pager.props.children);
    const step = Math.abs(delta.x) >= Math.abs(delta.y) ? Math.sign(delta.x) : 0;
    const next = Math.min(Math.max(pager.state.page + step, 0), Math.max(pages - 1, 0));
    if (next === pager.state.page) return false;
    await act(() => pager.setPage(next));
    log(`swipe: pager page ${next}`);
    return true;
  };

  const scroll = async (node: ReactTestInstance, delta: Point) => {
    const horizontal = node.props.horizontal === true;
    const paged = Boolean(node.props.pagingEnabled);
    const rect = layoutRects?.get(node) ?? { x: 0, y: 0, w: window.w, h: window.h };
    const viewport = horizontal ? rect.w : rect.h;
    const extent = contentExtent(node, rect, horizontal);
    const content = paged && viewport > 0 ? Math.min(extent, pageCount(node) * viewport) : extent;
    const along = horizontal ? delta.x : delta.y;
    const offsets = scrollOffsets.get(node);
    const before = (horizontal ? offsets?.x : offsets?.y) ?? 0;
    const moved = paged && viewport > 0 ? (Math.round(before / viewport) + Math.sign(along)) * viewport : before + along;
    const offset = Math.min(Math.max(moved, 0), Math.max(content - viewport, 0));
    if (offset === before) return false;
    const contentOffset = horizontal ? { x: offset, y: 0 } : { x: 0, y: offset };
    scrollOffsets.set(node, contentOffset);
    scrolled = true;
    const nativeEvent = {
      contentOffset,
      contentSize: horizontal ? { width: content, height: rect.h } : { width: rect.w, height: content },
      layoutMeasurement: { width: rect.w, height: rect.h },
    };
    await act(async () => {
      for (const name of ['scrollBeginDrag', 'scroll', 'scrollEndDrag', 'momentumScrollEnd']) fireEvent(node as never, name, { nativeEvent });
    });
    log(`swipe: ${horizontal ? 'x' : 'y'} offset ${Math.round(before)} → ${Math.round(offset)}`);
    return true;
  };

  // A slider's label is usually a sibling of the knob its GestureDetector
  // wraps, and a v2 detector leaves nothing on the host: climb the fiber chain
  // and at each level search down for the nearest `gesture` prop.
  const gestureNear = (instance: ReactTestInstance): { gesture?: { toGestureArray?: () => unknown[] }; chain: string[] } => {
    const below = (start: Fiber): unknown => {
      const queue = [start];
      for (let budget = 400; queue.length && budget > 0; budget--) {
        const f = queue.shift()!;
        const gesture = f.memoizedProps?.gesture;
        if (gesture && typeof gesture === 'object') return gesture;
        for (let c = f.child; c; c = c.sibling) queue.push(c);
      }
      return undefined;
    };
    const chain: string[] = [];
    for (let fiber = instance.unstable_fiber ?? null; fiber && chain.length < 40; fiber = fiber.return) {
      chain.push(fiberName(fiber));
      const gesture = below(fiber);
      if (gesture) return { gesture, chain };
    }
    return { chain };
  };

  const debugElement = (testId: string | undefined, text: string | undefined) => {
    let found: ReactTestInstance | undefined;
    const find = (n: ReactTestInstance) => {
      if (found) return;
      if ((testId && n.props.testID === testId) || (text && HOST_TEXT.has(n.type) && textOf(n) === text)) {
        found = n;
        return;
      }
      for (const c of n.children) if (typeof c !== 'string') find(c);
    };
    find(root());
    if (!found) return { error: `no element with ${testId ? `testId ${testId}` : `text ${JSON.stringify(text)}`}` };
    const chain: unknown[] = [];
    for (let n: ReactTestInstance | null = found; n && chain.length < 16; n = n.parent) {
      const p = n.props;
      let owner = n.unstable_fiber?.return ?? null;
      while (owner && (typeof owner.type === 'string' || RN_PRIMITIVES.test(fiberName(owner)))) owner = owner.return;
      const style = flatStyle(p);
      chain.push({
        type: n.type,
        owner: owner ? fiberName(owner) : undefined,
        testId: p.testID,
        pointerEvents: p.pointerEvents ?? style.pointerEvents,
        ariaHidden: p['aria-hidden'] ?? p.accessibilityElementsHidden,
        props: Object.keys(p).filter((k) => k !== 'children' && k !== 'style'),
        style,
        contentContainerStyle: p.contentContainerStyle ? flatStyle({ style: p.contentContainerStyle }) : undefined,
      });
    }
    return { chain };
  };

  // The host tree cannot tell whether a provider or overlay is mounted at all;
  // the fiber tree, from the HostRoot up the first host, can.
  const debugTree = (childrenOfName: string | undefined, wanted: string | undefined) => {
    const r = root();
    const hostTypes: Record<string, number> = {};
    let nodes = 0;
    const visit = (n: ReactTestInstance, depth: number) => {
      if (depth > 60) return;
      nodes += 1;
      if (n.type) hostTypes[n.type] = (hostTypes[n.type] ?? 0) + 1;
      for (const child of n.children) if (typeof child !== 'string') visit(child, depth + 1);
    };
    visit(r, 0);
    // RNTL's container has no fiber of its own.
    const firstFiber = (n: ReactTestInstance): Fiber | null => {
      if (n.unstable_fiber) return n.unstable_fiber;
      for (const child of n.children) {
        const fiber = typeof child === 'string' ? null : firstFiber(child);
        if (fiber) return fiber;
      }
      return null;
    };
    let rootFiber = firstFiber(r);
    while (rootFiber?.return) rootFiber = rootFiber.return;

    const composites: Record<string, number> = {};
    let childrenOf: string[] | undefined;
    const stack: Fiber[] = rootFiber ? [rootFiber] : [];
    for (let budget = 40000; stack.length && budget > 0; budget--) {
      const f = stack.pop()!;
      const name = fiberName(f);
      if (f.type && typeof f.type !== 'string' && name !== 'anonymous') composites[name] = (composites[name] ?? 0) + 1;
      if (childrenOfName && !childrenOf && name === childrenOfName) {
        childrenOf = [];
        // One composite layer deeper, so a wrapper does not hide what it holds.
        for (let c = f.child; c; c = c.sibling) {
          const inner: string[] = [];
          for (let g = c.child; g; g = g.sibling) inner.push(fiberName(g));
          childrenOf.push(inner.length ? `${fiberName(c)} > [${inner.join(', ')}]` : fiberName(c));
        }
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    const ranked = Object.entries(composites);
    return {
      backend: 'headless',
      rootType: r.type,
      nodes,
      hostTypes,
      composites: Object.fromEntries(wanted ? ranked.filter(([name]) => new RegExp(wanted).test(name)) : ranked.sort((a, b) => b[1] - a[1]).slice(0, 25)),
      childrenOf,
      elements: instances.length,
      focused: focused?.type ?? null,
    };
  };

  return {
    name: 'headless',
    native: false,
    snapshot,
    commitCount: () => {
      snapshot();
      return commits;
    },
    window: () => window,
    press,
    pressPoint: async () => {
      throw new Error('Headless has no coordinates; press by testId or text');
    },
    pressJs: press,
    typeText: (chunk, target) => edit(target, (value) => value + chunk),
    deleteBackward: (count, target) => edit(target, (value) => value.slice(0, -count)),
    dismissKeyboard: async () => {
      if (focused) await fireEvent(focused as never, 'blur');
      focused = null;
    },
    submit: async (target) => {
      const input = focusedInput(target);
      await fireEvent(input as never, 'submitEditing', { nativeEvent: { text: currentValue(input) } });
    },
    // A finger across a scroller moves its content or turns a pager's page;
    // fire what the platform would and let the app's handlers decide.
    swipe: async (from, to) => {
      snapshot();
      const horizontal = Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);
      const target = scrollerAt(from, horizontal);
      if (!target) {
        log(`swipe: nothing scrolls under ${Math.round(from.x)},${Math.round(from.y)}`);
        return;
      }
      const delta = { x: from.x - to.x, y: from.y - to.y };
      // Estimated geometry can put the point on a scroller already at its edge; a finger there drags the one around it.
      for (let node: ReactTestInstance | null = target; node; node = node.parent) {
        if (!scrollsAlong(node, horizontal)) continue;
        const pager = pagerOf(node);
        if (pager ? await turnPage(pager, delta) : await scroll(node, delta)) return;
      }
      log('swipe: nothing moved');
    },
    // A slider or a sheet handle is a gesture-handler pan, driven through the
    // library's own jest utility with a synthetic event list.
    swipeOn: async (element, dx, dy) => {
      const { gesture, chain } = gestureNear(instanceFor(element));
      if (!gesture) throw new Error(`No GestureDetector near the element (searched around ${chain.join(' < ')})`);
      // A composed gesture (Race/Simultaneous) holds several; drive the first pan.
      const handlers = (gesture.toGestureArray?.() ?? [gesture]) as { handlerName?: string }[];
      const pan = handlers.find((h) => h.handlerName === 'PanGestureHandler') ?? handlers[0];
      let fireGestureHandler: (gesture: unknown, events: unknown[]) => void;
      let State: { BEGAN: number; ACTIVE: number; END: number };
      try {
        fireGestureHandler = require('react-native-gesture-handler/jest-utils').fireGestureHandler;
        State = require('react-native-gesture-handler').State;
      } catch {
        throw new Error('swipe on an element needs react-native-gesture-handler (its jest-utils drive the handler)');
      }
      const steps = 6;
      const events: unknown[] = [{ state: State.BEGAN, translationX: 0, translationY: 0 }];
      for (let i = 1; i <= steps; i++) {
        events.push({ state: State.ACTIVE, translationX: (dx * i) / steps, translationY: (dy * i) / steps, velocityX: dx, velocityY: dy });
      }
      events.push({ state: State.END, translationX: dx, translationY: dy });
      await act(() => {
        fireGestureHandler(pan, events);
      });
      log(`swipe: pan (${dx},${dy}) via ${pan?.handlerName ?? 'gesture'} found at ${chain[chain.length - 1]}`);
    },
    // A wrong frame traced to the style Yoga was given, or what is mounted at all.
    debug: (params?: unknown) => {
      const p = (params ?? {}) as { testId?: string; text?: string; childrenOf?: string; composites?: string };
      return p.testId || p.text ? debugElement(p.testId, p.text) : debugTree(p.childrenOf, p.composites);
    },
  };
};
