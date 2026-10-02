import fs from 'node:fs';
import path from 'node:path';

import { readJsonl } from '../files.js';

export type AppEvent = { name: string; props?: Record<string, unknown> };
export type RunEvent = AppEvent & { step: number; route?: string };

type Drainable = { command<T = unknown>(name: string, params?: unknown): Promise<T> };

/** An app's own buffer may say `properties`; lynkeus says `props`. */
export const normalizeEvents = (raw: unknown): AppEvent[] =>
  (Array.isArray(raw) ? raw : []).flatMap((e) => {
    const r = e as { name?: unknown; props?: unknown; properties?: unknown };
    if (typeof r?.name !== 'string') return [];
    const props = (r.props ?? r.properties) as Record<string, unknown> | undefined;
    return [{ name: r.name, ...(props && typeof props === 'object' ? { props } : {}) }];
  });

export const drainEvents = async (device: Drainable): Promise<AppEvent[]> => {
  try {
    return normalizeEvents(await device.command('events', { clear: true }));
  } catch {
    return [];
  }
};

export const eventsFile = (runDir: string) => path.join(runDir, 'events.jsonl');

export const writeEvents = (runDir: string, events: RunEvent[]): void => {
  if (events.length === 0) return;
  fs.writeFileSync(eventsFile(runDir), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
};

export const readEvents = (file: string): RunEvent[] => readJsonl<RunEvent>(file);

/** Every run under `runs/` that recorded events, newest first. */
export const eventsFiles = (runsRoot: string): string[] => {
  const found: { file: string; mtime: number }[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.name === 'events.jsonl') found.push({ file: full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  visit(runsRoot, 0);
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
};

/** A run folder, `last`, or an events.jsonl itself. */
export const resolveEventsFile = (runsRoot: string, ref: string): string | undefined => {
  if (ref === 'last') return eventsFiles(runsRoot)[0];
  const full = path.resolve(ref);
  return full.endsWith('.jsonl') ? full : eventsFile(full);
};

export const describeEvents = (events: RunEvent[]): string =>
  events.map((e) => `${String(e.step).padStart(2)} ${e.route ?? '?'}  ${e.name}${e.props ? ` ${JSON.stringify(e.props)}` : ''}`).join('\n');
