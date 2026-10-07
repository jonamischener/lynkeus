# Changelog

## 0.2.0 (unreleased)

- `lynkeus-agent` on Android: an element is where its view stands, not where the shadow tree puts it. In an app that draws under the status bar the two were a status bar apart, so a press landed above its target and every control read `~covered`. The native module answers `frames(tags)`; an app has to be rebuilt to get it, and until then the agent behaves as before.
- `lynkeus`: commands regrouped. Static knowledge is `lynkeus map build|screens|show|paths|plan|impact|check|changes` (was `graph`, `screens`, `screen-info`, `paths`, `plan`, `impact`, `check`). What the OS hands the app is `lynkeus os deeplink|appstate|clock|biometrics|scan|gallery|permissions|push|appearance|location|language` (was the bare names and `lynkeus device …`). The host is `lynkeus headless start|init|doctor` (was `headless`, `init`, `doctor`). `lynkeus mock` is unchanged. The old spellings still work as aliases.
- New commands: `see` (assert a route or element is on screen now), `hello` (what the app said about itself), `screen --tree` (the screen as nested lines of meaning, no geometry), `snapshot <name>` (a tree baseline by default; `--pixels` adds the screenshot), `flake` (the same flow n times), `why` (why the last step failed, from the screen, requests and trace), `record` (a flow from what a person does in the app), `lint --save` / `--baseline` (only the findings that are new).
- `lynkeus.config.json` in the app's folder holds what was repeated as flags: `entry`, `apiEnv`, `port`, `device`, `app`, `attachTimeout`, `lintBaseline`. Flags win over the environment, the environment over the file.
- Global flags: `--root`, `--device`, `--app`, `--launch`, `--attach-timeout`, `--json`, `--help`.
- The token env var is `LYNKEUS_TOKEN`. `lynkeus headless start` refuses to run without one.
- Headless respects what a device would refuse: a swipe on an element the platform is not presenting fails; a swipe across a scroller scrolls it (a pager turns its page), and frames follow the scroll. Percentage widths and heights are laid out.
- `screen` lists only what is presented and counts the rest in the header (`--all` lists it), prints coordinates only with `--frames` and read stats only with `--verbose`; states read `!disabled`, `~covered`, `~inert`. About half the tokens per screen; an icon inside a button is not listed. Recorded screens keep only what is presented.
- `lynkeus mcp` serves nine core tools (about 750 tokens a turn, against 4,200 for all of them); `--full` serves all of them.
- Targets can be scoped: `press '#like' --in 'hi from Ana'`, `--nth 2` (protocol: optional `within`). `wait <target> --scroll` swipes until it is in the window; a device press brings an offscreen target in first. `type … --submit` sends the return key.
- Every app answers `events` (what `qa.event` recorded) and `stores` (the state of what `qa.observe` exposed). `run --events` keeps each step's events; `events`, `events diff`, `funnel check` and `funnel report` read them against `.lynkeus/funnels/`.
- `map check` and `map impact` follow a named import through a barrel to the file that defines it: a changed hook reaches the screens that use it, not every screen that imports from the barrel.
- `case run` runs cases written as markdown: `app.*` steps drive the app, any other step is a fixture answered by a command the project declares (JSON lines), `assert` reads the backend, and `cases.macros` names steps of the project's own. `case init` writes an example, the reference and a fixtures server to start from.
- `map ci` writes a workflow that comments on each pull request which screens its diff reaches.
- A command outside a session attaches in about 100 ms (it was 120 ms to 1.8 s): the agent redials every 100 ms for 3 s after a drop, the driver listens before asking the OS for simulators, and the source extractor loads only for `map build`. The crawl returns to where it began instead of a fixed route. `debug` names the component that blocks a touch.
- Linted with Biome in CI; `lynkeus-client` and the protocol's shapes are tested; no product names in the sources, and a test keeps it so.
- Docs split: the README is a landing page; the manual lives in `docs/` (CONCEPTS, DRIVE, HEADLESS, KNOWLEDGE, TROUBLESHOOTING) next to the generated COMMANDS and PROTOCOL.

## 0.1.2

- Monorepo: `lynkeus-agent`, `lynkeus`, `lynkeus-client`, `lynkeus-protocol`.
- `lynkeus`: screen graph extraction, `plan`, `smoke`, `crawl`, flow runner with `--var`, MCP server.
- A covered element still matches when nothing reachable does.

## 0.1.0

First release.

- `Lynkeus` component and `qa.register` for app commands (`reset`, `busy`, anything else).
- Screen snapshot from the fiber tree with Fabric measurement and native hit-test visibility.
- Native touch and key synthesis (iOS, Android), long press via `holdMs`, swipes.
- `waitFor`, `idle`, `navigate`/`back` through a navigation adapter, deep links, request log.
- Protocol v1 with optional token handshake; `batch` for several calls per round trip.
- Node client package `lynkeus-client`.
