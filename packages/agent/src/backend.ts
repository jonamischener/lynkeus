import type { Element, Screen } from './protocol';

export type Snapshot = {
  elements: Element[];
  presenting?: Screen['presenting'];
};

/**
 * Where the app runs and how it is touched: the Fabric + native backend on a
 * device, the test renderer in a headless host. The handlers speak only this.
 */
export type Backend = {
  readonly name: string;
  /** True when presses are real synthesized touches rather than direct calls. */
  readonly native: boolean;
  snapshot(): Snapshot;
  commitCount(): number;
  window(): { w: number; h: number };
  press(element: Element, holdMs: number): Promise<void>;
  pressPoint(x: number, y: number, holdMs: number): Promise<void>;
  /** Straight to the element's onPress. */
  pressJs(element: Element): Promise<void>;
  /** Into the focused input; `target` was tapped just before when given. */
  typeText(text: string, target?: Element): Promise<void>;
  deleteBackward(count: number, target?: Element): Promise<void>;
  dismissKeyboard(): Promise<void>;
  /** The return key on the focused field (or `target`). */
  submit(target?: Element): Promise<void>;
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  /** Drive the element's own gesture handler with a pan of (dx, dy) points; without it, a real swipe is used. */
  swipeOn?(element: Element, dx: number, dy: number): Promise<void>;
  debug(params?: unknown): unknown;
};

export const centre = ({ frame }: Element): { x: number; y: number } => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });
