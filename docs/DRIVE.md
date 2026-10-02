# Drive the app

Mount the agent once, then drive the running app from a terminal, from Node,
or from anything that can hold a WebSocket. Every command and flag is listed
in [COMMANDS.md](COMMANDS.md); the vocabulary is in [CONCEPTS.md](CONCEPTS.md).

## Mount it

One line in your entry, before `registerComponent`, and no screen renders
anything:

```ts
// index.js
import { auto } from 'lynkeus-agent/auto';
auto({ token: process.env.LYNKEUS_TOKEN, enabled: __DEV__ && config.ENV !== 'prod' });
```

`auto()` wraps the root through `AppRegistry` and finds your React Navigation
container by itself (it looks for the container's context value, so no ref
has to be passed around). `npx lynkeus headless init --auto` writes it for you.
Prefer the explicit component when you want to hand it an adapter for another
router:

```tsx
import { Lynkeus, qa, reactNavigationAdapter } from 'lynkeus-agent';

// Optional, but the two names drivers rely on:
qa.register('reset', async () => { await session.logout(); await cache.clear(); });
qa.register('busy', () => queryClient.isFetching() > 0);
// …and anything else your app wants to expose to a test:
qa.register('setFlag', ({ name, on }) => flags.override(name, on));
// Stores show up in the trace, so a failure says what the app believed:
qa.observe('session', useSessionStore);

const App = () => {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer ref={ref}>
      <RootNavigator />
      <Lynkeus
        navigation={reactNavigationAdapter(ref)}
        enabled={__DEV__ && config.ENV !== 'prod'}
        app={{ name: 'myapp', env: config.ENV }}
      />
    </NavigationContainer>
  );
};
```

An app that mounts both keeps working: the first client to start owns the
socket and the second stays quiet.

| Prop | Default | |
|---|---|---|
| `enabled` | `__DEV__` | Gate it further: a debug build pointed at production is not a QA surface. |
| `navigation` | none | An adapter; `reactNavigationAdapter(ref)` ships. Without one you still get screen, touches and waits, not routes. |
| `host`, `port` | `localhost` / `10.0.2.2`, `8123` | Where the driver listens. `LYNKEUS_PORT` moves both ends when you run several at once. |
| `token` | — | The driver must open with `{event:'auth', token}` before being served. Keeps other local processes from driving the app. The CLI reads it from `LYNKEUS_TOKEN`. |
| `app` | — | Free-form, sent in `hello` (name, version, environment). |

## Drive it

Anything that runs more than a couple of commands keeps one connection:

```sh
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
npx lynkeus mcp                          # the same commands as MCP tools, for an AI agent
```

A step in a session costs about 50 ms; the same command on its own pays for a
process and a connection, about 1.5 s. The invocations below are the way to
look at something once. From the app's folder, with a dev build running on a
booted simulator:

```sh
npx lynkeus map build                    # read the source once: routes, testIds, navigations → .lynkeus/graph.json
npx lynkeus hello                        # what the app said about itself: platform, native, registered commands
npx lynkeus screen                       # what is on screen right now, in ~8 ms
npx lynkeus screen --tree                # the same as nested lines of meaning, no geometry
npx lynkeus press '#next-button'         # by testId, "text", index or x,y
npx lynkeus type "1124888418" '#phone-input'
npx lynkeus swipe up                     # or on a target: drives its gesture (a slider, a sheet)
npx lynkeus wait Settings.Main               # or a target: '#next-button', with --gone to wait for it to leave; or 800 (ms)
npx lynkeus wait '#row-25' --scroll          # swipe the nearest scroller until it is in the window
npx lynkeus press '#like-message-button' --in 'hi from Ana'   # the one that goes with that message
npx lynkeus see '#pay-button'            # assert it is there now (exit 1 if not); --absent, --within <ms>
npx lynkeus idle                         # until the app stops committing: data arrived, animations done
npx lynkeus requests                     # 4xx/5xx after an action: the backend half of the check
npx lynkeus trace --last 20              # routes, requests, store diffs, touches and commands, in order
npx lynkeus call reset                   # an app command registered with qa.register
npx lynkeus nav Checkout.Confirm '{"id":"abc"}'   # a teleport, not a user action
npx lynkeus back
npx lynkeus launch --clean               # relaunch the app, run its reset command, wait for the agent
npx lynkeus map plan --from Settings.Main --to Settings.Profile   # which buttons to press, screen by screen
npx lynkeus run flows/login.json --var phone=1124888418 --diff --screenshots
npx lynkeus smoke                        # open every parameter-free route, record what renders
npx lynkeus crawl Settings.Main --depth 2    # press every safe button, learn where it leads
npx lynkeus lint                         # unlabeled controls, small targets, untranslated keys, covered/clipped
npx lynkeus perf                         # per screen: requests on arrival, time to quiet, errors, stalls, the slowest call
npx lynkeus mcp                          # the core of it as MCP tools for an AI harness (--full: all)
```

Short forms (`plan`, `deeplink`, `clock`, `biometrics`, …) are accepted as
aliases; the grouped names above are the documented ones.

From Node:

```ts
import { AgentServer } from 'lynkeus-client';

const server = new AgentServer({ port: 8123 });
await server.listen();
await server.waitForApp();                 // the app dials in on launch
await server.call('press', { testId: 'get-started-button' });
const screen = await server.call('screen');
```

Or from anything else: the protocol is a dozen JSON methods, documented in
[PROTOCOL.md](PROTOCOL.md).

### One process, many commands

Spawning a CLI per step costs more than the step. `lynkeus session` keeps one
connection open and reads commands as JSON arrays on stdin, one JSON line of
output each:

