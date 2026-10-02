import fs from 'node:fs';
import path from 'node:path';

import type { Device } from '../device/driver.js';
import { writeJson } from '../files.js';
import { problemsOf } from '../knowledge/problems.js';
import { readRouteParams } from '../knowledge/route-params.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { clearOverlayIfShown, type Overlay } from './overlay.js';

export type SmokeResult = {
  route: string;
  ok: boolean;
  reached?: string;
  elements: number;
  ms: number;
  problems: string[];
  screen?: string;
  screenshot?: string;
};

export type SmokeOptions = {
  device: Device;
  graph: ScreenGraph;
  appRoot: string;
  /** Path of the route params type map, relative to appRoot. */
  paramsFile?: string;
  outDir: string;
  only?: string[];
  screenshots?: boolean;
  overlay?: Overlay;
  appId?: string;
  errorCopy?: RegExp;
  onResult?: (r: SmokeResult) => void;
};

export const smoke = async (options: SmokeOptions): Promise<SmokeResult[]> => {
  const { device, graph } = options;
  const params = new Map(readRouteParams(options.appRoot, options.paramsFile).map((p) => [p.route, p]));
  const routes = Object.keys(graph.screens)
    .filter((r) => (options.only ? options.only.some((o) => r === o || r.startsWith(o)) : true))
    .filter((r) => params.get(r)?.free ?? false)
    .sort();
  fs.mkdirSync(options.outDir, { recursive: true });
  const results: SmokeResult[] = [];

  const recover = async () => {
    if (!options.appId) throw new Error('App disconnected and no --app to relaunch');
    await device.launchApp(options.appId, { fresh: true });
    await clearOverlayIfShown(device, options.overlay);
  };

  await clearOverlayIfShown(device, options.overlay);
  for (const route of routes) {
    const t0 = performance.now();
    const result: SmokeResult = { route, ok: true, elements: 0, ms: 0, problems: [] };
    try {
      if (!device.server.connected) await recover();
      const before = await device.requests();
      await device.navigate(route);
      await device.idle({ quietMs: 200, timeoutMs: 1500 });
      const screen = await device.screen();
      const { requests } = await device.requests(before.requests.at(-1)?.id);
      result.reached = screen.route;
      result.elements = screen.elements.length;
      if (screen.route !== route && !screen.path.includes(route)) result.problems.push(`landed on ${screen.route ?? '?'}`);
      if (screen.elements.length && screen.elements.every((e) => e.kind === 'text' || !e.enabled)) result.problems.push('nothing to interact with');
      result.problems.push(...problemsOf(screen, requests, options.errorCopy));
      const slug = route.replace(/[^\w.]+/g, '_');
      result.screen = path.join(options.outDir, `${slug}.json`);
      writeJson(result.screen, { screen, requests });
      if (options.screenshots) {
        result.screenshot = path.join(options.outDir, `${slug}.png`);
        await device.screenshot(result.screenshot);
      }
    } catch (error) {
      result.problems.push(error instanceof Error ? error.message : String(error));
    }
    result.ok = result.problems.length === 0;
    result.ms = Math.round(performance.now() - t0);
    results.push(result);
    options.onResult?.(result);
  }
  writeJson(path.join(options.outDir, 'summary.json'), results);
  return results;
};
