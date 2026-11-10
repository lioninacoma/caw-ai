English · [Deutsch](test-files.de.md)

# Test files

Each test has two YAML files:

| File | Written by | Commit? |
|---|---|---|
| `caw/tests/<id>.yaml` | you: what the test does, in plain language | yes |
| `caw/recordings/<id>.yaml` | caw-ai: how to replay it | yes, review it first |

You write the test plan. `record` writes the recording; by hand you only add the [extras](#hand-written-additions) Claude does not record. `recording` and `knownMessages` belong in the recording only; in the test plan `validate` rejects them.

## Test plan

```yaml
# caw/tests/create-ticket.yaml
id: create-ticket
app: web              # a name from apps in caw.config.json
role: user            # a name from roles (leave out without login)
targets: [local]      # environments this test may run on
mutates: true         # true if the test creates or changes data
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

| Field | Required | |
|---|---|---|
| `id` | no | Defaults to the file name; if given, it must match it. |
| `app` | if the config has several apps | App the test starts in. Defaults to the only app in the config. |
| `role` | with login, if the config has several roles | Role from the config. Defaults to the only role. |
| `targets` | no | Environments the test may run on. Defaults to all environments except production. |
| `mutates` | yes | `true` if it creates or changes data; such tests only run on environments with `writable: true`. `false` if it only reads. |
| `also` | no | More apps the flow passes through, e.g. `[admin]`. With `--overlay` their local code comes along too, if they have a source. |
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
npx caw-ai run create-ticket --target local       # exit 4: S2 changed, prints the fix command
npx caw-ai fix create-ticket S2 --target local    # re-record S2 only
```

`notes`, metadata, `retry` and `caw/caw.md` are not part of the hash. To add a step at the end, write it and `fix` it. Deleting or reordering steps needs a new `record`.

## Recording

Written by `record` and `fix`. Review it; change it only for the [hand-written additions](#hand-written-additions). An excerpt:

```yaml
# caw/recordings/create-ticket.yaml
# Written by caw-ai, belongs to caw/tests/create-ticket.yaml. Delete by hand if needed, never edit.

test: create-ticket
steps:
  - id: S2
    hash: 23b43d5acb2796dd
    after: S1
    recordedOn: local
    recordedAt: 2026-11-09T09:31:28.406Z
    actions:
      - click: {role: button, name: New ticket}
        path: /tickets
      - wait-ready: {}
      - fill: {role: textbox, name: Title, inside: {role: dialog, name: New ticket}}
        value: Printer offline {{runTag}}
        path: /tickets
      - type: {role: combobox, name: Customer, inside: {role: dialog, name: New ticket}}
        value: Acme
        path: /tickets
      - type: {role: combobox, name: Priority, inside: {role: dialog, name: New ticket}}
        value: High
        path: /tickets
      - click: {role: button, name: Create ticket, inside: {role: dialog, name: New ticket}}
        path: /tickets
      - wait-ready: {}
      - remember: {name: ticketnr, code: "(document.querySelector('[role=status]').textContent.match(/#(\d+)/)||[])[1]"}
    check: "(()=>{const s=document.querySelector('[role=status]');if(!s||!/^Ticket #\d+ created$/.test(s.textContent.trim()))return false;const n=s.textContent.match(/#(\d+)/)[1];return n==='{{ticketnr}}' && [...document.querySelectorAll('table[aria-label=\"Tickets\"] tbody tr')].some(r=>r.cells[0].textContent.trim()===n && r.cells[1].textContent.trim()==='Printer offline {{runTag}}');})()"
    network:
      - {name: GET /api/customers, status: 200, ms: 54, params: []}
      - {name: POST /api/tickets, status: 201, ms: 269, params: [json.customer, json.description, json.priority, json.title]}
      - {name: GET /api/tickets, status: 200, ms: 274, params: [q]}
    effects:
      runs: 1
      actions:
        - action: 4
          controls:
            - + select "Customer" required,filled
            - + button "Create ticket"
            - '- select "Customer" required,empty'
            - '- button "Create ticket" disabled'
```

| Field | |
|---|---|
| `actions` | What to do, with targets the way a human finds them: role and name, label, `data-testid`, the dialog around it. Never generated class names. |
| `path` | The page the action was recorded on. If a target is missing, the run tells you it is on a different page. |
| `check` | A JavaScript expression that must return `true`. It runs in the signed-in page, so read it before you commit. |
| `remember` | Reads a value the run creates, here the ticket number. Later steps use it as `{{ticketnr}}`. |
| `network` | Requests per step from a healthy run. Used to tell app bugs from environment problems. |
| `effects` | What each action changed on the page, learned from healthy runs (`runs` counts them). A change fails the step or shows as a warning. |
| `knownMessages` | Messages that were visible during recording and are not errors. |

## Hand-written additions

Claude doesn't record these; you add them to `caw/recordings/<id>.yaml` yourself. `validate` checks them. A new recording of the step by Claude replaces its actions, so add `upload` and `download` again afterwards; `secret` on a `remember` survives it.

| Syntax | Meaning |
|---|---|
| `- upload: {role: button, name: Choose files}`<br>`  files: [fixtures/brief.pdf]` | Sets files on a file field. If the target is the field itself (`role: textbox` with its label), it gets the files directly; if it is a button in front of a hidden field, its click opens the file chooser and that gets them. Paths are relative to the `caw` folder, never absolute and never outside it; a missing file stops the step before the click |
| `- download: {role: button, name: Export}`<br>`  file: "^report-.*\\.zip$"` | The click must start a download within the step's time limit, its file name must match the regular expression in `file` and the file must not be empty. Otherwise the step fails like an unmet check, without a second click. The tool deletes the file right after |
| `- remember: {name: davPassword, code: "...", secret: true}` | Like `remember`, but from then on the value is masked as `••••` in the terminal, the workbench, `result.json`, `report.md` and everything Claude gets, like the role's password. The run itself keeps using the real value |
| `name: {pattern: "^Review( \\d+)?$"}` | In a target, also under `inside`: a regular expression instead of the exact name, for a live count or a changing part. The pattern sees the full name. A fixed name over 80 characters is empty on the page and never matches; `validate` rejects it and suggests a pattern for its start |
| `frame: {tag: iframe, name: Payment}` | In a target: the element lies in an iframe of the application. `frame` describes the iframe in the document above it, like a target (usually `tag: iframe` and its `title` as `name`); nested iframes carry `frame` again. Recording adds it by itself. If the iframe is missing, the step says which one. An iframe from another host needs it in `extraAllowedHosts` |
| `knownMessages:`<br>`  - {pattern: "^Checksum \\S+ copied$"}` | Next to fixed texts: a pattern for a message with changing content, such as a checksum or a time. Like fixed texts it sees the message with digits as `#`, always in full; only the report shortens long messages. A new recording keeps patterns and adds no fixed text a pattern already covers |

A check can read the clipboard: the browser has `clipboard-read` and `clipboard-write` for the environment's origin, e.g. `check: navigator.clipboard.readText().then((text) => text.startsWith('sha256:'))` (an expression that returns a promise is awaited).

## Placeholders

| Placeholder | Replaced with |
|---|---|
| `{{runTag}}` | A value unique per run, e.g. `CAW-20261109091543` |
| `{{runTagLower}}` | The same in lowercase, for URLs |
| `{{today}}`, `{{today+7}}`, `{{todayIso-1}}` | Dates relative to the day of the run |
| `{{ticketnr}}` | A value read during the run with `remember` |

Claude adds these while recording. In the test plan you only need `{{runTag}}`.
