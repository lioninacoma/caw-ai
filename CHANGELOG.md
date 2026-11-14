# Changelog

All notable changes to caw-ai. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

First release.

### Added
- Test plans as YAML in `caw/tests/` (steps `S<n>` with title, action and one expected result) and recordings per step in `caw/recordings/`, written by the tool only.
- `caw record`: you demonstrate, Claude follows the plan, or the Claude Code session records; every recording ends with a plan you approve and a check run. `record <test>@S4` re-records from a step to the end.
- Recordings store native Playwright locators, one per target (`getByRole('button', { name: 'Save', exact: true })`, frames via `contentFrame()`), parsed without running code; ExtJS components also via the `extjs=` selector engine (`Ext.ComponentQuery`). Replay needs exactly one visible, uncovered match, tolerates two for a dialog transition, scrolls virtual lists and explains a missing target (frame missing, covered by a dialog, renamed).
- Actions `click`, `dblclick`, `fill`, `type`, `press`, `upload`, `download`; a demonstrated double-click is recorded as one `dblclick`, a file chosen from `caw/fixtures` as an `upload` (files from elsewhere are named, never copied). A plan reworded during recording keeps the checks already passed; only a changed expected result or order takes them back, and going back to it restores them.
- `caw run`: deterministic replay without Claude, with retries for flaky pages, learned network and effect baselines, and a split between test, application and environment failures. Several tests in a row (`run a b c`, `run --all`), JUnit output, CI mode (`--no-chat`, `--headless`, `--timeout`, `--max-steps`).
- `caw open`: the app signed in with workbench and chat; `open <test>` replays the test and hands over the window, `open <test>@S4` stops at the entry of S4.
- Workbench: steps, the app under its own address and the chat in one window; key bar (F1 Open…, F5 Reload, F9 Pause, Esc Cancel, F2 Requests, F3 Console, F4 Steps, F6 Chat, F7 Theme, F8 App only, F10 Animations off).
- Fixing and developing in the chat: ask Claude, fix a step, get code advice to accept or reject; while developing Claude can use the page and propose code changes.
- `--overlay [build|dev|<url>]`: your local code over a deployed environment with `"overlay": true`, from the project's code server (`overlay.url`, started with `overlay.start`) or a build folder (`overlay.build`); ExtJS over the Sencha watch. `caw overlay status` and `overlay check`.
- Setup: `init` (`--explore-only` only looks at the app), `validate`, `doctor`, `role` (`role login` stores an SSO session), `list`, `skill`; the Claude Code skill and MCP server (`caw mcp`) let your session set up projects, start runs and act as the agent.
- Agents: `local` (Claude Code with narrow tools), `docker` (isolated sandbox with firewall) and `session` (your Claude Code session); cost limits via `agent.model` and `agent.maxBudgetUsd`.
- Sign-in: login form, one-time codes, SSO via saved sessions; test users per role in `caw/.env`, entered only in the window.
- Network and safety: one request name (`POST /graphql mutation CloseTicket`, `json.<key>` for JSON-RPC) and one rule for what writes, with `reads` for requests that only read; pages navigate only to the app's hosts and `allowHosts` (`host-blocked`), while scripts, fonts, analytics and iframes may load from anywhere and are listed as third-party hosts whose errors are warnings; production hosts are unreachable from other environments, and a run on production sends no write requests (`write-blocked`); error pages count as evidence.
- Themes as packages: built-in `nacht`, `bernstein`, `phosphor`, `kachel` and `cockpit`, own themes next to `prefs.json`, `caw theme`.
- The command is `caw` (package `caw-ai`, `npx caw …` once installed). Claude's browser commands live under `caw agent` and are not in the human help. Durations carry their unit (`--step-timeout 30s`, `--claude-timeout 60m`); `--env` picks the environment, `--explain` lets Claude explain failures unasked, `--max-actions` limits Claude. Old command and flag names are refused with their new name.
- User interface, CLI, messages and reports in English and German.

[Unreleased]: https://github.com/lioninacoma/caw-ai/commits/HEAD
