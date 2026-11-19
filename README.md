English · [Deutsch](README.de.md)

# caw-ai

[![CI](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/caw-ai)](https://www.npmjs.com/package/caw-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> `caw` · *Context-Aware Web Testing*
>
> End-to-end regression tests for your own web app, written in plain language, recorded once with Claude, replayed without AI.
> Claude reproduces your bug reports, and the same tests take you to any state of your app to develop there.

- [Plain-language tests, replayed without AI](#plain-language-tests-replayed-without-ai)
- [Reproduce bugs](#reproduce-bugs)
- [Reach any state and develop](#reach-any-state-and-develop)
- [Triage and repair](#triage-and-repair)
- [Drive it from Claude Code](#drive-it-from-claude-code)
- [Safe with credentials and production](#safe-with-credentials-and-production)
- [Export to Playwright](#export-to-playwright)

## Plain-language tests, replayed without AI

You describe what a user does, step by step. You demonstrate it in your app, or Claude walks it for you; you approve the plan
and adopt the result. From then on the test replays with Playwright, locally and in CI: deterministic, fast, without tokens.

<img src="docs/media/demo.webp" width="100%" alt="caw records a test of the Errand example: the test is described in the chat, Claude proposes the test plan and works through it in the app; then caw replays the recording without AI and the plan is adopted">

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
npx caw run --all --env staging --headless --report junit=out/caw.xml   # in CI
```

A recording stores each target as a Playwright locator (role, name, label, text) next to the plan. A test runs on every
environment it fits (local dev server, staging, a CI stack caw starts itself), writing tests only where writing is allowed.
`caw record <test>@S3` re-records from S3 after an intended change. Details: [Guide](docs/guide.md#plain-language-tests-record-once-replay-without-ai).

## Reproduce bugs

Hand Claude a bug report. It signs in as a test role, walks the report on its own and tells you whether the bug is real:
yes, no or unclear, with what it observed against what was expected, the steps it took, screenshots and a hint at the cause
in your code. It also writes a draft test plan that fails while the bug is there, ready to adopt as a regression test.

<img src="docs/media/reproduce.webp" width="100%" alt="caw reproduce: Claude has walked a bug report in the Errand example; the end card says the bug is reproduced and names the report and the draft test">

```bash
npx caw reproduce "Searching for home finds nothing although todos are tagged #home." --env local
npx caw reproduce --file bug.md --from first-errand@S3 --env local --headless   # start in a test's state
```

No plan to approve and no question to you: Claude only investigates. It runs only on environments you allow Claude on, never
on production, only reads where the environment is not `writable`, and changes no code and no test. The report and the draft
stay in the run folder. Details: [Guide](docs/guide.md#reproducing-a-bug-reproduce).

## Reach any state and develop

`caw open <test>@S3` signs in with the test's role, replays up to the entry of S3 and hands you the window: its navigation
done, its inputs open. F1 ("Open…") picks any test and step of the environment, for any role.

<img src="docs/media/states.webp" width="100%" alt="The F1 dialog lists the test first-errand with its steps S1 to S4">

Pick an element in the app (`/element` in the chat) and ask about it: Claude reads your source code and answers with file
and line. Against your dev server, F5 loads your change.

<img src="docs/media/develop.webp" width="100%" alt="An element is picked in the app; Claude explains in the chat why &quot;Add todo&quot; is disabled, with server.mjs:134">

```bash
npx caw open first-errand@S3 --env local   # the state before S3, signed in, the window is yours
npx caw open --env local                   # the app signed in, without a test
```

Details: [Guide](docs/guide.md#reach-any-state-and-develop).

## Triage and repair

When a step breaks, caw tells you whether the test, the app or the environment is at fault, from the requests, console output
and page changes it saw while recording. No AI is needed for that. In the chat Claude finds the cause on request, "Fix step"
re-records only that step after an intended change, and a fix for the app comes as a code change you accept or reject: paste
a bug into the chat and "Apply change" writes Claude's fix.

<img src="docs/media/bugfix.webp" width="100%" alt="Claude reproduces a search bug and proposes a code change to server.mjs with an &quot;Apply change&quot; button">

```bash
npx caw run first-errand --env local --explain   # Claude explains a failure right away
npx caw record first-errand@S3 --env local       # re-record from S3 to the end
```

Details: [Guide](docs/guide.md#triage-and-repair).

## Drive it from Claude Code

Register caw as an MCP server of the project, then just ask Claude Code. Your session sets up the project, records, runs,
reproduces and takes you to a state, and is the agent itself at no extra tokens.

```bash
claude mcp add caw --scope project -- npx caw-ai mcp
```

```
set up caw for this project
record a test for creating a ticket
reproduce this bug: after saving, the list still shows the old title
take me to the ticket detail page, I want to work on the status field
```

On Windows (not WSL): `claude mcp add caw --scope project -- cmd /c npx caw-ai mcp`. `caw init` switches the entry to the
installed copy once caw is in `node_modules`. Details: [Guide](docs/guide.md#drive-it-from-claude-code).

## Safe with credentials and production

- **Test accounts stay yours:** you put them into `caw/.env` (or CI secrets) yourself. caw signs in, never asks for them and
  never writes them; Claude can't read the file, and the password is masked in everything Claude gets.
- **Production is read-only:** a run on production sends no write requests, and production hosts are unreachable from every
  other environment. Claude never works on production.
- **Claude stays in a box:** it drives the browser only through fixed commands, and while it is attached the browser reaches
  only your environments and the hosts you allow. Locally Claude Code gets only read tools, in Docker a firewall.

Sign-in: login forms, one-time codes, steps on an identity provider (e.g. Keycloak), HTTP Basic, stored sessions. What masking
can and cannot do: [Data and privacy](#data-and-privacy) and [Sandbox boundaries](docs/guide.md#sandbox-boundaries).

## Export to Playwright

`caw export <test>` writes the recorded test as a Playwright test that runs without caw, only with `@playwright/test`: the
recorded locators, one `test.step()` per step, sign-in included.

```bash
npx caw export first-errand --env local
npx playwright test -c caw/export/playwright
```

Details: [Commands](docs/commands.md#export).

## Prerequisites

- Node 22.4+ and Google Chrome (or another Chromium browser) on Windows or Linux (macOS untested)
- [Claude Code](https://claude.com/claude-code), for recording, reproducing and fixing only
- Docker, only if Claude should run in a container (`--agent docker`)

Works with plain web apps, React, Vue, Angular, Next.js, Nuxt and server-rendered multi-page apps.
Extensions add [ExtJS](docs/extensions/extjs.md) and [local code on deployed portals](docs/extensions/overlay.md).

### Claude access and costs

caw does not call Claude itself. It starts your own Claude Code (`--agent local`), works as a tool in your Claude Code session
(`--agent session`), or passes your own `ANTHROPIC_API_KEY` into the container at run time (`--agent docker`, API key only); it
never reads or stores it. Which terms apply depends on your account: Pro and Max plans are for personal use; for company
projects and CI use a Team or Enterprise plan or an API key from the Claude Console. Complying with Anthropic's terms is up to
you.

Claude only runs while recording, reproducing, fixing or when you ask in the chat; replays use no tokens. Usage is billed to
your account. To cap it, set a model and a budget per Claude run:

```json
"agent": { "model": "haiku", "maxBudgetUsd": 0.5 }
```

or for one run `CAW_CLAUDE_MODEL=haiku CAW_CLAUDE_BUDGET=0.5`. caw passes them to Claude Code as `--model` and
`--max-budget-usd`.

## Install and first test

```bash
npm i -D caw-ai
```

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
| Let Claude reproduce a bug report | `caw reproduce "<bug report>" --env local` |
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

Notes for Claude go into the project's `caw/caw.md` and into your own `caw.md` next to your personal settings, for every
project. See [docs/configuration.md](docs/configuration.md).

## Data and privacy

**When Claude runs** (`record`, `reproduce`, the chat, `--explain`), Claude Code sends to Anthropic what Claude works with: page
contents (accessibility snapshots, `eval` results, screenshots), console and network summaries, the project source it reads,
your notes in `caw.md` and your chat messages. Your Claude Code account and its terms apply.

**Masked or blocked:** caw signs in itself; the role's password, one-time codes and values marked `secret: true` are replaced
with `••••` in everything Claude gets (error messages, URLs and dialog texts too). That keeps a value from reaching Claude by
accident; a deliberately misbehaving agent can transform a value in the page with `eval` (split, encode) and read it past the
mask. `caw/.env`, `.env*`, `caw/.auth` and typical key files are blocked for Claude (Claude Code
deny rules locally, hidden in the Docker container). Other secrets in project files Claude may read are not, and Claude sees
everything the test user sees in the app: use test accounts and test data. Details:
[Sandbox boundaries](docs/guide.md#sandbox-boundaries).

**Replays** (`run` without chat, CI) send nothing to any AI.

**No telemetry:** caw reports nothing anywhere. Its own network traffic goes to your environments and `allowHosts` and to what
the app's pages load themselves (scripts, fonts, analytics), plus package downloads when the Docker image is built; in the
Docker sandbox, Claude Code reaches only the Anthropic API (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`).

**The browser is outside that firewall:** Chrome runs on your machine. While Claude is attached (record, reproduce, a run with
chat, `open`), every request of its pages goes only to your environments, `allowHosts` and `thirdPartyHosts`; anything else is
aborted and named in the run, so a page Claude drives cannot send what it sees elsewhere. Without Claude (replays, CI) pages
load from any host except production. Details: [Sandbox boundaries](docs/guide.md#sandbox-boundaries).

**Run data** stays on your machine in `.caw/runs/<run>/`: report, `result.json`, screenshots, Claude's logs and `trace.zip`.
The trace contains page contents and network data including cookies; don't upload it or run folders publicly. `init` adds
`.caw/` to `.gitignore`.

## What caw is not

- An autonomous exploratory-testing agent: Claude follows your plan or your bug report.
- A Playwright IDE: you don't write locators or code (`caw export` is the way out).
- A visual-diff, API, load or security testing tool: steps check content and state, not pixels.
- A cross-browser grid: Chromium only.
- A network-mocking framework: tests run against the real backend of the environment.
- Parallel: tests run one after another.

Other AI providers are not supported: recording, reproducing, fixing and the chat need Claude Code; replays need no AI.

## FAQ

**Does every run cost tokens?**
No. Recording, reproducing and the chat use Claude tokens, billed through your Claude Code account; replays use none, locally
and in CI. Before Claude starts, the chat asks once per run (not when your own Claude Code session is the agent); you can turn
that notice off. The run log shows the cost Claude Code reports.

**Does Claude see my passwords?**
Not by accident. caw signs in itself before Claude starts (and takes no commands while it signs in again), Claude can't
read `caw/.env` and only drives the browser through fixed commands, and the password is masked in everything Claude gets.
The mask is no defence against a deliberately misbehaving agent: with `eval` it can transform a value in the page. So use
test accounts: Claude acts as that user.

**Can `reproduce` break something?**
Only where you let Claude write: on an environment without `writable` every write request is blocked, production is never
allowed, and Claude changes neither code nor tests. The draft test goes into `caw/tests` only when you copy it there.

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

- [Guide](docs/guide.md): every feature in detail, agents, workbench, chat, failure assessment, sandbox
- [Commands](docs/commands.md): every command and option, exit and error codes
- [Configuration](docs/configuration.md): `caw.config.json`, environments, sign-in, roles, `caw/.env`, `caw.md`
- [Test files](docs/test-files.md): test plan and recording format, placeholders
- Extensions: [overlay](docs/extensions/overlay.md) (local code on a deployed environment), [ExtJS](docs/extensions/extjs.md)

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). Fonts and graphics: [NOTICE.md](NOTICE.md).
