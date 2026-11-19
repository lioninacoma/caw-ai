English · [Deutsch](commands.de.md)

# Commands

Run every command from your project root: `npx caw <command>` (or `pnpm exec`, `yarn`). `<env>` is a name from `environments` in `caw.config.json`, e.g. `local`. Tenants are environments of their own (`extends`).

`--env` may be left out when the choice is clear: a test that fits exactly one environment takes it; otherwise, on your machine, the only environment among its candidates where Claude may work (for `record` of a new test, the only environment where Claude may work). In CI caw never guesses. The terminal names the choice, e.g. `Environment: local (the only one with claude)`. If it is ambiguous, the command stops and lists the choices (exit 3).

| Command | What it does | Claude? |
|---|---|---|
| [`init`](#init) | Set up a project: look at the app, write config and `.mcp.json`; with `--explore-only` only suggest settings | no |
| [`doctor`](#doctor) | Check machine, config, credentials and environments | no |
| [`overlay`](extensions/overlay.md) | Extension: local code on a deployed environment (only with an `overlay` block) | no |
| [`validate`](#validate) | Check config and tests offline | no |
| [`list`](#list) | List tests and steps with their recording status | no |
| [`record`](#record) | Record a test or replace its recording, also from a step on | yes |
| [`run`](#run) | Replay a test, or several for CI | only if you ask |
| [`open`](#open) | Open the app with workbench and chat; with a test at its end or at the entry of a step | only if you ask |
| [`reproduce`](#reproduce) | Claude reproduces a bug report on its own: report and draft test plan | yes |
| [`role`](#role) | List, add or remove roles and their test users; `role login` stores a session (SSO) | no |
| [`export`](#export) | The recorded test as a Playwright test that runs without caw | no |
| [`mcp`](#mcp) | MCP server for your own Claude Code session (started by Claude Code, not in `--help`) | – |

`npx caw help` prints the same overview in the terminal. `npx caw <command> --help` (or `-h`, anywhere on the line) prints only that command, `npx caw agent --help` the agent commands. `npx caw --version` prints the version.

When a command stops, the terminal shows the reason first, then for an invalid call the command's short form, then the code and exit code:

```
✕ create-ticket@s2: a step goes after the test as <test>@S<n>, e.g. order@S3.
  Usage: caw record <test> [--env <env>] [--role <role>]  or  caw record <test>@<S4> [--env <env>]
  (code: usage, exit 3)
```

An option that needs a value never takes the next option as its value: `--env --headless` stops with `--env needs a value, e.g. --env local`.

## init

```bash
npx caw init --url http://localhost:5173
```

Asks in the terminal whether the app needs a sign-in, then opens it in Chrome. Sign in with a test account (caw notices when the sign-in form is gone), go to the page where tests should start and click **Done** in the "caw explore" card at the bottom right of the window. The card shows the step as a badge ("2 · Start page") and, on the start step, the page it will use ("PAGE /todos"); its header collapses it. caw-ai detects framework, login form and a "signed in" marker and creates:

- `caw.config.json`
- `caw/.env.example` with the credential variables per role
- a `caw` entry in `.mcp.json` (to the installed copy if caw is in `node_modules` of the project or a parent folder up to the repository root, otherwise `npx caw-ai@<this version> mcp`; an `npx` entry is switched to the installed copy once there is one)
- `caw/tests/` for your test plans and `caw/caw.md` for notes Claude reads in every run
- `.gitignore` entries for `caw/.env`, `.caw/` and `caw/.auth/`

Anything it couldn't detect is set to `TODO`. `doctor` lists it, `validate` fails with exit 3 until it is filled in. Existing files are left alone.

| Option | |
|---|---|
| `--url <address>` | The app's address. Without it, `init` asks. |
| `--env <name>` | Name of the environment. Default: `local` on this machine, else the first part of the host name (`staging.example.com` → `staging`); a name that looks like production becomes `production: true`. |
| `--language <code>` | Team language for plans and Claude's texts. Default: the app's own language, asked. |
| `--login`, `--no-login` | Answer the sign-in question up front (scripts). |
| `--yes` | Don't wait for you to sign in, ask no questions. Good for apps without sign-in. With a sign-in nobody signs in: `signedInSelector` stays `TODO` and `start` stays `/` (or the path of `--url`). |
| `--from <file>` | Use an existing `--explore-only` result instead of opening the app. If `caw/.explore.json` exists, `init` uses it automatically. |
| `--no-mcp` | Don't touch `.mcp.json`. |
| `--offline` | Don't open the app: write the template with `TODO` for the sign-in. Without a terminal and without `--url`, `init` does this by itself. |
| `--insecure-tls` | Accept self-signed certificates; stored on the environment. |
| `--allow-http` | Allow plain `http` to another machine; stored on the environment. |

### Only look: `--explore-only`

```bash
npx caw init --explore-only --url http://localhost:5173
```

Looks at the app like `init`, but only writes suggestions to `caw/.explore.json`: framework, login type and selectors, signed-in marker, start page, messages and console noise. Each suggestion has `confidence: certain` or `likely`. Pass the file to `init --from` later.

With it: `--yes`, `--insecure-tls` (as for `init`); `--login` or `--no-login` answer the sign-in question for scripts.

If the sign-in leads to an identity provider on another host (such as Keycloak), you sign in there as usual. explore reads its pages and suggests `signIn` `steps` that fill the user name and password (identifier-first and a one-time code included) and the provider's host in `allowHosts`; `path` is the app page the sign-in started from. If its pages have no fields caw can fill, it suggests a stored session (`type: session`, [role login](#role)).

You type the sign-in yourself; caw only reads the page's structure (fields, selectors), never what you type. `init` then asks for the role names in the terminal and lists their variables in `caw/.env.example`: copy it to `caw/.env` and fill in the test users (see [role](#role)).

## doctor

```bash
npx caw doctor
npx caw doctor --agent docker
npx caw doctor --env staging
```

Checks Node, Chrome, Claude Code (agent `local`) or Docker and token (agent `docker`), the config, `TODO` values, credentials per role and whether each environment answers. Every failed check comes with the next step. For an invalid config it shows the first finding; `validate` lists them all. Placeholder addresses (`example.com`, `.test`, `.invalid`) are reported, never contacted.

With the [overlay extension](extensions/overlay.md) and ExtJS parts, doctor adds optional lines about the local code server and the last `overlay check`.

## validate

```bash
npx caw validate
```

Checks `caw.config.json` and every file in `caw/tests/` without browser or Claude. Errors name file and line, all of them at once. Use it in CI and pre-commit hooks.

`signIn` values still `TODO` fail validation (exit 3, code `config-invalid`): each one says what belongs there.

Per test and environment it prints which code runs there, e.g. `smoke (staging): deployed` or `smoke (local): dev server localhost:5173, your current version`.

## list

```bash
npx caw list
npx caw list create-ticket
```

Without a test: one row per test with its targets, its recording status (`recorded`, `stale (S2, S3)`, `not recorded`) and whether it writes data. With a test: one line per step, e.g. `S2  Create a ticket  (stale)`. No browser, no Claude.

Without `caw.config.json` it stops like every other command (`config-missing`). A test name that doesn't exist names the known tests and, for a typo, the closest one (`Did you mean create-ticket?`); `record <name>` is offered only for a new test. An unknown step names the test's steps (`Steps: S1–S6.`).

## record

```bash
npx caw record create-ticket --env local
```

Records a test plan from `caw/tests/create-ticket.yaml`, or creates a new test if the file doesn't exist. Chrome opens with the workbench and a chat:

1. You demonstrate the flow or, for a new test, describe it in the chat; for an existing test Claude can also follow the test plan.
2. Claude shows a plan in the chat. You approve it or ask for changes.
3. Claude walks the flow and checks each step.
4. caw replays the recording without Claude.
5. You choose "Adopt test plan". Only then are files written.

Runs only on environments where Claude may work (`"claude": true`). `--env` can be left out if there is only one.

| Option | |
|---|---|
| `--role <role>` | First recording only. Not needed if the config has one role. |
| `--read-only` | First recording only: the test doesn't write data (`writes: false`); if it does write while recording, it becomes `writes: true`. |
| `--overlay` | Only with the [overlay extension](extensions/overlay.md): local code over the deployed environment |
| `--start` | Start the environment with its `start` command if it doesn't answer, and stop it at the end ([lifecycle](configuration.md#starting-stopping-and-resetting-an-environment)). With `--overlay` also the parts' local code servers. Without it caw starts nothing and names the command. |
| `--reset` | Run the environment's `reset` before recording. |
| `--agent local\|docker\|session` | Where Claude runs. Default: `agent.mode` from the config, else `local`. |
| `--claude-timeout <duration>` | Time limit for Claude, default `60m`. |
| `--max-actions <n>` | Limit on Claude's browser actions, default `maxActions` or 100. |
| `--step-timeout <duration>` | Time limit per step in the check run, default `30s`. |

### From a step on

```bash
npx caw record create-ticket@S3 --env local
```

Re-records the test from S3 to the end. Use it when the app changed on purpose from there on, after you changed a step's text by hand, or to add steps at the end. S1 and S2 replay without Claude, then Claude follows the old plan from S3 while you steer in the chat; there is no demonstration. From S3 on the plan may change: Claude can add, remove, rename or reorder steps. The steps before S3 and their recordings stay exactly as they are; steps no longer in the plan are deleted when you adopt. Baselines and network effects from S3 on are learned again on the next healthy run. `@S1` records the whole test, like `record create-ticket`.

There is no check run first: if a step fails because of a bug in the app, find the cause with `run` instead. To repair just the one step that failed, use "Fix step" in the chat of a run. `--role` and `--read-only` don't apply here (exit 3): the test keeps its metadata.

## run

```bash
npx caw run create-ticket --env local
```

Replays the recording. No Claude, no tokens. On environments where Claude may work (`claude`) the chat sits next to the app: if a step fails you can ask Claude for the cause or have the step fixed right there.

A run changes no file on its own. With `--learn` it learns missing baselines and effects into `caw/recordings/<test>.yaml`, in every mode, CI included; with the chat, a passed run that could learn offers "Save baselines" on its end card instead, and only that click writes. The first line says which environment, which team language and whether the run learns, e.g. `Mode on local (team language en): with chat; learns: no.` At the end a run that learned says what changed, e.g. `Changed: caw/recordings/create-ticket.yaml (baselines S2, S5)`, or `Test file unchanged.` After a failure it prints the reason of the failed step (also with `--headless` and in CI) and the next commands: a run with chat to find the cause and `open <test>@<step>` up to the entry of the failed step. The report path is also printed as a `file://` link. In `report.md`, steps after the failed one are `skipped`, and screenshots link to the run's `agent/` folder.

| Option | |
|---|---|
| `--overlay` | Only with the [overlay extension](extensions/overlay.md): local code over the deployed environment |
| `--start` | As for `record`. |
| `--reset`, `--no-reset` | The environment's `reset` runs once before the first writing test; `--reset` before the first test, `--no-reset` never. |
| `--explain` | On errors or warnings Claude explains the cause without being asked. Costs tokens. |
| `--no-chat` | Visible window, no chat, no Claude. Like CI. |
| `--headless` | No window, no chat. The recorded viewport (else 1920×1080). |
| `--learn` | Learn missing baselines and effects from passed steps into `caw/recordings/`. Without it a run leaves every file as it is. |
| `--step-timeout <duration>` | Time limit per step, default `30s`. |
| `--claude-timeout <duration>` | Time limit for Claude when it investigates or fixes, default `60m`. |
| `--max-actions <n>` | Limit on Claude's actions when fixing. |
| `--agent local\|docker\|session` | As for `record`. |

With `CI` set, `run` has no chat and never starts Claude, like `--no-chat`. `record` and `open` need a person and are rejected in CI (exit 3), since nobody would take over the browser. On runners without a display add `--headless` or use `xvfb-run`.

### Several tests (CI)

```bash
npx caw run --all --env dev --headless --report junit=caw-junit.xml
npx caw run create-ticket close-ticket --env dev
```

Runs the tests one after another, without chat (`--explain` is rejected). `--all` takes every test that lists the target. Without `--env` the only target of the tests is used. A test that can't run (missing recording, typo) doesn't stop the others. At the end a table shows `PASS`, `FAIL`, `ERROR`, `NEEDS RECORDING` or `REJECTED` per test. The exit code is that of the worst run, in this order: `2` error > `1` fail > `4` needs recording > `3` rejected > `0` pass.

`--report junit=<file>` also writes the table as JUnit XML (relative to the project folder and inside it; a path outside, also through a link, is refused before any test runs): `fail` as `<failure>`, everything else that didn't pass as `<error>`.

## open

```bash
npx caw open --env dev
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local
```

Opens the app with workbench and chat: navigate, try things, develop with Claude. Learns nothing and writes no test file.

- **Without a test** it opens the app's start page. If the environment has a form sign-in, you watch it in the app first, as the step "Sign in" under Preparation, then caw goes to the start page. Without `--env` it takes the only environment where Claude may work.
- **`open <test>`** replays the whole test first, then the window is yours.
- **`open <test>@S3`** stops at the entry of S3: S1 and S2 replay completely, of S3 only its navigation (`goto`, clicks, waiting for the page). Its inputs and its check stay open for you; the terminal says `Ready for S3 …: navigation done, inputs open`. If S3 has no inputs at all (e.g. only a submit click), none of S3 runs; if one of its clicks wrote data in earlier runs, it stops before that click; if S3 isn't recorded or is stale, none of it runs. The terminal names the reason.

With a test, `open` signs in with the test's role and replays without Claude; the step it stops at isn't judged. It runs the code of the environment.

| Option | |
|---|---|
| `--role <role>` | Without a test only; not needed if the config has only one. A test brings its own. |
| `--start`, `--reset` | As for `run` (`reset` only with `--reset`). |
| `--step-timeout <duration>` | Time limit per step while replaying, default `30s`. |
| `--agent local\|docker\|session`, `--claude-timeout <duration>`, `--max-actions <n>` | As for `record`. |

After the handover, **F1** (or ⋯ → Open…, `/open` in the chat) in the workbench opens "Open…": any test for this environment, and optionally a step. Without a step the test runs to its last step; with a step it lands at that step's entry, like `open <test>@<step>`. caw starts a new session (cookies and site storage cleared), signs in with the account of the test's role and plays it in the same window, without Claude. With Basic auth only tests of your own role.

If restoring fails on something that does not always show up (a cookie banner already dismissed), ask in the chat: Claude can mark the click optional. What you accept goes into the test file right away. While recording, use `click <target> --optional`.

## reproduce

```bash
npx caw reproduce "After saving, the list still shows the old title." --env local
npx caw reproduce --file bug.md --from create-ticket@S3 --env local --headless
some-command-that-prints-the-ticket | npx caw reproduce - --env local
```

Claude reproduces a bug on its own, signed in as a test role: no plan to approve, nobody to answer, no decision. It reads and
operates the page like a person would and ends with a verdict: reproduced, not reproduced, or unclear. The run folder then holds
`report.md` (verdict, the bug report, what Claude observed and expected, its steps, the browser actions, screenshots, hard errors,
blocked or notable requests, a hint at the cause) and `draft-test.yaml`, a test plan in caw's format made from Claude's steps.
Nothing goes into `caw/tests`: to keep the bug as a regression test, copy the draft there, review it and `caw record <id>`.

- **Where:** only on environments with `claude`, never on production (`reproduce-not-allowed`). Without `--env` the only such
  environment, or the test's with `--from`.
- **Writing:** only where the environment is `writable`. Elsewhere caw aborts every write request like on production, and
  Claude knows it may only read.
- **Never:** code changes, advice, changes to tests or the config. The browser reaches only the project's hosts (as whenever Claude
  is attached).
- **The role:** the test's with `--from`, otherwise `--role` or the only one. A missing test user stops with `credentials-missing`.

| Option | |
|---|---|
| `"<bug report>"`, `--file <file>`, `-` | The bug report: as the argument, from a file, or from stdin. Exactly one, at most 8000 characters. |
| `--from <test>[@<S4>]` | Start in a test's state: its steps (up to the entry of S4) replay without Claude first. |
| `--role <role>` | Without `--from`; not needed if the config has only one. |
| `--headless` | No window. With a window the workbench shows what Claude does; you can only watch or end it (Esc). |
| `--agent local\|docker\|session` | As for `record`. From your own Claude Code session (`caw_start` with `command: "reproduce"`) at no extra tokens. |

Exit codes: `0` reproduced, `1` not reproduced or unclear, `2` environment error (also when the starting state of `--from` was
not reached: `reproduce-state`), `3` invalid input.

## role

```bash
npx caw role                          # roles, whether a test user is set (never the values), tests per role
npx caw role list --json              # the same as one JSON line
npx caw role add clerk               # the role into the config, its variable names into caw/.env.example
npx caw role remove clerk             # only if no test uses it; caw/.env stays as it is
npx caw role login clerk --env dev    # signIn.type session: sign in by hand, store the session
```

A role is a test user. caw never asks for, reads from a page, writes or shows user names and passwords: you put them into `caw/.env` yourself (or set them as CI secrets), under `CAW_<ROLE>_USER` and `CAW_<ROLE>_PASSWORD` (`CAW_<ROLE>_TOTP` for one-time codes, `__<ENV>` for another account on one environment, see [configuration](configuration.md#roles)). `role add` writes the role (`{}`) to `caw.config.json`, the variable names without values to `caw/.env.example` and `caw/.env` to `.gitignore`, and names the variables to fill in. `role remove` takes the role out of the config and names the role's lines left in `caw/.env`; deleting them is up to you.

When `record`, `run` or `open` needs a role without a test user, it stops before Chrome or Claude start with `credentials-missing`, naming the variables. For `signIn.type: session` use `role login`: you sign in by hand and caw stores the session, never a password.

`role login` is for `signIn.type: session` (SSO, OAuth, MFA you can't automate). It opens Chrome on the sign-in and you sign in by hand. As soon as `signedInSelector` shows up, caw stores cookies and storage in `caw/.auth/<env>/<role>.json`. Run it again when the session expires.

## export

```bash
npx caw export order --env ci
npx playwright test -c caw/export/playwright
```

Writes the recorded test as a Playwright test that runs without caw, only with `@playwright/test`, into `caw/export/playwright/` (`--out <dir>` for another folder):

| File | |
|---|---|
| `<test>.spec.mjs` | One `test()`, one `test.step()` per caw step. The locators are the recorded ones; checks become `expect.poll`, a dialog decision is answered around the action that opens it, `remember` and `{{runTag}}`/date placeholders are filled per run |
| `caw-support.mjs` | Sign-in from `signIn` (form, steps, Basic, saved session, TOTP), waiting for a quiet page like caw, uploads, downloads, `<select>` filling; for ExtJS the `extjs=` engine. Overwritten by every export |
| `playwright.config.mjs` | Base URL, locale, time zone and viewport of the recording, Chrome, `trace: 'off'`. Written only if missing; then it is yours. The trace is off because the sign-in fills the test user's password and one-time code, and a Playwright trace keeps them in plain text (caw scrubs its own traces, Playwright doesn't). Switch it on only where that is acceptable, and never upload such a trace |

The environment (`--env`, otherwise the only fitting one) gives the address and the sign-in. At run time `CAW_BASE_URL` overrides the address; test users come from the same variables as for caw (`CAW_<ROLE>_USER`, `CAW_<ROLE>_PASSWORD`, `CAW_<ROLE>_TOTP`, optionally with `__<ENV>`). A file in the folder that export did not write is never overwritten.

Not exported: learned effects and network baselines, `knownMessages`, the console and request failure rules, `retry`, `readyIgnore`, and the 2 s tolerance for a second match while a dialog closes. The test must be recorded completely and current, otherwise exit 4 with the `record` command to run.

## mcp

Started by Claude Code through `.mcp.json` (`claude mcp add caw --scope project -- npx caw-ai mcp`). You don't call it yourself. The server is named `caw`; on start it tells Claude what caw is for and to read `caw_guide` first. It gives your session these tools:

| Tool | | Tokens |
|---|---|---|
| `caw_guide` | The guidance per topic (`topic`); without one the index. `overlay` and `extjs` only when the project uses them | no |
| `caw_doctor` | `doctor` as data (`agent`, `env`) | no |
| `caw_init` | `mode: explore` (`url`, `login` or `yes`): the window, waits and returns the suggestions (`wait: false` only starts it); `mode: write` (`fromExplore`) and `mode: offline` write the files; `env`, `language`, `insecureTls`, `allowHttp`, `roles`, `noMcp` | no |
| `caw_role` | Roles as data (`list`), a new one in the config with its variable names (`add`, `name`; the human fills `caw/.env`), a saved session (`login`), `remove`; never user names or passwords | no |
| `caw_config` | Read the config, or change it validated (`patch`, `dryRun`). A patch that adds or removes the `overlay` block changes the tool list. Refused: commands (`start`, `stop`, `reset`, `ready`, `lintCommand`, overlay `start`), environment flags, `browser.executablePath`, `sandboxImage`, `sandboxUser`, `agent.mode`; the session edits those in the file, where you see the diff | no |
| `caw_validate` | `validate` as data | no |
| `caw_list` | `list` as data | no |
| `caw_overlay` | Only with an `overlay` block: `action: status` (`overlay status` in-process, fast), `check` or `apply` (`overlay check`, `--apply`; waits up to 3 minutes); `env`, `part` | no |
| `caw_start` | Start `run`, `record`, `open` or `reproduce` with `--agent session` (`reproduce`: `bug`, `from`, `role`, `env`, `headless`; `test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset`, or `args`; `step` for `record` and `open`, only with `test`). With `overlay` it checks the local code server first: `down`, `wrong-app` or `stale` returns `state`, `url`, `start` and `partDir` instead of starting; `moved` starts with `--overlay <foundUrl>`. Never `--start` together with `overlay`: the session starts the local code server itself after asking you. `start` and `reset` run the environment's configured commands | none beyond your session |
| `caw_status` | Is a run waiting for the session? Last lines of output; last run's result and artefacts as data. `wait` (up to 120 s) returns as soon as the run needs the session, ends or reports something new | no |
| `caw` | The agent commands (`snapshot`, `click`, `plan`, `finish`, …) | in the run |
| `caw_selection` | The element you picked with `/element` in the workbench chat | no |

Results come as short text plus `structuredContent` (JSON).

## Agent commands

`caw agent <command>` with `snapshot`, `click`, `dblclick`, `hover`, `drag`, `dialog`, `fill`, `type`, `press`, `upload`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

These are the only way Claude can touch the browser. They exist for the agent during `record` and in the chat; you won't need them. `npx caw agent --help` lists their arguments.

## Exit codes

| Code | |
|---|---|
| `0` | pass |
| `1` | fail: the app didn't do what the test expects |
| `2` | error: the environment prevented a verdict (server down, login failed, Chrome missing, …), or an unexpected internal error (the stack is printed) |
| `3` | rejected: invalid call, config (also `TODO` values left from `init`) or test file. Nothing ran. |
| `4` | needs recording: the recording is missing (`record`) or a step changed since it was recorded (`record <test>@<step>`). Nothing ran. |

## Environment variables

| Variable | |
|---|---|
| `CAW_LANG` | `en` or `de`: your own language for caw's texts (CLI, workbench), instead of the team language (`language` in the config). Claude keeps writing plans in the team language. |
| `CAW_AI_HOME` | Folder for personal settings (`prefs.json`). Default `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` or `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API key from the Claude Console for the `docker` agent. `local` and `session` use your Claude Code login. |
| `CAW_CLAUDE_MODEL`, `CAW_CLAUDE_BUDGET` | Model and budget in US dollars for Claude runs (`--model`, `--max-budget-usd`); override `agent.model` and `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Windows only: `windows` or `wsl` to pick the Docker route. |
| `CI` | Set: no chat, `docker` agent only; `record` and `open` are rejected. |
| `NO_COLOR`, `FORCE_COLOR` | Terminal colors off or on. |
| `MCP_TOOL_TIMEOUT` | In Claude Code's environment: raise it if `plan` or `chat` time out in your session. |

## Error codes

When caw stops, or a run ends with `error`, it prints the reason and then the code.

| Code | Exit | Fix |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw <command> --help` |
| `reproduce-not-allowed` | 3 | `reproduce` only on an environment with `claude`, never production |
| `reproduce-state` | 2 | The starting state of `--from` was not reached: `run` the test and fix it first |
| `config-missing` | 3 | `npx caw init --url <address>` |
| `config-invalid` | 3 | Fix the field named in the message or fill in the `TODO` values, then `doctor` |
| `test-missing`, `test-invalid` | 3 | Create or fix the test file, then `validate` |
| `replay-missing` | 4 | `record` the test |
| `replay-stale` | 4 | A step changed since recording: `record <test>@<step>` |
| `step-unknown` | 3 | Use a step ID from the test file (`list <test>`) |
| `env-invalid`, `env-denied` | 3 | Use an environment from the config; production can't be recorded |
| `host-blocked` | 3 | `goto` to a host that is no app host: add it to `allowHosts` if the app really navigates there. In a run the same block is a failure of the step |
| `env-certificate` | 2 | The environment's certificate is not trusted: for an internal certificate authority set `environments.<env>.insecureTls: true` |
| `write-protected` | 3 | Recording and writing tests need `claude` / `writable` on the environment |
| `auth-missing` | 3 | No stored session, or it expired: `caw role login <role> --env <env>` (the message names it) |
| `credentials-missing` | 2 | Set the variables the message names in `caw/.env` or the environment (CI secrets); a new role first with `role add <role>` |
| `login-form-missing`, `login-failed` | 2 | Is the backend up? Are the `signIn` selectors or steps and the credentials right? |
| `env-unreachable` | 2 | Start the environment (or pass `--start` when it has a `start` command), check the URL |
| `env-start-failed` | 2 | The environment's `start` ended with an error: see the log tail and `.caw/env/<env>-start.log` |
| `env-not-ready` | 2 | `ready` did not answer below 500 in time: raise `ready.timeoutMs` or check the `start` command |
| `env-reset-failed` | 2 | The environment's `reset` failed or took longer than 10 minutes; no test ran. See `.caw/env/<env>-reset.log` |
| `app-not-loaded`, `app-not-settled` | 2 | Open the page by hand, check the console |
| `browser-missing` | 2 | Install Google Chrome, or set `browser` in the config |
| `claude-missing` | 2 | Install Claude Code and sign in, or use `--agent docker` |
| `token-missing` | 2 | Set `ANTHROPIC_API_KEY`, or use `--agent local` |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Start Docker with Linux containers, or use `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Check registry login and `sandboxImage` |
| `sandbox-path` | 2 | A project path with a comma, quote or line break (or a colon in a folder the sandbox hides) cannot be mounted safely: rename it or use `--agent local` |
| `aborted` | 2 | You closed the window or pressed Ctrl+C |
| `chat-failed`, `no-session` | 2 | Start again |
| `chat-tampered` | 2 | The page under test reloaded the chat frame or removed its sandbox; the run ended so that no decision could come from there. Find the application script that touches `top.document` |
