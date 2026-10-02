import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'index.ts'), 'utf8');
const frozenFile = path.join(here, '..', '..', 'shape.json');
const agentProtocol = fs.readFileSync(path.join(here, '..', '..', '..', 'agent', 'src', 'protocol.ts'), 'utf8');

const SHAPES = ['ElementKind', 'HiddenReason', 'Frame', 'Element', 'Screen', 'Scope', 'Target'];

const declaration = (name: string): string => {
  const start = source.search(new RegExp(`export type ${name}\\b`));
  assert.notEqual(start, -1, `no export type ${name} in the protocol`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
};

const normalized = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

const hash = createHash('sha1')
  .update(SHAPES.map((n) => normalized(declaration(n))).join('\n'))
  .digest('hex');
const agentVersion = Number(/PROTOCOL_VERSION = (\d+)/.exec(agentProtocol)?.[1]);

test('the protocol shapes change only on purpose', () => {
  if (process.env.UPDATE_PROTOCOL_SHAPE === '1') fs.writeFileSync(frozenFile, `${JSON.stringify({ version: PROTOCOL_VERSION, hash }, null, 2)}\n`);
  const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8')) as { version: number; hash: string };
  assert.equal(
    hash,
    frozen.hash,
    `${SHAPES.join(', ')} changed. A change a driver of version ${frozen.version} would misread needs PROTOCOL_VERSION bumped; an optional field it can ignore does not. Either way, record the decision with UPDATE_PROTOCOL_SHAPE=1.`,
  );
  assert.equal(PROTOCOL_VERSION, frozen.version, 'PROTOCOL_VERSION moved without recording the shape it belongs to (UPDATE_PROTOCOL_SHAPE=1)');
  assert.equal(agentVersion, PROTOCOL_VERSION, "lynkeus-agent's own PROTOCOL_VERSION must equal this one");
});
