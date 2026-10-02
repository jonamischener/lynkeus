/**
 * Booleans never consume the next token (`--direct a.ts` keeps `a.ts`),
 * `--no-<flag>` clears one, and a repeated list flag collects.
 */
export type FlagSpec = {
  type: 'string' | 'number' | 'boolean' | 'list';
  help: string;
  default?: string | number | boolean;
  /** The placeholder in usage: `--timeout <ms>`. */
  value?: string;
};

export type PositionalSpec = {
  name: string;
  help: string;
  required?: boolean;
  /** Takes every argument left. */
  rest?: boolean;
};

export type FlagValues = Record<string, string | number | boolean | string[] | undefined>;

export class UsageError extends Error {}

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  root: { type: 'string', help: "the app's folder (default: the current one)", value: 'dir' },
  device: { type: 'string', help: 'simulator udid or name', value: 'udid|name' },
  app: { type: 'string', help: 'bundle id, for launching and simulator commands', value: 'bundleId' },
  launch: { type: 'boolean', help: 'relaunch the app before attaching (needs --app)' },
  'attach-timeout': { type: 'number', help: 'how long to wait for the app to attach', default: 15000, value: 'ms' },
  json: { type: 'boolean', help: 'machine-readable output when the command has one' },
  help: { type: 'boolean', help: 'this text' },
};

export const parseArgs = (
  argv: string[],
  positionals: PositionalSpec[] = [],
  flags: Record<string, FlagSpec> = {},
): { args: string[]; flags: FlagValues; passthrough: string[] } => {
  const specs = { ...GLOBAL_FLAGS, ...flags };
  const out: FlagValues = {};
  const args: string[] = [];
  let passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      let name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      let inline = eq === -1 ? undefined : token.slice(eq + 1);
      let negated = false;
      if (!specs[name] && name.startsWith('no-') && specs[name.slice(3)]?.type === 'boolean') {
        name = name.slice(3);
        negated = true;
      }
      const spec = specs[name];
      if (!spec)
        throw new UsageError(
          `unknown flag --${name}; flags: ${Object.keys(specs)
            .map((f) => `--${f}`)
            .join(' ')}`,
        );
      if (spec.type === 'boolean') {
        out[name] = !negated && (inline === undefined ? true : inline !== 'false');
        continue;
      }
      if (inline === undefined) {
        inline = argv[i + 1];
        if (inline === undefined || (inline.startsWith('--') && inline.length > 2))
          throw new UsageError(`--${name} needs a value${spec.value ? ` <${spec.value}>` : ''}`);
        i++;
      }
      if (spec.type === 'number') {
        const n = Number(inline);
        if (Number.isNaN(n)) throw new UsageError(`--${name} expects a number, got "${inline}"`);
        out[name] = n;
      } else if (spec.type === 'list') {
        out[name] = [...((out[name] as string[] | undefined) ?? []), inline];
      } else out[name] = inline;
      continue;
    }
    args.push(token);
  }
  for (const [name, spec] of Object.entries(specs)) if (out[name] === undefined && spec.default !== undefined) out[name] = spec.default;
  const required = positionals.filter((p) => p.required);
  if (args.length < required.length)
    throw new UsageError(
      `missing ${required
        .slice(args.length)
        .map((p) => `<${p.name}>`)
        .join(' ')}`,
    );
  const last = positionals[positionals.length - 1];
  if (!last?.rest && args.length > positionals.length) throw new UsageError(`unexpected argument "${args[positionals.length]}"`);
  return { args, flags: out, passthrough };
};

export const pairs = (list: string[] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const eq = item.indexOf('=');
    if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
};

/** Double quotes group; everything else splits on spaces. */
export const splitLine = (line: string): string[] => (line.match(/"[^"]*"|\S+/g) ?? []).map((a) => a.replace(/^"|"$/g, ''));
