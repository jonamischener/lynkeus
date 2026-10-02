import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { type ComponentType, type ReactElement, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { render } from '@testing-library/react-native';
import { createHandlers, dispatch, noNavigation, type Element } from 'lynkeus-agent';

import { headlessBackend, type BackendOptions } from '../backend.js';
import { loadYoga, type YogaModule } from '../layout.js';
import { pagerView } from '../mocks/factories.js';
import type { ReactTestInstance } from '../tree.js';

const noop = () => undefined;

const mount = async (element: ReactElement, yoga: YogaModule | null = null, options: BackendOptions = {}) => {
  const rendered = await render(element);
  const backend = headlessBackend(() => rendered.container as unknown as ReactTestInstance, { yoga, ...options });
  return { rendered, backend, snapshot: () => backend.snapshot().elements };
};

const byTestId = (elements: Element[], testId: string): Element => {
  const found = elements.find((e) => e.testId === testId);
  if (!found) throw new Error(`no element with testId ${testId} in ${JSON.stringify(elements)}`);
  return found;
};

describe('headlessBackend snapshot', () => {
  it('lists a pressable as one button carrying its text', async () => {
    const { snapshot } = await mount(
      <Pressable testID="go" onPress={noop}>
        <Text>Go</Text>
      </Pressable>,
    );
    const elements = snapshot();
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ kind: 'button', testId: 'go', text: 'Go', enabled: true });
  });

  it('lists a text input with its value, placeholder and label', async () => {
    const { snapshot } = await mount(<TextInput accessibilityLabel="email" placeholder="Email" value="a@b.c" onChangeText={noop} />);
    expect(snapshot()[0]).toMatchObject({ kind: 'input', accessibilityLabel: 'email', placeholder: 'Email', value: 'a@b.c' });
  });

  it('masks the value of a secure input', async () => {
    const { snapshot } = await mount(<TextInput testID="secret" value="1234" secureTextEntry onChangeText={noop} />);
    expect(snapshot()[0]?.value).toBe('••••');
  });

  it('lists a text node as text', async () => {
    const { snapshot } = await mount(<Text>Hello there</Text>);
    expect(snapshot()[0]).toMatchObject({ kind: 'text', text: 'Hello there' });
  });

  it('lists a view only when it carries a testID or a label, as kind view', async () => {
    const { snapshot } = await mount(
      <View>
        <View testID="box" />
        <View accessibilityLabel="panel" />
        <View />
      </View>,
    );
    const elements = snapshot();
    expect(elements.map((e: Element) => [e.kind, e.testId ?? e.accessibilityLabel])).toEqual([
      ['view', 'box'],
      ['view', 'panel'],
    ]);
  });

  it('a disabled pressable is listed but not enabled', async () => {
    const { snapshot } = await mount(<Pressable testID="pay" onPress={noop} disabled />);
    expect(byTestId(snapshot(), 'pay').enabled).toBe(false);
  });

  it('keeps parent links between listed elements', async () => {
    const { snapshot } = await mount(
      <View testID="screen">
        <View testID="row">
          <Text>Label</Text>
        </View>
      </View>,
    );
    const elements = snapshot();
    expect(byTestId(elements, 'row').parent).toBe(byTestId(elements, 'screen').i);
    expect(elements.find((e: Element) => e.kind === 'text')?.parent).toBe(byTestId(elements, 'row').i);
  });

  it('without Yoga, frames form a column in tree order', async () => {
    const { snapshot } = await mount(
      <View>
        <Text>One</Text>
        <Text>Two</Text>
      </View>,
    );
    expect(snapshot().map((e: Element) => e.frame)).toEqual([
      { x: 0, y: 0, w: 390, h: 10 },
      { x: 0, y: 10, w: 390, h: 10 },
    ]);
  });

  it('commitCount grows only when the listed tree changes', async () => {
    const { rendered, backend } = await mount(<Text>One</Text>);
    expect(backend.commitCount()).toBe(1);
    expect(backend.commitCount()).toBe(1);
    await rendered.rerender(<Text>Two</Text>);
    expect(backend.commitCount()).toBe(2);
  });
});

