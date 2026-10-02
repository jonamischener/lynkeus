import fs from 'node:fs';
import path from 'node:path';

import { packageName } from '../config.js';

const APP_CANDIDATES = ['App.tsx', 'App.jsx', 'App.js', 'app/App.tsx', 'src/App.tsx', 'src/App.jsx', 'src/App.js'];
const INDEX_CANDIDATES = ['index.js', 'index.tsx', 'index.ts'];

export type InitOptions = {
  entry: string;
  app?: string;
  apiEnv: string;
  auto: boolean;
  force: boolean;
  locale?: { languageTag?: string; country?: string; language?: string };
};

const findFirst = (root: string, candidates: string[]): string | undefined => candidates.find((c) => fs.existsSync(path.join(root, c)));

const relImport = (fromFile: string, toFile: string): string => {
  const rel = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\\/g, '/')
    .replace(/\.(tsx|ts|jsx|js)$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

const entryTemplate = (appImport: string, apiEnv: string, appName: string, locale?: InitOptions['locale']): string => {
  const LOCALE =
    locale?.languageTag || locale?.country || locale?.language
      ? `\n  // The locale this app is built for, from lynkeus.config.json.\n  locale: ${JSON.stringify({ country: locale.country, languageTag: locale.languageTag, languageCode: locale.language })},`
      : "\n  // locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },";
  return `// Entry for \`lynkeus headless start\`: the whole app, hosted under jest so an agent can
// drive it in Node against a real local backend. Nothing here runs in the app
// itself. lynkeus mocks the common native modules (storage, keychain,
// device-info, safe-area, localize, ...); only ${appName}-specific pieces go here.
import { installDefaultMocks } from 'lynkeus-headless/mocks'

// Real network plus a hosted app is exactly what would let a driver act
// against production if ${apiEnv} ever pointed there. Refuse anything not local.
const apiUrl = process.env.${apiEnv} ?? ''
if (!/^https?:\\/\\/(localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2)(:\\d+)?(\\/|$)/.test(apiUrl)) {
  throw new Error(\`lynkeus headless only drives a local backend; ${apiEnv} is "\${apiUrl}"\`)
}

installDefaultMocks({
  network: 'real',${LOCALE}
})

// App-specific mocks go here, before the app is required. \`lynkeus headless doctor\`
// lists the native modules the app references that nothing covers yet:
//   jest.mock('some-native-package', () => ({ method: () => undefined }))

// Whatever the app's index runs before rendering (polyfills, i18n, services):
// require it here too, then the App.
const { default: App } = require('${appImport}')

export { App }
`;
};

export const init = (root: string, opts: InitOptions): string[] => {
  const notes: string[] = [];
  const entryPath = path.join(root, opts.entry);
  const app = opts.app ?? findFirst(root, APP_CANDIDATES);
  if (!app) throw new Error(`no App component found (${APP_CANDIDATES.join(', ')}); pass --component <path>`);
  if (fs.existsSync(entryPath) && !opts.force) {
    notes.push(`${opts.entry} exists; left as is (--force overwrites)`);
  } else {
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, entryTemplate(relImport(entryPath, path.join(root, app)), opts.apiEnv, packageName(root), opts.locale));
    notes.push(`wrote ${opts.entry} (app: ${app})`);
  }
  if (opts.auto) {
    const index = findFirst(root, INDEX_CANDIDATES);
    if (!index) {
      notes.push("no index.js to add the auto mount to; add it yourself: import { auto } from 'lynkeus-agent/auto'; auto({ token: ... })");
    } else {
      const indexPath = path.join(root, index);
      const text = fs.readFileSync(indexPath, 'utf8');
      if (text.includes('lynkeus-agent/auto')) {
        notes.push(`${index} already mounts the agent`);
      } else {
        const line =
          "import { auto } from 'lynkeus-agent/auto'\n// Dev-only QA agent; a release build never evaluates the client.\nauto({ token: process.env.LYNKEUS_TOKEN })\n";
        // After the last import, so the app's own polyfills still run first.
        const imports = [...text.matchAll(/^import .*$/gm)];
        const at = imports.length ? imports[imports.length - 1]!.index! + imports[imports.length - 1]![0].length + 1 : 0;
        fs.writeFileSync(indexPath, text.slice(0, at) + line + text.slice(at));
        notes.push(`added auto() to ${index}`);
      }
    }
  }
  notes.push("jest: make sure transformIgnorePatterns lets 'lynkeus-[^/]+' through, next to react-native (lynkeus headless doctor checks it)");
  notes.push(`next: LYNKEUS_TOKEN=<token> ${opts.apiEnv}=http://127.0.0.1:3000/ lynkeus headless start`);
  notes.push('      then, in another shell: lynkeus screen  (or lynkeus headless doctor to see what still needs a mock)');
  return notes;
};
