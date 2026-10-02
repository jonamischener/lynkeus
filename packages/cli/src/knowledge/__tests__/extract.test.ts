import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Project } from 'ts-morph';

import { collectImports, screenDeclarations } from '../extract.js';

const file = (code: string) => new Project({ useInMemoryFileSystem: true }).createSourceFile('Nav.tsx', code);

test('JSX screens are found', () => {
  const decls = screenDeclarations(
    file(`
    const Nav = () => <Stack.Navigator><Stack.Screen name="A.Main" component={AMain} /></Stack.Navigator>
  `),
  );
  assert.deepEqual(decls, [{ route: 'A.Main', component: 'AMain' }]);
});

test('static-config screens are found, with quoted and bare keys', () => {
  const decls = screenDeclarations(
    file(`
    const Tabs = createTabs({ screens: {
      'Settings.Notifications': { screen: SettingsNotifications, options: { lazy: false } },
      Settings: { screen: SettingsMain },
    } })
  `),
  );
  assert.deepEqual(decls, [
    { route: 'Settings.Notifications', component: 'SettingsNotifications' },
    { route: 'Settings', component: 'SettingsMain' },
  ]);
});

test('a static entry whose screen is a nested navigator call is not a screen', () => {
  const decls = screenDeclarations(
    file(`
    const Root = createStack({ screens: { 'Root.Tabs': { screen: buildRootTabs({ hideFirst: false }) } } })
  `),
  );
  assert.deepEqual(decls, []);
});

test('an object with a screen key inside a spread still counts', () => {
  const decls = screenDeclarations(
    file(`
    const tabs = { ...(hide ? {} : { 'Settings.Main': { screen: SettingsMain } }) }
  `),
  );
  assert.deepEqual(decls, [{ route: 'Settings.Main', component: 'SettingsMain' }]);
});

test('navigate params that name a screen are not declarations', () => {
  const decls = screenDeclarations(
    file(`
    navigation.navigate('Root.Tabs', { screen: 'Settings.Main', params: { screen: 'Settings.Main' } })
    const target = { name: 'Root.Tabs', params: { screen: 'Settings.Main' } }
  `),
  );
  assert.deepEqual(decls, []);
});

const app = (files: Record<string, string>) => {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [name, code] of Object.entries(files)) project.createSourceFile(`/app/${name}`, code);
  return (name: string) => collectImports(project.getSourceFileOrThrow(`/app/${name}`), '/app');
};

test('a name imported through a barrel points at the file that defines it', () => {
  const imports = app({
    'hooks/useThing.ts': 'const useThing = () => 1\nexport { useThing }',
    'hooks/useOther.ts': 'export const useOther = () => 2',
    'hooks/index.ts': "export * from './useThing'\nexport { useOther as useRenamed } from './useOther'",
    'Screen.tsx': "import { useThing } from './hooks'",
    'Other.tsx': "import { useRenamed } from './hooks'",
  });
  assert.deepEqual(imports('Screen.tsx'), { imports: ['hooks/useThing.ts'], barrels: ['hooks/index.ts'] });
  assert.deepEqual(imports('Other.tsx'), { imports: ['hooks/useOther.ts'], barrels: ['hooks/index.ts'] });
});

test('what cannot be traced to one file stays on the module it was imported from', () => {
  const imports = app({
    'hooks/useThing.ts': 'export const useThing = () => 1',
    'hooks/index.ts': "export * from './useThing'\nexport const here = 1",
    'Whole.tsx': "import * as hooks from './hooks'",
    'Local.tsx': "import { here, missing } from './hooks'",
  });
  assert.deepEqual(imports('Whole.tsx'), { imports: ['hooks/index.ts'], barrels: [] });
  assert.deepEqual(imports('Local.tsx'), { imports: ['hooks/index.ts'], barrels: [] });
});
