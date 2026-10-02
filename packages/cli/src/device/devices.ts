import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Platform = 'ios' | 'android';

export type DeviceInfo = {
  id: string;
  name: string;
  platform: Platform;
  type: 'simulator' | 'emulator' | 'physical';
  connected: boolean;
};

export const bootedSimulators = async (): Promise<DeviceInfo[]> => {
  // No Xcode (Linux, CI) means no simulators, not a crash: the app may be hosted headless.
  let stdout: string;
  try {
    ({ stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
  return Object.values(parsed.devices)
    .flat()
    .filter((d) => d.state === 'Booted')
    .map((d) => ({ id: d.udid, name: d.name, platform: 'ios', type: 'simulator', connected: true }));
};

export const HEADLESS_HOST: DeviceInfo = { id: 'headless', name: 'headless host', platform: 'ios', type: 'simulator', connected: true };

export const pickAgentDevice = async (wanted?: string): Promise<DeviceInfo> => {
  const devices = await bootedSimulators();
  const id = wanted ?? process.env.LYNKEUS_DEVICE;
  const device = id ? devices.find((d) => d.id === id || d.name.includes(id)) : devices[0];
  if (!device) {
    // A headless host dials the driver itself: nothing to boot or attach to.
    if (!id && devices.length === 0) return HEADLESS_HOST;
    throw new Error(id ? `No booted simulator matching "${id}".` : 'No booted simulator. Boot one first.');
  }
  return device;
};
