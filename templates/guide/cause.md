# caw: cause first

A failed step can be due to the test, the application or the environment. That applies when fixing, when recommending and in
conversation. Before you adjust the test, you clarify what it is due to.

1. **Read caw's assessment:** `diagnosis` (`side`: app, test, environment or unclear; `strength`; `findings`) and `evidence`
   (`requests` of the step in the run, `recorded` from the recording, `effect`: the first action that acts differently than in healthy runs (learned over the first five, then frozen),
   with `missing`, `instead` and `extra`). `effect` shows where the application first behaved differently; the search starts there, not
   only at the failed target. The lines name controls with their label or, without one of their own, with the heading of their area,
   e.g. `textarea "Message" disabled,empty`: You search for this text in the source code; that is where the element is and what it is bound to. When fixing this is in `repair`, otherwise in `outcome`. `network` shows the
   last requests, `console` the hard errors.
   Further pointers to the place in the source code, where they exist:
   - A script error has `at`, the first own location, and `stack`, translated via source maps, e.g. `src/screens/GroupsScreen.tsx:190:15`.
   - With React, Vue and Angular a target carries `component` (the components from outside to inside) and with Vue `source`, the file.
   - `framework.hints` in `task` says where this framework usually makes requests.
   - If the abort reports that a target is "covered by dialog …", the action before did not close the dialog. Check whether the data
     or the call is wrong: A 409 or 422 and a message like "already exists" point to test data or a state from an
     earlier run; then it is the test (`{{runTag}}` in the value). A 400 without such a message, a technical message or a field that the
     call names differently than during the recording (`params`) point to the application. Decide with evidence, not by the form of the dialog.
2. **Search in the source code, regardless of the framework.** The name of a request, a URL or a text on the page leads to the place that
   makes the request or shows the data. Look there for timeouts, parameters, conditions and error handling. A request that aborts after
   a few milliseconds without a page change was usually aborted by the application itself.
   **You do not guess how the interface wants to be called.** Evidence for that is `params` from the recording (the parameter names when
   the step worked) next to `params` in the run, and other places in the source code that call the same interface. If such evidence is missing, say
   so and suggest where the human can look, instead of inventing a change.
3. **Decide, with evidence:** one sentence on what it is due to, with request, error or location (`file:line`). If you deviate from caw's
   assessment, name the evidence for it.
4. **If it is due to the application, you do not adjust the test.** No `retry`, no different `check`, no changed `expect`: That would hide the
   error. Instead give a recommendation for the application with a concrete change (topic `advise`). When fixing,
   you then submit `fail` with the reason.
5. **Entries in `context`** only count with an identifying feature. If an entry fits the picture but not the evidence, the evidence counts.
