import fs from 'node:fs';
import path from 'node:path';

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

export const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export const readJsonl = <T>(file: string): T[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
};

export const appendJsonl = (file: string, row: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
};

// Through a temporary file and a rename, so a reader never sees half a file.
export const writeJsonl = (file: string, rows: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  fs.renameSync(tmp, file);
};

export const today = () => new Date().toISOString().slice(0, 10);

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
