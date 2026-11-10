English · [Deutsch](README.de.md)

# caw-ai

[![CI](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/caw-ai)](https://www.npmjs.com/package/caw-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **caw** – **c**onstrained **a**gentic **w**ebtester
>
> Integration tests for web apps, written in plain language. Claude records each test once; replays run without AI.
>
> *Constrained* because the agent has limits: Claude drives the browser only through a fixed set of commands, reaches only the hosts in your config, never sees your credentials, and every recording ends with a plan you approve.

![caw-ai replays a recorded test of a small todo app at phone width, without AI: the raven follows each step, then lands on the chat with a question](docs/media/demo.webp)

Each step describes an action and the expected result:

```yaml
# caw/tests/create-ticket.yaml
steps:
  - id: S2
    name: Create a ticket
    do: Create a new ticket "Printer offline {{runTag}}" for customer "Acme Corp" with priority "High".
    expect: A confirmation shows the number of the new ticket.
```

Record once, then replay:

```bash
npx caw-ai record create-ticket --target local   # Claude performs the steps in Chrome, you approve the result
npx caw-ai run create-ticket --target local      # replays the recording, without Claude
```

## How it works

- Tests are YAML files with steps in plain language. While recording, Claude performs each step in Chrome and stores the targets by role, label and text, not as CSS selectors.
- A replay uses only the recording. It is deterministic and uses no tokens, locally and in CI.
- If a step fails, the chat next to the app shows the cause. `fix` re-records only that step.
- Failures are classified as test, app or environment, based on requests, console output and the page changes seen during recording.
- Claude controls the browser through a fixed set of commands, reaches only the configured hosts and does not get the credentials.
- Supported: plain web apps, React, Vue, Angular and ExtJS.

## Prerequisites

- Node 22+ and Google Chrome on Windows or Linux (macOS untested)
- [Claude Code](https://claude.com/claude-code), for recording and fixing only
- Docker, only if Claude should run in a container (`--agent docker`)

## Install

```bash
npm i -D caw-ai
```

## Usage

Start your app, then:

```bash
npx caw-ai init --url http://localhost:5173   # opens the app; sign in once, press Enter
cp caw/.env.example caw/.env                  # add a test account
npx caw-ai doctor                             # lists what is still missing
```

Describe a test in `caw/tests/smoke.yaml`:

```yaml
id: smoke
app: web
role: tester
targets: [local]
mutates: false
steps:
  - id: S1
    name: Open the dashboard
    do: Open "Dashboard" in the navigation.
    expect: The dashboard is visible.
```

Record it once, replay it from then on:

```bash
npx caw-ai record smoke --target local
npx caw-ai run smoke --target local
```

[`examples/helpdesk`](examples/helpdesk) contains a small sample app with a test.

### Common commands

| Task | Command |
|---|---|
| Run a test | `caw-ai run <test> --target local` |
| Run it like CI | `caw-ai run <test> --target local --headless` |
| Record a new test | `caw-ai record <test> --target local` |
| Update one changed step | `caw-ai fix <test> S3 --target local` |
| Get the app into a state and keep coding there | `caw-ai run <test> --target local --until S3` |
| Open the app signed in, without a test | `caw-ai open --target local` |
| Test local code inside a deployed environment | `caw-ai run <test> --target dev --overlay` |
| Let Claude explain failures right away | `caw-ai run <test> --target local --advise` |
| Check config and tests | `caw-ai validate` |

Exit codes: `0` pass, `1` fail, `2` environment error, `3` invalid input, `4` needs recording. All commands and options: [docs/commands.md](docs/commands.md).

### In CI

```yaml
- run: npx caw-ai validate
- run: npx caw-ai run smoke --target staging --headless
```

With `CI` set there is no chat and Claude is not started. Record and fix locally, commit the files, replay in CI.

### From Claude Code

`init` also adds a skill and an MCP server. Then, in Claude Code:

```
/caw-ai record a test for creating a ticket
/caw-ai take me to the ticket detail page, I want to work on the status field
```

## Config

`caw.config.json` holds environments, login and roles. `init` writes it for you:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "auth": { "type": "form", "path": "/login", "userSelector": "#email", "passwordSelector": "#password",
            "signedInSelector": "[data-testid=user-menu]" },
  "apps": { "web": { "dir": ".", "startUrl": "/" } },
  "roles": { "tester": { "loginEnv": "CAW_LOGIN_TESTER", "passwordEnv": "CAW_PW_TESTER" } }
}
```

Login can be a form (with optional TOTP), HTTP Basic, or a stored session for SSO. See [docs/configuration.md](docs/configuration.md).

## FAQ

**Does every run cost tokens?**
No. Only `record`, `fix` and asking Claude in the chat do. Before Claude starts, the chat asks once per run; you can turn that notice off.

**Does Claude see my passwords?**
No. caw-ai signs in itself before Claude starts. Claude can't read `caw/.env` and only drives the browser through fixed commands. Use test accounts anyway: Claude acts as that user.

**What happens when the UI changes?**
The step fails and the chat tells you why. If the change was intended, "Fix step" re-records that step; the rest of the test stays as it is.

**My app has no login.**
Leave `auth` and `roles` out of the config. `init` does that for you when it finds no login form.

**Is it Playwright?**
It uses Playwright to drive your installed Chrome. You don't write Playwright code.

## Docs

- [Commands](docs/commands.md): every command and option, exit and error codes
- [Configuration](docs/configuration.md): `caw.config.json`, login types, `caw/.env`, `caw/caw.md`
- [Test files](docs/test-files.md): test plan and recording format, placeholders
- [Guide](docs/guide.md): agents, workbench, chat, failure assessment, sandbox

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Fonts and graphics: [NOTICE.md](NOTICE.md).
