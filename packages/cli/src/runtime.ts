/**
 * Runs one command from an argv: resolve, parse, run, and on failure read the
 * evidence. The terminal, session lines, a recording's stdin, cases and the
 * MCP server all come through here.
 */
import { UsageError } from './args.js';
import { describeWhy, explain } from './knowledge/why.js';
import { type Base, helpFor, parseFor, resolve } from './registry.js';
import { type Expected, expectedOf } from './targets.js';

export type Outcome = { text?: string; json?: unknown; code: number; error?: string; why?: string };

/** The screen, requests and trace after a failure, read as rules; empty when there is nothing to read. */
export const whyFor = async (base: Base, expected?: Expected): Promise<string> => {
  try {
    const device = await base.device();
    const [screen, requests, trace] = await Promise.all([device.screen(), device.requests(), device.trace()]);
    return describeWhy(
      explain({ screen, requests: requests.requests.slice(-40), inFlight: requests.inFlight, trace: trace.events.slice(-40), target: expected }),
    );
  } catch {
    return '';
  }
};

const TARGET_ARG: Record<string, number> = { press: 0, see: 0, wait: 0, swipe: 1, nav: 0, type: 1 };

export const execute = async (argv: string[], base: Base): Promise<Outcome> => {
  const found = resolve(argv);
  if (!found) return { code: 2, error: `unknown command "${argv.slice(0, 2).join(' ')}"; \`lynkeus help\` lists them` };
  const { command, rest } = found;
  let parsed: ReturnType<typeof parseFor>;
  try {
    parsed = parseFor(command, rest);
  } catch (error) {
    if (error instanceof UsageError) return { code: 2, error: `${error.message}\n\n${helpFor(command)}` };
    throw error;
  }
  if (parsed.flags.help) return { code: 0, text: helpFor(command) };
  try {
    const result = await command.run({ ...base, ...parsed });
    if (result === undefined) return { code: 0 };
    if (typeof result === 'string') return { code: 0, text: result };
    return { code: result.code ?? 0, text: result.text ?? (result.json === undefined ? undefined : JSON.stringify(result.json)), json: result.json };
  } catch (error) {
    const out: Outcome = { code: 1, error: error instanceof Error ? error.message : String(error) };
    const at = TARGET_ARG[command.name];
    if (at !== undefined) {
      const why = await whyFor(base, expectedOf(parsed.args[at]));
      if (why) out.why = why;
    }
    return out;
  }
};