describe('headlessBackend actions', () => {
  it('press fires the element onPress', async () => {
    const onPress = jest.fn();
    const { snapshot, backend } = await mount(<Pressable testID="go" onPress={onPress} />);
    await backend.press(byTestId(snapshot(), 'go'), 0);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('typing appends to the focused input through onChangeText', async () => {
    const onChangeText = jest.fn();
    const { snapshot, backend } = await mount(<TextInput testID="email" value="a" onChangeText={onChangeText} />);
    await backend.press(byTestId(snapshot(), 'email'), 0);
    expect(snapshot()[0]?.focused).toBe(true);
    await backend.typeText('b');
    expect(onChangeText).toHaveBeenLastCalledWith('ab');
  });

  it('debug names the component that blocks a touch above an element', async () => {
    const Locked = ({ children }: { children: ReactElement }) => <View pointerEvents="none">{children}</View>;
    const { backend } = await mount(
      <Locked>
        <Pressable testID="back" onPress={noop} />
      </Locked>,
    );
    const { chain } = backend.debug({ testId: 'back' }) as { chain: { owner?: string; pointerEvents?: string }[] };
    expect(chain.find((c) => c.pointerEvents === 'none')?.owner).toBe('Locked');
  });

  it('submit is the return key: onSubmitEditing with what was typed', async () => {
    const onSubmitEditing = jest.fn();
    const { snapshot, backend } = await mount(<TextInput testID="search" onSubmitEditing={onSubmitEditing} />);
    await backend.press(byTestId(snapshot(), 'search'), 0);
    await backend.typeText('ana');
    await backend.submit();
    expect(onSubmitEditing).toHaveBeenCalledWith(expect.objectContaining({ nativeEvent: { text: 'ana' } }));
  });

  it('deleteBackward removes from the end of what was typed', async () => {
    const onChangeText = jest.fn();
    const { snapshot, backend } = await mount(<TextInput testID="email" onChangeText={onChangeText} />);
    await backend.press(byTestId(snapshot(), 'email'), 0);
    await backend.typeText('abc');
    await backend.deleteBackward(2);
    expect(onChangeText).toHaveBeenLastCalledWith('a');
  });

  it('typing with nothing focused is refused', async () => {
    const { backend } = await mount(<TextInput testID="email" onChangeText={noop} />);
    await expect(backend.typeText('x')).rejects.toThrow(/No focused text input/);
  });

  it('a stale element is refused after the tree changed', async () => {
    const { rendered, snapshot, backend } = await mount(
      <View>
        <Pressable testID="a" onPress={noop} />
        <Pressable testID="b" onPress={noop} />
      </View>,
    );
    const b = byTestId(snapshot(), 'b');
    await rendered.rerender(<View />);
    snapshot();
    await expect(backend.press(b, 0)).rejects.toThrow(/is gone/);
  });
});

describe('headlessBackend with Yoga layout', () => {
  let yoga: YogaModule | null = null;

  beforeAll(async () => {
    yoga = await loadYoga(noop);
  });

  it('loads Yoga under jest', () => {
    expect(yoga).not.toBeNull();
  });

  it('places elements at real coordinates', async () => {
    const { snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <View testID="pay" style={{ width: 200, height: 50, marginTop: 20, marginLeft: 10 }} />
      </View>,
      yoga,
    );
    expect(byTestId(snapshot(), 'pay').frame).toEqual({ x: 10, y: 20, w: 200, h: 50 });
  });

  it('a swipe across a paged carousel turns its pages and frees the control it gates', async () => {
    const Carousel = () => {
      const [page, setPage] = useState(0);
      return (
        <View style={{ flex: 1 }}>
          <ScrollView
            horizontal
            pagingEnabled
            style={{ height: 300 }}
            onMomentumScrollEnd={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width))}
          >
            {[0, 1, 2].map((i) => (
              <View key={i} testID={`page-${i}`} style={{ width: 390, height: 300 }} />
            ))}
          </ScrollView>
          <View pointerEvents={page === 2 ? 'auto' : 'none'}>
            <Pressable testID="slide-to-confirm" style={{ width: 300, height: 60 }} onPress={noop} />
          </View>
        </View>
      );
    };
    const { backend, snapshot } = await mount(<Carousel />, yoga);
    expect(byTestId(snapshot(), 'slide-to-confirm').hidden).toBe('inert');

    const left = { from: { x: 300, y: 150 }, to: { x: 60, y: 150 } };
    await backend.swipe(left.from, left.to, 250);
    expect(byTestId(snapshot(), 'slide-to-confirm').hidden).toBe('inert');
    await backend.swipe(left.from, left.to, 250);
    expect(byTestId(snapshot(), 'slide-to-confirm').hidden).toBeUndefined();
    expect(byTestId(snapshot(), 'page-2').frame.x).toBe(0);
    expect(byTestId(snapshot(), 'page-0').offscreen).toBe(true);

    await backend.swipe(left.from, left.to, 250);
    expect(byTestId(snapshot(), 'slide-to-confirm').hidden).toBeUndefined();
  });

  it('a swipe across a pager turns its page and stops at the ends', async () => {
    const { PagerView } = pagerView() as {
      PagerView: ComponentType<{ children: ReactElement[]; style?: object; onPageSelected?: (e: { nativeEvent: { position: number } }) => void }>;
    };
    const selected: number[] = [];
    const { backend, snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <PagerView style={{ flex: 1 }} onPageSelected={(e) => selected.push(e.nativeEvent.position)}>
          <Text testID="first">First</Text>
          <Text testID="second">Second</Text>
        </PagerView>
      </View>,
      yoga,
    );
    expect(snapshot().some((e) => e.testId === 'second')).toBe(false);
    await backend.swipe({ x: 300, y: 100 }, { x: 60, y: 100 }, 250);
    expect(byTestId(snapshot(), 'second').text).toBe('Second');
    await backend.swipe({ x: 300, y: 100 }, { x: 60, y: 100 }, 250);
    await backend.swipe({ x: 60, y: 100 }, { x: 300, y: 100 }, 250);
    expect(selected).toEqual([1, 0]);
  });

  it('waits for a row far down a list by scrolling to it', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <ScrollView>
          {Array.from({ length: 30 }, (_, i) => (
            <Pressable key={i} testID={`row-${i}`} style={{ height: 100 }} onPress={noop} />
          ))}
        </ScrollView>
      </View>,
      yoga,
    );
    const handlers = createHandlers(noNavigation, backend);
    await dispatch(handlers, 'waitFor', { target: { testId: 'row-25' }, scroll: true, timeoutMs: 10000 });
    const row = byTestId(backend.snapshot().elements, 'row-25');
    expect(row.frame.y).toBeGreaterThanOrEqual(0);
    expect(row.frame.y + row.frame.h / 2).toBeLessThanOrEqual(844);
  });

  it('looks for a target that is not mounted down to the end, then back up', async () => {
    // Rows mount only near the window, as a virtualized list does.
    const Windowed = () => {
      const [offset, setOffset] = useState(0);
      const first = Math.floor(offset / 100);
      return (
        <View style={{ flex: 1 }}>
          <ScrollView onScroll={(e) => setOffset(e.nativeEvent.contentOffset.y)}>
            <View style={{ height: 3000 }}>
              {Array.from({ length: 9 }, (_, i) => first + i)
                .filter((i) => i < 30)
                .map((i) => (
                  <Pressable key={i} testID={`row-${i}`} style={{ position: 'absolute', top: i * 100, height: 100, width: 390 }} onPress={noop} />
                ))}
            </View>
          </ScrollView>
        </View>
      );
    };
    const { backend } = await mount(<Windowed />, yoga);
    const handlers = createHandlers(noNavigation, backend);
    await dispatch(handlers, 'waitFor', { target: { testId: 'row-27' }, scroll: true, timeoutMs: 10000 });
    expect(backend.snapshot().elements.some((e) => e.testId === 'row-0')).toBe(false);
    await dispatch(handlers, 'waitFor', { target: { testId: 'row-0' }, scroll: true, timeoutMs: 10000 });
    expect(byTestId(backend.snapshot().elements, 'row-0').frame.y).toBeGreaterThanOrEqual(0);
    await expect(dispatch(handlers, 'waitFor', { target: { testId: 'row-99' }, scroll: true, timeoutMs: 3000 })).rejects.toThrow(/Timed out/);
  });

  it('sizes a percentage width and height against the parent', async () => {
    const { snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <View testID="half" style={{ width: '50%', height: '10%' }} />
      </View>,
      yoga,
    );
    expect(byTestId(snapshot(), 'half').frame).toMatchObject({ w: 195, h: 84 });
  });

  it('a later, larger sibling over an element marks it covered', async () => {
    const { snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="pay" style={{ width: 200, height: 50 }} onPress={noop} />
        <View testID="sheet" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      </View>,
      yoga,
    );
    const elements = snapshot();
    expect(byTestId(elements, 'pay').covered).toBe(true);
    expect(byTestId(elements, 'sheet').covered).toBeUndefined();
  });

  it('a later sibling that is smaller does not cover', async () => {
    const { snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="pay" style={{ width: 200, height: 50 }} onPress={noop} />
        <View testID="badge" style={{ position: 'absolute', top: 0, left: 0, width: 40, height: 40 }} />
      </View>,
      yoga,
    );
    expect(byTestId(snapshot(), 'pay').covered).toBeUndefined();
  });

  it('an ancestor never covers its own child', async () => {
    const { snapshot } = await mount(
      <View testID="screen" style={{ flex: 1 }}>
        <Pressable testID="pay" style={{ width: 200, height: 50 }} onPress={noop} />
      </View>,
      yoga,
    );
    expect(byTestId(snapshot(), 'pay').covered).toBeUndefined();
  });

  it('an element whose centre is outside the window is offscreen', async () => {
    const { snapshot } = await mount(
      <View style={{ flex: 1 }}>
        <View testID="far" style={{ position: 'absolute', top: 2000, width: 100, height: 100 }} />
      </View>,
      yoga,
    );
    expect(byTestId(snapshot(), 'far').offscreen).toBe(true);
  });
});

