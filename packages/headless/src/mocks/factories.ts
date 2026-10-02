// Mock factories for driving a real app against a real backend in Node:
// storage that persists in memory, a client version above any server gate, a
// locale that resolves. They run inside `jest.doMock`, so `require` is jest's.
import type { ComponentType } from 'react';

import { onReset, resolvable } from '../runtime.js';

export type MockFactory = () => unknown;

type Host = ComponentType<Record<string, unknown>>;

const ui = () => {
  const React = require('react') as typeof import('react');
  const { View, Image } = require('react-native') as { View: Host; Image: Host };
  return { React, View, Image };
};

// The library's own stub is a proxy that never settles. Instances with the same
// id share their storage, as on a device.
export const mmkv: MockFactory = () => {
  type Value = string | number | boolean;
  const stores = new Map<string, Map<string, Value>>();
  onReset(() => {
    for (const store of stores.values()) store.clear();
  });
  class MMKV {
    private readonly m: Map<string, Value>;
    constructor(config?: { id?: string }) {
      const id = config?.id ?? 'mmkv.default';
      this.m = stores.get(id) ?? stores.set(id, new Map()).get(id)!;
    }
    set(key: string, value: Value) {
      this.m.set(key, value);
    }
    getString(key: string) {
      const v = this.m.get(key);
      return typeof v === 'string' ? v : undefined;
    }
    getNumber(key: string) {
      const v = this.m.get(key);
      return typeof v === 'number' ? v : undefined;
    }
    getBoolean(key: string) {
      const v = this.m.get(key);
      return typeof v === 'boolean' ? v : undefined;
    }
    contains(key: string) {
      return this.m.has(key);
    }
    delete(key: string) {
      this.m.delete(key);
    }
    getAllKeys() {
      return [...this.m.keys()];
    }
    clearAll() {
      this.m.clear();
    }
    addOnValueChangedListener() {
      return { remove: () => undefined };
    }
  }
  return { MMKV, useMMKV: (config?: { id?: string }) => new MMKV(config) };
};

export const keychain: MockFactory = () => {
  const store = new Map<string, { username: string; password: string }>();
  onReset(() => store.clear());
  const service = (o?: { service?: string }) => o?.service ?? 'default';
  return {
    ACCESSIBLE: {
      WHEN_UNLOCKED: 'WHEN_UNLOCKED',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
      AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    },
    ACCESS_CONTROL: { BIOMETRY_ANY: 'BIOMETRY_ANY', BIOMETRY_CURRENT_SET: 'BIOMETRY_CURRENT_SET' },
    setGenericPassword: async (username: string, password: string, o?: { service?: string }) => {
      store.set(service(o), { username, password });
      return { service: service(o), storage: 'memory' };
    },
    getGenericPassword: async (o?: { service?: string }) => store.get(service(o)) ?? false,
    resetGenericPassword: async (o?: { service?: string }) => store.delete(service(o)),
    getSupportedBiometryType: async () => null,
  };
};

export type DeviceVersion = { version?: string; build?: number; system?: string };

// Servers gate old binaries, and the library's own mock reports 0.0.0.
export const deviceInfo =
  ({ version = '9.9.9', build = 9999, system = 'iOS' }: DeviceVersion = {}): MockFactory =>
  () => {
    const overrides = {
      getVersion: () => version,
      getBuildNumber: () => String(build),
      getSystemName: () => system,
    };
    const libraryMock = 'react-native-device-info/jest/react-native-device-info-mock';
    if (resolvable(libraryMock)) {
      const base = require(libraryMock);
      return { ...(base.default ?? base), ...overrides };
    }
    return {
      ...overrides,
      getSystemVersion: () => '17.0',
      getModel: () => 'Simulator',
      getBrand: () => 'Apple',
      getDeviceId: () => 'sim',
      getBundleId: () => 'app.headless',
      getApplicationName: () => 'App',
      getUniqueId: async () => 'headless-unique-id',
      getUniqueIdSync: () => 'headless-unique-id',
      isEmulator: async () => true,
      isEmulatorSync: () => true,
      hasNotch: () => false,
      getDeviceType: () => 'Handset',
    };
  };

