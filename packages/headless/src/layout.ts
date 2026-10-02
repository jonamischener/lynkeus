// Approximate layout: a Yoga tree built from the host styles, with text sized
// from character counts. Not pixel-accurate, but enough to tell a button on
// screen from one off it or under an overlay.
import type { Node as YogaNode, Yoga as YogaModule } from 'yoga-layout/load';
import { HOST_IMAGE, HOST_INPUT, HOST_SCROLL, HOST_TEXT, SCREEN_CONTAINERS } from 'lynkeus-agent/hosts';
import { flatStyle, isUnrendered } from 'lynkeus-agent/presentation';

import { textOf, topScreenChild, type ReactTestInstance } from './tree.js';

export type Rect = { x: number; y: number; w: number; h: number };
export type LayoutIndex = Map<ReactTestInstance, Rect>;
export type { YogaModule };

type Style = Record<string, unknown>;

export const loadYoga = async (log: (line: string) => void): Promise<YogaModule | null> => {
  try {
    // yoga-layout ships ESM only and its Emscripten binary opens with
    // `import.meta.url`, which jest's CommonJS transform rejects. The wasm is
    // embedded and that url never read, so run the binary as a plain script in
    // Node's own context with the expression replaced, then hand it to the
    // package's wrapper, which jest transforms fine.
    const fs = require('node:fs') as typeof import('node:fs');
    const vm = require('node:vm') as typeof import('node:vm');
    const path = require('node:path') as typeof import('node:path');
    // The `exports` map exposes only `.` and `./load`: walk from the public entry.
    const dist = path.dirname(path.dirname(require.resolve('yoga-layout/load')));
    const binaryPath = path.join(dist, 'binaries', 'yoga-wasm-base64-esm.js');
    const source = fs
      .readFileSync(binaryPath, 'utf8')
      .replace('import.meta.url', "'file:///yoga'")
      .replace(/export default loadYoga;\s*$/, 'module.exports = loadYoga;');
    // WebAssembly is absent from this package's tsconfig lib.
    const g = globalThis as unknown as Record<string, unknown>;
    const sandbox = {
      module: { exports: {} as unknown },
      exports: {},
      setTimeout,
      clearTimeout,
      console,
      WebAssembly: g.WebAssembly,
      TextDecoder: g.TextDecoder,
      TextEncoder: g.TextEncoder,
      Buffer: g.Buffer,
      atob: g.atob,
      process,
    };
    vm.runInNewContext(source, sandbox, { filename: binaryPath });
    const loadYogaImpl = sandbox.module.exports as () => Promise<unknown>;
    const wrapAssembly = (require(path.join(dist, 'src', 'wrapAssembly.js')) as { default: (lib: unknown) => YogaModule }).default;
    return wrapAssembly(await loadYogaImpl());
  } catch (error) {
    log(`layout: yoga unavailable (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
    return null;
  }
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const dimension = (v: unknown): number | `${number}%` | undefined =>
  num(v) ?? (typeof v === 'string' && /^-?\d+(\.\d+)?%$/.test(v) ? (v as `${number}%`) : undefined);

const styleApplier = (Y: YogaModule) => {
  const FLEX_DIRECTION: Record<string, number> = {
    row: Y.FLEX_DIRECTION_ROW,
    'row-reverse': Y.FLEX_DIRECTION_ROW_REVERSE,
    column: Y.FLEX_DIRECTION_COLUMN,
    'column-reverse': Y.FLEX_DIRECTION_COLUMN_REVERSE,
  };
  const JUSTIFY: Record<string, number> = {
    'flex-start': Y.JUSTIFY_FLEX_START,
    'flex-end': Y.JUSTIFY_FLEX_END,
    center: Y.JUSTIFY_CENTER,
    'space-between': Y.JUSTIFY_SPACE_BETWEEN,
    'space-around': Y.JUSTIFY_SPACE_AROUND,
    'space-evenly': Y.JUSTIFY_SPACE_EVENLY,
  };
  const ALIGN: Record<string, number> = {
    'flex-start': Y.ALIGN_FLEX_START,
    'flex-end': Y.ALIGN_FLEX_END,
    center: Y.ALIGN_CENTER,
    stretch: Y.ALIGN_STRETCH,
    baseline: Y.ALIGN_BASELINE,
    auto: Y.ALIGN_AUTO,
  };
  const WRAP: Record<string, number> = { wrap: Y.WRAP_WRAP, nowrap: Y.WRAP_NO_WRAP, 'wrap-reverse': Y.WRAP_WRAP_REVERSE };
  const EDGES = [
    [Y.EDGE_TOP, 'Top', 'Vertical', 'top'],
    [Y.EDGE_BOTTOM, 'Bottom', 'Vertical', 'bottom'],
    [Y.EDGE_LEFT, 'Left', 'Horizontal', 'left'],
    [Y.EDGE_RIGHT, 'Right', 'Horizontal', 'right'],
  ] as const;

  const enumOf = (table: Record<string, number>, value: unknown) => (typeof value === 'string' ? table[value] : undefined);

  return (node: YogaNode, style: Style, instance: ReactTestInstance): void => {
    if (style.display === 'none') node.setDisplay(Y.DISPLAY_NONE);
    const direction = enumOf(FLEX_DIRECTION, style.flexDirection ?? 'column');
    if (direction !== undefined) node.setFlexDirection(direction);
    const justify = enumOf(JUSTIFY, style.justifyContent);
    if (justify !== undefined) node.setJustifyContent(justify);
    const alignItems = enumOf(ALIGN, style.alignItems);
    if (alignItems !== undefined) node.setAlignItems(alignItems);
    const alignSelf = enumOf(ALIGN, style.alignSelf);
    if (alignSelf !== undefined) node.setAlignSelf(alignSelf);
    const wrap = enumOf(WRAP, style.flexWrap);
    if (wrap !== undefined) node.setFlexWrap(wrap);

    const flex = num(style.flex);
    if (flex !== undefined) node.setFlex(flex);
    const grow = num(style.flexGrow);
    if (grow !== undefined) node.setFlexGrow(grow);
    const shrink = num(style.flexShrink);
    if (shrink !== undefined) node.setFlexShrink(shrink);
    const basis = num(style.flexBasis);
    if (basis !== undefined) node.setFlexBasis(basis);
    const width = dimension(style.width);
    if (width !== undefined) node.setWidth(width);
    const height = dimension(style.height);
    if (height !== undefined) node.setHeight(height);
    const minWidth = num(style.minWidth);
    if (minWidth !== undefined) node.setMinWidth(minWidth);
    const minHeight = num(style.minHeight);
    if (minHeight !== undefined) node.setMinHeight(minHeight);
    const maxWidth = num(style.maxWidth);
    if (maxWidth !== undefined) node.setMaxWidth(maxWidth);
    const maxHeight = num(style.maxHeight);
    if (maxHeight !== undefined) node.setMaxHeight(maxHeight);

    if (style.position === 'absolute') node.setPositionType(Y.POSITION_TYPE_ABSOLUTE);
    else if (style.position === 'relative') node.setPositionType(Y.POSITION_TYPE_RELATIVE);
    const border = num(style.borderWidth);
    for (const [edge, side, axis, position] of EDGES) {
      const margin = num(style[`margin${side}`]) ?? num(style[`margin${axis}`]) ?? num(style.margin);
      if (margin !== undefined) node.setMargin(edge, margin);
      const padding = num(style[`padding${side}`]) ?? num(style[`padding${axis}`]) ?? num(style.padding);
      if (padding !== undefined) node.setPadding(edge, padding);
      if (border !== undefined) node.setBorder(edge, border);
      const offset = num(style[position]);
      if (offset !== undefined) node.setPosition(edge, offset);
    }

    const isInput = HOST_INPUT.has(instance.type);
    if (isInput || HOST_TEXT.has(instance.type)) {
      const fontSize = num(style.fontSize) ?? (isInput ? 16 : 14);
      const lineHeight = num(style.lineHeight) ?? Math.round(fontSize * 1.3);
      const p = instance.props as { value?: string; placeholder?: string };
      const content = isInput ? String(p.value ?? p.placeholder ?? '') : textOf(instance);
      const intrinsic = Math.max(content.length, isInput ? 8 : 0) * fontSize * 0.55;
      const fixedHeight = num(style.height);
      node.setMeasureFunc((availableWidth, widthMode) => {
        const w = widthMode === Y.MEASURE_MODE_EXACTLY ? availableWidth : Math.min(intrinsic || availableWidth, availableWidth || intrinsic);
        const lines = w > 0 ? Math.max(1, Math.ceil(intrinsic / w)) : 1;
        return { width: Math.max(w, isInput ? 40 : 0), height: fixedHeight ?? lines * lineHeight };
      });
    } else if (HOST_IMAGE.has(instance.type) && num(style.width) === undefined && num(style.height) === undefined) {
      node.setWidth(0);
      node.setHeight(0);
    }
  };
};

const appliers = new WeakMap<YogaModule, ReturnType<typeof styleApplier>>();

type Box = { node: YogaNode; instance: ReactTestInstance; children: Box[] };

// Deeper than any real screen; a runaway tree must not blow the stack.
const MAX_DEPTH = 200;

// Absolute rects keyed by host instance, or null when the tree cannot be laid out.
export const computeLayout = (Y: YogaModule, rootInstance: ReactTestInstance, window: { w: number; h: number }): LayoutIndex | null => {
  let applyStyle = appliers.get(Y);
  if (!applyStyle) {
    applyStyle = styleApplier(Y);
    appliers.set(Y, applyStyle);
  }
  const created: YogaNode[] = [];

  const build = (instance: ReactTestInstance, depth: number, override?: Style): Box | null => {
    if (depth > MAX_DEPTH || isUnrendered(instance.type, instance.props)) return null;
    const node = Y.Node.create();
    created.push(node);
    const scroller = HOST_SCROLL.has(instance.type);
    // React Native's own base style: a scroller takes the space it is given, not its content's.
    const style = { ...(scroller ? { flexGrow: 1, flexShrink: 1 } : undefined), ...flatStyle(instance.props), ...override };
    try {
      applyStyle(node, style, instance);
    } catch {
      // A style that cannot be mapped must not sink the whole layout.
    }
    const box: Box = { node, instance, children: [] };
    // A node with a measure function cannot have children.
    if (HOST_TEXT.has(instance.type) || HOST_INPUT.has(instance.type)) return box;
    const contentStyle: Style | undefined = scroller && instance.props.horizontal ? { flexDirection: 'row', alignSelf: 'flex-start' } : undefined;
    const top = SCREEN_CONTAINERS.has(instance.type) ? topScreenChild(instance) : undefined;
    for (const child of top === undefined ? instance.children : top ? [top] : []) {
      if (typeof child === 'string') continue;
      const childBox = build(child, depth + 1, box.children.length === 0 ? contentStyle : undefined);
      if (!childBox) continue;
      node.insertChild(childBox.node, box.children.length);
      box.children.push(childBox);
    }
    return box;
  };

  try {
    const root = build(rootInstance, 0);
    if (!root) return null;
    root.node.setWidth(window.w);
    root.node.setHeight(window.h);
    // On a device the root view fills the window; RNTL's root has no size to
    // give, so unstyled provider wrappers under it would collapse to zero and
    // take every `flex: 1` screen with them.
    for (const child of root.children) {
      const style = flatStyle(child.instance.props);
      if (num(style.height) === undefined && num(style.flex) === undefined && num(style.flexGrow) === undefined) {
        child.node.setFlexGrow(1);
        child.node.setFlexShrink(1);
      }
    }
    root.node.calculateLayout(window.w, window.h, Y.DIRECTION_LTR);
    const rects: LayoutIndex = new Map();
    const place = (box: Box, offsetX: number, offsetY: number) => {
      const l = box.node.getComputedLayout();
      const x = offsetX + l.left;
      const y = offsetY + l.top;
      rects.set(box.instance, { x, y, w: l.width, h: l.height });
      for (const child of box.children) place(child, x, y);
    };
    place(root, 0, 0);
    root.node.freeRecursive();
    return rects;
  } catch {
    for (const node of created) {
      try {
        node.free();
      } catch {
        // already freed with its parent
      }
    }
    return null;
  }
};
