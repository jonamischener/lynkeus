# Knowledge: what lynkeus knows before it touches anything

Everything here lives under `.lynkeus/` in the app's folder and is a build
product: safe to delete, cheap to regenerate. The vocabulary (graph, edges,
flows, trees) is in [CONCEPTS.md](CONCEPTS.md); flags in
[COMMANDS.md](COMMANDS.md).

## The map

`lynkeus map build` parses the app once and writes `.lynkeus/graph.json`: every
route, the file that declares it, the testIds a screen is likely to have, and
the navigations it can perform. Runs add observed edges (`.lynkeus/edges.jsonl`):
this button, from this screen, actually landed there.

| Command | |
|---|---|
| `lynkeus map build [--as-base]` | read the source; `--as-base` also keeps it as `graph.base.json` for `map check` |
| `lynkeus map screens` | every route in the graph |
| `lynkeus map show <Route>` | testIds and navigations that screen is likely to have, from source |
| `lynkeus map paths <Route>` | what leads to a route: observed edges first, then static |
| `lynkeus map plan --from <A> --to <B>` | directions: which buttons to press, screen by screen |
| `lynkeus map impact <file>… [--depth n] [--direct]` | screens a change can reach, nearest first |
| `lynkeus map check [--base ref]` | a branch from the app's side: screens reached, graph diff |
| `lynkeus map changes [--last n]` | testIds that appeared, disappeared or moved on a recorded screen |

`map plan` and `map paths` prefer observed edges over the static guess, so
the more the app has been walked, the better the directions.

## Edges: crawl and smoke

`lynkeus crawl [Route] --depth <n>` presses every safe control it finds and
learns where each leads, writing the observed edges the planner uses. It starts
from the current screen when no route is given, stops after `--max` presses,
and can log in again after a reset (`--login-flow a.json,b.json`, with
`--var` and `--var-cmd` for the values those flows need). `--verbose` prints
every recovery and decision.

It finishes a screen before it goes anywhere. Depth-first, the second control
on a screen takes the whole budget into whatever it opened, and the controls
that matter are rarely the first ones; so every control is pressed, and only
then does the crawl go back into what they opened — sheets first, since a
sheet exists only while the screen holding it is open and a route can always
be reached again.

What it did not get to is in `.lynkeus/frontier.jsonl`: per place, the controls
already pressed and the ones still owed. The next run picks those up instead of
repeating the first screen, so coverage accumulates across runs rather than
resetting. `--fresh` ignores it.

`--to <Route>` walks towards a route instead of exploring: at each screen it
presses what `map plan` says leads there, follows it down immediately, and
stops on arrival. Two presses to a screen behind a sheet, rather than a sweep.

## Places, not just routes

A sheet, a dialog or anything else the app presents over a screen is a state of
that route, not a route of its own — `lynkeus screen` reports it as
`presenting` and everything under it as `hidden`. The graph writes it
`Route#control`, named after the control that opens it, because that is also
the only way back in:

```
Settings.Main                  -[account-button]->  Settings.Main#account-button
Settings.Main#account-button   -[delete-account-button]->  Account.Delete
```

`map plan` routes through them like any other step and says when one opens a
layer. Static analysis knows nothing about them: source describes a screen, not
what is covering it, so these edges only ever come from walking.

`lynkeus smoke [Route.Prefix]…` opens every parameter-free route (or only those
under the prefixes given) and records what rendered; `--screenshots` adds one
capture per screen, `--params <file>` supplies a route params type map for
routes that need one.

An overlay the app raises on its own (a lock screen, a rating prompt, a
forced-update wall) is yours to describe: hand both commands
`--overlay-when '#key-1' --overlay-flow flows/keypad.json`, and the flow
clears it whenever the target shows up.

## Flows: run and flake

`lynkeus run flows/login.json --var phone=1124888418` replays a flow and
reports per-step timing, route and errors. `--diff` prints what changed on
screen after each step; `--screenshots` keeps one capture per step under
`.lynkeus/runs/`.

`lynkeus flake flows/login.json --times 10` runs the same flow n times and
reports how often it passed, and the step and error it died on:

```
passed 8/10; 2× at step 4 (waitFor Settings.Main): Timed out …
```

An intermittent case becomes a number and a step.

## Record what a person does

On a device build mounted with `auto()`, every touch goes into the trace,
resolved to the element under the finger. `lynkeus record` watches the trace
while someone uses the app and, on Ctrl-C, writes a flow (`--out
flows/name.json`): one press per touch and, after each, what it caused (the
route it led to, the requests it fired, the stores it changed). Those are the
assertions a case needs, not only the steps. `--so-far` drafts from the trace
as it stands and stops.

`--screenshots` adds one capture per touch, taken once the screen settles,
listed in a strip next to the flow so a person can review what was recorded
before keeping it. Lines typed on stdin run as commands meanwhile, so a
script can drive part of a recording.

Under the headless host there are no touches to trace; a recording there
holds routes and requests only.

## Lint, with a baseline

