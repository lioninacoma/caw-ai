# Changelog

All notable changes to caw-ai. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
