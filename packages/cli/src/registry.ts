/**
 * One definition per command, read by every surface: the terminal's parser and
 * usage, session lines, the MCP tools and the reference document.
 */
import type { LynkeusConfig } from './config.js';
import type { Device } from './device/driver.js';
import type { ScreenGraph } from './knowledge/types.js';
import { GLOBAL_FLAGS, parseArgs, type FlagSpec, type FlagValues, type PositionalSpec } from './args.js';

export type Group = 'drive' | 'os' | 'map' | 'runs' | 'headless';

const GROUPS: Record<Group, { title: string; blurb: string }> = {
  drive: { title: 'Drive', blurb: 'the app that is running, through the agent inside it' },
  os: { title: 'os', blurb: 'what the outside world hands the app: links, clock, sensors, the network, the simulator' },
  map: { title: 'map', blurb: "what lynkeus knows before touching anything, from the app's source and from walks" },
  runs: { title: 'Runs', blurb: 'flows, smokes, crawls and recordings' },
  headless: { title: 'headless', blurb: 'the app hosted in Node under jest, no simulator' },
};

/** What a command runs against: one per process, or per session or MCP server. */
export type Base = {
  root: string;
  config: LynkeusConfig;
  /** The live app, connected on first use. */
  device: () => Promise<Device>;
  /** The static graph; throws with advice when there is none. */
  graph: () => ScreenGraph;
  /** Progress and diagnostics, on stderr. */
  err: (line: string) => void;
  /** Inside `lynkeus session` and over MCP: one connection, many commands. */
  attached: boolean;
};

export type Ctx = Base & { args: string[]; flags: FlagValues; passthrough: string[] };

export type Result = {
  /** What a person reads; the JSON on one line when left out. */
  text?: string;
  /** What a program reads; printed instead of the text under --json. */
  json?: unknown;
  code?: number;
};

export type Command = {
  /** `press`, or `map build` for a grouped command. */
  name: string;
  group: Group;
  summary: string;
  /** Longer help, for `lynkeus help <command>` and the reference. */
  details?: string;
  positionals?: PositionalSpec[];
  flags?: Record<string, FlagSpec>;
  /** Other spellings it answers to, left out of the usage. */
  aliases?: string[];
  needs: 'nothing' | 'graph' | 'app';
  /** `core` is served to every MCP client; other commands that need the app or the graph only with `mcp --full`. */
  mcp?: boolean | 'core';
  /** Flags a model has no use for (artifacts, timing knobs): left out of the MCP schema. */
  mcpOmit?: string[];
  /** What a model is told instead of `details`. */
  mcpDetails?: string;
  /** Runnable from a session line (default: when it needs the app or the graph). */
  session?: boolean;
  /** The usage line, when the generated one would mislead. */
  example?: string;
  run: (ctx: Ctx) => Promise<Result | string | undefined>;
};

export const define = (c: Command): Command => c;

const byName = new Map<string, Command>();
const all: Command[] = [];

export const register = (commands: Command[]): void => {
  for (const c of commands) {
    for (const name of [c.name, ...(c.aliases ?? [])]) {
      if (byName.has(name)) throw new Error(`${name} is defined twice`);
      byName.set(name, c);
    }
    all.push(c);
  }
};

export const commands = (): Command[] => all;
export const find = (name: string): Command | undefined => byName.get(name);

/** The command an argv names, and the rest of the argv. */
export const resolve = (argv: string[]): { command: Command; rest: string[] } | undefined => {
  const two = argv.length >= 2 ? byName.get(argv.slice(0, 2).join(' ')) : undefined;
  if (two) return { command: two, rest: argv.slice(2) };
  const one = argv[0] ? byName.get(argv[0]) : undefined;
  return one ? { command: one, rest: argv.slice(1) } : undefined;
};

export const parseFor = (command: Command, rest: string[]) => parseArgs(rest, command.positionals, command.flags);

export const inSession = (c: Command): boolean => c.session ?? c.needs !== 'nothing';

export const overMcp = (c: Command, full: boolean): boolean => {
  if (c.mcp === false || (c.needs === 'nothing' && c.mcp === undefined)) return false;
  return c.mcp === 'core' || full;
};

const flagSignature = (name: string, f: FlagSpec) => `--${name}${f.type === 'boolean' ? '' : ` <${f.value ?? f.type}>`}`;

