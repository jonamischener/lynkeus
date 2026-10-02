import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { Platform } from './devices.js';

const run = promisify(execFile);

export type PlatformLifecycle = {
  launchApp(deviceId: string, appId: string, fresh: boolean): Promise<void>;
  screenshot(deviceId: string, destination: string): Promise<void>;
  freezeChrome(deviceId: string): Promise<void>;
};

const ios: PlatformLifecycle = {
  async launchApp(deviceId, appId, fresh) {
    const args = ['simctl', 'launch'];
    if (fresh) args.push('--terminate-running-process');
    await run('xcrun', [...args, deviceId, appId]);
  },

  async screenshot(deviceId, destination) {
    await run('xcrun', ['simctl', 'io', deviceId, 'screenshot', destination]);
  },

  async freezeChrome(deviceId) {
    await run('xcrun', [
      'simctl',
      'status_bar',
      deviceId,
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
    ]);
  },
};

const adb = (deviceId: string, args: string[]) => run('adb', ['-s', deviceId, ...args]);

const android: PlatformLifecycle = {
  async launchApp(deviceId, appId, fresh) {
    if (fresh) await adb(deviceId, ['shell', 'am', 'force-stop', appId]);
    await adb(deviceId, ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']);
  },

  async screenshot(deviceId, destination) {
    const { stdout } = await run('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    await writeFile(destination, stdout);
  },

  async freezeChrome(deviceId) {
    await adb(deviceId, ['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
    const demo = (args: string[]) => adb(deviceId, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...args]);
    await demo(['-e', 'command', 'enter']);
    await demo(['-e', 'command', 'clock', '-e', 'hhmm', '0941']);
    await demo(['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false']);
    await demo(['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4']);
    await demo(['-e', 'command', 'notifications', '-e', 'visible', 'false']);
  },
};

export const lifecycleFor = (platform: Platform): PlatformLifecycle => (platform === 'ios' ? ios : android);
