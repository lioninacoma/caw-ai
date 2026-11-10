English · [Deutsch](commands.de.md)

# Commands

Run every command from your project root: `npx caw-ai <command>` (or `pnpm exec`, `yarn`). `<env>` is a name from `environments` in `caw.config.json`, e.g. `local`. With tenants (`sites`) it is `tenant/env`, e.g. `north/dev`.

| Command | What it does | Claude? |
|---|---|---|
| [`init`](#init) | Set up a project: look at the app, write config, skill, `.mcp.json` | no |
| [`explore`](#explore) | Look at the app and suggest settings, write nothing else | no |
| [`skill`](#skill) | Create or update the Claude Code skill and `.mcp.json` | no |
| [`doctor`](#doctor) | Check machine, config, credentials and environments | no |
| [`validate`](#validate) | Check config and tests offline | no |
| [`record`](#record) | Record a test or replace its recording | yes |
| [`run`](#run) | Replay a test | only if you ask |
| [`fix`](#fix) | Re-record one step | yes |
| [`auth`](#auth) | Sign in by hand and store the session (SSO) | no |
| [`mcp`](#mcp) | MCP server for your own Claude Code session | – |

`npx caw-ai help` prints the same overview in the terminal. `npx caw-ai --version` prints the version.

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

Per test and target it prints which code runs there, e.g. `smoke (dev): local build from dist` or `smoke (staging): deployed (environment staging has no localCode)`. Notes that don't fail validation: `auth` values still `TODO`, old names such as `agent` or `source`, and settings without effect (see [Testing local code](configuration.md#testing-local-code)).

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

Runs only on environments with `"claude": true`.

| Option | |
|---|---|
| `--role <role>` | First recording only. Not needed if the config has one role. |
| `--app <app>` | First recording only. Not needed if the config has one app. |
| `--also <app>` | First recording only: the flow continues in another app of the project. |
| `--read-only` | First recording only: the test doesn't write data (`mutates: false`). |
| `--code local\|deployed` | Which code runs, see [Testing local code](configuration.md#testing-local-code). With `deployed` a new test keeps `code: deployed`. |
| `--agent local\|docker\|session` | Where Claude runs. Default: `agent.sandbox` from the config, else `local`. |
| `--timeout <minutes>` | Time limit for Claude, default 60. |
| `--max-steps <n>` | Limit on Claude's browser actions, default `maxSteps` or 100. |
| `--step-timeout <seconds>` | Time limit per step in the check run, default 30. |

## run

```bash
npx caw-ai run create-ticket --target local
```

Replays the recording. No Claude, no tokens. On environments with `claude` the chat sits next to the app: if a step fails you can ask Claude for the cause or have the step fixed right there.

| Option | |
|---|---|
| `--until <S4>` | Stop after this step and hand you the window, with local code where allowed. |
| `--code local\|deployed` | Which code runs: the local build or the deployed version. Default: `code` in the test and the config, see [Testing local code](configuration.md#testing-local-code). `local` on an environment without `localCode` is rejected (exit 3). |
| `--handover` | Leave the window open after the run. |
| `--advise` | On errors or warnings Claude explains the cause without being asked. Costs tokens. |
| `--no-chat` | Visible window, no chat, no Claude. Like CI. |
| `--headless` | No window, no chat. 1920×1080. |
| `--step-timeout <seconds>` | Time limit per step, default 30. |
| `--timeout <minutes>` | Time limit for Claude when it investigates or fixes, default 60. |
| `--max-steps <n>` | Limit on Claude's actions when fixing. |
| `--agent local\|docker\|session` | As for `record`. |

With `CI` set, `run` has no chat and never starts Claude, like `--no-chat`; `--until` and `--handover` are rejected (exit 3), since nobody would take over the browser. `record` and `fix` need a person and are rejected in CI too. On runners without a display add `--headless` or use `xvfb-run`.

## fix

```bash
npx caw-ai fix create-ticket S2 --target local
```

Re-records exactly one step. Use it after you changed a step's text by hand, or added a new step at the end. Steps before it replay without Claude. The other steps stay untouched. Options: `--agent`, `--code`, `--timeout`, `--max-steps`, `--step-timeout`.

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

These are the only way Claude can touch the browser. They exist for the agent during `record` and `fix`; you won't need them. `npx caw-ai help` lists their arguments.

## Exit codes

| Code | |
|---|---|
| `0` | pass |
| `1` | fail: the app didn't do what the test expects |
| `2` | error: the environment prevented a verdict (server down, login failed, Chrome missing, …), or an unexpected internal error (the stack is printed) |
| `3` | rejected: invalid call, config or test file. Nothing ran. |

## Environment variables

| Variable | |
|---|---|
| `CAW_LANG` | `en` or `de`. Overrides `language` in the config. |
| `CAW_AI_HOME` | Folder for personal settings (`prefs.json`). Default `%APPDATA%\caw-ai` or `~/.config/caw-ai`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token for the `docker` agent. Create one with `claude setup-token`. |
| `CAW_DOCKER` | Windows only: `windows` or `wsl` to pick the Docker route. |
| `CI` | Set: no chat, `docker` agent only; `record`, `fix`, `--until` and `--handover` are rejected. |
| `NO_COLOR`, `FORCE_COLOR` | Terminal colors off or on. |
| `MCP_TOOL_TIMEOUT` | In Claude Code's environment: raise it if `plan` or `chat` time out in your session. |

## Error codes

When caw-ai stops, it prints a code and the reason.

| Code | Exit | Fix |
|---|---|---|
| `usage` | 3 | `npx caw-ai help` |
| `config-missing` | 3 | `npx caw-ai init --url <address>` |
| `config-invalid` | 3 | Fix the field named in the message, then `doctor` |
| `test-missing`, `test-invalid` | 3 | Create or fix the test file, then `validate` |
| `replay-missing` | 3 | `record` the test |
| `replay-stale` | 3 | A step changed since recording: `fix <test> <step>` |
| `step-unknown` | 3 | Use a step ID from the test file |
| `target-invalid`, `target-denied` | 3 | Use an environment from the config; production can't be recorded |
| `write-protected` | 3 | Recording and writing tests need `claude` / `writable` on the environment |
| `auth-missing` | 3 | Delete the file under `caw/.auth/` and run `auth` again |
| `credentials-missing` | 2 | Fill `caw/.env` from `caw/.env.example` |
| `login-form-missing`, `login-failed` | 2 | Is the backend up? Are `auth` selectors and credentials right? |
| `target-unreachable`, `unreachable` | 2 | Start the dev server, check the URL |
| `app-not-loaded`, `app-not-settled` | 2 | Open the page by hand, check the console |
| `browser-missing` | 2 | Install Google Chrome, or set `browser` in the config |
| `watch-missing`, `watch-stale`, `local-code` | 2 | Start your framework's watch |
| `claude-missing` | 2 | Install Claude Code and sign in, or use `--agent docker` |
| `token-missing` | 2 | Set `CLAUDE_CODE_OAUTH_TOKEN` |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Start Docker with Linux containers, or use `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Check registry login and `sandboxImage` |
| `aborted` | 2 | You closed the window or pressed Ctrl+C |
| `chat-failed`, `no-session` | 2 | Start again |
