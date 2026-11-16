English · [Deutsch](README.de.md)

# caw-ai

[![CI](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/caw-ai)](https://www.npmjs.com/package/caw-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> `caw` · *Context-Aware Web Testing*
>
> End-to-end regression tests for your own web app, written in plain language, recorded once with Claude, replayed without AI.

You describe what a user does, step by step. You demonstrate it in your app, or Claude walks it for you. From then on the
test replays with Playwright, locally and in CI: deterministic, fast, without tokens. When a step breaks, caw tells you
whether the test, the app or the environment is at fault, and Claude repairs the step in a chat next to the running app.

The same tests take you to any state of your app, signed in, to develop or to reproduce a bug.

<img src="docs/media/demo.webp" width="100%" alt="caw records a test of the Errand example: Claude proposes the test plan, works through it in the app and answers a question in the chat; then caw replays the recording without AI and the plan is adopted">

```yaml
# caw/tests/first-errand.yaml
id: first-errand
role: tester
writes: true
steps:
  - id: S1
    name: Add a todo
    do: Add the todo "Feed the raven {{runTag}}" with the tag "#home".
    expect: A confirmation shows the number of the new todo, and it is at the top of the list.
```

```bash
npx caw record first-errand --env local   # Claude performs the steps in Chrome, you adopt the result
npx caw run first-errand --env local      # replays the recording, without Claude
```

## How it works

- **Tests** are YAML files with steps in plain language. A recording stores each target as a Playwright locator (role, name,
  label, text), next to the plan in `caw/recordings/`.
- **Recording:** you demonstrate in the window, or Claude follows the plan. You approve plans that write data and decide
  whether a recording is adopted. `caw record <test>@S3` re-records from S3 after an intended change.
- **Replay** uses only the recording: no AI, no tokens, locally and in CI. A test runs on every environment it fits (local dev
  server, staging, a CI stack caw starts itself), writing tests only where writing is allowed, and never writes on production.
- **Triage:** a failure is classified as test, app or environment from the requests, console output and page changes seen
  while recording. In the chat, "Fix step" repairs only that step.
- **Reaching states:** `caw open <test>@S3` signs in with the test's role, replays up to S3 and hands you the window. Claude in
  the chat can use the page, reproduce a pasted bug report and propose the fix in your code.
- **Sign-in:** login forms, one-time codes, steps on an identity provider (e.g. Keycloak), HTTP Basic, stored sessions.
  Test accounts go straight to `caw/.env`; Claude never sees them.
- **Exit to Playwright:** `caw export <test>` writes a Playwright test that runs without caw.

Works with plain web apps, React, Vue, Angular, Next.js, Nuxt and server-rendered multi-page apps.
Extensions add [ExtJS](docs/extensions/extjs.md) and [local code on deployed portals](docs/extensions/overlay.md).

## Prerequisites

- Node 22.4+ and Google Chrome (or another Chromium browser) on Windows or Linux (macOS untested)
- [Claude Code](https://claude.com/claude-code), for recording and fixing only
- Docker, only if Claude should run in a container (`--agent docker`)

### Claude access and costs

caw does not call Claude itself. It starts your own Claude Code (`--agent local`), works as a tool in your Claude Code session
(`--agent session`), or passes your own `ANTHROPIC_API_KEY` into the container at run time (`--agent docker`, API key only); it
never reads or stores it. Which terms apply depends on your account: Pro and Max plans are for personal use; for company
projects and CI use a Team or Enterprise plan or an API key from the Claude Console. Complying with Anthropic's terms is up to
you.

Claude only runs while recording, fixing or when you ask in the chat; replays use no tokens. Usage is billed to your account.
To cap it, set a model and a budget per Claude run:

```json
"agent": { "model": "haiku", "maxBudgetUsd": 0.5 }
```

or for one run `CAW_CLAUDE_MODEL=haiku CAW_CLAUDE_BUDGET=0.5`. caw passes them to Claude Code as `--model` and
`--max-budget-usd`.

## Install

```bash
npm i -D caw-ai
```

## Usage

Start your app, then:

```bash
npx caw init --url http://localhost:5173   # writes caw.config.json; with --explore-only it looks at the app and you sign in once
npx caw doctor                             # lists what is still missing
```

Describe a test in `caw/tests/smoke.yaml`:

```yaml
id: smoke
role: tester
writes: false
steps:
  - id: S1
    name: Open the dashboard
    do: Open "Dashboard" in the navigation.
    expect: The dashboard is visible.
```

Record it once, replay it from then on:

```bash
npx caw record smoke --env local
npx caw run smoke --env local
```

[`examples/errand`](examples/errand) is a small todo app with sign-in and a recorded test you can replay right away; see
[`examples`](examples).

### Common commands

| Task | Command |
|---|---|
| Run a test | `caw run <test> --env local` |
| Run it like CI | `caw run <test> --env staging --headless` |
| Run all tests that fit an environment | `caw run --all --env staging` |
| Record a new test | `caw record <test> --env local` |
| Re-record from a changed step to the end | `caw record <test>@S3 --env local` |
| Get the app to the start of a step and keep coding there | `caw open <test>@S3 --env local` |
| Open the app signed in, without a test | `caw open --env local` |
| Let Claude explain failures right away | `caw run <test> --env local --explain` |
| Export a test to Playwright | `caw export <test>` |
| Check config and tests | `caw validate` |

Exit codes: `0` pass, `1` fail, `2` environment error, `3` invalid input, `4` needs recording. All commands and options:
[docs/commands.md](docs/commands.md).

### In CI

```yaml
- run: npx caw validate
- run: npx caw run --all --env staging --headless --report junit=out/caw.xml
```

With `CI` set there is no chat and Claude is not started. Record locally, commit the files, replay in CI. Pass the test users
as secrets named after the role: `CAW_TESTER_USER`, `CAW_TESTER_PASSWORD` (and `CAW_TESTER_TOTP` for one-time codes),
optionally per environment with a suffix, e.g. `CAW_TESTER_USER__STAGING`. An environment with `start`, `stop` and `reset`
commands is started by `--start` and reset before the first writing test.

### From Claude Code

Register caw as an MCP server of the project, then just ask Claude Code:

```bash
claude mcp add caw --scope project -- npx caw-ai mcp
```

```
set up caw for this project
record a test for creating a ticket
take me to the ticket detail page, I want to work on the status field
```

On Windows (not WSL): `claude mcp add caw --scope project -- cmd /c npx caw-ai mcp`. `caw init` switches the entry to the
installed copy once caw is in `node_modules`.

## Working in the window

`caw open <test>@S3` replays a test up to the entry of S3 and hands you the window, signed in; `caw open <test>` runs the
whole test first.

### Open a test at a step

F1 ("Open…") lists every test of the environment, for any role. Pick a test and a step; caw signs in fresh with that role's
account, replays the steps before it and stops at the step's entry: its navigation done, its inputs open.

<img src="docs/media/states.webp" width="100%" alt="The F1 dialog lists the test first-errand with its steps S1 to S4">

### Develop

Pick an element in the app and ask about it. Claude reads your source code and answers with file and line. Against your dev
server, F5 loads your change.

<img src="docs/media/develop.webp" width="100%" alt="An element is picked in the app; Claude explains in the chat why &quot;Add todo&quot; is disabled, with server.mjs:134">

### Fix a bug with Claude

Paste a bug report into the chat. Claude reproduces it in the reached state, names the cause and proposes the fix as a change
to your code; "Apply change" writes it.

<img src="docs/media/bugfix.webp" width="100%" alt="Claude reproduces a search bug and proposes a code change to server.mjs with an &quot;Apply change&quot; button">

The workbench comes with [themes](themes/README.md) (F7).

## Config

`caw.config.json` holds environments, sign-in and roles. `init` writes it for you:

```json
{
  "environments": {
    "local":   { "url": "http://localhost:5173", "claude": true, "writable": true },
    "staging": { "url": "https://staging.example.com" }
  },
  "signIn": { "type": "form", "path": "/login", "userSelector": "#email", "passwordSelector": "#password",
              "signedInSelector": "[data-testid=user-menu]" },
  "roles": { "tester": {} }
}
```

See [docs/configuration.md](docs/configuration.md).

## Data and privacy

**When Claude runs** (`record`, the chat, `--explain`), Claude Code sends to Anthropic what Claude works with: page contents
(accessibility snapshots, `eval` results, screenshots), console and network summaries, the project source it reads and your
chat messages. Your Claude Code account and its terms apply.

**Masked or blocked:** caw signs in itself; the role's password, one-time codes and values marked `secret: true` are replaced
with `••••` before Claude sees text. `caw/.env`, `.env*`, `caw/.auth` and typical key files are blocked for Claude (Claude Code
deny rules locally, hidden in the Docker container). Other secrets in project files Claude may read are not, and Claude sees
everything the test user sees in the app: use test accounts and test data. Details:
[Sandbox boundaries](docs/guide.md#sandbox-boundaries).

**Replays** (`run` without chat, CI) send nothing to any AI.

**No telemetry:** caw reports nothing anywhere. Its own network traffic goes to your environments and `allowHosts` and to what
the app's pages load themselves (scripts, fonts, analytics), plus package downloads when the Docker image is built; in the
Docker sandbox, Claude Code reaches only the Anthropic API (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).

**Run data** stays on your machine in `.caw/runs/<run>/`: report, `result.json`, screenshots, Claude's logs and `trace.zip`.
The trace contains page contents and network data including cookies; don't upload it or run folders publicly. `init` adds
`.caw/` to `.gitignore`.

## What caw is not

- An autonomous exploratory-testing agent: Claude follows your plan.
- A Playwright IDE: you don't write locators or code (`caw export` is the way out).
- A visual-diff, API, load or security testing tool: steps check content and state, not pixels.
- A cross-browser grid: Chromium only.
- A network-mocking framework: tests run against the real backend of the environment.
- Parallel: tests run one after another.

Other AI providers are not supported: recording, fixing and the chat need Claude Code; replays need no AI.

## FAQ

**Does every run cost tokens?**
No. Recording and the chat use Claude tokens, billed through your Claude Code account; replays use none, locally and in CI.
Before Claude starts, the chat asks once per run (not when your own Claude Code session is the agent); you can turn that
notice off. The run log shows the cost Claude Code reports.

**Does Claude see my passwords?**
No. caw signs in itself before Claude starts. Claude can't read `caw/.env` and only drives the browser through fixed
commands. Use test accounts anyway: Claude acts as that user.

**What happens when the UI changes?**
The step fails and the chat tells you why. If the change was intended, "Fix step" re-records that step; the rest of the test
stays as it is.

**My app signs in through SSO.**
Let caw fill the identity provider's form with `signIn.steps` (`init --explore-only` suggests them), or sign in once by hand
with `caw role login` and let caw reuse the stored session.

**My app has no sign-in.**
Leave `signIn` and `roles` out of the config. `init` does that for you when it finds no sign-in form.

**Is it Playwright?**
It uses Playwright to drive your installed Chrome, and recordings store Playwright locators. You don't write Playwright code;
`caw export` turns a test into one if you want to leave.

## Docs

- [Commands](docs/commands.md): every command and option, exit and error codes
- [Configuration](docs/configuration.md): `caw.config.json`, environments, sign-in, roles, `caw/.env`, `caw/caw.md`
- [Test files](docs/test-files.md): test plan and recording format, placeholders
- [Guide](docs/guide.md): agents, workbench, chat, failure assessment, sandbox
- Extensions: [overlay](docs/extensions/overlay.md) (local code on a deployed environment), [ExtJS](docs/extensions/extjs.md)
- [Themes](themes/README.md): built-in themes, own theme packages, `caw theme`

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Fonts and graphics: [NOTICE.md](NOTICE.md).
