<h1 align="center">lynkeus</h1>

<p align="center">
  <strong>An in-app QA agent for React Native.</strong><br />
  Drive your app from inside the process: the screen as React sees it, real touches and exact waits, in milliseconds.
</p>

<p align="center">
  <a href="https://github.com/jonamischener/lynkeus/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jonamischener/lynkeus/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/lynkeus-agent"><img alt="npm" src="https://img.shields.io/npm/v/lynkeus-agent?label=lynkeus-agent" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="React Native 0.76+" src="https://img.shields.io/badge/react--native-0.76%2B-61dafb" />
  <img alt="New Architecture" src="https://img.shields.io/badge/new%20architecture-ready-success" />
</p>

---

End-to-end tools drive your app from the outside: they ask the operating system what is on screen, take a screenshot and guess. Every step costs a second or more, and the answer is a picture, not a fact.

lynkeus runs **inside** a development build of your app. It reads React's own tree, so what it reports is what React rendered: routes, testIDs, values, which element a touch would actually reach and which ones a sheet covers. Touches and keystrokes are synthesized in the process, and waits end on the render that satisfies them.

```
screen     2–9 ms      what is on screen: testIDs, labels, values, frames, and what is covered
press      ~60 ms      a real finger — gesture recognizers, Pressable and sheets all see it
type       25 ms/key   through the keyboard path, so masks and onChange behave
wait       exact       returns the moment a route or element appears (or disappears)
```

The same app can also run **with no simulator at all**: `lynkeus headless start` hosts it in Node under Jest and React Native Testing Library, speaking the same protocol.

## Highlights

- **Fast** — milliseconds per step instead of seconds, because nothing leaves the process to decide what to do next.
- **Facts, not pixels** — assert on routes, values and network requests that a screenshot cannot see.
- **Device or headless** — the same case runs on a simulator, a phone, or in Node with no simulator.
- **App-agnostic** — it knows nothing about your screens. Preparing backend state stays a separate tool that a script, a CI job or an AI agent composes with it.
- **Safe in release** — the native module compiles to no-ops outside debug builds, and the JavaScript is never evaluated when disabled.
- **Built for automation** — a CLI, a JSON-lines session, a Node client and an MCP server for AI agents.

## Requirements

- React Native 0.76 or newer with the New Architecture
- iOS and Android development builds
- Node 22 or newer for the CLI and the headless host

## Installation

```sh
yarn add -D lynkeus-agent lynkeus
cd ios && pod install
```

Rebuild the app once. From then on, Metro is enough.

## Quick start

**1. Mount the agent** in `index.js`, before `registerComponent`:

```ts
import { auto } from 'lynkeus-agent/auto';

auto({ token: process.env.LYNKEUS_TOKEN, enabled: __DEV__ });
```

**2. Drive the app** from a terminal:

```sh
npx lynkeus screen                          # what is on screen right now
npx lynkeus press '#next-button'            # by testID, "text", index or x,y
npx lynkeus type 'ana' '#search' --submit   # type, then the return key
npx lynkeus wait Settings.Main              # until a route or an element appears
```

**3. Run it without a simulator:**

```sh
npx lynkeus headless init --auto            # writes the headless entry and mounts the agent
LYNKEUS_TOKEN=secret npx lynkeus headless start
```

Running many commands in a row? Keep one connection open with `lynkeus session` (JSON lines, about 50 ms a step), or serve the commands to an AI agent with `lynkeus mcp`.

## Write a case

A case is a readable file of steps that runs the same on a device and on the headless host:

```yaml
---
id: settings-dark-mode
title: "Settings: switching to dark mode"
---
steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }
```

The runner waits out what only a device does — a pager's momentum, a screen still sliding in — and the few steps that only one side needs go under `on: device` or `on: headless`. See [Cases](docs/CASES.md).

## Packages

| Package | Description |
|---|---|
| [`lynkeus-agent`](packages/agent) | Mounted in the app: screen, touches, keys, waits and requests, plus `qa.register`, `qa.observe` and `qa.event` for commands of your own. |
| [`lynkeus`](packages/cli) | The CLI: drive the app, replay flows, smoke every route, crawl, build the screen graph, plan a path, name the screens a diff reaches, run cases, serve everything over MCP. |
| [`lynkeus-headless`](packages/headless) | Hosts the app in Node under Jest, with the same protocol and no simulator. Mocks the usual native modules. |
| [`lynkeus-client`](packages/client) | The Node driver the CLI is built on, for runners of your own. |
| [`lynkeus-protocol`](packages/protocol) | The wire contract, as TypeScript types. |

## Documentation

| Guide | |
|---|---|
| [Concepts](docs/CONCEPTS.md) | Agent, driver, host, targets, routes, screens, flows, the graph and configuration. |
| [Driving the app](docs/DRIVE.md) | Mounting the agent, commands, commands of your own, how the screen is read, why a step failed. |
| [Headless](docs/HEADLESS.md) | The app in Node: init, doctor, start, OS-side controls, mocks, and what headless cannot tell you. |
| [Knowledge](docs/KNOWLEDGE.md) | The screen graph, paths and plans, crawl, smoke, lint baselines, performance, snapshots and analytics funnels. |
| [Cases](docs/CASES.md) | The case format, backend fixtures, custom steps, and what a run leaves behind. |
| [AI agents](docs/LLM.md) | Driving it from a model: which tools, how to read a screen, the cycle for a pull request. |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | When a press does nothing, a wait times out, or everything is slow. |
| [Commands](docs/COMMANDS.md) | Every command and flag, generated from the CLI. |
| [Protocol](docs/PROTOCOL.md) | The JSON methods on the wire, for a driver of your own. |

## FAQ

**Does anything ship in my release build?**
No. The native module compiles to no-ops outside debug builds, and the agent's JavaScript is never evaluated when `enabled` is false.

**How does it compare to Detox, Maestro or Appium?**
It covers the same ground — driving a real build end to end — but from inside the app instead of through the operating system. That is what makes it fast, and why it needs a development build.

**Can an AI agent use it?**
Yes. `lynkeus mcp` serves the commands as MCP tools, and the [AI agents](docs/LLM.md) guide explains how a model should read screens and failures.

## Contributing

lynkeus is published for anyone to use, but the repository does not take contributions: issues are disabled and pull requests are closed automatically. You are welcome to fork it under the terms of the license.

## License

[MIT](LICENSE) © Jonathan Mischener
