/**
 * Which native modules the app's source references that nothing mocks yet:
 * "a crash deep in a React stack" turned into "these modules need a mock",
 * statically, without a simulator or a host.
 */
import fs from 'node:fs';
import path from 'node:path';

import { packageName } from '../config.js';

// What lynkeus-headless mocks, read out of the installed package when there is one (importing it would pull in
// React Native); this copy is only right for the version it shipped with.
const AUTO_MOCKED = [
  'react-native-mmkv',
  'react-native-keychain',
  'react-native-device-info',
  'react-native-safe-area-context',
  'react-native-localize',
  '@react-native-async-storage/async-storage',
  'react-native-worklets',
  'react-native-pager-view',
  'react-native-video',
  'react-native-fast-image',
  'react-native-biometrics',
  'react-native-in-app-review',
  'react-native-webview',
  'react-native-vision-camera',
  'react-native-image-picker',
];

// Native modules React Native's own jest preset already provides.
const PRESET_PROVIDED = new Set([
  'SettingsManager',
  'DeviceInfo',
  'PlatformConstants',
  'I18nManager',
  'StatusBarManager',
  'Appearance',
  'DevSettings',
  'SourceCode',
  'Timing',
  'UIManager',
  'ImageLoader',
  'KeyboardObserver',
  'LinkingManager',
  'NativeAnimatedModule',
  'NativeUnimoduleProxy',
]);

type NativeRef = { name: string; file: string; line: number; how: string };

const SCAN_DIRS = ['app', 'src', 'modules', 'components', 'screens'];
const SKIP = new Set(['node_modules', '.git', 'ios', 'android', 'lib', 'build', '.lynkeus', '__tests__', '__mocks__']);
const CODE = /\.[cm]?[jt]sx?$/;

const walk = (dir: string, out: string[]): void => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(full, out);
    } else if (CODE.test(e.name)) {
      out.push(full);
    }
  }
};

