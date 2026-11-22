English · [Deutsch](configuration.de.md)

# Configuration

caw reads three things from your project:

| File | What | Commit? |
|---|---|---|
| `caw.config.json` | Environments, sign-in, roles | yes |
| `caw/.env` | Test users' credentials | **no** (gitignored) |
| `caw/caw.md` | Project notes the agent reads in every run | yes |

Tests live in `caw/tests/` and `caw/recordings/`, see [Test files](test-files.md).

`caw.config.json` and the recordings are executable configuration: the config names shell commands caw runs (`start`,
`stop`, `reset`, `lintCommand`, `anonymize.command`, an overlay part's `start`) and the browser it launches, and a recording's `check` and
`remember` steps run their code in the page. Review changes to them like code, whoever made them.

## Minimal config

An app on a local dev server, no sign-in:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  }
}
```

With a sign-in form:

```json
{
  "framework": "react",
  "start": "/",
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  },
  "signIn": {
    "type": "form",
    "path": "/login",
    "userSelector": "#email",
    "passwordSelector": "#password",
    "signedInSelector": "[data-testid=user-menu]"
  },
  "roles": { "user": {} }
}
```

```bash
# caw/.env
CAW_USER_USER=test-user@example.com
CAW_USER_PASSWORD=secret
```

`npx caw init` writes a config like this for you. With `--explore-only` it first looks at the app and you sign in once; it
then suggests the sign-in (see [init](commands.md#init)). The test users you fill into `caw/.env` yourself; caw never writes them.

## environments

Required. One entry per place your app runs. The name is what you pass to `--env`: lowercase letters, digits and `-`,
starting with a letter, at most 32 characters.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "agent": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "agent": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Field | |
|---|---|
| `url` | Origin of the app. `https`, or `http` for this machine (`localhost`, `127.0.0.1`, `*.localhost`). |
| `agent` | `true`: the agent may record, fix and investigate here. |
| `writable` | `true`: tests with `writes: true` may run here. |
| `production` | Required for names that look like production (`prod`, `live`, `prod-eu` …). Such an environment can't have `agent` or `writable`. A run there sends no write requests, to any host: every request that is no GET, HEAD, OPTIONS, GraphQL query or `reads` pattern is aborted and fails the step with `write-blocked`, a form post into the top window too. Sign-in requests pass only while caw itself signs in; a token refresh the app sends later is a write unless `reads` names it. Not covered: messages the app sends over an open WebSocket (reading apps send them too, e.g. keep-alives and subscriptions). Runs on other environments never reach its host. A name that only looks like production says `"production": false`. |
| `insecureTls` | `true`: accept a self-signed certificate on this environment. |
| `allowHttp` | `true`: allow `http` on a host that is not this machine (an intranet without TLS). |
| `allowHosts` | More hosts pages may navigate to here, e.g. the sign-in service; adds to the top-level `allowHosts`. |
| `thirdPartyHosts` | More hosts the browser may reach here while an agent can act in the window; adds to the top-level `thirdPartyHosts`. |
| `signIn` | A sign-in for this environment only; replaces the top-level `signIn` as a whole. See [signIn](#signin). |
| `gate` | `{ "type": "basic" }`: an HTTP Basic gate in front of the app (common on staging), with its own account `CAW_GATE_USER` / `CAW_GATE_PASSWORD`. Not together with `signIn.type: basic`. |
| `start`, `stop`, `reset`, `ready` | Your commands for this environment, see [below](#starting-stopping-and-resetting-an-environment). |
| `extends` | Another environment whose fields this one takes over; its own fields replace them (lists and objects as a whole). `production` is never taken over. Useful for tenants: `"south": { "extends": "north", "url": "https://south.example.com" }`. |

Anything not set to `true` is off. A run against `staging` above replays only, read-only tests only, against the deployed
version.

Which environment a command takes: the one you name with `--env`. Without it, a test that runs on exactly one environment
takes that one; on your machine the only environment with `agent: true` among its candidates is taken; in CI caw never
guesses and names the candidates (exit 3).

### URL override for PR previews

A preview environment whose address is only known in the CI job gets it from the variable `CAW_URL__<ENV>` (environment
name in capitals, `-` as `_`, as for [credentials](#roles)), e.g. `CAW_URL__PREVIEW=https://pr-42.preview.example.com` for
`"preview": { "url": "https://preview.example.com", "writable": true }`. It applies to this process only and is never written
to `caw.config.json`; the first line of `run` names it (`Address from CAW_URL__PREVIEW: …`). Environments that inherit the
`url` through `extends` keep theirs. caw refuses it (`url-override`, exit 3) for an unknown environment, a production
environment, an environment with `agent: true` (a variable must not redirect where the agent works unseen), an address that is
no valid origin (the same rule as `url`) and the host of a production environment, since a run never blocks its own host and
the production block would be gone.

