# lynkeus command reference

Generated from the command registry (`lynkeus help --markdown`). Every command accepts the global flags at the end.

## Drive

the app that is running, through the agent inside it.

### `lynkeus screen [--tree] [--record] [--all] [--frames] [--verbose]`

Route, path and every element on screen, in ms

One line per element: index, kind, #testId, label, value and state (`!disabled`, `~covered`, `~inert`). What the platform is not presenting is left out and counted in the header; `--all` lists it. `--frames` adds each centre in points; `--verbose` the commit count and cost. `--tree` prints nested lines with no geometry: the form to diff. `--record` keeps the structure under .lynkeus/screens/ and notes what changed since the last read.

| Flag | |
|---|---|
| `--tree` | as a tree of meaning, without frames |
| `--record` | keep it under .lynkeus/screens/ and report changes (or LYNKEUS_RECORD_SCREENS=1) |
| `--all` | also list what is not presented |
| `--frames` | with each centre, in points |
| `--verbose` | commit count and read cost in the header |

### `lynkeus press <target> [--in <target>] [--nth <n>] [--hold <ms>] [--js] [--settle]`

A finger on an element

| Argument | |
|---|---|
| `target` | #testId | "text" | 12 (index) | 100,200 |

| Flag | |
|---|---|
| `--in <target>` | the match nearest this target |
| `--nth <n>` | the nth match, from 0 |
| `--hold <ms>` | hold for this long |
| `--js` | call onPress directly instead of a synthesized touch |
| `--settle` | wait for the app to stop committing, then print the screen |

### `lynkeus type <text> [target] [--in <target>] [--nth <n>] [--paste] [--submit] [--clear]`

Type into the focused input, or tap a target first

| Argument | |
|---|---|
| `text` | what to type |
| `target` | tap this first: #testId | "text" | 12 (index) | 100,200 (optional) |

| Flag | |
|---|---|
| `--in <target>` | the match nearest this target |
| `--nth <n>` | the nth match, from 0 |
| `--paste` | insert at once instead of key by key |
| `--submit` | then the return key (onSubmitEditing) |
| `--clear` | clear the field first |

### `lynkeus swipe [direction] [target] [--distance <pt>] [--from <x,y>] [--to <x,y>] [--duration <ms>]`

A drag; on a target, drives its gesture (a slider, a sheet)

On a target the drag starts at its centre, which a wide control cannot always afford: a slider needing 80% of its width would end off-screen, and a touch that leaves the screen is cancelled. `--from`/`--to` place both ends, in points.

| Argument | |
|---|---|
| `direction` | up | down | left | right (omit when giving --from/--to) (optional) |
| `target` | #testId | "text" | 12 (index) | 100,200 (optional) |

| Flag | |
|---|---|
| `--distance <pt>` | how far, in points |
| `--from <x,y>` | where the finger lands, as x,y |
| `--to <x,y>` | where it lifts, as x,y |
| `--duration <ms>` | how long the drag takes, ms |

### `lynkeus back`

Pop the current route

### `lynkeus nav <route> [params]`

Jump straight to a route (a teleport, not a user action)

| Argument | |
|---|---|
| `route` | e.g. Settings.Main |
| `params` | JSON params (optional) |

### `lynkeus wait <what> [--in <target>] [--nth <n>] [--gone] [--scroll] [--timeout <ms>]`

Until a route or element appears (or leaves), or a number of ms

| Argument | |
|---|---|
| `what` | Route | #testId | "text" | 12 (index) | 100,200 | 800 (ms) |

| Flag | |
|---|---|
| `--in <target>` | the match nearest this target |
| `--nth <n>` | the nth match, from 0 |
| `--gone` | until it leaves the screen |
| `--scroll` | scroll until it is in the window |
| `--timeout <ms>` | give up after (default `10000`) |

### `lynkeus screenshot <file>`

What the screen looks like right now, written to a file

A device or simulator only: a host renders nothing to capture.

| Argument | |
|---|---|
| `file` | where to write the png |

### `lynkeus see <what> [--absent] [--within <ms>]`

Assert a route or element is on screen now (exit 1 if not)

| Argument | |
|---|---|
| `what` | Route | #testId | "text" | 12 (index) | 100,200 |

| Flag | |
|---|---|
| `--absent` | assert it is not there |
| `--within <ms>` | allow it this long to appear (default `0`) |

### `lynkeus idle [--quiet <ms>] [--timeout <ms>] [--after <commit>]`

Until the app stops committing: data arrived, animations done

A screen that has not started looks exactly like one that has finished — both are quiet. `--after <commit>`, given the commit count from before whatever was supposed to happen, waits for the app to commit past it first.

