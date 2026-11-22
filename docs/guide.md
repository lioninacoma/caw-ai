English · [Deutsch](guide.de.md)

# Guide

How caw works in detail. For quick lookup see [Commands](commands.md), [Configuration](configuration.md) and [Test files](test-files.md).

**Chapters:**

1. [How caw judges a step](#how-caw-judges-a-step)
2. [Expectations and target designs](#expectations-and-target-designs)
3. [Plain-language tests: record once, replay without AI](#plain-language-tests-record-once-replay-without-ai)
4. [Triage and repair](#triage-and-repair)
5. [In CI](#in-ci)
6. [Reproducing a bug: `reproduce`](#reproducing-a-bug-reproduce)
7. [Reach any state and develop](#reach-any-state-and-develop)
8. [The agent's box](#the-agents-box)
9. [Visual checks](#visual-checks)
10. [Monitoring production](#monitoring-production)
11. [Drive it from Claude Code](#drive-it-from-claude-code)
12. [Export to Playwright](#export-to-playwright)
13. [More](#more)
14. [Appendix: workbench, console and report page](#appendix-workbench-console-and-report-page)

## How caw judges a step

A test is a list of steps in plain language. Each step says what to do and what should then be true. caw judges every step by the same rules, without AI, in every run.

### A step and its hash

A step has an `id`, a `name`, what to do (`do`), one expected result (`expect`) and an optional `note`. Its recording keeps a hash over `name`, `do`, `expect` and `note`. Change one of them and that step is outdated: `run` stops with exit 4 and names `caw record <test>@<step>`. Everything else stays outside the hash: `retry`, `design`, `needs`, `look`, the test's `notes`, `role`, `writes`, `environments`, `start` and `caw/caw.md`. Changing those never makes a step outdated ([Test files](test-files.md#what-invalidates-a-recording)).

### One expectation, one check

Each step has one expected result, and its recording has one check for it: an expression that must hold on the page at the end of the step. A recording is saved only when every step has a passed check with no action after it. Other findings can fail a step too: hard errors, learned effects, a target design, a look. None of them turns a failed check into a pass.

The rule for checks: **while a step's expected result stays the same, its check stays the same.** It holds when a step is fixed, when a test is recorded again from a step, and when a whole test is recorded again, also when the step moved to another position. An agent that brings a new check for an unchanged expected result is rejected when it finishes. Rewording `name`, `do` or `note` alone keeps the check. To change a check on purpose, change the expected result: the decision shows it, and [`caw audit`](#no-test-gets-weaker-unnoticed-audit) lists it.

### Who may change what

| Who | What | How |
|---|---|---|
| You | The test plan: steps with `name`, `do`, `expect`, `note` and `retry`, the test's `notes`, `role`, `writes` and `environments`. Only you write `design`, `needs` and `look`. | By hand in `caw/tests`, or by approving a plan, adopting a recording, accepting advice, clicking "Accept new effect", "Adopt new look" or "Use …" |
| The agent | The recording of the approved plan: per step its actions and one check. It proposes plans and advice; you decide. | Only through caw's fixed commands. A plan with `design`, `needs` or `look` is refused, and so is a new check for an unchanged expected result |
| caw | What it learns from healthy runs: request baselines, effects per action and looks (`look: true`). Also the hash, the run tag and dates as placeholders, and a draft's red proof. | Without AI, in the recording file. Learned values never overwrite your plan |

### Effects and baselines

After each action caw measures its effect: the state of the controls, the requests answered, the shape of JSON responses and console messages. It learns the effects over the first five healthy runs, keeping only what was equal in all of them, and then freezes them: no run changes them any more, only "Accept new effect" or deleting `effects` does. Per step it also keeps a baseline of the requests: name, duration and parameter names, never values.

Effects and baselines are learned only on the environment the test was recorded on (`recordedOn`), by runs outside CI (in CI only with `--learn`), and compared on every environment. A look (`look: true`) is learned the same way: its style lines over two passed runs ([Visual regression](#visual-regression)). Details: [Effect per action](#effect-per-action).

### The assessment: app, environment, test or unclear

When a step fails, caw names the side that is likely at fault, from what the browser saw: the requests against the baseline, hard errors, a lost sign-in, deviating effects. The side is `app` (the application), `environment` (a slow or missing server, a lost sign-in), `test` (a target missing on an otherwise unremarkable page) or `unclear`. It is a heuristic: it types the reports and decides a retry with `--retry-env`, but it never turns a failure into a pass, and a failed step exits 1 whatever it says. Details: [Assessment](#assessment-test-application-or-environment).

### When the UI changes

- **Intended change, same expectation**, e.g. a renamed button: fix the step ("Fix step" in the chat or `caw record <test>@S3`). The check stays as it is; the agent only finds the new way. For a renamed target caw may already propose the new one with proof ("Use …", [Renamed targets](#renamed-targets)). A changed look is taken over with "Adopt new look", a changed effect with "Accept new effect".
- **Intended change of behaviour:** change the step's `expect` yourself. The step is then outdated, the agent records a new check for it, and `caw audit` lists the change.
- **The assessment points to the app:** find the cause before you change anything. An adjusted test would only hide the bug. That is why "Let Claude Code find the cause" is then the main button, and "Fix step" comes second, with that warning.

## Expectations and target designs

The test plan can come before the screen. You write what a step should do and what should then be true; caw tells you what is still missing.

### Pending steps

Steps you write at the end of a test without recording them yet are pending. `run` plays the recorded steps and passes. The terminal, `report.md`, `result.json` and `list` (`pending (S4, S5)`) name the pending ones, and `run --all` counts the test as passed. `run --strict` exits 4 while anything is pending. `open <test>@S4` with S4 the first pending step hands you the window at its entry. Only the tail counts: an unrecorded step before a recorded one, a step changed after recording and a test with nothing recorded still exit 4. Details: [Test files](test-files.md#pending-steps).

### Develop against a target design

The test plan can be the spec before the screen exists. Write the next steps at the end of the test (they stay [pending](test-files.md#pending-steps)) and give a step the screen it should end on: `design: design/order-form.html`, and `needs:` with the locators that must be there before it can be recorded. The design usually comes from a Claude Design artifact or a Figma export: ask your Claude Code session to fetch it; it writes it with `caw_design` into `caw/design` and links it to the step when you ask. caw never fetches anything itself.

Each run then judges the design without AI, after the step's check passed: the controls, headings, labels and a few styles per control of the rendered design against the app's page ([details](test-files.md#target-design)). Not met, the step fails with kind `design`, and the chat offers to have it built by your attached session, to open the step with its design (**Open with design**, the window of `caw open <test>@S4 --design` in the same process) or to close, never to fix the step: the test is right, the screen is not built yet. When the first pending step's `needs` are all on the page, the run says it is ready to record: `caw record <test>@S4 --env <env>`.

To see where the screen is off, open the step with its design:

```bash
caw open <test>@S4 --design --env local
```

It plays through S4 (a pending S4: up to its entry) and shows the design beside the app, both at the recorded size and the same scale (a pending step has none of its own: the chat names the step whose size it is). Side by side, text that is data (a long run tag, a name) cannot shift anything. **F7** goes round the views: beside the app, over the app half transparent (pixel for pixel), hidden, beside again; the view stays across reloads. Below it the deviations are listed: missing controls and differing styles. They are listed anew after F5, a reload of the window and **Open again** (or a state picked with F1), so they always belong to the page you see; a design file that is missing is named in the chat with its step. The window judges neither the test nor the design: the terminal says it replayed up to S4 to show the design, not that the test passed.

## Plain-language tests: record once, replay without AI

A test is a plan in plain language. You or the agent walk it once in the browser; caw stores what was done and replays it from then on without AI, locally and in CI.

### Three modes

| Command | What happens | AI and chat | Environment |
|---|---|---|---|
| `record <test> --env <env>` | Record a new test plan or replace one | always | only environments with `agent` |
| `run <test> --env <env>` | Test run by plan | On environments with `agent` the chat sits alongside from the start; the agent only after your message, your click on "Let Claude Code find the cause" or "Fix step", or with `--explain` | all |
| `record <test>@S4 --env <env>` | Re-record from S4 to the end. S1 to S3 replay without the agent, then the agent follows the old plan from S4 on; there is no check run first, so look for causes with `run` | always | only environments with `agent` |

`open --env <env>` opens the app signed in, with workbench and chat but without a test, see [Commands](commands.md#open). `open <test>` replays a test first, `open <test>@S4` stops at the entry of S4, see [Reaching a state and taking over](#reaching-a-state-and-taking-over).

`<env>` is a name from `environments`, e.g. `local`. Tenants are environments of their own (`extends`).

**Test plan** means one YAML file per test under `caw/tests/<test>.yaml`. It holds the test steps; their recording is in `caw/recordings/<test>.yaml`, see [Test files](test-files.md).

```bash
# New test: demonstrate, approve the plan, adopt at the end
# (--role can be omitted if caw.config.json has only one role)
caw record bestellung --env local --role kunde

# Test without AI
caw run bestellung --env local

# Test; on errors or warnings the agent advises in the chat (costs tokens)
caw run bestellung --env local --explain

# Test without chat as in CI, with or without a visible window
caw run bestellung --env local --no-chat
caw run bestellung --env local --headless

# Up to the entry of S4 (S1 to S3 done, its inputs open) and keep working on local code there
caw open bestellung@S4 --env local

# Re-record from S4 to the end
caw record bestellung@S4 --env local
```

In Claude Code one sentence is enough: "take me to where the cart is filled". The session finds test and step and starts `open`. If nothing fits, it suggests `record`.

### Recording a test plan: `record`

You name the role only the first time; the tool writes `role` and `writes` (`true` unless `--read-only`), never `environments`. A re-recording keeps them. Claude Code or Docker, token and image are checked up front so your demonstration isn't wasted.

1. **Start.** Chrome and the chat open, you are signed in. For a new test the chat asks: "Show it myself" or "Describe it, Claude Code records". Describing means writing in the chat what the test should do; you may go to the page a sentence is about, and each message keeps the page it was written on; the chat confirms it with its number (H1, H2 …) as the approval card shows it. Clicks are not recorded, "Hand over to Claude Code" ends it, and the agent finds the way itself. For an existing test the chat asks: "Show it myself" or "Claude Code follows the test plan".
2. **Plan.** The agent presents the draft as a card in the chat: per test step ID, title, action and one expected result, plus notes on assumptions and open questions. The plan is the future test file without recording: YAML with `notes` and `steps`. Metadata or recordings the agent puts there are discarded by the tool. You approve or write what should change, and the agent presents a new version. Until approval the host rejects every action in the application with `plan-required`; reading is allowed.
3. **Execute.** The agent walks the path in a fresh browser. You can pause, write, mark elements and click. If the path changes fundamentally, the agent presents a new version. All actions since the last check belong to the plan's next step, so the agent must check in that order (`step-order`).
4. **Clean up.** The agent goes through the actions on its own and states in the chat what will be dropped, without needing your approval. The tool itself removes screenshots and the first of two `fill`s on the same field.
5. **Check run.** The tool replays the recording without the agent; the chat shows progress. If a step fails, the chat offers to fix it, even in the not-yet-adopted draft.
6. **Replace.** The chat shows a "Check run passed" card with what would be adopted; warnings and actions picked by position can be expanded. Then "Adopt test plan (N steps)" or "Discard draft", which a second click confirms. Only then is the test file written. Steps whose screen showed no data from the server and no lists come with a checkbox, none ticked: tick those that really show fixed data, and adopting gives them `look: true` ([visual regression](#visual-regression)). If the check run doesn't pass, the old test plan stays untouched; plan (`plan.yaml`) and draft (`test-draft.yaml`) remain in the run folder. Nothing is committed automatically.

**Test data:** Runs with `writes: true` leave data behind: one record each from the agent and from the check run, up to two more per fix. Whatever the agent dropped also happened in the application.

#### What goes into the recording

- **Recorded:** successful `click`, `fill`, `type`, `press`, `goto`, `reload`, `wait-ready`, `remember` and `check`. Failed attempts, `eval` and `snapshot` are left out.
- **Completeness:** Saved only if every step has a passed `check` with no action after it. Otherwise the output names what's missing and the run ends with `fail`.
- **Stable targets:** Instead of references, the file stores how a human finds the element, as a Playwright locator: role and full name, label or text, scoped to the dialog or row around it, e.g. `getByRole('dialog', { name: 'Neue Bestellung' }).getByRole('button', { name: 'Senden', exact: true })`; for ExtJS components without a role also `locator('extjs=…')` ([ExtJS](extensions/extjs.md)). List entries are thus tied to their text; if the data changes, the step fails.
- **Detours:** On submitting, the agent names what doesn't belong to the path (`"omit": [12, "14-16"]`). If all steps passed, `omit` is required, even empty, and the rejection shows the agent the full action list. Checks and `remember` can't be dropped. The report lists everything dropped. If the agent misses a detour, it stays in. The check run proves the path works, not that it is the shortest: review the file before committing, because its expressions later run in the signed-in page without the agent.
- **Run tag:** Each run has its own `runTag`, e.g. `CAW-20261105185233`. The agent writes it into free-text fields that identify a record. The recording stores `{{runTag}}`, and every replay substitutes its own value, so a run finds its own record instead of an earlier one. If the application turns the name into a lowercase address (`/akten/akte-caw-20261105185233`), it stores `{{runTagLower}}`.
- **Dates relative to today:** A date at most 60 days before or after the recording day (in the browser locale's format or `YYYY-MM-DD`) is stored as `{{date}}`, `{{date+7}}` or `{{isoDate-1}}`; `{{date}}` writes the date the way the locale does (`de-DE` 23.11.2026, `en-US` 11/23/2026). Replay substitutes the date of its own day, so a test doesn't fail the next day on "date is in the past". Dates further away stay fixed.
- **Values from the run:** An order number is new in every run. The agent reads it with `remember bestellnr "<expression>"`; the recording then stores `{{bestellnr}}` with the expression, and replay reads the value from the page again. The command rejects an empty value.
- **Project context across tests:** `caw/caw.md` is to the tests what CLAUDE.md is to Claude Code: relevant project information and quirks of the applications. You maintain it by hand and check it in, e.g. "search remembers the last input". The agent gets it in every run in which it works. The file isn't part of the step hash, so changing it invalidates no recording. If a note affects the path, re-record. Behavior only, no personal data.

**Limits:**

- **The agent can write while exploring.** There is deliberately no write lock: in many applications submitting and follow-up steps depend on each other, and reading and writing requests often look the same at the HTTP level. Instead: recording only on environments with `agent` and only with test accounts, the guide rule "own records only", plan approval, the step budget, and the report lists under "Write requests" every write request to the app's hosts, by name without parameter values. A request is a read if it is GET, HEAD or OPTIONS, a GraphQL query, or matches a `reads` pattern; sign-in, sign-out, session and token (paths ending in login, logout, session, token, auth, refresh, csrf and similar) don't count; everything else writes. Requests to sign-in services in `allowHosts` and to third-party hosts (analytics, CDNs) never make a test a writing one.
- **Step budget:** `--max-actions` (else `maxActions` from the config, else 100) counts the agent's `click`, `fill`, `type`, `press`, `goto` and `reload`, failed ones included. What you demonstrate yourself doesn't count.
- **The agent doesn't react instantly:** `claude -p` runs without input; message and pause take effect before the next action. "Cancel" takes effect immediately.

### Test run: `run`

Replays the recording without model, Docker or token. On environments with `agent` the chat sits next to the window from the start, except in CI (variable `CI` set), with `--no-chat` or `--headless`. The first terminal line states the mode and whether the run learns baselines (every run outside CI, in CI only with `--learn`), the last one what changed in the test files. The chat shows each action (`S3 · 4/12 click …`) including retries; input is locked. If the run passes, the chat reports it along with warnings and doesn't wait; it closes with the run or, with [`open <test>`](#reaching-a-state-and-taking-over), stays next to the handed-over window. If a step fails, see [Fixing a step](#fixing-a-step). If the recording is missing entirely, it ends with exit 4 and names `record`. If a step is outdated, it ends with exit 4 and names `record <test>@<step>` to re-record from that step.

- **Waiting:** There are no fixed pauses. A step waits until its target is visible and not covered. That covers load masks, overlays and dialogs within dialogs, since only the topmost dialog is clickable. `check` retries until it holds or the time limit expires.
- **Time limits:** 30 seconds per step by default, changeable with `--step-timeout` (e.g. `--step-timeout 45s`), or by hand per action with `timeoutMs` and per check with `recording.timeoutMs` in the test file. If the agent clarifies or fixes from within the run, `--agent-timeout <duration>` (default 60m) and `--max-actions <n>` apply as for `record`.
- **Errors:** If a step fails, the report names the test step with its action and points to a screenshot. Cleanup steps like "Cancel" then no longer run; a created record may stay open.
- **Failures:** Console errors, script errors, failed requests and HTTP status 500 and above stop replay at the next step. So do visible dialogs, error messages and messages from `messageSelectors` that didn't occur during recording (numbers in the text don't count). With the `web` adapter a status notice (`role=status`, `aria-live=polite`, e.g. a success toast) is not a failure: it appears or not depending on timing; an unknown one appears once as a warning in the report. A dialog with input fields is interaction, not a message. Also: lost login, an application that didn't load (`extjs`: no ExtJS on the page), a stuck load mask (`aria-busy`, with `extjs` the load mask), a different page than recorded, and every unmet `check`.
- **Fixing:** If a step fails, see [Fixing a step](#fixing-a-step).
- **Without chat:** `--no-chat` replays in a visible window as in CI, without chat and without the agent: report, screenshot, a hint to run with chat to find the cause (`record <test>@<step>` only for an intended change), exit code. `--headless` likewise, but without a window, at the recorded viewport (else 1920×1080). Neither works with `--explain` (exit 3). Whether an application accepts headless mode only shows in the run; otherwise use `--no-chat`.
- **Limits:** Only what was recorded is replayed. The agent's eye for anything odd is missing, and write protection and host lock apply here too. Toasts that disappear between two steps are not seen by replay.

### What a run does

A run with the agent, i.e. recording and fixing, does the following:

1. **Reject what must not run:** config, test file, target and write protection are checked; for the `local` agent also whether Claude Code is present.
2. **Image** (`docker` only): built once from the project's image plus the agent and the container part of the tool. Rebuilt only when these change.
3. **Open:** start Chrome, sign in, open the page and wait until the app has loaded (with the [overlay extension](extensions/overlay.md) also check the local code). Failures here yield `error` without spending tokens.
4. **Start the agent:** With `local`, `claude -p` starts on your machine with the locked-down tools (see [Sandbox boundaries](#sandbox-boundaries)); with `session` the run waits for your session. With `docker` the container starts (`docker run --rm`): set the firewall, then the container drops all privileges. If the sandbox isn't provably sealed, the agent doesn't run.
5. **Test:** `claude -p` works through the plan; every browser command goes to the host as a file over the channel. The host checks the verdict.
6. **Finish:** The agent ends immediately with the verdict (process or container). Report, trace and `floats.log` (clicks and, with `extjs`, the order of floating windows with timings, no content) are under `.caw/runs/<run>/`. The trace (`trace.zip`) contains page content, requests and cookies of the test account; don't share it. With `signIn.type: basic` it records no snapshots, so the password from the Authorization header doesn't end up in it. Signing in again during a run (restoring a state) pauses the trace: the part before is kept as `trace-1.zip`, `trace-2.zip` …, and no sign-in form or request is in any of them. Screenshots and `claude.log` are under `agent/`. The log is written continuously and shows the agent's text and commands with seconds since start; the same lines appear in the terminal. A closing summary after the verdict is not included. Terminal output is colored, the file has no color codes; `NO_COLOR=1` turns colors off. Chrome closes as well.

Exit codes: `0` pass, `1` fail, `2` error (the environment is to blame), `3` input rejected, `4` needs recording (`record`), `5` a person decides (`record --headless` stopped at a decision it may not take).

#### Error codes and remedies

All error codes with fixes: [Commands › Error codes](commands.md#error-codes).

## Triage and repair

When a step fails, caw classifies the failure without AI; the agent explains it on request, re-records a step or proposes a code change.

### Assessment: test, application or environment

If a step fails, the tool classifies the failure without the agent and without tokens. It uses only what every browser provides, independent of framework and environment:

- **Requests** of the application (`xhr`/`fetch`) with name, status, duration and outcome: answered, HTTP error, aborted, failed. The name is method and path, for GraphQL plus operation type and name; parameter values never appear in it, except for parameters from `requestKeys`. An abort caused by navigation doesn't count. Plus the **parameter names** without values, from the query, form bodies (`application/x-www-form-urlencoded`) and the top level of JSON bodies (as `json.<key>`).
- **Hard errors** of the run: script errors, console errors, HTTP status.
- **The baseline from recording:** `recording.network` stores per step which requests were answered during recording, how long they took and with which parameter names (`params`).

| Finding | Assessment |
|---|---|
| Request aborts early without navigation (under 1 s or a fifth of its recorded duration), HTTP 500+, script error | Application, clear |
| A failing request sends different parameter names than during recording ("now missing `a`, new `b`") | Application, clear |
| HTTP 4xx, console error, a recorded request no longer occurs, different parameter names on an answered request | Application, likely |
| Login lost | Environment, clear |
| Request much slower than during recording (over 5 s and three times as long), network error, late abort | Environment, likely |
| Target missing on an otherwise unremarkable page | Test or test data, likely |

The strongest finding decides; the others are listed below it. Without notable evidence it stays "unclear". The assessment appears in the chat, as the "Assessment" section in `report.md` with a table of requests next to the recorded ones, in `result.json` and in the agent's task (`diagnosis`, `evidence`). The agent reads it there first and can fetch the latest requests with `network`.

Without `recording.network` the report says so. The baseline is never created while recording or fixing: under the agent's control misclicks and detours also run, which are dropped from the recording, and their requests didn't belong to the step. It is created without the agent and tokens by the next `run` outside CI (in CI by `run --learn`), from the cleaned-up recording: every passed step without a baseline then gets one from this run, if it was recorded on the same environment. The same goes for the effect per action. Chat and terminal name the steps; only this field changes in the file, the hash stays untouched. A `run` never overwrites existing values, unless they date from before parameter names (entries without `params`). Otherwise a run changes no file.

#### Effect per action

Every action (click, input, key) has an effect on the page. The tool measures it after each action once the page is idle, and stores it in `recording.effects`. The effect is the difference between before and after, without values:

| List | Content | Example |
|---|---|---|
| `controls` | State of visible controls: disabled, required, read-only, invalid, checked, expanded, selected, empty/filled. Elements in list and table rows don't count, since they are data, often someone else's. For a list only whether it has rows counts. | `+ input "Lieferadresse*" empty`, `+ list "Bestellungen" rows` |
| `requests` | answered requests of the action with status | `GET /api/orders 200` |
| `responses` | shape of JSON responses (key paths as a short hash) and domain error markers such as `success=false` | `GET /… form 3fa2c… success=true` |
| `console` | console messages | `error: Bestellung laden fehlgeschlagen` |

Numbers become `#`, so order numbers and dates don't interfere.

**Learning:** A passed `run` outside CI (in CI `run --learn`) records the effect. The first five healthy runs are reconciled: only what was equal in all of them is kept; the console collects everything that occurred. A line every earlier run saw and this one didn't is dropped, and the run names it in the terminal and in `report.md` ("Dropped while learning effects"): flicker, or a regression in the first runs that would otherwise be learned away unseen. A JSON response is named by what changed: the fields that came and went (`PATCH /api/todos/# answers with other JSON fields: new .note; gone .legacy`), a marker (`answers success=false instead of success=true`) or no JSON answer at all. The recording keeps only a hash of a response's form, so caw keeps the field paths of the learned forms on this machine (`.caw/response-forms.json`, never values); a form learned elsewhere is named with its new fields only. The result stays. The effect then counts as learned (`runs: 5`) and is frozen: no run changes it any more, only **"Accept new effect"** or deleting `effects` does. Five runs, because in two a fluctuating line is too often there both times by chance and is learned as if it were stable. While the effects learn, they stay on this machine in `.caw/learning/<test>.json` (not checked in): the terminal counts them (`Learning effects (kept in .caw/learning until frozen): S1 3/5, S2 3/5.`), and only the run that freezes them writes them into the recording, once (`Effects frozen for S1, S2: caw/recordings/create-ticket.yaml. Please review and commit.`). Until then they fail nothing and `caw audit` does not look at them, so they would only be noise in Git. Each machine learns for itself; whoever freezes first commits, and a frozen recording pulled from Git wins over what a machine was still learning. A newly recorded step learns anew, its learning state goes with the old recording; so does that of a step whose effects were forgotten. The text of the page (its ARIA tree) is not compared: headings, button names and options there mostly come from data, which changes between runs.

**Comparison:**
- If something from the learned effect is missing during replay, that is a deviation, as is a new console message.
- If a step fails, the assessment names the first deviating action up to that step (application, likely) and what happened instead. The agent gets it as `evidence.effect`.
- If the check holds, the kind of deviation decides. If a learned effect deviates in a list from the config's `effects.fail`, **the step fails** (assessment: application, likely; different data than when learning can also explain it, e.g. a list that was empty back then). Default is `["controls", "console"]`: the state of controls and new console messages. These signals were completely stable in healthy runs. Deviations in `requests` and `responses` stay warnings in the report, so drift shows up before a check breaks. With `"effects": { "fail": [] }` all deviations stay warnings.
- **Retries (`retry`)** change the application, e.g. an entry is opened a second time and thereby locked. So after the first retry in a run: steps that run again only as lead-in (with `retry.from`) are neither compared nor learned; later steps only warn; only the retried step itself still fails on its effect. If it deviates the same way twice (measured by the lists from `effects.fail`), there is no further attempt.
- A step with a learned deviation doesn't learn, so no error disappears from the comparison: a warning stays in every run until the effect is accepted, also one outside `effects.fail`, such as a request that is no longer sent. To accept a changed effect, choose **"Accept new effect"** in the chat. The button appears when only the effect deviates and the check holds. It deletes this step's `effects` from the file, without the agent and without tokens; the next five healthy runs learn it anew. Without chat, do the same by deleting `effects` from the file.

#### Renamed targets

If a click or input finds its element gone because the UI renamed it (button "Speichern" now says "Sichern") and exactly one similar element is there, caw tries that one, without the agent and without tokens, and proves it: only for a click, double click, fill or type whose effect is learned and does not write. caw runs the action on the candidate while it aborts every write, and keeps it only if the learned effect comes again, nothing tried to write, and the step's unchanged check passes. The step still fails (kind `target`), the replay goes on, since the check holds, and the step carries `proposal` (`step`, `action`, `from`, `to`, `evidence`) in `result.json`; `report.md` lists it under "Proposed targets". In the chat **Use "Sichern"** changes only that action's target in the recording (hash, description and learned effects stay) and runs the test again. In CI there is only the report section. `caw audit` lists such a change, it is no weakening.

### Advice on errors and warnings

Without fix parameters nothing costs tokens as long as you don't write or click: on a failed step a `run` shows the reason, hard errors and warnings in the chat. The agent advises on its own only here, and in conversation when you ask:

| Run | When |
|---|---|
| `run` and "Let Claude Code find the cause" | A step failed and you click the button in the chat. If the assessment is "application", it is the main button, otherwise it sits next to "Fix step". Then as with `--explain`: cards, and "Test again" after an adopted application change |
| `run … --explain` | Without a click: a step fails, a hard error occurs or there are warnings, even in a passed run. For runs whose result you only look at later. Only on environments with `agent` and with chat (not in CI), otherwise exit 3 |
| `record <test>@<S4>` and "Fix step" | Errors or warnings while re-recording or fixing and in the check run afterwards |
| `record` | only once you choose "Fix step" in the check run |

The agent works in the failed run's browser, so the state is still there. It may only read (`snapshot`, `eval`, `console`, `network`, `screenshot`, `url`); the host rejects everything else with `advise-only`. It reads the source code read-only as always and looks for the cause there, whatever the framework. Its log is in `agent/claude-advice.log`.

Every piece of advice names its evidence (`evidence`), e.g. a request, a hard error or a location in the code; without it the host rejects it. Each appears in the chat as a card, one after another:

- **Test:** title, rationale, evidence and the change as before/after, plus "Accept" and "Discard". Possible are `name`, `do`, `expect`, `note` and `retry` of an existing step, the test case's `notes`, an entry in `caw/caw.md`, and a pattern in `consoleIgnore` or `foreignCode`. If the assessment clearly points to an application bug, the card marks the advice as contradicting it.
- **Application:** title, rationale, evidence and a ready-made prompt for a Claude Code session on your side, with "Copy prompt" and "Continue". If the agent brings concrete changes (`edits`: file, search text, replacement, reason), the host checks them against the real code: path relative to the project, not under `caw/`, `.caw/` or `.claude/`, not in `node_modules/` or `.git` at any depth, not a secret, build, CI or agent-instruction file (`package.json`, lock files, Dockerfiles, `.github/`, `.circleci/`, `Jenkinsfile`, `CLAUDE.md`, `AGENTS.md`, `.cursor/` …), the search text exactly once in the file. The card shows file, line and diff. "Apply change" writes them to the files, line endings are preserved; if the location has changed in the meantime, nothing is written. The agent itself never changes application code.

What accepting does:

- **`retry` only:** takes effect immediately, without re-recording, since `retry` isn't part of the hash.
- **Changed text** in `name`, `do`, `expect` or `note`: the step is then outdated, and the chat offers "Fix step".
- **`caw.md` and config:** written immediately; the config applies from the next run.
- **Test file:** In `run` the change is in the file immediately. With `record` and "Fix step" it goes into the draft and only applies with "Adopt test plan".
- **Code change:** in the file immediately. Check it with the project's lint and a new `run`. While the card **Test again** waits, the window stays yours: reload the app (F5) and look at the change first. When the agent marks the change as one to the app's server (`restart: true`: it takes effect only after the server restarts), the card says so: with `--start` and a `start` command caw restarts the server it started before testing again; otherwise, an environment without `start` or a server that was already running, the card asks you to restart it yourself first.

The "Recommendations" section in `report.md` lists each piece of advice with evidence and your decision, for application advice including the prompt and changes as a diff. Nothing is ever committed.

### Fixing a step

If a step fails in `run` or in the check run of `record`, replay stops and the browser stays in the failure state. The chat says "S4 failed: <reason>" with hard errors and warnings and unlocks input (state "Clarify failure"), plus "Fix step" and "End run". Below it is the tool's [assessment](#assessment-test-application-or-environment) with its findings. If it points to an application bug, "Fix step" becomes only the second button, with a note that an adjusted test would merely hide the bug. This exists only on environments with `agent`; in CI, with `--no-chat`/`--headless` and on other environments there is only the exit code and the report.

- **Ask:** Only your message starts the agent, in the same browser and read-only as with [advice](#advice-on-errors-and-warnings). It answers in the chat, names cause, file and line, and can give advice cards. Each further message continues the same conversation until you press a button. The log is in `agent/claude-talk.log`. Without a message or click, no tokens are spent.
- **Fix in the same browser:** If nothing of the failed step has run yet, i.e. its first action failed without a hard error from outside, the agent fixes it right there, without a lead-in. The test run's report is kept as `report-test-run.md`. Otherwise, e.g. after half a sequence of actions or an unmet check, it proceeds as below with a lead-in in a fresh browser. The chat says beforehand which way it will be.

`record <test>@S4 --env <env>` re-records from S4 to the end, e.g. after an intended change in the application, or for a step changed by hand or newly added. The steps before S4 must be current; from S4 on steps may be outdated or not yet recorded. There is no check run first and no demonstration: S1 to S3 replay without the agent, then the agent follows the old plan from S4 on, you steer in the chat, and the agent looks for no cause. From S4 on the agent may add, remove, rename or reorder steps; the steps before stay as they are. If the agent presents the plan from S4 on unchanged, it applies without approval: the chat says so, and you can still write if something should change. The approval card appears only if something changes, likewise when fixing a failure. `@S1` is the same as `record <test>`. Recording a whole test again, a step whose expected result stays must keep its check too, also when it moved to another position; a changed expected result is shown at the decision. `--role` and `--read-only` don't go with a step (exit 3): the test keeps its metadata. Exactly one step is fixed only with "Fix step" in a run's chat.

Only what the agent tells you with `say` appears as a message in the chat. Its other notes are collapsed with the actions. If you cancel, the report says "Aborted by you."

1. **Prepare:** In a fresh browser S1 to S3 run without the agent; the chat shows progress. If a step before that already fails, that one is offered. Skipped when fixing in the same browser.
2. **Cause, then plan:** The agent gets only this step (with `record <test>@S4` all steps from S4 on, without looking for a cause): text, previous actions, check, reason, assessment with requests, plus `caw.md` and the `remember` values read so far. It first clarifies the cause, including in the source code, and states it in the chat. If the application is at fault, it doesn't change the test but gives advice with a concrete code change and reports `fail`. Otherwise it presents only this step as a card. A changed result is marked there, shown at the decision and listed in the report.
3. **Execute:** The agent runs the step and cleans it up. If the result stays the same, the check must stay the same too, or `finish` rejects it. Likewise if a `remember` value needed by a later step disappears.
4. **Check run:** The whole test runs without the agent in a fresh browser, up to any step that may still be outdated. If another step fails, the offer comes again. If it passes: "Adopt test plan (N steps)" or "Discard draft".

Only the fixed steps change in the file; comments and all other steps stay identical character for character. With `record <test>@S4` the steps before S4 stay identical, steps no longer in the plan are deleted, and the steps from S4 on lose their request baselines and effects, and what they were learning in `.caw/learning`; the next `run` outside CI learns them anew. New messages the agent sees along the way count as known afterwards; the decision lists them so no application bug slips through unnoticed.

- **Test data:** A fix costs up to two passes; writing steps before it create data accordingly. Tokens are spent only for this step, with `record <test>@S4` for all steps from S4 on. If a step fails after submitting, the record stays open; replay doesn't clean up.
- **Without the agent:** If Claude Code (`local`) or Docker or token (`docker`) is missing, the chat names the reason and the run stays `fail`.
- **Discard draft:** The test plan stays unchanged, after a confirmation ("Really discard?"). A previously failed `run` ends with `fail`.
- **Insert, delete, reorder:** With `record <test>@S4` the agent may change the plan from S4 on, because later steps may build on earlier ones. A step you add by hand gets its recording the same way: `record <test>@<its id>`.

## In CI

In CI caw needs no AI and no tokens. With `CI` set, `run` plays without chat and without an agent, `open` refuses (exit 3), and a run learns baselines and effects only with `--learn`. One run never freezes effects (five healthy runs do, a look two): `--learn` in CI only gets that far with the `.caw/learning` folder kept between jobs (a CI cache of that folder) or several runs in one job; without it each job starts learning from zero. Learning is at home on the developers' machines. The reports carry caw's assessment, retries repeat only what the environment broke, `bisect` finds the commit that broke a test, and `audit` shows in the PR whether a test got weaker. All flags: [Commands › Several tests (CI)](commands.md#several-tests-ci).

```yaml
- run: npx caw run --all --env preview --headless --retry-env 1 --report junit=out/caw.xml --report summary=out/summary.md
  env:
    CAW_URL__PREVIEW: ${{ steps.deploy.outputs.url }}
- run: cat out/summary.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

### Reports

`--report` can be given several times: `junit=<file>` for your CI, `summary=<file>` one Markdown line per test for the job summary (`$GITHUB_STEP_SUMMARY`), `json=<file>` the same for scripts. The paths must stay inside the project folder; each run replaces the files.

**JUnit:** one `<testcase>` per test. A failed step is `<failure type="app|environment|test|unclear" message="S3: <reason>">` with the assessment, its findings and the report path as text. Anything else that didn't pass is `<error type="<code>">` with the error code, e.g. `env-unreachable`, `auth-missing` or `replay-stale`. A pending step is a note in `<system-out>`. A monitor routes alerts by `type`.

**JSON:** `target`, `startedAt`, `exit`, and per test `id`, `status` (`pass`, `fail`, `error`, `rejected`, `needs-recording`), `exit`, `failedStep`, `reason`, `side` (`app`, `environment`, `test`, `unclear`), `strength`, `findings`, `code`, `steps`, `report` and `attempts`, each as far as it applies. For example:

```bash
jq -r '.tests[] | select(.status != "pass") | "\(.id) \(.status) \(.side // .code) \(.failedStep // "")"' out/caw.json
```

The assessment is a heuristic from the browser's evidence. It types the reports and decides a retry; it never turns a failure into a pass.

### Retries

`--retry-env <n>` (1 to 5) runs a test again right away when it ended with exit `2`, or with exit `1` and the assessment `environment`. At most `n` more attempts. A failure the assessment puts on the app, the test or nothing clear is never repeated, nor is exit `3` or `4`. The last attempt counts. Every attempt stays in the reports with its own report path: JUnit lists them in `<system-out>`, the JSON under `attempts`, and table, JUnit and summary say e.g. "passed on attempt 2 (environment)".

### PR previews

`CAW_URL__<ENV>` points an environment at another address for one process, e.g. a PR preview (`CAW_URL__PREVIEW`). The run's first line names it; it is never written to the config. caw refuses it for production and for environments with `agent`, and for a production host (`url-override`, exit 3). Details: [Configuration](configuration.md#url-override-for-pr-previews).

### Finding the commit that broke a test: `bisect`

`caw bisect <test> --env <env>` is one step of `git bisect run`. On each commit it starts the environment with its `start` command, plays the test headless without chat and without learning, and prints one line. Exit `0` is good, `1` bad (a step failed on the app), `125` skip (environment, test, unclear, any error), `128` stops the bisect. The test, its recording and `caw.config.json` come from a fixed ref (`--tests-from`, default `refs/bisect/bad`), because bisect checks out `caw/` too. Run caw from a fixed install:

```bash
git bisect start <bad> <good>
git bisect run npx -p caw-ai@<version> caw bisect <test> --env <env>
git bisect reset
```

Details: [Commands › bisect](commands.md#bisect).

### No test gets weaker unnoticed: `audit`

A check belongs to its expected result: while the expected result stays, caw keeps the check, also when a step is fixed or recorded again. People can still weaken a test, by a button in the chat, adopted advice or a hand edit. `caw audit <ref>` lists every such change since the branch left `<ref>`, as Markdown in the team language; to change a check on purpose, change the step's expected result, and the reviewer sees both.

#### In a PR

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx caw validate
- run: npx caw audit origin/${{ github.base_ref }} > audit.md
- run: gh pr comment ${{ github.event.pull_request.number }} --body-file audit.md
  if: always()
  env:
    GH_TOKEN: ${{ github.token }}
```

The step fails (exit 1) when a test got weaker; the comment says which and how, e.g. "The check of S2 changed although its expected result „One order is listed.“ stayed the same." with the check before and now. What counts: [Commands](commands.md#audit).

## Reproducing a bug: `reproduce`

The agent walks a bug report on its own and reports whether it reproduces.

`caw reproduce "<bug report>"` gives the agent a bug report and a signed-in browser, nothing else to do: no plan to approve, no
questions, no decisions (see [commands](commands.md#reproduce)). With `--from <test>@S3` the steps of a test first lead to the
state where the bug shows. The agent reads the report, walks it, judges by evidence (screenshot, console, network) and ends with
`yes`, `no` or `unclear`, the steps it took in plain language and, if it read the source, a hint at the cause with file and line.

What the agent may and may not do here:

- Only on environments with `agent`, never on production; the browser reaches only the project's hosts.
- Write only where the environment is `writable`; elsewhere every write request is aborted and named in the report.
- No plan, no `check`, no question to you, no advice and no code change: these commands are refused.
- Nothing goes into `caw/tests`: the report stays in the run folder. Only a reproduced bug (`yes`) leaves a draft in
  `caw/drafts/<id>.yaml`, plan and later its recording in one file. Its expectations describe the correct behaviour. Its
  last step is the red step: once recorded, its check evaluates and does not hold while the bug is there, and holds once it is
  fixed. Only that counts as red; a failure anywhere else (an earlier step, a check that threw) proves nothing about the bug.
  Its `notes` list what the agent did in the browser, with locators, as orientation for recording. Drafts are not part of `run --all`; `list` shows them apart.

From your Claude Code session, ask for it ("reproduce this bug: …"): the session starts `caw_start` with `command: "reproduce"`,
is the agent itself at no extra tokens, and gets the verdict, the report and the draft from `caw_status`, with the draft's
`phase` and `next`.

### From the bug to a proven fix

The draft turns the bug into a test that proves the fix: red before, green after, every other test still green.

1. **Red:** `caw record <id>` records the draft. Its last step is the one that must fail: the agent checks the correct behaviour
   there and the check answers "no" while the bug is there. caw keeps exactly that failing check, as long as it evaluated (a
   check that threw proves nothing). The check run without the agent then shows "S3 red as expected: the test catches the bug"
   when every step before passed and S3 failed at its check; "Adopt test plan" keeps the draft with `red: {step, run, head}` (the run and
   the commit checked out then). If S3 passes, the draft does not catch the bug, and the decision says so.
2. **Fix:** you fix the bug, by hand or with your attached Claude Code session; every change needs your approval. caw's own
   agent never changes code.
3. **Green:** `caw run <id>` replays the same recording without AI. Still red, the chat says "S3 still red: the bug is still
   there" and offers nothing to fix in the test; green, the terminal names the next command.
4. **Promote:** `caw run <id> --promote` runs the draft and, if it passes, `run --all` on the same environment. Only when both
   are green does the test move to `caw/tests` and `caw/recordings`, the draft is deleted, and the draft's run folder gets
   `fix-report.md`: red at which step (run, commit), green in which run, the files changed since the red commit (tracked files,
   committed or not, in the whole repository; new files only inside the project folder; without `caw/` and `.caw/`) and how
   many other tests passed. Exit 0 promoted, 1 not green,
   4 not recorded or never red.

**Guided in the workbench.** With a window the chat leads through these steps in one process, each in a new window, and the
chat so far goes along; "Later" on any card ends the run there, and the terminal still names the next command. A bar over
each card shows the phases Reproduced › Red › Fix › Green › Promoted: done ones ticked, the current one highlighted.

- `caw reproduce` reproduced: the card offers **Record red**, the recording of the draft as with `caw record <id>`.
- Saved red: the card **Now fix the bug** lists the red step, its expected result, its check and, when known, the cause the
  reproduction suspected (from the reproduction's run folder, which `keepRuns` keeps while the draft exists; the agent recording it also finds it at the start of the draft's `notes`, which the recorded plan may rewrite). **Let the agent fix it** has the agent advise the fix, with every agent kind
  (local, Docker, your attached session): its code changes come as cards you apply one by one ("Apply change"), caw's own agent
  never writes code. If the cause lies outside the project (another repository, a service, the environment), its card says
  where, there is nothing to apply, and **I fix it there** waits like **I fix it myself** until you **Test again**.
- Still red: fix again, test again or end the run. Green: **S3 green: the bug is fixed**, and **Adopt** promotes the draft as
  `--promote` does, while the window waits; the chat names the fix report. If another test is red, the card says so and the
  draft stays.
- `caw record <id>` and `caw run <id>` with a window join at their step. Headless, `--no-chat` and CI run as before.

From your session the same steps are `caw_start` with `command: "record"`, `"run"` and `"run"` with `promote: true`. Your
session need not keep track: `caw_status` (for the reproduction and every run of the draft) and each row of
`caw_reproductions` carry `phase` (`reproduced`, `red`, `green`, `promoted`) and `next`, the step after it: record, fix the app
(with the red step, its check and the suspected cause), run, promote, or done with the fix report. `green` comes only from a run
after the red proof that checked the red step and passed it; `caw open <id>@<red step>` stops before that check and leaves the
phase `red`.

If the agent finds that an existing test already checks the reported behaviour, it names it in its verdict (`covered`: the test,
optionally the step, and why). caw accepts only a recorded test and adds its newest run from `.caw/runs`; if that run passed,
the report says its check may miss the bug.

### Tickets from another tool

caw talks to no ticket system. If your session has another MCP server that serves tickets, it chains the two: it reads a
ticket there, starts `caw_start` with `command: "reproduce"`, the ticket text as `bug` and its id as `ref` (`--ref` on the
command line), and goes on to the next one. caw keeps the id as it is, never looks it up, and writes it into the report, the
result and the draft. Afterwards `caw_reproductions` with `refs` lists the runs for these tickets (verdict, what the agent
observed, an existing test that covers it, draft, report) and names tickets without a run as `missing`; the session shows the
table. Whatever the ticket says stays the bug report: the agent treats it as data, not as instructions.

## Reach any state and develop

The same tests take you to any state of your app, signed in, and hand you the window: to develop there with the agent in the chat.

### Reaching a state and taking over

```bash
caw open <test> --env local
caw open <test>@S4 --env local
```

`open <test>` replays the whole test and then hands over the window. `open <test>@S4` stops at the entry of `S4`: S1 to S3 run completely with their checks, of S4 only its leading navigation (`goto`, clicks, `wait-ready`). Its inputs and its check stay open, so you continue right where S4's work starts, e.g. in the form it fills in. The terminal says "Ready for S4 <name>: navigation done, inputs open." S4 itself is not judged; later steps don't run, so they may be outdated. `@S1` signs in, opens the app and does S1's navigation.

Of S4 nothing runs if it has no input at all (`fill`, `type`, `upload`, e.g. only a "Submit" click) or if it is not recorded or outdated. If one of its leading clicks wrote data in earlier runs (learned effects), it stops before that click. The terminal names the reason.

The sequence is deterministic, the environment isn't: this is not a snapshot. The path runs anew each time with new data, and if the application deviates, the step fails visibly.

- **Code:** As in every run the code of the environment: against your dev server your current code, otherwise the deployed version. The `Code:` line says which (see [Testing local code](configuration.md#testing-local-code)). You see changes with F5; the form state is gone afterwards. To get back, start the command again.
- **Path fails:** You clarify the error in the chat and can have the step fixed. If you close the chat, the window still goes to you and the report names the error. The exit code remains the verdict.
- **No recording:** exit 4, record first. This applies to the steps before S4; S4 itself may be outdated.
- **Learns nothing:** unlike `run`, `open` learns no baselines or effects.
- **Not in CI:** with `CI` set, `open` ends with exit 3; nobody is there to take the window.
- **State after reload:** Whether a view keeps its state after F5 depends on the application.

### Developing in the reached state

With chat, the chat stays open after handover (state "Develop"). Its first card, "What you can do now", says what the window offers:

The workbench stays as it is, with steps and chat; F8 shows the app alone (**App only**) and keeps it across reloads. The browser window stays as it is. The app now fills the whole pane; the recorded size holds only while caw replays, also when it restores a state.

- **Ask:** You ask the agent in the chat, ideally about an element you picked in the app with `/element`. The agent reads the source code and answers. It never changes code itself; it proposes verified changes: "Apply change" writes them into your project folder, "Copy prompt" hands them to you for your own session.
- **Let the agent use the page:** On request the agent clicks, fills in, presses keys, navigates or reloads, e.g. "click the selected button". It asks before anything that saves or deletes data.
- **Debug a bug:** Paste a bug ticket into the chat. The agent reproduces it in the reached state, looks at console, requests, component values and source, names the cause with file and line and proposes the fix as a change you apply with a click. Then reload or restore the state, and the agent checks whether the bug is gone.
- **Reload** (F5): reloads the current page without cache so your change shows immediately. Chat and steps stay; the test is already over and its result doesn't change.
- **Open again** (in the chat): starts a new session (cookies and site storage cleared), signs in again and replays the recording up to the same point (with `@S4` the entry of S4), with new test data, exactly like any other run.
- **Open… (F1):** any test of this environment, of any role, and optionally a step. Before caw replaces your window, you confirm in the chat, e.g. with "Open S2". Then caw replays the test in the same window with the account of the test's role: without a step the whole test, with a step up to its entry, as with `open <test>@<step>`. If restoring fails, the agent in the chat knows why; it can also adjust the test, e.g. mark a cookie-banner click optional, and the change goes into the test file right away.
- **Pick an element:** With `/element` in the chat you click an element in the application, also a greyed-out button or one in a dialog; a ring with a label shows what the click picks (the click does nothing there, Esc cancels). It is attached to your next question in the chat, and caw stores it with label, component or source, page and requests for your Claude Code session, retrievable with `caw_selection`.
- **End:** "End run" or close the window.

### Take over and keep developing

`caw open <test>` replays the test and leaves the window open after the verdict:

- **Keep clicking:** You continue in the same page and the same form state, including unsaved input and DevTools.
- **Keep developing:** Against your dev server as the environment, F5 loads your current code. With the [overlay extension](extensions/overlay.md) the local code stays in place until you close the window. There is no automatic reload apart from the dev server's hot reload.
- **State:** F5 loses whatever existed only in the browser, such as open dialogs and unsaved input. "Restore state" in the chat or a new test run brings you back.
- **End:** Closing the window ends the run. The exit code remains the verdict.
- **Keyboard in the chat:** Ctrl+↵ (Cmd+↵) triggers the main action while the input is empty, e.g. "Approve plan" or "Finish demo"; that button shows `Ctrl ↵`. Alt+↵ sends a checkpoint while you demonstrate. Esc first closes an open menu, then clears the input field if you are typing in it. Otherwise Esc requests cancellation ("Really cancel? (Esc)" and "No"); only a second Esc within 4 seconds confirms it. New choice buttons get focus unless you are typing.
- **Your turn:** When the chat waits for you (plan, decision, clarifying a failure), "YOUR TURN" shows above the application, and the terminal prints once "Waiting for you in the Chrome window: …".
- **Record, play, pause:** A chip at the top right of the workbench shows what the run does: "REC" while the agent records or fixes, "PLAY" while caw replays (run, check run, restoring a state), "PAUSE" while such a run is paused (F9). When nothing runs (after the run, after the handover, after cancelling) there is no chip.
- **After the run:** The outcome is the last line in the chat, e.g. "Saved: caw/tests/bestellung.yaml". Below it the end card says "Run passed" or "Run failed" (for `reproduce` the verdict, with observed, expected and cause), counts the steps and shows the command for a new run, with a button to copy it. Its main action is "Close window", with "Open report" beside it. "Open report" opens the [report page](#the-report-page) in a new tab. The window stays open for 15 seconds, counting down on "Close window", and then closes itself; a click into the chat input stops the countdown for good ("Stays open"). Above the card a notice names the steps whose baselines this run saved. If a new window is about to open (for the agent or the check run), chat and terminal say so first.

You can open your own tabs at any time, even during a run: only the application tab and its popups are controlled, and only their errors count. Clicking in the application tab while a run is working, however, affects the test.

In the window you stay behind the same host lock and are signed in as the test user. Playwright dismisses dialogs like `alert()` automatically, so they never block. The profile is fresh and deleted at the end. If it is left behind, e.g. after an abort, the next run removes it once its process is gone.

## The agent's box

Test accounts stay in your `caw/.env`, production is read-only, and the agent reaches the application only through the browser and fixed commands.

### Sandbox boundaries

**Local (agent `local`):**

- **Tools:** Claude Code starts with `--tools Read,Grep,Glob`, `--permission-mode dontAsk` and `--strict-mcp-config`: no shell, no writing, no web, only the caw tool as MCP server. Hooks are disabled. `--tools` fixes the list; your own settings unlock no further tools.
- **Reach:** Only `Read(./**)`, `Grep(./**)` and `Glob(./**)` are allowed, i.e. the project folder; `dontAsk` rejects everything else, including `~/.ssh` or Claude Code's login (verified with Claude Code 2.1.319). Your own and the project's Claude Code settings aren't loaded (`--setting-sources ""`), so their `allow` rules can't widen this; only connection settings (`env`, `apiKeyHelper`, `model`, AWS helpers) are carried over from `~/.claude/settings.json`. Locally the agent can't view screenshots in the agent folder under `.caw/`.
- **Files:** `.env*`, `.git`, `.claude`, `.worktrees`, `.caw`, `caw/.auth` and typical key files (`.npmrc`, `*.pem`, `id_rsa*` …) are blocked via `permissions.deny`. That's a Claude Code lock, not file system protection as in the container: if you need stronger guarantees, use `docker`.
- **Network:** The agent itself has no web tool. It reaches the application only through the browser and its lock.

**Session (agent `session`):** The rights of your own Claude Code session apply. caw only adds the browser commands.

**Container (agent `docker`):**

- **Files:** The project folder is mounted read-only, always under the Linux path in the container (`C:\x` as `/mnt/c/x`). Only the run's agent folder and the container's interior are writable. `.git`, `.claude`, `.worktrees`, `.caw` and all `.env` files are hidden, including `caw/.env`. The agent can see other secrets in the project folder.
- **Network:** Default deny for IPv4 and IPv6. Allowed are loopback and HTTPS to the Anthropic API. The firewall resolves its addresses at startup and writes them to `/etc/hosts`; after that DNS is blocked too, including Docker's built-in resolver, so no data can be smuggled out in DNS names. If the API's addresses change during a run, a new run helps. The application isn't reachable from the container.
- **Privileges:** The container starts as root only for the firewall, then runs as the sandbox user (`sandboxUser`) without capabilities, with `no-new-privileges`. No published ports, no Docker socket.
- **Token:** It arrives at runtime as an environment variable and isn't in the image.

**Chrome (on the host, outside the Docker firewall):**

- **Control:** The agent never gets CDP. There are only the fixed commands of `caw agent --help`, as files in the agent folder. Navigation via `goto` only goes to allowed hosts.
- **Network:** The Docker firewall covers only the agent's container, not this Chrome. Pages navigate only to the hosts of `environments` and `allowHosts` (a request route; a redirect onto another host fails the action as well). While an agent can act in the window (record, a run with chat, `open`), every request goes only to those hosts and `thirdPartyHosts`: fetch, XHR, WebSockets, beacons, iframes, scripts and redirect hops. Chrome cannot even resolve any other name (`--host-resolver-rules` with `MAP * ~NOTFOUND` and one exception per allowed host), which also stops DNS lookups and connections no route sees; a request route and a WebSocket route abort the requests first and name each blocked host as a warning in the run, with the key that allows it. Otherwise subresources and iframes may go to any host and are listed in the report as third-party hosts. Production hosts of other environments are unresolvable for every request type in every run, also with a trailing dot. Plus `--no-proxy-server`, so the resolver rules apply, and a WebRTC lock.
- **Sandbox:** Chrome always runs in its own sandbox. Where it cannot start (Linux as root, some containers) caw stops with `browser-sandbox`; `browser.noSandbox: true` turns it off knowingly (unsafe).
- **Workbench:** The tool answers the top window's document itself, at the application's address. The application thus shares the origin with the workbench and can modify its page; decisions are made only in the chat, whose document it can't reach (separate, opaque origin). It can remove the chat iframe's sandbox or reload it; the tool then doesn't write the chat into it and the run ends with `chat-tampered`. Of the application's documents only the application iframe's own lose `X-Frame-Options` and `frame-ancestors`, and the tool knows the application frame by identity, not by its name. A POST into the top window is sent once by the tool via the browser context (same cookies, same host lock).
- **Limit of the lock:** It knows host names, not ports or addresses. Other services on an allowed host are reachable from the page, and a production host reached by its IP address (or another name for the same address) is not blocked.
- **Visibility:** `eval` runs in the signed-in page. The agent sees and can do everything the test user sees and can do in the application. So use only test accounts with few rights.
- **Backend:** The lock ends at the application's host. Requests via an application proxy pass through, and where it forwards them is up to the server. The real boundary is the test account's rights.
- **`writes: false`:** A new test is writing unless `record … --read-only`. If a read-only test does write during recording, it becomes writing on adopt. The tool checks the field before starting against `environments.<env>.writable`. During the run only the guide's instruction prevents writing; it isn't technically blocked (on `production` environments write requests to any host are blocked, form posts into the top window included; messages over an open WebSocket are not, since reading apps send them too).
- **Corporate policies:** A centrally enforced Chrome policy (e.g. a proxy) can override the lock. Check this on the machine running the tests (`chrome://policy`).

**Verdict:** Only the host writes report and `result.json`, outside the agent folder. Only screenshots the host took itself count.

## Visual checks

Two kinds of visual check, both without AI. A [target design](#develop-against-a-target-design) says what a screen should become. `look: true` keeps a built screen the way it is.

### Visual regression

`look: true` on a step in the test file makes caw learn that step's look: its style lines over two passed runs, in a window and headless alike ([details](test-files.md#visual-regression)). A later run whose styles changed fails the step with kind `visual`. Only you write `look`, like `design` and `needs`; it is outside the hash.

- **Fixed data only:** set it only on steps whose screen shows fixed data, e.g. a state the test sets up itself. Changing data makes it noisy.
- **Suggested after recording:** after `caw record` the check run suggests such steps in its "Check run passed" card. It judges where their text comes from: values from the server's answers, rows, list entries, cards, dates. None is ticked, because caw cannot be sure. Ticked steps get `look: true` when you adopt.
- **Left out:** the controls inside list and table rows, list entries, cards and what `visualIgnore` in the config finds do not count in the style lines, so one list entry more changes nothing.
- **Intended change:** **Adopt new look** in the chat takes over the new look of every changed step at once. `caw audit` lists it, and taking `look: true` off a step with a learned look counts as a weakening.

## Monitoring production

A monitor is a `run` of read-only tests against production on a schedule. It needs no agent and no tokens: caw writes the result, your scheduler or CI raises the alert. Reports, retries and the rest of CI: [In CI](#in-ci).

### Recipe

```bash
npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json
```

- **Which tests:** `--all --env prod` takes every test that lists `prod` under `environments`. Without that field a test runs everywhere except production, so add the environment to each test the monitor should run ([Test files](test-files.md#test-plan)). Only read-only tests can: a test with `writes: true` that lists a production environment is invalid.
- **No window:** `--headless`. A production environment has no `agent`, so there is no chat and no agent anyway.
- **Retries:** `--retry-env 1` gives a test one more attempt when the environment is to blame ([Retries](#retries)).
- **Reports:** `junit=` for your CI or alerting tool, `json=` for scripts. In GitHub Actions also `summary=` for the job summary ([Reports](#reports)). They are the monitor's alert input.
- **Pending steps:** A test with steps not recorded yet passes without them. `--strict` makes that exit `4`.

GitHub Actions, every 15 minutes, with the account from the repository's secrets:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json --report summary=out/summary.md
        env:
          CAW_CLERK_USER__PROD: ${{ secrets.CAW_CLERK_USER__PROD }}
          CAW_CLERK_PASSWORD__PROD: ${{ secrets.CAW_CLERK_PASSWORD__PROD }}
      - run: cat out/summary.md >> "$GITHUB_STEP_SUMMARY"
        if: always() && hashFiles('out/summary.md') != ''
```

On your own machine, with `alert.sh` standing for your alerting:

```bash
*/15 * * * * cd /srv/shop && npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json >> out/monitor.log 2>&1 || ./alert.sh $?
```

### Exit codes

| Exit | Means | The monitor |
|---|---|---|
| `0` | every test passed | stays quiet |
| `1` | a step failed: the app didn't do what the test expects | alerts; the reports say whether it looks like the app, the environment, the test or unclear |
| `2` | environment: no verdict (server down, sign-in failed, Chrome missing, an internal error) | reports production as unavailable, or alerts after several runs in a row |
| `3` | rejected, nothing ran: the monitor itself is broken (config, test file, a missing secret `credentials-missing`, `auth-missing`, the call) | tells whoever maintains the monitor |
| `4` | the test needs maintenance: recording missing (`replay-missing`), a step changed since recording (`replay-stale`), pending steps with `--strict` (`replay-pending`) | tells whoever maintains the tests |

With several tests the exit code is the worst one: `2` before `1` before `4` before `3` before `0`. So one test that ended on the environment hides another one's failed step in the exit code; the reports have each test's own result. If caw stops before the first test (invalid config, unknown environment, a report path outside the project), it exits `3` and writes no report. Treat a missing report like `3`. All codes: [Commands › Error codes](commands.md#error-codes).

### What is different on production

- **Marked in the config:** `"production": true` on the environment. A name that looks like production (`prod`, `live`, `prod-eu` …) must say `true` or `false`; `prod`, `production`, `prd`, `live` and the like must say `true`. Otherwise the config is invalid (exit `3`).
- **No agent, no writing:** A production environment can't have `agent` or `writable`, nor `start`, `stop`, `reset` or `ready`. So `record`, `reproduce`, the chat and `--explain` don't run there; you record a test on another environment. `role login`, the overlay and a `CAW_URL__<ENV>` override (`url-override`, exit `3`) are refused for it, and `doctor` never contacts it.
- **Writes blocked:** every request that is no read is aborted and fails the step with `write-blocked` ([Configuration › environments](configuration.md#environments)).
- **Out of reach for other runs:** a run on another environment can't resolve the production host.
- **Less in `result.json`:** its steps carry no effect lines on production, since those name what is visible on the page.
- **Learning:** Baselines, effects and learned looks are learned only on the environment a test was recorded on (`recordedOn` in the recording), and compared on every environment. A run on production learns nothing and changes no test file. Effects (controls, requests, responses, console) are learned over five healthy runs and then stay fixed. Production has other data than the recording environment, so an effect can deviate there, e.g. a list that was empty when learned; [Effect per action](#effect-per-action) says what fails a step and what only warns.

### Limits

- **WebSocket:** Requests, baselines, effects and the assessment see the app's requests, not messages over a WebSocket. Those messages aren't blocked on production either. A broken live update shows only if a check or the controls notice it.
- **Access by IP address:** caw has no proxy setting: Chrome starts with `--no-proxy-server`, so the host lock holds. The monitor's machine must reach production directly. If production admits only certain addresses, run the monitor on a machine with a known address and allow it.
- **A monitoring account of its own:** Sign in with an account made for the monitor, with as few rights as the tests need, never a personal one. Its credentials come the usual way ([Configuration › roles](configuration.md#roles)): `CAW_<ROLE>_USER__PROD`, `CAW_<ROLE>_PASSWORD__PROD` and for one-time codes `CAW_<ROLE>_TOTP__PROD`, as CI secrets or in `caw/.env` on the monitor's machine. `caw role login` refuses production, so caw can't save a stored session (`signIn.type: session`) there; without the file a run stops with `auth-missing` (exit `3`). A monitor on production signs in with a form or basic login only (`signIn.type: form` or `basic`).
- **Retention:** Every test run and every attempt leaves a folder in `.caw/runs/`. `keepRuns` (default 30) counts every test run, not every monitor run: it keeps the newest and deletes older ones when a run starts. With ten tests that is three monitor runs. So a monitor should raise `keepRuns` or archive its JSON report itself; `0` keeps every run and fills the disk.
- **Personal data in artifacts:** Production shows real data. caw masks the role's password, one-time codes, values marked `secret: true` and HTTP Basic credentials with `••••` in `report.md`, `result.json` and the trace. Request names carry no parameter values (except `requestKeys`), and on production `result.json` leaves out effect lines. Not masked: screenshots (the failure screen, `visual.screenshots`), the trace (`trace.zip` with page contents, requests and the account's cookies), and texts the app showed, which end up in reasons, findings, messages and console lines in `report.md`, `result.json` and the JUnit, JSON and summary reports. Keep `.caw/runs` on the monitor's machine, don't upload run folders as CI artifacts, and treat the reports as data that may quote the page.

## Drive it from Claude Code

The agent runs as your own Claude Code, in a Docker sandbox or as your Claude Code session. In your session caw is a set of MCP tools: set up, record, run, reproduce, open a state.

### Agent: local, Docker or your session

Where the agent runs when a run needs it is set by `agent.mode` in the config (`local`, `docker` or `session`, default `local`). `--agent local|docker` overrides it for one run; `--attach [<key>]` lets your own Claude Code session work for it. In CI (`CI` set) it is always `docker`; other values abort.

| Agent | How the agent runs | Good for |
|---|---|---|
| `local` | `claude -p` on your machine with your login. Only the tools `Read`, `Grep`, `Glob` and the caw tool: no shell, no writing, no web, no hooks, no other MCP servers. | everyday work on your own machine |
| `docker` | `claude` in a container with a firewall, only with an API key (`ANTHROPIC_API_KEY`) | anyone who doesn't want the agent on their own system |
| `session` | No agent process of its own. Your open Claude Code session takes the role via the MCP server `caw mcp`. | recording, fixing and developing in your usual IDE session |

In all three cases the browser is the actual boundary: the agent sees the application only through the fixed commands and can navigate only to allowed hosts (see [Sandbox boundaries](#sandbox-boundaries)).

```json
"caw:shop:smoke": "caw run shop-smoke --env local",
"caw:shop:smoke:record": "caw record shop-smoke --env local",
"caw:shop:smoke:rerecord-docker": "caw record shop-smoke@S2 --env local --agent docker"
```

In CI (`CI` set) `run` runs without chat and without the agent; `agent.mode` only applies there if a run does need the agent, and then always as `docker`.

**Personal settings:** What you set for yourself in the workbench is stored per user in `prefs.json` under `CAW_AI_HOME`, otherwise `%APPDATA%\caw-ai` (Windows) or `~/.config/caw-ai`: "Animations off" (F10: no spinner, no pulsing dots, no blinking cursor), collapsed steps or chat, and the mode (`system`, `light` or `dark`; `system` follows your operating system and is the default). You change them on the [settings page](#settings) (Ctrl+,). In the same folder your own `caw.md` holds notes for the agent in every project, read before the project's `caw/caw.md` ([Configuration](configuration.md#your-own-cawmd)).

**Token notice:** Before the agent works (record, fix a step, investigate a failure, questions in the chat, `--explain`), the chat asks once per run: "Continue", "Don't ask again" or a decline that says what it does: "Continue without Claude Code" (investigate a failure, questions in the chat) or "Cancel run" (record, fix a step). "Don't ask again" sets `"tokenNotice": "off"` in `prefs.json`; remove the entry to get the notice back. With `--attach` (or `agent.mode: session`) there is no notice: your session is already running.

**Try it** without a project of your own: [`examples/errand`](../examples/errand) in the repository, a small app with login and one test.

#### From your Claude Code session

Register caw once as an MCP server of the project:

```bash
claude mcp add caw --scope project -- npx caw-ai mcp
```

On Windows (not WSL) `npx` needs a wrapper: `claude mcp add caw --scope project -- cmd /c npx caw-ai mcp`. Once caw is
installed in the project (`npm i -D caw-ai`), `init` points the entry at the installed copy
(`node node_modules/caw-ai/bin/caw.mjs mcp`); restart Claude Code afterwards. Your session then has these tools:

| Tool | Purpose | Tokens |
|---|---|---|
| `caw_guide` | How to work with caw, per topic (`setup`, `tests`, `run`, `session`, `config` …); without a topic the index | no |
| `caw_init` | `mode: explore` opens the app for you to sign in and returns the suggestions; `mode: write` writes the config from them; `mode: offline` the template with TODO | no |
| `caw_config` | `{ read: true }`: config as written and effective, with validation; `{ patch, dryRun }`: validated change, an invalid result is not written. Commands (`start`, `stop`, `reset`, `ready`, `lintCommand`, overlay `start`), the environment flags (`production`, `agent`, `writable`, `allowHttp`, `insecureTls`), `browser.executablePath`, `sandboxImage`, `sandboxUser` and `agent.mode` are refused: the session edits those in the file, where Claude Code shows you the diff | no |
| `caw_role` | `list` roles and whether a test user is set; `add` puts a role into the config and names its variables, you fill `caw/.env` yourself; `login` saves a session (SSO); `remove` | no |
| `caw_attach` | attaches this session to caw windows: returns its key and the command it starts with its Monitor tool; chat messages and tasks of an attached window then reach the session as lines | no |
| `caw_doctor`, `caw_validate`, `caw_list` | `doctor`, `validate` and `list` as data | no |
| `caw_reproductions` | the reproductions in `.caw/runs` with verdict, `ref`, covering test, draft and report; `refs` names those without a run as `missing`, `since` filters by date | no |
| `caw_design` | target designs under `caw/design`: write (`put`), list, link to a step on the person's request | no |
| `caw_start` | starts `run`, `record`, `open` or `reproduce` with your session as the agent: fields `test`, `env`, `step`, `overlay`, `headless`, `learn`, `promote`, `strict`, `design`, `start`, `reset`; for `reproduce` `bug`, `from`, `role`, `ref` (or `args`) | none beyond your session |
| `caw_status` | whether a run is waiting for the session and which guide topics apply, which decision the window waits for (`waiting.decision`), the last lines of output, and the last run: result, last step, artefacts | no |
| `caw_decide` | answers the waiting decision like a button: a `free` option the session may answer, a `human` one only after you confirm it in a form your client shows ([Decisions](#decisions-from-your-session)) | no |
| `caw` | the agent's commands (`snapshot`, `click`, `plan`, `finish` …) for the waiting run | as part of the run |
| `caw_selection` | the element you picked with `/element` in the workbench chat while developing | no |
| `caw_overlay` | only with an `overlay` block: is the local code server ready, `check` and `apply` | no |

The server tells Claude Code what caw is for and to read `caw_guide` first. One skill comes along: `caw init` (and `caw skill`, also to update it) writes `.claude/skills/caw-attach/SKILL.md`, which tells your session when to attach to a caw window: when you want to look at something in the app with it, have a bug reproduced together, or type `/caw-attach`. Check it in; caw only replaces a file it wrote itself. The data tools return a short text and the same result as `structuredContent` (JSON). None of them prints to the MCP channel or asks on stdin; explore, `overlay check` and runs run as separate processes. caw never starts your local code server from the session; the agent does that in its own session after asking you, unless your project's rules (e.g. `CLAUDE.md`) say otherwise.

So in your session you write "record a test for the order" or "take me to S4 of bestellung", and the session does the rest with the guide. If you start a window yourself in the terminal with `--attach`, it waits until your session listens: type `/caw-attach` there (or ask it to attach). Then whatever you write in the workbench chat, with `/element`, reaches that session; it answers in the chat and may change the app's code when you ask. A recording or run you started counts as your request: the task caw hands the session says so ("The person started this recording in caw …: submitting the plan and following it is what they asked for"), so a safety check of the session, such as Claude Code's auto mode, does not take submitting the plan for a step around your oversight. You still approve the plan and decide in the window.

- **Fewer questions:** With your session as the agent there is no token notice, and `record` of an existing test plan starts without asking who demonstrates. A read-only plan that the session follows unchanged needs no plan approval; adopting the tested plan at the end always does.
- **Without a window:** `record <test> --headless` (or `caw_start` with `headless`) records a test that has a plan without you. caw takes only what changes nothing the test checks; anything else stops the run, writes nothing and exits `5` ([Commands](commands.md#without-a-window)).
- **Waiting:** `plan` and `chat` wait for you for up to an hour. If Claude Code cancels the call earlier, raise `MCP_TOOL_TIMEOUT` (milliseconds) in Claude Code's environment.
- **Caution:** Your session has more rights than the agent in a run (shell, writing). Whatever comes from the application is data to it, not an instruction; caw tells it so with every task. Have Bash and write calls in this session confirmed instead of allowing them wholesale. The caw tools run the project's commands too: `caw_start` with `start` runs the environment's `start` (and later its `stop`), with `reset` its `reset`, and a `run` with a writing test runs `reset` before that test; all from `caw.config.json`, on your machine. `caw_config` cannot change those commands or the environment flags; that edit goes through Claude Code's own file edit, so review its diff like code.

##### Decisions from your session

Every card the window waits for is a decision with a stable id (`plan.approve`, `recording.adopt`, `red.proof`, `step.failed`, `effect.accept`, `target.use`, `look.adopt`, `fix.guide`, `fix.green`, `advice.item`, `tokens`, `state.restore` …), a `context` without caw's wording (test, step, reason, diagnosis, red step, files) and options with stable ids. Each option has a gate: `free` when it changes no standard (close, later, discard, test again, record red, ask the agent), `human` when it does (approve a changed or writing plan, adopt a recording that changes what the test checks, accept an effect or a look, use a target, ignore errors, promote, apply app code, fix a step the app is blamed for).

`caw_status` shows the waiting decision as `waiting.decision`; `caw_decide` answers it. Your session may answer a `free` option, when it fits what you asked for. For a `human` option caw asks you through Claude Code with a form only you can confirm (MCP elicitation); the model cannot answer it. A client without forms is refused and told to let you answer in the window. The first answer wins, the window's or the session's, and the window shows "answered by the session". `result.json` and `report.md` list each decision with who took it (`window`, `session`, `elicitation`, `terminal`, `auto`), and `caw audit` lists those that changed something outside the window. Only `caw_decide` can answer. The run names its public key in `decision.json` in the run folder; an answer in `decision-answer.json` counts only with a proof (an HMAC) made from a secret that only the run and your session's caw MCP server share: each computes it from its own private key, which never leaves its process and is in no file. A run started from your session (`caw_start`) gets the server's key through its stdin and takes answers only from that server; a run you start in a terminal takes them from the sessions listening in the project (`caw_attach`; `caw_decide` registers its session too). An answer file without a valid proof, such as one your session's own file tools wrote, is ignored: the terminal and `report.md` say "invalid answer ignored". What remains: a session with full shell rights on your user account can still do a lot, such as starting a run itself with its own key, editing test and recording files directly or reading another process's memory. That is no longer a slip through a file but a deliberate act, and `caw audit` in the pull request is the backstop.

### Docker

Only for the `docker` agent. The Docker daemon must be running; the tool doesn't start it. It starts and removes the container itself.

On Windows the tool takes the first route whose daemon answers: `docker.exe` first, then Docker in WSL. Which one is shown at the start of the output. Pin it with `CAW_DOCKER=windows` or `CAW_DOCKER=wsl`.

This check runs before anything else and aborts with its own message (exit 2):

| Code | Meaning |
|---|---|
| `docker-missing` | No Docker found |
| `docker-not-running` | Docker is there, the daemon doesn't answer |
| `docker-wrong-mode` | Docker Desktop is set to Windows containers; the sandbox needs Linux containers |

## Export to Playwright

`caw export <test>` writes a recorded test as a Playwright test that runs without caw, only with `@playwright/test`: the recorded locators, one `test.step()` per step, sign-in from `signIn`, checks as `expect.poll`. What is not exported and how to run it: [Commands](commands.md#export).

## More

### Local code in the application

Against your dev server the app runs your code anyway: it is just an environment ([Configuration › Testing local code](configuration.md#testing-local-code)). For apps that only run inside a deployed environment, the [overlay extension](extensions/overlay.md) lays your local code over it; with ExtJS from the Sencha watch ([ExtJS](extensions/extjs.md)).

### Framework: `web`, `react`, `vue`, `angular` or `extjs`

Almost everything in the tool is framework-agnostic: snapshot, clicks, console, requests, assessment, chat. Whatever depends on it lives in an adapter, chosen with `framework` in the config. A project has exactly one; the test file doesn't name it. `react`, `vue` and `angular` are `web` with three additions: they detect when the framework has mounted the application, name the component for each target (only as a hint for the agent and the report), and skip framework files in the stack.

| | `web` (default) | `react` / `vue` / `angular` | `extjs` |
|---|---|---|---|
| Stored target | A Playwright locator: role and full accessible name (`aria-label`, label, text), `data-testid`, scoped to the named dialog, form or row around it. Never field values. Open shadow roots count (closed ones can't be reached); an iframe of the application via `contentFrame()` | like `web`, plus `component` as a hint: the components from outside in, e.g. `GroupsScreen › Button`; for Vue also `source`, the SFC file. Dev build only, irrelevant for finding the target again | like `web`; a component without role or name as `locator('extjs=…')` (`Ext.ComponentQuery`) |
| Ready | Document loaded, no page request open (requests open longer than 10 s, like long polling, don't count), nothing with `aria-busy`, no indeterminate progress (`role=progressbar` without `aria-valuenow`), DOM quiet for 150 ms | like `web`, plus mounted: React root container, Vue `data-v-app`, Angular `[ng-version]`; Angular also stable according to Zone.js if the app offers Testability (with `bootstrapApplication` only with `provideProtractorTestingSupport()`) | No `Ext.Ajax` request open, no store loading |
| `wait-ready --for` | CSS selector, `--min-count` counts visible matches | like `web` | `storeId` or ComponentQuery, counts records |
| Messages | modal dialogs without input fields, `role=alert`, `role=alertdialog`, or `messageSelectors`; `role=status` (toasts, snackbars) only as a notice | like `web` | modal dialogs, `messageSelectors`, plus ExtJS dialogs and toasts |
| Stack origin | top entry | top entry outside `react-dom`, `@vue/*`, `@angular/*`, `zone.js` | top entry outside `ext-*.js` |

For all of them:

- **Source maps:** A script error points to the source if the application serves source maps (Vite in dev mode always, builds with `sourcemap`): `src/screens/GroupsScreen.tsx:190:15` instead of `index-3f9a.js:1:48211`. They are loaded only from the script's origin and only from hosts in the lock.
- **Route changes:** If a single-page router aborts open requests on a route change (up to 1 s before or 0.5 s after), that doesn't count as an application error, just like an abort caused by navigation.
- **Covered targets:** If a target isn't clickable, the tool says why: it's missing, it's invisible, or a dialog covers it, along with its message.
- **Virtualized lists:** If a row is missing, the search scrolls the list until it appears.

For `web` and the SPA adapters an accessible UI helps: buttons with text or `aria-label`, fields with `<label>`, dialogs with a title. Where that's missing, `data-testid` makes a target unique. Otherwise the index among equal matches remains, and it breaks as soon as the order changes. No adapter uses generated classes and ids (`_ngcontent-…`, CSS module hashes, `:r1:` from `useId`).

**Dev server instead of bundle:** Test a bundled application (Vite, Angular CLI, webpack) locally directly against its dev server, e.g. `http://localhost:5173`; it reaches the backend through the dev server's proxy, even a remote one. `http` is allowed only on your own machine: `localhost`, `127.0.0.1` or a name under `.localhost` (e.g. `app.localhost` if several applications need separate cookies). Chrome always reaches these names via `127.0.0.1`; if the dev server listens only on `::1`, start it with `--host 127.0.0.1`.

## Appendix: workbench, console and report page

What you see and press while a run has a window, and what it prints in the terminal.

### The workbench

With chat, everything runs on one page, like Cypress:

- **Top:** the caw logo, then `/ project / test` and a badge with what the run does ("Claude Code records", "Check run", "Develop"); the full sentence ("Claude Code records morning-errand") is its tooltip. On the right the facts in mono (the environment and the role only when the project has several, a production environment always, your local build only under an overlay), a status pill with a dot and a word ("Claude Code working", "Your turn", "S3 failed", "All passed"), the REC/PLAY/PAUSE chip and the ⋯ menu.
- **Left:** the steps with their state (running, passed, failed, not reached) and their duration. After the handover a step that can be opened offers "Open up to S3" when you point at it (as F1 does).
- **Center:** the application in an iframe with its address above it; on a production or read-only environment the address carries a badge. Below it the counts, e.g. "12 requests · 1 console": a click on them (or F2, F3) opens requests (name, outcome, duration) and console (errors and warnings) in a drawer. On a console error the drawer opens by itself; Esc (or "Esc closes" in the drawer) closes it.
- **Right:** the chat with the agent.
- **⋯ menu** (also Ctrl+K): every function with its key, in two groups. Run: Pause (F9), Reload app (F5), Cancel run (Esc) and, after the handover, Open… (F1). View: Requests (F2), Console (F3), Hide steps (F4), Hide chat (F6), App only (F8). Below them Animations off (F10), Settings (Ctrl+,) and Keyboard shortcuts (?). Arrow keys move, Enter picks, Esc closes. The keys also work while the focus is in the chat.
- **Collapse:** a click on the title "Steps" or "Chat" (or F4, F6) collapses the pane to a narrow strip. When the chat needs you, it opens by itself.
- **App only:** F8 shows only the application, with one line above it and "Back to workbench F8". **Chat** in that line (Ctrl+J, also with the focus in the app) shows the same chat floating over the app at the bottom right, 380 × 520; Esc, Ctrl+J or × hide it again. A dot on Chat says the agent wrote while it was hidden. A decision or the end of the run shows it by itself, so the close countdown never runs out unseen. The bar also says who answers when your session is attached ("Claude Code connected · k7f2"). The window keeps the choice until it closes; a new run starts with the chat hidden.
- **Reload:** F5 (also Ctrl+R, inside the application and in the chat, ⋯ → Reload app, or `/reload` in the chat) reloads the current page without cache after handover; chat and steps stay. While the test is running, also while "Open again" or F1 restores a state, this is blocked and the menu item is greyed out: a reload would corrupt the state for the following steps. If someone reloads the whole workbench via the browser, caw rebuilds it; if the test was running, it aborts without a result.

### Settings

Ctrl+, (or ⋯ → Settings, `/settings` in the chat) turns the workbench into its settings page; Esc or "Back to the run" returns. The page is yours, for every project, and names the `prefs.json` it saves to. It changes only how the workbench looks; everything else it shows read-only:

- **General:** Appearance System, Light or Dark, applied at once to workbench and chat (System follows your operating system until you pick Light or Dark); Animations (F10); the language with where it comes from (`CAW_LANG`, `prefs.json`, `caw.config.json` or the system), read-only. Layout: whether the steps panel (F4) and the chat panel (F6) are open when a run starts.
- **Agent:** "Ask before Claude Code uses tokens", read-only: "Don't ask again" in the notice turns it off, removing `tokenNotice` from `prefs.json` brings it back. The workbench cannot change it, because it shares its origin with the application under test. With an agent, the agent of this run (from `--agent` or the config).
- **Notes for Claude Code:** your own `caw.md` and the project's `caw/caw.md`, each with its path and number of lines, never its content; "Copy path" copies yours.
- **Keyboard:** the keys below.
- **This run**, read-only: project, environment with its switches (Agent allowed, writable, production), role, code and version.

Light and dark: the workbench, the chat, the report page and the "caw explore" card follow your system unless you set a mode; the choice is `mode` in `prefs.json` (`system`, `light` or `dark`).

### Keyboard

| Key | What it does |
|---|---|
| F1 | Open… a test or a step (after the handover) |
| F2, F3 | Requests, console |
| F4, F6 | Collapse or expand steps, chat |
| F5 | Reload the app without cache (after the handover) |
| F7 | Target design beside the app, over it, hidden (`open … --design`) |
| F8 | App only, and back |
| Ctrl+J | In App only: show or hide the chat over the app |
| F9 | Pause or continue the agent |
| F10 | Animations off or on |
| Esc | Closes the open menu, dialog, settings page or drawer, cancels picking an element; otherwise asks to cancel the run, and a second Esc within 4 seconds confirms |
| Ctrl+K | The ⋯ menu |
| Ctrl+, | Settings |
| ? | Keyboard shortcuts (not while typing) |
| Ctrl+↵ | Chat: the main action, while the input is empty (Cmd+↵ on a Mac) |
| Alt+↵ | Chat: sends your text as a checkpoint while you demonstrate |
| / | Chat: the commands, at the start of the input |

F11 and F12 stay with Chrome. The DevTools console starts in the workbench, not in the app; right-click → Inspect in the app switches it to the app frame. In the workbench and in the app frame, `caw` holds tools (`caw.help()` lists them):

| | |
|---|---|
| `caw.app` | The app's window: `caw.app.fetch('/api/…')`, `caw.app.document.title` |
| `caw.info` | Project, test, running step, mode, run folder, environment, URL, role, framework, version. Names only, never passwords |
| `caw.requests()`, `caw.console()` | The lists behind the counts in the footer |
| `caw.locator(el)` | The locator caw would record for an element, e.g. `await caw.locator($0)` after Inspect |
| `caw.ready()` | The framework's ready probe and the open requests, right now |

The app shares its origin with the workbench and can read `caw` too, so it holds nothing secret and changes nothing.

The workbench lives at the application's own address, on its origin. Many applications access the top window (`top.Ext`, `parent.config`, `top.location.href`) because they believe they are inside the portal. In the workbench this works the same:

- **Same origin:** The browser doesn't block such access.
- **Global names:** The workbench passes through the application's global names that it doesn't have itself. So `top.Ext` is the application's `Ext`.
- **Address:** The workbench's address follows the application; `top.location.href` is correct.
- **Navigation:** If the application redirects the top window (`top.location = …`, a form with `target="_top"`, also via POST), the page lands in the application and the workbench stays. A running test goes on; only a reload by you (F5, the browser's button) makes it invalid.

The tool serves the workbench: only the top window's document is intercepted, no other request. So the application can be embedded, the test browser strips `X-Frame-Options` and `frame-ancestors` from the CSP of its hosts' documents, in this browser only.

The chat sits in an isolated iframe with its own origin (`sandbox` without `allow-same-origin`). The application can neither reach its DOM nor decide there as the human. Sharing the workbench's origin, it can remove the iframe's sandbox or reload it; the tool writes the chat only into a document with an opaque origin and checks that in a script the page can't touch. If the chat frame was reloaded or lost its sandbox, the run ends with `chat-tampered`. Messages from workbench and chat never count as application errors.

**With chat, always the workbench.** Without chat (`--no-chat`, CI, `--headless`) the application runs alone in its own window.

**Limits:**

- iframes inside the application whose host isn't allowed stay empty.
- Whatever a page does only at the top of the window (`window.top` checks, frame busting via script) may behave differently in the iframe. Turn such checks off in the test environment.
- The workbench is served by caw, so Chrome counts it as a public page and its private network check (Local Network Access) would block the application in an intranet or on this machine. The test browser grants that permission to the application's origin only.

### The chat

On the right of the workbench, even in a test run without the agent. The history carries over across the workbenches of demonstration, the agent and check run. The agent's log also appears there: text as messages, commands as expandable actions. The window is the only source of instructions; the application page can't reach the chat. The transcript is saved as `chat.log` in the run folder.

- **Your context on the approval card:** Every message you wrote while showing or describing gets a mark on the card (✎) with what the agent made of it: the note of a step, its retry, the test's notes, or "only for this recording". The agent has to account for each of them; a plan that leaves one out is rejected.
- **Demonstrate:** Clicks, double-clicks, field changes, files chosen from `caw/fixtures` and the keys Enter, Tab, Escape and the arrow keys are captured (arrows not in a native select list, whose choice is captured as the field change). A message gives the agent context at this point of the path. Alt+↵ (or `/checkpoint` in front of the text) sends it as a checkpoint instead: a future step with a screenshot there; type first what should be visible. "Finish demo", the main action above the input, ends the demonstration. While it runs, "● RECORDING – your clicks count" shows above the application. Password fields never leave the page. All other input goes to the agent and into the recording, so demonstrate with test data only.
- **Write a message:** The agent reads it before its next action, since until then the tool rejects every browser command. If the agent is thinking, this takes a moment.
- **Pause:** While the agent works, "Pause F9" sits in the status line above the input (also F9 or `/pause`). The agent stops before its next action; the status pill shows it. Then you can write and click in the application until you press "Continue". Your clicks go into the test, so only click once "Paused" is shown.
- **Main action:** The one thing to do next ("Done", "Approve plan", "Finish demo", "Hand over to Claude Code", "Continue") sits full width above the input; Ctrl+↵ triggers it while the input is empty.
- **Commands:** `/` at the start of the input opens the commands: `/element`, `/checkpoint`, `/pause`, `/open`, `/requests`, `/console`, `/reload`, `/app`, `/settings`, `/keys`, `/cancel`, each with its key. Arrow keys and Enter pick, Tab completes, Esc closes; a command that is not possible right now is greyed out. `/open`, `/requests`, `/console`, `/app`, `/settings` and `/keys` open that view in the workbench, like their keys.
- **Cards:** plan, question, advice (with a diff for a code change), failure, decision and the token notice come as cards. Each card has one primary action; one other choice sits beside it, more go behind "More".
- **Mark element:** During demonstration, plan, pause, question and failure clarification, `/element` picks the component you mean: a ring with a label (role and name, e.g. `button "Add todo" in dialog "New todo"`) shows what a click would pick, and a band at the top of the application says that the click does nothing there and Esc cancels. The click isn't recorded. The element shows as a chip above the input (× removes it) and is attached to your next message; the agent gets its description.
- **Questions:** The agent asks via `ask-operator`. Your answer or "Done" releases the run.
- **Step back:** There is no rewind. Tell the agent what was wrong: it goes to the right state and drops the detour with `omit`. What was submitted stays in the application; then only a new run helps.
- **Cancel:** Esc (or `/cancel`, ⋯ → Cancel run) asks "Really cancel? (Esc)"; a second Esc or a click on it within 4 seconds confirms and ends everything immediately with `error`. Closing the chat has the same effect; without it there is neither approval nor decision.

The human's time counts toward the agent's limit, so the default here is 60 minutes (`--agent-timeout 60m`).

### Console output

In a terminal a run reads like the workbench: the head with the version, the mode in bold, what caw is doing, then the "Run" rule with one line per step and its duration, the reason under a failed step, the summary, the report and what to do next:

```
● caw · Context-Aware Web Testing · <version>
  › Mode on local (team language en): no window and no chat (--headless); learns: no.
Replay without Claude Code · first-errand on local as user · team language en
Code: dev server localhost:4874, your current version

  › Opening Chrome and signing in ...
  › Replaying the recording (19 steps, recorded on local) ...
    ›  1/19 click button "New todo" +0.0s
    …

Run ────────────────────────────────────────────────
  ✓ S1  Add a todo     4.0s
  ✓ S2  Find it        1.5s
  ✕ S3  Tick it off   32.1s
      └ Not met after 30 s: …
  ○ S4  Plan it      not reached

Failed. 2 of 4 steps passed. · 39.9s
report  .caw/runs/<run>/report.md
        file:///…/report.md
next    S3 failed. Find the cause: caw run first-errand --env local in the terminal, …
        Up to the entry of the step: caw open first-errand@S3 --env local
```

The marks are ✓ passed, ✕ failed, ! warning and ○ not reached. In files and pipes it stays plain lines prefixed with `[caw]`, with `Report:` before the report's path. `NO_COLOR` turns colors off, `FORCE_COLOR` forces them.

### The report page

"Open report" on the end card opens `report.md` as a page in a new tab of the same browser, in your light or dark mode. At the top the logo, "Report" and the path; then the title with a badge (passed, failed, error, or a reproduction's verdict), the lines below it, tiles for passed, failed, not reached and write requests, and the steps with their badges. Hard errors and warnings are lists with icons, write requests are in mono, and screenshots the report links appear as thumbnails. Read-only runs, reasons and notes are banners. The page only shows what `report.md` says; the file itself is unchanged.
