/** The usual cause and fix of a headless failure, found in jest's output so nobody reads a 300-line stack for it. */
export type Explanation = { cause: string; fix: string; match: string };

type Rule = { re: RegExp; cause: (m: RegExpMatchArray) => string; fix: (m: RegExpMatchArray) => string };

const RULES: Rule[] = [
  {
    re: /TurboModuleRegistry\.getEnforcing\(\.\.\.\): '([^']+)' could not be found/,
    cause: (m) => `the native module ${m[1]} does not exist under jest`,
    fix: (m) =>
      `mock the package that owns ${m[1]} in the headless entry: jest.mock('<package>', () => ({ ... })). \`lynkeus headless doctor\` lists where it is referenced.`,
  },
  {
    re: /Invariant Violation: (?:requireNativeComponent: )?"?([\w.]+)"? was not found in the UIManager/,
    cause: (m) => `the native view ${m[1]} has no jest counterpart`,
    fix: (m) => `mock the library that renders ${m[1]} with a plain View (see the vision-camera and webview stubs lynkeus ships for the shape).`,
  },
  {
    re: /Cannot find module '([^']+)' from '([^']+)'/,
    cause: (m) => `${m[2]} imports ${m[1]}, which jest cannot resolve`,
    fix: (m) => `if ${m[1]} is a path alias, add it to jest moduleNameMapper; if it is an optional native package, jest.mock it in the headless entry.`,
  },
  {
    re: /lynkeus headless only drives a local backend; API_URL is "([^"]*)"/,
    cause: (m) => `API_URL is "${m[1] || '(empty)'}", not a local backend`,
    fix: () =>
      `export API_URL=http://127.0.0.1:<port>/ before \`lynkeus headless start\`; if the app inlines env at build time, clear its jest transform cache too.`,
  },
  {
    re: /(\w+)\.(\w+) is not a function/,
    cause: (m) => `${m[1]}.${m[2]} is missing — usually a mock that does not implement a method the app calls`,
    fix: (m) => `extend the mock for ${m[1]} with ${m[2]}; the lynkeus defaults can be overridden per key in installDefaultMocks({ overrides }).`,
  },
  {
    re: /Cannot read propert(?:y|ies) of undefined \(reading '(\w+)'\)/,
    cause: (m) => `something the app expected to exist is undefined (reading '${m[1]}')`,
    fix: () =>
      `look one frame up the stack for the module: a mock returning {} instead of the shape the app reads, or a store not initialised because a service failed earlier.`,
  },
  {
    re: /Jest did not exit one second after the test run has completed/,
    cause: () => `the host finished but something kept the event loop alive`,
    fix: () => `harmless for a host that is meant to stay up; when it is not, an open socket or timer from a mock is the usual culprit.`,
  },
  {
    re: /ECONNREFUSED (\d+\.\d+\.\d+\.\d+):(\d+)/,
    cause: (m) => `nothing is listening on ${m[1]}:${m[2]}`,
    fix: () => `start the backend (or the lynkeus driver, if this is the agent's socket) and check the port the entry dials.`,
  },
  {
    re: /Test environment jest-environment-\w+ cannot be found|Unexpected token 'export'|SyntaxError: Cannot use import statement/,
    cause: () => `jest is not transforming a dependency (ESM in node_modules)`,
    fix: () =>
      `add the package to transformIgnorePatterns' allow-list in the app's jest config, the same way react-native itself is listed (lynkeus-agent and lynkeus-headless need 'lynkeus-[^/]+' there).`,
  },
  {
    re: /ReferenceError: (\w+) is not defined/,
    cause: (m) => `${m[1]} is a global the runtime does not provide under jest`,
    fix: (m) => `define ${m[1]} in the headless entry before requiring the app (globalThis.${m[1]} = ...), or mock the module that expects it.`,
  },
];

export const explainError = (text: string): Explanation[] => {
  const out: Explanation[] = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) out.push({ match: m[0], cause: rule.cause(m), fix: rule.fix(m) });
  }
  return out;
};

export const describeExplanations = (list: Explanation[]): string =>
  list.length === 0 ? '' : ['', 'lynkeus: what this looks like', ...list.map((e) => `  ${e.match}\n    cause  ${e.cause}\n    fix    ${e.fix}`)].join('\n');