### Starting, stopping and resetting an environment

An environment may name your own commands to start, stop and reset it. caw never runs them on a `production` environment.
`start` runs only with `--start` (`caw_start` with `start`), `stop` only after a `start` caw did. `reset` runs with
`--reset` before the first test, and by itself in `run` once before the first writing test, unless `--no-reset`.

```json
"ci": {
  "url": "http://localhost:8080", "writable": true,
  "start": "docker compose -f ci/compose.yaml up -d --wait",
  "stop":  "docker compose -f ci/compose.yaml down -v",
  "reset": "docker compose -f ci/compose.yaml exec -T api npm run seed",
  "ready": { "path": "/healthz", "timeoutMs": 120000 }
}
```

| Field | |
|---|---|
| `start` | Shell command that starts the environment. Runs only with `--start`. caw doesn't wait for it to end: a command that detaches (`up -d`) and one that keeps running (`npm run dev`) both work. |
| `stop` | Shell command that stops it. Only together with `start`, and only when caw started the environment. A long-running `start` is then ended with its child processes. |
| `reset` | Shell command that resets the data. Needs `writable: true`. `run` runs it once before the first writing test, `--reset` before the first test, `--no-reset` never. `record` and `open` only with `--reset`. |
| `ready` | When the environment counts as up: a GET to `path` (default `/`) answers below 500. caw asks every second for `timeoutMs` (default 60000, 1000 to 1800000). |

Commands run in the project folder with your platform's shell (`cmd.exe` on Windows, `/bin/sh` elsewhere), with
`CAW_ENV` and `CAW_ENV_URL` set. Their output goes to `.caw/env/<env>-start.log`, `-stop.log` and `-reset.log`.

- If the environment already answers, `--start` uses it and neither starts nor stops it.
- A `start` that ends with an error first fails with `env-start-failed`. One that never gets ready fails with `env-not-ready`.
  Either way caw stops what it started.
- A failing `reset` (or one taking longer than 10 minutes) fails with `env-reset-failed`, and no test runs.
- Without `--start`, an environment that doesn't answer fails with `env-unreachable`; the message names `--start` when
  `start` is set.
- The `CI` variable changes none of this: `--start` is always explicit.

## signIn

Leave it out if your app has no sign-in. Set it at the top level, or per environment (`environments.<env>.signIn`), e.g.
no sign-in on `local` and an identity provider on `staging`.

| `type` | For | Fields |
|---|---|---|
| `form` | A sign-in page with user name and password | `path`, `signedInSelector`, and either `userSelector` + `passwordSelector` (optional `submitSelector`, else Enter submits; optional `codeSelector` for a one-time code) or `steps` |
| `basic` | HTTP Basic | `signedInSelector` (optional) |
| `session` | SSO, OAuth, MFA you can't automate: you sign in once with `caw role login`, caw reuses the stored session | `signedInSelector`, optional `path` (default `/`) |
| `none` | No sign-in (same as leaving `signIn` out) | – |

- `path` is a path of the app, starting with `/`. Sign-in starts at `<url><path>`; that page may redirect to an identity
  provider. It is never the provider's address.
- `signedInSelector` exists only when you are signed in, on the app. If it disappears during a run, caw reports a lost
  sign-in.
- Selectors are Playwright selector strings: CSS by default, `text=` and `role=` too.

### Sign-in steps

For an identity provider (Keycloak, Entra ID, Okta …), identifier-first pages or extra prompts. Each step has exactly one
verb, 1 to 20 steps, at least one fills from the test user:

```json
"signIn": {
  "type": "form",
  "path": "/login",
  "signedInSelector": "[data-testid=user-menu]",
  "steps": [
    { "fill": "#username", "with": "user" },
    { "click": "#next" },
    { "waitFor": "#password" },
    { "fill": "#password", "with": "password" },
    { "click": "#sign-in" },
    { "fill": "#otp", "with": "totp" },
    { "press": "Enter", "on": "#otp" },
    { "click": "text=Stay signed in", "optional": true }
  ]
},
"allowHosts": ["login.example-idp.com"]
```

