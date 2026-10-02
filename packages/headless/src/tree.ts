// The host-only tree React Native Testing Library 14 renders, typed
// structurally so the package does not depend on the renderer's types.
export type ReactTestInstance = {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly parent: ReactTestInstance | null;
  readonly children: (ReactTestInstance | string)[];
  readonly unstable_fiber?: Fiber | null;
};

export type Fiber = {
  type: unknown;
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
};

type Named = { displayName?: string; name?: string };

// forwardRef and memo keep the real component's name on `render` / `type`.
export const fiberName = (fiber: Fiber): string => {
  const t = fiber.type as (Named & { render?: Named; type?: Named }) | string | null;
  if (typeof t === 'string') return t;
  if (!t) return 'anonymous';
  return t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || 'anonymous';
};

export const textOf = (node: ReactTestInstance): string => {
  const parts: string[] = [];
  const visit = (n: ReactTestInstance | string) => {
    if (typeof n === 'string') parts.push(n);
    else for (const child of n.children) visit(child);
  };
  visit(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
};

// Stack and tab containers keep inactive screens mounted; the last child that
// is not an inactive RNSScreen is the one on top, as on a device.
export const topScreenChild = (container: ReactTestInstance): ReactTestInstance | null => {
  let top: ReactTestInstance | null = null;
  for (const child of container.children) {
    if (typeof child !== 'string' && (child.type !== 'RNSScreen' || child.props.activityState !== 0)) top = child;
  }
  return top;
};
