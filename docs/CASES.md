# Cases

Cases a person can read, run against the app. The format and the runner are
lynkeus'; what a user is, how this app logs in and how its backend is prepared
are the project's, declared in `lynkeus.config.json`.

```sh
npx lynkeus case init                 # an example case, this reference, a fixtures server to start from
npx lynkeus case run                  # every case under cases.dir
npx lynkeus case run cases/gift.md --host   # one case, hosting the app in Node for the run
npx lynkeus case run --report out.jsonl     # one JSON line per case, for CI
npx lynkeus case run --out run/            # the run as a directory a report can read
```

A case is a markdown file: frontmatter that names it, then `setup`, `steps`
and `expected`. `lynkeus case run cases/example.md` runs one; without files
it runs every case in this folder. A step that fails stops the case, and the
report carries the screen, the requests and the reason.

## Steps that drive the app

| Step | Value | |
|---|---|---|
| `app.press` | target, or `{ target, within?, nth?, optional?, hold? }` | Waits for the control to be there and enabled. `optional` presses only if it is on screen. |
| `app.type` | `{ text, target?, submit?, clear? }` | `target` is tapped first; `submit` ends with the return key. |
| `app.swipe` | `{ direction, target?, distance? }` or `{ from, to }` | |
| `app.wait` | route, target, ms, `{ target, scroll? }` or `{ request, status? }` | `scroll` swipes until the target is in the window. A `request` is `METHOD /path`. |
| `app.see` | target, or `{ testId?, text?, route?, request?, event?, layer?, absent?, timeoutMs? }` | An assertion on what the app shows or did. Everything named must hold. |
| `app.nav` | route, or `{ route, params }` | A teleport, for getting to where the case starts. |
| `app.back` | | |
| `app.requests` | `mark` | From here on, `request` only counts what the app asks for. |
| `app.call` | `{ command, params?, expect?, as? }` | A command the app registered with `qa.register`. |
| `app.run` | `{ flow, vars? }` | A lynkeus flow, from the flows folder. |
| `app.events` / `app.event` | `clear` / `{ name, props?, absent? }` | What the app told its analytics. |
| `app.<command>` | its arguments by name | Any other lynkeus command: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`… |

A target is `#testId`, `"text"`, an index or `x,y`.

One case runs on a host and on a device. What only one of them needs — closing a
native screen the host never shows — is kept to it; everywhere else it is
skipped:

```yaml
  - on: device        # or headless, ios, android
    do:
      - app.press: "364,84"
```

On a device, a swipe is followed by a wait for the screen to stop moving, since
a pager keeps going after the finger lifts and swallows a swipe sent into that
momentum. A swipe on a target keeps the whole drag inside the window.

A case that should run over several inputs says so in its frontmatter, and runs
once per combination, named after it (`signup[locale=fr,login=phone]`):

```yaml
matrix: { locale: [en, fr], login: [phone, email] }
```

`{{matrix.locale}}` anywhere in the file is that run's value.

## Steps that prepare and read the backend

Any other step name is a **fixture**: lynkeus sends it to the command in
`cases.fixtures` (lynkeus.config.json) as one JSON line and reads one back.

```
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
```

`as: u` keeps the answer; `{{u.user_id}}` reads it later. `assert` calls
the `inspect` fixture and checks one path of its answer with `equals`,
`includes`, `gte`, `lte`, `near`, `matches`, `present` or `absent`.
`exec: { run: "…", as? }` runs a shell command and keeps its JSON output.

## Steps of your own

`cases.macros` names a step and the steps it stands for. Inside,
`{{param.x}}` is what the case passed, and a parameter that names an alias
is that alias.

```json
"macros": {
  "app.login": [
    { "app.call": { "command": "reset" } },
    { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
  ]
}
```

`when` runs a step only if the case passed that parameter (`"when": "wait"`)
or passed that value (`"when": "method=phone"`); `unless` is the opposite.

`cases.interruptions` names what the app may put in the way of any step — a
lock screen, a consent sheet — and the steps that get past it:

```json
"interruptions": [{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }]
```

It runs before a press, a type, a swipe or a see finds it there; a step whose
own words match `unless` is about it, and is left alone.

Cases and fixtures often live in a repository of their own: `LYNKEUS_CONFIG`
names a second configuration file, read over the app's, and the paths under
its `cases` are relative to it.

## Configuration

```json
"cases": {
  "dir": "cases",
  "flows": "flows",
  "fixtures": { "command": "node cases/fixtures.mjs", "cwd": ".", "timeoutMs": 120000 },
  "inspect": "inspect",
  "refs": { "user": "user_id" },
  "macros": {}
}
```

`refs` says which parameters point at what an earlier step made: with
`"user": "user_id"`, `user: u` reaches the fixture as `user_id`, read from what
`as: u` kept, and a step that names no user gets the latest one. The fixtures
command is started once per run, in `cwd`, and can be anything that reads a
line and writes a line: a Node script, a Rails runner, a container.

## What a run leaves

A failed case runs once more before it counts as failed (`--once` turns that
off), and one that passes the second time is reported as passed on retry. A
failed step leaves the screen as it was, the requests the app had made and,
for a step on a target, why: covered, hidden behind a layer, disabled, gone.

A step the host has no way to do (a mocked response on a real device, a command
the app does not register in this build) is `unsupported`, not failed: the case
stops there, counts as one that cannot run on this host, and does not fail the
run. The same case then passes where the host can do it.

`--out <dir>` writes the run as a directory that a report, a dashboard or a
script can read without knowing how the run was made:

```
run.json      when it started and ended, what the app ran on, the totals
cases.jsonl   one line per attempt of a case, in the order they ran
```

A line of `cases.jsonl` carries the case's id, title, description and file, the
attempt (1, or 2 for the second chance), the result, when it started, how long
it took, and its steps. Each step says which part of the case it is (`setup` or
`steps`), whether it passed, failed, was skipped or is unsupported on this host, how long it took, its error, and the events the
app sent to its analytics while it ran. A failed attempt keeps its evidence.

The types are `RunManifest`, `RunCase`, `RunStep` and `RunEvent` in
`lynkeus-protocol`, with `RUN_SCHEMA` in `run.json`. A field is only ever
added; a change to what an existing field means raises the schema, and a
reader should refuse a schema it does not know. `run.json` is written when the
run starts and again when it ends, so a run that was cut short has no
`finishedAt` and no `totals`.
