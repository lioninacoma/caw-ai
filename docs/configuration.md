English · [Deutsch](configuration.de.md)

# Configuration

caw-ai reads three things from your project:

| File | What | Commit? |
|---|---|---|
| `caw.config.json` | Environments, login, apps, roles | yes |
| `caw/.env` | Test account credentials | **no** (gitignored) |
| `caw/caw.md` | Project notes Claude reads in every run | yes |

Tests live in `caw/tests/` and `caw/recordings/`, see [Test files](test-files.md).

## Minimal config

An app on a local dev server, no login:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } }
}
```

With a login form:

```json
{
  "framework": "react",
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "auth": {
    "type": "form",
    "path": "/login",
    "userSelector": "#email",
    "passwordSelector": "#password",
    "signedInSelector": "[data-testid=user-menu]"
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } },
  "roles": {
    "user": { "loginEnv": "CAW_LOGIN_USER", "passwordEnv": "CAW_PW_USER" }
  }
}
```

```bash
# caw/.env
CAW_LOGIN_USER=test-user@example.com
CAW_PW_USER=secret
```

`caw/.env` is read like dotenv: `KEY=value`, optionally in quotes; a comment after the value needs a space before `#` (`KEY=value # note`). A `#` without a space before it belongs to the value; quote values that contain ` #`.

`npx caw init` writes a config like this for you, and the role with its test user: after **Done** you name the role in the window, **Save** writes the variables to `caw/.env`. Environment variables of the same name win over `caw/.env`, e.g. in CI.

## environments

Required. One entry per place your app runs. The name is what you pass to `--env`.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "claude": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Field | |
|---|---|
| `url` | Origin of the app. `https`, or `http` for `localhost`, `127.0.0.1` and `*.localhost`. |
| `claude` | `true`: Claude may record, fix and investigate here. |
| `writable` | `true`: tests with `mutates: true` may run here. |
| `production` | Required for names like `prod` or `live`. Such an environment can't have `claude` or `writable`. A run there sends no write requests: each one is aborted and fails the step with `write-blocked` (`reads` names requests that only read). Runs on other environments never reach its host. |
| `urls` | Instead of `url` when you use `sites`: `{ "north": "https://north.example.com", … }`. |

Anything not set to `true` is off. A run against `staging` above replays only, read-only tests only, against the deployed version.

### Starting, stopping and resetting an environment

An environment may name your own commands to start, stop and reset it. caw runs them only when asked, and never on a
`production` environment.

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

## auth

Leave it out if your app has no login.

| `type` | For | Fields |
|---|---|---|
| `form` | Login page with user and password | `path`, `userSelector`, `passwordSelector`, `signedInSelector`, optional `submitSelector` (else Enter submits), optional `codeSelector` for a TOTP second factor |
| `basic` | HTTP Basic Auth | `signedInSelector` (optional) |
| `storageState` | SSO, OAuth, MFA: you sign in once with `caw role login` | `signedInSelector`, optional `path` |
| `none` | No login (same as leaving `auth` out) | – |

`signedInSelector` is a CSS selector that only exists when you are signed in. If it disappears during a run, caw-ai reports a lost login.

Second factor (TOTP): set `codeSelector` to the one-time code field and give the role a `totpEnv` with the account's Base32 secret. caw-ai fills in the current code (RFC 6238, SHA-1, 30 s, 6 digits). If the app refuses the code because the account already signed in within the same 30 s window (the code field stays and `signedInSelector` does not appear within 10 s), caw-ai waits for the next window and tries once more.

```json
"auth": { "type": "form", "path": "/login", "userSelector": "#user", "passwordSelector": "#password",
          "codeSelector": "#otp", "signedInSelector": "[data-testid=user-menu]" },
"roles": { "user": { "loginEnv": "CAW_LOGIN_USER", "passwordEnv": "CAW_PW_USER", "totpEnv": "CAW_TOTP_USER" } }
```

SSO example:

```json
"auth": { "type": "storageState", "signedInSelector": "app-user-menu" },
"allowHosts": ["login.example-idp.com"],
"roles": { "user": {} }
```

```bash
npx caw role login user --env dev   # sign in by hand once, session goes to caw/.auth/dev/user.json
```

## roles

One entry per kind of user your tests sign in as. Tests pick one with `role:`.

| `auth.type` | Role entry |
|---|---|
| `form`, `basic` | `{ "loginEnv": "CAW_LOGIN_ADMIN", "passwordEnv": "CAW_PW_ADMIN" }`: names of variables in `caw/.env`. Optional `totpEnv` for `codeSelector`. |
| `storageState` | `{}`: the session is stored per environment in `caw/.auth/` |
| none | leave `roles` out |

