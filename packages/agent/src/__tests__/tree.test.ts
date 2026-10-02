import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Dimensions } from 'react-native';

import { snapshotElements } from '../tree';

type FakeFiber = {
  tag: number;
  type: unknown;
  stateNode: unknown;
  memoizedProps: unknown;
  child: FakeFiber | null;
  sibling: FakeFiber | null;
  return: FakeFiber | null;
};

const link = (parent: FakeFiber, children: FakeFiber[]) => {
  parent.child = children[0] ?? null;
  children.forEach((c, i) => {
    c.return = parent;
    c.sibling = children[i + 1] ?? null;
  });
  return parent;
};

let nextTag = 1;
const host = (type: string, props: Record<string, unknown>, frame: number[], children: FakeFiber[] = []): FakeFiber =>
  link(
    {
      tag: 5,
      type,
      stateNode: { node: frame, canonical: { nativeTag: nextTag++ } },
      memoizedProps: props,
      child: null,
      sibling: null,
      return: null,
    },
    children,
  );
const text = (value: string): FakeFiber => ({
  tag: 6,
  type: 'RCTRawText',
  stateNode: null,
  memoizedProps: value,
  child: null,
  sibling: null,
  return: null,
});
const composite = (children: FakeFiber[]): FakeFiber =>
  link({ tag: 0, type: () => null, stateNode: null, memoizedProps: {}, child: null, sibling: null, return: null }, children);

const g = globalThis as Record<string, unknown>;

