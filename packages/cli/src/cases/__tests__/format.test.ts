import assert from 'node:assert/strict';
import { test } from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dig, interpolate, matcherOf, matches, parseCase, readCases } from '../format.js';

const CASE = `---
id: gift
title: "A gift shows up"
---
setup:
  - create_user: { as: u, name: "Ana" }
steps:
  - app.press: "#open"
  - app.back
  - assert: { user: u, path: score, equals: 25 }
expected: |
  The score is 25.
`;

test('a case is its frontmatter, its setup, its steps and what it expects', () => {
  const c = parseCase(CASE, 'cases/gift.md');
  assert.equal(c.id, 'gift');
  assert.deepEqual(c.setup, [{ verb: 'create_user', value: { as: 'u', name: 'Ana' } }]);
  assert.deepEqual(
    c.steps.map((s) => s.verb),
    ['app.press', 'app.back', 'assert'],
  );
  assert.equal(c.expected, 'The score is 25.');
});

test('a file without frontmatter, or a step with two verbs, is refused with its place', () => {
  assert.throws(() => parseCase('steps: []', 'x.md'), /x\.md: no frontmatter/);
  assert.throws(() => parseCase('---\nid: x\n---\nsteps:\n  - { a: 1, b: 2 }\n', 'x.md'), /steps\[0\] must be one step/);
});

test('a path reads into lists, and a star collects from every element', () => {
  const json = { accounts: [{ code: 'usd' }, { code: 'eur' }], user: { id: 7 } };
  assert.equal(dig(json, 'accounts.1.code'), 'eur');
  assert.deepEqual(dig(json, 'accounts.*.code'), ['usd', 'eur']);
  assert.equal(dig(json, 'user.name.first'), undefined);
});

test('a reference alone keeps its type; inside text it is text; a missing one says which', () => {
  const scope = { u: { user_id: 7, name: 'Ana' } };
  assert.deepEqual(interpolate({ id: '{{u.user_id}}', hi: 'hi {{u.name}}', n: 3 }, scope), { id: 7, hi: 'hi Ana', n: 3 });
  assert.match(interpolate('x{{random.letters}}', scope), /^x[a-z]{6}$/);
  assert.throws(() => interpolate('{{v.user_id}}', scope), /no alias 'v'/);
  assert.throws(() => interpolate('{{u.phone}}', scope), /\{\{u\.phone\}\} is empty/);
});

test('matchers compare numbers as numbers and lists by any element', () => {
  assert.equal(matches('25.0', { equals: 25 }), true);
  assert.equal(matches('abc', { equals: 'abc' }), true);
  assert.equal(matches(['usd', 'bridge_usd'], { includes: 'bridge' }), true);
  assert.equal(matches(9, { gte: 10 }), false);
  assert.equal(matches(null, { absent: true }), true);
  assert.equal(matches('AUTORIZADO', { matches: '^AUT' }), true);
  assert.deepEqual(matcherOf({ path: 'a', equals: 1, user: 'u' }), { equals: 1 });
  assert.equal(matcherOf({ path: 'a' }), undefined);
});

test('a case with a matrix runs once per combination, named after it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-matrix-')), 'm.md');
  fs.writeFileSync(file, '---\nid: m\nmatrix: { locale: [en, fr], login: [phone] }\n---\nsteps:\n  - create_user: { locale: "{{matrix.locale}}" }\n');
  const cases = readCases(file);
  assert.deepEqual(
    cases.map((c) => c.id),
    ['m[locale=en,login=phone]', 'm[locale=fr,login=phone]'],
  );
  assert.deepEqual(cases[1]!.setup, []);
  assert.deepEqual(cases[1]!.steps[0]!.value, { locale: 'fr' });
});
