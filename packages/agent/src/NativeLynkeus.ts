import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * The native half: touches and keys synthesized inside the process, and a
 * hit test that tells which view a touch at a point would reach.
 *
 * Every method is compiled to a no-op outside debug builds (`#if DEBUG` on
 * iOS, `ApplicationInfo.FLAG_DEBUGGABLE` on Android); `isAvailable` says which
 * one you got.
 */
export interface Spec extends TurboModule {
  isAvailable(): boolean;
  /** A finger down at (x, y) for `holdMs` (a tap is ~50 ms, a long press ~600 ms). */
  tap(x: number, y: number, holdMs: number): Promise<boolean>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<boolean>;
  /** Inserts through the focused field's key input, so the app sees real key events. */
  typeText(text: string): Promise<boolean>;
  deleteBackward(count: number): Promise<boolean>;
  dismissKeyboard(): Promise<boolean>;
  /** The return key on the focused field: what fires onSubmitEditing. */
  submitEditing(): Promise<boolean>;
  /**
   * For each (xs[i], ys[i]), the React tags of the view a touch would reach
   * and of its ancestors, innermost first. Synchronous over JSI so a screen
   * snapshot resolves visibility in the same tick it reads the tree.
   * Returned as JSON (`number[][]`): codegen has no nested array type.
   */
  hitTest(xs: number[], ys: number[]): string;
  /**
   * Where each tag's native view stands in the window, in points, as JSON
   * (`([x, y, width, height] | null)[]`, null for a tag with no view). Android
   * answers; iOS returns `[]`, where the shadow tree already agrees with the views.
   */
  frames(tags: number[]): string;
}

export default TurboModuleRegistry.get<Spec>('Lynkeus');
