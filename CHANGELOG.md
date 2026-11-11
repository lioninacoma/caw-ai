# Changelog

All notable changes to caw-ai. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-11-11

0.2.0 was never published; its changes are part of 0.3.0.

### Breaking

Upgrading from 0.1.0: see [docs/upgrading.md](docs/upgrading.md).

- Node 22.4 or later (was 22).
- Environment key `agent` → `claude` (`"claude": true`: Claude may record, fix and investigate here). `agent` is now an unknown field, not an alias.
- Environment key `localCode` → `overlay`. It only allows local code; a run uses it only with `--overlay` on `run`, `record`, `fix` or `open`. Without the option every run, also `run --until`, tests the deployed version.
- App keys `statics`, `redirects` and `constants` → `apps.<app>.overlay` with `url`, `start`, `build` and `statics`. `redirects` and `constants` are gone: with `"framework": "extjs"` the Sencha watch's web server is the source, and caw-ai reads the build names of app and packages from `app.json`, `.sencha/app/*.properties` and the watch's `bootstrap.json`. Group 1 of `assetUrlPattern` now names an `overlay.statics` entry, a path inside `overlay.build` or an ExtJS build name.
- Exit codes: a missing or stale recording (`replay-missing`, `replay-stale`) exits with `4` (was `3`); an unexpected internal error with `2` (was `1`); a missing session file (`auth-missing`) or `TODO` sign-in selectors on `run` with `3` (was `2`). With `CI` set, `record`, `fix`, `open`, `run --until` and `run --handover` exit with `3` instead of waiting for a person.
- Test files: `recording` and `knownMessages` in `caw/tests/<test>.yaml` are an error. 0.1.0 still read such single files and split them on write; they belong in `caw/recordings/<test>.yaml`.
- Run artefacts have English names: `claude-gespraech.log` → `claude-talk.log`, `claude-empfehlung.log` → `claude-advice.log`, `test-entwurf.yaml` → `test-draft.yaml`, `report-testlauf.md` → `report-test-run.md`, `vorfuehrung.json` → `demonstration.json`, `punkt-N.png` → `point-N.png`, `fehler.json` → `failures.json`, `netzwerk.json` → `network.json`, `fehler-schritt-N.png` → `failure-step-N.png`, `anleitung.md` → `instructions.md`, `.caw/auswahl.json` → `.caw/selection.json`, `caw-werkbank.js` → `caw-workbench.js`; demonstration run folders end in `-demonstration` (was `-vorfuehrung`).
- Workbench: the light theme and the `fed` setting in `prefs.json` are gone; `"theme": "light"` or `"dark"` there falls back to `nacht`. The Silkscreen font is replaced by VT323.
- The Claude Code skill changed: run `caw-ai skill` once to update `.claude/skills/caw-ai/SKILL.md`.
- `--agent docker` needs an API key from the Claude Console (`ANTHROPIC_API_KEY`, passed to Docker by name only); `CLAUDE_CODE_OAUTH_TOKEN` is no longer passed into containers. `local` and `session` use your own Claude Code login as before.