describe('headlessBackend value components', () => {
  const QRCode = (_: { value: unknown }) => <View testID="qr-host" />;
  const Header = (_: { value: string }) => <View testID="h" />;
  const TwoHosts = (_: { value: string }) => (
    <>
      <View testID="first" />
      <View testID="second" />
    </>
  );

  it('carries the value of a component matching the default /qr|barcode/i onto the host it renders', async () => {
    const { snapshot } = await mount(<QRCode value="pay:abc" />);
    expect(byTestId(snapshot(), 'qr-host')).toMatchObject({ kind: 'image', value: 'pay:abc', accessibilityLabel: 'qr' });
  });

  it('lists the host under a QR even when it has no testID or label', async () => {
    const Bare = (_: { value: string }) => <View />;
    const { snapshot } = await mount(<Bare value="pay:abc" />, null, { valueComponents: /bare/i });
    expect(snapshot()).toHaveLength(1);
  });

  it('gives the value to one host element only', async () => {
    const { snapshot } = await mount(<TwoHosts value="pay:abc" />, null, { valueComponents: /twohosts/i });
    const elements = snapshot();
    expect(byTestId(elements, 'first').value).toBe('pay:abc');
    expect(byTestId(elements, 'second').value).toBeUndefined();
  });

  it('ignores a component whose name does not match', async () => {
    const element = byTestId((await mount(<Header value="pay:abc" />)).snapshot(), 'h');
    expect(element.kind).toBe('view');
    expect(element.value).toBeUndefined();
  });

  it('valueComponents chooses which names carry their value', async () => {
    const { snapshot } = await mount(<Header value="pay:abc" />, null, { valueComponents: /header/i });
    expect(byTestId(snapshot(), 'h').value).toBe('pay:abc');
  });

  it('ignores a value that is not a string', async () => {
    expect(byTestId((await mount(<QRCode value={42} />)).snapshot(), 'qr-host').value).toBeUndefined();
  });
});

