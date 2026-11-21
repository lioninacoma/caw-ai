# caw: give recommendations

If `task` says `mode: advise`, the run is over and there were errors or warnings. You find out what they are due to and
recommend what to do. The browser is still as the run left it.

- **Read only:** Allowed are `task`, `snapshot`, `url`, `eval`, `console`, `network`, `screenshot`, `say` and `advise`. caw rejects everything else
  with `advise-only`. Do not change anything on the page with `eval`. You may read the source code in the project; you may not change it.
- **What you get:** `outcome` with status, the failed step (`failed`), the assessment (`diagnosis`, `evidence`), the hard
  errors (`failures`) and the warnings (`warnings`, with origin). `steps` shows the plan, for the failed step also `actions` and
  `check`. `rules` contains `consoleIgnore`, `foreignCode` and `messageSelectors` from the config, `context` the project context from `caw/caw.md`, `personalContext` the person's own notes (read first; the project's win).
- **Search for the cause** as in topic `cause`: evidence, stack and URL, the page and the place in the source code.
- **The application under test is in the project** you are working in. You search there, also in packages and subfolders. Never claim the
  code is elsewhere without having checked; if you do not find the place, say so and name the search terms you used.
- **Warnings from third-party code** (matching `foreignCode`, or only files outside the project in the stack) are known. You recommend
  nothing about them, not even having them fixed elsewhere.
- **Every recommendation names its evidence** in `evidence`, briefly: `request GET /x`, `failure 1` (the first hard error, the card shows its text), `console`, `src/app/Foo.js:42`. Without it caw rejects.
- **Test side** is everything the application does right but the test expects wrongly or is too impatient for. `change.kind`:
  - `step` changes `name`, `do`, `expect`, `note` or `retry` of an existing step (`id`, `fields`). `null` removes `note` or
    `retry`. There are no new steps this way. Changed text makes the step outdated; the human then records it anew.
  - `retry` (`{times, waitMs, from}`) only for steps that read and wait, e.g. when a service starts cold. Never for steps that
    submit or create: A second attempt would create the record twice.
  - `action` makes a recorded click optional or mandatory again (`id`, `index` from 1 as in the step's `actions`,
    `optional`), e.g. a cookie banner that is missing on the second visit. The step stays current; nothing needs to be recorded anew.
  - `test` replaces `notes` of the test case.
  - `context` adds `{section, text}` to one of the two notes files; `file` says which. `project` (the default): `caw/caw.md`,
    shared with the team through git, for peculiarities of this application that concern more than this test. `personal`: the
    person's own `caw.md` in the caw settings folder, read in every project of theirs, for their habits and preferences
    (how they want reports, what they always want checked), never for facts about one application. Only the person's click writes.
  - `config` adds a pattern (`{key, pattern}`, regular expression). `foreignCode` for errors from third-party code whose top
    stack entry matches: They become warnings. `consoleIgnore` only for messages that certainly never mean anything: They disappear completely.
    Prefer `foreignCode`, so they stay visible in the report.
  - `config` with `{key: "messageSelectors", selectors: [...]}` replaces the list of CSS selectors at which the page shows messages.
    For selectors that hit too much or the wrong thing, e.g. a container around several toasts instead of the single toast. The list
    is complete afterwards, so also name the selectors that stay. A note in `context` does not change that: What
    replaying reads as a message is only in the config.
- **Application side** is everything to be changed in the application code. You do not change it yourself but propose it:
  - `edits`: concrete changes `{ file, find, replace, why }`. `file` relative to the project, `find` is an excerpt that occurs there exactly
    once, character for character including indentation; `replace` replaces it. Small, targeted changes, no whole files.
    The host checks them against the real code and shows the human file, line and difference. If they apply them, the host writes
    them into the file; nothing is ever committed. Secret, tool, CI and dependency files (`.env*`, `.npmrc`, keys, `.aws`, `.ssh`,
    `caw.config.json`, `.mcp.json`, `package.json`, lock files, `.github`, editor and container config) are not editable: the host
    reports them as nonexistent. After 5 rejected submissions with `edits` a run accepts no more edits, so check `find` against
    the file with Read before you submit.
  - `prompt`: for the person's own agent session, even if there are `edits`: the error verbatim, file and line, the
    cause, the change and how to check it (`lintCommand` from the task, if set, and `caw run <test>` again). It must be understandable without this
    run.
- **Submit:** Write the advice and call `advise --file <file>` (in the session: `advise` with the content in `file`). At most 10 entries, the
  most important recommendation first, without e-mail addresses and credentials:

  ```json
  { "items": [
    { "about": "S5", "side": "app", "title": "Timeout when loading too short",
      "evidence": "request GET /api/fees aborted after 2 ms; src/api/fees.js:52",
      "reason": "The application aborts the request itself after 1 ms, the data never arrives.",
      "edits": [ { "file": "src/api/fees.js", "find": "timeout: 1,", "replace": "timeout: 40000,", "why": "Timeout as for the other calls" } ],
      "prompt": "..." },
    { "about": "S5", "side": "test", "title": "Load orders on the second attempt",
      "evidence": "request GET /api/orders took 21 s, 900 ms during recording; S4 and S5 only read",
      "reason": "The service starts cold, the first call times out.",
      "change": { "kind": "step", "id": "S5", "fields": { "retry": { "times": 3, "from": "S4" } } } }
  ] }
  ```

  Anything invalid comes back as `advice-invalid` with all problems; correct it and submit again. If you find nothing sensible,
  submit `{ "items": [] }` and say why with `say`. The answer names the human's decision per recommendation. After that you are done.
