#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';

import { AgentServer } from 'lynkeus-client';

import { GLOBAL_FLAGS } from './args.js';
import { caseCommands } from './commands/cases.js';
import { driveCommands } from './commands/drive.js';
import { headlessCommands } from './commands/headless.js';
import { mapCommands } from './commands/map.js';
import { osCommands } from './commands/os.js';
import { reportCommands } from './commands/report.js';
import { runsCommands } from './commands/runs.js';
import { graphFile, loadConfig, loadGraph, portFromEnv } from './config.js';
import { HEADLESS_HOST, pickAgentDevice } from './device/devices.js';
import { Device } from './device/driver.js';
import { type Base, commands, find, helpFor, inSession, referenceMarkdown, register, resolve, usage } from './registry.js';
import { execute } from './runtime.js';

register([...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...caseCommands, ...reportCommands, ...headlessCommands]);

/** The global flags, read leniently from the whole argv before any command parses its own. */
const globals = (argv: string[]) => {
  const out: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--') break;
    if (!t.startsWith('--')) continue;
    const name = t.slice(2).split('=')[0]!;
    const spec = GLOBAL_FLAGS[name];
    if (!spec) continue;
    if (spec.type === 'boolean') out[name] = true;
    else out[name] = t.includes('=') ? t.slice(t.indexOf('=') + 1) : argv[i + 1];
  }
  return out;
};

export type Session = { ctx: Base; stop: () => Promise<void> };

// `ownHost`: the port belongs to a host this run started for a case; whatever dials in is the device.
const contextFor = (argv: string[], attached = false, port?: number, ownHost = false): Session => {
  const g = globals(argv);
  const root = path.resolve((g.root as string | undefined) ?? process.cwd());
  const config = loadConfig(root);
  const err = (line: string) => console.error(line);
  let graph: ReturnType<typeof loadGraph> | undefined;
  let device: Promise<Device> | undefined;

  const connect = async (): Promise<Device> => {
    const appId = (g.app as string | undefined) ?? process.env.LYNKEUS_APP_ID ?? config.app;
    const started = performance.now();
    const attachedIn = (d: Device) => err(`attached in ${Math.round(performance.now() - started)}ms (${d.info.name})`);
    const server = new AgentServer({ token: process.env.LYNKEUS_TOKEN, port: port ?? portFromEnv(config) });
    // A host started for the case is the device: looking for the configured simulator would only replace a
    // late app's error with one about a simulator nobody asked for.
    const picking = ownHost ? Promise.resolve(HEADLESS_HOST) : pickAgentDevice((g.device as string | undefined) ?? process.env.LYNKEUS_DEVICE ?? config.device);
    if (g.launch && appId) {
      const d = new Device(await picking, { appId, server });
      await d.launchApp(appId, { fresh: true });
      attachedIn(d);
      return d;
    }
    // Asking the OS which simulators are up takes longer than the app takes to dial in, so listen first.
    picking.catch(() => undefined);
    await server.listen();
    const hello = await server
      .waitForApp(Number(g['attach-timeout'] ?? process.env.LYNKEUS_ATTACH_TIMEOUT_MS ?? config.attachTimeout ?? 15000))
      .catch(async (error) => {
        await server.close();
        await picking;
        throw error;
      });
    const headless = hello.app?.runtime === 'headless';
    const info = {
      ...HEADLESS_HOST,
      name: headless ? HEADLESS_HOST.name : String(hello.app?.name ?? hello.platform),
      platform: hello.platform === 'android' ? ('android' as const) : ('ios' as const),
    };
    const d = new Device(info, { appId: appId ?? null, server, resolving: headless || ownHost ? undefined : picking });
    attachedIn(d);
    return d;
  };

  const ctx: Base = {
    root,
    config,
    attached,
    err,
    graph: () => {
      graph ??= loadGraph(root);
      if (!graph) throw new Error(`No graph at ${graphFile(root)}: run \`lynkeus map build\` in the app's folder first.`);
      return graph;
    },
    device: () => {
      device ??= connect();
      return device;
    },
    forPort: (other) => {
      const scoped = contextFor(argv, attached, other, true);
      return { base: scoped.ctx, stop: scoped.stop };
    },
  };
  return {
    ctx,
    stop: async () => {
      await device?.then((d) => d.stop()).catch(() => undefined);
    },
  };
};

/** Each stdin line is a JSON array of arguments (`["press", "#x"]`); each answer is one JSON line. */
const session = async (argv: string[]) => {
  const { ctx, stop } = contextFor(argv, true);
  const device = await ctx.device();
  console.log(JSON.stringify({ ok: true, out: `attached (${device.info.name})` }));
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let av: string[];
    try {
      av = JSON.parse(line) as string[];
    } catch {
      console.log(JSON.stringify({ ok: false, error: 'each line must be a JSON array of arguments' }));
      continue;
    }
    if (av[0] === 'exit') break;
    const found = resolve(av)?.command;
    if (found && !inSession(found)) {
      console.log(JSON.stringify({ ok: false, error: `${found.name} is not available in a session` }));
      continue;
    }
    const r = await execute(av, ctx);
    console.log(
      JSON.stringify(
        r.error
          ? { ok: false, error: r.error, ...(r.why ? { why: r.why } : {}) }
          : { ok: r.code === 0, out: r.text ?? '', ...(r.json !== undefined ? { json: r.json } : {}) },
      ),
    );
  }
  await stop();
};

const help = (argv: string[]) => {
  if (argv.includes('--markdown')) return referenceMarkdown();
  const topic = argv
    .slice(1)
    .filter((a) => !a.startsWith('--'))
    .join(' ');
  if (!topic) return usage();
  const c = find(topic);
  return c ? helpFor(c) : `no command "${topic}"\n\n${usage()}`;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const [first] = argv;
  if (!first || first === 'help' || first === '--help') return console.log(help(argv));
  if (first === 'commands')
    return console.log(
      commands()
        .map((c) => c.name)
        .join('\n'),
    );
  if (first === 'mcp') {
    const { serve } = await import('./mcp/server.js');
    return serve(contextFor(argv, true), { full: argv.includes('--full') });
  }
  if (first === 'session') {
    await session(argv);
    return process.exit(0);
  }
  const { ctx, stop } = contextFor(argv);
  const outcome = await execute(argv, ctx);
  if (outcome.error) {
    console.error(`✗ ${outcome.error}`);
    if (outcome.why) console.error(`why:\n${outcome.why}`);
  } else if (globals(argv).json && outcome.json !== undefined) console.log(JSON.stringify(outcome.json, null, 2));
  else if (outcome.text) console.log(outcome.text);
  await stop();
  process.exit(outcome.code);
};

void main();
