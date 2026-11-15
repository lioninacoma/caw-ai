# caw: overview

caw keeps end-to-end regression tests for this project's own web application. A test is a plain-language plan; caw records
it once with Claude in the real application and from then on replays it with Playwright, without AI, locally and in CI. A
second benefit: any state a test reaches can be restored to develop from ("take me to where the cart is filled").

caw is not a load test, not a crawler and not a test generator for apps the team does not own.

## Project layout

- `caw.config.json`: environments, sign-in, roles and rules (topic `config`).
- `caw/tests/<test>.yaml`: the test plans (topic `tests`). Written by people or by you as the session.
- `caw/recordings/<test>.yaml`: what caw recorded per step. Written only by caw, never by hand.
- `caw/caw.md`: project notes every run agent reads (domain terms, peculiarities).
- `caw/.env`: test users. Never read, written or asked for by you.
- `.caw/`: runs, logs and reports (not checked in).

## Where you are

- **The developer's session** (you have the `caw_*` tools): you set up the project, write plans, start runs and, when a run
  waits for you, act as its agent. Topics `setup`, `tests`, `run`, `session`.
- **The agent of a run** (you have only the `caw` tool or `caw agent <command>` in a container): you drive the browser for
  one task. Topics `agent`, `plan`, `record`, `chat`, `cause`, `fix`, `advise`, `talk`, `rules`.

## Tools

| Tool | For |
|---|---|
| `caw_guide` | This guidance, per topic |
| `caw_init` | Look at the app (`mode: explore`), write the config (`mode: write`), or a template (`mode: offline`) |
| `caw_config` | Read the config, or patch it (validated) |
| `caw_role` | Test users per role: list, add (window), login (saved session), remove |
| `caw_doctor`, `caw_validate`, `caw_list` | Checks and overview, no tokens |
| `caw_start` | Start `run`, `record` or `open` with you as the agent |
| `caw_status` | Wait for a run; says which topics apply when it waits for you |
| `caw` | The agent commands while a run waits for you |
| `caw_selection` | The element the person picked in the workbench |
