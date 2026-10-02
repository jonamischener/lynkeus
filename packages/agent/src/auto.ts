/**
 * Zero-touch mount. One line in the app's entry, before registerComponent:
 *
 *   import { auto } from 'lynkeus-agent/auto';
 *   auto({ token: process.env.LYNKEUS_TOKEN });
 *
 * The agent wraps the root component through AppRegistry and finds the app's
 * navigation container by itself. An app that also renders <Lynkeus> keeps
 * working: the first client to start owns the socket.
 */
import { Component, type ComponentType, createElement, Profiler, type ReactNode } from 'react';
import { AppRegistry, View } from 'react-native';

import { Lynkeus, type LynkeusProps } from './Lynkeus';
import { type ContainerRef, type NavigationAdapter, reactNavigationAdapter } from './navigation';
import { recordCommit } from './profile';
import { record } from './trace';

type Fiber = { child: Fiber | null; sibling: Fiber | null; memoizedProps?: { value?: unknown } };
type Root = ComponentType<{ children?: ReactNode }>;

const looksLikeContainer = (value: unknown): value is ContainerRef => {
  const v = value as Partial<ContainerRef> | null;
  return !!v && typeof v.getRootState === 'function' && typeof v.getCurrentRoute === 'function' && typeof v.addListener === 'function';
};

// The container's ref is the value of a context provider somewhere below the root.
const findContainer = (root: Fiber | null, budget = 20000): ContainerRef | undefined => {
  const stack: Fiber[] = root ? [root] : [];
  while (stack.length && budget-- > 0) {
    const fiber = stack.pop()!;
    const value = fiber.memoizedProps?.value;
    if (looksLikeContainer(value)) return value;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return undefined;
};

/**
 * Finds the container on demand, since the client reads its adapter once. A
 * host remount (reset) detaches the old container and the next call finds the new one.
 */
const lazyAdapter = () => {
  let inner: NavigationAdapter | undefined;
  let current: ContainerRef | undefined;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const resolve = (): NavigationAdapter | undefined => {
    const ref = inner ? undefined : api.locate?.();
    if (ref && ref !== current) {
      unsubscribe?.();
      current = ref;
      inner = reactNavigationAdapter(ref);
      unsubscribe = inner.subscribe(notify);
      notify();
    }
    return inner;
  };
  const required = (): NavigationAdapter => {
    const nav = resolve();
    if (!nav) throw new Error('Navigation container not found yet');
    return nav;
  };
  const api = {
    locate: undefined as (() => ContainerRef | undefined) | undefined,
    detach() {
      unsubscribe?.();
      unsubscribe = undefined;
      inner = undefined;
      current = undefined;
    },
    isReady: () => resolve()?.isReady() ?? false,
    currentRoute: () => resolve()?.currentRoute(),
    path: () => resolve()?.path() ?? [],
    navigate: (name: string, params?: object) => required().navigate(name, params),
    canGoBack: () => resolve()?.canGoBack() ?? false,
    goBack: () => required().goBack(),
    resetToRoot: () => resolve()?.resetToRoot?.(),
    resetTo: (name: string, params?: object) => resolve()?.resetTo?.(name, params),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      resolve();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return api;
};

const isControl = (kind: string) => kind === 'button' || kind === 'input' || kind === 'switch';

export type AutoOptions = Omit<LynkeusProps, 'navigation'> & {
  /** How often to look for the navigation container until it is found. Default 250 ms, for 20 s. */
  discoverEveryMs?: number;
};

let wrapper: Root | undefined;

export const auto = (options: AutoOptions = {}): void => {
  const enabled = options.enabled ?? __DEV__;
  if (!enabled || wrapper) return;
  const { discoverEveryMs = 250, ...agentProps } = options;
  const navigation = lazyAdapter();

  class QaRoot extends Component<{ children?: ReactNode }> {
    private timer: ReturnType<typeof setInterval> | null = null;
    private tries = 0;
    private find = (): ContainerRef | undefined => findContainer((this as unknown as { _reactInternals?: Fiber })._reactInternals ?? null);

    componentDidMount() {
      // This root is the live tree: whatever was attached before belongs to an unmounted one.
      navigation.detach();
      navigation.locate = this.find;
      // Find the container early so route events flow before any command asks for it.
      this.timer = setInterval(() => {
        if (navigation.isReady() || ++this.tries > 20000 / discoverEveryMs) this.stop();
      }, discoverEveryMs);
      navigation.isReady();
    }

    componentWillUnmount() {
      this.stop();
      if (navigation.locate === this.find) navigation.locate = undefined;
      navigation.detach();
    }

    private stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }

    // A person's touches go into the trace, resolved to the control under the finger, so
    // `lynkeus record` can turn a session into steps. Touch events bubble here from every descendant.
    private onTouchEnd = (e: { nativeEvent: { pageX: number; pageY: number } }) => {
      try {
        const { pageX: x, pageY: y } = e.nativeEvent;
        const { snapshotElements } = require('./tree') as typeof import('./tree');
        const hit = snapshotElements()
          .elements.filter(
            ({ kind, frame }) => isControl(kind) && frame.w > 0 && x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h,
          )
          .sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0];
        record({
          kind: 'touch',
          x: Math.round(x),
          y: Math.round(y),
          testId: hit?.testId,
          text: hit?.text ?? hit?.accessibilityLabel,
          route: navigation.currentRoute()?.name,
        });
      } catch {
        // A touch the trace cannot resolve is not worth breaking the app for.
      }
    };

    private onRender = (_id: string, _phase: string, actualDuration: number) => {
      recordCommit(actualDuration, navigation.currentRoute()?.name);
    };

    render() {
      return createElement(
        View,
        { style: { flex: 1 }, onTouchEnd: this.onTouchEnd },
        createElement(Profiler, { id: 'app', onRender: this.onRender }, this.props.children),
        createElement(Lynkeus, { ...agentProps, navigation, enabled }),
      );
    }
  }

  wrapper = QaRoot;
  const appRegistry = AppRegistry as typeof AppRegistry & {
    getWrapperComponentProvider?: () => ((appParams: unknown) => Root) | undefined;
  };
  const previous = appRegistry.getWrapperComponentProvider?.();
  AppRegistry.setWrapperComponentProvider((appParams) => {
    const Outer = previous?.(appParams);
    if (!Outer) return QaRoot;
    // Keep whatever wrapper the app (or another library) already installed.
    return (props: { children?: ReactNode }) => createElement(Outer, null, createElement(QaRoot, null, props.children));
  });
};

/** For hosts that render the app themselves: the root auto() installed, if any. */
export const autoWrapper = (): Root | undefined => wrapper;