// SafeAreaProvider renders nothing until insets arrive; the library's own mock reports them at once.
export const safeAreaContext: MockFactory = () => {
  const libraryMock = 'react-native-safe-area-context/jest/mock';
  if (resolvable(libraryMock)) return require(libraryMock).default;
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    ...require('react-native-safe-area-context'),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: { insets, frame },
  };
};

export type LocaleDefault = { country?: string; languageTag?: string; languageCode?: string };

export const localize =
  ({ country = 'US', languageTag = 'en-US', languageCode = 'en' }: LocaleDefault = {}): MockFactory =>
  () => {
    // The real one answers with a tag the app supports (a plain 'fr' when that
    // is what it ships), never the device's own.
    const bestTag = (tags: string[]) => {
      const best = tags.find((t) => t === languageTag) ?? tags.find((t) => t.split('-')[0] === languageCode);
      return best ? { languageTag: best, isRTL: false } : undefined;
    };
    const api = {
      getCountry: () => country,
      getLocales: () => [{ countryCode: country, languageTag, languageCode, isRTL: false }],
      getNumberFormatSettings: () => ({ decimalSeparator: '.', groupingSeparator: ',' }),
      getCurrencies: () => ['USD'],
      getCalendar: () => 'gregorian',
      getTemperatureUnit: () => 'celsius',
      getTimeZone: () => 'America/New_York',
      uses24HourClock: () => false,
      usesMetricSystem: () => true,
      usesAutoDateAndTime: () => undefined,
      usesAutoTimeZone: () => undefined,
      findBestLanguageTag: bestTag,
      findBestAvailableLanguage: bestTag,
      addEventListener: () => ({ remove: () => undefined }),
      removeEventListener: () => undefined,
    };
    return { ...api, default: api };
  };

export const reanimated: MockFactory = () => require('react-native-reanimated/mock');

export const asyncStorage: MockFactory = () => require('@react-native-async-storage/async-storage/jest/async-storage-mock');

// Nothing installs the library's own mock, and under jest the real
// scheduleOnRN silently drops the function: every "when the animation
// finishes" callback routed through it never runs.
export const worklets: MockFactory = () => require('react-native-worklets/lib/module/mock');

// Tab views put every page inside a native pager, so without one no tab content
// exists. A class, because callers hand its ref to findNodeHandle.
export const pagerView: MockFactory = () => {
  const { React, View } = ui();
  type Props = {
    children?: React.ReactNode;
    initialPage?: number;
    onPageSelected?: (e: { nativeEvent: { position: number } }) => void;
    orientation?: 'horizontal' | 'vertical';
    style?: unknown;
  };
  class PagerView extends React.Component<Props, { page: number }> {
    state = { page: this.props.initialPage ?? 0 };
    setPage = (position: number) => {
      this.setState({ page: position });
      this.props.onPageSelected?.({ nativeEvent: { position } });
    };
    setPageWithoutAnimation = this.setPage;
    setScrollEnabled = () => undefined;
    render() {
      return React.createElement(
        View,
        { style: this.props.style, testID: 'pager-view', orientation: this.props.orientation },
        ...React.Children.toArray(this.props.children).map((child, i) =>
          React.createElement(View, { key: i, style: i === this.state.page ? undefined : { display: 'none' }, collapsable: false }, child),
        ),
      );
    }
  }
  return { __esModule: true, default: PagerView, PagerView };
};

export const video: MockFactory = () => {
  const { React, View } = ui();
  type Props = { style?: unknown; testID?: string; onLoad?: (e: unknown) => void; onReadyForDisplay?: () => void };
  class Video extends React.Component<Props> {
    componentDidMount() {
      this.props.onLoad?.({ duration: 1, naturalSize: { width: 1, height: 1 } });
      this.props.onReadyForDisplay?.();
    }
    // The whole imperative surface: one missing ref method throws where the
    // app catches nothing and takes the tree down.
    seek = () => undefined;
    pause = () => undefined;
    resume = () => undefined;
    setVolume = () => undefined;
    setFullScreen = () => undefined;
    setSource = () => undefined;
    save = async () => ({ uri: '' });
    restoreUserInterfaceForPictureInPictureStopCompleted = () => undefined;
    enterPictureInPicture = () => undefined;
    exitPictureInPicture = () => undefined;
    getCurrentPosition = async () => 0;
    presentFullscreenPlayer = () => undefined;
    dismissFullscreenPlayer = () => undefined;
    render() {
      return React.createElement(View, { style: this.props.style, testID: this.props.testID ?? 'video' });
    }
  }
  return { __esModule: true, default: Video, Video, ResizeMode: { CONTAIN: 'contain', COVER: 'cover', STRETCH: 'stretch' } };
};

