/**
 * How each case has done across runs, kept in one JSON file: the last results,
 * how often it needed its second chance, the step it last died on. A case that
 * passes and fails without anything changing is the one to look at first.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CaseReport } from './runner.js';

const KEPT = 20;

export type Outcome = { at: string; result: CaseReport['result']; retried: boolean; step?: string; error?: string };
export type Ledger = Record<string, { runs: number; failed: number; retried: number; last: Outcome[] }>;

export class Flakes {
  private readonly ledger: Ledger;

  constructor(private readonly file: string) {
    let read: Ledger = {};
    try {
      read = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
    } catch {
      // No ledger yet, or one this cannot read: start a new one.
    }
    this.ledger = read;
  }

  note(report: CaseReport & { retried?: boolean }, at = new Date()): void {
    const entry = this.ledger[report.id] ?? { runs: 0, failed: 0, retried: 0, last: [] };
    this.ledger[report.id] = entry;
    const broke = report.steps.find((s) => s.status === 'failed');
    entry.runs += 1;
    if (report.result === 'failed') entry.failed += 1;
    if (report.retried) entry.retried += 1;
    entry.last = [
      ...entry.last,
      {
        at: at.toISOString(),
        result: report.result,
        retried: !!report.retried,
        ...(broke ? { step: broke.step, error: broke.error?.split('\n')[0] } : {}),
      },
    ].slice(-KEPT);
  }

  /** The cases among `ids` whose recent runs disagree with each other, worded for a summary. */
  flaky(ids: string[]): string[] {
    return ids.flatMap((id) => {
      const last = this.ledger[id]?.last ?? [];
      const shaky = last.filter((o) => o.result === 'failed' || o.retried).length;
      if (shaky === 0 || shaky === last.length) return [];
      return [`⚠ ${id} is flaky: ${shaky} of its last ${last.length} runs failed or needed a second chance`];
    });
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.ledger, null, 2)}\n`);
  }
}
