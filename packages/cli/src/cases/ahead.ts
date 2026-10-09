/**
 * Setups made ahead of their cases. `case prepare` runs, in the order a suite
 * will, the setup of every case that needs only the project's fixtures, and
 * leaves what it produced here, one file a case; `case run` takes the file
 * when its case starts and goes straight to the steps.
 *
 * A case that starts before its setup is ready marks itself started, runs its
 * own setup, and the preparer skips it. Files are taken with a rename, so two
 * processes never get the same one.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Case } from './format.js';
import type { Prepared } from './runner.js';

// What a backend held a quarter of an hour ago may have moved on (a session, a rate).
const MAX_AGE_MS = 15 * 60_000;

type Kept = { setup: string; at: number; prepared: Prepared };

export class Ahead {
  constructor(private readonly dir: string) {}

  #file(c: Case, suffix = '.json') {
    return path.join(this.dir, `${c.id.replace(/[^\w.-]+/g, '_')}${suffix}`);
  }

  clear(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
  }

  start(c: Case): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.#file(c, '.started'), '');
  }

  started(c: Case): boolean {
    return fs.existsSync(this.#file(c, '.started'));
  }

  keep(c: Case, prepared: Prepared): void {
    // Its case started while this was being made, and ran a setup of its own.
    if (this.started(c)) return;
    const file = this.#file(c);
    const kept: Kept = { setup: JSON.stringify(c.setup), at: Date.now(), prepared };
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Setups made and not yet taken by a case that is still to start. */
  waiting(): number {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json') && !fs.existsSync(path.join(this.dir, f.replace(/\.json$/, '.started')))).length;
  }

  /** The case's setup if it was made, is recent and is the setup the case has now. */
  take(c: Case): Prepared | undefined {
    const file = this.#file(c);
    const mine = `${file}.${process.pid}`;
    try {
      fs.renameSync(file, mine);
    } catch {
      return undefined;
    }
    try {
      const kept = JSON.parse(fs.readFileSync(mine, 'utf8')) as Kept;
      return kept.setup === JSON.stringify(c.setup) && Date.now() - kept.at < MAX_AGE_MS ? kept.prepared : undefined;
    } catch {
      return undefined;
    } finally {
      fs.rmSync(mine, { force: true });
    }
  }
}
