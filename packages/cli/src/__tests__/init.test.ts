import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { init } from '../commands/init.js';
import { explainError } from '../knowledge/errors.js';

const tmpApp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-init-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'App.tsx'), 'export default () => null');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(
    path.join(root, 'index.js'),
    "import { AppRegistry } from 'react-native'\nimport App from './app/App'\n\nAppRegistry.registerComponent('demo', () => App)\n",
  );
  return root;
};

test('init writes an entry that requires the app and refuses non-local backends', () => {
  const root = tmpApp();
  const notes = init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: false, force: false });
  const entry = fs.readFileSync(path.join(root, 'qa/headless.tsx'), 'utf8');
  assert.match(entry, /require\('\.\.\/app\/App'\)/);
  assert.match(entry, /process\.env\.API_URL/);
  assert.match(entry, /installDefaultMocks/);
  assert.ok(notes.some((n) => n.includes('wrote qa/headless.tsx')));
  // Second run leaves it alone.
  const again = init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: false, force: false });
  assert.ok(again.some((n) => n.includes('left as is')));
});

test('init --auto adds the mount after the imports, once', () => {
  const root = tmpApp();
  init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: true, force: false });
  init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: true, force: false });
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.equal(index.split('lynkeus-agent/auto').length, 2);
  assert.ok(index.indexOf('auto(') < index.indexOf('registerComponent'));
  assert.ok(index.indexOf("import App from './app/App'") < index.indexOf('lynkeus-agent/auto'));
});

test('the error catalogue names the module behind a TurboModule crash', () => {
  const [e] = explainError(
    "Invariant Violation: TurboModuleRegistry.getEnforcing(...): 'RNCWebView' could not be found. Verify that a module by this name is registered",
  );
  assert.ok(e);
  assert.match(e.cause, /RNCWebView/);
  assert.equal(explainError('all good').length, 0);
});
