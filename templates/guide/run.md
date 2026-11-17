# caw: run, record and reach a state

Start commands with `caw_start` (you become the agent, topic `session`) or, without the tools, `npx caw <command>` in the
project folder (on Windows from PowerShell). Report the result including the path to the report. The exit code is the verdict.

- **Test:** `run <test>` (or `caw_start` with `command: "run"`, `test`). Runs without AI. If the recording is missing it ends
  with exit 4 (recording needed) and names `record`; if a step is outdated it names `record <test>@S<n>`. If a step fails on an
  environment with `claude: true` and not in CI, the chat offers "{{label:run.button.fix}}"; only the person starts Claude from there. With
  `--explain` (only on such environments, not in CI) Claude gives recommendations right away on errors or warnings; that costs
  tokens, so add it only if the person wants it. `--learn` writes missing baselines into the recording: only when asked.
- **Reach a state** ("take me to where the cart is filled"): read `caw/tests/` and find the step `S<n>` the person wants to work
  in, the one after the step whose `expect` describes the state. `open <test>@S<n>` replays the steps before completely and of
  `S<n>` only its navigation, so the person lands at that step with its inputs open; `S<n>` is not judged. If `S<n>` has no
  inputs, or one of its clicks writes, nothing of it or only up to that click runs. If the state is the end of the test, `open
  <test>` replays all and hands over. The command ends only when the person closes the window: start it in the background and
  say when the state is reached. The window then belongs to them.
- **Record or replace:** `record <test>`, on an environment with `claude: true` (and `writable` for a writing test). It follows
  the plan in `caw/tests/<test>.yaml`; without a plan it starts with the person's demonstration. The person sits at the chat,
  approves the plan and decides at the end. It writes in the application and costs tokens: start it only when the person wants it.
- **Change from a step on:** `record <test>@S<n>` re-records from `S<n>` to the end, even if nothing fails, e.g. after a step was
  changed by hand or the application changed on purpose. The steps before replay without Claude; from `S<n>` on steps may be
  added, removed or reordered. `@S1` records the whole test. A single failed step is fixed in the run's chat ("{{label:run.button.fix}}").

**Export:** `export <test> --env <name>` writes the recorded test as a Playwright test that runs without caw
(`caw/export/playwright/`: `<test>.spec.mjs`, `caw-support.mjs`, `playwright.config.mjs`). Only when the person asks for it,
e.g. to hand the test to a team that only uses Playwright. Learned effects, baselines and the failure rules stay with caw.

**Environment:** `--env <name>` (`env` in `caw_start`). Without it caw takes the only fitting one, or names the candidates.
**Lifecycle:** `--start` (`start: true`) runs the environment's configured `start` command when it does not answer and stops it
afterwards; `--reset` (`reset: true`) runs its `reset` first. The commands are the team's; never start servers through caw otherwise.

**Exit codes:** 0 passed, 1 failed, 2 environment or tool problem, 3 usage or invalid input, 4 recording needed.
