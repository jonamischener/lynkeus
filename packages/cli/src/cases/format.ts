/**
 * A case is a markdown file a person can read: YAML frontmatter that says what
 * it is, and a YAML body that says what to prepare (`setup`), what to do
 * (`steps`) and what that proves (`expected`). Each step is one key: an
 * `app.<verb>` drives the app, `assert` reads the backend, `exec` runs a shell
 * command, and any other name is a fixture the project declared.
 */
import fs from 'node:fs';

import { parse } from 'yaml';

export type StepValue = string | number | boolean | null | Record<string, unknown> | unknown[];
export type Step = { verb: string; value: StepValue; on?: string };

export type Case = {
  file: string;
  id: string;
  title?: string;
  meta: Record<string, unknown>;
  setup: Step[];
  steps: Step[];
  expected?: string;
};

/** A bare verb, or one `verb: value`. */
export const stepOf = (item: unknown, where = 'a step'): Step => {
  if (typeof item === 'string') return { verb: item, value: null };
  const keys = item && typeof item === 'object' ? Object.keys(item) : [];
  if (keys.length !== 1) throw new Error(`${where} must be one step, as \`verb: value\`, not ${JSON.stringify(item)}`);
  return { verb: keys[0]!, value: (item as Record<string, StepValue>)[keys[0]!]! };
};

const stepsOf = (list: unknown, file: string, section: string): Step[] => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`${file}: ${section} is not a list`);
  return list.flatMap((item, i) => {
    const entry = item as Record<string, unknown> | null;
    if (entry && typeof entry === 'object' && 'do' in entry) {
      if (typeof entry.on !== 'string') throw new Error(`${file}: ${section}[${i}] has \`do\` without \`on\``);
      const inner = Array.isArray(entry.do) ? entry.do : [entry.do];
      return inner.map((s, j) => ({ ...stepOf(s, `${file}: ${section}[${i}].do[${j}]`), on: entry.on as string }));
    }
    return [stepOf(item, `${file}: ${section}[${i}]`)];
  });
};

export const parseCase = (text: string, file: string): Case => {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no frontmatter (a case starts with --- and its id)`);
  const meta = (parse(match[1]!) ?? {}) as Record<string, unknown>;
  const body = (parse(match[2]!) ?? {}) as Record<string, unknown>;
  const id = typeof meta.id === 'string' ? meta.id : file.replace(/^.*\//, '').replace(/\.md$/, '');
  return {
    file,
    id,
    title: typeof meta.title === 'string' ? meta.title : undefined,
    meta,
    setup: stepsOf(body.setup, file, 'setup'),
    steps: stepsOf(body.steps, file, 'steps'),
    expected: typeof body.expected === 'string' ? body.expected.trim() : undefined,
  };
};

const variantsOf = (text: string): Record<string, unknown>[] => {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const matrix = head ? ((parse(head[1]!) ?? {}) as Record<string, unknown>).matrix : undefined;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix) || Object.keys(matrix).length === 0) return [];
  return Object.entries(matrix as Record<string, unknown>).reduce<Record<string, unknown>[]>(
    (combos, [key, values]) => combos.flatMap((combo) => (Array.isArray(values) ? values : [values]).map((v) => ({ ...combo, [key]: v }))),
    [{}],
  );
};

export const readCases = (file: string): Case[] => {
  const text = fs.readFileSync(file, 'utf8');
  const variants = variantsOf(text);
  if (variants.length === 0) return [parseCase(text, file)];
  return variants.map((variant) => {
    const filled = text.replace(/\{\{\s*matrix\.(\w+)\s*\}\}/g, (ref, key: string) => {
      if (!(key in variant)) throw new Error(`${file}: ${ref} is not in its matrix`);
      return String(variant[key]);
    });
    const c = parseCase(filled, file);
    return {
      ...c,
      id: `${c.id}[${Object.entries(variant)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')}]`,
    };
  });
};

/** `a.b.0.c` into a value; `a.*.b` collects b from every element of the list a. */
export const dig = (json: unknown, dotted: string): unknown => {
  const star = dotted.indexOf('.*.');
  if (star !== -1) {
    const list = dig(json, dotted.slice(0, star));
    return Array.isArray(list) ? list.map((item) => dig(item, dotted.slice(star + 3))) : undefined;
  }
  let current: unknown = json;
  for (const key of dotted.split('.')) {
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const random = (kind: string): string | undefined => {
  if (kind === 'letters') return Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * 26)]).join('');
  if (kind === 'digits') return Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  return undefined;
};

export type Scope = Record<string, unknown>;

/** `{{alias.path}}` from what earlier steps answered, `{{random.letters}}`, `{{env.NAME}}`. */
export const interpolate = <T>(value: T, scope: Scope): T => {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([\w-]+)\.([\w.*-]+)\s*\}\}$/.exec(value);
    const lookup = (name: string, path: string): unknown => {
      if (name === 'random') return random(path);
      if (name === 'env') return process.env[path];
      if (!(name in scope)) throw new Error(`no alias '${name}' (add \`as: ${name}\` to the step that creates it)`);
      return dig(scope[name], path);
    };
    // A value that is one reference keeps its type; inside a sentence it is text.
    if (whole) {
      const found = lookup(whole[1]!, whole[2]!);
      if (found === undefined || found === null) throw new Error(`${value} is empty`);
      return found as T;
    }
    return value.replace(/\{\{\s*([\w-]+)\.([\w.*-]+)\s*\}\}/g, (ref, name: string, path: string) => {
      const found = lookup(name, path);
      if (found === undefined || found === null) throw new Error(`${ref} is empty`);
      return typeof found === 'object' ? JSON.stringify(found) : String(found);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, scope)])) as T;
  return value;
};

export type Matcher = {
  equals?: unknown;
  near?: unknown;
  gte?: unknown;
  lte?: unknown;
  present?: boolean;
  absent?: boolean;
  includes?: unknown;
  matches?: string;
};

const MATCHERS = ['equals', 'near', 'gte', 'lte', 'present', 'absent', 'includes', 'matches'] as const;

export const matcherOf = (params: Record<string, unknown>): Matcher | undefined => {
  const found = MATCHERS.filter((m) => m in params);
  return found.length ? (Object.fromEntries(found.map((m) => [m, params[m]])) as Matcher) : undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Whether a value read from the backend is what the case said it would be. */
export const matches = (got: unknown, m: Matcher): boolean => {
  if ('equals' in m) {
    const a = num(got);
    const b = num(m.equals);
    return a !== undefined && b !== undefined ? a === b : String(got) === String(m.equals);
  }
  if ('near' in m) return num(got) !== undefined && num(m.near) !== undefined && Math.abs(num(got)! - num(m.near)!) <= 0.01;
  if ('gte' in m) return num(got) !== undefined && num(got)! >= (num(m.gte) ?? Number.NaN);
  if ('lte' in m) return num(got) !== undefined && num(got)! <= (num(m.lte) ?? Number.NaN);
  if ('present' in m) return m.present ? got !== undefined && got !== null : got === undefined || got === null;
  if ('absent' in m) return m.absent ? got === undefined || got === null : got !== undefined && got !== null;
  if ('includes' in m) return Array.isArray(got) ? got.some((v) => String(v).includes(String(m.includes))) : String(got ?? '').includes(String(m.includes));
  if ('matches' in m) return new RegExp(m.matches!).test(String(got ?? ''));
  return false;
};
