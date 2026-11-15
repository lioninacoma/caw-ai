# caw: the flow plan

The plan is the later test file without recording, YAML with exactly these fields:

```yaml
notes: |
  What applies to the whole test, plus assumptions and open questions, clearly named as such.
steps:
  - id: S1
    name: Open checkout
    do: Click "Next" and wait for the checkout.
    expect: The checkout is visible.
    note: Optional, applies only to this step.
    retry: {times: 2, waitMs: 15000, from: S1}   # optional, see below
```

**`retry`** belongs in the plan if a step fluctuates for a known reason, e.g. a slow database or an entry that appears with a
delay. Never because of a script error: that can be a rare error of the application that a second attempt only hides (the
report then warns). If the step fails during replay or a hard error occurs in it, caw waits `waitMs` (default 10 s), reloads
the page and replays once more from step `from` (default: this step), at most `times` times.
Only for steps that write nothing, also not in `from` and the steps up to here: otherwise a submit would create a second
record. Step `from` must work from the freshly loaded page; check that while recording with `reload`. Wait and reload attempts
you need yourself are removed from the recording. If the plan already has a `retry`, keep it.

caw sets metadata and `recording`; whatever you enter there is dropped. Describe the path so that someone else finds it, with
paths and structures instead of data: no names, addresses, numbers or free texts from the application.

**Cutting:** each step has exactly one result and one check and is a point at which you would later want to open the test
(`open <test>@S<n>` lands at a step's entry) or re-record from. Few steps that matter for the domain, rather than one per click.
IDs are `S<n>` and existing IDs stay fixed: a new step gets the next free number; the file determines the order. `do` may be
empty for a pure check step (`do: ""`).

`plan --file <file>` (in the session: `plan` with the content in `file`) shows it to the person in the chat and waits.
Always call `plan`, `ask-operator` and `chat` in the foreground and wait for their answer, even if it takes minutes. If you end
before that, e.g. with a background command, the run is over.

- `{ "approved": true }`: carry out exactly this plan. From now on its steps are the yardstick.
- `{ "approved": true, "invalidated": ["S2", "S3"], "note": "..." }`: approved, but the version changes steps you already
  checked. Their checks no longer count: bring the page back into those states and check them again; remove outdated actions
  with `omit`.
- `{ "approved": false, "feedback": "..." }`: work in the change, take out answered questions and present a new version.
  `element` names a component the person marked for it. If `feedback` is null, they are gone: end the run.
- An invalid plan comes back as `plan-invalid` with a line number, without the person seeing it.

If the path changes fundamentally along the way, or steps are added, present a new version before you continue. A check for
a step that is not in the plan is rejected (`step-unknown`). At the end the last approved version counts as the test plan, so
align it if you learned something important. Rewording `name`, `do` or `note`, or adding a `retry`, keeps the checks already
passed. A changed `expect`, a new step in between or another order takes back the checks from there on; a later version with
the same expected results brings them back.