const PATTERNS: { re: RegExp; how: string }[] = [
  { re: /NativeModules\.(\w+)/g, how: 'NativeModules' },
  { re: /TurboModuleRegistry\.get(?:Enforcing)?\(\s*['"]([^'"]+)['"]/g, how: 'TurboModuleRegistry' },
  { re: /requireNativeComponent\s*(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g, how: 'requireNativeComponent' },
  { re: /codegenNativeComponent\s*<[^>]*>\(\s*['"]([^'"]+)['"]/g, how: 'codegenNativeComponent' },
];

const scanNativeRefs = (root: string): NativeRef[] => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(path.join(root, d), files);
  const seen = new Map<string, NativeRef>();
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { re, how } of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const name = m[1]!;
        if (PRESET_PROVIDED.has(name) || seen.has(name)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        seen.set(name, { name, file: path.relative(root, file), line, how });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const entryMocks = (root: string, entry: string): { specs: Set<string>; files: Set<string>; network?: string } => {
  const specs = new Set<string>();
  const files = new Set<string>();
  const entryPath = path.join(root, entry);
  let text = '';
  try {
    text = fs.readFileSync(entryPath, 'utf8');
  } catch {
    return { specs, files };
  }
  const dir = path.dirname(entryPath);
  const jestMock = /jest\.(?:do)?mock\(\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(jestMock)) {
    const spec = m[1]!;
    specs.add(spec);
    if (spec.startsWith('.')) files.add(path.relative(root, path.resolve(dir, spec)));
  }
  const overrides = /['"]([^'"]+)['"]\s*:\s*(?:\([^)]*\)|function)/g; // rough: keys in overrides map
  for (const m of text.matchAll(overrides)) specs.add(m[1]!);
  const network = /network\s*:\s*['"](real|banned)['"]/.exec(text)?.[1];
  return { specs, files, network };
};

const autoMockedFrom = (root: string): string[] => {
  for (const rel of ['node_modules/lynkeus-headless/lib/mocks/install.js', 'node_modules/lynkeus-headless/src/mocks/install.ts']) {
    try {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      const defaults = src.match(/defaults[^=]*=\s*\{([\s\S]*?)\n\s*\};/)?.[1];
      const names = [...(defaults ?? '').matchAll(/^\s*'([^']+)':/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
      if (names.length > 0) return names;
    } catch {}
  }
  return AUTO_MOCKED;
};

export const doctor = (root: string, entry: string, options: { fix?: boolean } = {}): string[] => {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const autoMocked = autoMockedFrom(root);
  const present = autoMocked.filter((m) => m in deps);
  const entryHasFile = fs.existsSync(path.join(root, entry));
  const { specs, files, network } = entryHasFile ? entryMocks(root, entry) : { specs: new Set<string>(), files: new Set<string>(), network: undefined };
  const refs = scanNativeRefs(root);

  // Inside a package installDefaultMocks() covers, the app never reaches the raw native binding.
  const insideAutoMocked = (ref: NativeRef) => present.some((m) => ref.file.includes(`node_modules/${m}/`) || ref.file.startsWith(`${m}/`));
  const covered = (ref: NativeRef): boolean =>
    files.has(ref.file) || specs.has(ref.name) || insideAutoMocked(ref) || [...specs].some((s) => ref.file.includes(s.replace(/^\.\.?\//, '')));
  const uncovered = refs.filter((r) => !covered(r));

  const lines: string[] = [];
  lines.push(`lynkeus headless doctor — headless readiness for ${packageName(root)}\n`);

  lines.push('Auto-mocked by lynkeus (installDefaultMocks):');
  if (present.length) for (const m of present) lines.push(`  ✓ ${m}`);
  else lines.push('  (none of the known native libs are installed)');
  lines.push('');

  if (!entryHasFile) {
    lines.push(`No headless entry at ${entry}.`);
    lines.push('  Create one that installs the default mocks and exports App:');
    lines.push("    import { installDefaultMocks } from 'lynkeus-headless/mocks'");
    lines.push("    installDefaultMocks({ network: 'real' })");
    lines.push("    const { default: App } = require('./path/to/App')");
    lines.push('    export { App }');
    lines.push('');
  } else {
    lines.push(`Mocked in ${entry} (app-specific):`);
    const appMocks = [...specs].filter((s) => !autoMocked.includes(s));
    if (appMocks.length) for (const s of appMocks) lines.push(`  ✓ ${s}`);
    else lines.push('  (none beyond the lynkeus defaults)');
    lines.push(`  network: ${network ?? "default (jest ban) — pass { network: 'real' } to reach a backend"}`);
    lines.push('');
  }

  // The agent ships ESM; a jest config that only transforms react-native-* never parses it.
  const jestConfig = ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  if (jestConfig) {
    const text = fs.readFileSync(jestConfig, 'utf8');
    if (/transformIgnorePatterns/.test(text) && !/lynkeus/.test(text)) {
      lines.push(`jest: ${path.basename(jestConfig)} has transformIgnorePatterns without lynkeus in its allow-list.`);
      lines.push("  Add 'lynkeus-[^/]+' next to react-native, or the host stops at \"Unexpected token 'export'\" in lynkeus-agent.");
      lines.push('');
    }
  }
  lines.push("Native modules your app's source references:");
  if (refs.length === 0) {
    lines.push('  (none found by the static scan)');
  } else {
    for (const r of refs) {
      const mark = covered(r) ? '✓' : '⚠';
      lines.push(`  ${mark} ${r.name.padEnd(28)} ${r.file}:${r.line}  (${r.how})`);
    }
  }
  lines.push('');

  if (uncovered.length) {
    lines.push(`${uncovered.length} native module(s) look unmocked. Under jest they do not exist, so`);
    lines.push(`the app can crash when it touches them. Add a mock for each in ${entry}:`);
    for (const r of uncovered) lines.push(`  jest.mock('...${r.name}...', () => ({ /* the methods your app calls */ }))`);
    lines.push('');
    lines.push('(Heuristic: some may be provided by a mocked wrapper or a library. Review.)');
    if (options.fix) {
      // `{}` gets past the import; a method the app then calls fails with a name `doctor --explain` understands.
      const packages = [...new Set(uncovered.map((r) => r.file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter((p): p is string => !!p))];
      const local = uncovered.filter((r) => !r.file.includes('node_modules/'));
      const block = [
        '',
        '// Added by `lynkeus headless doctor --fix`: stubs for native modules nothing covered.',
        '// Replace {} with the methods the app calls; `lynkeus headless doctor` re-checks.',
        ...packages.map((p) => `jest.mock('${p}', () => ({}))`),
        ...local.map((r) => `// TODO ${r.name} (${r.file}:${r.line}, ${r.how}): app-local, mock the module that wraps it`),
        '',
      ].join('\n');
      if (entryHasFile) {
        const entryPath = path.join(root, entry);
        const text = fs.readFileSync(entryPath, 'utf8');
        const at = text.indexOf('const { default: App }');
        fs.writeFileSync(entryPath, at >= 0 ? `${text.slice(0, at) + block.trimStart()}\n${text.slice(at)}` : text + block);
        lines.push(`--fix: wrote ${packages.length} stub(s) and ${local.length} TODO(s) into ${entry}`);
      } else {
        lines.push('--fix: no entry to write into; run `lynkeus headless init` first');
      }
    }
  } else if (refs.length) {
    lines.push('Every referenced native module appears covered. ✓');
  }

  return lines;
};
