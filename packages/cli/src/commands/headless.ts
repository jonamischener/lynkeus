import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type LynkeusConfig, lynkeusDir, portFromEnv } from '../config.js';
import { describeExplanations, explainError } from '../knowledge/errors.js';
import { type Ctx, define } from '../registry.js';
import { doctor } from './doctor.js';
import { init } from './init.js';

const ENTRY_FLAG = { entry: { type: 'string' as const, help: 'the headless entry (or `entry` in lynkeus.config.json)', value: 'file' } };
const entryOf = (ctx: Ctx) => (ctx.flags.entry as string | undefined) ?? ctx.config.entry ?? 'qa/headless.tsx';

/** The jest test that hosts the app. The port is written in, not read from the environment there: babel would inline the first run's value into jest's transform cache. */
const hostTest = (entryImport: string, port: number | undefined, config: LynkeusConfig, appName: string) => {
  const live = config.live?.join('|');
  const options = [
    'navigation: entry.navigation',
    'token: process.env.LYNKEUS_TOKEN',
    `port: ${port ?? 'undefined'}`,
    'host: process.env.LYNKEUS_HOST',
    `live: ${live ? `/${live}/` : 'undefined'}`,
    `strictMode: ${config.strictMode === true}`,
    `app: { name: ${JSON.stringify(appName)}, runtime: 'headless' }`,
  ];
  return `// Written by \`lynkeus headless start\`; runs the app under jest as a host for the agent.
import { hostApp } from 'lynkeus-headless';
import * as entry from '${entryImport}';

hostApp(() => <entry.App />, { ${options.join(', ')} });
`;
};

export const headlessCommands = [
  define({
    name: 'headless start',
    group: 'headless',
    summary: 'Host the app in Node (jest + RNTL) and wait for a driver; same protocol, no simulator',
    details:
      'Needs LYNKEUS_TOKEN in the environment (the value the app reads for its token). LYNKEUS_PORT moves the host and its driver together; LYNKEUS_HOST says where the driver is listening, for a host that is not in the same place as its driver (a container dialling out, say). Arguments after `--` go to jest. When the host crashes, the last lines say what the error usually means.',
    flags: ENTRY_FLAG,
    aliases: ['headless'],
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const token = process.env.LYNKEUS_TOKEN;
      if (!token)
        return {
          text: 'lynkeus headless needs LYNKEUS_TOKEN in the environment (the same value the app reads for its token): a hosted app talks to a real backend, and without one any local process could drive it.',
          code: 1,
        };
      const entry = entryOf(ctx);
      if (!fs.existsSync(path.join(ctx.root, entry)))
        return { text: `No ${entry} in ${ctx.root}. \`lynkeus headless init\` writes one; it must export \`App\` and, optionally, \`navigation\`.`, code: 1 };
      const testDir = path.join(lynkeusDir(ctx.root), '__tests__');
      const port = portFromEnv(ctx.config);
      // One file per port: two hosts of the same app must not read each other's.
      const testFile = path.join(testDir, port ? `headless-${port}.test.tsx` : 'headless.test.tsx');
      const rel = path
        .relative(testDir, path.join(ctx.root, entry))
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, '');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, hostTest(rel.startsWith('.') ? rel : `./${rel}`, port, ctx.config, path.basename(ctx.root)));
      // Node resolves `localhost` to ::1 first; local backends usually listen on IPv4 only.
      const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');
      const child = spawn('npx', ['jest', testFile, '--runInBand', '--watchAll=false', ...ctx.passthrough], {
        cwd: ctx.root,
        stdio: ['inherit', 'inherit', 'pipe'],
        env: { ...process.env, CI: '1', NODE_OPTIONS: nodeOptions },
      });
      let tail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        tail = (tail + chunk.toString()).slice(-20000);
      });
      const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
      if (code) {
        const found = explainError(tail);
        if (found.length) ctx.err(describeExplanations(found));
      }
      return { code };
    },
  }),
  define({
    name: 'headless init',
    group: 'headless',
    summary: 'Write the headless entry: default mocks, a local-backend guard, your App',
    flags: {
      ...ENTRY_FLAG,
      component: { type: 'string', help: 'the App component file (found by itself when standard)', value: 'App.tsx' },
      'api-env': { type: 'string', help: 'the env var the app reads its API base from', value: 'NAME' },
      auto: { type: 'boolean', help: 'also mount the agent from index.js with auto()' },
      force: { type: 'boolean', help: 'overwrite an existing entry' },
    },
    needs: 'nothing',
    run: async (ctx) => {
      const lines = init(ctx.root, {
        entry: entryOf(ctx),
        app: ctx.flags.component as string | undefined,
        apiEnv: (ctx.flags['api-env'] as string | undefined) ?? ctx.config.apiEnv ?? 'API_URL',
        auto: !!ctx.flags.auto,
        force: !!ctx.flags.force,
        locale: { ...ctx.config.locale, language: ctx.config.language },
      });
      return { text: lines.join('\n'), json: lines };
    },
  }),
  define({
    name: 'headless doctor',
    group: 'headless',
    summary: 'What lynkeus mocks, and which native modules still need one',
    flags: {
      ...ENTRY_FLAG,
      fix: { type: 'boolean', help: 'write stubs for the uncovered modules into the entry' },
      explain: { type: 'string', help: 'turn a jest error into its usual cause and fix', value: 'text' },
    },
    needs: 'nothing',
    run: async (ctx) => {
      if (ctx.flags.explain) {
        const found = explainError(ctx.flags.explain as string);
        return {
          text: found.length ? describeExplanations(found).trim() : 'nothing in the catalogue matches; paste the first line of the error, not the stack.',
          json: found,
        };
      }
      return doctor(ctx.root, entryOf(ctx), { fix: !!ctx.flags.fix }).join('\n');
    },
  }),
];
