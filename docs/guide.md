English · [Deutsch](guide.de.md)

# Guide

How caw-ai works in detail. For quick lookup see [Commands](commands.md), [Configuration](configuration.md) and [Test files](test-files.md).

## Agent: local, Docker or your session

Where Claude runs when a run needs it is set by `agent.sandbox` in the config (`local` or `docker`, default `local`). `--agent local|docker|session` overrides it for one run. In CI (`CI` set) it is always `docker`; other values abort.

| Agent | How Claude runs | Good for |
|---|---|---|
| `local` | `claude -p` on your machine with your login. Only the tools `Read`, `Grep`, `Glob` and the caw tool: no shell, no writing, no web, no hooks, no other MCP servers. | everyday work on your own machine |
| `docker` | `claude` in a container with a firewall, token from `CLAUDE_CODE_OAUTH_TOKEN` | CI, nightly runs, and anyone who doesn't want Claude on their own system |
| `session` | No Claude process of its own. Your open Claude Code session takes the role via the MCP server `caw-ai mcp`. | recording, fixing and developing in your usual IDE session |

In all three cases the browser is the actual boundary: Claude sees the application only through the fixed commands and can navigate only to allowed hosts (see [Sandbox boundaries](#sandbox-boundaries)).

```json
"caw:shop:smoke": "caw-ai run shop-smoke --target local",
"caw:shop:smoke:record": "caw-ai record shop-smoke --target local",
"caw:shop:smoke:fix-docker": "caw-ai fix shop-smoke S2 --target local --agent docker"
```

In CI (`CI` set) `run` runs without chat and without Claude; `agent.sandbox` only applies there if a run does need Claude, and then always as `docker`.

**Personal settings:** What you set for yourself in the workbench is stored per user in `prefs.json` under `CAW_AI_HOME`, otherwise `%APPDATA%\caw-ai` (Windows) or `~/.config/caw-ai`: "Animations off" (F10: the raven stops blinking, no spinner, no blinking cursor), collapsed steps or chat, and the theme (F7, see [Themes](../themes/README.md)).

**Token notice:** Before Claude works (record, fix, investigate a failure, questions in the chat, `--advise`), the chat asks once per run: "Continue", "Don't ask again" or a decline that says what it does: "Continue without Claude" (investigate a failure, questions in the chat) or "Cancel run" (record, fix). "Don't ask again" sets `"tokenNotice": "off"` in `prefs.json`; remove the entry to get the notice back.

**Try it** without a project of your own: `examples/notizen` in the repository, a small app with login and one test.

### From your Claude Code session

`init` adds the MCP server to the project's `.mcp.json` (`node node_modules/caw-ai/bin/caw-ai.mjs mcp`). Your session then has these tools:

| Tool | Purpose |
|---|---|
| `caw_start` | starts `run`, `record` or `fix` in the background with `--agent session`; the window opens on your side |
| `caw_status` | whether a run is waiting for the session, with its task, and the last lines of output (`.caw/session-*.log`) |
| `caw` | the agent's commands (`snapshot`, `click`, `plan`, `finish` …), as described in the skill |
| `caw_selection` | the element you picked with the crosshair in the workbench while developing |

So in your session you write "record a test for the order" or "take me to S4 of bestellung", and the skill does the rest. If you start the run yourself in the terminal with `--agent session`, the chat shows that it is waiting for the session; then tell it "take over the caw run" (it finds it with `caw_status`).

- **Waiting:** `plan` and `chat` wait for you for up to an hour. If Claude Code cancels the call earlier, raise `MCP_TOOL_TIMEOUT` (milliseconds) in Claude Code's environment.
- **Caution:** Your session has more rights than the agent in a run (shell, writing). Whatever comes from the application is data to it, not an instruction; caw-ai tells it so with every task. Have Bash and write calls in this session confirmed instead of allowing them wholesale.

## Docker

Only for the `docker` agent. The Docker daemon must be running; the tool doesn't start it. It starts and removes the container itself.

On Windows the tool takes the first route whose daemon answers: `docker.exe` first, then Docker in WSL. Which one is shown at the start of the output. Pin it with `CAW_DOCKER=windows` or `CAW_DOCKER=wsl`.

This check runs before anything else and aborts with its own message (exit 2):

| Code | Meaning |
|---|---|
| `docker-missing` | No Docker found |
| `docker-not-running` | Docker is there, the daemon doesn't answer |
| `docker-wrong-mode` | Docker Desktop is set to Windows containers; the sandbox needs Linux containers |

## Three modes

| Command | What happens | AI and chat | Environment |
|---|---|---|---|
| `record <test> --target <env>` | Record a new test plan or replace one | always | only environments with `claude` |
| `run <test> --target <env>` | Test run by plan, optionally up to a step | On environments with `claude` the chat sits alongside from the start; Claude only after your message, your click on "Let Claude find the cause" or "Fix step", or with `--advise` | all |
| `fix <test> <S4> --target <env>` | Change exactly this step. If it has a valid recording, `fix` first replays up to it: if it fails, the chat clarifies the cause as in `run`; only a passed or outdated step is re-recorded | always | only environments with `claude` |

`open --target <env>` opens the app signed in, with workbench and chat but without a test, see [Commands](commands.md#open).

`<env>` is a name from `environments`, e.g. `local`. With tenants (`sites`) the target is `tenant/env`, e.g. `nord/dev`.

**Test plan** means one YAML file per test under `caw/tests/<test>.yaml`. It holds the test steps; their recording is in `caw/recordings/<test>.yaml`, see [Test files](test-files.md).

```bash
# New test: demonstrate, approve the plan, adopt at the end
# (--role and --app can be omitted if caw.config.json has only one role or app)
caw-ai record bestellung --target local --role kunde --app shop --also backoffice

# Test without AI
caw-ai run bestellung --target local

# Test; on errors or warnings Claude advises in the chat (costs tokens)
caw-ai run bestellung --target local --advise

# Test without chat as in CI, with or without a visible window
caw-ai run bestellung --target local --no-chat
caw-ai run bestellung --target local --headless

# Reach a state and keep working on local code there
caw-ai run bestellung --target local --until S4

# Change one specific step
caw-ai fix bestellung S4 --target local
```

In Claude Code one sentence is enough: `/caw-ai take me to where the cart is filled`. The skill finds test and step and starts `--until`. If nothing fits, it suggests `record`.

## How you work with it

1. Start the app's dev server where you develop: in the devcontainer or on Windows.
2. Call it from PowerShell in the project folder: `pnpm caw:my-app:smoke`. Chrome opens maximized and you watch the test.
3. Change something and repeat step 2.

The call doesn't work inside the devcontainer itself: Chrome is missing there (and, for the `docker` agent, Docker). For `docker` from Windows: Git Bash has so far ended with exit 139 while building the image; use PowerShell.

### Take over and keep developing

`pnpm caw:my-app:smoke --handover` leaves the window open after the verdict:

- **Keep clicking:** You continue in the same page and the same form state, including unsaved input and DevTools.
- **Keep developing:** Against your dev server as the environment, F5 loads your current code. With `--overlay` the local code stays in place until you close the window, and F5 loads the current state of the build folder or dev server. There is no automatic reload apart from the dev server's hot reload.
- **State:** F5 loses whatever existed only in the browser, such as open dialogs and unsaved input. "Restore state" in the chat or a new test run brings you back.
- **End:** Closing the window ends the run. The exit code remains the verdict.
- **Keyboard in the chat:** Ctrl+Enter (Cmd+Enter) triggers the main button, e.g. "Approve plan" or "Finish demo"; that button shows `Ctrl+↵`. Esc first clears the input field if you are typing in it. Otherwise Esc requests cancellation ("Really cancel? (Esc)" and "No"); only a second Esc within 4 seconds confirms it. New choice buttons get focus unless you are typing.
- **Your turn:** When the chat waits for you (plan, decision, clarifying a failure), "YOUR TURN" shows in the header and above the application, and the terminal prints once "Waiting for you in the Chrome window: …".
- **Record, play, pause:** A chip at the top right of the workbench shows what the run does: "● REC" while Claude records or fixes, "▶ PLAY" while caw-ai replays (run, check run, restoring a state), "❚❚ PAUSE" while such a run is paused (F9). When nothing runs (after the run, after the handover, after cancelling) there is no chip.
- **After the run:** The outcome is the last line in the chat, e.g. "Saved: caw/tests/bestellung.yaml". The window stays open for 15 seconds with "Close window" and then closes itself. If a new window is about to open (for Claude or the check run), chat and terminal say so first.

You can open your own tabs at any time, even during a run: only the application tab and its popups are controlled, and only their errors count. Clicking in the application tab while a run is working, however, affects the test.

In the window you stay behind the same host lock and are signed in as the test user. Playwright dismisses dialogs like `alert()` automatically, so they never block. The profile is fresh and deleted at the end. If it is left behind, e.g. after an abort, the next run removes it once its process is gone.

## What a run does

A run with Claude, i.e. recording and fixing, does the following:

1. **Reject what must not run:** config, test file, target and write protection are checked; for the `local` agent also whether Claude Code is present.
2. **Image** (`docker` only): built once from the project's image plus Claude and the container part of the tool. Rebuilt only when these change.
3. **Open:** with `--overlay` get the source ready (dev server, build, Sencha watch), start Chrome, sign in, open the page; with `--overlay` check after the first load that local code arrived. Failures here yield `error` without spending tokens.
4. **Start Claude:** With `local`, `claude -p` starts on your machine with the locked-down tools (see [Sandbox boundaries](#sandbox-boundaries)); with `session` the run waits for your session. With `docker` the container starts (`docker run --rm`): set the firewall, then the container drops all privileges. If the sandbox isn't provably sealed, Claude doesn't run.
5. **Test:** `claude -p` works through the plan; every browser command goes to the host as a file over the channel. The host checks the verdict.
6. **Finish:** Claude ends immediately with the verdict (process or container). Report, trace and `floats.log` (clicks and, with `extjs`, the order of floating windows with timings, no content) are under `.caw/runs/<run>/`. The trace (`trace.zip`) contains page content, requests and cookies of the test account; don't share it. With `auth.type: basic` it records no snapshots, so the password from the Authorization header doesn't end up in it. Screenshots and `claude.log` are under `agent/`. The log is written continuously and shows Claude's text and commands with seconds since start; the same lines appear in the terminal. A closing summary after the verdict is not included. Terminal output is colored, the file has no color codes; `NO_COLOR=1` turns colors off. Chrome closes as well.

Exit codes: `0` pass, `1` fail, `2` error (the environment is to blame), `3` input rejected, `4` needs recording (`record` or `fix`).

### Error codes and remedies

All error codes with fixes: [Commands › Error codes](commands.md#error-codes).

## Recording a test plan: `record`

You name role and app only the first time; the tool writes the metadata (`targets: [<target>]`, `mutates: true`). A re-recording keeps it. Claude Code or Docker, token and image are checked up front so your demonstration isn't wasted.

1. **Start.** Chrome and the chat open, you are signed in. For a new test you demonstrate right away. For an existing one the chat first asks: "Show it myself" or "Claude follows the test plan".
2. **Plan.** Claude presents the draft as a card in the chat: per test step ID, title, action and one expected result, plus notes on assumptions and open questions. The plan is the future test file without recording: YAML with `notes` and `steps`. Metadata or recordings Claude puts there are discarded by the tool. You approve or write what should change, and Claude presents a new version. Until approval the host rejects every action in the application with `plan-required`; reading is allowed.
3. **Execute.** Claude walks the path in a fresh browser. You can pause, write, mark elements and click. If the path changes fundamentally, Claude presents a new version. All actions since the last check belong to the plan's next step, so Claude must check in that order (`step-order`).
4. **Clean up.** Claude goes through the actions on its own and states in the chat what will be dropped, without needing your approval. The tool itself removes screenshots and the first of two `fill`s on the same field.
5. **Check run.** The tool replays the recording without Claude; the chat shows progress. If a step fails, the chat offers to fix it, even in the not-yet-adopted draft.
6. **Replace.** The chat shows a "Check run passed" card with what would be adopted; warnings and actions picked by position can be expanded. Then "Adopt test plan (N steps)" or "Discard draft", which a second click confirms. Only then is the test file written. If the check run doesn't pass, the old test plan stays untouched; plan (`plan.yaml`) and draft (`test-draft.yaml`) remain in the run folder. Nothing is committed automatically.

**Test data:** Runs with `mutates: true` leave data behind: one record each from Claude and from the check run, up to two more per fix. Whatever Claude dropped also happened in the application.

### The workbench

With chat, everything runs on one page, like Cypress:

- **Top:** test, target, role, code state (local or as deployed at the address), "Animations off" and "Refresh".
- **Left:** the steps with their state (running, passed, failed, not reached), below them the counters for requests and console.
- **Center:** the application in an iframe with its address. Below it requests (name, outcome, duration) and console (errors and warnings); on a console error the panel opens by itself, "Collapse" closes it.
- **Right:** the chat with Claude.
- **Collapse:** Steps and chat collapse to a narrow strip via the button at the edge. When the chat needs you, it opens by itself.
- **Refresh:** The button, F5 (also inside the application) and a click on the logo reload the current page without cache after handover; chat and steps stay. While the test is running this is blocked and the button is greyed out: a reload would corrupt the state for the following steps. If someone reloads the whole workbench via the browser, caw-ai rebuilds it; if the test was running, it aborts without a result.

The workbench lives at the application's own address, on its origin. Many applications access the top window (`top.Ext`, `parent.config`, `top.location.href`) because they believe they are inside the portal. In the workbench this works the same:

- **Same origin:** The browser doesn't block such access.
- **Global names:** The workbench passes through the application's global names that it doesn't have itself. So `top.Ext` is the application's `Ext`.
- **Address:** The workbench's address follows the application; `top.location.href` is correct.
- **Navigation:** If the application redirects the top window (`top.location = …`, a form with `target="_top"`, also via POST), the page lands in the application and the workbench stays. A running test goes on; only a reload by you (F5, the browser's button) makes it invalid.

The tool serves the workbench: only the top window's document is intercepted, no other request. So the application can be embedded, the test browser strips `X-Frame-Options` and `frame-ancestors` from the CSP of its hosts' documents, in this browser only.

The chat sits in an isolated iframe with its own origin (`sandbox` without `allow-same-origin`). The application can neither reach its DOM nor decide there as the human. Messages from workbench and chat never count as application errors.

**With chat, always the workbench.** Without chat (`--no-chat`, CI, `--headless`) the application runs alone in its own window. A chat in a separate window no longer exists.

**Limits:**

- iframes inside the application whose host isn't allowed stay empty, as before.
- Whatever a page does only at the top of the window (`window.top` checks, frame busting via script) may behave differently in the iframe. Turn such checks off in the test environment.
- For the iframe, the test browser disables the private network check (Local Network Access).

### The chat

On the right of the workbench, even in a test run without Claude. The history carries over across the workbenches of demonstration, Claude and check run. Claude's log also appears there: text as messages, commands as expandable actions. The window is the only source of instructions; the application page can't reach the chat. The transcript is saved as `chat.log` in the run folder.

- **Demonstrate:** Clicks, field changes and the keys Enter, Tab and Escape are captured. A message gives Claude context at this point of the path, "Add checkpoint" sets a future step with a screenshot there; first type into the field what should be visible. "Finish demo" ends the demonstration. While it runs, "● RECORDING – your clicks count" shows above the application. Password fields never leave the page. All other input goes to Claude and into the recording, so demonstrate with test data only.
- **Write a message:** Claude reads it before its next action, since until then the tool rejects every browser command. If Claude is thinking, this takes a moment.
- **Pause:** Claude stops before its next action; the status in the window shows it. Then you can write and click in the application until you press "Continue". Your clicks go into the test, so only click once "Paused" is shown.
- **Mark element:** During demonstration, plan, pause, question and failure clarification, "Element" picks the component you mean: the next click in the application does nothing there and isn't recorded; Esc cancels. The element is attached to your next message; Claude gets its description.
- **Questions:** Claude asks via `ask-operator`. Your answer or "Done" releases the run.
- **Step back:** There is no rewind. Tell Claude what was wrong: it goes to the right state and drops the detour with `omit`. What was submitted stays in the application; then only a new run helps.
- **Cancel:** ends everything immediately with `error`, after a confirmation in the window. Closing the chat has the same effect; without it there is neither approval nor decision.

The human's time counts toward Claude's limit, so the default here is 60 minutes (`--timeout`).

### What goes into the recording

- **Recorded:** successful `click`, `fill`, `type`, `press`, `goto`, `reload`, `wait-ready`, `remember` and `check`. Failed attempts, `eval` and `snapshot` are left out.
- **Completeness:** Saved only if every step has a passed `check` with no action after it. Otherwise the output names what's missing and the run ends with `fail`.
- **Stable targets:** Instead of references, the file stores how a human finds the element, depending on the [framework](#framework-web-react-vue-angular-or-extjs): for `web` role and name, e.g. `{role: button, name: Senden, inside: {role: dialog, name: Neue Bestellung}}`, for `extjs` the component, e.g. `{xtype: combobox, label: Land*, part: input.x-input-el}`. List entries are thus tied to their text; if the data changes, the step fails.
- **Detours:** On submitting, Claude names what doesn't belong to the path (`"omit": [12, "14-16"]`). If all steps passed, `omit` is required, even empty, and the rejection shows Claude the full action list. Checks and `remember` can't be dropped. The report lists everything dropped. If Claude misses a detour, it stays in. The check run proves the path works, not that it is the shortest: review the file before committing, because its expressions later run in the signed-in page without Claude.
- **Run tag:** Each run has its own `runTag`, e.g. `CAW-20261105185233`. Claude writes it into free-text fields that identify a record. The recording stores `{{runTag}}`, and every replay substitutes its own value, so a run finds its own record instead of an earlier one. If the application turns the name into a lowercase address (`/akten/akte-caw-20261105185233`), it stores `{{runTagLower}}`.
- **Dates relative to today:** A date at most 60 days before or after the recording day (`DD.MM.YYYY` or `YYYY-MM-DD`) is stored as `{{today}}`, `{{today+7}}` or `{{todayIso-1}}`. Replay substitutes the date of its own day, so a test doesn't fail the next day on "date is in the past". Dates further away stay fixed.
- **Values from the run:** An order number is new in every run. Claude reads it with `remember bestellnr "<expression>"`; the recording then stores `{{bestellnr}}` with the expression, and replay reads the value from the page again. The command rejects values shorter than four characters.
- **Project context across tests:** `caw/caw.md` is to the tests what CLAUDE.md is to Claude Code: relevant project information and quirks of the applications. You maintain it by hand and check it in, e.g. "search remembers the last input". Claude gets it in every run with Claude. The file isn't part of the step hash, so changing it invalidates no recording. If a note affects the path, re-record. Behavior only, no personal data.
- **Two apps in one test:** If the path leads into a second app of the project, name it on the first `record` with `--also verwaltung` (in the test file `also: [verwaltung]`). With `--overlay` its local code comes along too, if it has a source. The app needs an entry in `apps`, but no `startUrl`.

**Limits:**

- **Claude can write while exploring.** There is deliberately no write lock: in many applications submitting and follow-up steps depend on each other, and reading and writing requests often look the same at the HTTP level. Instead: recording only on environments with `claude` and only with test accounts, the skill rule "own records only", plan approval, the step budget, and the report lists under "Write requests" every call other than GET, HEAD and OPTIONS and every one with a key from `requestKeys`, without parameter values. Sign-in, sign-out, session and token (paths ending in login, logout, session, token, auth, refresh, csrf and similar) don't count: they don't make a test a writing one.
- **Step budget:** `--max-steps` (else `maxSteps` from the config, else 100) counts Claude's `click`, `fill`, `type`, `press`, `goto` and `reload`, failed ones included. What you demonstrate yourself doesn't count.
- **Claude doesn't react instantly:** `claude -p` runs without input; message and pause take effect before the next action. "Cancel" takes effect immediately.

## Test run: `run`

Replays the recording without model, Docker or token. On environments with `claude` the chat sits next to the window from the start, except in CI (variable `CI` set), with `--no-chat` or `--headless`. The first terminal line states the mode and whether the run learns baselines (`--no-learn` turns that off), the last one what changed in the test files. The chat shows each action (`S3 · 4/12 click …`) including retries; input is locked. If the run passes, the chat reports it along with warnings and doesn't wait; it closes with the run or, with `--until` and `--handover`, stays next to the handed-over window. If a step fails, see [Fixing a step](#fixing-a-step). If the recording is missing entirely, it ends with exit 4 and names `record`. If a step is outdated, it ends with exit 4 and names `fix` for exactly that step.

- **Waiting:** There are no fixed pauses. A step waits until its target is visible and not covered. That covers load masks, overlays and dialogs within dialogs, since only the topmost dialog is clickable. `check` retries until it holds or the time limit expires.
- **Time limits:** 30 seconds per step by default, changeable with `--step-timeout`, or by hand per action with `timeoutMs` and per check with `recording.timeoutMs` in the test file. If Claude clarifies or fixes from within the run, `--timeout <minutes>` (default 60) and `--max-steps <n>` apply as for `record` and `fix`.
- **Errors:** If a step fails, the report names the test step with its action and points to a screenshot. Cleanup steps like "Cancel" then no longer run; a created record may stay open.
- **Failures:** Console errors, script errors, failed requests and HTTP status 500 and above stop replay at the next step. So do visible dialogs, error messages and messages from `messageSelectors` that didn't occur during recording (numbers in the text don't count). With the `web` adapter a status notice (`role=status`, `aria-live=polite`, e.g. a success toast) is not a failure: it appears or not depending on timing; an unknown one appears once as a warning in the report. A dialog with input fields is interaction, not a message. Also: lost login, an application that didn't load (`extjs`: no ExtJS on the page), a stuck load mask (`aria-busy`, with `extjs` the load mask), a different page than recorded, and every unmet `check`.
- **Fixing:** If a step fails, see [Fixing a step](#fixing-a-step).
- **Without chat:** `--no-chat` replays in a visible window as in CI, without chat and without Claude: report, screenshot, a hint to run with chat to find the cause (`fix` only for an intended change), exit code. `--headless` likewise, but without a window, at a fixed 1920×1080. Neither works with `--advise`, `--handover` or `--until` (exit 3). Whether an application accepts headless mode only shows in the run; otherwise use `--no-chat`.
- **Limits:** Only what was recorded is replayed. Claude's eye for anything odd is missing, and write protection and host lock apply here too. Toasts that disappear between two steps are not seen by replay.

### Reaching a state and taking over

```bash
caw-ai run <test> --target local --until S4
```

The tool replays the recording up to the passed `check` of `S4` and hands over the window. Later steps don't run, so they may be outdated. The sequence is deterministic, the environment isn't: this is not a snapshot. The path runs anew each time with new data, and if the application deviates, the step fails visibly.

- **Code:** As in every run the deployed version, unless you add `--overlay`; against your dev server as the environment your current code anyway. The `Code:` line says which (see [Testing local code](configuration.md#testing-local-code)). You see changes with F5; the form state is gone afterwards. To get back, start the command again.
- **Path fails:** You clarify the error in the chat and can have the step fixed. If you close the chat, the window still goes to you and the report names the error. The exit code remains the verdict.
- **No recording:** exit 4, record first.
- **State after reload:** Whether a view keeps its state after F5 depends on the application.

`--handover` also hands over the window after a full test run. It applies only to `run`.

### Developing in the reached state

With chat, the chat stays open after handover (state "Develop"):

The workbench starts in **App only** (F8 brings steps and chat back); the browser window stays as it is.

- **Ask:** You ask Claude in the chat, ideally about an element you picked in the app with the crosshair button. Claude reads the source code and answers. It never changes code itself; it proposes verified changes: "Apply change" writes them into your project folder, "Copy prompt" hands them to you for your own session.
- **Let Claude use the page:** On request Claude clicks, fills in, presses keys, navigates or reloads, e.g. "click the selected button". It asks before anything that saves or deletes data.
- **Debug a bug:** Paste a bug ticket into the chat. Claude reproduces it in the reached state, looks at console, requests, component values and source, names the cause with file and line and proposes the fix as a change you apply with a click. Then reload or restore the state, and Claude checks whether the bug is gone.
- **Refresh** (button at the top, F5, click on the logo): reloads the current page without cache so your change shows immediately. Chat and steps stay; the test is already over and its result doesn't change.
- **Restore state** (in the chat): starts a new session (cookies and site storage cleared), signs in again and replays the recording up to the step, with new test data, exactly like any other run.
- **Choose state (F1):** any test of this environment, of any role, and optionally the step to stop at. caw-ai restores it in the same window with the account of the test's role. If restoring fails, Claude in the chat knows why; it can also adjust the test, e.g. mark a cookie-banner click optional, and the change goes into the test file right away.
- **Element to Claude Code:** With the crosshair button in the chat you click an element in the application (the click does nothing there, Esc cancels). It is attached to your next question in the chat, and caw-ai stores it with label, component or source, page and requests for your Claude Code session, retrievable with `caw_selection`.
- **End:** "End run" or close the window.

## Fixing a step

If a step fails in `run` or in the check run of `record` and `fix`, replay stops and the browser stays in the failure state. The chat says "S4 failed: <reason>" with hard errors and warnings and unlocks input (state "Clarify failure"), plus "Fix step" and "End run". Below it is the tool's [assessment](#assessment-test-application-or-environment) with its findings. If it points to an application bug, "Fix step" becomes only the second button, with a note that an adjusted test would merely hide the bug. This exists only on environments with `claude`; in CI, with `--no-chat`/`--headless` and on other environments there is only the exit code and the report.

- **Ask:** Only your message starts Claude, in the same browser and read-only as with [advice](#advice-on-errors-and-warnings). It answers in the chat, names cause, file and line, and can give advice cards. Each further message continues the same conversation until you press a button. The log is in `agent/claude-talk.log`. Without a message or click, no tokens are spent.
- **Fix in the same browser:** If nothing of the failed step has run yet, i.e. its first action failed without a hard error from outside, Claude fixes it right there, without a lead-in. The test run's report is kept as `report-test-run.md`. Otherwise, e.g. after half a sequence of actions or an unmet check, it proceeds as below with a lead-in in a fresh browser. The chat says beforehand which way it will be.

`fix <test> S4 --target <env>` starts the lead-in path directly, e.g. for a step changed by hand or newly added. The steps before it must be current. Since S4 didn't fail here, the chat says "Re-record S4" and Claude looks for no cause. If Claude presents the plan unchanged, it applies without approval: the chat says so, and you can still write if something should change. The approval card appears only if the step changes, likewise when fixing a failure.

Only what Claude tells you with `say` appears as a message in the chat. Its other notes are collapsed with the actions. If you cancel, the report says "Aborted by you."

1. **Prepare:** In a fresh browser S1 to S3 run without Claude; the chat shows progress. If a step before that already fails, that one is offered. Skipped when fixing in the same browser.
2. **Cause, then plan:** Claude gets only this step: text, previous actions, check, reason, assessment with requests, plus `caw.md` and the `remember` values read so far. It first clarifies the cause, including in the source code, and states it in the chat. If the application is at fault, it doesn't change the test but gives advice with a concrete code change and reports `fail`. Otherwise it presents only this step as a card. A changed result is marked there, shown at the decision and listed in the report.
3. **Execute:** Claude runs the step and cleans it up. If the result stays the same, the check must stay the same too, or `finish` rejects it. Likewise if a `remember` value needed by a later step disappears.
4. **Check run:** The whole test runs without Claude in a fresh browser, up to any step that may still be outdated. If another step fails, the offer comes again. If it passes: "Adopt test plan (N steps)" or "Discard draft".

Only the fixed steps change in the file; comments and all other steps stay identical character for character. New messages Claude sees along the way count as known afterwards; the decision lists them so no application bug slips through unnoticed.

- **Test data:** A fix costs up to two passes; writing steps before it create data accordingly. Tokens are spent only for this step. If a step fails after submitting, the record stays open; replay doesn't clean up.
- **Without Claude:** If Claude Code (`local`) or Docker or token (`docker`) is missing, the chat names the reason and the run stays `fail`.
- **Discard draft:** The test plan stays unchanged, after a confirmation ("Really discard?"). A previously failed `run` ends with `fail`.
- **Insert, delete, reorder:** Add a new step by hand and record it with `fix`. A deleted or moved step requires `record`, because later steps may build on it.

## Assessment: test, application or environment

If a step fails, the tool classifies the failure without Claude and without tokens. It uses only what every browser provides, independent of framework and environment:

- **Requests** of the application (`xhr`/`fetch`) with name, status, duration and outcome: answered, HTTP error, aborted, failed. The name is method and path; parameter values never appear in it, except for parameters from `requestKeys`. An abort caused by navigation doesn't count. Plus the **parameter names** without values, from the query and form bodies (`application/x-www-form-urlencoded`); JSON bodies are left out.
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

The strongest finding decides; the others are listed below it. Without notable evidence it stays "unclear". The assessment appears in the chat, as the "Assessment" section in `report.md` with a table of requests next to the recorded ones, in `result.json` and in Claude's task (`diagnosis`, `evidence`). Claude reads it there first and can fetch the latest requests with `network`.

Without `recording.network` the report says so. The baseline is never created while recording or fixing: under Claude's control misclicks and detours also run, which are dropped from the recording, and their requests didn't belong to the step. It is created without Claude and tokens in the next `run` with chat on an environment with `claude`, from the cleaned-up recording: every passed step without a baseline then gets one from this run, if it was recorded on the same target. The same goes for the effect per action. Chat and terminal name the steps; only this field changes in the file, the hash stays untouched. A `run` never overwrites existing values, unless they date from before parameter names (entries without `params`). Without chat, e.g. in CI, the file stays as it is.

### Effect per action

Every action (click, input, key) has an effect on the page. The tool measures it after each action once the page is idle, and stores it in `recording.effects`. The effect is the difference between before and after, without values:

| List | Content | Example |
|---|---|---|
| `controls` | State of visible controls: disabled, required, read-only, invalid, checked, expanded, selected, empty/filled. Elements in list and table rows don't count, since they are data, often someone else's. For a list only whether it has rows counts. | `+ input "Lieferadresse*" empty`, `+ list "Bestellungen" rows` |
| `view` | ARIA tree without links, field contents and long texts (lists are data) | `+ - text: Bestellung vollständig? …` |
| `requests` | answered requests of the action with status | `GET /api/orders 200` |
| `responses` | shape of JSON responses (key paths as a short hash) and domain error markers such as `success=false` | `GET /… form 3fa2c… success=true` |
| `console` | console messages | `error: Bestellung laden fehlgeschlagen` |

Numbers become `#`, so order numbers and dates don't interfere.

**Learning:** A passed `run` with chat on an environment with `claude` records the effect. The first two healthy runs are reconciled: only what was equal in both is kept; the console collects everything that occurred. The effect then counts as learned (`runs: 2`) and no run changes it any more. A newly recorded step learns anew.

**Comparison:**
- If something from the learned effect is missing during replay, that is a deviation, as is a new console message.
- If a step fails, the assessment names the first deviating action up to that step (application, likely) and what happened instead. Claude gets it as `evidence.effect`.
- If the check holds, the kind of deviation decides. If a learned effect deviates in a list from the config's `effects.fail`, **the step fails** (assessment: application, likely; different data than when learning can also explain it, e.g. a list that was empty back then). Default is `["controls", "console"]`: the state of controls and new console messages. These signals were completely stable in healthy runs. Deviations in `view`, `requests` and `responses` stay warnings in the report, so drift shows up before a check breaks. With `"effects": { "fail": [] }` all deviations stay warnings.
- **Retries (`retry`)** change the application, e.g. an entry is opened a second time and thereby locked. So after the first retry in a run: steps that run again only as lead-in (with `retry.from`) are neither compared nor learned; later steps only warn; only the retried step itself still fails on its effect. If it deviates the same way twice (measured by the lists from `effects.fail`), there is no further attempt.
- **Self-cleaning:** If a whole run passes without retry and a step deviates only in lists outside `effects.fail`, that evidently fluctuates. The missing lines drop out of the learned effect, e.g. a request that doesn't come in every run. So the warning appears only once. Deviations in lists from `effects.fail` remain findings.
- Otherwise a step with a learned deviation doesn't learn, so no error disappears from the comparison. To accept a changed effect, choose **"Accept new effect"** in the chat. The button appears when only the effect deviates and the check holds. It deletes this step's `effects` from the file, without Claude and without tokens; the next two healthy runs learn it anew. Without chat, do the same by deleting `effects` from the file.

## Advice on errors and warnings

Without fix parameters nothing costs tokens as long as you don't write or click: on a failed step a `run` shows the reason, hard errors and warnings in the chat. Claude advises on its own only here, and in conversation when you ask:

| Run | When |
|---|---|
| `run` and "Let Claude find the cause" | A step failed and you click the button in the chat. If the assessment is "application", it is the main button, otherwise it sits next to "Fix step". Then as with `--advise`: cards, and "Test again" after an adopted application change |
| `run … --advise` | Without a click: a step fails, a hard error occurs or there are warnings, even in a passed run. For runs whose result you only look at later. Only on environments with `claude` and with chat (not in CI), otherwise exit 3 |
| `fix <test> <S4>` and "Fix step" | Errors or warnings while fixing and in the check run afterwards |
| `record` | only once you choose "Fix step" in the check run |

Claude works in the failed run's browser, so the state is still there. It may only read (`snapshot`, `eval`, `console`, `network`, `screenshot`, `url`); the host rejects everything else with `advise-only`. It reads the source code read-only as always and looks for the cause there, whatever the framework. Its log is in `agent/claude-advice.log`.

Every piece of advice names its evidence (`evidence`), e.g. a request, a hard error or a location in the code; without it the host rejects it. Each appears in the chat as a card, one after another:

- **Test:** title, rationale, evidence and the change as before/after, plus "Accept" and "Discard". Possible are `name`, `do`, `expect`, `note` and `retry` of an existing step, the test case's `notes`, an entry in `caw/caw.md`, and a pattern in `consoleIgnore` or `foreignCode`. If the assessment clearly points to an application bug, the card marks the advice as contradicting it.
- **Application:** title, rationale, evidence and a ready-made prompt for a Claude Code session on your side, with "Copy prompt" and "Continue". If Claude brings concrete changes (`edits`: file, search text, replacement, reason), the host checks them against the real code: path relative to the project, not under `caw/`, `.caw/`, `node_modules/`, `.git/` or `.claude/`, the search text exactly once in the file. The card shows file, line and diff. "Apply change" writes them to the files, line endings are preserved; if the location has changed in the meantime, nothing is written. Claude itself never changes application code.

What accepting does:

- **`retry` only:** takes effect immediately, without re-recording, since `retry` isn't part of the hash.
- **Changed text** in `name`, `do`, `expect` or `note`: the step is then outdated, and the chat offers "Fix step".
- **`caw.md` and config:** written immediately; the config applies from the next run.
- **Test file:** In `run` the change is in the file immediately. With `fix` and `record` it goes into the draft and only applies with "Adopt test plan".
- **Code change:** in the file immediately. Check it with the project's lint and a new `run`.

The "Recommendations" section in `report.md` lists each piece of advice with evidence and your decision, for application advice including the prompt and changes as a diff. Nothing is ever committed.

## Console output

In a terminal the tool shows colors, symbols and, at the end, a result block with every step. In files and pipes it stays plain lines prefixed with `[caw-ai]`. `NO_COLOR` turns this off, `FORCE_COLOR` forces it.

## How local code gets into the application

When local code runs, what to set, and how build folder and dev server get into the page: [Configuration › Testing local code](configuration.md#testing-local-code). This section covers ExtJS (Sencha).

With `"framework": "extjs"`, `--overlay` (or `--overlay dev`) takes the local code from the Sencha watch. The ExtJS app is loaded into a deployed page under its build names; caw answers those requests with the sources that `bootstrap.json` in the app folder lists, in their order. The app needs no `overlay` entry; optional are `statics` and `devCommand`. `--overlay build` and `--overlay <url>` are rejected (exit 3).

**Build names.** caw derives them as Sencha Cmd builds:

- **App:** `output.js.path` (or `output.js` as a string) in `app.json`, also in the stages `production`, `testing` and `development`; otherwise `app.output.js.path` or `app.output.js` from `.sencha/app/*.properties`; otherwise `app.js`. caw doesn't know which stage is deployed, so each of these names counts.
- **Package:** `<name>.js` and `<name>-debug.js`, with the name from the packages in `bootstrap.json`.

A request matches by the last segment of its path; the folder in front of it is where the portal keeps the file. The name comes from the path below the environment URL or from group 1 of `assetUrlPattern`. Framework packages (`ext/`, `node_modules/@sencha/`) are never replaced, so Ext JS itself always comes from the server. If a name fits two parts, or the page loads two files with the same build name, the run ends with exit 2 (`overlay-ambiguous`) and names both; give one app its own `output.js.path`.

**The watch.** The Sencha watch writes `bootstrap.json` into the app folder. The host reads it and the sources directly from the project folder, anew on every request, without network access to the watch.

- **Watch not running:** with `devCommand` (e.g. `"sencha app watch"`) caw starts it in the app folder, waits up to 180 s until `bootstrap.json` matches the files, logs to `.caw/<app>-watch.log` and stops it at the end. Without `devCommand` the run ends with exit 2 (`watch-missing`) and names the command.
- **Changed files arrive on the next load.** New classes appear in `bootstrap.json` only after the watch has built.
- **`bootstrap.json` missing, empty or naming files that no longer exist:** exit 2 (`watch-missing`, `watch-stale`).
- **`node_modules` must be in the project folder.** If it lives in a named devcontainer volume, the host can't see it and reports `watch-stale`.

## Framework: `web`, `react`, `vue`, `angular` or `extjs`

Almost everything in the tool is framework-agnostic: snapshot, clicks, console, requests, assessment, chat. Whatever depends on it lives in an adapter, chosen with `framework` in the config. A project has exactly one; the test file doesn't name it. `react`, `vue` and `angular` are `web` with three additions: they detect when the framework has mounted the application, name the component for each target (only as a hint for Claude and the report), and skip framework files in the stack.

| | `web` (default) | `react` / `vue` / `angular` | `extjs` |
|---|---|---|---|
| Stored target | Role and accessible name (`aria-label`, label, text), plus `data-testid` and the nearest named region as `inside` (dialog, form, row). Without a role: tag and own text. Never field values. Open shadow roots count (closed ones can't be reached); in an iframe of the application the target carries the iframe as `frame` | like `web`, plus `component`: the components from outside in, e.g. `GroupsScreen › Button`; for Vue also `source`, the SFC file. Dev build only, irrelevant for finding the target again | Component: `xtype`, label, `itemId`, sub-element |
| Ready | Document loaded, no page request open (requests open longer than 10 s, like long polling, don't count), nothing with `aria-busy`, no indeterminate progress (`role=progressbar` without `aria-valuenow`), DOM quiet for 150 ms | like `web`, plus mounted: React root container, Vue `data-v-app`, Angular `[ng-version]`; Angular also stable according to Zone.js if the app offers Testability (with `bootstrapApplication` only with `provideProtractorTestingSupport()`) | No `Ext.Ajax` request open, no store loading |
| `wait-ready --store` | CSS selector, `--min-count` counts visible matches | like `web` | `storeId` or ComponentQuery, counts records |
| Messages | modal dialogs without input fields, `role=alert`, `role=alertdialog`, or `messageSelectors`; `role=status` (toasts, snackbars) only as a notice | like `web` | modal dialogs, `messageSelectors`, plus ExtJS dialogs and toasts |
| Stack origin | top entry | top entry outside `react-dom`, `@vue/*`, `@angular/*`, `zone.js` | top entry outside `ext-*.js` |

For all of them:

- **Source maps:** A script error points to the source if the application serves source maps (Vite in dev mode always, builds with `sourcemap`): `src/screens/GroupsScreen.tsx:190:15` instead of `index-3f9a.js:1:48211`. They are loaded only from the script's origin and only from hosts in the lock.
- **Route changes:** If a single-page router aborts open requests on a route change (up to 1 s before or 0.5 s after), that doesn't count as an application error, just like an abort caused by navigation.
- **Covered targets:** If a target isn't clickable, the tool says why: it's missing, it's invisible, or a dialog covers it, along with its message.
- **Virtualized lists:** If a row is missing, the search scrolls the list until it appears.

For `web` and the SPA adapters an accessible UI helps: buttons with text or `aria-label`, fields with `<label>`, dialogs with a title. Where that's missing, `data-testid` makes a target unique. Otherwise the index among equal matches remains, and it breaks as soon as the order changes. No adapter uses generated classes and ids (`_ngcontent-…`, CSS module hashes, `:r1:` from `useId`).

**Dev server instead of bundle:** Test a bundled application (Vite, Angular CLI, webpack) locally directly against its dev server, e.g. `http://localhost:5173`; it reaches the backend through the dev server's proxy, even a remote one. `http` is allowed only on your own machine: `localhost`, `127.0.0.1` or a name under `.localhost` (e.g. `app.localhost` if several applications need separate cookies). Chrome always reaches these names via `127.0.0.1`; if the dev server listens only on `::1`, start it with `--host 127.0.0.1`.

## Sandbox boundaries

**Local (agent `local`):**

- **Tools:** Claude Code starts with `--tools Read,Grep,Glob`, `--permission-mode dontAsk` and `--strict-mcp-config`: no shell, no writing, no web, only the caw tool as MCP server. Hooks are disabled. `--tools` fixes the list; your own settings unlock no further tools.
- **Reach:** Only `Read(./**)`, `Grep(./**)` and `Glob(./**)` are allowed, i.e. the project folder; `dontAsk` rejects everything else, including `~/.ssh` or Claude Code's login (verified with Claude Code 2.1.319). Your own and the project's Claude Code settings aren't loaded (`--setting-sources ""`), so their `allow` rules can't widen this; only connection settings (`env`, `apiKeyHelper`, `model`, AWS helpers) are carried over from `~/.claude/settings.json`. Locally Claude can't view screenshots in the agent folder under `.caw/`.
- **Files:** `.env*`, `.git`, `.claude`, `.worktrees`, `.caw`, `caw/.auth` and typical key files (`.npmrc`, `*.pem`, `id_rsa*` …) are blocked via `permissions.deny`. That's a Claude Code lock, not file system protection as in the container: if you need stronger guarantees, use `docker`.
- **Network:** Claude itself has no web tool. It reaches the application only through the browser and its lock.

**Session (agent `session`):** The rights of your own Claude Code session apply. caw-ai only adds the browser commands.

**Container (agent `docker`):**

- **Files:** The project folder is mounted read-only, always under the Linux path in the container (`C:\x` as `/mnt/c/x`). Only the run's agent folder and the container's interior are writable. `.git`, `.claude`, `.worktrees`, `.caw` and all `.env` files are hidden, including `caw/.env`. The agent can see other secrets in the project folder.
- **Network:** Default deny for IPv4 and IPv6. Allowed are loopback and HTTPS to the Anthropic API. The firewall resolves its addresses at startup and writes them to `/etc/hosts`; after that DNS is blocked too, including Docker's built-in resolver, so no data can be smuggled out in DNS names. If the API's addresses change during a run, a new run helps. The application isn't reachable from the container.
- **Privileges:** The container starts as root only for the firewall, then runs as the sandbox user (`sandboxUser`) without capabilities, with `no-new-privileges`. No published ports, no Docker socket.
- **Token:** It arrives at runtime as an environment variable and isn't in the image.

**Chrome (on the host, outside the Docker firewall):**

- **Control:** The agent never gets CDP. There are only the fixed commands from `caw-ai help`, as files in the agent folder. Navigation via `goto` only goes to allowed hosts.
- **Network:** `--host-resolver-rules` allows only the hosts from `environments` and `extraAllowedHosts`; IP addresses are blocked too. Plus `--no-proxy-server` and a WebRTC lock.
- **Workbench:** The tool answers the top window's document itself, at the application's address. The application thus shares the origin with the workbench and can modify its page; decisions are made only in the chat, which it can't reach (separate, opaque origin). A POST into the top window is sent once by the tool via the browser context (same cookies, same host lock).
- **Limit of the lock:** It knows hosts, not ports. Other services on an allowed host are reachable from the page.
- **Visibility:** `eval` runs in the signed-in page. Claude sees and can do everything the test user sees and can do in the application. So use only test accounts with few rights.
- **Backend:** The lock ends at the application's host. Requests via an application proxy pass through, and where it forwards them is up to the server. The real boundary is the test account's rights.
- **`mutates: false`:** A new test is writing unless `record … --read-only`. If a read-only test does write during recording, it becomes writing on adopt. The tool checks the field before starting against `environments.<env>.writable`. During the run only the skill's instruction prevents writing; it isn't technically blocked.
- **Corporate policies:** A centrally enforced Chrome policy (e.g. a proxy) can override the lock. Check this on the machine running the tests (`chrome://policy`).

**Verdict:** Only the host writes report and `result.json`, outside the agent folder. Only screenshots the host took itself count.

## Development

```bash
npm test                          # unit tests; browser tests need Chrome and are skipped otherwise
npm run e2e                       # E2E against the fake portal under e2e/, with scripts instead of Claude and human
npm run pack:check                # package contents: no secrets, no tests, no project terms
```

On Windows the E2E runs best from PowerShell via `e2e/watchdog.ps1`: the watchdog ends the run when the log stays silent too long. What counts are the results in `<log>.result` with the summary `RESULT OK=… FAIL=…`, also in `<log>.status`: the agent's processes write into the log too and can overwrite lines. If there is a FAIL, the E2E ends with exit 1. On its first run the E2E builds the sandbox image from `node:22-bookworm-slim` and needs Docker for it, but no token.

The tool has been tried with ExtJS 6.5.3 Modern, React 19 (Vite dev server), Vue 3.5 and Angular 19. `e2e/frameworks` tests React 19 (Vite 8), Vue 3.5 (Vite 8), Angular 21 (zoneless and with Zone.js), Next.js 16 and Nuxt 4, each on the dev server, as a production build over HTTPS and, where possible, with `--overlay` (`node e2e/frameworks/matrix.mjs`). Windows and Linux are officially supported as hosts; macOS is untested. For the `docker` agent, Docker in WSL has been tried; Docker Desktop is untested: firewall in the container, write permissions in the agent folder and the channel over its file sharing.
