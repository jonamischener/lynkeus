# Concepts

The words the rest of the docs use, each in a few sentences.

## Agent, driver, host

The **agent** is the code mounted inside your app (`lynkeus-agent`).
In a dev build it opens a WebSocket to loopback and answers requests: what is
on screen, press this, type that, wait for a route. Nothing listens inside the
app; the app dials out.

The **driver** is whatever holds the other end of that socket: `npx lynkeus`,
an `AgentServer` in your own Node runner, an MCP server in front of an LLM,
a CI job. The wire contract is in [PROTOCOL.md](PROTOCOL.md).

The **host** is the process that runs the app when there is no simulator.
`lynkeus headless start` renders your app under jest and React Native Testing
Library, in Node, and the agent inside it dials out exactly as on a device.
See [HEADLESS.md](HEADLESS.md).

## Sessions and MCP

Spawning a CLI per step costs more than the step. `lynkeus session` keeps one
connection open and reads commands as JSON arrays on stdin, one JSON line of
output each:

```sh
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

A press drops from roughly 1.5 s (process start, connect, exit) to about
50 ms. Commands that run a whole flow or host the app are not available in a
session. When a step fails, the answer carries `why` alongside the error.

`lynkeus mcp` serves the commands a turn needs as MCP tools over stdio, for an
AI harness: screen, press, type, wait, why, call, os deeplink, map show and map
plan. `lynkeus mcp --full` adds the rest (crawl, record, snapshot, doctor…). The
model sees structured elements instead of pixels.

## Targets

Every command that touches or looks for an element takes a target, spelled
one of four ways:

| Spelling | Matches |
|---|---|
| `#next-button` | the element with that `testID` |
| `"Continue"` | a control (button or input) by exact label, then by substring; a paragraph only by exact text |
| `12` | the element at that index in the last screen listing |
| `100,200` | a point, in window points |

Covered elements are never matched. When two elements tie, the later one
wins: it draws on top.

## Routes and paths

A **route** is a screen name as the navigation adapter reports it, such as
`Settings.Main` or `Checkout.Confirm`. The **path** is the chain of navigators from
the root down to the focused screen. Both come from the adapter
(`reactNavigationAdapter` ships); without one, lynkeus still sees elements but
no routes, so `wait Settings.Main` has nothing to wait for.

## Screen

`lynkeus screen` is the app as React rendered it, one JavaScript tick ago. It
lists the route, the path and every **element** a user could see or touch.
Each element has a **kind** (`button`, `input`, `text`, `scroll`, `switch`,
`image`, `view`), a frame in window points, and whatever it carries: testID,
text or label, an input's **value** (masked for `secureTextEntry`),
placeholder, focus.

Three flags matter more than the rest. **disabled** means the control will not
answer a touch. **covered** means a touch at its centre would land on
something else, as the platform's own hit test reports. **hidden** means the
app is not presenting it at all — it belongs to another tab, or to the screen
a sheet is covering — and says which of those it is. An app keeps far more
mounted than it shows, so this is what separates the screen from the tree; a
screen presenting a sheet or a dialog names it in `presenting`.

`lynkeus screen --tree` prints the same screen as nested lines of meaning
(kind, label, testID, value, state) with no geometry. That is the form to
diff: a renamed heading is a changed line, a font hint is nothing.
`lynkeus snapshot` keeps trees as baselines.

## Flows and recording

A **flow** is a JSON file: a name, the variables it needs, and a list of
steps (`press`, `type`, `waitFor`, `assert`, `call`, `navigate`, `deepLink`,
`keypad`, `note`, and a few more). Values may reference run variables
(`{{phone}}`) or results saved by earlier `call` steps (`{{user.pin}}`).
`lynkeus run` replays one; `lynkeus flake` replays it n times.