`lynkeus lint` reads the current screen and flags controls with no label, tap
targets under 44pt, text that is an untranslated i18n key, interactive
elements a touch cannot reach, and duplicate testIds. `--strict` exits 1 on
any warning.

```sh
npx lynkeus lint --save .lynkeus/lint/home.json        # on main: keep this screen's findings
npx lynkeus lint --baseline .lynkeus/lint/home.json    # on the branch: print only what is new
```

`lintBaseline` in `lynkeus.config.json` names the file when `--baseline` is
given none.

## Perf

`lynkeus perf` reads the trace and reports, per screen: requests on arrival,
time to quiet, errors, stalls, and the slowest call. `--since <seq>` limits
it to what happened after a trace seq; `--last <n>` to the last n events.

## Snapshots: trees, and pixels deliberately few

```sh
npx lynkeus snapshot onboarding-hero            # first time: writes .lynkeus/snapshots/onboarding-hero.tree.txt
npx lynkeus snapshot onboarding-hero            # later: diffs the tree like code; what differs goes under runs/
npx lynkeus snapshot onboarding-hero --update   # the change was intended
npx lynkeus snapshot onboarding-hero --pixels   # on a simulator, also compare a screenshot
```

The tree is the screen as nested lines of meaning: kinds, labels, testIDs,
values, states, no geometry. A renamed heading or a lost button is a changed
line; a font hint is nothing. It works everywhere, the headless host
included.

`--pixels` adds a screenshot compared with a red-on-grey diff
(`--tolerance <ratio>` for how many pixels may differ). The status bar is
frozen first (9:41, full battery) so the clock does not count; `--no-freeze`
skips that. Keep pixels for the screens where the visual *is* the product: a
an illustration, a chart, a map. Everything else is better served by the
tree.

For drift across a whole suite rather than one named screen,
`lynkeus screen --record` (or `LYNKEUS_RECORD_SCREENS=1`) keeps each route's
structure under `.lynkeus/screens/`, and `lynkeus map changes` lists what moved
since the last read. A suite that never asserts on `#mute-toggle` still tells
you the day it vanished.

## A branch, from the app's side

```sh
npx lynkeus map build --as-base        # on main: keep the graph as .lynkeus/graph.base.json
npx lynkeus map check --base main      # on the branch
```

`map check` diffs the branch against `main`, lists the screens its changed
files can reach (nearest first, with the import they reach them through),
and what the screen graph gained or lost: routes, navigations, testIDs.
`--graph-base <file>` points it at another baseline; `--depth <n>` bounds
how many imports away it looks. `lynkeus map impact <file>…` answers the
first half for an explicit list of files. A name imported through a barrel
(`import { useThing } from '~hooks'`) counts as an import of the file that
defines it, so a change to one hook reaches the screens that use that hook,
not every screen that imports any; the barrel reaches them all only when the
barrel itself changes.

`lynkeus lint --save <file>` on main and `lynkeus lint --baseline <file>` on the
branch print only the findings that are new. Together they answer what a
review agent needs: which cases to run, and whether the change moved
anything it did not mean to.

`lynkeus map ci` writes a GitHub workflow that does this on every pull request
and keeps one comment on it up to date with the screens the diff reaches.

## Knowledge travels in the pull request

There is no server: everything lynkeus learns is text under `.lynkeus/`, and
it changes the way code does — in a pull request someone reviews.

- **With the feature.** A run with `LYNKEUS_RECORD_SCREENS=1` leaves the
  screens it read under `.lynkeus/screens/`. When a branch changes a screen,
  commit what the run recorded in the same pull request as the code that
  changed it: the reviewer sees the new controls next to the diff that added
  them, and `map changes` on main stays quiet.
- **Without a feature.** A nightly run over main can find the app moved on
  its own (a flag flipped, a backend answer changed). Open that as its own
  pull request, the way a dependency bot does, with `lynkeus map changes` as
  its description.
- **Before running anything.** `map check` on the branch names the screens
  its diff reaches; crossed with which cases touch which routes, it names the
  cases to run. Those that fail get a `lynkeus why`, the case or the code gets
  fixed, and the pull request carries both.

## Analytics: events and funnels

`lynkeus run <flow> --events` drains the app's `events` command after every
step and keeps what it recorded as `events.jsonl` in the run folder, each event
with the step and route that caused it (the app's own buffer, or `qa.event`).
`lynkeus events --run last` reads it back.

A funnel is the analytics contract, as a file:

```json
// .lynkeus/funnels/signup.json
{ "steps": [
  { "event": "signup_started", "props": { "source": "string", "step": "number" } },
  { "event": "signup_completed", "props": { "method": "email" } }
] }
```

A property names a type the dashboard needs, or a value it filters on.
`lynkeus funnel check signup --run last` says which step never happened,
came out of order, or changed shape (exit 1). `lynkeus events diff <main run>
<branch run>` lists the events a build added, lost, or reshaped — a lost or
reshaped one exits 1, so a pull request that breaks a dashboard says so before
anyone looks at the dashboard. `lynkeus funnel report` shows which funnel steps
some recorded run produces and which none does: coverage of analytics, not
conversion, since a scripted run always converts.
