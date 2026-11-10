# Changelog

All notable changes to caw-ai. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `localBuild` per app: local code from a build folder with normal hashed file names (Vite, Angular CLI, webpack). The deployed entry files are mapped to the local ones by name without hash; lazy chunks, CSS, source maps, fonts and images follow. No fixed file names, no list of files, no `assetUrlPattern` needed.
- Targets in iframes of the application: recording adds `frame` (the iframe, described in the document above it, nested if needed), replay finds the element there, and a missing iframe is named in the step's error.

### Fixed
- Open shadow roots also count for an enclosing `<label>`, the sign-in marker, messages and dialogs as web components, and `wait-ready` counts.
- Local code of apps under `also`: `statics` were never served, only `redirects`.
- Local code with only `statics` (Vite, Angular CLI, webpack builds) no longer crashes looking for a Sencha `bootstrap.json`.
- A missing `statics` file (no build, watch not started) stops the run with `watch-missing` and names the file, instead of "the application is not loaded".
- React apps that hydrate the whole document (Next.js App Router, React Router framework mode, Remix) count as loaded; before, every run ended with `app-not-loaded`.
- Sign-in on server-rendered pages (Nuxt, Next.js, Angular SSR) waits until the framework has taken over the form; before, the values were lost on hydration or Enter submitted the form natively.
- Source maps load on Windows for environments under `*.localhost` and for `localhost` dev servers listening on 127.0.0.1 only.
- With local code, a script from `statics` is mapped with the source map next to the local file, not the deployed one.
- Index source maps with `sections` (Turbopack, `next dev`) and `file:///` sources are understood.
- Errors that a framework catches and logs with a stack (Angular's `ErrorHandler`, Vue in production, React error boundaries) point to the source file and count as clear application errors, like uncaught ones. Failed requests logged that way (`HttpErrorResponse`, `AxiosError`) stay network evidence.
- Deployed pages with Subresource Integrity (`integrity` on scripts and styles, e.g. Angular's `subresourceIntegrity`) accept local code; the attributes are removed from the deployed HTML only while local code is served.
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
- `validate` checks each entry of `statics`, `constants` and `redirects` and the fields of a role (unknown keys, variable names); before, a bad entry crashed the run.
- A test name is a file name in `caw/tests` (letters of any language such as `kündigung`, digits, `_`, `-`, `.`; no folders, no trailing dot); `record team/login` failed only after the whole recording.
- In CI (`CI` set) `record`, `fix`, `run --until` and `run --handover` are rejected with exit 3 instead of waiting for a person until the runner times out.
- A missing session file (`auth-missing`) or `TODO` selectors end `run` with exit 3 as documented, not 2. An unexpected internal error ends with exit 2 (environment), not 1 (test failed), and stops Claude.
- `.devcontainer` `image` is checked like `sandboxImage` before it goes into the Dockerfile.
- With `localhost` allowed, `127.0.0.1` is reachable too and vice versa: a dev server opened under one name often opens its HMR socket under the other (webpack-dev-server with `host: 127.0.0.1`).
- Local code with Subresource Integrity also works in popups and new tabs of the app, not only in the first tab.
- `localBuild` with many lazy chunks (Angular names each `chunk-<hash>.js`) no longer slows every request: which files the local build reaches is computed once per build, not per request.
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
- `e2e/frameworks`: test projects for React (Vite and webpack 5), Vue (Vite), Angular 21 (zoneless and Zone.js), Next.js 16 and Nuxt 4, each against the dev server, as a production build over HTTPS and with local code (`localBuild` with hashed builds, `statics` with fixed names), with and without a running build watch. React also covers an iframe and a web component.

### Docs
- `CONTRIBUTING.md` and templates for issues and pull requests.

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
- `run --until <step>` / `--handover`: get the app into a state and keep the window for development, with your local code where allowed.
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