const signature = (c: Command): string => {
  const pos = (c.positionals ?? []).map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`) + (p.rest ? '…' : '')).join(' ');
  const fl = Object.entries(c.flags ?? {})
    .map(([n, f]) => `[${flagSignature(n, f)}]`)
    .join(' ');
  return [c.name, pos, fl].filter(Boolean).join(' ');
};

const inGroups = () => (Object.keys(GROUPS) as Group[]).map((g) => ({ ...GROUPS[g], list: all.filter((c) => c.group === g) })).filter((g) => g.list.length);

export const usage = (): string => {
  const lines = ['lynkeus — drive a React Native app from the outside, through the agent inside it', ''];
  for (const g of inGroups()) {
    lines.push(`${g.title} — ${g.blurb}`);
    for (const c of g.list) {
      const sig = c.example ?? signature(c);
      lines.push(sig.length > 44 ? `  ${sig}\n${' '.repeat(47)}${c.summary}` : `  ${sig.padEnd(45)}${c.summary}`);
    }
    lines.push('');
  }
  lines.push(
    `Global: ${Object.entries(GLOBAL_FLAGS)
      .map(([n, f]) => flagSignature(n, f))
      .join('  ')}`,
    '`lynkeus help <command>` for details; `lynkeus session` runs many commands on one connection; `lynkeus mcp` serves the core of them to an AI harness (`--full`: all).',
  );
  return lines.join('\n');
};

export const helpFor = (c: Command): string => {
  const lines = [`lynkeus ${signature(c)}`, '', c.summary];
  if (c.details) lines.push('', c.details);
  if (c.positionals?.length) {
    lines.push('', 'Arguments');
    for (const p of c.positionals) lines.push(`  ${p.name.padEnd(14)} ${p.help}${p.required ? '' : ' (optional)'}`);
  }
  const flags = Object.entries(c.flags ?? {});
  if (flags.length) {
    lines.push('', 'Flags');
    for (const [n, f] of flags) lines.push(`  ${flagSignature(n, f).padEnd(24)} ${f.help}${f.default !== undefined ? ` (default ${f.default})` : ''}`);
  }
  if (c.aliases?.length) lines.push('', `Also: ${c.aliases.join(', ')}`);
  const needs = c.needs === 'app' ? 'the app running with the agent' : c.needs === 'graph' ? 'a graph (lynkeus map build)' : 'nothing';
  const mcp = c.mcp === 'core' ? '; served over MCP' : overMcp(c, true) ? '; served over MCP with --full' : '';
  lines.push('', `Needs: ${needs}${inSession(c) ? '; available in a session' : ''}${mcp}`);
  return lines.join('\n');
};

const flagRow = (n: string, f: FlagSpec) => `| \`${flagSignature(n, f)}\` | ${f.help}${f.default !== undefined ? ` (default \`${f.default}\`)` : ''} |`;

/** The reference document, generated so it cannot drift from the commands. */
export const referenceMarkdown = (): string => {
  const lines = [
    '# lynkeus command reference',
    '',
    'Generated from the command registry (`lynkeus help --markdown`). Every command accepts the global flags at the end.',
    '',
  ];
  for (const g of inGroups()) {
    lines.push(`## ${g.title}`, '', `${g.blurb}.`, '');
    for (const c of g.list) {
      lines.push(`### \`lynkeus ${signature(c)}\``, '', c.summary + (c.details ? `\n\n${c.details}` : ''), '');
      if (c.positionals?.length) {
        lines.push('| Argument | |', '|---|---|');
        for (const p of c.positionals) lines.push(`| \`${p.name}\` | ${p.help}${p.required ? '' : ' (optional)'} |`);
        lines.push('');
      }
      const flags = Object.entries(c.flags ?? {});
      if (flags.length) lines.push('| Flag | |', '|---|---|', ...flags.map(([n, f]) => flagRow(n, f)), '');
      if (c.aliases?.length) lines.push(`Also accepted: ${c.aliases.map((a) => `\`${a}\``).join(', ')}.`, '');
    }
  }
  lines.push(
    '## Modes',
    '',
    '`lynkeus session` keeps one connection and reads JSON arrays of arguments on stdin, one command per line, answering one JSON object per line (`{ok, out, json?}` or `{ok:false, error, why?}`); `exit` ends it. `lynkeus mcp` serves the core commands as MCP tools over stdio; `lynkeus mcp --full` serves all of them. `lynkeus help <command>` prints one command; `lynkeus help --markdown` prints this document.',
    '',
    '## Global flags',
    '',
    '| Flag | |',
    '|---|---|',
    ...Object.entries(GLOBAL_FLAGS).map(([n, f]) => flagRow(n, f)),
    '',
  );
  return lines.join('\n');
};