| Flag | |
|---|---|
| `--quiet <ms>` | no commit for this long counts as settled (default `300`) |
| `--timeout <ms>` | give up after (the answer says whether it settled) (default `5000`) |
| `--after <commit>` | a commit count from before: quiet only counts once the app has committed past it |

### `lynkeus requests [--last <n>]`

The HTTP requests the app made: method, path, status, ms

| Flag | |
|---|---|
| `--last <n>` | how many (default `30`) |

### `lynkeus trace [--since <seq>] [--last <n>]`

What happened, in order: routes, requests, store diffs, touches, commands

| Flag | |
|---|---|
| `--since <seq>` | only after this seq (from a previous trace) |
| `--last <n>` | how many (default `60`) |

### `lynkeus call <command> [params]`

An app command registered with qa.register (reset, busy, …)

| Argument | |
|---|---|
| `command` | its name |
| `params` | JSON params (optional) |

### `lynkeus hello`

What the app said about itself: platform, native, registered commands

### `lynkeus launch [bundleId] [--clean]`

Relaunch the app and wait for the agent

| Argument | |
|---|---|
| `bundleId` | or --app (optional) |

| Flag | |
|---|---|
| `--clean` | run the app's reset command first, if it is attached |

### `lynkeus why [target] [--route <Route>]`

Why the last thing failed: screen, requests and trace read as rules

Runs by itself after a failed press, wait, type, swipe or nav. Give it what you were looking for to sharpen the answer.

| Argument | |
|---|---|
| `target` | what was expected: Route | #testId | "text" | 12 (index) | 100,200 (optional) |

| Flag | |
|---|---|
| `--route <Route>` | the route that was expected |

### `lynkeus lint [--strict] [--save <file>] [--baseline <file>]`

Unlabeled controls, small targets, untranslated keys, covered or clipped elements

| Flag | |
|---|---|
| `--strict` | exit 1 on any warning |
| `--save <file>` | keep this screen's findings in a baseline file |
| `--baseline <file>` | print only what is new against a baseline file |

### `lynkeus perf [--since <seq>] [--last <n>]`

Per screen: requests on arrival, time to quiet, errors, stalls, the slowest call

| Flag | |
|---|---|
| `--since <seq>` | only after this trace seq |
| `--last <n>` | only the last n trace events |

### `lynkeus profile [action]`

What React spent rendering, per route, measured by the Profiler auto() mounts

`profile start` clears and starts recording, `profile` reports what was recorded since, `profile stop` reports and stops. Recording is off until started, so an app that never asks pays nothing.

| Argument | |
|---|---|
| `action` | start | stop (omit to report) (optional) |

## os

what the outside world hands the app: links, clock, sensors, the network, the simulator.

### `lynkeus os deeplink <url>`

Open a URL in the app, as the OS would hand it over

| Argument | |
|---|---|
| `url` | myapp://pay/abc or https://… |

Also accepted: `deeplink`.

### `lynkeus os appstate <state>`

Headless: AppState listeners see the change (background, then active: what refetches or re-locks)

| Argument | |
|---|---|
| `state` | active | background | inactive |

Also accepted: `appstate`.

### `lynkeus os network <state>`

Headless: airplane mode (requests fail, open sockets drop, NetInfo listeners hear it)

| Argument | |
|---|---|
| `state` | off | on |

Also accepted: `network`.

### `lynkeus os clock [--now <iso>] [--advance <ms>] [--reset]`

Headless: what Date answers (timers stay real)

| Flag | |
|---|---|
| `--now <iso>` | set the time |
| `--advance <ms>` | move the clock forward |
| `--reset` | back to the real clock |

Also accepted: `clock`.

### `lynkeus os biometrics [--available <kind>] [--next <success,fail,cancel>] [--fallback <outcome>]`

Headless: the sensor and what the next prompts answer

| Flag | |
|---|---|
| `--available <kind>` | FaceID | TouchID | none |
| `--next <success,fail,cancel>` | outcomes of the next prompts, in order |
| `--fallback <outcome>` | what a fallback prompt answers |

Also accepted: `biometrics`.

### `lynkeus os scan <value> [--type <qr|ean13|…>]`

Headless: the open camera's code scanner receives a value

| Argument | |
|---|---|
| `value` | what the code carries |

| Flag | |
|---|---|
| `--type <qr|ean13|…>` | code type (default `qr`) |

Also accepted: `scan`.

### `lynkeus os gallery [uri] [--cancel] [--name <name>] [--mime <type>]`

Headless: what the next image picker answers

| Argument | |
|---|---|
| `uri` | file the picker returns (optional) |

