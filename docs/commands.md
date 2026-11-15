English · [Deutsch](commands.de.md)

# Commands

Run every command from your project root: `npx caw <command>` (or `pnpm exec`, `yarn`). `<env>` is a name from `environments` in `caw.config.json`, e.g. `local`. With tenants (`sites`) it is `tenant/env`, e.g. `north/dev`.

`--env` may be left out when the choice is clear: `run`, `record` and `open <test>` then take the test's only target (for `record`, the only one of them where Claude may work; for `record` of a new test, the only environment where Claude may work). The terminal names the choice, e.g. `› Target: local (only target of create-ticket)`. If it is ambiguous, the command stops and lists the choices: `--env is missing: local, dev`.

| Command | What it does | Claude? |
|---|---|---|
| [`init`](#init) | Set up a project: look at the app, write config and `.mcp.json`; with `--explore-only` only suggest settings | no |
| [`doctor`](#doctor) | Check machine, config, credentials and environments | no |
| [`overlay status`](#overlay-status) | Is the local code server for `--overlay` ready? | no |
| [`overlay check`](#overlay-check) | Check that `--overlay` replaces everything it should | no |
| [`validate`](#validate) | Check config and tests offline | no |
| [`list`](#list) | List tests and steps with their recording status | no |
| [`record`](#record) | Record a test or replace its recording, also from a step on | yes |
| [`run`](#run) | Replay a test, or several for CI | only if you ask |
| [`open`](#open) | Open the app signed in, with workbench and chat; with a test at its end or at the entry of a step | only if you ask |
| [`role`](#role) | List, add or remove roles and their test users; `role login` stores a session (SSO) | no |
| [`theme`](#theme) | List, pick or check workbench themes | no |
| [`mcp`](#mcp) | MCP server for your own Claude Code session (started by Claude Code, not in `--help`) | – |

`npx caw help` prints the same overview in the terminal. `npx caw <command> --help` (or `-h`, anywhere on the line) prints only that command, `npx caw agent --help` the agent commands. `npx caw --version` prints the version.

When a command stops, the terminal shows the reason first, then for an invalid call the command's short form, then the code and exit code:

```
✗ create-ticket@s2: a step goes after the test as <test>@S<n>, e.g. order@S3.
  Usage: caw record <test> [--env <env>] [--role <role>] [--app <app>]  or  caw record <test>@<S4> [--env <env>]
  (code: usage, exit 3)
```

An option that needs a value never takes the next option as its value: `--env --headless` stops with `--env needs a value, e.g. --env local`.

## init

```bash
npx caw init --url http://localhost:5173
```

Asks in the terminal whether the app needs a sign-in, then opens it in Chrome. Sign in with a test account (caw-ai notices when the sign-in form is gone), go to the page where tests should start and click **Done** in the card at the bottom right of the window. caw-ai detects framework, login form and a "signed in" marker and creates:

- `caw.config.json`
- `caw/.env.example` with the credential variables per role
- a `caw` entry in `.mcp.json` (to the installed copy if caw is in `node_modules`, otherwise `npx caw-ai mcp`; an `npx` entry is switched to the installed copy once there is one)
- `caw/tests/` for your test plans and `caw/caw.md` for notes Claude reads in every run
- `.gitignore` entries for `caw/.env`, `.caw/` and `caw/.auth/`

Anything it couldn't detect is set to `TODO`. `doctor` lists it, `validate` fails with exit 3 until it is filled in. Existing files are left alone.

| Option | |
|---|---|
| `--url <address>` | The app's address. Without it, `init` asks. |
| `--yes` | Don't wait for you to sign in, ask no questions. Good for apps without login. With a login nobody signs in: `signedInSelector` stays `TODO` and `startUrl` stays `/` (or the path of `--url`). |
| `--from <file>` | Use an existing `--explore-only` result instead of opening the app. If `caw/.explore.json` exists, `init` uses it automatically. |
| `--no-mcp` | Don't touch `.mcp.json`. |
| `--offline` | Don't open the app: write the template with `TODO` for the sign-in. Without a terminal and without `--url`, `init` does this by itself. |
| `--insecure-tls` | Accept self-signed certificates (local environments only). |

### Only look: `--explore-only`

```bash
npx caw init --explore-only --url http://localhost:5173
```

Looks at the app like `init`, but only writes suggestions to `caw/.explore.json`: framework, login type and selectors, signed-in marker, start page, messages and console noise. Each suggestion has `confidence: certain` or `likely`. Pass the file to `init --from` later.

With it: `--yes`, `--insecure-tls` (as for `init`); `--login` or `--no-login` answer the sign-in question for scripts.

With a sign-in, the card then asks for the role of the account you used and saves it as a test user (see [role](#role)); `init` takes the roles from there.

## doctor

```bash
npx caw doctor
npx caw doctor --agent docker
```

Checks Node, Chrome, Claude Code (agent `local`) or Docker and token (agent `docker`), the config, `TODO` values, credentials per role and whether each environment answers. Every failed check comes with the next step. For an invalid config it shows the first finding; `validate` lists them all. Placeholder addresses (`example.com`, `.test`, `.invalid`) are reported, never contacted.

For ExtJS with an environment that has `overlay: true`, doctor adds optional lines per app: `bootstrap.json` present and current, the local code server (`local code http://localhost:1841/ serves <app>`, `doesn't answer` with the `start` command, or `runs at <found>` when the watch took another port), and per part (app, package) the result of the last `overlay check` with its age, or the hint to run one. doctor never starts anything.

## overlay status

```bash
npx caw overlay status
npx caw overlay status --env dev --app web --json
```

Is the local code server of the app ready for `--overlay`? No browser, no sign-in, starts nothing. It requests `overlay.url`; for ExtJS it checks that the server is the watch of *this* app (`app.json` name, `bootstrap.json` with a load order) and, if not, looks for the app's watch on another port.

| State | Meaning | Exit |
|---|---|---|
| `ready` | The server answers (ExtJS: serves this app). A build folder or fixed files need no server and are `ready` too. | 0 |
| `moved` | The ExtJS watch runs at `foundUrl` instead of `url` (port was taken). Runs use it; set `url`. | 0 |
| `down` | Nothing answers at `url`. The output names `start` and the app folder. | 2 |
| `wrong-app` | Another app (or no Sencha watch) answers at `url`. | 2 |
| `stale` | The watch lists files in `bootstrap.json` it doesn't serve. | 2 |
| `not-overlay`, `no-app` | The environment has no `"overlay": true`, or the app is unknown or has no `app.json`. | 3 |
| `static-missing` | A file from `overlay.statics` is missing. | 2 |
| `static-invalid` | A `overlay.statics` path leads outside the workspace, or to a secret file. | 3 |

`--json` prints `{ state, framework, app, appDir, url, foundUrl?, start, statics?, message? }` as the only line on stdout; `statics` lists each entry with `name`, `path` and `state` (`ok`, `missing`, `outside`, `secret`).

## overlay check

```bash
npx caw overlay check
npx caw overlay check --env dev --apply
npx caw overlay check --json
```

Opens the app headless with `--overlay` (signed in, no steps, no Claude) and compares the page's script requests with what the overlay should replace. For ExtJS that is the app and every own package from `bootstrap.json`, `x.js` and `x-debug.js` counting as one part. Per part it prints `local`, `deployed` or `not loaded` (maybe loaded later).

A part that came `deployed` means a mixed version: the page ran partly on your code, partly on the server's. The script URLs are matched by name, independent of `assetUrlPattern`, so the check also finds sources the config doesn't know. For each such source it suggests a pattern:

```
✓ shop-theme: local
! OrderEntry: deployed
› https://dev.example.com/o/FormProxyServlet?url=repository:///Root/ (5 script(s)): assetUrlPattern "[?&]url=repository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)"
```

`--apply` adds the suggested patterns to `assetUrlPattern` in `caw.config.json` (only missing ones; a single string becomes a list), validates the file before writing and checks once more. A source without a safe pattern is listed as such; add one by hand.

Before the browser it runs `overlay status`. If the server isn't ready it stops with that state, the address and the `start` command, and starts nothing. `--start` runs `start` in the app folder in that case and stops it afterwards (CI).

`--env` defaults to the only environment with `overlay: true`; `--app` and `--role` to the only app and the first role. The result always goes to `.caw/overlay-check.json` (`at`, `target`, `app`, `state`, `url`, `start`, `parts`, `missed`, `notLoaded`, `suggestions`, `unresolved`, with `overlay.statics` also `statics` with `status` `local`, `deployed` or `not-loaded` per entry, after `--apply` also `applied`). A static that came from the server makes the check `incomplete`. `--json` prints it as the only line on stdout. Exit 0 complete, 2 incomplete or server problem (`down`, `wrong-app`, `stale`), 3 no overlay environment or no app.

## validate

```bash
npx caw validate
```

Checks `caw.config.json` and every file in `caw/tests/` without browser or Claude. Errors name file and line, all of them at once. Use it in CI and pre-commit hooks.

`auth` values still `TODO` fail validation (exit 3, code `config-invalid`): each one says what belongs there.

Per test and target it prints which code runs there and where `--overlay` would apply, e.g. `smoke (staging): deployed` or `smoke (dev): deployed; with --overlay: overlay, build dist`. Notes that don't fail validation: settings without effect, such as an app with `overlay` while no environment allows it (see [Testing local code](configuration.md#testing-local-code)).

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

1. You demonstrate the flow, or let Claude follow the test plan.
2. Claude shows a plan in the chat. You approve it or ask for changes.
3. Claude walks the flow and checks each step.
4. caw-ai replays the recording without Claude.
5. You choose "Adopt test plan". Only then are files written.

Runs only on environments where Claude may work (`"claude": true`). `--env` can be left out if there is only one.

| Option | |
|---|---|
| `--role <role>` | First recording only. Not needed if the config has one role. |
| `--app <app>` | First recording only. Not needed if the config has one app. |
| `--also <app>` | First recording only: the flow continues in another app of the project. |
| `--read-only` | First recording only: the test doesn't write data (`mutates: false`). |
| `--overlay [build\|dev\|<url>]` | Lay local code over the deployed environment, see [Testing local code](configuration.md#testing-local-code). |
| `--start` | Start the environment with its `start` command if it doesn't answer, and stop it at the end ([lifecycle](configuration.md#starting-stopping-and-resetting-an-environment)). With `--overlay` also the parts' local code servers. Without it caw starts nothing and names the command. |
| `--reset` | Run the environment's `reset` before recording. |
| `--agent local\|docker\|session` | Where Claude runs. Default: `agent.mode` from the config, else `local`. |
| `--claude-timeout <duration>` | Time limit for Claude, default `60m`. |
| `--max-actions <n>` | Limit on Claude's browser actions, default `maxSteps` or 100. |
| `--step-timeout <duration>` | Time limit per step in the check run, default `30s`. |

### From a step on

```bash
npx caw record create-ticket@S3 --env local
```

Re-records the test from S3 to the end. Use it when the app changed on purpose from there on, after you changed a step's text by hand, or to add steps at the end. S1 and S2 replay without Claude, then Claude follows the old plan from S3 while you steer in the chat; there is no demonstration. From S3 on the plan may change: Claude can add, remove, rename or reorder steps. The steps before S3 and their recordings stay exactly as they are; steps no longer in the plan are deleted when you adopt. Baselines and network effects from S3 on are learned again on the next healthy run. `@S1` records the whole test, like `record create-ticket`.

There is no check run first: if a step fails because of a bug in the app, find the cause with `run` instead. To repair just the one step that failed, use "Fix step" in the chat of a run. `--role`, `--app`, `--also` and `--read-only` don't apply here (exit 3): the test keeps its metadata.

## run

```bash
npx caw run create-ticket --env local
```

Replays the recording. No Claude, no tokens. On environments where Claude may work (`claude`) the chat sits next to the app: if a step fails you can ask Claude for the cause or have the step fixed right there.

A run changes no file on its own. With `--learn` it learns missing baselines and effects into `caw/recordings/<test>.yaml`, in every mode, CI included; with the chat, a passed run that could learn offers "Learn baselines" on its end card instead, and only that click writes. The first line says which environment, which team language and whether the run learns, e.g. `Mode on local (team language en): with chat; learns: no.` At the end a run that learned says what changed, e.g. `Changed: caw/recordings/create-ticket.yaml (baselines S2, S5)`, or `Test file unchanged.` After a failure it prints the reason of the failed step (also with `--headless` and in CI) and the next commands: a run with chat to find the cause and `open <test>@<step>` up to the entry of the failed step. The report path is also printed as a `file://` link. In `report.md`, steps after the failed one are `skipped`, and screenshots link to the run's `agent/` folder.

| Option | |
|---|---|
| `--overlay [build\|dev\|<url>]` | Lay local code over the deployed environment: the build folder, the local code server at `overlay.url` (dev server, Sencha watch), or the server at `<url>`; without a value the one configured source. Only on environments with `"overlay": true`. Without the option the deployed version always runs. See [Testing local code](configuration.md#testing-local-code). |
| `--start` | As for `record`. |
| `--reset`, `--no-reset` | The environment's `reset` runs once before the first writing test; `--reset` before the first test, `--no-reset` never. |
| `--explain` | On errors or warnings Claude explains the cause without being asked. Costs tokens. |
| `--no-chat` | Visible window, no chat, no Claude. Like CI. |
| `--headless` | No window, no chat. 1920×1080. |
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

`--report junit=<file>` also writes the table as JUnit XML (relative to the project folder): `fail` as `<failure>`, everything else that didn't pass as `<error>`.

## open

```bash
npx caw open --env dev --overlay
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local --overlay
```

Opens the app signed in, with workbench and chat: navigate, try things, develop with Claude. Learns nothing and writes no test file.

- **Without a test** it opens the app's start page. Without `--env` it takes the only environment where Claude may work.
- **`open <test>`** replays the whole test first, then the window is yours.
- **`open <test>@S3`** stops at the entry of S3: S1 and S2 replay completely, of S3 only its navigation (`goto`, clicks, waiting for the page). Its inputs and its check stay open for you; the terminal says `Ready for S3 …: navigation done, inputs open`. If S3 has no inputs at all (e.g. only a submit click), none of S3 runs; if one of its clicks wrote data in earlier runs, it stops before that click; if S3 isn't recorded or is stale, none of it runs. The terminal names the reason.

With a test, `open` signs in with the test's role and replays without Claude; the step it stops at isn't judged. It runs the deployed version, unless you add `--overlay`.

| Option | |
|---|---|
| `--role <role>`, `--app <app>` | Without a test only; not needed if the config has only one. A test brings its own. |
| `--overlay [build\|dev\|<url>]`, `--start`, `--reset` | As for `run` (`reset` only with `--reset`). |
| `--step-timeout <duration>` | Time limit per step while replaying, default `30s`. |
| `--agent local\|docker\|session`, `--claude-timeout <duration>`, `--max-actions <n>` | As for `record`. |

After the handover, **F1** in the workbench opens "Open…": any test for this environment, and optionally a step. Without a step the test runs to its last step; with a step it lands at that step's entry, like `open <test>@<step>`. caw-ai starts a new session (cookies and site storage cleared), signs in with the account of the test's role and plays it in the same window, without Claude. With Basic auth only tests of your own role.

If restoring fails on something that does not always show up (a cookie banner already dismissed), ask in the chat: Claude can mark the click optional. What you accept goes into the test file right away. While recording, use `click <target> --optional`.

## role

```bash
npx caw role                          # roles, whether a test user is set (never the values), tests per role
npx caw role list --json              # the same as one JSON line
npx caw role add clerk --env dev   # window on the sign-in page: sign in, save the role
npx caw role remove clerk             # only if no test uses it; also drops its lines in caw/.env
npx caw role login clerk --env dev    # auth.type storageState: sign in by hand, store the session
```

A role is a test user. `role add` opens the sign-in page of the environment. You sign in with the test account; the card names the role (prefilled, editable) and **Save** writes user name and password to `caw/.env`, the role with its variable names to `caw.config.json` and `caw/.env` to `.gitignore`. **+ Another role** signs out and takes the next account. The values go from the page straight to the file: not to Claude, not to the terminal, not into `caw/.explore.json`.

`init` (also with `--explore-only`) ends the same way: after **Done** the card asks for the role of the account you signed in with. When `record`, `run` or `open` needs a role without a test user, the window opens first and the run goes on after **Save**; in CI and with `--headless` it ends with `credentials-missing`. For `auth.type: storageState` use `role login`.

`role login` is for `auth.type: storageState` (SSO, OAuth, MFA). It opens Chrome on the login and you sign in by hand. As soon as `signedInSelector` shows up, caw-ai stores cookies and storage in `caw/.auth/<env>/<role>.json`. Run it again when the session expires.

## theme

```bash
npx caw theme                 # list themes, the active one marked
npx caw theme use phosphor    # pick one
npx caw theme check my-theme  # schema, contrast, mark width, fonts
```

The theme is yours, stored in `prefs.json`, and applies in every project. Built in: `nacht` (default), `bernstein`, `phosphor`, `kachel`, `cockpit`. Change colours, glyphs, raven and CRT look with F7 in the workbench; own themes are folders next to `prefs.json`. Details: [themes/README.md](../themes/README.md).

## mcp

Started by Claude Code through `.mcp.json` (`claude mcp add caw --scope project -- npx caw-ai mcp`). You don't call it yourself. The server is named `caw`; on start it tells Claude what caw is for and to read `caw_guide` first. It gives your session these tools:

| Tool | | Tokens |
|---|---|---|
| `caw_guide` | The guidance per topic (`topic`); without one the index. `overlay` and `extjs` only when the project uses them | no |
| `caw_doctor` | `doctor` as data (`agent`, `env`) | no |
| `caw_init` | `mode: explore` (`url`, `login` or `yes`): the window, waits and returns the suggestions and saved roles (`wait: false` only starts it); `mode: write` (`fromExplore`) and `mode: offline` write the files; `env`, `language`, `insecureTls`, `allowHttp`, `roles`, `noMcp` | no |
| `caw_role` | Roles as data (`list`), the sign-in window for a new one (`add`, `name`, `env`; waits and returns the saved roles), a saved session (`login`), `remove`; never user names or passwords | no |
| `caw_config` | Read the config, or change it validated (`patch`, `dryRun`). A patch that adds or removes the `overlay` block changes the tool list | no |
| `caw_validate` | `validate` as data | no |
| `caw_list` | `list` as data | no |
| `caw_overlay` | Only with an `overlay` block: `action: status` (`overlay status` in-process, fast), `check` or `apply` (`overlay check`, `--apply`; waits up to 3 minutes); `env`, `part` | no |
| `caw_start` | Start `run`, `record` or `open` with `--agent session` (`test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset`, or `args`; `step` for `record` and `open`, only with `test`). With `overlay` it checks the local code server first: `down`, `wrong-app` or `stale` returns `state`, `url`, `start` and `appDir` instead of starting; `moved` starts with `--overlay <foundUrl>`. Never `--start` together with `overlay`: the session starts the local code server itself after asking you. `start` and `reset` run the environment's configured commands | none beyond your session |
| `caw_status` | Is a run waiting for the session? Last lines of output; last run's result and artefacts as data. `wait` (up to 120 s) returns as soon as the run needs the session, ends or reports something new | no |
| `caw` | The agent commands (`snapshot`, `click`, `plan`, `finish`, …) | in the run |
| `caw_selection` | The element you picked with the crosshair in the workbench | no |

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
| `CAW_LANG` | `en` or `de`. Overrides `language` in the config. |
| `CAW_AI_HOME` | Folder for personal settings (`prefs.json`). Default `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` or `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API key from the Claude Console for the `docker` agent. `local` and `session` use your Claude Code login. |
| `CAW_CLAUDE_MODEL`, `CAW_CLAUDE_BUDGET` | Model and budget in US dollars for Claude runs (`--model`, `--max-budget-usd`); override `agent.model` and `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Windows only: `windows` or `wsl` to pick the Docker route. |
| `CI` | Set: no chat, `docker` agent only; `record` and `open` are rejected. |
| `NO_COLOR`, `FORCE_COLOR` | Terminal colors off or on. |
| `MCP_TOOL_TIMEOUT` | In Claude Code's environment: raise it if `plan` or `chat` time out in your session. |

## Error codes

When caw-ai stops, or a run ends with `error`, it prints the reason and then the code.

| Code | Exit | Fix |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw <command> --help` |
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
| `auth-missing` | 3 | Delete the file under `caw/.auth/` and run `auth` again |
| `credentials-missing` | 2 | `role add <role> --env <env>` (sign in in the window), or set the variables in the environment or `caw/.env` (CI) |
| `login-form-missing`, `login-failed` | 2 | Is the backend up? Are `auth` selectors and credentials right? |
| `env-unreachable` | 2 | Start the environment (or pass `--start` when it has a `start` command), check the URL |
| `env-start-failed` | 2 | The environment's `start` ended with an error: see the log tail and `.caw/env/<env>-start.log` |
| `env-not-ready` | 2 | `ready` did not answer below 500 in time: raise `ready.timeoutMs` or check the `start` command |
| `env-reset-failed` | 2 | The environment's `reset` failed or took longer than 10 minutes; no test ran. See `.caw/env/<env>-reset.log` |
| `app-not-loaded`, `app-not-settled` | 2 | Open the page by hand, check the console |
| `browser-missing` | 2 | Install Google Chrome, or set `browser` in the config |
| `overlay-not-ready` | 2 | The local code server at `overlay.url` doesn't answer, serves another app, or the build is missing: run the `start` command the message names in the app folder, or add `--start` |
| `overlay-ssr` | 2 | Server-rendered page: test local code with the dev server as the environment (`--env local`) |
| `overlay-incomplete` | 2 | Parts came from the server instead of local code (mixed version): add the suggested `assetUrlPattern`, or run `overlay check --apply` |
| `overlay-unused` | 2 | Nothing came from local code: do build or dev server match the app, does `assetUrlPattern` cover its requests? |
| `overlay-ambiguous` | 2 | ExtJS: give one app its own `output.js.path` in `app.json` |
| `overlay-stale` | 2 | ExtJS: the watch's `bootstrap.json` names files it doesn't serve. Wait until the watch has finished building, or restart it |
| `claude-missing` | 2 | Install Claude Code and sign in, or use `--agent docker` |
| `token-missing` | 2 | Set `ANTHROPIC_API_KEY`, or use `--agent local` |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Start Docker with Linux containers, or use `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Check registry login and `sandboxImage` |
| `aborted` | 2 | You closed the window or pressed Ctrl+C |
| `chat-failed`, `no-session` | 2 | Start again |