| Step | |
|---|---|
| `{ "fill": "<selector>", "with": "user" \| "password" \| "totp" }` | The role's user name, password or current one-time code |
| `{ "fill": "<selector>", "value": "<text>" }` | A fixed text that is no secret, e.g. a tenant or domain |
| `{ "click": "<selector>" }` | Click |
| `{ "press": "<key>", "on": "<selector>" }` | Press a key, on `on` or on the focused element |
| `{ "waitFor": "<selector>" }` | Wait until the element is visible |
| `"optional": true` | Skip the step if its element isn't visible within 3 s ("Stay signed in?") |
| `"timeoutMs"` | How long a step waits for its element, default 30000 |

Steps run in order from `<url><path>`, on whatever page is current; the provider's host must be in `allowHosts`. After the
last step caw waits up to 30 s for `signedInSelector`. `init --explore-only` suggests the steps when you sign in at a
provider there.

### One-time codes

Give the role a TOTP secret (`CAW_<ROLE>_TOTP`, Base32 as in the `otpauth://` link) and use `codeSelector` or a
`with: "totp"` step. caw fills in the current code (RFC 6238, SHA-1, 30 s, 6 digits). If the app refuses it because the
account already signed in within the same 30 s window, caw waits for the next window and tries once more. Passwords and
codes are masked in trace, logs and reports.

### Stored session

```json
"signIn": { "type": "session", "signedInSelector": "[data-testid=user-menu]" },
"allowHosts": ["login.example-idp.com"]
```

```bash
npx caw role login user --env dev   # sign in by hand once; the session goes to caw/.auth/dev/user.json
```

`caw/.auth/` is gitignored. Without the file a run stops with `auth-missing` and names this command; when the session has
expired it names it too. In CI, put the file there from a secret before the run.

## roles

One entry per kind of user your tests sign in as. A role is an empty object; tests pick one with `role:`. Names follow the
environment names; `gate` is reserved.

```json
"roles": { "clerk": {}, "admin": {} }
```

The credentials follow a naming convention, never the config:

```bash
# caw/.env
CAW_CLERK_USER=clerk@example.com
CAW_CLERK_PASSWORD=secret
CAW_CLERK_TOTP=JBSWY3DPEHPK3PXP        # only for one-time codes
CAW_CLERK_USER__STAGING=qa.clerk       # another account on staging
CAW_CLERK_PASSWORD__STAGING=secret2
```

- The suffix `__<ENV>` (environment name in capitals, `-` as `_`) is the account for that environment. A set is taken as a
  whole: if any variable of the suffixed set exists, caw never mixes in the unsuffixed ones.
- Variables of the process (CI) win over `caw/.env`.
- `caw/.env` is read like dotenv: `KEY=value`, optionally in quotes; a comment after the value needs a space before `#`.