`lynkeus record` writes a flow from what a person does in the app: on a device
build mounted with `auto()`, each touch becomes a press step, followed by
what it caused. See [KNOWLEDGE.md](KNOWLEDGE.md#record-what-a-person-does).

## Graph and observed edges

The **graph** (`.lynkeus/graph.json`, from `lynkeus map build`) is static: lynkeus
reads the app's source once and records every route, the file that declares
it, the testIDs a screen is likely to have, and the navigations it can
perform. It is a guess made from code.

**Observed edges** (`.lynkeus/edges.jsonl`) are facts from runs: this button,
pressed on this screen, actually landed there. `lynkeus crawl` collects them,
and `lynkeus map paths` and `lynkeus map plan` prefer them over the static
guess. An edge can end in a **place** that is not a route — `Settings.Main#account-button`
is the sheet that control opens, named after it because that is the only way
back in. The **frontier** (`.lynkeus/frontier.jsonl`) is what the crawl has not
got to: per place, what was pressed and what is still owed, so a second run
continues where the first stopped. See [KNOWLEDGE.md](KNOWLEDGE.md).

## Headless host and simulator

Both speak the same protocol, so every drive command works on either. They
differ in what is real.

On a **simulator** the native layer is real: the camera, gestures, push
delivery, WebViews, native crashes and pixels. `lynkeus os permissions`,
`os push`, `os appearance`, `os location` and `os language` reach the
simulator from outside.

Under the **headless host** the native layer is mocked and the JavaScript
runs against a real backend. What the OS would hand the app is a command
instead: `lynkeus os deeplink`, `os appstate`, `os clock`, `os biometrics`,
`os scan`, `os gallery`, and `lynkeus mock` for the network. That leaves out,
on purpose: the real camera and decoder, complex native gestures, push
delivery, what a WebView renders, native crashes, and pixels. For those the
same cases run on a simulator; only the way the host starts differs.

## `.lynkeus/`

Everything lynkeus keeps lives under `.lynkeus/` in the app's folder. All of it
is a build product: safe to delete, cheap to regenerate.

| Path | |
|---|---|
| `graph.json` | the static graph from `lynkeus map build` |
| `graph.base.json` | the graph kept with `--as-base`, for `map check` to diff against |
| `edges.jsonl` | observed edges from runs and crawls |
| `frontier.jsonl` | what a crawl has pressed in each place, and what it still owes |
| `screens/` | screen structures kept by `lynkeus screen --record`, read by `map changes` |
| `snapshots/` | tree and pixel baselines from `lynkeus snapshot` |
| `runs/` | artifacts of runs, smokes, crawls, recordings and snapshot diffs |

## Configuration

Values otherwise repeated on every invocation go in `lynkeus.config.json` in
the app's folder:

```json
{
  "entry": "qa/headless.tsx",
  "apiEnv": "API_URL",
  "port": 8123,
  "device": "iPhone 16",
  "app": "com.example.myapp",
  "attachTimeout": 15000,
  "lintBaseline": ".lynkeus/lint.json"
}
```

Flags win over the environment, and the environment over the file.
`LYNKEUS_PORT` moves the app, the host and the driver together, so several
pairs can run on one machine. `LYNKEUS_TOKEN` is the shared secret between the
app and its driver. Global flags:
`--root`, `--device`, `--app`, `--launch`, `--attach-timeout`, `--json`,
`--help`.

## What lynkeus does not know

Nothing about your product. It has no list of your screens, no idea what your
buttons do, no notion of a user, a session or anything your product calls its own. Everything it
reports it read from the running app or from your source.

Where a decision needs product knowledge, it is yours to supply, and it lives
in `lynkeus.config.json` rather than in the tool:

| Decision | Where it lives |
|---|---|
| Which controls a crawl must never press | `crawl.never`, and it starts empty: lynkeus ships no words, because which controls are irreversible depends on the app. A read-only crawl already stops at the first press that makes the app write |
| Which overlay the app raises on its own, and how to clear it | `--overlay-when` plus a flow you write |
| Which components carry a value worth reading (a QR, a barcode) | `valueComponents` on the host |
| How to log in again after a reset | `--login-flow`, flows you write |
| What language the app speaks | `language` and `locale` — lynkeus never reads your copy, it passes them on: `os language` defaults to them, the generated headless entry mocks them, MCP reports them |
| What a route means, what state a case needs | your own tooling; lynkeus never fabricates state |
| Which of your screens is worth reaching first | `crawl --to <Route>`; without one it explores everything, in the order the app renders it |

If you find product knowledge baked into lynkeus itself, that is a bug: open
an issue.
