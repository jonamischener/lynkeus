import type { ElementKind } from './protocol';

// Host component names on a device (Fabric) and under the test renderer, where
// the JS component name is the host type.
export const HOST_INPUT = new Set(['TextInput', 'RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput']);
export const HOST_TEXT = new Set(['Text', 'RCTText']);
export const HOST_SWITCH = new Set(['Switch', 'RCTSwitch', 'AndroidSwitch']);
export const HOST_SCROLL = new Set(['ScrollView', 'RCTScrollView']);
export const HOST_IMAGE = new Set(['Image', 'RCTImageView']);
export const SCREEN_CONTAINERS = new Set(['RNSScreenStack', 'RNSScreenContainer']);

// Pressability (Pressable, Touchable*) installs onClick; a bare responder
// handler is usually a scroll or keyboard-dismiss wrapper, not a button.
export const isPressable = (name: string, p: Record<string, unknown>): boolean =>
  name === 'RNGestureHandlerButton' || typeof p.onClick === 'function' || p.accessibilityRole === 'button' || p.role === 'button';

export const kindOf = (name: string, p: Record<string, unknown>, pressable = isPressable): ElementKind => {
  if (HOST_INPUT.has(name)) return 'input';
  if (pressable(name, p)) return 'button';
  if (HOST_TEXT.has(name)) return 'text';
  if (HOST_SCROLL.has(name)) return 'scroll';
  if (HOST_SWITCH.has(name)) return 'switch';
  if (HOST_IMAGE.has(name)) return 'image';
  return 'view';
};
