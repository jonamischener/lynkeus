import fs from 'node:fs';
import path from 'node:path';

import { define } from '../registry.js';

type Fetch = typeof fetch;

export type Pushed = { url: string; files: number; refused: string[] };

const answer = async (response: Response, doing: string) => {
  if (response.ok) return response.json() as Promise<Record<string, unknown>>;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(`${doing}: ${body.error ?? `the service answered ${response.status}`}`);
};

/**
 * Uploads a run directory (`case run --out`) to the reports service: the run, its cases, then every frame and
 * film the cases name. A file the organisation's plan does not keep (a film on Free) is left out and listed.
 */
export const pushRun = async (dir: string, o: { url: string; key: string; project: string; fetch?: Fetch }): Promise<Pushed> => {
  const call = o.fetch ?? fetch;
  const auth = { authorization: `Bearer ${o.key}` };
  const base = o.url.replace(/\/+$/, '');
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as unknown;
  const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8');

  const created = await answer(
    await call(`${base}/v1/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: o.project, run }),
    }),
    'creating the run',
  );
  const id = String(created.id);
  await answer(await call(`${base}/v1/runs/${id}/cases`, { method: 'PUT', headers: auth, body: cases }), 'sending its cases');

  const named = new Set<string>();
  for (const line of cases.split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { video?: string; steps?: { screenshot?: string }[] };
    for (const p of [c.video, ...(c.steps ?? []).map((s) => s.screenshot)]) if (p) named.add(p);
  }
  let files = 0;
  const refused: string[] = [];
  for (const file of named) {
    const local = path.join(dir, file);
    if (!fs.existsSync(local)) continue;
    const response = await call(`${base}/v1/runs/${id}/files/${file.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: auth,
      body: fs.readFileSync(local),
    });
    if (response.status === 402) refused.push(file);
    else {
      await answer(response, `sending ${file}`);
      files += 1;
    }
  }
  const finished = await answer(await call(`${base}/v1/runs/${id}/finish`, { method: 'POST', headers: auth }), 'finishing the run');
  return { url: String(finished.url), files, refused };
};

export const reportCommands = [
  define({
    name: 'report push',
    group: 'runs',
    summary: 'Upload a run to the reports service and print the report’s address',
    details:
      'Uploads what `case run --out <dir>` wrote: the run, its cases, and every frame and film they name. The report shows the film in step with the steps, the events each step sent, and why a case failed. The service and the organisation’s key come from LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY; a film the organisation’s plan does not keep is left out and said so.',
    positionals: [{ name: 'dir', help: 'the run directory `case run --out` wrote', required: true }],
    flags: {
      project: { type: 'string', help: 'the project the run is filed under (default: the app’s folder name)', value: 'name' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const dir = path.resolve(ctx.args[0]!);
      if (!fs.existsSync(path.join(dir, 'cases.jsonl')))
        return { text: `${ctx.args[0]}: no cases.jsonl; pass the directory \`case run --out\` wrote`, code: 2 };
      const url = process.env.LYNKEUS_REPORTS_URL;
      const key = process.env.LYNKEUS_REPORTS_KEY;
      if (!url || !key) return { text: 'set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY (the organisation’s API key)', code: 2 };
      const project = typeof ctx.flags.project === 'string' ? ctx.flags.project : path.basename(ctx.root);
      try {
        const pushed = await pushRun(dir, { url, key, project });
        const notes = pushed.refused.length ? `\nnot kept on this plan: ${pushed.refused.join(', ')}` : '';
        return { text: `${pushed.url}${notes}`, json: pushed };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
];
