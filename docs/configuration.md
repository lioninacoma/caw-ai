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
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } }
}
```

With a login form:

```json
{
  "framework": "react",
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
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

`npx caw-ai init` writes a config like this for you.

## environments

Required. One entry per place your app runs. The name is what you pass to `--target`.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "agent": true, "localCode": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Field | |
|---|---|
| `url` | Origin of the app. `https`, or `http` for `localhost`, `127.0.0.1` and `*.localhost`. |
| `agent` | `true`: Claude may record, fix and investigate here. |
| `writable` | `true`: tests with `mutates: true` may run here. |
| `localCode` | `true`: serve app code from your project folder (see `assetUrlPattern`). |
| `production` | Required for names like `prod` or `live`. Such an environment can't have `agent`, `localCode` or `writable`. |
| `urls` | Instead of `url` when you use `sites`: `{ "north": "https://north.example.com", … }`. |

Anything not set to `true` is off. A run against `staging` above replays only, read-only tests only.

## auth

Leave it out if your app has no login.

| `type` | For | Fields |
|---|---|---|
| `form` | Login page with user and password | `path`, `userSelector`, `passwordSelector`, `signedInSelector`, optional `submitSelector` (else Enter submits), optional `codeSelector` for a TOTP second factor |
| `basic` | HTTP Basic Auth | `signedInSelector` (optional) |
| `storageState` | SSO, OAuth, MFA: you sign in once with `caw-ai auth` | `signedInSelector`, optional `path` |
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
"extraAllowedHosts": ["login.example-idp.com"],
"roles": { "user": {} }
```

```bash
npx caw-ai auth user --target dev   # sign in by hand once, session goes to caw/.auth/dev/user.json
```

## roles

One entry per kind of user your tests sign in as. Tests pick one with `role:`.

| `auth.type` | Role entry |
|---|---|
| `form`, `basic` | `{ "loginEnv": "CAW_LOGIN_ADMIN", "passwordEnv": "CAW_PW_ADMIN" }`: names of variables in `caw/.env`. Optional `totpEnv` for `codeSelector`. |
| `storageState` | `{}`: the session is stored per environment in `caw/.auth/` |
| none | leave `roles` out |

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
| `localBuild` | Local code: the build folder relative to the project, e.g. `"dist"` or `"dist/app/browser"`. Works with normal hashed builds (Vite, Angular CLI, webpack). |
| `statics` | Local code, single files: `[{ "name": "main.js", "path": "dist/main.js" }]` |
| `redirects`, `constants` | Local code for Sencha/ExtJS apps. |

## Everything else

| Field | Default | |
|---|---|---|
| `language` | detected | `en` or `de` for UI, CLI and reports. `CAW_LANG` overrides it. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` or `extjs`. Decides how targets are stored and when a page counts as ready. |
| `agent.sandbox` | `local` | Where Claude runs: `local` (Claude Code on your machine, read-only tools) or `docker`. Always `docker` in CI. |
| `extraAllowedHosts` | `[]` | More hosts Chrome may reach, e.g. login or CDN. Everything else is blocked. |
| `insecureTls` | `false` | Accept self-signed certificates. |
| `browser` | system Chrome | `{ "channel": "msedge" }` or `{ "executablePath": "/path/to/chromium" }` |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS selectors for error messages without ARIA roles. |
| `consoleIgnore` | `[]` | Regexes for known, harmless console errors. Keep them narrow. |
| `foreignCode` | `[]` | Regexes for third-party scripts, e.g. `"/vendor/"`. Their errors become warnings. |
| `requestKeys` | `[]` | Query parameters that name a request, e.g. `["action"]` for single-endpoint APIs. |
| `effects.fail` | `["controls", "console"]` | Which learned effects fail a step when they change. `[]` makes all of them warnings. |
| `maxSteps` | `100` | Claude's action budget when recording and fixing. |
| `readyTimeoutMs` | | How long to wait for the app to settle. |
| `lintCommand` | | Your check command, e.g. `npm run lint`. Claude mentions it in code suggestions. |
| `assetUrlPattern` | | Regex for requests that load app code; group 1 is the file name in `statics`/`redirects`/`constants`, or the path inside `localBuild`. Without it, `localBuild` uses the path below the environment URL. |
| `sites` | | Same app for several tenants: `["north", "south"]`, then `urls` per environment. |
| `extends` | | Shared defaults from a file, e.g. `"./caw/presets/base.json"`. |
| `sandboxImage` | `node:22-bookworm-slim` | Base image for the `docker` agent. Falls back to `image` in `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | User inside the container. |

## caw/caw.md

Plain Markdown, like a `CLAUDE.md` for your tests. Write down things Claude can't see in the code but that matter in every test:

```markdown
## Search
- The search keeps the last input across sessions. Click "Clear filter" first.
```

Changing it never invalidates a recording. No personal data.

## Personal settings

Workbench choices (theme, animations, collapsed panels, the token notice) are stored per user in `prefs.json` under `CAW_AI_HOME`, default `%APPDATA%\caw-ai` or `~/.config/caw-ai`. Not in the project.