Add a role with `npx caw role add <role> --env <env>`: sign in with the test account in the window, name the role, **Save**. caw-ai writes the entry above, the values to `caw/.env` and `caw/.env` to `.gitignore`. Without a window (CI) set the variables in the environment. See [role](commands.md#role).

Use test accounts with as few rights as possible. Claude drives a browser signed in as this user.

## apps

Required. Usually one app; monorepos can list several.

```json
"apps": {
  "web":   { "dir": "apps/web", "startUrl": "/" },
  "admin": { "dir": "apps/admin", "startUrl": "/admin" }
}
```

| Field | |
|---|---|
| `dir` | App folder relative to the project, `.` for a single app. |
| `startUrl` | Path where tests start. Only needed for apps a test starts in. |

## Testing local code

caw-ai knows two modes:

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
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
}
```

`--env local` then tests what is in your editor (Vite, `ng serve`, webpack dev server, Next.js, Nuxt).

### Local code on a deployed environment

For apps that only run inside a deployed environment (portal, shell, backend only on staging), the [overlay extension](extensions/overlay.md) lays your local code over the environment. It is active only with an `overlay` block in the config.

## Everything else

| Field | Default | |
|---|---|---|
| `language` | detected | `en` or `de` for UI, CLI and reports. `CAW_LANG` overrides it. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` or `extjs`. Decides how targets are stored and when a page counts as ready. |
| `agent.mode` | `local` | Where Claude runs: `local` (Claude Code on your machine, read-only tools) or `docker`. Always `docker` in CI. |
| `agent.model` | Claude Code's default | Model for Claude, passed as `--model`, e.g. `haiku` or `sonnet`. `CAW_CLAUDE_MODEL` overrides it for one run. |
| `agent.maxBudgetUsd` | none | Stops a Claude run at this estimated spend in US dollars (`--max-budget-usd`). `CAW_CLAUDE_BUDGET` overrides it. |
| `allowHosts` | `[]` | More hosts pages may navigate to, e.g. a sign-in service; also per environment as `environments.<env>.allowHosts`. Pages navigate only to the environments' hosts and these (links, form posts, popups, redirects, `goto`); anything else fails with `host-blocked`. Scripts, styles, fonts, images, XHR/fetch, WebSockets and iframes may go to any host. Production hosts of other environments stay unreachable for every request. |
| `insecureTls` | `false` | Accept self-signed certificates. |
| `browser` | system Chrome | `{ "channel": "msedge" }` or `{ "executablePath": "/path/to/chromium" }` |
| `browser.locale`, `browser.timezone` | as recorded | Language and time zone of the test browser, e.g. `"de-DE"` and `"Europe/Berlin"`. Without them a replay uses the values stored with the recording, and a recording uses the host's. Dates, numbers and translations then look the same on every machine and CI runner. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS selectors for error messages without ARIA roles. |
| `consoleIgnore` | `[]` | Regexes for known, harmless console errors. Keep them narrow. |
| `foreignCode` | `[]` | Regexes for third-party scripts, e.g. `"/vendor/"`. Their errors become warnings. |
| `requestKeys` | `[]` | Parameters that name a request, for single-endpoint APIs: query parameters such as `["action"]`, or top-level JSON body fields as `json.<key>`, e.g. `["json.method"]` for JSON-RPC. A GraphQL request is named by its operation without this: `POST /graphql mutation CloseTicket`. |
| `reads` | `[]` | Requests that only read although they are no GET, e.g. `["POST /api/search"]`. A pattern is a method (or `*`) and a path, then optionally key and GraphQL tokens: `*` matches within a path segment (any characters in the other tokens), `**` anything. `"POST /api/*/query"`, `"POST /api/proxy op=load*"`, `"POST /graphql mutation TrackView"`, `"* /api/telemetry/**"`. A pattern that ends in its path never matches a GraphQL request. Top level only: it is the same app in every environment. |
| `effects.fail` | `["controls", "console"]` | Which learned effects fail a step when they change. `[]` makes all of them warnings. |
| `maxSteps` | `100` | Claude's action budget when recording and fixing. |
| `readyTimeoutMs` | | How long to wait for the app to settle. |
| `readyIgnore` | `[]` | CSS selectors of areas that change by themselves, e.g. `["#ticker", ".clock", "footer [role=progressbar]"]`. Their DOM changes and progress indicators don't count when waiting for a quiet page. Spinners without size, hidden or outside the viewport never count. If a page never gets quiet, the report says so once per step. |
| `lintCommand` | | Your check command, e.g. `npm run lint`. Claude mentions it in code suggestions. |
| `sites` | | Same app for several tenants: `["north", "south"]`, then `urls` per environment. |
| `extends` | | Shared defaults from a file, e.g. `"./caw/base.json"`. |
| `sandboxImage` | `node:22-bookworm-slim` | Base image for the `docker` agent. Falls back to `image` in `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | User inside the container. |
| `theme` | | Team default for the workbench: `{ "base": "phosphor", "colors": { … } }`. A personal choice in `prefs.json` wins. See [Themes](../themes/README.md#team-default). |

## caw/caw.md

Plain Markdown, like a `CLAUDE.md` for your tests. Write down things Claude can't see in the code but that matter in every test:

```markdown
## Search
- The search keeps the last input across sessions. Click "Clear filter" first.
```

Changing it never invalidates a recording. No personal data.

## Personal settings

Workbench choices (theme, animations, collapsed panels, the token notice) are stored per user in `prefs.json` under `CAW_AI_HOME`, default `%APPDATA%\caw-ai` or `~/.config/caw-ai`. Not in the project.
