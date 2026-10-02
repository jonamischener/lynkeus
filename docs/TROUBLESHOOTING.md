# Troubleshooting

Headless-specific entries are in [HEADLESS.md](HEADLESS.md#troubleshooting).
After any failed `press`, `wait`, `type` or `nav`, lynkeus already prints why;
`lynkeus why <target>` asks again at any moment.

**A press does nothing.** Read the screen first: the element may be covered
(`~covered` in the listing), disabled (`!disabled`), or not presented at all:
the header counts those (`3 hidden: 3 behind-overlay`) and `lynkeus screen --all`
lists them — they are in the tree but belong to a screen the app is not
showing, so close what is open or target something inside it. `--js` presses through the React
handler instead of the OS, which is a useful comparison, not a fix.

**No keyboard on the simulator while typing.** `type` taps the field first,
so it is focused the way a person focuses it and the system keyboard comes up.
When it does not, the simulator is taking keys from the Mac instead: turn off
I/O → Keyboard → Connect Hardware Keyboard (or
`defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false`).

**A wait times out on a screen that is clearly there.** The route name comes
from the navigation adapter; check `lynkeus screen` for the real one. Without an
adapter there are no routes at all, only elements.

**A text target does not match.** `"text"` matches a control by exact label
first, then by substring; a paragraph matches only by exact text, so a word
inside running copy is never a target. `lynkeus why '"Continue"'` says whether
the text is a wording or an accent away.

**Everything is slow.** One process per step is the usual cause; use
`lynkeus session`. If a case waits seconds after login, it is your backend
answering, not the agent; `lynkeus requests` says so.

**Two runs fight over the port.** Set `LYNKEUS_PORT` on both the app (or the
host) and the driver; each pair is independent. `port` in `lynkeus.config.json`
sets the driver's default.

**The driver never attaches.** The app dials out to `localhost:8123` on iOS
and `10.0.2.2:8123` on the Android emulator, retrying every 1.5 s. Check that
the build is a debug build, that `enabled` is true for this environment, and
that the token the app was built with is the `LYNKEUS_TOKEN` the driver reads.
`--attach-timeout <ms>` (or `attachTimeout` in the config) gives it longer;
`--launch --app <bundleId>` relaunches the app first.

**An overlay the app raises eats the screen.** A lock screen, a "rate us"
sheet, a forced-update wall: lynkeus has no idea what yours looks like, on
purpose. Compose it from primitives in your own tooling (`lynkeus wait '#key-1'`,
`lynkeus press '#key-1'`, `lynkeus wait '#key-1' --gone`) and hand `smoke` and
`crawl` the same thing as `--overlay-when '#key-1' --overlay-flow
flows/keypad.json`.

**`map plan` has no directions.** The static graph only knows navigations it
can read from source. Run `lynkeus crawl` from the starting screen to add
observed edges, then ask again; `lynkeus map paths <Route>` shows what it
currently knows about the destination.

**`map changes` reports nothing.** It reads what `lynkeus screen --record` (or
`LYNKEUS_RECORD_SCREENS=1`) kept under `.lynkeus/screens/`; without recorded
screens there is nothing to compare.
