import path from 'node:path';

import type { Device } from '../device/driver.js';
import { writeJson } from '../files.js';
import { drainEvents, type RunEvent, writeEvents } from '../knowledge/events.js';
import { runDir, stepFile } from './artifacts.js';
import type { Flow, FlowReport, FlowStep, StepReport } from './types.js';

const interpolate = <T>(value: T, vars: Record<string, unknown>): T => {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
      const found = key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], vars);
      if (found === undefined) throw new Error(`Unknown flow variable {{${key}}}`);
      return String(found);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)])) as T;
  }
  return value;
};

export type RunFlowOptions = {
  device: Device;
  vars?: Record<string, unknown>;
  /** Where to leave each step's screen, and screenshot when asked; nothing is kept without one. */
  artifactsRoot?: string;
  screenshots?: boolean;
  /** Drain the app's `events` after every step and keep them with the run; it empties the app's buffer. */
  events?: boolean;
  onStep?: (report: StepReport, index: number) => void;
};

export const runFlow = async (flow: Flow, options: RunFlowOptions): Promise<FlowReport> => {
  const { device } = options;
  const vars: Record<string, unknown> = { ...options.vars };
  const missing = (flow.vars ?? []).filter((name) => vars[name] === undefined);
  if (missing.length) throw new Error(`Flow "${flow.name}" needs vars: ${missing.join(', ')}`);

  const reports: StepReport[] = [];
  const started = performance.now();
  const dir = options.artifactsRoot ? runDir(options.artifactsRoot, flow.name) : undefined;
  const runEvents: RunEvent[] = [];
  // What the app recorded before this run is not this run's.
  if (options.events && device.server.connected) await drainEvents(device);

  for (const [index, raw] of flow.steps.entries()) {
    const step = interpolate(raw, vars);
    const t0 = performance.now();
    const report: StepReport = { step, ok: true, ms: 0 };
    try {
      await execute(step, flow, device, vars);
    } catch (error) {
      report.ok = false;
      report.error = error instanceof Error ? error.message : String(error);
    }
    report.ms = Math.round(performance.now() - t0);
    if (device.server.connected && !('note' in step)) {
      try {
        const screen = await device.screen();
        report.route = screen.route;
        report.screen = screen;
        const events = options.events ? await drainEvents(device) : [];
        if (events.length) {
          report.events = events;
          for (const e of events) runEvents.push({ ...e, step: index + 1, route: screen.route });
        }
        if (dir) {
          report.artifact = { screen: stepFile(dir, index + 1, 'json') };
          writeJson(report.artifact.screen, screen);
          if (options.screenshots) {
            report.artifact.screenshot = stepFile(dir, index + 1, 'png');
            await device.screenshot(report.artifact.screenshot);
          }
        }
      } catch {
        // A hung or gone app is reported by the step itself.
      }
    }
    reports.push(report);
    options.onStep?.(report, index);
    if (!report.ok) break;
  }

  const report: FlowReport = {
    name: flow.name,
    ok: reports.every((r) => r.ok),
    totalMs: Math.round(performance.now() - started),
    steps: reports,
    vars,
    dir,
  };
  if (dir) {
    writeEvents(dir, runEvents);
    writeJson(path.join(dir, 'report.json'), { ...report, steps: report.steps.map(({ screen: _screen, ...rest }) => rest) });
  }
  return report;
};

const execute = async (step: FlowStep, flow: Flow, device: Device, vars: Record<string, unknown>): Promise<void> => {
  if ('note' in step) return;
  if ('launch' in step) {
    await device.server.listen();
    // A running app dials in within ~1.5 s.
    const hello =
      device.server.hello ??
      (await device.server.waitForApp(2500).then(
        () => device.server.hello,
        () => null,
      ));
    if (step.launch.clean && hello) await device.command('reset').catch(() => undefined);
    // A headless host has no process to relaunch; the reset was the fresh start.
    if (hello?.app?.runtime === 'headless') return;
    const appId = step.launch.appId ?? flow.appId ?? device.appId;
    if (!appId) throw new Error('launch needs an appId (step, flow, or --app)');
    await device.launchApp(appId, { fresh: step.launch.fresh ?? true });
    return;
  }
  if ('press' in step) {
    await device.press(step.press);
    return;
  }
  if ('pressIf' in step) {
    const { timeoutMs, ...target } = step.pressIf;
    const present = await device.waitFor({ target, timeoutMs: timeoutMs ?? 300 }).then(
      () => true,
      () => false,
    );
    if (present) await device.press(target);
    return;
  }
  if ('keypad' in step) {
    for (const digit of step.keypad.digits) {
      await device.press({ testId: step.keypad.pattern.replace('{d}', digit), mode: step.keypad.mode });
    }
    return;
  }
  if ('type' in step) {
    await device.type(step.type);
    return;
  }
  if ('swipe' in step) {
    await device.swipe({ direction: step.swipe.direction });
    return;
  }
  if ('back' in step) {
    await device.back();
    return;
  }
  if ('dismissKeyboard' in step) {
    await device.server.call('dismissKeyboard');
    return;
  }
  if ('navigate' in step) {
    await device.navigate(step.navigate.name, step.navigate.params);
    return;
  }
  if ('deepLink' in step) {
    await device.openUrl(step.deepLink.url);
    return;
  }
  if ('waitFor' in step) {
    await device.waitFor(step.waitFor);
    return;
  }
  if ('idle' in step) {
    await device.idle(step.idle);
    return;
  }
  if ('assert' in step) {
    // An assertion is a wait with no patience: the state must already hold.
    await device.waitFor({ ...step.assert, timeoutMs: 0 });
    return;
  }
  if ('call' in step) {
    const result = await device.command(step.call.method, step.call.params);
    if (step.call.as) vars[step.call.as] = result;
    return;
  }
  throw new Error(`Unknown step ${JSON.stringify(step)}`);
};
