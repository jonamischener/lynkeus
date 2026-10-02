import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { FlagSpec } from '../args.js';
import type { Session } from '../cli.js';
import { type Command, commands, overMcp } from '../registry.js';
import { execute } from '../runtime.js';
import { TARGET_HELP } from '../targets.js';

const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

type Property = { type: string; items?: { type: string }; description: string };

const propertyFor = (f: FlagSpec): Property => ({
  type: f.type === 'list' ? 'array' : f.type,
  ...(f.type === 'list' ? { items: { type: 'string' } } : {}),
  description: f.help + (f.default !== undefined ? ` (default ${f.default})` : ''),
});

const describe = (c: Command) => {
  const details = c.mcpDetails ?? c.details;
  return details ? `${c.summary}\n\n${details}` : c.summary;
};

const identifier = (name: string) => name.replace(/[^a-z0-9]+/gi, '_');

// Written by hand: a schema library adds fields to every tool that a model pays for on every turn.
const schemaFor = (c: Command) => {
  const properties: Record<string, Property> = {};
  const required: string[] = [];
  for (const p of c.positionals ?? []) {
    const key = identifier(p.name);
    properties[key] = p.rest ? { type: 'array', items: { type: 'string' }, description: p.help } : { type: 'string', description: p.help };
    if (p.required) required.push(key);
  }
  for (const [name, f] of Object.entries(c.flags ?? {})) if (!c.mcpOmit?.includes(name)) properties[identifier(name)] = propertyFor(f);
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}) };
};

/** Back to an argv, so the same runtime serves both surfaces. */
const argvFor = (c: Command, input: Record<string, unknown>): string[] => {
  const av = c.name.split(' ');
  for (const p of c.positionals ?? []) {
    const v = input[identifier(p.name)];
    if (v === undefined) continue;
    if (Array.isArray(v)) av.push(...v.map(String));
    else av.push(String(v));
  }
  for (const [name, f] of Object.entries(c.flags ?? {})) {
    const v = input[identifier(name)];
    if (v === undefined) continue;
    if (f.type === 'boolean') {
      if (v) av.push(`--${name}`);
    } else if (f.type === 'list') for (const item of v as string[]) av.push(`--${name}`, item);
    else av.push(`--${name}`, String(v));
  }
  return av;
};

export const serve = async (session: Session, options: { full?: boolean } = {}) => {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  const server = new Server({ name: 'lynkeus', version }, { capabilities: { tools: {} } });
  const served = commands().filter((c) => overMcp(c, !!options.full));
  const byName = new Map(served.map((c) => [identifier(c.name), c]));
  // So a model reading the app's screens knows their language before it starts guessing.
  const { config } = session.ctx;
  const locale = config.language || config.locale ? JSON.stringify({ language: config.language, ...config.locale }, null, 2) : undefined;

  // The grammar of a target is spelled where a model meets it first; after that it is a word.
  let spelled = false;
  const once = (help: string) => {
    if (!help.includes(TARGET_HELP)) return help;
    const out = spelled ? help.replace(TARGET_HELP, 'target') : help;
    spelled = true;
    return out;
  };
  const tools = served.map((c) => {
    const schema = schemaFor(c);
    for (const property of Object.values(schema.properties)) property.description = once(property.description);
    return { name: identifier(c.name), description: describe(c), inputSchema: schema };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(locale
        ? [
            {
              name: 'app_locale',
              description: 'The language and region this app is built for, as its own configuration declares them.',
              inputSchema: { type: 'object' as const, properties: {} },
            },
          ]
        : []),
      ...tools,
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'app_locale' && locale) return text(locale);
    const c = byName.get(request.params.name);
    if (!c) return { ...text(`✗ no tool ${request.params.name}`), isError: true };
    const r = await execute(argvFor(c, (request.params.arguments ?? {}) as Record<string, unknown>), session.ctx);
    if (r.error) return { ...text(`✗ ${r.error}${r.why ? `\n\nwhy:\n${r.why}` : ''}`), isError: true };
    return text(r.text || (r.json !== undefined ? JSON.stringify(r.json, null, 2) : 'ok'));
  });
  await server.connect(new StdioServerTransport());
};
