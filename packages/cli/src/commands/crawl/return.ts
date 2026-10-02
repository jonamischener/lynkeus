import { execSync } from 'node:child_process';

import type { Screen } from 'lynkeus-protocol';

import type { Device } from '../../device/driver.js';
import { runFlow } from '../../flow/runner.js';
import type { CrawlOptions } from '../crawl.js';
import { clearOverlayIfShown } from '../overlay.js';
import { isCloser, presented, stateKey, targetFor, targetOf } from './state.js';

/** Fatal: exploring a logged-out app would record its intro screens as reachable from logged-in ones, and poison `plan`. */
export class RecoveryError extends Error {}

type Context = { device: Device; options: CrawlOptions; goTo: (route: string | undefined) => Promise<void> };

/** How the crawl gets back to where it was standing, or back to life. */
export const createReturns = ({ device, options, goTo }: Context) => {
  const dead = (s: Screen) => !s.route && s.elements.length === 0;
  const pressed = (target: ReturnType<typeof targetFor>, timeoutMs: number) =>
    device
      .waitFor({ target, timeoutMs })
      .then(() => device.press(target))
      .then(
        () => true,
        () => false,
      );

  const logIn = async (login: NonNullable<CrawlOptions['login']>) => {
    const entry = (await device.screen()).route;
    const vars = { ...login.vars };
    for (const flow of login.flows) {
      for (const name of flow.vars ?? []) {
        const command = login.varCommands?.[name];
        if (!command) continue;
        options.log?.(`${name} ← ${command}`);
        vars[name] = execSync(command, { encoding: 'utf8' }).trim();
        if (!vars[name]) throw new RecoveryError(`the command for {{${name}}} printed nothing`);
      }
      options.log?.(`login: ${flow.name}`);
      const report = await runFlow(flow, { device, vars });
      if (!report.ok) throw new RecoveryError(`login flow "${flow.name}" failed at step ${report.steps.length}`);
    }
    const after = await device.screen();
    if (!after.route || after.route === entry) throw new RecoveryError(`login left the app on ${after.route ?? 'no route'}`);
  };

  const recover = async () => {
    if (device.server.hello?.app?.runtime === 'headless') {
      // A host has no process to relaunch; a reset mounts the app again from scratch.
      await device.command('reset');
      if (options.login) await logIn(options.login);
      return;
    }
    if (!options.appId) throw new RecoveryError('App disconnected and no --app to relaunch');
    await device.launchApp(options.appId, { fresh: true });
    await clearOverlayIfShown(device, options.overlay);
  };

  // Sheets animate on the UI thread after React has gone quiet: a screen whose controls are all still covered gets one more look.
  const settle = async (): Promise<Screen> => {
    await device.idle({ quietMs: 150, timeoutMs: 800 });
    const screen = await device.screen();
    const controls = presented(screen).filter((e) => e.kind === 'button');
    if (controls.length === 0 || !controls.every((e) => e.covered)) return screen;
    await new Promise((r) => setTimeout(r, 400));
    return device.screen();
  };

  const changedFrom = async (now: Screen) => {
    await device.idle({ quietMs: 150, timeoutMs: 800 });
    return stateKey(await device.screen()) !== stateKey(now);
  };

  /** Without knowing what an app calls its close button: its declared closer, then its backdrop, a swipe down, back. */
  const closeOverlay = async (now: Screen) => {
    // Only what the layer offers: a "Close" on the screen it covers is out of reach.
    const closer = options.closers ? presented(now).find((e) => isCloser(e, options.closers!)) : undefined;
    if (closer) return device.press(targetOf(closer));
    const backdrop = now.presenting ? now.elements[now.presenting.i] : undefined;
    if (backdrop?.kind === 'button' && backdrop.enabled) {
      await device.press(targetOf(backdrop));
      if (await changedFrom(now)) return;
    }
    await device.swipe({ direction: 'down' });
    if (await changedFrom(now)) return;
    await device.back().catch(() => undefined);
  };

  const revive = async (): Promise<Screen> => {
    const now = await settle();
    if (!dead(now)) return now;
    options.log?.('navigator is dead; recovering before exploring');
    await recover().catch(() => undefined);
    return settle();
  };

  /** Back on the route is enough: lists and banners drift between visits. */
  const returnTo = async (origin: Screen): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      let now = await device.screen();
      if (dead(now)) {
        options.log?.('navigator is dead; recovering');
        await recover();
        now = await device.screen();
      }
      if (now.route === origin.route && !now.presenting) return true;
      if (now.route !== origin.route) {
        const popped = await device.back().then(
          () => true,
          () => false,
        );
        if (!popped) await goTo(origin.route);
      } else await closeOverlay(now);
      await device.idle({ quietMs: 200, timeoutMs: 1500 });
    }
    const back = (await device.screen()).route === origin.route;
    if (!back) options.log?.(`could not return to ${origin.route ?? '?'}`);
    return back;
  };

  /** A sheet is named after the control that opens it, so getting back in is pressing that control again. */
  const restore = async (origin: Screen, layer?: string): Promise<boolean> => {
    if (!(await returnTo(origin))) return false;
    if (!layer || (await device.screen()).presenting) return true;
    if (!(await pressed(targetFor(layer), 800))) return false;
    return (await settle()).presenting !== undefined;
  };

  return { dead, recover, settle, revive, restore };
};
