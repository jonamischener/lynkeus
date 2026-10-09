/**
 * Fixtures are how a case prepares and reads the backend, and lynkeus knows
 * nothing about them: a project declares one long-lived command and lynkeus
 * speaks JSON lines to it. One line in per step —
 *
 *   {"command": "create_user", "params": {"plan": "pro"}, "env": {"PLAN": "pro"}}
 *
 * — and one line out, the step's answer: any JSON object, `"ok": false` and an
 * `error` when it failed. `params` is the step as written; `env` is the same
 * flattened to upper-case strings, for a server that hands them to a script.
 *
 * Before the first case lynkeus asks what the server can do —
 *
 *   {"command": "lynkeus.describe", "params": {}, "env": {}}
 *
 * — and a server that knows answers `{"commands": ["create_user", …]}`. With
 * that, a case naming a fixture nobody answers is refused before anything
 * runs. A server that answers `"ok": false`, as one written before this did,
 * is taken to describe nothing, and its cases run unchecked.
 *
 * A connection that makes cases' setups ahead of time (`case prepare`) says so
 * first, with `lynkeus.ahead`, so a server may give its work a lower priority
 * than the cases running meanwhile. A server that does not know it is free to
 * answer anything.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

export type FixturesConfig = { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number };

export type Answer = Record<string, unknown>;

/** The one command that is lynkeus's own and not the project's. */
export const DESCRIBE = 'lynkeus.describe';

export type Description = { commands: string[] };

/** lynkeus's second own command: this connection works ahead of the cases. */
export const AHEAD = 'lynkeus.ahead';

const envOf = (params: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), typeof v === 'object' ? JSON.stringify(v) : String(v)]),
  );

export class Fixtures {
  #config: FixturesConfig;
  #root: string;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: string[] = [];
  #waiting: ((line: string | null) => void) | null = null;
  #stderr = '';

  constructor(config: FixturesConfig, root: string) {
    this.#config = config;
    this.#root = root;
  }

  #start(): ChildProcessWithoutNullStreams {
    if (this.#child) return this.#child;
    const child = spawn(this.#config.command, {
      shell: true,
      // Its own process group, so closing takes the shell and what it started.
      detached: true,
      cwd: path.resolve(this.#root, this.#config.cwd ?? '.'),
      env: { ...process.env, ...this.#config.env },
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-4000);
    });
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      if (this.#waiting) {
        const resolve = this.#waiting;
        this.#waiting = null;
        resolve(line);
      } else this.#lines.push(line);
    });
    child.on('close', () => {
      this.#child = null;
      this.#waiting?.(null);
      this.#waiting = null;
    });
    this.#child = child;
    return child;
  }

  async call(command: string, params: Record<string, unknown>): Promise<Answer> {
    const child = this.#start();
    child.stdin.write(`${JSON.stringify({ command, params, env: envOf(params) })}\n`);
    const timeoutMs = this.#config.timeoutMs ?? 120_000;
    const line = await new Promise<string | null>((resolve, reject) => {
      const ready = this.#lines.shift();
      if (ready !== undefined) return resolve(ready);
      const timer = setTimeout(() => {
        this.#waiting = null;
        reject(new Error(`${command}: the fixtures command did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiting = (answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
    });
    if (line === null)
      throw new Error(`${command}: the fixtures command ended${this.#stderr ? `: ${this.#stderr.trim().split('\n').slice(-3).join(' · ')}` : ''}`);
    const answer = JSON.parse(line) as Answer;
    if (answer.ok === false) throw new Error(`${command}: ${String(answer.error ?? answer.message ?? 'ok=false')}`);
    return answer;
  }

  /** What the server says it answers, or nothing when it does not say. */
  async describe(): Promise<Description | undefined> {
    const answer = await this.call(DESCRIBE, {}).catch(() => undefined);
    const commands = answer?.commands;
    return Array.isArray(commands) && commands.every((c) => typeof c === 'string') ? { commands } : undefined;
  }

  /** Says this connection works ahead of the cases being run. Whatever the server answers, it goes on. */
  async ahead(): Promise<void> {
    await this.call(AHEAD, {}).catch(() => undefined);
  }

  close(): void {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.stdin.end();
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}
