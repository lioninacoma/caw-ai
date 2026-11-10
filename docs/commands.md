English · [Deutsch](commands.de.md)

# Commands

Run every command from your project root: `npx caw-ai <command>` (or `pnpm exec`, `yarn`). `<env>` is a name from `environments` in `caw.config.json`, e.g. `local`. With tenants (`sites`) it is `tenant/env`, e.g. `north/dev`.

`--target` may be left out when the choice is clear: `run`, `record` and `fix` then take the test's only target (for `record` and `fix`, the only one of them where Claude may work; for `record` of a new test, the only environment where Claude may work). The terminal names the choice, e.g. `› Target: local (only target of create-ticket)`. If it is ambiguous, the command stops and lists the choices: `--target is missing: local, dev`.

| Command | What it does | Claude? |
|---|---|---|
| [`init`](#init) | Set up a project: look at the app, write config, skill, `.mcp.json` | no |
| [`explore`](#explore) | Look at the app and suggest settings, write nothing else | no |
| [`skill`](#skill) | Create or update the Claude Code skill and `.mcp.json` | no |
| [`doctor`](#doctor) | Check machine, config, credentials and environments | no |
| [`validate`](#validate) | Check config and tests offline | no |
| [`list`](#list) | List tests and steps with their recording status | no |
| [`record`](#record) | Record a test or replace its recording | yes |
| [`run`](#run) | Replay a test, or several for CI | only if you ask |
| [`fix`](#fix) | Re-record one step | yes |
| [`open`](#open) | Open the app signed in, with workbench and chat, without a test | only if you ask |
| [`auth`](#auth) | Sign in by hand and store the session (SSO) | no |
| [`mcp`](#mcp) | MCP server for your own Claude Code session | – |

`npx caw-ai help` prints the same overview in the terminal. `npx caw-ai <command> --help` (or `-h`, anywhere on the line) prints only that command, `npx caw-ai help agent` the agent commands. `npx caw-ai --version` prints the version.

When a command stops, the terminal shows the reason first, then for an invalid call the command's short form, then the code and exit code:

```
✗ fix expects a step like S4.
  Usage: caw-ai fix <test> <S4> [--target <env>]
  (code: usage, exit 3)
```

An option that needs a value never takes the next option as its value: `--target --headless` stops with `--target needs a value, e.g. --target local`.

## init

```bash
npx caw-ai init --url http://localhost:5173
```

Opens the app in Chrome. Sign in once, then press Enter. caw-ai detects framework, login form and a "signed in" marker and creates:

- `caw.config.json`
- `caw/.env.example` with the credential variables per role
- `.claude/skills/caw-ai/SKILL.md` and a `caw-ai` entry in `.mcp.json`
- `caw/tests/` for your test plans and `caw/caw.md` for notes Claude reads in every run
- `.gitignore` entries for `caw/.env`, `.caw/` and `caw/.auth/`

Anything it couldn't detect is set to `TODO`. `doctor` and `validate` point you to it. Existing files are left alone.

| Option | |
|---|---|
| `--url <address>` | The app's address. Without it, `init` asks. |
| `--yes` | Don't wait for you to sign in, ask no questions. Good for apps without login. |
| `--from <file>` | Use an existing `explore` result instead of opening the app. If `caw/.explore.json` exists, `init` uses it automatically. |
| `--no-mcp` | Don't touch `.mcp.json`. |
| `--offline` | Don't open the app: write the template with `TODO` for the sign-in. Without a terminal and without `--url`, `init` does this by itself. |
| `--insecure-tls` | Accept self-signed certificates (local environments only). |

## explore

```bash
npx caw-ai explore --url http://localhost:5173
```

Like `init`, but only writes suggestions to `caw/.explore.json`: framework, login type and selectors, signed-in marker, start page, messages and console noise. Each suggestion has `confidence: certain` or `likely`. Pass the file to `init --from` later.

Options: `--yes`, `--insecure-tls` (as for `init`).

## skill

```bash
npx caw-ai skill
```

Creates or updates `.claude/skills/caw-ai/SKILL.md` and the `.mcp.json` entry. Run it after updating caw-ai. Then tell Claude Code "Set up caw-ai" and it walks you through `init` and `doctor`.

## doctor

```bash
npx caw-ai doctor
npx caw-ai doctor --agent docker
```

Checks Node, Chrome, Claude Code (agent `local`) or Docker and token (agent `docker`), the config, `TODO` values, credentials per role and whether each environment answers. Every failed check comes with the next step.

## validate

```bash
npx caw-ai validate
```

Checks `caw.config.json` and every file in `caw/tests/` without browser or Claude. Errors name file and line. Use it in CI and pre-commit hooks.

Per test and target it prints which code runs there and where `--overlay` would apply, e.g. `smoke (staging): deployed` or `smoke (dev): deployed; with --overlay: overlay, build dist`. Notes that don't fail validation: `auth` values still `TODO` and settings without effect, such as an app with `overlay` while no environment allows it (see [Testing local code](configuration.md#testing-local-code)).

## list

```bash
npx caw-ai list
npx caw-ai list create-ticket
```

Without a test: one row per test with its targets, its recording status (`recorded`, `stale (S2, S3)`, `not recorded`) and whether it writes data. With a test: one line per step, e.g. `S2  Create a ticket  (stale)`. No browser, no Claude.

A test name that doesn't exist names the known tests and, for a typo, the closest one (`Did you mean create-ticket?`). An unknown step names the test's steps (`Steps: S1–S6.`).

## record

```bash
npx caw-ai record create-ticket --target local
```

Records a test plan from `caw/tests/create-ticket.yaml`, or creates a new test if the file doesn't exist. Chrome opens with the workbench and a chat:

1. You demonstrate the flow, or let Claude follow the test plan.
2. Claude shows a plan in the chat. You approve it or ask for changes.
3. Claude walks the flow and checks each step.
4. caw-ai replays the recording without Claude.
5. You choose "Adopt test plan". Only then are files written.

Runs only on environments where Claude may work (`"claude": true`). `--target` can be left out if there is only one.

| Option | |
|---|---|
| `--role <role>` | First recording only. Not needed if the config has one role. |
| `--app <app>` | First recording only. Not needed if the config has one app. |
| `--also <app>` | First recording only: the flow continues in another app of the project. |
| `--read-only` | First recording only: the test doesn't write data (`mutates: false`). |
| `--overlay [build\|dev\|<url>]` | Lay local code over the deployed environment, see [Testing local code](configuration.md#testing-local-code). |
| `--agent local\|docker\|session` | Where Claude runs. Default: `agent.sandbox` from the config, else `local`. |
| `--timeout <minutes>` | Time limit for Claude, default 60. |
| `--max-steps <n>` | Limit on Claude's browser actions, default `maxSteps` or 100. |
| `--step-timeout <seconds>` | Time limit per step in the check run, default 30. |

## run

```bash
npx caw-ai run create-ticket --target local
```

Replays the recording. No Claude, no tokens. On environments where Claude may work (`claude`) the chat sits next to the app: if a step fails you can ask Claude for the cause or have the step fixed right there.

With the chat, the run learns missing baselines into `caw/recordings/<test>.yaml`. At the end it says what changed, e.g. `Changed: caw/recordings/create-ticket.yaml (baselines S2, S5)`, or `Test file unchanged.` After a failure it prints the next commands: a run with chat to find the cause and `--until` up to the step before the failure. The report path is also printed as a `file://` link.

| Option | |
|---|---|
| `--until <S4>` | Stop after S4, the window stays open. Implies `--handover`. Runs the deployed version like every run, unless you add `--overlay`. |
| `--overlay [build\|dev\|<url>]` | Lay local code over the deployed environment: the build folder, the dev server, or the dev server at `<url>`; without a value the one configured source. Only on environments with `"overlay": true`. Without the option the deployed version always runs. See [Testing local code](configuration.md#testing-local-code). |
| `--handover` | Leave the window open after the run. |
| `--advise` | On errors or warnings Claude explains the cause without being asked. Costs tokens. |
| `--no-chat` | Visible window, no chat, no Claude. Like CI. |
| `--headless` | No window, no chat. 1920×1080. |
| `--no-learn` | Keep the chat, but learn no baselines: the test file only changes if you adopt something in the chat. |
| `--step-timeout <seconds>` | Time limit per step, default 30. |
| `--timeout <minutes>` | Time limit for Claude when it investigates or fixes, default 60. |
| `--max-steps <n>` | Limit on Claude's actions when fixing. |
| `--agent local\|docker\|session` | As for `record`. |

With `CI` set, `run` has no chat and never starts Claude, like `--no-chat`; `--until` and `--handover` are rejected (exit 3), since nobody would take over the browser. `record`, `fix` and `open` need a person and are rejected in CI too. On runners without a display add `--headless` or use `xvfb-run`.

### Several tests (CI)

```bash
npx caw-ai run --all --target dev --headless --report junit=caw-junit.xml
npx caw-ai run create-ticket close-ticket --target dev
```

Runs the tests one after another, without chat (`--advise`, `--handover` and `--until` are rejected). `--all` takes every test that lists the target. Without `--target` the only target of the tests is used. A test that can't run (missing recording, typo) doesn't stop the others. At the end a table shows `PASS`, `FAIL`, `ERROR`, `NEEDS RECORDING` or `REJECTED` per test. The exit code is that of the worst run, in this order: `2` error > `1` fail > `4` needs recording > `3` rejected > `0` pass.

`--report junit=<file>` also writes the table as JUnit XML (relative to the project folder): `fail` as `<failure>`, everything else that didn't pass as `<error>`.

## fix

```bash
npx caw-ai fix create-ticket S2 --target local
```

Re-records exactly one step. Use it after you changed a step's text by hand, or added a new step at the end. Steps before it replay without Claude. The other steps stay untouched. Options: `--agent`, `--overlay`, `--timeout`, `--max-steps`, `--step-timeout`.

## open

```bash
npx caw-ai open --target dev --overlay
```

Opens the app signed in, with workbench and chat, without a test: navigate, try things, develop with Claude. Like `run --until` without steps before it. Learns nothing and writes no test file. Without `--target` it takes the only environment where Claude may work.

| Option | |
|---|---|
| `--role <role>`, `--app <app>` | Not needed if the config has only one. |
| `--overlay [build\|dev\|<url>]` | As for `run`. |
| `--agent local\|docker\|session`, `--timeout <minutes>`, `--max-steps <n>` | As for `record`. |

## auth

```bash
npx caw-ai auth user --target dev
```

For `auth.type: storageState` (SSO, OAuth, MFA). Opens Chrome on the login. Sign in by hand. As soon as `signedInSelector` shows up, caw-ai stores cookies and storage in `caw/.auth/<env>/<role>.json`. Run it again when the session expires.

## mcp

Started by Claude Code through `.mcp.json`. You don't call it yourself. It gives your session these tools:

| Tool | |
|---|---|
| `caw_start` | Start `run`, `record` or `fix` with `--agent session` |
| `caw_status` | Is a run waiting for the session? Last lines of output |
| `caw` | The agent commands (`snapshot`, `click`, `plan`, `finish`, …) |
| `caw_selection` | The element you picked with the crosshair in the workbench |

## Agent commands

`snapshot`, `click`, `fill`, `type`, `press`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

These are the only way Claude can touch the browser. They exist for the agent during `record` and `fix`; you won't need them. `npx caw-ai help agent` lists their arguments.

## Exit codes

| Code | |
|---|---|
| `0` | pass |
| `1` | fail: the app didn't do what the test expects |
| `2` | error: the environment prevented a verdict (server down, login failed, Chrome missing, …), or an unexpected internal error (the stack is printed) |
| `3` | rejected: invalid call, config or test file. Nothing ran. |
| `4` | needs recording: the recording is missing (`record`) or a step changed since it was recorded (`fix`). Nothing ran. |

## Environment variables

| Variable | |
|---|---|
| `CAW_LANG` | `en` or `de`. Overrides `language` in the config. |
| `CAW_AI_HOME` | Folder for personal settings (`prefs.json`). Default `%APPDATA%\caw-ai` or `~/.config/caw-ai`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token for the `docker` agent. Create one with `claude setup-token`. |
| `CAW_DOCKER` | Windows only: `windows` or `wsl` to pick the Docker route. |
| `CI` | Set: no chat, `docker` agent only; `record`, `fix`, `open`, `--until` and `--handover` are rejected. |
| `NO_COLOR`, `FORCE_COLOR` | Terminal colors off or on. |
| `MCP_TOOL_TIMEOUT` | In Claude Code's environment: raise it if `plan` or `chat` time out in your session. |

## Error codes

When caw-ai stops, it prints the reason and then the code.

| Code | Exit | Fix |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw-ai <command> --help` |
| `config-missing` | 3 | `npx caw-ai init --url <address>` |
| `config-invalid` | 3 | Fix the field named in the message, then `doctor` |
| `test-missing`, `test-invalid` | 3 | Create or fix the test file, then `validate` |
| `replay-missing` | 4 | `record` the test |
| `replay-stale` | 4 | A step changed since recording: `fix <test> <step>` |
| `step-unknown` | 3 | Use a step ID from the test file (`list <test>`) |
| `target-invalid`, `target-denied` | 3 | Use an environment from the config; production can't be recorded |
| `write-protected` | 3 | Recording and writing tests need `claude` / `writable` on the environment |
| `auth-missing` | 3 | Delete the file under `caw/.auth/` and run `auth` again |
| `credentials-missing` | 2 | Fill `caw/.env` from `caw/.env.example` |
| `login-form-missing`, `login-failed` | 2 | Is the backend up? Are `auth` selectors and credentials right? |
| `target-unreachable`, `unreachable` | 2 | Start the dev server, check the URL |
| `app-not-loaded`, `app-not-settled` | 2 | Open the page by hand, check the console |
| `browser-missing` | 2 | Install Google Chrome, or set `browser` in the config |
| `overlay-not-ready` | 2 | Start the dev server or build, or set `devCommand` / `buildCommand` on the app; the message names the command |
| `overlay-ssr` | 2 | Server-rendered page: test local code with the dev server as the environment (`--target local`) |
| `overlay-unused` | 2 | Nothing came from local code: do build or dev server match the app, does `assetUrlPattern` cover its requests? |
| `overlay-ambiguous` | 2 | ExtJS: give one app its own `output.js.path` in `app.json` |
| `watch-missing`, `watch-stale` | 2 | Start the Sencha watch (`sencha app watch`) or set `devCommand` |
| `claude-missing` | 2 | Install Claude Code and sign in, or use `--agent docker` |
| `token-missing` | 2 | Set `CLAUDE_CODE_OAUTH_TOKEN` |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Start Docker with Linux containers, or use `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Check registry login and `sandboxImage` |
| `aborted` | 2 | You closed the window or pressed Ctrl+C |
| `chat-failed`, `no-session` | 2 | Start again |
