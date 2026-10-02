/**
 * What the outside world hands the app. One vocabulary whether the app is
 * hosted in Node (lynkeus stands in for the OS) or runs on a simulator (simctl
 * and adb do it); each command's summary says which it supports.
 */
import { type Ctx, define } from '../registry.js';
import { simulatorCommand } from './device.js';

/** A command the agent answers in place of the OS, with parameters taken from the context. */
const agent =
  (name: string, params: (ctx: Ctx) => unknown = () => undefined) =>
  async (ctx: Ctx) => ({ json: await (await ctx.device()).command(name, params(ctx)) });

const simulator = (sub: string) => async (ctx: Ctx) => {
  const device = await ctx.device();
  const info = await device.resolved();
  const lines = await simulatorCommand(info.platform, info.id, sub, ctx.args, (ctx.flags.app as string | undefined) ?? device.appId ?? undefined);
  return { text: lines.join('\n'), json: { ran: lines } };
};

export const osCommands = [
  define({
    name: 'os deeplink',
    mcp: 'core',
    group: 'os',
    summary: 'Open a URL in the app, as the OS would hand it over',
    positionals: [{ name: 'url', help: 'myapp://pay/abc or https://…', required: true }],
    aliases: ['deeplink'],
    needs: 'app',
    run: async (ctx) => {
      await (await ctx.device()).openUrl(ctx.args[0]!);
      return { json: { opened: ctx.args[0] } };
    },
  }),
  define({
    name: 'os appstate',
    group: 'os',
    summary: 'Headless: AppState listeners see the change (background, then active: what refetches or re-locks)',
    positionals: [{ name: 'state', help: 'active | background | inactive', required: true }],
    aliases: ['appstate'],
    needs: 'app',
    run: agent('appstate', (ctx) => ({ state: ctx.args[0] })),
  }),
  define({
    name: 'os network',
    group: 'os',
    summary: 'Headless: airplane mode (requests fail, open sockets drop, NetInfo listeners hear it)',
    positionals: [{ name: 'state', help: 'off | on', required: true }],
    aliases: ['network'],
    needs: 'app',
    run: agent('network', (ctx) => ({ state: ctx.args[0] })),
  }),
  define({
    name: 'os clock',
    group: 'os',
    summary: 'Headless: what Date answers (timers stay real)',
    flags: {
      now: { type: 'string', help: 'set the time', value: 'iso' },
      advance: { type: 'number', help: 'move the clock forward', value: 'ms' },
      reset: { type: 'boolean', help: 'back to the real clock' },
    },
    aliases: ['clock'],
    needs: 'app',
    run: agent('clock', ({ flags }) => ({ now: flags.now || undefined, advanceMs: flags.advance, reset: flags.reset || undefined })),
  }),
  define({
    name: 'os biometrics',
    group: 'os',
    summary: 'Headless: the sensor and what the next prompts answer',
    flags: {
      available: { type: 'string', help: 'FaceID | TouchID | none', value: 'kind' },
      next: { type: 'string', help: 'outcomes of the next prompts, in order', value: 'success,fail,cancel' },
      fallback: { type: 'string', help: 'what a fallback prompt answers', value: 'outcome' },
    },
    aliases: ['biometrics'],
    needs: 'app',
    run: agent('biometrics', ({ flags }) => ({
      available: flags.available || undefined,
      next: flags.next ? (flags.next as string).split(',') : undefined,
      fallback: flags.fallback || undefined,
    })),
  }),
  define({
    name: 'os scan',
    group: 'os',
    summary: "Headless: the open camera's code scanner receives a value",
    positionals: [{ name: 'value', help: 'what the code carries', required: true }],
    flags: { type: { type: 'string', help: 'code type', default: 'qr', value: 'qr|ean13|…' } },
    aliases: ['scan'],
    needs: 'app',
    run: agent('scan', (ctx) => ({ value: ctx.args[0], type: ctx.flags.type })),
  }),
  define({
    name: 'os gallery',
    group: 'os',
    summary: 'Headless: what the next image picker answers',
    positionals: [{ name: 'uri', help: 'file the picker returns' }],
    flags: {
      cancel: { type: 'boolean', help: 'the user cancelled' },
      name: { type: 'string', help: 'file name reported', value: 'name' },
      mime: { type: 'string', help: 'mime type reported', value: 'type' },
    },
    aliases: ['gallery'],
    needs: 'app',
    run: agent('gallery', ({ args, flags }) => (flags.cancel ? { cancel: true } : { uri: args[0], fileName: flags.name, type: flags.mime })),
  }),
  define({
    name: 'mock',
    group: 'os',
    summary: 'Headless: answer a request before the network (--sticky survives a reset)',
    positionals: [{ name: 'route', help: "'GET /path' (a bare path matches any method)" }],
    flags: {
      status: { type: 'number', help: 'HTTP status to answer', default: 200, value: 'code' },
      body: { type: 'string', help: 'JSON body', value: 'json' },
      delay: { type: 'number', help: 'answer after', value: 'ms' },
      times: { type: 'number', help: 'only this many times', value: 'n' },
      sticky: { type: 'boolean', help: 'keep the rule across an app reset' },
      lost: { type: 'boolean', help: 'let the request reach the server and fail it on the way back' },
      clear: { type: 'boolean', help: 'drop every rule' },
      list: { type: 'boolean', help: 'show the rules' },
    },
    example: "mock 'GET /path' [--status 500] [--body <json>] [--delay <ms>] [--times <n>] [--sticky] [--lost] | --clear | --list",
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      if (ctx.flags.clear) return { json: await device.command('netmock', { action: 'clear' }) };
      if (ctx.flags.list) {
        const rules = await device.command('netmock', { action: 'list' });
        return { text: JSON.stringify(rules, null, 2), json: rules };
      }
      if (!ctx.args[0]) throw new Error("mock needs 'METHOD /path' (or --clear, --list)");
      const [method, route] = ctx.args[0].includes(' ') ? ctx.args[0].split(/\s+/, 2) : ['*', ctx.args[0]];
      return {
        json: await device.command('netmock', {
          action: 'add',
          method,
          path: route,
          status: ctx.flags.status,
          body: ctx.flags.body,
          delayMs: ctx.flags.delay,
          times: ctx.flags.times,
          sticky: ctx.flags.sticky || undefined,
          lost: ctx.flags.lost || undefined,
        }),
      };
    },
  }),
  define({
    name: 'os permissions',
    group: 'os',
    summary: 'Simulator: grant, revoke or reset a permission for the app',
    positionals: [
      { name: 'action', help: 'grant | revoke | reset', required: true },
      { name: 'service', help: 'camera, photos, location, microphone, contacts, …', required: true },
    ],
    needs: 'app',
    run: simulator('permissions'),
  }),
  define({
    name: 'os push',
    group: 'os',
    summary: 'Simulator: deliver a push notification to the app',
    positionals: [{ name: 'payload', help: '\'{"alert":"…"}\' or a .json file', required: true }],
    needs: 'app',
    run: simulator('push'),
  }),
  define({
    name: 'os appearance',
    group: 'os',
    summary: 'Simulator: light or dark',
    positionals: [{ name: 'mode', help: 'light | dark', required: true }],
    needs: 'app',
    run: simulator('appearance'),
  }),
  define({
    name: 'os location',
    group: 'os',
    summary: 'Simulator: where the device is',
    positionals: [{ name: 'where', help: '<lat>,<lon> | clear', required: true }],
    needs: 'app',
    run: simulator('location'),
  }),
  define({
    name: 'os language',
    group: 'os',
    summary: 'Simulator: relaunch the app in a locale',
    positionals: [{ name: 'tag', help: 'de-DE, en-US, … (default: the locale in lynkeus.config.json)' }],
    needs: 'app',
    run: async (ctx) => {
      const tag = ctx.args[0] ?? ctx.config.locale?.languageTag ?? ctx.config.language;
      if (!tag) throw new Error('os language needs a tag, or `locale` in lynkeus.config.json');
      return simulator('language')({ ...ctx, args: [tag] });
    },
  }),
];