```sh
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

That is what a suite runner should use: a press drops from ~1.5 s (process
start, connect, exit) to ~50 ms.

## Use cases

**A test in your own runner.** Mount the agent, start `AgentServer`, drive the
app from jest/vitest/whatever you already use. Assertions are plain code; the
app is the fixture.

**A suite that composes with backend tooling.** Cases in YAML/Markdown, UI
steps through lynkeus, state through your own commands (whatever your backend
needs: a record created, a flag flipped, a status forced). Neither tool knows
about the other; the runner interleaves them.

**CI with no device farm.** `lynkeus headless start` in a container, your
backend in another. No simulators, no flakiness from animations, and shards
that scale with cores: one host per `LYNKEUS_PORT`. See
[HEADLESS.md](HEADLESS.md).

**An AI that drives the app.** `lynkeus mcp` exposes screen, press, type, wait,
why, call, os deeplink, map show and map plan as MCP tools; `--full` adds every
other command, at about five times the tokens per turn. The model sees structured
elements instead of pixels, so it can decide the next step from facts.
`lynkeus map plan --from … --to …` gives it directions instead of guesses.

**Reaching states a real backend won't hand you.** `lynkeus mock 'GET /path'
--status 500` (or `--delay`, an empty list, a specific body) answers before the
network, so error states, timeouts and empty states are one line each, with no
backend fixture. `lynkeus os clock`, `lynkeus os appstate` and `lynkeus os deeplink`
do the same for time, foreground/background and links. All headless-only
except `os deeplink`; on a device you get the real thing.

**A quick accessibility and copy pass.** `lynkeus lint` reads the current screen
and flags controls with no label, tap targets under 44pt, text that is an
untranslated i18n key, interactive elements a touch cannot reach, and duplicate
testIds: the review comments no one runs on every build.

**Catching UI drift.** `lynkeus screen --record` (or `LYNKEUS_RECORD_SCREENS=1`)
stores each route's structure under `.lynkeus/screens/`, and `lynkeus map changes`
lists the testIds that appeared, disappeared or moved since the last read.
A suite that never asserts on `#mute-toggle` still tells you the day it
vanished. `lynkeus snapshot <name>` keeps a screen's tree as a baseline and
diffs it like code.

**Smoke and exploration.** `lynkeus smoke` opens every parameter-free route and
records what rendered. `lynkeus crawl` presses every safe button and learns
where it leads, filling in the observed edges the planner uses. Both are in
[KNOWLEDGE.md](KNOWLEDGE.md).

## App commands

`qa.register(name, fn)` exposes anything the app can do to whoever drives it,
reachable as `lynkeus call <name> '<json>'`. `lynkeus hello` lists what the app
registered. Two names are conventions every driver looks for:

| Command | |
|---|---|
| `reset` | Log out, clear storage and caches. A driver calls it before each case (`lynkeus launch --clean` does too); a stale query cache is the most common cross-test bug. |
| `busy` | `true` while the app is fetching. Lets a driver wait for data, not for a timer. |

`qa.observe(name, store)` puts a store's changes in the trace, so a failure
report says what the app believed at that moment, not just what it painted,
and `lynkeus call stores '{"name":"session"}'` reads its state.

`qa.event(name, props)`, called from wherever the app reports to its
analytics, records the event in the trace and in a buffer that
`lynkeus call events` reads (`'{"clear":true}'` empties it). An app that
already keeps its own buffer can register `events` over the default.

## How it reads the screen

The React DevTools hook (present in development) exposes the fiber tree.
The agent walks it, keeps the host components a user could see or touch,
measures each through the Fabric shadow tree (a synchronous JSI call, no
bridge) and asks the platform which of them a touch would actually reach.
Inactive screens of a stack or tab navigator are skipped; a modal or a sheet
marks what it covers. The whole snapshot is one JavaScript tick.

Values of `secureTextEntry` fields are masked. Request logging records
method, path, status and duration; never headers or bodies, and sensitive
query values are redacted.

## Why did that fail

After a failed `press`, `wait`, `type` or `nav`, lynkeus reads its own
evidence (the screen, the last requests, the trace) as rules and says what
it found: the navigator is dead, every request is 401, the backend answered
5xx, the target is there but covered or disabled, the text is a wording or
accent away, the list is capped by look-alikes, requests were still in
flight. `lynkeus why <target>` asks the same question at any moment
(`--route <Route>` when a route was expected); in session mode the answer
rides along in the JSON (`why`), so a runner prints it under the failure.

```sh
npx lynkeus flake flows/login.json --times 10   # passed 8/10; 2× at step 4 (waitFor Settings.Main): Timed out …
```

An intermittent case becomes a number and a step: the same flow n times,
and a histogram of where it died and with what.

## Platform notes

- **iOS**: touch synthesis uses private UIKit API, the technique KIF and Detox
  rely on. It is wrapped in `#if DEBUG`; the symbols do not exist in a release
  build. Requires the New Architecture.
- **Android**: `MotionEvent`s dispatched to the activity window; keys through
  the focused `EditText`. Refuses to run unless the app is debuggable
  (`FLAG_DEBUGGABLE`).
- **Expo**: works in a development build (not Expo Go). Add the package and
  run `expo prebuild`.
- **Headless**: Node 20+, the app's own jest config and babel transform.

### Security posture

- Debug builds only. Native touch synthesis is absent from release binaries,
  not merely disabled; the JS client is never required unless `enabled`.
- The app dials **out** to loopback (or the emulator gateway). Nothing listens
  inside the app, and nothing is reachable from the network.
- With `token`, only the driver that knows the secret is served.
- Gate `enabled` on your environment. A debug build that talks to a real
  backend with real accounts should not run the agent.