### Added
- `--overlay [build|dev|<url>]` on `run`, `record`, `fix` and `open`: your local code over a deployed environment that has `"overlay": true`. One model for every framework: the project's local code server at `apps.<app>.overlay.url` (dev server, Sencha watch), started with the project's own command `overlay.start`; or a build folder (`overlay.build`). caw-ai swaps the app's code tags in each served page and bridges the HMR WebSocket. It starts nothing by itself: a server that doesn't answer ends the run with exit 2 (`overlay-not-ready`) naming `start`; `--start` runs it and stops it at the end (CI). Server-rendered pages and runs where nothing came from local code end with exit 2. See [Testing local code](docs/configuration.md#testing-local-code).
- ExtJS overlay over the Sencha watch's web server (`overlay.url`, default `http://localhost:1841/`, `init` writes it): `bootstrap.json` and the sources come over HTTP; caw checks that the server is the watch of this app (`app.json` name, load order), so another project's watch is never used (`wrong-app`); a watch on a random port is found among the running watch processes and used (`moved`). A source the watch doesn't serve ends with `overlay-stale`.
- `caw-ai overlay status [--target] [--app] [--json]`: is the local code server ready (`ready`, `moved`, `down`, `wrong-app`, `stale`), without a browser and without starting anything.
- Every run prints which code it tests (`Code: deployed`, `Code: overlay, build dist, built 14:02, 3 min ago`); `validate` prints it per test and target and notes settings without effect and `auth` values still `TODO`.
- `caw-ai open`: the app signed in, with workbench and chat, without a test.
- `caw-ai list`: tests with targets, recording status and whether they write; `list <test>` per step.
- `run a b c` and `run --all`: several tests in a row without chat, a result table, the exit code of the worst run; `--report junit=<file>` writes JUnit XML.
- `run --no-learn`: chat without learning baselines. A run with chat ends with what it changed in which file.
- `--target` may be left out when there is only one choice. Help per command (`caw-ai run --help`, `-h`, `caw-ai help agent`). "Did you mean …?" for unknown config and test fields, test names, steps and commands.
- **F1 Choose state** after a handover (`open`, `run --until`): replay any test of the environment, of any role, up to a chosen step in a fresh session, without Claude.
- While developing, Claude can use the page on request (click, fill, type, press, go to, reload), reproduce a pasted bug ticket and propose the fix as a code change you accept with a click. It asks before anything that saves or deletes data.
- Optional clicks for things that don't always appear, such as a cookie banner: `click <target> --optional` while recording, or Claude marks a recorded click optional. Replay waits 3 s and otherwise skips it.
- Targets inside iframes (`frame` in the recording) and in open shadow roots.
- A failed check run whose only hard failures are script errors offers **Ignore errors and check again** (adds them to `consoleIgnore`). Claude can propose `consoleIgnore` entries while recording.
- `explore` and `init` ask whether the app has a sign-in (`--login` / `--no-login`), notice the sign-in themselves and end with a **Done** button in the window instead of Enter in the terminal. `init --offline` writes the template with `TODO` sign-in selectors.
- A failed sign-in is reported after seconds instead of at the timeout; with chat Claude proposes a corrected `auth` block, applied only after you agree.
- Themes as packages (`themes/<name>/theme.json`): built-in `nacht` (default), `bernstein` and `phosphor`, plus three with their own layouts, not just colours: `kachel` (tmux-style tiles, tab and status bar), `plakat` (light, signal yellow, steps as tiles, one big number) and `cockpit` (round gauge, warning lamps for steps), which bring a `theme.css` and, for `plakat` and `cockpit`, their own fonts; own themes next to `prefs.json`; a team default as `theme` in `caw.config.json`. `caw-ai theme`, `theme use <name>`, `theme check <name>`; F7 in the workbench edits colours, glyphs, raven and CRT look.
- Workbench: a chip shows recording, replay or pause while something runs; "Your turn" when the chat waits for you; the adopt decision as a card; a key bar at the bottom (F1 Choose state, F5 Reload, F9 Pause, Esc Cancel, F2 Requests, F3 Console, F4 Steps, F6 Chat, F7 Theme, F8 App only, F10 Animations off).
- [Upgrading from 0.1.0](docs/upgrading.md).
- Cost limits for Claude: `agent.model` and `agent.maxBudgetUsd` (or `CAW_CLAUDE_MODEL`, `CAW_CLAUDE_BUDGET` for one run), passed to Claude Code as `--model` and `--max-budget-usd`. README section "Claude access and costs": which account for which use, and that caw-ai never handles logins.
- ExtJS overlay with Sencha Cmd 7: packages whose `bootstrap.json` entry has no file list are found by their namespace path, and the app part includes `app.js` (`Ext.application`) and the other scripts from `app.json` `js`.
- `fill` on a select list picks the option with that value or label, while recording and on replay (before, Claude had to fall back to typing the first letters, which depends on the option order).
- Test files: a step text with an unquoted ` #` followed by text (`expect: Toast "Added #12" shows`) is an error with its line number, because YAML would cut it off as a comment.
- `readyIgnore` setting for areas that change by themselves (ticker, clock, permanent spinner); `browser.locale` and `browser.timezone` pin the test browser's language and time zone.
- The run log line "Claude finished after …" shows turns, tokens and the cost Claude Code reports.
- Upgrade guide [docs/upgrading.md](docs/upgrading.md); `validate` and `doctor` say where each config key from 0.1.0 went.
- Release workflow: a `v*` tag runs lint, tests and the pack check and publishes through npm trusted publishing with provenance, without a token.
- `caw-ai overlay check [--target] [--app] [--apply] [--start] [--json]`: opens the app headless with the overlay and shows per expected part (app, packages, theme) whether it came from local code, from the server or was not loaded; suggests an `assetUrlPattern` per missing source and adds it with `--apply`. Writes `.caw/overlay-check.json` (with `url` and `start`). Starts the local code server only with `--start`; otherwise names `start` when the server isn't ready.
- `assetUrlPattern` takes a list of patterns for pages that load code from several sources (a path and a proxy parameter); `apps.<app>.overlay.assetUrlPattern` per app.
- `doctor` shows `bootstrap.json`, the local code server (serves the app, doesn't answer with its `start` command, or runs on another port) and the last overlay check per part for ExtJS overlay environments; `init` adds ExtJS overlay hints.
- MCP: the Claude Code session can run every setup and check step: `caw_doctor`, `caw_init`, `caw_explore`, `caw_config`, `caw_validate`, `caw_list` and `caw_overlay` (`status`, `check`, `apply`), none of them uses tokens. Tool results carry `structuredContent` next to a short text.
- Test users as roles, entered only in the window: after signing in during `explore` the card asks for the role and saves user name and password to `caw/.env` (and `.gitignore`); "+ Another role" takes the next account. `init` takes the roles from there. The values never reach Claude, the terminal or `caw/.explore.json`.
- `caw-ai role [list|add|remove]` and the MCP tool `caw_role`: manage roles in an existing project; `add` opens the sign-in window.
- When `record`, `run` or `open` needs a role without a test user (also a new role in a test plan), the sign-in window opens first and the run goes on after saving. In CI and with `--headless` it still ends with `credentials-missing`.
- MCP: `caw_explore` and `caw_role add` wait until the human is done in the window (up to 20 minutes) and return the result directly: suggestions with the saved roles, or the roles that got a test user. `wait: false` only starts them.
- A read-only test plan the Claude Code session wrote and follows unchanged needs no plan approval; adopting the proven test still does. Writing or changed plans keep the approval card.
- The skill sets up a project from one prompt: Claude decides environment flags, adopts certain findings, derives `overlay.url` and `overlay.start` from the project (`vite.config`, `angular.json`, `package.json` scripts, README; Sencha 1841), applies and re-checks overlay patterns itself, and lists its decisions at the end instead of asking. It asks for a target URL only when the project names none and uses the overlay only when you ask for your local code; before such a run it checks `caw_overlay` status and, if the server is down, asks you and starts `start` in its own session.
- MCP: when the Claude Code session is the agent, `record` follows an existing test plan without the "who demonstrates" question, and caw shows no token notice. The session can write a new test plan itself and record it.
- MCP: `caw_start` takes typed fields (`test`, `target`, `step`, `until`, `overlay`, `headless`) and `open`, checks the config first and, with an overlay, the local code server: `down`, `wrong-app` or `stale` returns `state`, `url`, `start` and `appDir` instead of starting; on another port (`moved`) it starts against the found URL. It never passes `--start`. `caw_status` also returns the last run's result, last step and artefacts, explore suggestions and the latest overlay check.


### Changed
- caw stands for **Context-Aware Workflows**: workbench header, terminal banner, help, package description and README. Show it. Understand it. Replay it.
- README: the first sentence says what caw-ai does differently.
- Workbench chat: no header of its own, the frame says CHAT. Cancel with Esc (or Esc Cancel in the key bar), confirmed in a row in the chat. The reload key is called "Reload".
- An ExtJS overlay run where expected parts still came from the server ends with exit 2 (`overlay-incomplete`), naming the parts, server URLs and a suggested `assetUrlPattern`. Before, only a run where nothing came from local code failed.
- IBM Plex Mono now ships as IBM's own unmodified files (`builtin:ibm-plex-mono-400.woff2`, `-500.woff2`); the old `builtin:ibm-plex-mono-latin-*-normal.woff2` names still work.
- New look ("console") for workbench, chat, report, the `explore` card and the terminal: VT323 for headings, IBM Plex Mono for text. Without a terminal the plain `[caw-ai]` lines stay.
- Test files: `id`, `app`, `role` and `targets` may be left out (file name, the only app, the only role, all non-production environments). A test name is a file name in `caw/tests`, without folders.
- Error output: message first, then the command's short form for usage errors, then `(code: …, exit …)`.
- Replay skips a repeated click whose target is now covered by a dialog the first click opened, instead of failing after 30 s; the report names it.
- After a handover the workbench starts in **App only**; F8 brings it back. The first Esc asks before cancelling, a second confirms.
- Every regular end of a run is "End run"; "Cancel" only aborts.
- More of the UI follows the language setting: failure explanations, app names, theme messages, the default `caw/caw.md` header. Messages and prompts for Claude are English.
- `examples/helpdesk` is replaced by `examples/errand`, a small todo app with sign-in and the recorded test `first-errand` you can replay right away.
- Replays use the language and time zone of the recording (or `browser.locale`/`browser.timezone`), so dates and texts match on CI runners.
- New recordings fail on an ambiguous target (listing up to three candidates) instead of clicking the first match; older recordings keep the first match and warn once.
- Ids in page paths become placeholders like other remembered values; run tags are unique to the millisecond.
- `validate` exits 3 while `auth` values are still `TODO` and reports every problem of a test file at once; `doctor` shows the first real config error and never probes placeholder hosts; `init` writes no placeholder `staging` environment and keeps `startUrl` off the sign-in page.
- Without a window (`--headless`, CI) the terminal shows why the step failed; error verdicts always show their code; `report.md` links screenshots and marks steps never reached as skipped.
- The Claude Code skill (`templates/skill.md`) is in English; run `caw-ai skill` to update it.
- The raven logo is an easter egg again and no longer flies: no hand cursor, no frame on hover, not in the tab order. Its hearts are smaller; with "Animations off" none rise and those in flight disappear instead of freezing.


### Fixed
- The `.mcp.json` entry from `init` and `skill` points to caw-ai where it is installed, also in a parent folder (monorepo with hoisted `node_modules`).
- Actions of Claude and of replay no longer take focus from the chat; looking for a target no longer scrolls the app.
- **Fix step** after a recording keeps what you and Claude agreed on (e.g. an allowed console error).
- React apps that hydrate the whole document (Next.js App Router, React Router framework mode, Remix) count as loaded instead of ending with `app-not-loaded`; Angular SSR counts as loaded only after hydration.
- Sign-in on server-rendered pages (Nuxt, Next.js, Angular SSR) waits until the framework has taken over the form; a foreign login page (Keycloak, Entra ID) no longer waits for the app's framework; a sign-in check during a client-side redirect keeps waiting.
- Source maps: loaded on Windows for `*.localhost` and for dev servers listening on 127.0.0.1 only; index maps with `sections` (Turbopack) and `file:///` sources are understood; with `--overlay` the local map is used.
- Errors caught and logged by a framework (Angular `ErrorHandler`, Vue, React error boundaries) point to the source file and count as application errors.
- Pages with Subresource Integrity accept local code under `--overlay`, also in popups and new tabs.
- An environment on `http://127.0.0.1:<port>` was blocked by the browser's network rules; with `localhost` allowed, `127.0.0.1` is reachable too and vice versa.
- The app navigating the top window itself (`top.location`, `target=_top`) no longer aborts the run as a reload by the person.
- Actions in a popup of the app are recorded; restoring a state with a popup open loads the start page in the app.
- A `remember` with `secret: true` in a retried step kept `••••` instead of the value.
- Re-recording a test keeps its `knownMessages` patterns, `secret: true` markers and check time limits.
- `caw/.env` is read like dotenv: comments after the value, quotes and surrounding spaces are no longer part of the value.
- `validate` checks each `overlay.statics` entry and the fields of a role instead of crashing on a bad entry.
- `.devcontainer` `image` is checked like `sandboxImage` before it goes into the Dockerfile.
- Pages that never get quiet no longer cost the full step timeout silently: hidden or off-screen spinners don't count, and the report says when a page never settled.
- Remembered values with quotes (e.g. O'Brien) no longer break check code.
- Cancelling a CI job (SIGTERM, SIGHUP) cleans up Chrome and the dev server like Ctrl+C.
- The report names the tested code the same way as the terminal (e.g. "dev server …").
- Chrome no longer offers to translate the app under test.


### Security
- The chat is identified by the frame the workbench created, and every chat page carries a one-time key: the app, or Claude via `eval`, can no longer replace the chat to approve plans or pick options as the person.
- Without a container, Claude Code loads no user or project settings (`--setting-sources ""`), so their `allow` rules or `additionalDirectories` can't widen its reach; only connection settings are carried over. `id_dsa*` joins the denied files.
- Secret values reach Claude neither in the repair task (the host fills `{{name}}` placeholders when Claude runs a check) nor in the diagnosis and evidence in `result.json` and `report.md`. A password typed into a field that isn't a password field (show-password toggles) is recorded as a secret input without its value.
- Code advice can't reach `.git`, `caw/`, `node_modules` or `.claude` through `./` segments, letter case, trailing dots or spaces, short names or links.
- Evidence files of a demonstration are created fresh, never through a link placed in the folder.
- Source maps are fetched without following redirects.
- The Docker sandbox installs Claude Code pinned to major version 2 instead of the newest release.
- A second sign-in during a run (restoring a state) no longer ends up in the trace; earlier parts are kept as `trace-1.zip`, …
- Proposed code edits cannot target secret, tool, CI or dependency files (`.env*`, `.npmrc`, keys, `.aws`, `.ssh`, `caw.config.json`, `.mcp.json`, `package.json`, lock files, `.github`, …); they are reported as nonexistent, and a run accepts no more edits after 5 rejected submissions.
- Secret remembered values are only filled into fill and type values; `check`, `eval` and `remember` code containing one is refused.
- `eval` needs an approved plan while recording, like other commands that can act on the page.
- The tested page can no longer change the token notice or restore another test's state on its own: an F1 pick asks for confirmation in the chat (a mitigation; app and workbench still share an origin).
- The Docker sandbox and the local agent also hide `.aws`, `.ssh`, `.docker/config.json`, `*.env`, `.envrc`, `.pypirc`, `.yarnrc*`, `credentials.json` and key stores.

## [0.1.0] - 2026-11-09

First public release.

### Added
- Recording action `upload`: sets files from the `caw` folder on a file field, directly or through the file chooser a button opens.
- Recording action `download`: the click must start a download whose name matches a pattern and whose file isn't empty.
- `remember` with `secret: true`: the value is masked in terminal, workbench, `result.json`, `report.md` and for Claude.
- Patterns `{pattern: "..."}` for target names (also under `inside`) and in `knownMessages`.
- The browser grants `clipboard-read` and `clipboard-write` for the environment's origin, so a check can read the clipboard.
- Sign-in with a one-time code: a code refused as already used is retried once with the code of the next 30 s window.

### Changed
- Messages are matched against `knownMessages` in full; only the report shortens long ones. A recorded entry that was cut at 300 characters needs the full text or a pattern.
- `validate` rejects a fixed target name over 80 characters and says why: the tool reads such names as empty.
- Reports (`result.json`, `report.md`) mask the role's password like everything Claude gets.
- The raven stays on the chat between questions that follow shortly after each other, instead of flying back and forth; a running step calls it back at once.
- The raven shows its idle animations more often.

### Docs
- Reference for commands, configuration and test files in `docs/`, English and German.
- Example project `examples/helpdesk`: a small helpdesk app with login, dialog and detail page, plus a test plan to record.

### Test plans and recordings
- Test plans as YAML in `caw/tests/`: steps `S<n>` with title, action and exactly one expected result.
- Recording per step in `caw/recordings/` (actions, check, baselines, effects), written by the tool only.
- Three ways to record: you demonstrate, Claude follows the plan, or reuse the last demonstration. Every recording ends with a plan you approve.
- Replay without Claude: deterministic, with retries for flaky pages, effect baselines learned from healthy runs, and a clear split between test, app and environment failures.

### Workbench and chat
- One window: steps on the left, your app in the middle (under its own address, so `top.X` keeps working), the chat with Claude on the right.
- Step list shows every automatic action as its own point and follows the current point.
- Pixel theme in light and dark, an animated raven that marks the current action, and an option to turn animations off.
- Chat: pause before you click, approve plans with one button, cancel with an inline confirmation (Esc cancels directly).
- After a run: result, "Open report" (report.md as a page) and the command for the next run.

### Fixing and developing
- When a step fails: ask Claude in the chat (read-only), let it fix the step, or get recommendations with code edits you accept or reject.
- `run --until <step>` / `--handover`: get the app into a state and keep the window for development.
- MCP server (`caw-ai mcp`) for your Claude Code session: start runs, act as the agent, read the element you picked with the crosshair.

### Setup and operation
- `explore`, `init`, `validate`, `doctor` and `auth` for setting up a project; Claude Code can set it up with you via the skill.
- Agents: `local` (default, Claude Code with narrow tools), `docker` (isolated sandbox with firewall) or `session` (your Claude Code session).
- CI mode: `--no-chat`, `--headless`, `run --timeout` and `--max-steps`.
- `http://localhost` and `127.0.0.1` are allowed as targets.
- User interface, CLI, error messages and reports in English and German (`language` in `caw.config.json`, `CAW_LANG`, or the system language).
- Sign-in: login form, second factor via `auth.codeSelector` and `totpEnv` per role, SSO via `storageState` and `caw-ai auth`; apps without a login need no `auth`.

[Unreleased]: https://github.com/lioninacoma/caw-ai/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lioninacoma/caw-ai/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/lioninacoma/caw-ai/releases/tag/v0.1.0