describe('snapshotElements', () => {
  beforeEach(() => {
    nextTag = 1;
    g.nativeFabricUIManager = { getBoundingClientRect: (node: number[]) => node };
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.nativeFabricUIManager;
  });

  const install = (root: FakeFiber) => {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: { tag: 3, child: root, sibling: null } }]),
      onCommitFiberRoot: () => undefined,
    };
  };

  it('lists controls and text with labels, frames and tags, only on the active screen', () => {
    const screenA = host(
      'RNSScreen',
      { activityState: 0 },
      [0, 0, 400, 800],
      [host('RCTView', { testID: 'old-button', onClick: () => null }, [10, 10, 100, 40])],
    );
    const screenB = host(
      'RNSScreen',
      { activityState: 2 },
      [0, 0, 400, 800],
      [
        host('RCTView', { testID: 'go', onClick: () => null }, [10, 10, 100, 40], [host('RCTText', {}, [12, 12, 90, 20], [text('Go '), text('now')])]),
        host('RCTSinglelineTextInputView', { testID: 'secret', text: '1234', secureTextEntry: true }, [10, 60, 100, 40]),
        host('RCTText', {}, [10, 120, 200, 20], [text('Welcome')]),
        host('RCTView', {}, [0, 0, 0, 0]),
      ],
    );
    install(composite([host('RNSScreenStack', {}, [0, 0, 400, 800], [composite([screenA]), composite([screenB])])]));

    const { elements } = snapshotElements();
    expect(elements.map((e) => [e.kind, e.testId ?? e.text])).toEqual([
      ['button', 'go'],
      ['input', 'secret'],
      ['text', 'Welcome'],
    ]);
    const [button, input] = elements;
    expect(button?.text).toBe('Go now');
    expect(button?.frame).toEqual({ x: 10, y: 10, w: 100, h: 40 });
    expect(typeof button?.tag).toBe('number');
    expect(input?.value).toBe('••••');
  });

  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };
  const byTestId = (elements: ReturnType<typeof snapshotElements>['elements']) => Object.fromEntries(elements.map((e) => [e.testId ?? `#${e.i}`, e]));

  it('hides what a root layer with controls is covering', () => {
    const page = host('RCTView', {}, [0, 0, 400, 800], [host('RCTView', { testID: 'behind', onClick: () => null }, [10, 10, 100, 40])]);
    const sheet = host('RCTView', { style: fill }, [0, 0, 400, 800], [host('RCTView', { testID: 'key-1', onClick: () => null }, [10, 500, 60, 60])]);
    const toastHost = host('RCTView', { style: [fill] }, [0, 0, 400, 800]);
    install(composite([page, sheet, toastHost]));

    const { elements, presenting } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId.behind?.hidden).toBe('behind-overlay');
    expect(byId['key-1']?.hidden).toBeUndefined();
    expect(presenting?.modal).toBe(false);
  });

  it('takes a full-size layer that states no insets for a layer', () => {
    const sized = { position: 'absolute', width: '100%', height: '100%' };
    const page = host('RCTView', {}, [0, 0, 400, 800], [host('RCTView', { testID: 'underneath', onClick: () => null }, [10, 10, 100, 40])]);
    const lock = host('RCTView', { style: sized }, [0, 0, 400, 800], [host('RCTView', { testID: 'numpad-1', onClick: () => null }, [10, 500, 60, 60])]);
    install(composite([page, lock]));

    const { elements, presenting } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId.underneath?.hidden).toBe('behind-overlay');
    expect(byId['numpad-1']?.hidden).toBeUndefined();
    expect(presenting).toBeDefined();
  });

  it('does not take an overlay inside a control or a scroll view for a layer', () => {
    const page = host(
      'RCTView',
      {},
      [0, 0, 400, 800],
      [
        host('RCTView', { testID: 'still-here', onClick: () => null }, [10, 10, 100, 40]),
        host(
          'RCTScrollView',
          {},
          [0, 100, 400, 700],
          [
            host(
              'RCTView',
              { testID: 'card', onClick: () => null },
              [0, 100, 400, 200],
              [host('RCTView', { style: fill }, [0, 100, 400, 200], [host('RCTView', { testID: 'card-cta', onClick: () => null }, [10, 110, 80, 30])])],
            ),
          ],
        ),
      ],
    );
    install(composite([page]));

    const { elements, presenting } = snapshotElements();
    expect(presenting).toBeUndefined();
    expect(byTestId(elements)['still-here']?.hidden).toBeUndefined();
  });

  it('a modal beats an overlay, however late the overlay renders', () => {
    const modal = host(
      'RCTView',
      { accessibilityViewIsModal: true },
      [0, 0, 400, 800],
      [host('RCTView', { testID: 'confirm', onClick: () => null }, [10, 400, 100, 40])],
    );
    const banner = host('RCTView', { style: fill }, [0, 0, 400, 800], [host('RCTView', { testID: 'banner-cta', onClick: () => null }, [10, 10, 100, 40])]);
    install(composite([modal, banner]));

    const { elements, presenting } = snapshotElements();
    expect(presenting?.modal).toBe(true);
    expect(byTestId(elements)['banner-cta']?.hidden).toBe('behind-modal');
  });

  it('skips a subtree the platform is not rendering, and marks the ones it hides', () => {
    const pages = host(
      'RCTView',
      {},
      [0, 0, 400, 800],
      [
        host(
          'RCTView',
          { testID: 'page-1', style: { display: 'none' } },
          [0, 0, 400, 800],
          [host('RCTView', { testID: 'off-tab', onClick: () => null }, [10, 10, 100, 40])],
        ),
        host(
          'RCTView',
          { testID: 'page-2', 'aria-hidden': true },
          [0, 0, 400, 800],
          [host('RCTView', { testID: 'other-tab', onClick: () => null }, [10, 60, 100, 40])],
        ),
        host('RCTView', { testID: 'page-3', pointerEvents: 'none' }, [0, 0, 400, 800], [host('RCTText', {}, [10, 120, 200, 20], [text('readable')])]),
        host('RCTView', { testID: 'page-4' }, [0, 0, 400, 800], [host('RCTView', { testID: 'on-tab', onClick: () => null }, [10, 160, 100, 40])]),
      ],
    );
    install(composite([pages]));

    const { elements } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId['off-tab']).toBeUndefined();
    expect(byId['other-tab']?.hidden).toBe('a11y');
    expect(byId['page-3']?.hidden).toBe('inert');
    expect(byId['on-tab']?.hidden).toBeUndefined();
  });
});
