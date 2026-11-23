English · [Deutsch](commands.de.md)

# Commands

Run every command from your project root: `npx caw <command>` (or `pnpm exec`, `yarn`). `<env>` is a name from `environments` in `caw.config.json`, e.g. `local`. Tenants are environments of their own (`extends`).

`--env` may be left out when the choice is clear: a test that fits exactly one environment takes it; otherwise, on your machine, the only environment among its candidates where the agent may work (for `record` of a new test, the only environment where the agent may work). In CI caw never guesses. The terminal names the choice, e.g. `Environment: local (the only one where Claude Code may work)`. If it is ambiguous, the command stops and lists the choices (exit 3).

| Command | What it does | Agent? |
|---|---|---|
| [`init`](#init) | Set up a project: look at the app, write config and `.mcp.json`; with `--explore-only` only suggest settings | no |
| [`doctor`](#doctor) | Check machine, config, credentials and environments | no |
| [`overlay`](extensions/overlay.md) | Extension: local code on a deployed environment (only with an `overlay` block) | no |
| [`validate`](#validate) | Check config and tests offline | no |
| [`audit`](#audit) | List what weakens the tests since a branch or commit, for the PR | no |
| [`bisect`](#bisect) | One step of `git bisect run`: find the commit that broke a test | no |
| [`list`](#list) | List tests and steps with their recording status | no |
| [`record`](#record) | Record a test or replace its recording, also from a step on | yes |
| [`run`](#run) | Replay a test, or several for CI | only if you ask |
| [`open`](#open) | Open the app with workbench and chat; with a test at its end or at the entry of a step | only if you ask |
| [`reproduce`](#reproduce) | The agent reproduces a bug report on its own: report and, when reproduced, a draft in `caw/drafts` | yes |
| [`design snapshot`](#design-snapshot) | The screen at a step's entry as a design page with the app's own stylesheets: the starting point for a draft | no |
| [`role`](#role) | List, add or remove roles and their test users; `role login` stores a session (SSO) | no |
| [`skill`](#skill) | Write or update the Claude Code skill `caw-attach` for your own session | no |
| [`export`](#export) | The recorded test as a Playwright test that runs without caw | no |
| [`mcp`](#mcp) | MCP server for your own Claude Code session (started by Claude Code, not in `--help`) | – |

`npx caw help` prints the same overview in the terminal. `npx caw <command> --help` (or `-h`, anywhere on the line) prints only that command, `npx caw agent --help` the agent commands. `npx caw --version` prints the version.

When a command stops, the terminal shows the reason first, then for an invalid call the command's short form, then the code and exit code:

```
✕ create-ticket@s2: a step goes after the test as <test>@S<n>, e.g. order@S3.
  Usage: caw record <test> [--env <name>] [--role <role>] [--headless]  or  caw record <test>@<S4> [--env <name>] [--agent local|docker | --attach [<key>]]
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
- `caw/tests/` for your test plans and `caw/caw.md` for notes the agent reads in every run
- `.claude/skills/caw-attach/SKILL.md`, the skill for your own Claude Code session (see [`skill`](#skill))
- `.gitignore` entries for `caw/.env`, `.caw/` and `caw/.auth/`

Anything it couldn't detect is set to `TODO`. `doctor` lists it, `validate` fails with exit 3 until it is filled in. Existing files are left alone.

| Option | |
|---|---|
| `--url <address>` | The app's address. Without it, `init` asks. |
| `--env <name>` | Name of the environment. Default: `local` on this machine, else the first part of the host name (`staging.example.com` → `staging`); a name that looks like production becomes `production: true`. |
| `--language <code>` | Team language for plans and the agent's texts. Default: the app's own language, asked. |
| `--login`, `--no-login` | Answer the sign-in question up front (scripts). |
| `--yes` | Don't wait for you to sign in, ask no questions. Good for apps without sign-in. With a sign-in nobody signs in: `signedInSelector` stays `TODO` and `start` stays `/` (or the path of `--url`). |
| `--from <file>` | Use an existing `--explore-only` result instead of opening the app. If `caw/.explore.json` exists, `init` uses it automatically. |
| `--no-mcp` | Don't touch `.mcp.json` and don't write the skill. |
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
npx caw doctor --attach
npx caw doctor --env staging
```

Checks Node, Chrome, Claude Code (agent `local`) or Docker and token (agent `docker`), or with `--attach` the caw entry in `.mcp.json` your own session needs, then the skill `caw-attach`, the config, `TODO` values, credentials per role and whether each environment answers. Every failed check comes with the next step. For an invalid config it shows the first finding; `validate` lists them all. Placeholder addresses (`example.com`, `.test`, `.invalid`) are reported, never contacted.

With the [overlay extension](extensions/overlay.md) and ExtJS parts, doctor adds optional lines about the local code server and the last `overlay check`.

## validate

```bash
npx caw validate
```

Checks `caw.config.json` and every file in `caw/tests/` without a browser or the agent. Errors name file and line, all of them at once. Use it in CI and pre-commit hooks.

`signIn` values still `TODO` fail validation (exit 3, code `config-invalid`): each one says what belongs there.

Per test and environment it prints which code runs there, e.g. `smoke (staging): deployed` or `smoke (local): dev server localhost:5173, your current version`.

## audit

```bash
npx caw audit origin/main
npx caw audit origin/main --json
```

No test gets weaker unnoticed. caw itself keeps a check as long as its expected result stays, but a chat button, adopted advice or a hand edit can still weaken a test. `audit` compares the test data (`caw/tests`, `caw/recordings`, `caw.config.json`, and the files under `caw/design` a step links) at the merge base of `<ref>` and `HEAD` with your working tree and prints the changes as Markdown in the team language, ready for a PR comment. No browser, no agent; it needs `git` on the `PATH` and, in CI, the history (`fetch-depth: 0`).

**Weakened** (exit 1):

- a check changed while its step's expected result stayed the same (matched by the expected result, like recording does: a step that only moved is fine)
- a test or a step removed; a test or recording file that can't be read (`validate` says why)
- the test runs on fewer environments (`environments`, also against the config's default)
- `retry` added or raised; a step's or an action's `timeoutMs` raised (above 30 s when it had none)
- an action made `optional`; an action removed from a step (the others kept in their order; a `wait-ready` taken out doesn't count)
- known messages added: by hand to `knownMessages`, or made known by a step that had a recording before (a step's first recording sets its baseline, listed for information)
- learned effects: a learned line removed while the step's expected result stayed (`effects-removed`; effects are learned over 5 runs and then frozen, caw never removes a line, so only a hand edit does), new console lines taken in (when `console` is in `effects.fail`), or the learned effects dropped altogether (they are learned anew); only while the step's actions stay the same, a step recorded anew learns its effects anew. A `wait-ready` added or taken out only renumbers the actions: each learned line is compared at its action's new number
- a step's target design (`design:`) taken off or swapped for another, or the linked file under `caw/design` changed or removed
- a learned look dropped from the recording while the step keeps `look: true` (only while the step's actions stay the same)
- config: `consoleIgnore`, `foreignCode`, `reads`, `visualIgnore` or `readyIgnore` entries added, `messageSelectors` watching less, `effects.fail` or `design.fail` narrowed, a guarded key changed (environment commands and flags, `lintCommand`, `sandboxImage`, `sandboxUser`, `browser.executablePath`, `agent.mode`)

**Changed** (listed, not a weakening): a changed expected result, with its check; new tests and steps; an action's target swapped while the step's actions and learned effects stayed (an adopted proposal for a renamed element, see [Guide](guide.md#renamed-targets)); learned effect lines replaced by new ones in the same list of an action, as when "Accept new effect" forgot them and five runs learned them anew (`effects-replaced`, with the old and new lines; a removal without new lines is a weakening). Changing the expected result is the way to change a check on purpose: the reviewer then sees both. **For information:** changed request baselines; messages newly known only from steps recorded for the first time (their baseline, `known-messages-baseline`: each step that made one known, by `known` in its recording, was committed before without a recording; every step of a test's first recording, or a pending step recorded now). **Decided outside the window:** where `.caw/runs` is kept (your machine, not CI), the answers since the merge base that changed something and were taken by caw itself in a run without a window (`auto`), by your session (`session`), by you in your session (`elicitation`) or by you at the terminal of `record --headless` (`terminal`): adopted, accepted, applied, used, promoted. They never change the exit code.

Exit `0` nothing weakened, `1` weakened, `3` the ref is unknown, has no common history with `HEAD` (`git-ref`), or there is no Git (`git-missing`). `--json` prints `{ ref, base, weakened, findings, decided }`, each finding with `id`, `kind`, `severity` (`weakening`, `listed`, `info`), `test` (`null` for the config), `step`, `before`, `after` and `text`; `decided` lists `run`, `test`, `decision`, `option` and `by`.

## bisect

```bash
git bisect start <bad> <good>
git bisect run npx -p caw-ai@<version> caw bisect <test> --env <env>
git bisect reset
```

Finds the commit that broke a test. `git bisect run` checks out one commit after another and calls `caw bisect` on each. It checks out `caw/` too, so the old commit's test would be another one or missing: the test, its recording and `caw.config.json` come from `--tests-from <ref>` (default `refs/bisect/bad`, the commit `git bisect start` was given as bad). The test must be recorded there; pending steps at its end are left out as in `run`.

On each commit `caw bisect` starts the environment with its `start` command (so it runs that commit's code), plays the test headless without chat and stops the environment again. It learns nothing, so the working tree stays clean for the next checkout, and learned effects fail no step: they were learned on another version of the app. Per commit it prints one line, e.g. `caw bisect 3f2a1c9: failed at S3, assessment app bug, exit 1 (bad)`.

| Exit | For git bisect | When |
|---|---|---|
| `0` | good | the test passed |
| `1` | bad | a step failed and caw puts it on the app |
| `125` | skip | a step failed on the environment, the test or unclear; the environment didn't start (e.g. the commit doesn't build); any other error |
| `128` | stops the bisect | the call, or the test or config at the ref, is invalid; the test isn't recorded there or changed after recording; the environment has no `start`, or it already answers before caw starts it (it could be any commit's build: stop it first) |

Run caw from a fixed install, as `npx -p caw-ai@<version>` does: the project's `node_modules` changes from commit to commit, and an old commit may have no caw or another version. `--step-timeout <duration>` limits each step (default 30s). Errors never end with exit 2, which `git bisect` would read as bad.

## list

```bash
npx caw list
npx caw list create-ticket
```

Without a test: one row per test with its targets, its recording status (`recorded`, `pending (S4, S5)`, `stale (S2, S3)`, `not recorded`) and whether it writes data. With a test: one line per step, e.g. `S2  Create a ticket  (stale)` or `S4  Export  (pending)`. [Pending](test-files.md#pending-steps) is the unrecorded tail after the last recorded step. No browser, no agent.

Drafts from [`reproduce`](#reproduce) in `caw/drafts` follow in a table of their own, with `red at S3 (run …)` once a run proved
they fail while the bug is there, else `recorded, not red yet`; with steps still pending the proof follows their state
(`pending (S5), red at S5 (run …)`). A design draft starts with `target design:`. `list <draft>` shows its steps like a test's.

Without `caw.config.json` it stops like every other command (`config-missing`). A test name that doesn't exist names the known tests and, for a typo, the closest one (`Did you mean create-ticket?`); `record <name>` is offered only for a new test. An unknown step names the test's steps (`Steps: S1–S6.`).

## record

```bash
npx caw record create-ticket --env local
```

Records a test plan from `caw/tests/create-ticket.yaml`, or creates a new test if the file doesn't exist. A draft from
[`reproduce`](#reproduce) (`caw/drafts/<id>.yaml`) records the same way and stays in its one file; its last step must fail
while the bug is there ([from the bug to a proven fix](guide.md#from-the-bug-to-a-proven-fix)). Chrome opens with the workbench and a chat:

1. You demonstrate the flow or, for a new test, describe it in the chat; for an existing test the agent can also follow the test plan.
2. The agent shows a plan in the chat. You approve it or ask for changes.
3. The agent walks the flow and checks each step.
4. caw replays the recording without the agent.
5. You choose "Adopt test plan". Only then are files written.

Runs only on environments where the agent may work (`"agent": true`). `--env` can be left out if there is only one.

| Option | |
|---|---|
| `--role <role>` | First recording only. Not needed if the config has one role. |
| `--read-only` | First recording only: the test doesn't write data (`writes: false`); if it does write while recording, it becomes `writes: true`. |
| `--overlay` | Only with the [overlay extension](extensions/overlay.md): local code over the deployed environment |
| `--start` | Start the environment with its `start` command if it doesn't answer, and stop it at the end ([lifecycle](configuration.md#starting-stopping-and-resetting-an-environment)). With `--overlay` also the parts' local code servers. Without it caw starts nothing and names the command. |
| `--reset` | Run the environment's `reset` before recording. |
| `--agent local\|docker` | Where caw starts its agent. Default: `agent.mode` from the config, else `local`. |
| `--attach [<key>]` | Your own Claude Code session answers instead, at no extra tokens, after `/caw-attach` there (see [the guide](guide.md#drive-it-from-claude-code)). Without `<key>` the only listening session; with several, name one by its key (`k7f2`) or the start of its session id. The window waits while none listens and says "not connected" when it goes. |
| `--agent-timeout <duration>` | Time limit for the agent, default `60m`. |
| `--max-actions <n>` | Limit on the agent's browser actions, default `maxActions` or 100. |
| `--step-timeout <duration>` | Time limit per step in the check run, default `30s`. |
| `--headless` | No window, for a test that has a plan; see [Without a window](#without-a-window). |

### Without a window

```bash
npx caw record create-ticket --env local --headless
```

Records a test that has a plan without a window and without a person, also in CI. The agent follows the plan; caw takes only what changes nothing the test checks: it approves the plan when it is the file's own (same steps and `writes`), adopts the recording when it records that plan with no changed expected result, no message newly known, no step removed, fixed or still stale and no hard error on the way (a step recorded for the first time sets its baseline, every step in a test's first recording, otherwise e.g. a pending step at the end: a newly known message seen only in such steps counts as known from then on, and `report.md` and `caw audit` name it; seen in a step that had a recording before, it is the person's), saves a draft's red proof, and closes cards that only say what happened. A writing test only runs on a `writable` environment anyway.

Anything else is a decision for a person. Started in a terminal (stdin and stdout a terminal, not CI), caw asks there: the decision's title, what it is about (with what would change: a changed expected result as before → after, the messages newly known) and its options numbered; Enter takes the option that ends it without changing anything, `revise` of a plan asks what should change. An attached session may answer the same decision through [`caw_decide`](#mcp) meanwhile; the first answer wins, and `result.json` and `report.md` log yours as `terminal`. Without a terminal (CI, started by a session) or when the terminal closes, the run stops there and writes nothing; the decision stays open, it is not logged as taken by caw. `result.json` names it as `openDecision` (its `id`, `context` and `options` with their gate), `report.md` under "Open decision", `caw_status` as `openDecision`; the command exits `5` and names the command to record with a window. Started from your session (`caw_start` with `headless`), the decision first waits up to 10 minutes for the person's consent through [`caw_decide`](#mcp). A new test (no plan) and `@<step>` are refused (exit 3): nobody would demonstrate or steer. The agent cannot ask anyone to show something, and no token notice is shown.

### From a step on

```bash
npx caw record create-ticket@S3 --env local
```

Re-records the test from S3 to the end. Use it when the app changed on purpose from there on, after you changed a step's text by hand, or to add steps at the end. S1 and S2 replay without the agent, then the agent follows the old plan from S3 while you steer in the chat; there is no demonstration. From S3 on the plan may change: the agent can add, remove, rename or reorder steps. The steps before S3 and their recordings stay exactly as they are; steps no longer in the plan are deleted when you adopt. Baselines and network effects from S3 on are learned again on the next healthy run. `@S1` records the whole test, like `record create-ticket`.

There is no check run first: if a step fails because of a bug in the app, find the cause with `run` instead. To repair just the one step that failed, use "Fix step" in the chat of a run. `--role` and `--read-only` don't apply here (exit 3): the test keeps its metadata.

## run

```bash
npx caw run create-ticket --env local
```

Replays the recording. No agent, no tokens. On environments where the agent may work (`agent`) the chat sits next to the app: if a step fails you can ask the agent for the cause or have the step fixed right there.

Outside CI every run learns the missing baselines of its passed steps into `caw/recordings/<test>.yaml`, headless as well as in the window, where the chat says which steps got them. Effects (five healthy runs) and looks (two) learn on this machine in `.caw/learning/<test>.json` and go into the recording once they freeze; until then each run prints the count (`Learning effects (kept in .caw/learning until frozen): S1 3/5.`), the freezing run names the file to review and commit. In CI (`CI` set) a run changes no file, unless you pass `--learn`. The first line says which environment, which team language and whether the run learns, e.g. `Mode on local (team language en): with chat; learns: yes, missing baselines into caw/recordings/create-ticket.yaml; effects and looks learn in .caw/learning and go into it once frozen.` At the end a run that learned says what changed, e.g. `Changed: caw/recordings/create-ticket.yaml (baselines S2, S5)`, or `Test file unchanged.` After a failure it prints the reason of the failed step (also with `--headless` and in CI) and the next commands: a run with chat to find the cause and `open <test>@<step>` up to the entry of the failed step. The report path is also printed as a `file://` link. In `report.md`, steps after the failed one are `skipped`, and screenshots link to the run's `agent/` folder. `result.json` lists every step under `steps`: its status (`pass`, `fail`, `skipped`), why it failed (`kind`: `check`, `effect`, `target`, `state`, `external`), its time in seconds, its requests and the effects of its actions with any deviation from the learned ones; on production without the effects, as they show visible names.

A test that ends in [pending steps](test-files.md#pending-steps) (written, not recorded yet) plays its recorded steps and passes without them: the terminal ends with `Pending, not recorded yet: S4, S5. They did not run. Record them: caw record <test>@S4 --env <env>`, `report.md` names them below the results, `result.json` lists them under `pending` and under `steps` with `status: "pending"`, the workbench marks them as not reached. When the first pending step has a target design, the run judges it at that step's entry and prints `Target design of S4 at its entry: met …` or `… not met yet (fails nothing): …` (`pendingDesign` in `result.json` and `caw_status`); the exit code stays. With `--strict` such a test stops before anything runs (exit 4, `replay-pending`). An unrecorded step before a recorded one, a step changed after recording and a test with nothing recorded stop with exit 4 as before.

| Option | |
|---|---|
| `--overlay` | Only with the [overlay extension](extensions/overlay.md): local code over the deployed environment |
| `--start` | As for `record`. |
| `--reset`, `--no-reset` | The environment's `reset` runs once before the first writing test; `--reset` before the first test, `--no-reset` never. |
| `--explain` | On errors or warnings the agent explains the cause without being asked. Costs tokens. |
| `--no-chat` | Visible window, no chat, no agent. Like CI. |
| `--headless` | No window, no chat. The recorded viewport (else 1920×1080). |
| `--learn` | In CI: learn missing baselines and effects from passed steps, as every run outside CI does anyway. Effects and looks count in `.caw/learning` until they freeze; one job alone never freezes them, so keep that folder between jobs (a CI cache) if CI is to learn them. |
| `--strict` | Pending steps fail the run with exit 4 instead of passing without them, e.g. for a release pipeline. |
| `--promote` | Only for a draft in `caw/drafts`: see [Promoting a draft](#promoting-a-draft). |
| `--step-timeout <duration>` | Time limit per step, default `30s`. |
| `--agent-timeout <duration>` | Time limit for the agent when it investigates or fixes, default `60m`. |
| `--max-actions <n>` | Limit on the agent's actions when fixing. |
| `--agent local\|docker`, `--attach [<key>]` | As for `record`. |

With `CI` set, `run` has no chat and never starts the agent, like `--no-chat`. `record` and `open` need a person and are rejected in CI (exit 3), since nobody would take over the browser. On runners without a display add `--headless` or use `xvfb-run`.

### Promoting a draft

```bash
npx caw run bug-search-finds-nothing --promote --env local
```

A draft from [`reproduce`](#reproduce) that was recorded red (its `red` field) and passes now becomes a test. caw runs the
draft; if it passes, every other test on the same environment (`run --all`); only when both are green does the test move to
`caw/tests` and `caw/recordings` (without `red`), the draft is deleted and the draft's run folder gets `fix-report.md`: red at
which step (run, commit), green in which run, the files changed since the red commit (`git diff --name-only` in the whole
repository plus untracked files inside the project folder, never an untracked folder such as a nested repository, plus a file
modified in the working tree at red (`red.dirty`) whose content changed since, and never such a file whose content is still the
same as at red; without
`caw/` and `.caw/`) and how many other tests passed. A test of the same name is never overwritten (exit 3).

A design draft (`origin: design`, see [Guide](guide.md#build-a-draft-test-first)) is promoted only with its target design met at
its red step, also when `design.fail` leaves out `target`, and its run folder gets `design-report.md` instead: red at which step
with the design not met and how many deviations the red run judged (run, commit), green in which run, the changed files and the
other tests.

Exit codes: `0` promoted, `1` the draft or another test did not pass (a design draft: or its design is not met), `4` the draft
is not fully recorded or was never shown red. `--promote` takes one draft, not with `--all`, `--report` or `--retry-env` (exit 3). Drafts are never part of `--all`.

### Several tests (CI)

```bash
npx caw run --all --env dev --headless --report junit=out/caw-junit.xml --report summary=out/summary.md --retry-env 1
npx caw run create-ticket close-ticket --env dev
```

Runs the tests one after another, without chat (`--explain` is rejected). `--all` takes every test that lists the target. Without `--env` the only target of the tests is used. A test that can't run (missing recording, typo) doesn't stop the others. At the end a table shows `PASS`, `FAIL`, `ERROR`, `NEEDS RECORDING` or `REJECTED` per test. The exit code is that of the worst run, in this order: `2` error > `1` fail > `4` needs recording > `3` rejected > `0` pass.

A test with pending steps passes and shows `S4–S5 pending` in the table (with `--strict` it is `NEEDS RECORDING`).

A failed step exits `1` whatever caw's assessment of it (app, environment, test, unclear): the assessment is a heuristic from the browser's evidence, so it types the reports and decides `--retry-env`, but never turns a failure into a pass or an error.

`--report <kind>=<file>` also writes the result to a file, once per kind and repeatable for several kinds. The file is relative to the project folder and must stay inside it; a path outside, also through a link, is refused before any test runs. A single test with `--report` or `--retry-env` takes the same path.

| Kind | Content |
|---|---|
| `junit=<file>` | JUnit XML. A pass with pending steps stays a passed test case and carries `S4–S5 pending` in `<system-out>`; `<skipped>` would count the whole test as skipped, though its recorded steps ran. A failed step is `<failure type="app\|environment\|test\|unclear" message="S3: <reason>">` with the assessment, its findings and the report path as text; anything else that didn't pass is `<error type="<error code>">` (e.g. `replay-missing`, `browser-closed`). A retried test lists every attempt in `<system-out>`. Warnings (`Warning S2: <text>`) and the steps still learning their effects (`Effects still learning: S1 2/5.`, plus `This run learned nothing (CI without --learn).`) go into `<system-out>` too; they change no result. |
| `summary=<file>` | Markdown, one line per test: result, failed step with its reason, assessment, first finding and report path; below the table one line per warning and per test still learning its effects. Made for a CI job summary: `cat out/summary.md >> "$GITHUB_STEP_SUMMARY"`. |
| `json=<file>` | For scripts: `target`, `startedAt`, `exit` and per test `id`, `status`, `exit`, `failedStep`, `reason`, `side`, `strength`, `findings`, `code` (as far as they apply), `steps` (`id`, `status`, `seconds`), `warnings` (`type`, `step`, `text`, `count`), `learning` (`learns`, `effects` with `id` and `runs`, `of`), `report` and `attempts`. |

`--retry-env <n>` (1 to 5) runs a test again when it failed on the environment: exit `2`, or exit `1` with the assessment `environment`. At most `n` more attempts; a failure the assessment puts on the app, the test or nothing clear is never repeated. The last attempt's result counts, every attempt stays in the reports, and the table, JUnit and the summary say e.g. `passed on attempt 2 (environment)`.

## open

```bash
npx caw open --env dev
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local
```

Opens the app with workbench and chat: navigate, try things, develop with the agent. Learns nothing and writes no test file.

- **Without a test** it opens the app's start page. If the environment has a form sign-in, you watch it in the app first, as the step "Sign in" under Preparation, then caw goes to the start page. Without `--env` it takes the only environment where the agent may work.
- **`open <test>`** replays the whole test first, then the window is yours.
- **`open <test>@S3`** stops at the entry of S3: S1 and S2 replay completely, of S3 only its navigation (`goto`, clicks, waiting for the page). Its inputs and its check stay open for you; the terminal says `Ready for S3 …: navigation done, inputs open`. If S3 has no inputs at all (e.g. only a submit click), none of S3 runs; if one of its clicks wrote data in earlier runs, it stops before that click; if S3 isn't recorded or is stale, none of it runs. The terminal names the reason. With S3 the first [pending step](test-files.md#pending-steps) this is where you build it; `open <test>@S4` behind a pending S3 is refused and names S3 (record it first), `open <test>` plays up to the last recorded step.

With a test, `open` signs in with the test's role and replays without the agent; the step it stops at isn't judged. It runs the code of the environment.

| Option | |
|---|---|
| `--role <role>` | Without a test only; not needed if the config has only one. A test brings its own. |
| `--start`, `--reset` | As for `run` (`reset` only with `--reset`). |
| `--step-timeout <duration>` | Time limit per step while replaying, default `30s`. |
| `--design` | With `@S3`: plays through S3 (a pending S3: up to its entry) and opens the comparison with its target design, a page over the workbench (F7 opens and closes it, Esc closes it): app and design at the recorded size side by side, overlaid or only their differences, the deviations as numbered cards that mark their element in both images; computed anew after F5, a reload and restoring the state. A missing design file is named in the chat. See [develop against a target design](guide.md#develop-against-a-target-design). |
| `--agent local\|docker`, `--attach [<key>]`, `--agent-timeout <duration>`, `--max-actions <n>` | As for `record`. |

After the handover, **F1** (or ⋯ → Open…, `/open` in the chat) in the workbench opens "Open…": any test for this environment, and optionally a step. Without a step the test runs to its last step; with a step it lands at that step's entry, like `open <test>@<step>`. caw starts a new session (cookies and site storage cleared), signs in with the account of the test's role and plays it in the same window, without the agent. With Basic auth only tests of your own role.

If restoring fails on something that does not always show up (a cookie banner already dismissed), ask in the chat: the agent can mark the click optional. What you accept goes into the test file right away. While recording, use `click <target> --optional`.

## reproduce

```bash
npx caw reproduce "After saving, the list still shows the old title." --env local
npx caw reproduce --file bug.md --from create-ticket@S3 --env local --headless
some-command-that-prints-the-ticket | npx caw reproduce - --env local
```

The agent reproduces a bug on its own, signed in as a test role: no plan to approve, nobody to answer, no decision. It reads and
operates the page like a person would and ends with a verdict: reproduced, not reproduced, or unclear. The run folder then holds
`report.md` (verdict, the bug report, what the agent observed and expected, its steps, the browser actions, screenshots, hard errors,
blocked or notable requests, a hint at the cause). When reproduced, `caw/drafts/<id>.yaml` holds a draft test in caw's format
made from the agent's steps, with the agent's browser actions and their locators in its `notes`. Nothing goes into `caw/tests`: review
the draft, record it red with `caw record <id>`, fix the bug, `caw run <id>` shows it green, and `caw run <id> --promote` makes
it a test ([from the bug to a proven fix](guide.md#from-the-bug-to-a-proven-fix)). With a window outside CI the chat offers
**Record red** once reproduced and then guides through the fix in the same process; the terminal output stays the same.

- **Where:** only on environments with `agent`, never on production (`reproduce-not-allowed`). Without `--env` the only such
  environment, or the test's with `--from`.
- **Writing:** only where the environment is `writable`. Elsewhere caw aborts every write request like on production, and
  the agent knows it may only read.
- **Never:** code changes, advice, changes to tests or the config. The browser reaches only the project's hosts (as whenever an
  agent can act in the window).
- **The role:** the test's with `--from`, otherwise `--role` or the only one. A missing test user stops with `credentials-missing`.

| Option | |
|---|---|
| `"<bug report>"`, `--file <file>`, `-` | The bug report: as the argument, from a file, or from stdin. Exactly one, at most 8000 characters. |
| `--from <test>[@<S4>]` | Start in a test's state: its steps (up to the entry of S4) replay without the agent first. |
| `--role <role>` | Without `--from`; not needed if the config has only one. |
| `--ref <id>` | An id from another tool, e.g. a ticket (`TCK-1234`): up to 64 letters, digits and `. _ # : / -`, otherwise exit 3. caw never looks it up; it stands in `report.md`, `result.json` (`reproduce.ref`), the draft's notes and `caw_reproductions`. |
| `--headless` | No window. With a window the workbench shows what the agent does; you can only watch or end it (Esc). |
| `--agent local\|docker`, `--attach [<key>]` | As for `record`. From your own Claude Code session (`caw_start` with `command: "reproduce"`) at no extra tokens. |

Exit codes: `0` reproduced, `1` not reproduced or unclear, `2` environment error (also when the starting state of `--from` was
not reached: `reproduce-state`), `3` invalid input.

## design snapshot

```bash
npx caw design snapshot create-ticket@S3 --env local
npx caw design snapshot create-ticket@S3 --env local --name ticket-form
```

The screen at the entry of S3 as a design page, the starting point for a draft in the app's own style
([a draft from the app](guide.md#develop-against-a-target-design)). caw plays the test headless to the entry of S3, as
`open create-ticket@S3` would, but without window, chat or learning, and writes:

- `caw/design/<name>.html` (default `<test>-S3`): the page's DOM without scripts, event handlers, frames' content and
  `<base>`; field values frozen into attributes (`value`, `checked`, `selected`, a textarea's text), never a password or a
  hidden field's value; the role's secrets redacted as in `result.json`; every animation and transition at its end; an open
  shadow root (a web component's) as declarative shadow DOM (`<template shadowrootmode="open">`) with its styles, frozen
  the same way (a closed one cannot be reached);
- `caw/design/assets/<name>/`: the app's stylesheets as files (`sheet-<n>.css`, from the page's CSSOM: rules a script
  inserted are kept, `@import` resolved in place; inline `<style>` stays in the page), and the fonts and images the
  stylesheets and the page reference (`<n>-<file>`), with `url()` rewritten relative. A file is stored when it comes from the
  app's origin or the page loaded it already; it is read with GET from the page itself, through the run's guards. An earlier
  snapshot of the same name is replaced, files it no longer needs go. A design a step links (`design:` in a test or draft) is
  what that step is judged against: a snapshot onto it is refused before anything runs, naming the steps, unless you say
  `--replace` (or choose another `--name`).

It only reads the app, and never runs on production: an environment with `production` is refused (`env-denied`), since the snapshot would put its real data into the repository. The terminal names what could not be kept (a stylesheet of another origin without
CORS, frames, a scrolled area that shows from the top in the snapshot). Rendered offline from `caw/design` it looks
like the app, and judged against the same state it is met with no deviation (measured on the errand example and on ExtJS 6.5
Modern with the Material theme). Data stays as the screen shows it; the [data rule](test-files.md#what-is-data) applies to
design and app alike. The snapshot holds the data of that state from the environment it ran on: take it on a development or test environment.

| Option | |
|---|---|
| `--name <name>` | The page's name under `caw/design`, plain segments (`ticket-form`, `screens/ticket`), not under `assets/`. |
| `--json` | The result as one JSON line: `ok`, `file`, `assets`, `files`, `notes`, `report` (or `reason`). |
| `--start`, `--overlay[=<parts>]`, `--step-timeout <duration>` | As for `run`. |

Exit codes: `0` written, `1` the way to the step failed (the report names the step), `2` the snapshot could not be written,
`3` invalid input. From your session: `caw_design` `{action: "snapshot", test, step, file?, env?}`.

## role

```bash
npx caw role                          # roles, whether a test user is set (never the values), tests per role
npx caw role list --json              # the same as one JSON line
npx caw role add clerk               # the role into the config, its variable names into caw/.env.example
npx caw role remove clerk             # only if no test uses it; caw/.env stays as it is
npx caw role login clerk --env dev    # signIn.type session: sign in by hand, store the session
```

A role is a test user. caw never asks for, reads from a page, writes or shows user names and passwords: you put them into `caw/.env` yourself (or set them as CI secrets), under `CAW_<ROLE>_USER` and `CAW_<ROLE>_PASSWORD` (`CAW_<ROLE>_TOTP` for one-time codes, `__<ENV>` for another account on one environment, see [configuration](configuration.md#roles)). `role add` writes the role (`{}`) to `caw.config.json`, the variable names without values to `caw/.env.example` and `caw/.env` to `.gitignore`, and names the variables to fill in. `role remove` takes the role out of the config and names the role's lines left in `caw/.env`; deleting them is up to you.

When `record`, `run` or `open` needs a role without a test user, it stops before Chrome or the agent start with `credentials-missing`, naming the variables. For `signIn.type: session` use `role login`: you sign in by hand and caw stores the session, never a password.

`role login` is for `signIn.type: session` (SSO, OAuth, MFA you can't automate). It opens Chrome on the sign-in and you sign in by hand. As soon as `signedInSelector` shows up, caw stores cookies and storage in `caw/.auth/<env>/<role>.json`. Run it again when the session expires.

## skill

```bash
npx caw skill                         # writes or updates .claude/skills/caw-attach/SKILL.md
```

Writes the Claude Code skill `caw-attach`, which `init` also writes with the MCP entry. It tells your session when and how to
attach to a caw window (`caw_attach`, the Monitor, `caw_start` with `open`): when you want to look at something in the app
together, have a bug reproduced with you, or type `/caw-attach`. Run it again after updating caw. A file there that caw did
not write stays as it is (exit 3, `skill-foreign`). `doctor` reports a missing or outdated skill as optional.

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

Started by Claude Code through `.mcp.json` (`claude mcp add caw --scope project -- npx caw-ai mcp`). You don't call it yourself. The server is named `caw`; on start it tells the session what caw is for and to read `caw_guide` first. It gives your session these tools:

| Tool | | Tokens |
|---|---|---|
| `caw_guide` | The guidance per topic (`topic`); without one the index. `overlay` and `extjs` only when the project uses them | no |
| `caw_doctor` | `doctor` as data (`agent`, `attach`, `env`) | no |
| `caw_init` | `mode: explore` (`url`, `login` or `yes`): the window, waits and returns the suggestions (`wait: false` only starts it); `mode: write` (`fromExplore`) and `mode: offline` write the files; `env`, `language`, `insecureTls`, `allowHttp`, `roles`, `noMcp` | no |
| `caw_role` | Roles as data (`list`), a new one in the config with its variable names (`add`, `name`; the human fills `caw/.env`), a saved session (`login`), `remove`; never user names or passwords | no |
| `caw_config` | Read the config, or change it validated (`patch`, `dryRun`). A patch that adds or removes the `overlay` block changes the tool list. Refused: commands (`start`, `stop`, `reset`, `ready`, `lintCommand`, overlay `start`), environment flags, `browser.executablePath`, `sandboxImage`, `sandboxUser`, `agent.mode`; the session edits those in the file, where you see the diff | no |
| `caw_validate` | `validate` as data; drafts from `caw/drafts` under `drafts` | no |
| `caw_list` | `list` as data; drafts under `drafts`, each with `red` (`{ step, run, head, dirty? }` or `null`) and, as in `caw_status`, `phase` and `next` (a design draft with `origin: design`) | no |
| `caw_reproductions` | The reproductions in `.caw/runs`, newest first: `runId`, `date`, `ref`, `status`, `reproduced`, `observed`, `expected`, `cause`, `covered`, `draft`, `phase`, `next`, `report`; `refs` (list) keeps those and names refs without a run as `missing` (never run, or pruned by `keepRuns`), `since` (ISO date) keeps newer runs | no |
| `caw_design` | Target designs under `caw/design`: `snapshot` runs `design snapshot` (`test`, `step`, `file`, `env`; onto a design a step links only with `personAsked: true`); `put` writes `design/<name>.html` after checking name, size and that it is an HTML page, with `stylesFrom` (a snapshot) its own stylesheets replaced by the snapshot's, and replaces a design a step links only with `personAsked: true`; `list` returns the design files and the steps that link them; `link` sets or removes one step's `design:` in `caw/tests/<test>.yaml`, or in the draft `caw/drafts/<test>.yaml` when there is no such test (with `personAsked: true`, only when the person asked) | no |
| `caw_overlay` | Only with an `overlay` block: `action: status` (`overlay status` in-process, fast), `check` or `apply` (`overlay check`, `--apply`; waits up to 3 minutes); `env`, `part` | no |
| `caw_attach` | Attach this session: returns its key and the command to start with the Monitor tool; every chat message and task of an attached window then reaches the session as a line. |
| `caw_start` | Start `run`, `record`, `open` or `reproduce` attached to this session (`--attach=<key>`) (`reproduce`: `bug`, `from`, `role`, `env`, `ref`, `headless`; `test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset`, or `args`; `step` for `record` and `open`, only with `test`; `promote` for `run` of a draft; `strict` for `run`; `design` for `open`). With `overlay` it checks the local code server first: `down`, `wrong-app` or `stale` returns `state`, `url`, `start` and `partDir` instead of starting; `moved` starts with `--overlay <foundUrl>`. Never `--start` together with `overlay`: the session starts the local code server itself after asking you. `start` and `reset` run the environment's configured commands | none beyond your session |
| `caw_status` | Is a run waiting for the session? Last lines of output; last run's result and artefacts as data; for a reproduction with a draft and a run of a draft its `phase` and `next` (a design draft with `origin: design` and the phases `draft`, `red`, `green`, `adopted`; `next.decision` names the window's card for that phase). A card the run waits for comes as `waiting.decision` (`id`, `context`, `options` each with `gate`, state `deciding`); the one a run without a window left open as `openDecision`. `wait` (up to 120 s) returns as soon as the run needs the session, ends or reports something new | no |
| `caw_decide` | Answers the waiting decision like a button: `decision`, `option`, `run` (default the last), `message` (only `revise` of `plan.approve`). A `free` option the session may answer; a `human` one only with the person's consent, asked as a form through the client (MCP elicitation), and refused with the way by hand when the client has none. The first answer wins, window or session; the window shows "answered by the session". The answer carries a proof only this MCP server can make; an answer file written any other way is ignored ([guide](guide.md#decisions-from-your-session)) | no |
| `caw` | The agent commands (`snapshot`, `click`, `plan`, `finish`, …) | in the run |
| `caw_selection` | The element you picked with `/element` in the workbench chat | no |

Results come as short text plus `structuredContent` (JSON). Every tool refuses fields it does not take.

## Agent commands

`caw agent <command>` with `snapshot`, `click`, `dblclick`, `hover`, `drag`, `dialog`, `fill`, `type`, `press`, `upload`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

These are the only way the agent can touch the browser. They exist for the agent during `record` and in the chat; you won't need them. `npx caw agent --help` lists their arguments.

## Exit codes

| Code | |
|---|---|
| `0` | pass |
| `1` | fail: a step didn't do what the test expects, whatever caw's assessment (app, environment, test, unclear); for `audit`: a test was weakened |
| `2` | error: the environment prevented a verdict (server down, login failed, Chrome missing, …), or an unexpected internal error (the stack is printed) |
| `3` | rejected: invalid call, config (also `TODO` values left from `init`) or test file. Nothing ran. |
| `4` | needs recording: the recording is missing (`record`), a step changed since it was recorded (`record <test>@<step>`), or `run --strict` met pending steps. Nothing ran. |
| `5` | a person decides: `record --headless` stopped at a decision it may not take (`openDecision`) and wrote nothing |

## Environment variables

| Variable | |
|---|---|
| `CAW_LANG` | `en` or `de`: your own language for caw's texts (CLI, workbench), instead of the team language (`language` in the config). The agent keeps writing plans in the team language. |
| `CAW_AI_HOME` | Folder for personal settings (`prefs.json`). Default `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` or `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API key from the Claude Console for the `docker` agent. `local` uses your Claude Code login; with `--attach` your own session works. |
| `CAW_AGENT_MODEL`, `CAW_CLAUDE_BUDGET` | Model and budget in US dollars for agent runs (`--model`, `--max-budget-usd`); override `agent.model` and `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Windows only: `windows` or `wsl` to pick the Docker route. |
| `CI` | Set: no chat, `docker` agent only; `record` and `open` are rejected. |
| `CAW_URL__<ENV>` | Another address for one environment in this process, e.g. a PR preview; never written to the config. See [configuration](configuration.md#url-override-for-pr-previews). |
| `NO_COLOR`, `FORCE_COLOR` | Terminal colors off or on. |
| `MCP_TOOL_TIMEOUT` | In Claude Code's environment: raise it if `plan` or `chat` time out in your session. |

## Error codes

When caw stops, or a run ends with `error`, it prints the reason and then the code.

| Code | Exit | Fix |
|---|---|---|
| `decision-needed` | 5 | `record --headless` stopped at the plan: the agent's plan is not the file's, so the person approves it. Record with a window, or answer through `caw_decide` with the person's consent |
| `usage`, `unknown-command` | 3 | `npx caw <command> --help` |
| `reproduce-not-allowed` | 3 | `reproduce` only on an environment with `agent`, never production |
| `reproduce-state` | 2 | The starting state of `--from` was not reached: `run` the test and fix it first |
| `config-missing` | 3 | `npx caw init --url <address>` |
| `config-invalid` | 3 | Fix the field named in the message or fill in the `TODO` values, then `doctor` |
| `url-override` | 3 | A `CAW_URL__<ENV>` variable names no environment, a production or agent environment, a production host or no valid origin: fix or unset it |
| `test-missing`, `test-invalid` | 3 | Create or fix the test file, then `validate` |
| `replay-missing` | 4 | `record` the test |
| `replay-stale` | 4 | A step changed since recording: `record <test>@<step>` |
| `replay-pending` | 4 | `run --strict` and the test ends in pending steps: `record <test>@<first pending step>` |
| `step-unknown` | 3 | Use a step ID from the test file (`list <test>`) |
| `env-invalid`, `env-denied` | 3 | Use an environment from the config; production can't be recorded |
| `host-blocked` | 3 | `goto` to a host that is no app host: add it to `allowHosts` if the app really navigates there. In a run the same block is a failure of the step |
| `env-certificate` | 2 | The environment's certificate is not trusted: for an internal certificate authority set `environments.<env>.insecureTls: true` |
| `write-protected` | 3 | Recording and writing tests need `agent` / `writable` on the environment |
| `git-missing`, `git-ref` | 3 | `audit`: install Git, run it inside the repository, name a ref Git knows; in CI fetch the history (`fetch-depth: 0`) |
| `skill-foreign` | 3 | `caw skill`: `.claude/skills/caw-attach/SKILL.md` exists and was not written by caw |
| `auth-missing` | 3 | No stored session, or it expired: `caw role login <role> --env <env>` (the message names it) |
| `credentials-missing` | 3 | Set the variables the message names in `caw/.env` or the environment (CI secrets); a new role first with `role add <role>` |
| `login-form-missing`, `login-failed` | 2 | Is the backend up? Are the `signIn` selectors or steps and the credentials right? |
| `env-unreachable` | 2 | Start the environment (or pass `--start` when it has a `start` command), check the URL |
| `browser-sandbox` | 2 | Chrome's sandbox cannot start (Linux as root, some containers): fix the machine, or knowingly set `browser.noSandbox: true` |
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