| Flag | |
|---|---|
| `--cancel` | the user cancelled |
| `--name <name>` | file name reported |
| `--mime <type>` | mime type reported |

Also accepted: `gallery`.

### `lynkeus mock [route] [--status <code>] [--body <json>] [--delay <ms>] [--times <n>] [--sticky] [--lost] [--clear] [--list]`

Headless: answer a request before the network (--sticky survives a reset)

| Argument | |
|---|---|
| `route` | 'GET /path' (a bare path matches any method) (optional) |

| Flag | |
|---|---|
| `--status <code>` | HTTP status to answer (default `200`) |
| `--body <json>` | JSON body |
| `--delay <ms>` | answer after |
| `--times <n>` | only this many times |
| `--sticky` | keep the rule across an app reset |
| `--lost` | let the request reach the server and fail it on the way back |
| `--clear` | drop every rule |
| `--list` | show the rules |

### `lynkeus os permissions <action> <service>`

Simulator: grant, revoke or reset a permission for the app

| Argument | |
|---|---|
| `action` | grant | revoke | reset |
| `service` | camera, photos, location, microphone, contacts, … |

### `lynkeus os push <payload>`

Simulator: deliver a push notification to the app

| Argument | |
|---|---|
| `payload` | '{"alert":"…"}' or a .json file |

### `lynkeus os appearance <mode>`

Simulator: light or dark

| Argument | |
|---|---|
| `mode` | light | dark |

### `lynkeus os location <where>`

Simulator: where the device is

| Argument | |
|---|---|
| `where` | <lat>,<lon> | clear |

### `lynkeus os language [tag]`

Simulator: relaunch the app in a locale

| Argument | |
|---|---|
| `tag` | de-DE, en-US, … (default: the locale in lynkeus.config.json) (optional) |

## map

what lynkeus knows before touching anything, from the app's source and from walks.

### `lynkeus map build [--as-base]`

Read the source once: routes, testIDs, navigations → .lynkeus/graph.json

| Flag | |
|---|---|
| `--as-base` | also keep it as graph.base.json, for `map check` to diff against |

### `lynkeus map screens`

Every route in the graph, and every route a run has actually opened

### `lynkeus map show <route>`

testIDs and navigations a screen is likely to have, from source

| Argument | |
|---|---|
| `route` | e.g. Settings.Main |

### `lynkeus map paths <route>`

What leads to a route: observed edges first, then static

| Argument | |
|---|---|
| `route` | e.g. Checkout.Confirm |

### `lynkeus map plan [--from <Route>] [--to <Route>]`

Directions from one route to another: which buttons to press, screen by screen

| Flag | |
|---|---|
| `--from <Route>` | starting route |
| `--to <Route>` | destination route |

Also accepted: `plan`.

### `lynkeus map impact <file>… [--depth <n>] [--direct]`

Screens a change can reach, nearest first

| Argument | |
|---|---|
| `file` | changed source files |

| Flag | |
|---|---|
| `--depth <n>` | how many imports away to look (default `4`) |
| `--direct` | only the screen and its importers |

### `lynkeus map ci [--force] [--depth <n>]`

Write a GitHub workflow that comments on each pull request which screens its diff reaches

Writes `.github/workflows/lynkeus-map-check.yml` in the app. On every pull request it builds the map from the sources (no app, no device, well under a second of analysis), runs `map check` against the base branch and keeps one comment on the PR up to date. `--force` overwrites an existing file.

| Flag | |
|---|---|
| `--force` | overwrite the workflow if it exists |
| `--depth <n>` | how many imports away the check looks (default `2`) |

### `lynkeus map check [--base <ref>] [--graph-base <file>] [--depth <n>]`

A branch from the app's side: screens its diff reaches, routes/navigations/testIDs that changed

| Flag | |
|---|---|
| `--base <ref>` | git ref to diff against (default `main`) |
| `--graph-base <file>` | graph to diff against (default .lynkeus/graph.base.json) |
| `--depth <n>` | how many imports away to look (default `4`) |

### `lynkeus map changes [--last <n>]`

testIDs that appeared, disappeared or moved on a recorded screen since it was last read

| Flag | |
|---|---|
| `--last <n>` | how many changes (default `30`) |

## Runs

flows, smokes, crawls and recordings.

### `lynkeus run <flow.json> [--var <k=v>] [--screenshots] [--diff] [--events]`

Replay a flow with variables; per-step timing, route and errors

| Argument | |
|---|---|
| `flow.json` | the flow file |

| Flag | |
|---|---|
| `--var <k=v>` | a flow variable (repeatable) |
| `--screenshots` | one capture per step |
| `--diff` | print what changed on screen after each step |
| `--events` | keep the app's analytics events per step (runs/…/events.jsonl); empties its buffer |

