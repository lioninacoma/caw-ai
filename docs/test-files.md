English · [Deutsch](test-files.de.md)

# Test files

Each test has two YAML files:

| File | Written by | Commit? |
|---|---|---|
| `caw/tests/<id>.yaml` | you: what the test does, in plain language | yes |
| `caw/recordings/<id>.yaml` | caw: how to replay it | yes, review it first |

You write the test plan. `record` writes the recording; by hand you only add the [extras](#hand-written-additions) Claude does not record. `recording` and `knownMessages` belong in the recording only; in the test plan `validate` rejects them.

## Test plan

```yaml
# caw/tests/create-ticket.yaml
id: create-ticket
role: user            # a name from roles (leave out without sign-in)
writes: true          # true if the test creates or changes data
notes: |
  A support agent takes a call: they log a ticket for a customer and start working on it.

steps:
  - id: S1
    name: Open the ticket list
    do: Open "Tickets" in the navigation.
    expect: The ticket list is visible.
  - id: S2
    name: Create a ticket
    do: Create a new ticket "Printer offline {{runTag}}" for customer "Acme Corp" with priority "High".
    expect: A confirmation shows the number of the new ticket.
  - id: S3
    name: Find the ticket
    do: Search the list for "{{runTag}}".
    expect: Exactly one ticket is listed, with priority "High" and status "Open".
  - id: S4
    name: Start working on it
    do: Open the ticket and change its status to "In progress".
    expect: The ticket shows the status "In progress".
```

Write test plans in any language; Claude reads them like a tester would.

| Field | Required | |
|---|---|---|
| `id` | no | Defaults to the file name; if given, it must match it. |
| `role` | with sign-in, if the config has several roles | Role from the config. Defaults to the only role. |
| `writes` | yes | `true` if it creates or changes data; such tests only run on environments with `writable: true`. `false` if it only reads. A test that sends a write request while it is recorded becomes `true`. |
| `environments` | no | Environments the test may run on. Defaults to every environment except production, and for a writing test only the writable ones. `record` never sets it. |
| `start` | no | Path where this test starts, instead of the config's `start`. |
| `notes` | no | Context for the whole test. |
| `steps` | yes | See below. |

Per step:

| Field | Required | |
|---|---|---|
| `id` | yes | `S1`, `S2`, … Never renumber; new steps get the next free number. |
| `name` | yes | Short title. |
| `do` | yes | One action, in plain language. `""` for a pure check step. |
| `expect` | yes | Exactly one result you can check. |
| `note` | no | Context for this step only. |
| `retry` | no | `{ times: 2, waitMs: 15000, from: S1 }`: reload and retry when the step fails for a known reason, e.g. a cold backend. Not for steps that submit data. |

Tips:

- One action and one result per step: "Open the list" / "The list is visible".
- Write `do` and `expect` the way a tester would say it. Claude turns them into targets and checks.
- Put `{{runTag}}` in names you create. Every run gets its own value, so a run finds its own record and not one from yesterday.

## What invalidates a recording

Each step has a hash over `name`, `do`, `expect` and `note`. Change one of them and only that step is outdated:

```bash
npx caw run create-ticket --env local       # exit 4: S2 changed, prints the record command
npx caw record create-ticket@S2 --env local # re-record from S2 to the end, S1 stays
```

`notes`, `role`, `writes`, `environments`, `start`, `retry` and `caw/caw.md` are not part of the hash. To add a step at the end, write it and `record` the test from that step (`record <test>@S7`). From the step you name on, Claude may also delete, rename or reorder steps; the steps before it stay untouched.

## Recording

Written by `record` and by "Fix step" in a run's chat. Review it; change it only for the [hand-written additions](#hand-written-additions). An excerpt:

```yaml
# caw/recordings/create-ticket.yaml
# Written by caw, belongs to caw/tests/create-ticket.yaml. Delete by hand if needed, never edit.

test: create-ticket
steps:
  - id: S2
    hash: 23b43d5acb2796dd
    after: S1
    recordedOn: local
    recordedAt: 2026-11-09T09:31:28.406Z
    locale: en-US
    timezone: Europe/Berlin
    actions:
      - {click: "getByRole('button', { name: 'New ticket', exact: true })", path: /tickets}
      - {wait-ready: {}}
      - {fill: "getByRole('dialog', { name: 'New ticket' }).getByRole('textbox', { name: 'Title', exact: true })", value: "Printer offline {{runTag}}", path: /tickets}
      - {fill: "getByRole('combobox', { name: 'Priority', exact: true })", value: high, path: /tickets}
      - {click: "getByRole('button', { name: 'Create ticket', exact: true })", path: /tickets}
      - {wait-ready: {}}
      - {remember: {name: ticketnr, code: "(document.querySelector('[role=status]').textContent.match(/#(\\d+)/)||[])[1]"}}
      - {click: "getByRole('row').filter({ hasText: 'Printer offline {{runTag}}' }).getByRole('link', { name: 'Open', exact: true })", path: /tickets}
    check: "document.querySelector('h1')?.textContent === 'Ticket #{{ticketnr}}'"
    network:
      - {name: POST /api/tickets, status: 201, ms: 269, params: [json.customer, json.priority, json.title]}
      - {name: GET /api/tickets, status: 200, ms: 274, params: [q]}
    effects:
      runs: 1
      actions:
        - action: 5
          controls:
            - + button "Create ticket"
            - '- button "Create ticket" disabled'
```

| Field | |
|---|---|
| `actions` | What to do. `dblclick` is one double-click, e.g. on a grid row that only opens that way; a double-click you demonstrate is recorded as one. The target of `click`, `dblclick`, `fill`, `type`, `upload` and `download` is one Playwright locator, written as Playwright prints it, without `page.`: role and full name with `exact: true`, label, text, `data-testid`, the row or dialog around it, `contentFrame()` for an iframe. caw parses it and never runs it as code; `validate` rejects anything else, snapshot references (`aria-ref=`), `:nth-child` and, for ExtJS, generated ids like `#button-1023`. ExtJS components can also be found with `locator('extjs=button[text="Save"]')` (`Ext.ComponentQuery`); a text or title with a comma never goes into such a query, because ComponentQuery splits at every comma. |
| `hover`, `dragTo` | `hover` moves the pointer over its target, e.g. a menu that opens on hover. `dragTo` drags its target onto the locator in `to`, e.g. a card onto a column. |
| `dialog` | The answer to a native dialog (`alert`, `confirm`, `prompt`, `beforeunload`) that the action opens: `{type, accept, value?, message?}`. `value` is the text for an accepted `prompt` (placeholders allowed); `message` is the dialog text at recording, digits as `#`. Replay answers the dialog that way. A dialog nobody recorded is dismissed and listed as warning `dialog-unexpected`; a recorded one that doesn't come is warning `dialog-missing`. When you demonstrate, the chat shows the dialog with OK and Cancel; Claude answers with `caw agent dialog accept|dismiss`. |
| `path` | The page the action was recorded on. If a target is missing, the run tells you it is on a different page. |
| `locale`, `timezone`, `viewport` | Language, time zone and size of the app view while recording; replay uses them unless the config sets `browser.locale`/`browser.timezone`/`browser.viewport`. Headless replay opens at that size; in the workbench the app frame gets exactly that size, scaled down if the window is smaller. |
| `check` | A JavaScript expression that must return `true`. It runs in the signed-in page, so read it before you commit. |
| `remember` | Reads a value the run creates, here the ticket number. Its `code` runs in the signed-in page like `check`, so read it before you commit. Later steps use it as `{{ticketnr}}`. Any value that is not empty; one shorter than four characters (an id like `7`) is replaced only in typed values, URLs, string literals of checks and target texts that are exactly that value. |
| `network` | Requests per step from a healthy run. Used to tell app bugs from environment problems. |
| `effects` | What each action changed on the page, learned from healthy runs (`runs` counts them). A change fails the step or shows as a warning. |
| `knownMessages` | Messages that were visible during recording and are not errors. |

On replay a locator must find exactly one element that is visible and not covered. Two matches are tolerated for two seconds, e.g. while one dialog closes and the next opens with the same button; then the step fails and names both. A locator chosen by position (`nth()`, `first()`) is listed after recording so you can check it.

## Hand-written additions

Claude doesn't record `download` and `secret`; you add them to `caw/recordings/<id>.yaml` yourself. `validate` checks them. A new recording of the step by Claude replaces its actions, so add `download` again afterwards; `secret` on a `remember` survives it.

`upload` is recorded, but only with files from `caw/fixtures`: when you demonstrate, caw compares the file you choose by name, size and SHA-256 with the files there. A match turns the click that opened the file chooser into the `upload`; a file from anywhere else is named in the chat and not recorded, and nothing is copied. Put test files without personal data into `caw/fixtures` and choose them from there. Claude uploads with `upload <target> fixtures/<file>`, also only from there.

| Syntax | Meaning |
|---|---|
| `- upload: "getByRole('button', { name: 'Choose files', exact: true })"`<br>`  files: [fixtures/brief.pdf]` | Sets files on a file field. If the target is the field itself (e.g. `getByLabel('Attachment')`), it gets the files directly; if it is a button in front of a hidden field, its click opens the file chooser and that gets them. Paths are relative to the `caw` folder and start with `fixtures/`; never absolute, never outside `caw/fixtures`, never a link out of it; a missing file stops the step before the click |
| `- download: "getByRole('button', { name: 'Export', exact: true })"`<br>`  file: "^report-.*\\.zip$"` | The click must start a download within the step's time limit, its file name must match the regular expression in `file` and the file must not be empty. Otherwise the step fails like an unmet check, without a second click. The tool deletes the file right after |
| `- remember: {name: davPassword, code: "...", secret: true}` | Like `remember`, but from then on the value is masked as `••••` in the terminal, the workbench, `result.json`, `report.md` and everything Claude gets, like the role's password. The run itself keeps using the real value |
| `getByRole('button', { name: /^Review( \\d+)?$/ })` | A regular expression instead of the exact name, for a live count or a changing part |
| `knownMessages:`<br>`  - {pattern: "^Checksum \\S+ copied$"}` | Next to fixed texts: a pattern for a message with changing content, such as a checksum or a time. Like fixed texts it sees the message with digits as `#`, always in full; only the report shortens long messages. A new recording keeps patterns and adds no fixed text a pattern already covers |

A check can read the clipboard: while a check, a `remember` or Claude's `eval` runs, the browser has `clipboard-read` for the environment's origin, at other times only `clipboard-write` (so the page under test cannot read your clipboard whenever it likes), e.g. `check: navigator.clipboard.readText().then((text) => text.startsWith('sha256:'))` (an expression that returns a promise is awaited).

## Placeholders

| Placeholder | Replaced with |
|---|---|
| `{{runTag}}` | A value unique per run, e.g. `CAW-20261109091543` |
| `{{runTagLower}}` | The same in lowercase, for URLs |
| `{{date}}`, `{{date+7}}`, `{{isoDate-1}}` | Dates relative to the day of the run: `{{date}}` in the browser's locale (`de-DE` 23.11.2026, `en-US` 11/23/2026, `en-GB` 23/11/2026), `{{isoDate}}` as 2026-11-23. While recording, a date at most 60 days from the recording day in the locale's format or ISO becomes one of them; a date in another locale's order stays as it is |
| `{{ticketnr}}` | A value read during the run with `remember` |

Claude adds these while recording. In the test plan you only need `{{runTag}}`. In a locator they are filled per text, so a value with a quote stays one string and a value inside a regular expression is escaped.
