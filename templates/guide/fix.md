# caw: fix a step

If `task` contains the field `repair`, you change exactly the one step in `steps`. The browser is already at the state before it: The steps in `repair.before` have run without you. With `repair.from` it is a range instead, see "Re-record from a step on" below.

- `repair.reason` says why it is your turn, `repair.actions` and `repair.check` show the existing recording, `repair.after` names what comes afterwards and builds on it.
- `repair.remembered` contains the values the steps before read, with `name` and `value`. Type and check with the real value; caw stores the placeholder. If the step itself read via `remember`, keep the same name, otherwise `finish` rejects if a later step needs it. A value the human marked as secret (`secret`) appears there as `••••`: You never get to see it. Its placeholder (`{{name}}`) works only as a `fill` or `type` value; `check`, `eval` and `remember` code containing it is refused. If the step needs it elsewhere, tell the human.
- **`repair.rerecord`:** The step did not fail; the human wants to record it anew, e.g. after a change by hand. There is
  no cause to search for: Present the plan with the step from `steps`, unchanged if nothing should change. An unchanged plan
  counts as accepted without approval. Then carry out the step and submit it.
- **`repair.agreed`: What the human said and decided in the chat before** (`from`: human, claude or decision). That applies to you,
  even if another agent session had the conversation. If they declared an error harmless, it is no reason for `fail`.
  If you deviate from it, then only with new evidence, and tell them with `say`.
- **`repair.resolved` instead of `repair.diagnosis`:** The hard errors of the test run are now allowed (`consoleIgnore`, `foreignCode`).
  The old assessment no longer applies. Carry out the step and measure it by its `check`; warnings alone are no `fail`.
- **The cause first,** if the step failed, see topic `cause`. Tell the human with `say` in one sentence what it is due to and why. If it is due to the
  application, submit the recommendation with `advise` and then `fail`, without a plan.
- **Plan first,** as soon as it is clear that the test has to be adjusted: Present a plan with exactly this one step, same ID, no other. The card marks a changed `expect`.
- **The yardstick:** If `expect` stays the same, use `repair.check` unchanged, otherwise `finish` rejects. If the application does not meet it, the step is `fail`; do not look for another expression that returns `true`. Only change `expect` if the human wants that, and name the reason in the chat.
- Submit `fail` if the application is wrong or behaves differently in domain terms than the step requires: error messages, dialogs it does not name, missing functions, data that does not arrive. Only adjust what has shifted purely
  technically, e.g. a renamed element or a rearranged screen, and only if assessment and effect support it:
  If the renaming is in the source code as an intended change, adjust; if the assessment shows "application" or the element is missing without a
  counterpart, ask the human.
- At the end submit only this step with `finish`. caw then replays the whole test without you.

If a section is now somewhere else, you may search for it, also on other pages of the application, within `maxActions`.

## Re-record from a step on

If `repair.from` is `true`, the human wants the test re-recorded from the first step in `steps` to its end (`repair.rerecord` is
set too: nothing failed, there is no cause to search for). The steps in `repair.before` have run without you and stay as they are.

- `repair.steps` lists the old steps from there on, each with `id`, its recorded `actions` and its `check` (missing if it was never
  recorded). They are orientation and can be outdated; the page is authoritative. `repair.remembered` works as above.
- **Plan first:** Present a plan with the steps from there to the end, at least one, and none of the steps in `repair.before`.
  You may add, remove, rename or reorder steps; keep the IDs of steps that stay, a new step gets the next free number. An
  unchanged plan counts as accepted without approval, otherwise the card shows each changed `expect`.
- **The yardstick per step:** A step whose `expect` stays the same keeps its old `check`, otherwise `finish` rejects.
- Carry out the steps in order, prove each with `check` and submit them with `finish`. caw then replays the whole test without
  you; steps you left out are deleted from the test.