### `lynkeus events [--run <dir>] [--name <regex>]`

What the app told its analytics: live, or step by step in a run

Without `--run`, what the app has recorded so far (its `events` command, left as it is). With `--run <dir>` or `--run last`, the events a `run --events` kept, each with the step and route it happened on.

| Flag | |
|---|---|
| `--run <dir>` | a run folder, or `last` |
| `--name <regex>` | only events whose name matches |

### `lynkeus events diff <before> <after>`

The same flow on two builds: events that appeared, disappeared or changed shape

| Argument | |
|---|---|
| `before` | a run folder (main) |
| `after` | a run folder (the branch), or `last` |

### `lynkeus funnel check <name> [--run <dir>]`

Did a run produce a funnel: every step, in order, with the properties it needs

A funnel is `.lynkeus/funnels/<name>.json`: `{ "steps": [{ "event": "signup_started", "props": { "source": "string", "step": "number" } }, { "event": "signup_completed" }] }`. A property names a type the dashboard needs, or a value it filters on. Exit 1 when a step is missing, out of order, or has the wrong shape.

| Argument | |
|---|---|
| `name` | the funnel |

| Flag | |
|---|---|
| `--run <dir>` | a run folder, or `last` (default `last`) |

### `lynkeus funnel report [--last <n>]`

Across the recorded runs: which funnel steps some run produces, and which none does

| Flag | |
|---|---|
| `--last <n>` | how many recent runs (default `50`) |

### `lynkeus flake <flow.json> [--times <n>] [--var <k=v>]`

The same flow n times: how often it passes, and the step and error it dies on

| Argument | |
|---|---|
| `flow.json` | the flow file |

| Flag | |
|---|---|
| `--times <n>` | how many runs (default `5`) |
| `--var <k=v>` | a flow variable (repeatable) |

### `lynkeus smoke [Route.Prefix]… [--params <file>] [--screenshots] [--overlay-when <target>] [--overlay-flow <flow.json>]`

Open every parameter-free route (or the prefixes given) and record what renders

| Argument | |
|---|---|
| `Route.Prefix` | only routes under these prefixes (optional) |

| Flag | |
|---|---|
| `--params <file>` | route params type map, relative to the app |
| `--screenshots` | one capture per screen |
| `--overlay-when <target>` | a target the app raises on its own (a lock screen, a rating prompt) |
| `--overlay-flow <flow.json>` | the flow that clears it |

### `lynkeus crawl [Route] [--depth <n>] [--max <n>] [--to <Route>] [--fresh] [--overlay-when <target>] [--overlay-flow <flow.json>] [--login-flow <a.json,b.json>] [--var <k=v>] [--var-cmd <name='cmd'>] [--press-anything] [--verbose]`

Press every control it finds, learn where each leads (feeds map paths and plan)

Finishes a screen before it goes anywhere, so the controls that matter are not lost to whatever the first one opened, and remembers in .lynkeus/frontier.jsonl what it did not get to — a second run continues instead of repeating. `--to` walks towards a route instead of exploring everything. Read-only by default: every press happens, but the moment one makes the app write (a POST, PUT, PATCH or DELETE) the crawl reports it and stops exploring past it, and never presses that control again. Controls that must not be pressed at all go in lynkeus.config.json under crawl.never — lynkeus ships no list of its own, because which controls are irreversible depends on the app.

| Argument | |
|---|---|
| `Route` | where to start (default: the current screen) (optional) |

| Flag | |
|---|---|
| `--depth <n>` | how many screens deep (default `1`) |
| `--max <n>` | at most this many presses (default `80`) |
| `--to <Route>` | walk towards this route and stop on arrival |
| `--fresh` | ignore what earlier runs already pressed |
| `--overlay-when <target>` | a target the app raises on its own (a lock screen, a rating prompt) |
| `--overlay-flow <flow.json>` | the flow that clears it |
| `--login-flow <a.json,b.json>` | flows that log in again after a reset, comma-separated |
| `--var <k=v>` | a flow variable (repeatable) |
| `--var-cmd <name='cmd'>` | a variable produced by a shell command when needed (repeatable) |
| `--press-anything` | keep exploring past a press that wrote (a disposable environment only) |
| `--verbose` | print every recovery and decision |

### `lynkeus record [--out <flow.json>] [--so-far] [--screenshots]`

Watch what a person does in the app; Ctrl-C writes a flow with what each step caused

Touches are traced on device builds mounted with auto(); a host records routes and requests only. Lines typed on stdin run as commands meanwhile.

