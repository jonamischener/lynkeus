/**
 * Writes a run of cases as the directory `lynkeus-protocol` describes: run.json
 * and cases.jsonl. The manifest is written at the start and again at the end,
 * so a run that was cut short still says when it began and what it ran on.
 */
import fs from 'node:fs';
import path from 'node:path';

import { RUN_SCHEMA, type RunCase, type RunManifest, type RunStep } from 'lynkeus-protocol';

import type { Case } from './format.js';
import type { CaseReport } from './runner.js';

export type Attempt = { report: CaseReport; attempt: number; startedAt: Date };

export const toRunCase = (c: Case, { report, attempt, startedAt }: Attempt, root: string): RunCase => {
  const steps: RunStep[] = report.steps.map((s, index) => {
    // The runner numbers an event's step from 1, in the order the steps ran.
    const events = (report.events ?? []).filter((e) => e.step === index + 1);
    return {
      step: s.step,
      status: s.status,
      ms: s.ms,
      ...(s.error ? { error: s.error } : {}),
      section: index < c.setup.length ? 'setup' : 'steps',
      ...(events.length > 0
        ? {
            events: events.map((e) => ({
              origin: 'app' as const,
              name: e.name,
              ...(e.props ? { props: e.props } : {}),
              ...(e.route ? { route: e.route } : {}),
            })),
          }
        : {}),
    };
  });
  const description = typeof c.meta.description === 'string' ? c.meta.description : undefined;
  return {
    id: report.id,
    ...(report.title ? { title: report.title } : {}),
    ...(description ? { description } : {}),
    file: path.relative(root, path.resolve(root, report.file)),
    attempt,
    result: report.result,
    startedAt: startedAt.toISOString(),
    ms: report.ms,
    steps,
    ...(report.evidence ? { evidence: report.evidence } : {}),
  };
};

export class RunFile {
  private readonly manifest: RunManifest;
  private readonly last = new Map<string, { result: RunCase['result']; attempt: number }>();

  constructor(
    private readonly dir: string,
    private readonly root: string,
    startedAt = new Date(),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cases.jsonl'), '');
    this.manifest = { schema: RUN_SCHEMA, startedAt: startedAt.toISOString() };
    this.save();
  }

  add(c: Case, attempt: Attempt): void {
    const line = toRunCase(c, attempt, this.root);
    fs.appendFileSync(path.join(this.dir, 'cases.jsonl'), `${JSON.stringify(line)}\n`);
    this.last.set(line.id, { result: line.result, attempt: line.attempt });
  }

  finish(app: { platform?: string; native?: boolean } = {}, finishedAt = new Date()): void {
    const cases = [...this.last.values()];
    this.manifest.finishedAt = finishedAt.toISOString();
    if (app.platform) this.manifest.platform = app.platform;
    if (app.native !== undefined) this.manifest.native = app.native;
    this.manifest.totals = {
      cases: cases.length,
      passed: cases.filter((c) => c.result === 'passed').length,
      failed: cases.filter((c) => c.result === 'failed').length,
      unsupported: cases.filter((c) => c.result === 'unsupported').length,
      retried: cases.filter((c) => c.attempt > 1).length,
    };
    this.save();
  }

  private save(): void {
    fs.writeFileSync(path.join(this.dir, 'run.json'), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }
}
