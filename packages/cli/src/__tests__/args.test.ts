import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pairs, parseArgs, splitLine, UsageError } from '../args.js';
import { driveCommands } from '../commands/drive.js';
import { headlessCommands } from '../commands/headless.js';
import { mapCommands } from '../commands/map.js';
import { osCommands } from '../commands/os.js';
import { runsCommands } from '../commands/runs.js';

const FLAGS = {
  direct: { type: 'boolean' as const, help: '' },
  depth: { type: 'number' as const, help: '', default: 4 },
  var: { type: 'list' as const, help: '' },
  out: { type: 'string' as const, help: '' },
};

test('booleans never eat the next positional; numbers are numbers; lists collect', () => {
  const p = parseArgs(
    ['--direct', 'a.ts', 'b.ts', '--depth', '2', '--var', 'x=1', '--var', 'y=2'],
    [{ name: 'file', help: '', required: true, rest: true }],
    FLAGS,
  );
  assert.deepEqual(p.args, ['a.ts', 'b.ts']);
  assert.equal(p.flags.direct, true);
  assert.equal(p.flags.depth, 2);
  assert.deepEqual(p.flags.var, ['x=1', 'y=2']);
  assert.deepEqual(pairs(p.flags.var as string[]), { x: '1', y: '2' });
});

test('defaults, --no-flag, --flag=value and passthrough after --', () => {
  const p = parseArgs(['--no-direct', '--out=x.json', '--', '--jest-flag'], [], FLAGS);
  assert.equal(p.flags.direct, false);
  assert.equal(p.flags.depth, 4);
  assert.equal(p.flags.out, 'x.json');
  assert.deepEqual(p.passthrough, ['--jest-flag']);
});

test('unknown flags, missing values and missing positionals are usage errors that name what exists', () => {
  assert.throws(
    () => parseArgs(['--nope'], [], FLAGS),
    (e: unknown) => e instanceof UsageError && /--direct/.test((e as Error).message),
  );
  assert.throws(() => parseArgs(['--depth', '--direct'], [], FLAGS), /--depth needs a value/);
  assert.throws(() => parseArgs(['--depth', 'x'], [], FLAGS), /expects a number/);
  assert.throws(() => parseArgs([], [{ name: 'target', help: '', required: true }], FLAGS), /missing <target>/);
  assert.throws(() => parseArgs(['a', 'b'], [{ name: 'one', help: '' }], FLAGS), /unexpected argument "b"/);
});

test('a session line splits on spaces and keeps quoted text together', () => {
  assert.deepEqual(splitLine('press "Comenzar ya" --hold 200'), ['press', 'Comenzar ya', '--hold', '200']);
});

test('every command is named once, documented, and its aliases are unique', () => {
  const all = [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands];
  const names = new Set<string>();
  for (const c of all) {
    assert.ok(c.summary.length > 10, `${c.name} has a summary`);
    assert.ok(!names.has(c.name), `${c.name} defined once`);
    names.add(c.name);
    for (const a of c.aliases ?? []) {
      assert.ok(!names.has(a), `${a} unique`);
      names.add(a);
    }
    for (const [flag, spec] of Object.entries(c.flags ?? {})) assert.ok(spec.help, `${c.name} --${flag} has help`);
    for (const p of c.positionals ?? []) assert.ok(p.help, `${c.name} <${p.name}> has help`);
  }
  for (const short of ['plan', 'deeplink', 'appstate', 'network', 'clock', 'biometrics', 'scan', 'gallery', 'headless'])
    assert.ok(names.has(short), `${short} accepted`);
});

test('MCP serves a small core by default and everything else on request', () => {
  const all = [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands];
  const core = all.filter((c) => c.mcp === 'core').map((c) => c.name);
  assert.deepEqual(core.sort(), ['call', 'map plan', 'map show', 'os deeplink', 'press', 'screen', 'type', 'wait', 'why']);
});

test('what MCP leaves out of a tool is still a flag of the command', () => {
  for (const c of [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands]) {
    for (const flag of c.mcpOmit ?? []) assert.ok(c.flags?.[flag], `${c.name} omits --${flag}, which it does not have`);
  }
});
