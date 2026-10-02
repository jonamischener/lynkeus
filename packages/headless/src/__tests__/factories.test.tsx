import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ComponentType } from 'react';
import { host } from 'lynkeus-agent';
import { render } from '@testing-library/react-native';

import { installControls } from '../mocks/controls.js';
import { biometrics, cameras, imagePicker, pickerQueue, visionCamera } from '../mocks/factories.js';
import { reset } from '../runtime.js';

type Command = (params: unknown) => unknown;
const command = (name: string): Command => {
  const handler = host.get(name);
  if (!handler) throw new Error(`command "${name}" is not registered`);
  return handler as Command;
};

beforeAll(() => {
  installControls();
});

describe('biometrics', () => {
  type Sensor = {
    isSensorAvailable(): Promise<{ available: boolean; biometryType?: string }>;
    simplePrompt(): Promise<{ success: boolean; error?: string }>;
    createKeys(): Promise<unknown>;
    biometricKeysExist(): Promise<{ keysExist: boolean }>;
  };
  type State = { available: string | null; queue: string[]; fallback: string; prompts: number };
  let sensor: Sensor;
  const control = (params: unknown) => command('biometrics')(params) as State;

  beforeEach(() => {
    reset();
    const { default: ReactNativeBiometrics } = biometrics() as { default: new () => Sensor };
    sensor = new ReactNativeBiometrics();
  });

  it('reports FaceID by default', async () => {
    await expect(sensor.isSensorAvailable()).resolves.toEqual({ available: true, biometryType: 'FaceID' });
  });

  it('available none removes the sensor', async () => {
    control({ available: 'none' });
    await expect(sensor.isSensorAvailable()).resolves.toMatchObject({ available: false });
  });

  it('prompts answer the queued outcomes in order, then the fallback', async () => {
    control({ next: ['success', 'cancel'] });
    await expect(sensor.simplePrompt()).resolves.toEqual({ success: true });
    await expect(sensor.simplePrompt()).resolves.toEqual({ success: false, error: 'User cancellation' });
    await expect(sensor.simplePrompt()).resolves.toEqual({ success: false, error: 'Authentication failed' });
  });

  it('a single next outcome is queued like a list', async () => {
    control({ next: 'success' });
    expect(control({}).queue).toEqual(['success']);
    await expect(sensor.simplePrompt()).resolves.toEqual({ success: true });
  });

  it('the fallback can be made to succeed', async () => {
    control({ fallback: 'success' });
    await expect(sensor.simplePrompt()).resolves.toEqual({ success: true });
  });

  it('counts prompts, and a reset sets them, the queue and the fallback back', async () => {
    control({ next: ['success', 'success'], fallback: 'success' });
    await sensor.simplePrompt();
    expect(control({})).toMatchObject({ prompts: 1, queue: ['success'] });
    reset();
    expect(control({})).toMatchObject({ prompts: 0, queue: [], fallback: 'fail' });
    await expect(sensor.simplePrompt()).resolves.toMatchObject({ success: false });
  });

  it('keys exist once created and are gone after a reset', async () => {
    await expect(sensor.biometricKeysExist()).resolves.toEqual({ keysExist: false });
    await sensor.createKeys();
    await expect(sensor.biometricKeysExist()).resolves.toEqual({ keysExist: true });
    reset();
    await expect(sensor.biometricKeysExist()).resolves.toEqual({ keysExist: false });
  });
});

describe('visionCamera', () => {
  type CameraProps = { codeScanner?: unknown; isActive?: boolean; testID?: string };
  const { Camera } = visionCamera() as { Camera: ComponentType<CameraProps> };

  it('mounting a Camera registers it and unmounting removes it', async () => {
    const rendered = await render(<Camera />);
    expect(cameras).toHaveLength(1);
    await rendered.unmount();
    expect(cameras).toHaveLength(0);
  });

  it('the stub is on screen, labelled with whether the camera is active', async () => {
    const rendered = await render(<Camera isActive={false} />);
    expect(rendered.getByLabelText('camera inactive')).toBeTruthy();
    await rendered.unmount();
  });

  it('scan hands the value to the mounted camera codeScanner', async () => {
    const onCodeScanned = jest.fn();
    const rendered = await render(<Camera codeScanner={{ onCodeScanned }} />);
    const result = command('scan')({ value: 'pay:123', type: 'ean13' });
    expect(onCodeScanned).toHaveBeenCalledTimes(1);
    const [codes, frame] = onCodeScanned.mock.calls[0] as [Array<{ value: string; type: string }>, { width: number }];
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ value: 'pay:123', type: 'ean13' });
    expect(frame.width).toBe(1080);
    expect(result).toEqual({ scanned: 'pay:123', cameras: 1 });
    await rendered.unmount();
  });

  it('scan defaults the code type to qr', async () => {
    const onCodeScanned = jest.fn();
    const rendered = await render(<Camera codeScanner={{ onCodeScanned }} />);
    command('scan')({ value: 'x' });
    expect((onCodeScanned.mock.calls[0] as [Array<{ type: string }>])[0][0]?.type).toBe('qr');
    await rendered.unmount();
  });

  it('scan with no camera mounted is refused', () => {
    expect(() => command('scan')({ value: 'x' })).toThrow(/no camera mounted/);
  });

  it('scan without a value is refused', () => {
    expect(() => command('scan')({})).toThrow(/needs \{ value \}/);
  });
});

describe('imagePicker', () => {
  type Answer = { didCancel: boolean; assets: Array<{ uri?: string; fileName?: string; type?: string }> };
  const { launchImageLibrary } = imagePicker() as { launchImageLibrary: (opts: unknown, cb?: (r: Answer) => void) => Promise<Answer> };

  beforeEach(() => {
    pickerQueue.length = 0;
  });

  it('answers with the queued asset over sensible defaults', async () => {
    pickerQueue.push({ uri: 'file:///a.jpg', type: 'image/jpeg' });
    const answer = await launchImageLibrary({});
    expect(answer.didCancel).toBe(false);
    expect(answer.assets[0]).toMatchObject({ uri: 'file:///a.jpg', type: 'image/jpeg', fileName: 'headless.png' });
    expect(pickerQueue).toHaveLength(0);
  });

  it('an empty queue means the user cancelled', async () => {
    await expect(launchImageLibrary({})).resolves.toEqual({ didCancel: true, assets: [] });
  });

  it('the callback form receives the same answer', async () => {
    pickerQueue.push({ uri: 'file:///b.png' });
    const cb = jest.fn();
    const answer = await launchImageLibrary({}, cb);
    expect(cb).toHaveBeenCalledWith(answer);
  });

  it('the gallery command queues a pick', async () => {
    expect(command('gallery')({ uri: 'file:///c.png', fileName: 'c.png' })).toEqual({ queued: 1 });
    expect((await launchImageLibrary({})).assets[0]).toMatchObject({ uri: 'file:///c.png', fileName: 'c.png' });
  });

  it('the gallery command can queue a cancel', async () => {
    command('gallery')({ cancel: true });
    await expect(launchImageLibrary({})).resolves.toMatchObject({ didCancel: true });
  });

  it('the gallery command needs a uri or a cancel', () => {
    expect(() => command('gallery')({})).toThrow(/needs \{ uri \}/);
  });

  it('a reset empties the queue', () => {
    pickerQueue.push({ uri: 'file:///a.png' }, null);
    reset();
    expect(pickerQueue).toHaveLength(0);
  });
});
