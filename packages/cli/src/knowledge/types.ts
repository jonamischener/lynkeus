/**
 * What lynkeus reads from an app's source. Facts are kept per file and
 * attributed to screens by traversal: most testIDs and navigations live in
 * shared components, so attributing them at extraction would always miss some.
 */

/** As declared to the navigator, e.g. `Settings.Profile`. */
export type RouteName = string;

/** Relative to the app's root. */
export type SourcePath = string;

/** A testID written as a literal; one built at runtime is only found on the device. */
export type Selector = { id: string; line: number };

/** What the user touches to cause a navigation. */
export type NavigationTrigger =
  | { kind: 'testId'; testId: string }
  /** The element has a testID built at runtime. */
  | { kind: 'dynamicTestId'; expression: string }
  /** Nothing to attribute it to: conditional routing, effects, deep links. */
  | { kind: 'unknown' };

export type NavigationEdge = {
  /** The route when it is a literal, otherwise the source expression. */
  to: string;
  line: number;
  confidence: 'static' | 'dynamic';
  via: NavigationTrigger;
  /** `element` when the call sits in the element's own handler, `handler` when it was reached through a named function. */
  linkage?: 'element' | 'handler';
};

export type FileFacts = {
  selectors: Selector[];
  navigates: NavigationEdge[];
  /** First-party imports; a name imported through a barrel points at the file that defines it. */
  imports: SourcePath[];
  /** The barrels those names came through: a dependency only when the barrel itself changes. */
  barrels?: SourcePath[];
};

export type ScreenNode = {
  route: RouteName;
  /** The component bound in the navigator. */
  component: string;
  /** Null when the component could not be resolved to a file. */
  file: SourcePath | null;
  declaredIn: SourcePath;
};

export type ScreenGraph = {
  app: string;
  root: string;
  extractedAt: string;
  screens: Record<RouteName, ScreenNode>;
  files: Record<SourcePath, FileFacts>;
  /** What could not be read, so the graph is never silently wrong. */
  warnings: string[];
};
