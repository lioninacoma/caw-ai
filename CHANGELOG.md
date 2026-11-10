# Changelog

All notable changes to caw-ai. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `--overlay [build|dev|<url>]` on `run`, `record`, `fix` and `open`: local code over a deployed environment, only where the environment has `"overlay": true`. The app names its sources in `apps.<app>.overlay`: a build folder (`build`), a dev server (`dev`), fixed files (`statics`); with ExtJS the Sencha watch. Without a value the one configured source; a URL is a dev server at that address. Without `--overlay` every run tests the deployed version; a dev server on your machine is an environment of its own.
- With `--overlay` caw gets the source ready before Chrome starts, like Playwright's `webServer`: it starts the dev server with `devCommand` (with ExtJS the Sencha watch), builds once with `buildCommand` when the build is missing or older than the sources, prints each action and stops what it started at the end. Otherwise exit 2 with the reason and the command. The source never switches.
- Page swap: each HTML page of the app gets the code tags of the local page (build folder or dev server) at the position of the old ones, with the page's CSP nonce and without `integrity`. Inline scripts, project copies such as `public/env.js` and foreign origins stay from the server. Build requests match the exact file or the same name up to the hash (one hash rule for all bundlers); code requests and the HMR WebSocket go to the dev server.
- Checks after the first load with `--overlay`: a server-rendered page (Next.js, Nuxt, SvelteKit, Angular SSR) or a run where nothing came from local code ends with exit 2; scripts from the local asset folder served by the server and a build with a different base path are warnings. `report.md` has an `Overlay:` line with source, local and server files and whether the page was swapped.
- ExtJS: the build names of app and packages come from `app.json`, `.sencha/app/*.properties` and `bootstrap.json`; framework packages are never replaced; an ambiguous name ends with exit 2 and names both parts.
- `caw-ai open`: open the app signed in, with workbench and chat, without a test. Learns nothing and writes no test file.
- Targets in iframes of the application: recording adds `frame` (the iframe, described in the document above it, nested if needed), replay finds the element there, and a missing iframe is named in the step's error.
- Every run names its code in a `Code:` line, also in CI: `Code: deployed`, `Code: dev server localhost:5173, your current version` or `Code: overlay, build dist, built 14:02, 3 min ago`.
- `validate` prints per test and target which code runs there and where `--overlay` would apply, and notes settings without effect (an app with `overlay` while no environment allows it) and `auth` values still `TODO`.
- "Did you mean …?" for unknown fields in `caw.config.json` and test files (`insecureTLS`, `target`, `expected`), for test names, steps and commands; unknown roles and apps list the valid names.
- `caw-ai list`: tests with targets, recording status (recorded, stale with steps, not recorded) and whether they write; `list <test>` per step.
- `run a b c` and `run --all` for CI: tests one after another without chat, a table at the end, exit code of the worst run; `--report junit=<file>` writes JUnit XML.
- `--target` can be left out when there is only one choice (the test's only target, or the only environment where Claude may work); the choice is printed.
- Help per command (`caw-ai run --help`, `-h` anywhere, `caw-ai help agent` for the agent commands). Usage errors show the command's short form.
- `run --no-learn`: chat without learning baselines. A run with chat ends with what it changed in which file, or "Test file unchanged".
- After a failed run the terminal shows the exact next commands (run with chat on an environment with Claude, `--until` the step before).
- `init --offline` (also used without a terminal and without `--url`) writes the template with `TODO` sign-in selectors; `init` creates `caw/tests/` and `caw/caw.md`.
- Workbench: "Your turn" in the header and a note in the terminal whenever the chat waits for you; "● Recording" while you demonstrate, with "Finish demo"; "Add checkpoint" explains itself.
- Workbench: the adopt decision is a card ("Check run passed", one line per fact, warnings folded); "Discard draft" asks once more. After the decision the chat says what was saved and the window stays open for 15 s with "Close window".
- Workbench: before a new window opens (Claude, check run), chat and terminal say so. Keyboard shortcuts are shown on the buttons they trigger.

### Changed
- `examples/helpdesk` ships the recording of `create-ticket`: start the server and `run` it right away, no recording with Claude first.
- Exit code 4 ("needs recording") for a missing or outdated recording (`replay-missing`, `replay-stale`).
- Test files: `id`, `app`, `role` and `targets` may be left out: file name, the only app, the only role, all non-production environments.
- Error output: the message first, then the short form for usage errors, then `(code: …, exit …)`; an unknown command gets a suggestion instead of the full help.
- Wording: every regular end of a run is "End run", "Cancel" only aborts.
- Workbench raven: flights to and from the chat leave the screen at the nearest edge and come back in instead of crossing the middle; from the logo to the steps and back, and between steps, it hops to the next step or flies straight to the target, flapping its wings. On the logo it sits still. It glances back once instead of looking around, no longer waves when it arrives or comes home, and idle moves come every 5–12 s.
- Workbench: the first Esc only asks before cancelling (a second Esc confirms); Esc while typing clears the field. Choices in the failure and decision cards are compact and the card scrolls into view. The steps panel unfolds on failure on narrow screens. The workbench's refresh button is disabled while a test runs.

### Fixed
- Open shadow roots also count for an enclosing `<label>`, the sign-in marker, messages and dialogs as web components, and `wait-ready` counts.
- React apps that hydrate the whole document (Next.js App Router, React Router framework mode, Remix) count as loaded; before, every run ended with `app-not-loaded`.
- Sign-in on server-rendered pages (Nuxt, Next.js, Angular SSR) waits until the framework has taken over the form; before, the values were lost on hydration or Enter submitted the form natively.
- Source maps load on Windows for environments under `*.localhost` and for `localhost` dev servers listening on 127.0.0.1 only.
- With `--overlay`, a local script is mapped with the source map next to the local file, not the deployed one.
- Index source maps with `sections` (Turbopack, `next dev`) and `file:///` sources are understood.
- Errors that a framework catches and logs with a stack (Angular's `ErrorHandler`, Vue in production, React error boundaries) point to the source file and count as clear application errors, like uncaught ones. Failed requests logged that way (`HttpErrorResponse`, `AxiosError`) stay network evidence.
- Deployed pages with Subresource Integrity (`integrity` on scripts and styles, e.g. Angular's `subresourceIntegrity`) accept local code; the attributes are removed from the deployed HTML only with `--overlay`.
- Angular with SSR counts as loaded only after hydration, not as soon as the server HTML carries `ng-version`.
- Sign-in through a foreign login page (Keycloak, Entra ID) no longer waits for the app's framework there.
- An environment on `http://127.0.0.1:<port>` was blocked by the browser's network rules.
- The app navigating the top window itself (`top.location`, a form with `target=_top`) no longer aborts the run as if a person had reloaded the page; reloading twice in quick succession restores the workbench fully.
- Actions demonstrated in a popup of the app are recorded; before, popups were taken for the workbench.
- Restoring the state or restarting with a popup open loads the start page in the app, not in the popup, and closes the popup.
- A sign-in check during a client-side redirect keeps waiting instead of failing with "execution context was destroyed".
- A `remember` with `secret: true` in a step that is retried kept `••••` instead of the value.
- An effect-only failure (the check passes, the app reacts differently than in healthy runs) is recognized after retries and when the check reports itself, so the diagnosis says "likely" and offers to forget the learned effect.
- Re-recording an existing test keeps its `knownMessages` patterns, `secret: true` markers and check time limits.
- `caw/.env` is read like dotenv: a comment after the value (`KEY=value # note`), quotes and surrounding spaces are no longer part of the value.
- `validate` checks each entry of `overlay.statics` and the fields of a role (unknown keys, variable names); before, a bad entry crashed the run.
- A test name is a file name in `caw/tests` (letters of any language such as `kündigung`, digits, `_`, `-`, `.`; no folders, no trailing dot); `record team/login` failed only after the whole recording.
- In CI (`CI` set) `record`, `fix`, `run --until` and `run --handover` are rejected with exit 3 instead of waiting for a person until the runner times out.
- A missing session file (`auth-missing`) or `TODO` selectors end `run` with exit 3 as documented, not 2. An unexpected internal error ends with exit 2 (environment), not 1 (test failed), and stops Claude.
- `.devcontainer` `image` is checked like `sandboxImage` before it goes into the Dockerfile.
- With `localhost` allowed, `127.0.0.1` is reachable too and vice versa: a dev server opened under one name often opens its HMR socket under the other (webpack-dev-server with `host: 127.0.0.1`).
- `--overlay` with Subresource Integrity also works in popups and new tabs of the app, not only in the first tab.
- A build folder with many lazy chunks (Angular names each `chunk-<hash>.js`) no longer slows every request under `--overlay`: which files the local build reaches is computed once per build, not per request.
- A chain of top-level navigations by the app no longer counts as a reload by the person when the navigation type can't be read; only reload and back/forward do.

### Security
- The chat is identified by the frame the workbench created, not by its name: the app (same origin as the workbench) or Claude via `eval` could otherwise replace it with its own `caw-chat` iframe and approve plans or pick options as the person. Loading another page into the real chat iframe (`srcdoc`, `location`) doesn't work either: every chat page carries a one-time key the app can't read.
- Without a container, Claude Code no longer loads user or project settings (`--setting-sources ""`), whose `allow` rules or `additionalDirectories` would otherwise let it read outside the project; only connection settings (`env`, `apiKeyHelper`, `model`, AWS helpers) are carried over. `id_dsa*` joins the denied files.
- Evidence files of a demonstration (`fehler.json`, `netzwerk.json`, screenshots) are created fresh and never through a link the container placed in its folder.
- Code advice can't reach `.git`, `caw/`, `node_modules` or `.claude` through `./` segments, other letter case, trailing dots or spaces, short names or a link.
- Secret values reach Claude neither in the repair task (the check keeps the placeholder `{{name}}`, filled in by the host when Claude runs the check, which then reports only pass or fail; `eval`, `remember` and `goto` never get the value) nor in the diagnosis and evidence written to `result.json` and `report.md`.
- A password typed by the person into a field that isn't a password field (show-password toggles) is recorded as a secret input without its value.
- Source maps are fetched without following redirects, so an open redirect on an allowed host can't send a request from your machine elsewhere.

### Tests
- `e2e/frameworks`: test projects for React (Vite and webpack 5), Vue (Vite), Angular 21 (zoneless and Zone.js), Next.js 16 and Nuxt 4, each against the dev server, as a production build over HTTPS and, where possible, with `--overlay`, with and without a ready build (exit 2 instead of a silent run on the deployed version). React also covers an iframe and a web component.

### Docs
- `CONTRIBUTING.md` and templates for issues and pull requests.

### Internal
- `npm run mascot` (`assets/mascot/`): builds a pixel crow sprite sheet from a rigged Blender model via Pixor (work in progress, not used yet; `--install` would replace the raven). Not part of the package. The workbench raven now plays clips from a table (`src/host/raven-clips.mjs`).

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

[Unreleased]: https://github.com/lioninacoma/caw-ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lioninacoma/caw-ai/releases/tag/v0.1.0
