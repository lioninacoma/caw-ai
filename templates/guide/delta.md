# caw: a test for a ticket or a delta

Someone (a person or a skill of the project) has a text that says what was to be built (a ticket, an acceptance plan) and the
commits that built it (the delta), and wants a test that proves it. caw knows no ticket system and reads no ticket: it gets
text, commits and an opaque id. Reading the ticket, what may be passed on, and commenting stay with whoever asked.

1. **Delta:** name it as `<base>..<head>` (for a branch `main..<branch>`) or as one commit. Look at it with git (`git log`,
   `git diff <base>...<head>`). The head must be what is checked out, and the app must run from this folder: caw compares the
   delta's files with the working tree and refuses otherwise (`delta-mismatch`). Then tell the person what to check out; never
   switch branches, stash or start a server yourself. caw cannot see whether the dev server really serves this folder.
2. **Description:** write what the test shall prove, one list entry per requirement, each with the action and one expected
   result the person can see in the app, the normal case first, then the cases the delta refuses. Take only what the text or the
   delta says. Values: none from the ticket, from tests or from the app's data, and never a placeholder such as `<PERSON_1>`;
   describe them ("a six-digit number"). Any wish of the person goes in as an entry of its own.
3. **Start:** `caw_start` `{command: "record", test, env, description, delta, ref}`; `ref` is the ticket's key. If the test
   exists already, do not record it again unless the person asks: `{command: "run", test, env, delta, ref, headless: true}`.
   Then `caw_status` with `wait: 120` until the run waits for you, and read the topics it names.
4. **Plan:** the task holds the description as notes `H1`, `H2` … and the delta's files. Look at the page and the code, then
   submit the plan. `heard` says for every note which step proves it (`{note: H1, as: step, step: S2}`) or that this test
   cannot (`{note: H2, as: open}`, e.g. nothing to see in the app). The person approves the plan in the window.
5. **Record:** walk the plan, make up the values you type and keep texts that identify a record recognisable by `runTag`. Never
   type a placeholder. A step the app does not meet is a finding: report it as failed, do not change its expectation and do not
   weaken the check. The recording is adopted by the person in the window; never answer that decision yourself.
6. **Proof:** after adopting, `{command: "run", test, env, delta, ref, headless: true}`, then `caw_status` until it ended. Pass
   on only `proof` (`steps` with `expect` and `status`, `files`, `report`) together with `result.status`, `result.delta`
   (`head` is the tested commit, `dirty` the uncommitted changes besides it) and `result.ref`. They hold no evidence and no typed
   values; `expect` and `heard` are the words of the plan and the description. Which parts of the description are proven and which
   stay open: `result.heard` of the recording's runs. Passed means `result.status` is `pass` and no step is `pending` or `open`.
7. **Files:** `proof.files` belong to the delta and go into its commit; committing is the person's.

Nothing adopted (the person ended the run, a step failed): say so, name the step, its expectation and what the app did instead,
without values. A run that ended without `result` proves nothing.
