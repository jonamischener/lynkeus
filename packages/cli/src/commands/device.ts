import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Platform } from '../device/devices.js';

const run = promisify(execFile);

/** `optional`: a failure is the desired end state too (terminating an app that is not running). */
type Invocation = { bin: string; args: string[]; optional?: boolean };

const IOS_SERVICES = new Set([
  'all',
  'calendar',
  'contacts-limited',
  'contacts',
  'location',
  'location-always',
  'photos-add',
  'photos',
  'media-library',
  'microphone',
  'motion',
  'reminders',
  'siri',
  'camera',
]);

export const simulatorArgv = (platform: Platform, deviceId: string, sub: string, args: string[], appId?: string): Invocation[] => {
  const needApp = (): string => {
    if (!appId) throw new Error(`lynkeus os ${sub} needs --app <bundleId>`);
    return appId;
  };
  if (platform === 'ios') {
    switch (sub) {
      case 'permissions': {
        const [action, service] = args;
        if (!action || !['grant', 'revoke', 'reset'].includes(action)) throw new Error('lynkeus os permissions grant|revoke|reset <service> --app <bundleId>');
        if (!service || !IOS_SERVICES.has(service)) throw new Error(`service must be one of ${[...IOS_SERVICES].join(', ')}`);
        return [{ bin: 'xcrun', args: ['simctl', 'privacy', deviceId, action, service, needApp()] }];
      }
      case 'push': {
        const [payload] = args;
        if (!payload) throw new Error("lynkeus os push '<json>' | <file.json> --app <bundleId>");
        let file = payload;
        if (!fs.existsSync(payload)) {
          file = path.join(os.tmpdir(), `lynkeus-push-${Date.now()}.json`);
          // simctl wants an APNS payload: wrap a bare notification under "aps".
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          fs.writeFileSync(file, JSON.stringify('aps' in parsed ? parsed : { aps: parsed }));
        }
        return [{ bin: 'xcrun', args: ['simctl', 'push', deviceId, needApp(), file] }];
      }
      case 'appearance': {
        const [mode] = args;
        if (mode !== 'light' && mode !== 'dark') throw new Error('lynkeus os appearance light|dark');
        return [{ bin: 'xcrun', args: ['simctl', 'ui', deviceId, 'appearance', mode] }];
      }
      case 'location': {
        const [where] = args;
        if (where === 'clear') return [{ bin: 'xcrun', args: ['simctl', 'location', deviceId, 'clear'] }];
        if (!where || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(where)) throw new Error('lynkeus os location <lat>,<lon> | clear');
        return [{ bin: 'xcrun', args: ['simctl', 'location', deviceId, 'set', where] }];
      }
      case 'language': {
        // No system-wide switch on a booted simulator: relaunch the app with the
        // launch arguments iOS reads for its locale.
        const [tag] = args;
        if (!tag) throw new Error('lynkeus os language <bcp47, e.g. de-DE> --app <bundleId>');
        const app = needApp();
        const locale = tag.replace('-', '_');
        return [
          { bin: 'xcrun', args: ['simctl', 'terminate', deviceId, app], optional: true },
          { bin: 'xcrun', args: ['simctl', 'launch', deviceId, app, '-AppleLanguages', `(${tag})`, '-AppleLocale', locale] },
        ];
      }
      default:
        throw new Error(`unknown os subcommand "${sub}"; one of permissions, push, appearance, location, language`);
    }
  }
  const adb = (a: string[]): Invocation => ({ bin: 'adb', args: ['-s', deviceId, ...a] });
  switch (sub) {
    case 'permissions': {
      const [action, service] = args;
      if (!action || !['grant', 'revoke'].includes(action) || !service)
        throw new Error('lynkeus os permissions grant|revoke <android.permission.X> --app <applicationId>');
      return [adb(['shell', 'pm', action, needApp(), service.includes('.') ? service : `android.permission.${service.toUpperCase()}`])];
    }
    case 'appearance': {
      const [mode] = args;
      if (mode !== 'light' && mode !== 'dark') throw new Error('lynkeus os appearance light|dark');
      return [adb(['shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no'])];
    }
    case 'location': {
      const [where] = args;
      if (!where || !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(where)) throw new Error('lynkeus os location <lat>,<lon>');
      const [lat, lon] = where.split(',');
      return [adb(['emu', 'geo', 'fix', lon!, lat!])];
    }
    default:
      throw new Error(`"${sub}" is not available on Android through lynkeus; permissions, appearance and location are`);
  }
};

export const simulatorCommand = async (platform: Platform, deviceId: string, sub: string, args: string[], appId?: string): Promise<string[]> => {
  const out: string[] = [];
  for (const c of simulatorArgv(platform, deviceId, sub, args, appId)) {
    try {
      const { stdout } = await run(c.bin, c.args);
      out.push(`${c.bin} ${c.args.join(' ')}${stdout.trim() ? `\n${stdout.trim()}` : ''}`);
    } catch (error) {
      if (c.optional) continue;
      throw new Error(`${c.bin} ${c.args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
};
