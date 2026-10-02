import fs from 'node:fs';
import path from 'node:path';

import type { CasesConfig } from './cases/runner.js';
import { readJson } from './files.js';
import type { ScreenGraph } from './knowledge/types.js';

export const lynkeusDir = (root = process.cwd()) => path.join(root, '.lynkeus');
export const graphFile = (root?: string) => path.join(lynkeusDir(root), 'graph.json');
export const edgesFile = (root?: string) => path.join(lynkeusDir(root), 'edges.jsonl');
export const frontierFile = (root?: string) => path.join(lynkeusDir(root), 'frontier.jsonl');
export const runsDir = (root?: string) => path.join(lynkeusDir(root), 'runs');

export const loadGraph = (root?: string): ScreenGraph | null => {
  const file = graphFile(root);
  return fs.existsSync(file) ? readJson<ScreenGraph>(file) : null;
};

/**
 * `lynkeus.config.json` in the app's folder: what would otherwise be repeated
 * as flags or environment on every invocation. Flags win over the
 * environment, the environment over the file.
 */
export type LynkeusConfig = {
  cases?: CasesConfig;
  /** The headless entry (default `qa/headless.tsx`). */
  entry?: string;
  /** The environment variable the app reads its API base from; the headless entry refuses one that is not local. */
  apiEnv?: string;
  /** The driver port the app dials. */
  port?: number;
  /** Simulator udid or name. */
  device?: string;
  /** Bundle id or application id. */
  app?: string;
  /**
   * The language this app speaks, passed on and never interpreted: `os
   * language` defaults to it, the headless entry mocks this locale, and an MCP
   * client is told, so a model reading the screens knows their language.
   */
  language?: string;
  locale?: { languageTag?: string; country?: string };
  /** How long to wait for the app to attach, in ms. */
  attachTimeout?: number;
  /** The lint baseline `lint` compares against when no file is given. */
  lintBaseline?: string;
  /** Regular expressions for the text this app shows when it is broken; `smoke` and `crawl` report a match. */
  errorCopy?: string[];
  /** The shape of an untranslated key, and the smallest acceptable touch target in points. */
  lint?: { i18nKeyPatterns?: string[]; minTouchTarget?: number };
  /**
   * Regular expressions for the testIDs of controls whose content changes on
   * its own (a ticking clock, a countdown). Their text stops counting as a
   * commit, or `idle` would wait out its whole timeout on every screen that
   * shows one.
   */
  live?: string[];
  /** Keep React.StrictMode in the headless host. Off by default: its double renders inflate what the host measures. */
  strictMode?: boolean;
  /** Regular expressions matched against a control's testID and label. lynkeus ships none: only the app knows which controls are irreversible. */
  crawl?: {
    /** Never pressed. */
    never?: string[];
    /** Close an overlay the app raises. */
    close?: string[];
    /** Go back. Without them the crawl takes a small control in the top-left corner for one. */
    back?: string[];
  };
};

export const configFile = (root?: string) => path.join(root ?? process.cwd(), 'lynkeus.config.json');

const readConfig = (file: string): LynkeusConfig => {
  if (!fs.existsSync(file)) return {};
  try {
    const config = readJson<LynkeusConfig>(file);
    // Paths under `cases` are relative to the file that declares them.
    if (config.cases) config.cases.base = path.dirname(path.resolve(file));
    return config;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** The app's configuration, under the one `LYNKEUS_CONFIG` names: cases and fixtures often live in a repository of their own. */
export const loadConfig = (root?: string): LynkeusConfig => {
  const own = readConfig(configFile(root));
  const extra = process.env.LYNKEUS_CONFIG ? readConfig(path.resolve(process.env.LYNKEUS_CONFIG)) : {};
  return { ...own, ...extra };
};

export const portFromEnv = (config: LynkeusConfig = {}): number | undefined => (process.env.LYNKEUS_PORT ? Number(process.env.LYNKEUS_PORT) : config.port);

/** A list of regular expressions from the configuration, as one that matches any of them. */
export const anyOf = (patterns: string[] | undefined): RegExp | undefined => (patterns?.length ? new RegExp(patterns.join('|'), 'i') : undefined);

export const packageName = (root: string): string => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }).name ?? path.basename(root);
  } catch {
    return path.basename(root);
  }
};
