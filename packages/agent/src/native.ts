import NativeLynkeus, { type Spec } from './NativeLynkeus';

// Compiled in or out per build, so it cannot change while the process runs.
let availability: boolean | undefined;
const available = (): boolean => (availability ??= NativeLynkeus?.isAvailable() === true);

const ready = (): Spec => {
  if (!NativeLynkeus || !available()) {
    throw new Error('Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package');
  }
  return NativeLynkeus;
};

export const touch = {
  available,
  tap: (x: number, y: number, holdMs: number) => ready().tap(x, y, holdMs),
  swipe: (x1: number, y1: number, x2: number, y2: number, durationMs: number) => ready().swipe(x1, y1, x2, y2, durationMs),
  typeText: (text: string) => ready().typeText(text),
  deleteBackward: (count: number) => ready().deleteBackward(count),
  dismissKeyboard: () => ready().dismissKeyboard(),
  submitEditing: () => ready().submitEditing(),
  /** For each point, the tags of the view a touch there reaches and its ancestors; null without the native module. */
  /** Where each tag's native view stands in the window, null for a tag without one; null when the native side does not say. */
  frames: (tags: number[]): (number[] | null)[] | null => {
    // A build made before the native side learned this has no such method.
    if (!available() || tags.length === 0 || typeof ready().frames !== 'function') return null;
    const frames = JSON.parse(ready().frames(tags)) as (number[] | null)[];
    return frames.length === tags.length ? frames : null;
  },
  hitTest: (points: { x: number; y: number }[]): number[][] | null => {
    if (!available()) return null;
    const json = ready().hitTest(
      points.map((p) => p.x),
      points.map((p) => p.y),
    );
    return JSON.parse(json) as number[][];
  },
};
