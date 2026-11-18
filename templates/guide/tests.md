# caw: test plans

A test plan is `caw/tests/<test>.yaml`. You may write a new one as the session; an existing one changes only through a run
(`record <test>@S<n>`, "{{label:run.button.fix}}") or a recommendation the person accepts. `caw/recordings/` is written only by caw.

```yaml
id: order-cancel            # optional; if given, equal to the file name
role: clerk                 # needed when the config has more than one role
writes: true                # required: true if the test creates or changes data
environments: [local, ci]   # optional, only to restrict where it runs
start: /orders              # optional, when the test begins on another page than the config's start
notes: |
  What applies to the whole test.
steps:
  - id: S1
    name: Open the order
    do: Search for the order created in S0 and open it.
    expect: The order detail shows status "open".
  - id: S2
    name: Cancel it
    do: Click "Cancel order" and confirm.
    expect: The status is "cancelled".
    note: Optional, applies only to this step.
    retry: {times: 2, waitMs: 15000, from: S2}   # optional, see topic plan
```

- **`writes`** decides where the test may run: a writing test runs only on `writable` environments, never on production. A
  read-only test (`writes: false`) that writes while recording becomes writing when it is adopted.
- **`environments`** defaults to every non-production environment (only writable ones for a writing test). Name it only to
  restrict; a read-only test may name a production environment as a smoke test.
- **Steps** are `S<n>` and never renumbered: a new step gets the next free number, the order in the file counts. Each step has
  exactly one result in `expect` and is a point where someone would want to open the test (`open <test>@S<n>` lands at its
  entry) or re-record from. Few steps that matter for the domain, not one per click. `do` may be `""` for a pure check step.
- Describe the path so someone else finds it, with paths and structures instead of data: no names, addresses, numbers or free
  texts from the application. Text the run creates is recognised by `{{runTag}}`, which caw makes unique per run.
- Write plans, step names and expectations in the team language (`language` in the config).
- A YAML value with ` #` must be quoted; `caw_validate` reports a comment that cut a value.

After writing, check it with `caw_validate` (unknown role, wrong environment, invalid fields), then record it (topic `run`).
A test may use a role that has no test user yet, but `record` and `run` then stop with `credentials-missing` before Chrome
starts, naming the variables: tell the person to fill them into `caw/.env` (never ask for the values).
