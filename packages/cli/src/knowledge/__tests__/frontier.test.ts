import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as frontier from '../frontier.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-frontier-')), 'frontier.jsonl');

test('a place owes what it has not tried', () => {
  const file = tmpFile();
  const memory = frontier.open(file);
  memory.record('Settings.Main', { seen: ['share-button', 'account-button', 'profile-button'], visited: true });
  memory.record('Settings.Main', { tried: ['share-button'] });

  const [row] = frontier.load(file);
  assert.deepEqual(row?.tried, ['share-button']);
  assert.deepEqual(row?.left, ['account-button', 'profile-button']);
  assert.deepEqual(memory.tried('Settings.Main'), ['share-button']);
});

test('a place with nothing left is not offered again', () => {
  const memory = frontier.open(tmpFile());
  memory.record('Settings.Main', { seen: ['a'], visited: true });
  memory.record('Profile.Main', { seen: ['b', 'c'], visited: true });
  memory.record('Settings.Main', { tried: ['a'] });

  assert.deepEqual(memory.unfinished(), ['Profile.Main']);
});

test('a place only ever seen from outside owes a first visit, before any remainder', () => {
  const memory = frontier.open(tmpFile());
  memory.record('Settings.Main', { seen: ['a', 'b', 'c'], visited: true });
  memory.record('Settings.Main', { tried: ['a'] });
  memory.record('Profile.Edit', {});

  assert.deepEqual(memory.unfinished(), ['Profile.Edit', 'Settings.Main']);
});

test('a layer is a place of its own', () => {
  const memory = frontier.open(tmpFile());
  memory.record('Settings.Main#account-button', { seen: ['nested-button'], visited: true });
  memory.record('Settings.Main', { seen: ['account-button'], tried: ['account-button'], visited: true });

  assert.deepEqual(memory.unfinished(), ['Settings.Main#account-button']);
});

test('a run appends as it goes and compacts to one sorted line per place', () => {
  const file = tmpFile();
  const memory = frontier.open(file);
  memory.record('Settings.Main', { seen: ['a', 'b'], visited: true });
  memory.record('Settings.Main', { tried: ['a'] });
  memory.record('Account.Main', { seen: ['c'] });
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  assert.deepEqual(frontier.open(file).tried('Settings.Main'), ['a']);

  memory.compact();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).node),
    ['Account.Main', 'Settings.Main'],
  );
});

test('a deleted screen takes its unfinished controls with it', () => {
  const file = tmpFile();
  const memory = frontier.open(file);
  memory.record('Settings.Main', { seen: ['a'], visited: true });
  memory.record('Gone.Screen#sheet', { seen: ['b'], visited: true });

  assert.equal(frontier.prune(file, new Set(['Settings.Main'])), 1);
  assert.deepEqual(
    frontier.load(file).map((r) => r.node),
    ['Settings.Main'],
  );
});