Add a role with `npx caw role add <role>`: it goes into the config and its variable names into `caw/.env.example`; the values
you fill into `caw/.env` yourself, caw never asks for them. See [role](commands.md#role). Use test accounts with as few rights as
possible: the agent drives a browser signed in as this user.

## Testing local code

caw knows two modes:

- **E2E** (default, CI, nightly, every plain `run`): always the deployed code of the environment, also with `open <test>`.
- **Development:** your local code, from your dev server as an environment, or with the [overlay extension](extensions/overlay.md). Nothing switches to it silently.

Every run names the code in its first lines, in CI too:

```
Code: deployed
Code: dev server localhost:5173, your current version
```

### Your dev server as an environment

Testing against your local dev server needs no option. The dev server is an environment like any other:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
}
```

`--env local` then tests what is in your editor (Vite, `ng serve`, webpack dev server, Next.js, Nuxt).

### Local code on a deployed environment

For apps that only run inside a deployed environment (portal, shell, backend only on staging), the [overlay extension](extensions/overlay.md) lays your local code over the environment. It is active only with an `overlay` block in the config.

## Everything else

| Field | Default | |
|---|---|---|
| `language` | detected by init | The team language, a code such as `en`, `de` or `fr`: the agent writes plans, step names and `report.md` in it. caw's own texts (CLI, workbench) use it too when it is `en` or `de`, so a project speaks one language; `CAW_LANG` sets your own. Otherwise they follow your system. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` or [`extjs`](extensions/extjs.md). Decides when a page counts as ready and what a failure report names. |
| `start` | `/` | Path where tests start; a test can set its own `start`. |
| `source` | `.` | Where the app's source is, relative to the project, or `false` when it is not in this repository (then the agent gives no code advice). |
| `agent.mode` | `local` | Where the agent runs: `local` (Claude Code on your machine, read-only tools), `docker` (isolated) or `session` (your own Claude Code session). Always `docker` in CI. |
| `agent.model` | Claude Code's default | Model for the agent, passed as `--model`, e.g. `haiku` or `sonnet`. `CAW_AGENT_MODEL` overrides it for one run. |
| `agent.maxBudgetUsd` | none | Stops an agent run at this estimated spend in US dollars (`--max-budget-usd`). `CAW_CLAUDE_BUDGET` overrides it. |
| `maxActions` | `100` | The agent's action budget when recording and fixing. |
| `keepRuns` | `30` | How many run folders `.caw/runs` keeps. When a run starts, caw deletes the oldest beyond this; a run that is still open is never deleted, nor a reproduction whose draft is still in `caw/drafts` (it holds the suspected cause). `0` keeps every run. |
| `allowHosts` | `[]` | More hosts pages may navigate to, e.g. a sign-in service; also per environment. Pages navigate only to the environments' hosts and these (links, form posts, popups, redirects, `goto`); anything else fails with `host-blocked`. Without the agent, scripts, styles, fonts, images, XHR/fetch, WebSockets and iframes may go to any host. Production hosts of other environments stay unreachable for every request. Hosts are compared by name (case and a trailing dot do not matter); a host reached by its IP address is not recognised. |
| `thirdPartyHosts` | `[]` | Hosts of other parties the app needs while an agent can act in the window (record, a run with chat, `open`), e.g. `["fonts.example-cdn.com"]`; also per environment. Then every request of the browser (pages, scripts, XHR/fetch, WebSockets, beacons, iframes) goes only to the environments, `allowHosts` and these; anything else is aborted and named as a warning in the run, with this key. A production host listed here stays blocked. Otherwise the list does nothing. |
| `browser` | system Chrome | `{ "channel": "msedge" }` (`chrome`, `chrome-beta`, `chrome-dev`, `msedge`, `msedge-beta`, `msedge-dev`) or `{ "executablePath": "/path/to/chromium" }` (an absolute path on this machine; no network share, `\\?\` or `/proc` path) |
| `browser.noSandbox` | `false` | `true` starts Chrome without its sandbox. Unsafe: a page that breaks Chrome's renderer then runs with your rights. Only for machines where the sandbox cannot start (Linux as root, some containers); caw stops with `browser-sandbox` there instead of falling back on its own. |
| `browser.locale`, `browser.timezone`, `browser.viewport` | as recorded | Language, time zone and size of the test browser, e.g. `"de-DE"`, `"Europe/Berlin"`, `{ "width": 1280, "height": 800 }`. Without them a replay uses the values stored with the recording, and a recording uses the host's. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS selectors for error messages without ARIA roles. |
| `consoleIgnore` | `[]` | Regexes for known, harmless console errors. Keep them narrow. |
| `foreignCode` | `[]` | Regexes for third-party scripts, e.g. `"/vendor/"`. Their errors become warnings. |
| `requestKeys` | `[]` | Parameters that name a request, for single-endpoint APIs: query parameters such as `["action"]`, or top-level JSON body fields as `json.<key>`, e.g. `["json.method"]` for JSON-RPC. A GraphQL request is named by its operation without this: `POST /graphql mutation CloseTicket`. |
| `reads` | `[]` | Requests that only read although they are no GET, e.g. `["POST /api/search"]`. A pattern is a method (or `*`) and a path, then optionally key and GraphQL tokens: `*` matches within a path segment (any characters in the other tokens), `**` anything. `"POST /api/*/query"`, `"POST /api/proxy op=load*"`, `"POST /graphql mutation TrackView"`, `"* /api/telemetry/**"`. A pattern that ends in its path never matches a GraphQL request. Top level only: it is the same app in every environment. |
| `effects.fail` | `["controls", "console"]` | Which learned effects fail a step when they change. `[]` makes all of them warnings. |
| `design.fail` | `["target", "visual"]` | What fails a step: `target` its screen does not match its target design (`design:` in the test file), `visual` the learned look of a step with `look: true` changed (visual regression), `lint` the token lint found something, `fixedData` the [fixed data](test-files.md#fixed-data) of a look no longer fits the backend (otherwise warnings). `[]` only warns. |
| `visual.screenshots` | `false` | Every passed step gets its screen as `step-S3.png` in the run's `agent` folder and `screenshot` in `result.json`. |
| `visual.tolerance` | `24` | How far a color channel (0–255) may differ before a pixel counts as different. |
| `visual.maxRatio` | `0.01` | Share of differing pixels a learned look may have (only steps with `look: true` learn one, [visual regression](test-files.md#visual-regression); pixels only in headless runs). |
| `visual.designMaxRatio` | `0.03` | The same against a `.png` target design. The three thresholds are starting values until `e2e/spike/visual` has measured the noise between runs. |
| `visualIgnore` | `[]` | CSS selectors of areas no pixel comparison looks at, e.g. `["#clock", ".avatar"]`. The run tag, remembered values, numeric dates, list rows, list entries (`li`, `listitem`, not in navigation or menus) and cards (`article`) are masked anyway. Visual regression is meant for steps with fixed data; this covers the rest. |
| `anonymize.command` | | Your own command that anonymizes [fixed data](test-files.md#fixed-data) before it is stored, as a list without a shell, e.g. `["node", "tools/anonymize.mjs"]`, run in the project folder. It gets `{ "version": 1, "keep": [...], "answers": [{ "name", "body" }] }` on stdin and writes `{ "answers": [{ "body" }] }` on stdout, in the same order and with the same structure. Without it caw uses its own replacement. The agent cannot change `anonymize`: it is edited in the file. |
| `anonymize.keep` | `[]` | Values caw's own anonymization keeps as they are, e.g. currency codes or states the app interprets: `["EUR", "OPEN"]`. Every other text is replaced. |
| `readyTimeoutMs` | | How long to wait for the app to settle. |
| `readyIgnore` | `[]` | CSS selectors of areas that change by themselves, e.g. `["#ticker", ".clock", "footer [role=progressbar]"]`. Their DOM changes and progress indicators don't count when waiting for a quiet page. Spinners without size, hidden or outside the viewport never count. If a page never gets quiet, the run says so and names `readyIgnore`. |
| `lintCommand` | | Your check command, e.g. `npm run lint`. The agent mentions it in code suggestions. |
| `sandboxImage` | `node:22-bookworm-slim` | Base image for the `docker` agent. Falls back to `image` in `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | User inside the container. |
| `overlay` | | Turns on the [overlay extension](extensions/overlay.md). |

Any other field is reported as unknown (`Unknown field: …`). That includes `theme`: the workbench has one look in a light and a dark mode, which you pick for yourself (see [Personal settings](#personal-settings)).

## caw/caw.md

Plain Markdown, like a `CLAUDE.md` for your tests. Write down things the agent can't see in the code but that matter in every test:

```markdown
## Search
- The search keeps the last input across sessions. Click "Clear filter" first.
```

Changing it never invalidates a recording. No personal data.

### Your own caw.md

Next to `prefs.json` (see below) a `caw.md` holds your personal notes for the agent, the same in every project: how you want
findings reported, what you always want looked at, words you use. The agent reads it in every run where it works (recording, the
chat, `--explain`, developing, `reproduce`, your own session as the agent; in Docker as text in the task) before the project's
`caw/caw.md`, which wins where the two disagree. It never goes into a test, a recording or the project. The report notes that it
was read (path and number of lines, not its content), and `caw doctor` shows whether there is one.

Both files can grow from a run: the agent's advice may propose a line for either. The card names the file (project, shared
through git, or personal, with its path), and only your click on "Accept" writes it. Nothing else outside the project is ever written that way.

## Personal settings

Workbench choices and your language are stored per user in `prefs.json` under `CAW_AI_HOME`, default `%APPDATA%\caw-ai`
or `~/.config/caw-ai`. Not in the project. Your own `caw.md` (see above) lies in the same folder.

| Key | Values | |
|---|---|---|
| `mode` | `system` (default), `light`, `dark` | Light or dark for workbench, chat, report page and the "caw explore" card. `system` follows your operating system. |
| `animations` | `on` (default), `off` | `off` stops the spinner, pulsing dots and the blinking cursor (F10). |
| `steps`, `chat` | `open` (default), `closed` | Whether the steps and the chat panel are open when a run starts (F4, F6). |
| `tokenNotice` | `on` (default), `off` | `off` skips the notice before the agent uses tokens. Set by "Don't ask again"; remove it to get the notice back. |
| `language` | `de`, `en` | Your language for caw's own texts. `CAW_LANG` wins over it. |

The workbench's settings page (Ctrl+,) sets `mode`, `animations`, `steps` and `chat` and shows the rest read-only: the
page shares its origin with the application under test, so it may change only how the workbench looks. Unknown keys and
values are ignored.