describe('headlessBackend presentation', () => {
  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

  it('hides the screen under a root layer that has controls of its own', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="behind" onPress={noop} />
        <View testID="sheet" style={fill}>
          <Pressable testID="inside" onPress={noop} />
        </View>
      </View>,
    );
    const { elements, presenting } = backend.snapshot();
    expect(byTestId(elements, 'behind').hidden).toBe('behind-overlay');
    expect(byTestId(elements, 'inside').hidden).toBeUndefined();
    expect(presenting?.testId).toBe('sheet');
  });

  it('leaves the screen alone when the layer holds nothing to press', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="behind" onPress={noop} />
        <View testID="toast" style={fill} />
      </View>,
    );
    const { elements, presenting } = backend.snapshot();
    expect(presenting).toBeUndefined();
    expect(byTestId(elements, 'behind').hidden).toBeUndefined();
  });

  it('skips a page the app is not rendering and marks the ones it hides', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <View testID="page-1" style={{ display: 'none' }}>
          <Pressable testID="off-tab" onPress={noop} />
        </View>
        <View testID="page-2" aria-hidden>
          <Pressable testID="other-tab" onPress={noop} />
        </View>
        <View testID="page-3">
          <Pressable testID="on-tab" onPress={noop} />
        </View>
      </View>,
    );
    const { elements } = backend.snapshot();
    expect(elements.find((e) => e.testId === 'off-tab')).toBeUndefined();
    expect(byTestId(elements, 'other-tab').hidden).toBe('a11y');
    expect(byTestId(elements, 'on-tab').hidden).toBeUndefined();
  });

  it('a hidden element is not a layer root a nested overlay can hide behind', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <Pressable testID="behind" onPress={noop} />
        <View testID="card" onTouchEnd={noop}>
          <View testID="card-overlay" style={fill}>
            <Pressable testID="card-cta" onPress={noop} />
          </View>
        </View>
      </View>,
    );
    const { elements, presenting } = backend.snapshot();
    expect(presenting).toBeUndefined();
    expect(byTestId(elements, 'behind').hidden).toBeUndefined();
  });

  it('a modal wins over a layer that renders after it', async () => {
    const { backend } = await mount(
      <View style={{ flex: 1 }}>
        <View testID="dialog" accessibilityViewIsModal>
          <Pressable testID="confirm" onPress={noop} />
        </View>
        <View testID="banner" style={fill}>
          <Pressable testID="banner-cta" onPress={noop} />
        </View>
      </View>,
    );
    const { elements, presenting } = backend.snapshot();
    expect(presenting?.modal).toBe(true);
    expect(byTestId(elements, 'banner-cta').hidden).toBe('behind-modal');
    expect(byTestId(elements, 'confirm').hidden).toBeUndefined();
  });
});
