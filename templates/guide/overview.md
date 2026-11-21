# caw: overview

**The principle:** a test is only worth its checks. When a step's expected result is unchanged, its check stays; you never
weaken or replace it to make a run pass. When caw's assessment points to the app, you find the cause before any change and
never edit a test or recording to hide an app bug (topic `rules`). `caw audit` lists a check changed under an unchanged
expected result as a weakening, for the pull request.

caw keeps end-to-end regression tests for this project's own web application. A test is a plain-language plan; caw records
it once with Claude in the real application and from then on replays it with Playwright, without AI, locally and in CI. A
second benefit: any state a test reaches can be restored to develop from ("take me to where the cart is filled"). A
third: a reported bug can be reproduced on its own, signed in, with a report and a draft test as the result, which is
recorded red, turns green with the fix and then joins the tests with a fix report (topic `reproduce`).

caw is not a load test, not a crawler and not a test generator for apps the team does not own.

## Project layout

- `caw.config.json`: environments, sign-in, roles and rules (topic `config`).
- `caw/tests/<test>.yaml`: the test plans (topic `tests`). Written by people or by you as the session.
- `caw/recordings/<test>.yaml`: what caw recorded per step. Written only by caw, never by hand.
- `caw/caw.md`: project notes every run agent reads (domain terms, peculiarities). Next to it the person may keep their own
  notes for every project, `caw.md` in caw's settings folder (task field `personalContext`); the project's notes win.
- `caw/.env`: test users. Never read, written or asked for by you.
- `.caw/`: runs, logs and reports (not checked in).

## Where you are

- **The developer's session** (you have the `caw_*` tools): you set up the project, write plans, start runs and, when a run
  waits for you, act as its agent. Topics `setup`, `tests`, `run`, `reproduce`, `session`, `attach`, `design`.
- **The agent of a run** (you have only the `caw` tool or `caw agent <command>` in a container): you drive the browser for
  one task. Topics `agent`, `plan`, `record`, `chat`, `cause`, `fix`, `advise`, `talk`, `reproduce`, `rules`.

## Tools

| Tool | For |
|---|---|
| `caw_guide` | This guidance, per topic |
| `caw_attach` | Listen to the person's caw windows: your key and a command for the Monitor (topic `attach`) |
| `caw_init` | Look at the app (`mode: explore`), write the config (`mode: write`), or a template (`mode: offline`) |
| `caw_config` | Read the config, or patch it (validated); commands and environment flags only with your Edit tool (topic `config`) |
| `caw_role` | Test users per role: list, add (names the variables), login (saved session), remove |
| `caw_doctor`, `caw_validate`, `caw_list` | Checks and overview, no tokens |
| `caw_reproductions` | Past reproductions with verdict and `ref`; `refs` names those without a run (topic `reproduce`) |
| `caw_design` | Target designs under `caw/design`: `put` (.html, .png, tokens.json), `list`, `link` a step only on the person's request (topic `design`) |
| `caw_start` | Start `run`, `record`, `open` or `reproduce` with you as the agent |
| `caw_status` | Wait for a run; says which topics apply when it waits for you |
| `caw` | The agent commands while a run waits for you |
| `caw_selection` | The element the person picked in the workbench |
| `caw_overlay` | Only with an `overlay` block in the config: is the local code server ready, apply its parts (topic `overlay`) |
