# Driving lynkeus from a model

What to put in an agent's system prompt so it tests an app without spending
its context on it. Every number below was measured on a production React
Native app.

## Tools

`lynkeus mcp` serves nine tools: `screen`, `press`, `type`, `wait`, `why`,
`call`, `os_deeplink`, `map_show` and `map_plan` — about 750 tokens of tool
definitions on every turn. `lynkeus mcp --full` serves all 42 commands for
about 4,200. Start with the core; add `--full` for an agent whose job is
crawling, recording or snapshots.

## Reading a screen

```
Settings.Main (Tabs > Settings.Main) +overlay#account-sheet · 12 hidden: 12 behind-overlay
4 button #close-sheet "Close"
5 button #delete-account-button "Delete account" !disabled
6 text "Are you sure?"
7 button #slide-to-confirm ~inert
```

- The header is the route, the navigator path and the layer on top, if any.
  What the platform is not presenting (another tab, the screen under a sheet)
  is left out and counted: it cannot be touched, so a model has no use for it.
- One element per line: index, kind, `#testId`, label, then state:
  `!disabled`, `~covered` (something is drawn over it), `~inert` (readable,
  not touchable).
- No coordinates. Point at controls by `#testId`; add `--frames` only when a
  control has neither a testID nor text.
- An icon inside a button is part of the button and is not listed.
- An average screen reads in about 250 tokens; with a sheet open, what the
  sheet covers is not in the listing at all. `screen --json` is several times
  larger and carries nothing a model needs; it is for programs.

## Moving around

- `map_show <route>` before exploring: which buttons a screen has and where
  they lead, from the source, without opening it.
- `map_plan --from A --to B` for directions: the presses, screen by screen.
- `press '#like-button' --in 'hi from Ana'` when rows repeat a control;
  `--nth 2` for the third match.
- `wait '#row-25' --scroll` for something further down a list.
- `type 'ana' '#search' --submit` when the field acts on the return key.

## When something fails

Call `why` instead of reading the screen again. It says, in one answer,
whether the target is covered, hidden behind a layer, disabled, or not there
(and what near match is); whether the session is gone, the backend failed or
rate-limited, requests are still in flight, or none were made; whether the
navigator died or a render loop was broken; and the last command that failed.
Reading the screen again costs as much and says less.

## The cycle for a pull request

1. `lynkeus map check --base main` on the branch: the screens the diff reaches.
2. Crossed with which cases touch which routes, the cases to run.
3. Run them. For each failure, `why`.
4. Fix the case when the app changed on purpose, or the code when it did not.
5. The pull request carries the fix, the case and the screens the run
   recorded (`LYNKEUS_RECORD_SCREENS=1`), so the reviewer reads one diff
   instead of searching.
