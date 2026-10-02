export type RouteInfo = { name: string; params?: unknown };

/** How the agent reads and drives the app's router; one ships for React Navigation. */
export type NavigationAdapter = {
  isReady(): boolean;
  currentRoute(): RouteInfo | undefined;
  /** Route names from the root navigator down to the focused screen. */
  path(): string[];
  navigate(name: string, params?: object): void;
  canGoBack(): boolean;
  goBack(): void;
  /** Back to the initial route; called on `reset`, so a host that does not relaunch the app starts each flow clean. */
  resetToRoot?(): void;
  /** Replace the whole stack with one route, as an app does after login. */
  resetTo?(name: string, params?: object): void;
  /** Called whenever the focused route may have changed; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
};

type NavState = { index: number; routes: { name: string; state?: unknown }[] };

export type ContainerRef = {
  isReady(): boolean;
  getCurrentRoute(): { name: string; params?: unknown } | undefined;
  getRootState(): NavState | undefined;
  navigate: (...args: never[]) => void;
  canGoBack(): boolean;
  goBack(): void;
  // `never` here, not `unknown`: parameters are contravariant, and the real
  // ref types its argument, so `unknown` would reject every actual ref.
  resetRoot?: (state?: never) => void;
  addListener(type: 'state', listener: () => void): unknown;
  removeListener(type: 'state', listener: () => void): void;
};

const routePath = (state: NavState | undefined): string[] => {
  const path: string[] = [];
  let current = state;
  while (current) {
    const route = current.routes[current.index];
    if (!route) break;
    path.push(route.name);
    current = route.state as NavState | undefined;
  }
  return path;
};

/** Adapter for a `NavigationContainer` ref from `@react-navigation/native`. */
export const reactNavigationAdapter = (ref: ContainerRef): NavigationAdapter => {
  // An app resets its own stack (after login, say), so routes[0] stops being the
  // initial route; remember it the first time the container is ready.
  let initialRoute: string | undefined;
  const rememberInitial = () => {
    if (initialRoute === undefined && ref.isReady()) initialRoute = ref.getRootState()?.routes?.[0]?.name;
  };
  return {
    isReady: () => {
      rememberInitial();
      return ref.isReady();
    },
    currentRoute: () => (ref.isReady() ? ref.getCurrentRoute() : undefined),
    path: () => (ref.isReady() ? routePath(ref.getRootState()) : []),
    navigate: (name, params) => (ref as unknown as { navigate: (n: string, p?: object) => void }).navigate(name, params),
    canGoBack: () => ref.isReady() && ref.canGoBack(),
    goBack: () => ref.goBack(),
    resetToRoot: () => {
      if (!ref.isReady() || !ref.resetRoot) return;
      rememberInitial();
      // Nested navigators re-initialise to their initial screens. resetRoot() without a state throws.
      const first = initialRoute ?? ref.getRootState()?.routes?.[0]?.name;
      if (first) (ref.resetRoot as unknown as (state: { index: number; routes: { name: string }[] }) => void)({ index: 0, routes: [{ name: first }] });
    },
    resetTo: (name, params) => {
      if (!ref.isReady() || !ref.resetRoot) return;
      (ref.resetRoot as unknown as (state: { index: number; routes: { name: string; params?: object }[] }) => void)({ index: 0, routes: [{ name, params }] });
    },
    subscribe: (listener) => {
      rememberInitial();
      const onState = () => {
        rememberInitial();
        listener();
      };
      ref.addListener('state', onState);
      return () => ref.removeListener('state', onState);
    },
  };
};

/** For apps without a router: the agent still reads and drives the screen. */
export const noNavigation: NavigationAdapter = {
  isReady: () => true,
  currentRoute: () => undefined,
  path: () => [],
  navigate: () => {
    throw new Error('No navigation adapter configured');
  },
  canGoBack: () => false,
  goBack: () => {
    throw new Error('No navigation adapter configured');
  },
  subscribe: () => () => {},
};
