# Headless: the app in Node, no simulator

`lynkeus headless start` writes a jest test that never ends, imports your
entry, and renders it with React Native Testing Library. The agent inside the
app dials out exactly as it does on a device, so every command in
[DRIVE.md](DRIVE.md) works unchanged.

```sh
npx lynkeus headless init         # writes qa/headless.tsx: default mocks, local-backend guard, your App (--auto mounts the agent too)
npx lynkeus headless doctor       # what lynkeus will mock, and which native modules still need one (--fix writes the stubs)
LYNKEUS_TOKEN=secret npx lynkeus headless start   # hosts the app and waits for a driver on 8123
```

`headless start` needs `LYNKEUS_TOKEN` in the environment: a hosted app talks to a real backend, and
without a token any local process could drive it. `LYNKEUS_PORT` moves the host
and its driver together. Arguments after `--` go to jest. The entry path can
live in `lynkeus.config.json` as `entry` instead of `--entry` on every call;
`apiEnv` there is the variable the local-backend guard checks.

The host renders without `React.StrictMode`: production has none, and its
double renders and double-mounted effects double every request, commit and
millisecond the host measures. `"strictMode": true` in `lynkeus.config.json`
keeps it.

When the host crashes, the last thing printed is what the error usually
means and the fix. `lynkeus headless doctor --explain "<first line>"` does the
same for an error you paste.

## The entry

Your entry, `qa/headless.tsx` by default, exports `App` and, optionally, a
`navigation` adapter. It is the one place that knows your app:

```tsx
import { installDefaultMocks } from 'lynkeus-headless/mocks';

// Only what lynkeus cannot guess: your own native modules, app-relative paths.
jest.mock('../app/native/Updater', () => ({ /* … */ }));

installDefaultMocks({
  network: 'real',                       // let the app reach your local backend
  networkHosts: ['127.0.0.1', 'localhost'],   // and nothing else (the default)
  locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },
});

const { default: App } = require('../app/App');
export { App };
```

`installDefaultMocks` mocks what is installed and would otherwise explode in
Node: MMKV, keychain, device-info, safe-area-context, localize, async-storage,
worklets, pager-view, video, fast-image, biometrics, in-app-review. Reanimated
and gesture-handler are deliberately left alone (their jest story is a babel
plugin, not `jest.mock`); pass `overrides` if your app wants them mocked.
Options: `skip`, `overrides`, `network`, `networkHosts`, `websocket`,
`animations`, `deviceVersion`, `locale`.

`headless init` finds your App component when it sits in a standard place
(`--component` otherwise), takes `--api-env <NAME>` for the guard, and with
`--auto` also adds the `auto()` mount to `index.js`. `--force` overwrites an
existing entry.

## What you get and what you give up

- **Get**: no simulator, no build, start in ~40 s, several apps at once
  (`LYNKEUS_PORT`), a real backend if you point it at one, and the same screen
  reading and touches as on a device, layout included, computed with Yoga.
- **Give up**: anything native. Camera, biometrics, deep OS integrations are
  mocks. A WebView renders as an empty box. Native crashes are jest errors.

Long runs leak: node's heap grows a few dozen MB per full app reset, so a
runner that drives hundreds of cases should restart the host when
`lynkeus call memory` reports too much.

## Controls: what the OS would hand the app

Under the host, what a device would receive from the outside world is a
command instead. These are headless-only unless noted; on a device you get
the real thing.

```sh
npx lynkeus os deeplink 'myapp://pay/abc'     # Linking listeners (react-navigation included) receive it; works on a device too
npx lynkeus os appstate background            # then `active`: what refetches or re-locks on foreground
npx lynkeus os clock --now 2027-01-01T00:00:00Z   # what Date answers; timers stay real (--advance <ms>, --reset)
npx lynkeus os biometrics --available FaceID --next success   # the sensor and the next prompts (success, fail, cancel; --fallback)
npx lynkeus os scan 'https://pay.example/abc' --type qr       # the open camera's code scanner receives a value
npx lynkeus os gallery ./fixtures/id.jpg --name id.jpg --mime image/jpeg   # what the next image picker answers (--cancel)
```

The network is a rule table in front of `fetch`:

```sh
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # answer before the backend
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # a bare path matches any method; only once
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # survives an app reset
npx lynkeus mock --list
npx lynkeus mock --clear
```

Error states, timeouts and empty states are one line each, with no backend
fixture. A rule without `--sticky` is dropped by the app's `reset` command.

The biometric sensor is a mock a driver sets, so a case can walk both the
success and the fallback paths:
`lynkeus os biometrics --available FaceID --next success` (or `cancel`,
`fail`).

## What headless cannot tell you

The host runs the app's JavaScript against a real backend, with the native
layer mocked. That leaves out, on purpose: the real camera and the decoder
(`lynkeus os scan` hands the open scanner a value), complex native gestures (a
swipe is driven through the gesture handler, not a finger), push delivery
(the simulator can be pushed from outside with `lynkeus os push`), what a
WebView renders (the seam is testable: what the app sends it and what it
does with the messages back), native crashes, and pixels (`lynkeus snapshot
--pixels` needs a simulator; the tree baseline works under the host). For
those, the same cases run on a simulator; only the way the host starts
differs.

## Security posture

- `headless start` refuses to run without `LYNKEUS_TOKEN`. The token is the
  shared secret between the hosted app and its driver, the same value the
  app reads for its `token` prop.
- With `network: 'real'`, the host refuses any host outside `networkHosts`,
  which defaults to loopback. An automated harness pointed at production is
  exactly the accident this prevents.
- The `apiEnv` guard in the generated entry checks that the API base the app
  reads points at a local backend before the app is rendered.

## Troubleshooting

**An env var change has no effect.** If your babel inlines environment
variables, jest's transform cache freezes the first value it saw. Remove the
cache directory your jest config points at.

**The app never leaves the splash.** Usually a native module that lynkeus does
not know: run `lynkeus headless doctor`, then mock it in your entry (`--fix`
writes stubs). Node resolving `localhost` to IPv6 while your backend listens
on IPv4 is the other half of that bug; use `127.0.0.1`.

**The host crashed with a jest error you do not recognise.** Paste its first
line to `lynkeus headless doctor --explain "<line>"`; it maps the usual errors
to their cause and fix.

**A screen never settles.** A ticking screen (a countdown, a spinner that
re-renders) never goes idle, and `lynkeus idle` says so with `idle: false`.
That is information, not a bug in the host.

**Two hosts fight over the port.** Set `LYNKEUS_PORT` on both the host and the
driver; each pair is independent.
