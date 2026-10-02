import type { Element, HiddenReason, Screen } from './protocol';

/*
 * What the platform is presenting, out of everything React keeps mounted (other
 * tabs, the screen under a sheet, a closed modal's host). A host has no layout,
 * so the signals are structural: props React Native, react-navigation and the
 * accessibility APIs set on the views. Both walkers, the fiber one on a device
 * and the test-renderer one in a host, call these, so they can only agree.
 */

type HostProps = Record<string, unknown>;
type Style = Record<string, unknown>;

export type Layer = { i: number; kind: 'modal' | 'overlay'; testId?: string };

const mergeStyle = (into: Style, value: unknown): Style => {
  if (Array.isArray(value)) {
    for (const item of value) mergeStyle(into, item);
  } else if (value && typeof value === 'object') {
    Object.assign(into, value);
  }
  return into;
};

export const flatStyle = (p: HostProps): Style => mergeStyle({}, p.style);

/** The platform draws nothing here, so there is no frame to report either. */
export const isUnrendered = (name: string, p: HostProps): boolean =>
  flatStyle(p).display === 'none' || (name === 'RNSScreen' && p.activityState === 0) || (name === 'RCTModalHostView' && p.visible === false);

export const isA11yHidden = (p: HostProps): boolean =>
  p['aria-hidden'] === true || p.accessibilityElementsHidden === true || p.importantForAccessibility === 'no-hide-descendants';

/** No touch can reach this subtree: unlike `box-none`, a child of `none` cannot opt back in. */
export const blocksTouches = (p: HostProps): boolean => p.pointerEvents === 'none' || flatStyle(p).pointerEvents === 'none';

const atMostZero = (value: unknown): boolean => typeof value === 'number' && value <= 0;

// An inset a style leaves out starts at the edge.
const absentOrAtMostZero = (value: unknown): boolean => value === undefined || atMostZero(value);

const fillsParent = (style: Style): boolean => {
  if (style.position !== 'absolute') return false;
  if ([style.top, style.left, style.right, style.bottom].every(atMostZero)) return true;
  // 100% by 100% covers it too when top and left leave it at the corner.
  return absentOrAtMostZero(style.top) && absentOrAtMostZero(style.left) && style.width === '100%' && style.height === '100%';
};

/** Something with an identity of its own: an overlay inside it belongs to it, not to the app's root. */
export const opaqueContainer = (name: string, p: HostProps): boolean =>
  typeof p.testID === 'string' ||
  typeof p.accessibilityLabel === 'string' ||
  typeof p.onClick === 'function' ||
  typeof p.onPress === 'function' ||
  name === 'RCTScrollView';

/**
 * The layer this host opens, if any. An overlay only counts at the root:
 * apps mount sheets and dialogs as a sibling of everything else, and a card's
 * own absolute fill is not a layer over the screen.
 */
export const layerKindOf = (name: string, p: HostProps, rootAttached: boolean): 'modal' | 'overlay' | null => {
  if (p.accessibilityViewIsModal === true || p['aria-modal'] === true || (name === 'RCTModalHostView' && p.visible !== false)) return 'modal';
  if (rootAttached && fillsParent(flatStyle(p))) return 'overlay';
  return null;
};

/** Marks everything outside the layer on top as hidden and returns that layer. */
export const resolvePresentation = (elements: Element[], layers: Layer[]): Screen['presenting'] => {
  if (layers.length === 0) return undefined;
  const byIndex = new Map(elements.map((e) => [e.i, e]));
  const descends = (element: Element, ancestor: number): boolean => {
    for (let at = element.parent; at !== undefined; at = byIndex.get(at)?.parent) {
      if (at === ancestor) return true;
    }
    return false;
  };

  const interactive = (e: Element) => e.enabled && e.hidden === undefined && (e.kind === 'button' || e.kind === 'input' || e.kind === 'switch');
  const outside = (e: Element, layer: Layer) => e.i !== layer.i && !descends(e, layer.i);

  const inhabited = layers.filter((layer) => {
    // A toast, a gradient or an empty portal host hides nothing.
    if (!elements.some((e) => interactive(e) && descends(e, layer.i))) return false;
    if (layer.kind === 'modal') return true;
    // An overlay covers what was drawn before it. The first full-window view
    // at the root is the app's own scene container, not something over it.
    return elements.some((e) => e.i < layer.i && interactive(e) && outside(e, layer));
  });
  // A sheet inside a modal is the modal's content, not a layer over it.
  const outermost = inhabited.filter((layer) => {
    const element = byIndex.get(layer.i);
    return !element || !inhabited.some((other) => other !== layer && descends(element, other.i));
  });
  if (outermost.length === 0) return undefined;

  const modals = outermost.filter((layer) => layer.kind === 'modal');
  const winner = (modals.length > 0 ? modals : outermost).reduce((a, b) => (b.i > a.i ? b : a));
  const reason: HiddenReason = winner.kind === 'modal' ? 'behind-modal' : 'behind-overlay';
  for (const element of elements) {
    if (element.hidden !== undefined || !outside(element, winner)) continue;
    // A modal declares everything else hidden; an overlay only covers what is
    // under it, and anything drawn after it is on top.
    if (winner.kind === 'modal' || element.i < winner.i) element.hidden = reason;
  }
  return { i: winner.i, modal: winner.kind === 'modal', testId: winner.testId };
};