export const fastImage: MockFactory = () => {
  const { React, Image } = ui();
  const FastImage = Object.assign((props: Record<string, unknown>) => React.createElement(Image, props), {
    resizeMode: { contain: 'contain', cover: 'cover', stretch: 'stretch', center: 'center' },
    priority: { low: 'low', normal: 'normal', high: 'high' },
    cacheControl: { immutable: 'immutable', web: 'web', cacheOnly: 'cacheOnly' },
    preload: () => undefined,
    clearMemoryCache: () => Promise.resolve(),
    clearDiskCache: () => Promise.resolve(),
  });
  return { __esModule: true, default: FastImage };
};

export type BiometricOutcome = 'success' | 'fail' | 'cancel';

// Available by default, as on any current phone: apps read the sensor once at
// start-up, before a case can speak. The `biometrics` command sets the rest.
export const sensor = {
  available: 'FaceID' as null | 'TouchID' | 'FaceID' | 'Biometrics',
  queue: [] as BiometricOutcome[],
  fallback: 'fail' as BiometricOutcome,
  prompts: 0,
  keys: false,
};

export const biometrics: MockFactory = () => {
  const prompt = () => {
    sensor.prompts += 1;
    const outcome = sensor.queue.shift() ?? sensor.fallback;
    return outcome === 'success' ? { success: true } : { success: false, error: outcome === 'cancel' ? 'User cancellation' : 'Authentication failed' };
  };
  class ReactNativeBiometrics {
    isSensorAvailable = () =>
      Promise.resolve(
        sensor.available
          ? { available: true, biometryType: sensor.available }
          : { available: false, error: 'headless: no sensor (lynkeus biometrics --available FaceID)' },
      );
    simplePrompt = () => Promise.resolve(prompt());
    createKeys = () => {
      sensor.keys = true;
      return Promise.resolve({ publicKey: 'headless-public-key' });
    };
    biometricKeysExist = () => Promise.resolve({ keysExist: sensor.keys });
    deleteKeys = () => {
      sensor.keys = false;
      return Promise.resolve({ keysDeleted: true });
    };
    createSignature = () => {
      const result = prompt();
      return Promise.resolve(result.success ? { success: true, signature: 'headless-signature' } : result);
    };
  }
  return { __esModule: true, default: ReactNativeBiometrics, BiometryTypes: { TouchID: 'TouchID', FaceID: 'FaceID', Biometrics: 'Biometrics' } };
};

type WebViewProps = {
  style?: unknown;
  testID?: string;
  source?: { uri?: string; html?: string };
  onMessage?: (e: { nativeEvent: { data: string; url?: string } }) => void;
  onLoadStart?: (e: unknown) => void;
  onLoadEnd?: (e: unknown) => void;
  onLoad?: (e: unknown) => void;
  onNavigationStateChange?: (e: { url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; title: string }) => void;
  onShouldStartLoadWithRequest?: (e: { url: string }) => boolean;
};

type CameraProps = {
  style?: unknown;
  testID?: string;
  isActive?: boolean;
  codeScanner?: { onCodeScanned?: (codes: Array<{ value: string; type: string; frame?: unknown }>, frame: unknown) => void };
  onInitialized?: () => void;
};

// Mounted newest last: the `webview` and `scan` commands drive the last one.
export const webviews: Array<{ props: WebViewProps }> = [];
export const cameras: Array<{ props: CameraProps }> = [];

const unmount = <T>(list: T[], item: T) => {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
};