| Flag | |
|---|---|
| `--out <flow.json>` | where to write the flow |
| `--so-far` | draft from the trace as it stands and stop |
| `--screenshots` | one capture per touch, listed in <out>.strip.md |

### `lynkeus snapshot <name> [--update] [--pixels] [--tolerance <ratio>] [--no-freeze]`

A baseline for a screen: its tree (diffed like code) and, on a simulator, its pixels

The tree is the screen as nested lines of meaning: kinds, labels, testIDs, values, states, no geometry. A renamed heading or a lost button is a changed line; a font hint is nothing. `--pixels` adds a screenshot compared with a red-on-grey diff. Baselines live under .lynkeus/snapshots/; what differs goes under runs/.

| Argument | |
|---|---|
| `name` | the baseline name, e.g. onboarding-hero |

| Flag | |
|---|---|
| `--update` | the change is intended: overwrite the baseline |
| `--pixels` | also compare a screenshot (simulator) |
| `--tolerance <ratio>` | pixels allowed to differ, as a fraction (default `0.001`) |
| `--no-freeze` | do not pin the status bar before the screenshot |

### `lynkeus case run [files]… [--host] [--once] [--report <file>] [--events <dir>] [--dry-run]`

Run cases: setup through fixtures, steps against the app, the evidence when one fails

A case is a markdown file with `setup`, `steps` and `expected` (`lynkeus case init` writes an example and the reference). Without files, every case in `cases.dir`. A failed case runs once more before it counts as failed, unless `--once`. `--host` hosts the app in Node for the run.

| Argument | |
|---|---|
| `files` | case files (default: every .md under cases.dir) (optional) |

| Flag | |
|---|---|
| `--host` | start `headless start` for the run and stop it after |
| `--once` | no second chance for a case that fails |
| `--report <file>` | append one JSON line per case |
| `--events <dir>` | keep what the app told its analytics, per case, as <dir>/<case id>/events.jsonl |
| `--dry-run` | parse and list the steps without running them |

### `lynkeus case init [--force]`

Write an example case, the reference of the format and a fixtures server to start from

| Flag | |
|---|---|
| `--force` | overwrite what is there |

## headless

the app hosted in Node under jest, no simulator.

### `lynkeus headless start [--entry <file>]`

Host the app in Node (jest + RNTL) and wait for a driver; same protocol, no simulator

Needs LYNKEUS_TOKEN in the environment (the value the app reads for its token). LYNKEUS_PORT moves the host and its driver together; LYNKEUS_HOST says where the driver is listening, for a host that is not in the same place as its driver (a container dialling out, say). Arguments after `--` go to jest. When the host crashes, the last lines say what the error usually means.

| Flag | |
|---|---|
| `--entry <file>` | the headless entry (or `entry` in lynkeus.config.json) |

Also accepted: `headless`.

### `lynkeus headless init [--entry <file>] [--component <App.tsx>] [--api-env <NAME>] [--auto] [--force]`

Write the headless entry: default mocks, a local-backend guard, your App

| Flag | |
|---|---|
| `--entry <file>` | the headless entry (or `entry` in lynkeus.config.json) |
| `--component <App.tsx>` | the App component file (found by itself when standard) |
| `--api-env <NAME>` | the env var the app reads its API base from |
| `--auto` | also mount the agent from index.js with auto() |
| `--force` | overwrite an existing entry |

### `lynkeus headless doctor [--entry <file>] [--fix] [--explain <text>]`

What lynkeus mocks, and which native modules still need one

| Flag | |
|---|---|
| `--entry <file>` | the headless entry (or `entry` in lynkeus.config.json) |
| `--fix` | write stubs for the uncovered modules into the entry |
| `--explain <text>` | turn a jest error into its usual cause and fix |

## Modes

`lynkeus session` keeps one connection and reads JSON arrays of arguments on stdin, one command per line, answering one JSON object per line (`{ok, out, json?}` or `{ok:false, error, why?}`); `exit` ends it. `lynkeus mcp` serves the core commands as MCP tools over stdio; `lynkeus mcp --full` serves all of them. `lynkeus help <command>` prints one command; `lynkeus help --markdown` prints this document.

## Global flags

| Flag | |
|---|---|
| `--root <dir>` | the app's folder (default: the current one) |
| `--device <udid|name>` | simulator udid or name |
| `--app <bundleId>` | bundle id, for launching and simulator commands |
| `--launch` | relaunch the app before attaching (needs --app) |
| `--attach-timeout <ms>` | how long to wait for the app to attach (default `15000`) |
| `--json` | machine-readable output when the command has one |
| `--help` | this text |

