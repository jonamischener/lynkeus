/**
 * What `lynkeus case init` writes: one case to copy from, the reference of the
 * format next to it, and a fixtures server with two empty fixtures, so a
 * project starts from something that runs instead of from a blank folder.
 */
export const EXAMPLE_CASE = `---
id: example
title: "A user who was given points sees them on the first screen"
description: >
  What this proves and why it matters, in a sentence or two. A case reads top
  to bottom: what has to exist, what the person does, what must be true after.
---
setup:
  # Anything that is not an app step is a fixture: fixtures.mjs answers it.
  - create_user: { as: u, name: "Ana" }

steps:
  - app.see: { text: "Hello" }
  # \`user: u\` points at what \`create_user\` answered (cases.refs in lynkeus.config.json).
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 points", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  The points on screen and the points the backend holds are both 25.
`;

export const FORMAT = `# Cases

A case is a markdown file: frontmatter that names it, then \`setup\`, \`steps\`
and \`expected\`. \`lynkeus case run cases/example.md\` runs one; without files
it runs every case in this folder. A step that fails stops the case, and the
report carries the screen, the requests and the reason.

## Steps that drive the app

| Step | Value | |
|---|---|---|
| \`app.press\` | target, or \`{ target, within?, nth?, optional?, hold? }\` | Waits for the control to be there and enabled. \`optional\` presses only if it is on screen. |
| \`app.type\` | \`{ text, target?, submit?, clear? }\` | \`target\` is tapped first; \`submit\` ends with the return key. |
| \`app.swipe\` | \`{ direction, target?, distance? }\` or \`{ from, to }\` | |
| \`app.wait\` | route, target, ms, \`{ target, scroll? }\` or \`{ request, status? }\` | \`scroll\` swipes until the target is in the window. A \`request\` is \`METHOD /path\`. |
| \`app.see\` | target, or \`{ testId?, text?, route?, request?, event?, layer?, absent?, timeoutMs? }\` | An assertion on what the app shows or did. Everything named must hold. |
| \`app.nav\` | route, or \`{ route, params }\` | A teleport, for getting to where the case starts. |
| \`app.back\` | | |
| \`app.requests\` | \`mark\` | From here on, \`request\` only counts what the app asks for. |
| \`app.call\` | \`{ command, params?, expect?, as? }\` | A command the app registered with \`qa.register\`. |
| \`app.run\` | \`{ flow, vars? }\` | A lynkeus flow, from the flows folder. |
| \`app.events\` / \`app.event\` | \`clear\` / \`{ name, props?, absent? }\` | What the app told its analytics. |
| \`app.<command>\` | its arguments by name | Any other lynkeus command: \`app.mock\`, \`app.network\`, \`app.appstate\`, \`app.deeplink\`… |

A target is \`#testId\`, \`"text"\`, an index or \`x,y\`.

A case that runs over several inputs declares \`matrix: { locale: [en, fr] }\`
in its frontmatter and runs once per combination; \`{{matrix.locale}}\` is that
run's value.

One case runs on a host and on a device. What only one of them needs — closing a
native screen the host never shows — is kept to it:

\`\`\`yaml
  - on: device        # or headless, ios, android
    do:
      - app.press: "364,84"
\`\`\`

## Steps that prepare and read the backend

Any other step name is a **fixture**: lynkeus sends it to the command in
\`cases.fixtures\` (lynkeus.config.json) as one JSON line and reads one back.

\`\`\`
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
\`\`\`

Before the first case lynkeus sends \`{"command": "lynkeus.describe"}\`. A
server that answers \`{"commands": ["create_user", …]}\` gets its cases checked
first: one that names a fixture missing from the list is refused before
anything runs. A server that answers \`"ok": false\` is not checked.

\`as: u\` keeps the answer; \`{{u.user_id}}\` reads it later. \`assert\` calls
the \`inspect\` fixture and checks one path of its answer with \`equals\`,
\`includes\`, \`gte\`, \`lte\`, \`near\`, \`matches\`, \`present\` or \`absent\`.
\`exec: { run: "…", as? }\` runs a shell command and keeps its JSON output.

## Steps of your own

\`cases.macros\` names a step and the steps it stands for. Inside,
\`{{param.x}}\` is what the case passed, and a parameter that names an alias
is that alias.

\`\`\`json
"macros": {
  "app.login": [
    { "app.call": { "command": "reset" } },
    { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
  ]
}
\`\`\`

\`when\` runs a step only if the case passed that parameter (\`"when": "wait"\`)
or passed that value (\`"when": "method=phone"\`); \`unless\` is the opposite.

\`cases.interruptions\` names what the app may put in the way of any step — a
lock screen, a consent sheet — and the steps that get past it:
\`{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }\`. It
runs before a press, a type, a swipe or a see finds it there; a step whose own
words match \`unless\` is about it, and is left alone.

Cases and fixtures often live in a repository of their own: \`LYNKEUS_CONFIG\`
names a second configuration file, read over the app's, and the paths under
its \`cases\` are relative to it.
`;

export const FIXTURES = `#!/usr/bin/env node
// The fixtures of this project: how a case prepares the backend and reads it.
// lynkeus starts this once per run and talks JSON lines to it: one line in per
// step, one line out. Replace the bodies with calls to your backend — its
// admin API, a script, a database seed.
import readline from 'node:readline';

const users = new Map();

const fixtures = {
  async create_user({ name = 'Test user' }) {
    const user = { user_id: \`u_\${users.size + 1}\`, name, points: 0 };
    users.set(user.user_id, user);
    return user;
  },
  async give_points({ user_id, points }) {
    const user = users.get(user_id);
    if (!user) throw new Error(\`no user \${user_id}\`);
    user.points += Number(points);
    return { user_id, points: user.points };
  },
  // What \`assert\` reads.
  async inspect({ user_id }) {
    return users.get(user_id) ?? {};
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { command, params } = JSON.parse(line);
  // lynkeus asks once what this server answers, and refuses a case that names anything else.
  if (command === 'lynkeus.describe') {
    console.log(JSON.stringify({ commands: Object.keys(fixtures) }));
    continue;
  }
  try {
    const fixture = fixtures[command];
    if (!fixture) throw new Error(\`no fixture \${command}\`);
    console.log(JSON.stringify({ ok: true, ...(await fixture(params ?? {})) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
}
`;

export const CONFIG = {
  dir: 'cases',
  flows: 'flows',
  fixtures: { command: 'node cases/fixtures.mjs' },
  inspect: 'inspect',
  refs: { user: 'user_id' },
  macros: {},
};