// A WebView draws nothing under jest; the stub keeps the URL it was asked to
// load and lets the `webview` command push messages and navigations through.
export const webView: MockFactory = () => {
  const { React, View } = ui();
  class WebViewStub extends React.Component<WebViewProps> {
    componentDidMount() {
      webviews.push(this);
      const event = { nativeEvent: { url: this.props.source?.uri ?? '', loading: false, title: '', canGoBack: false, canGoForward: false } };
      setTimeout(() => {
        this.props.onLoadStart?.(event);
        this.props.onLoad?.(event);
        this.props.onLoadEnd?.(event);
      }, 0);
    }
    componentWillUnmount() {
      unmount(webviews, this);
    }
    injectJavaScript = () => undefined;
    postMessage = () => undefined;
    reload = () => undefined;
    goBack = () => undefined;
    render() {
      const uri = this.props.source?.uri ?? (this.props.source?.html ? 'about:html' : 'about:blank');
      return React.createElement(View, { style: this.props.style, testID: this.props.testID ?? 'webview', accessibilityLabel: `webview ${uri}` });
    }
  }
  return { __esModule: true, default: WebViewStub, WebView: WebViewStub };
};

// There is no lens to point at a code; the `scan` command hands the mounted
// camera's codeScanner the result, as the frame processor would.
export const visionCamera: MockFactory = () => {
  const { React, View } = ui();
  class CameraStub extends React.Component<CameraProps> {
    static requestCameraPermission = () => Promise.resolve('granted');
    static getCameraPermissionStatus = () => 'granted';
    static requestMicrophonePermission = () => Promise.resolve('granted');
    static getMicrophonePermissionStatus = () => 'granted';
    static getAvailableCameraDevices = () => [{ id: 'back', position: 'back', name: 'headless back camera' }];
    componentDidMount() {
      cameras.push(this);
      setTimeout(() => this.props.onInitialized?.(), 0);
    }
    componentWillUnmount() {
      unmount(cameras, this);
    }
    takePhoto = () => Promise.resolve({ path: '/tmp/headless-photo.jpg', width: 1, height: 1 });
    startRecording = () => undefined;
    stopRecording = () => Promise.resolve();
    focus = () => Promise.resolve();
    render() {
      // An overlay chain of percentages can resolve to 0×0, which is not listed:
      // the preview fills the window unless styled otherwise.
      const { Dimensions } = require('react-native') as { Dimensions: { get: (k: string) => { width: number; height: number } } };
      const { width, height } = Dimensions.get('window');
      return React.createElement(View, {
        style: [{ width, height }, this.props.style],
        testID: this.props.testID ?? 'camera',
        accessibilityLabel: `camera ${this.props.isActive === false ? 'inactive' : 'active'}`,
      });
    }
  }
  const device = { id: 'back', position: 'back', name: 'headless back camera', hasFlash: false, hasTorch: false, formats: [] };
  const permission = () => ({ hasPermission: true, requestPermission: () => Promise.resolve(true) });
  return {
    __esModule: true,
    Camera: CameraStub,
    useCameraDevice: () => device,
    useCameraDevices: () => [device],
    useCameraPermission: permission,
    useMicrophonePermission: permission,
    useCameraFormat: () => undefined,
    useFrameProcessor: () => undefined,
    useCodeScanner: (scanner: unknown) => scanner,
    runAsync: () => undefined,
    runAtTargetFps: () => undefined,
  };
};

export type PickedImage = { uri: string; fileName?: string; type?: string; width?: number; height?: number; fileSize?: number };

// What the next picks answer, set by the `gallery` command; null or nothing left means the user cancelled.
export const pickerQueue: Array<PickedImage | null> = [];

export const imagePicker: MockFactory = () => {
  const launch = (_options: unknown, callback?: (result: unknown) => void) => {
    const next = pickerQueue.shift();
    const result = next
      ? { didCancel: false, assets: [{ fileName: 'headless.png', type: 'image/png', width: 1, height: 1, fileSize: 68, ...next }] }
      : { didCancel: true, assets: [] };
    callback?.(result);
    return Promise.resolve(result);
  };
  return { __esModule: true, launchImageLibrary: launch, launchCamera: launch };
};

export const inAppReview: MockFactory = () => ({
  __esModule: true,
  default: { isAvailable: () => false, RequestInAppReview: () => Promise.resolve(false) },
});
