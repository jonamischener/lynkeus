# Contributing

lynkeus is published for anyone to use under the [MIT license](LICENSE), but the repository does not take contributions. Issues are disabled and pull requests are closed automatically. If you need a change, fork the repository.

## Development

The repository is a Yarn workspaces monorepo:

- `packages/protocol`, `packages/client`, `packages/agent`, `packages/headless` and `packages/cli`: the published packages.
- `example/`: a React Native app that mounts the agent from source.

Use the Node version in [`.nvmrc`](.nvmrc), then:

```sh
yarn               # install every workspace
yarn lint          # Biome
yarn typecheck     # builds the packages, then type-checks each one
yarn test          # builds the packages, then runs each one's tests
yarn build         # builds every package
```

The example app picks up JavaScript changes through Metro. Native changes in `packages/agent/ios` or `packages/agent/android` need a rebuild: `yarn example ios` or `yarn example android`.

`docs/COMMANDS.md` is generated from the CLI: run `yarn workspace lynkeus docs` after changing a command.
