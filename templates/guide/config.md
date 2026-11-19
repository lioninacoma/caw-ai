# caw: caw.config.json

JSON at the project root. Unknown keys are errors with a did-you-mean hint. Change it with `caw_config` `patch` (deep merge,
`null` deletes a key; arrays are replaced as a whole); only a valid result is written. Credentials never go into the config.
`caw_config` refuses commands and what decides where Claude runs and what it may do (`start`, `stop`, `reset`, `ready`, the
environment flags `production`, `agent`, `writable`, `allowHttp`, `insecureTls`, an overlay part's `start`, `lintCommand`,
`browser.executablePath`, `sandboxImage`, `sandboxUser`, `agent.mode`, and adding or removing an environment that has them):
name the exact change to the person and wait for their explicit yes in the conversation, even if your edits are approved
automatically; then edit the file with your own Edit tool.

## Top level

| Key | Meaning |
|---|---|
| `language` | Team language (plans, notes, Claude's chat texts), a tag such as `en`, `de`, `fr` |
| `framework` | `web` (no assumption), `react`, `vue`, `angular` (`extjs` with its extension) |
| `start` | Start path of every test, e.g. `/` or `/#/dashboard` |
| `signIn` | How caw signs in, for every environment without its own (below) |
| `roles` | `{ "<role>": {} }`; required when anything signs in, absent otherwise |
| `environments` | `{ "<env>": {...} }`, at least one (below) |
| `reads` | Request patterns that only read although they are not GET, e.g. `"POST /api/search"`, `"POST /graphql mutation TrackView"`, `"* /api/telemetry/**"` |
| `requestKeys` | Query parameter names that belong to a request's name (single-endpoint APIs) |
| `allowHosts` | Extra hosts for navigation in every environment, e.g. a shared identity provider. Host names, no URLs |
| `messageSelectors` | CSS selectors where the page shows messages; default `[role=alert]`, `[role=alertdialog]` |
| `consoleIgnore`, `foreignCode` | Regular expressions: console messages that never matter; errors from third-party code (they become warnings) |
| `readyIgnore`, `readyTimeoutMs` | Elements that never count as loading; how long to wait for a quiet page |
| `effects` | `{ "fail": [...] }`: which learned effects fail a step (`controls`, `view`, `requests`, `responses`, `console`) |
| `maxActions` | Claude's action budget per run (default 100) |
| `keepRuns` | how many run folders in `.caw/runs` caw keeps (default 30, 0 keeps all); older ones go when a run starts |
| `lintCommand` | The project's lint command, named in recommendations |
| `agent` | `{ "mode": "local"\|"docker"\|"session", "model", "maxBudgetUsd" }` |
| `browser` | `channel`, `executablePath`, `locale`, `timezone`, `viewport` (`{ width, height }`): pin them for replay |
| `sandboxImage`, `sandboxUser` | Docker sandbox image and user |

## environments.\<env\>

Names match `^[a-z][a-z0-9-]{0,31}$`.

| Key | Meaning |
|---|---|
| `url` | Origin, `https://host[:port]`; `http://` only on loopback or with `allowHttp: true` |
| `agent` | The agent may record, fix, explain and talk here (page content goes to Claude) |
| `writable` | Writing tests may run here |
| `production` | Production rules: no Claude, no writing, no lifecycle. A name like prod/live must state it |
| `extends` | Inherit another environment's keys (not `production`); values replace, never merge. Tenants: `south-dev` extends `north-dev` with another `url` |
| `signIn` | Replaces the top-level sign-in as a whole for this environment |
| `allowHosts` | Extra navigation hosts for runs here |
| `insecureTls`, `allowHttp` | Accept invalid certificates; allow `http` on a non-loopback host |
| `start`, `stop`, `reset` | Shell commands in the project root (`CAW_ENV`, `CAW_ENV_URL` set). `start` runs with `--start` when the environment does not answer, `stop` after; `reset` (needs `writable`) before the first writing test |
| `ready` | `{ "path": "/healthz", "timeoutMs": 60000 }`: the probe after `start` |

## signIn

| `type` | Fields |
|---|---|
| `none` | – |
| `form` | `path` (app path where sign-in starts), `signedInSelector`, and `userSelector` + `passwordSelector` (optional `submitSelector`, `codeSelector` for TOTP) or `steps` |
| `basic` | HTTP Basic; optional `signedInSelector` |
| `session` | `signedInSelector`, optional `path`; the session is saved per role with `caw_role` `action: "login"` |

`steps` (1–20) for multi-page or identity-provider sign-in, each with one verb: `{ "fill": "<sel>", "with": "user"|"password"|"totp" }`,
`{ "fill": "<sel>", "value": "<literal>" }`, `{ "click": "<sel>" }`, `{ "press": "Enter", "on": "<sel>" }`, `{ "waitFor": "<sel>" }`;
modifiers `optional: true` (skip if absent after 3 s) and `timeoutMs`. At least one step uses `with`. The provider's host goes
into `allowHosts`. Selectors are Playwright selectors (CSS, `text=`, `role=`).

## Test users

`caw/.env` (never in git, never read by you): `CAW_<ROLE>_USER`, `CAW_<ROLE>_PASSWORD`, `CAW_<ROLE>_TOTP`, with `__<ENV>` at the
end for an account of one environment (role and environment upper case, `-` as `_`). Added by the person through `caw_role add`.

## Example

```json
{
  "language": "en",
  "framework": "react",
  "start": "/",
  "signIn": { "type": "form", "path": "/login", "userSelector": "#email", "passwordSelector": "#password",
              "signedInSelector": "[data-testid=user-menu]" },
  "roles": { "clerk": {}, "admin": {} },
  "reads": ["POST /api/search"],
  "environments": {
    "local":   { "url": "http://localhost:5173", "agent": true, "writable": true, "start": "npm run dev" },
    "ci":      { "url": "http://localhost:8080", "writable": true, "start": "docker compose up -d --wait",
                 "stop": "docker compose down -v", "reset": "docker compose exec -T api npm run seed", "ready": { "path": "/healthz" } },
    "staging": { "url": "https://staging.example.com", "agent": true, "allowHosts": ["login.example-idp.test"],
                 "signIn": { "type": "form", "path": "/", "signedInSelector": "[data-testid=user-menu]",
                             "steps": [ { "fill": "#username", "with": "user" }, { "click": "#next" },
                                        { "fill": "#password", "with": "password" }, { "click": "#sign-in" } ] } },
    "prod":    { "url": "https://www.example.com", "production": true }
  }
}
```
