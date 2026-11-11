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

`npx caw-ai init` writes a config like this for you.

## environments

Required. One entry per place your app runs. The name is what you pass to `--target`.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Field | |
|---|---|
| `url` | Origin of the app. `https`, or `http` for `localhost`, `127.0.0.1` and `*.localhost`. |
| `claude` | `true`: Claude may record, fix and investigate here. |
| `writable` | `true`: tests with `mutates: true` may run here. |
| `overlay` | `true`: `--overlay` may lay your local code over this deployed environment. It only allows it and switches nothing on. Not needed for a dev server on your machine. See [Testing local code](#testing-local-code). |
| `production` | Required for names like `prod` or `live`. Such an environment can't have `claude`, `overlay` or `writable`. |
| `urls` | Instead of `url` when you use `sites`: `{ "north": "https://north.example.com", … }`. |

Anything not set to `true` is off. A run against `staging` above replays only, read-only tests only, against the deployed version.

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
| `overlay` | Where `--overlay` takes the app's local code from: local code server (`url`) and its start command (`start`), build folder, fixed files. See [Testing local code](#testing-local-code). |

## Testing local code

caw-ai knows two modes:

- **E2E** (default, CI, nightly, every plain `run`): always the deployed code of the environment, also with `--until`.
- **Development:** your local code, only with `--overlay`. Nothing switches to it silently.

Every run names the code in its first lines, in CI too:

```
Code: deployed
Code: dev server localhost:5173, your current version
Code: overlay, build dist, built 14:02, 3 min ago
Code: overlay, dev server http://localhost:5173
Code: overlay, Sencha watch http://localhost:1841/
```

### Your dev server as an environment

Testing against your local dev server needs no option. The dev server is an environment like any other:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
}
```

`--target local` then tests what is in your editor (Vite, `ng serve`, webpack dev server, Next.js, Nuxt). `--overlay` is rejected there (exit 3): it is for deployed environments.

### `--overlay`: local code over a deployed environment

For apps that only work inside a deployed environment, e.g. in a portal or a shell, or with a backend that only exists on staging. Page, API, cookies and login stay those of the environment; only the app's code comes from your machine.

It needs `"overlay": true` on the environment and a source on the app. One model for every framework: your project's **local code server** at `url`, started with your project's own command `start`:

```json
"environments": {
  "dev": { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true }
},
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "overlay": {
      "url": "http://localhost:5173",
      "start": "npm run dev",
      "statics": [{ "name": "Fx/Static.js", "path": "static.js" }]
    }
  }
}
```

| Field in `overlay` | |
|---|---|
| `url` | Address of the local code server: dev server (Vite, `ng serve`, webpack) or Sencha watch, e.g. `"http://localhost:5173"`. ExtJS default: `"http://localhost:1841/"`. |
| `start` | Your project's command that starts the server or builds, run in the app folder, e.g. `"npm run dev"`, `"pnpm run watch"`, `"npm run build"`. caw names it when the server is down; it runs it only with `--start`. |
| `build` | Build folder relative to the project, e.g. `"dist"` or `"dist/app/browser"`, for apps without a server: caw serves it itself. Not with ExtJS. |
| `statics` | Fixed names served live from disk: `name` is the name in the request, `path` the file relative to the app folder. For every framework and every source. |
| `assetUrlPattern` | Extra patterns for this app only, in addition to the top-level `assetUrlPattern`: for an app whose files come from somewhere else. String or list. |

Unknown fields are an error. You need only one of `build` and `url`. Earlier names still work with a note from `validate`: `dev` is `url`, `devCommand` and `buildCommand` are `start`. Setting both an old and a new name is an error.

| Call | Source |
|---|---|
| `--overlay` | The one configured source. If the app has both `build` and `url`, the call stops (exit 3) and asks you to choose. |
| `--overlay build` | The build folder. Not with ExtJS. |
| `--overlay dev` | The server at `url`. |
| `--overlay http://localhost:5174` | The server at this address. Overrides `url`, needs no `overlay` on the app. Only for a test with one app (exit 3 with `also`). |

`--overlay` works on `run`, `record`, `fix` and `open`. It is rejected (exit 3) with the reason on an environment without `"overlay": true`, on an environment that is itself a dev server on your machine, and for an app without a source. Apps from `also` use their own source; without one they stay deployed.

**caw starts nothing by itself.** Before Chrome opens it checks the source:

- **Server** at `url` doesn't answer: exit 2 (`overlay-not-ready`) with the address and `start`: `The local code server http://localhost:5173 doesn't answer. Start npm run dev in ., or run with --start …`. Start it yourself, or let Claude start it in its session (it asks first).
- **Build** missing or older than the newest source file of the app: exit 2 with `start`. Not counted as source: `node_modules`, the build folder, folders starting with a dot, common build folders (`dist`, `build`, `out`, `coverage`, …), `caw/`, Markdown files and `caw.config.json`; at most 5000 files are looked at.
- `npx caw-ai overlay status` shows the same without a browser: `ready`, `moved`, `down`, `wrong-app` or `stale`.

**`--start`** (on `run`, `record`, `fix`, `open` and `overlay check`, only together with `--overlay`) is for CI and scripts, like Playwright's `webServer`: caw runs `start` in the app folder when the server doesn't answer, waits up to 60 s (Sencha watch: 180 s, until it serves this app), logs to `.caw/<app>-dev-server.log` or `.caw/<app>-watch.log` and stops the whole process tree at the end of the run; for `open` and `--until` when you close the window. With `build` it runs `start` once (`.caw/<app>-build.log`) and checks again. The source never switches: a failed build doesn't fall back to the dev server or the deployed version.

**How the local code gets into the page:**

- **Pages:** Every HTML page of the app comes from the server. caw swaps the app's code tags in it for those of the local page: with `build` the page in the build folder with the most matches, with `url` the dev server's HTML for the same path. The new tags sit where the old ones were and carry the page's CSP nonce; `integrity` is removed. Inline scripts, project copies (e.g. `public/env.js`: the environment sets it, so it stays from the server) and scripts from other origins stay. There is no swap on pages without tags of the app (the login page), on server-rendered pages, and when the build uses a different base path (a warning says so); then only single requests come from local code.
- **Requests with `build`:** the exact file, or the file with the same name up to the hash. A hash is `name[-.]hash.ext` with 6 to 64 characters from `[A-Za-z0-9_-]`, containing a digit or an uppercase letter. Its length may change (`assets/index-Bx81.js` → `assets/index-Q7f2kL9a.js`), and a fixed name and a hashed one count as the same file (`main.js` ↔ `main-A1B2C3D4.js`).
- **Requests with `url`:** code requests (scripts, styles, fonts, images, modules) go to the dev server. Its HMR WebSocket is bridged, so hot reload works in the deployed page.
- **`statics`** are answered first, for every source.
- Everything local is served with `cache-control: no-store`; service workers are blocked in the test browser. The name of a request is its path below the environment URL, or group 1 of `assetUrlPattern`.

**Checks after the first load:**

| Finding | Result |
|---|---|
| Server-rendered page (Next.js, Nuxt, SvelteKit, Angular SSR) | Exit 2 (`overlay-ssr`). Test local code there with the dev server as the environment (`--target local`). |
| Expected parts came from the server (ExtJS: app or own package) | Exit 2 (`overlay-incomplete`): a mixed version. The message names the parts, up to five URLs and the `assetUrlPattern` that catches them. `caw-ai overlay check --apply` adds it. |
| Nothing came from local code | Exit 2 (`overlay-unused`). |
| Expected parts never requested | Note "Not loaded": maybe the app loads them later. |
| Scripts from the local asset folder came from the server | Warning "Mixed version": rebuild, or check that the build matches the deployed version. |
| Build with a different base path | Warning, no page swap. |

`report.md` names what happened: `Overlay: dist; 14 file(s) local, 2 script(s)/stylesheet(s) from the server; page swapped: yes`.

**ExtJS:** With `"framework": "extjs"` the local code comes from the web server of the Sencha watch, by default `http://localhost:1841/`. `init` writes `"overlay": { "url": "http://localhost:1841/" }`; add `start` with your project's watch command (e.g. `"pnpm run watch"` or `"sencha app watch"`), optionally `statics`. caw checks that the server at `url` serves *this* app (`app.json` name, `bootstrap.json` with a load order). If the port was taken, the watch picks a random one: caw finds it among the running watch processes, uses it and tells you to set `url`. `build` and `buildCommand` are errors there. Details: [Guide](guide.md#how-local-code-gets-into-the-application).

**Several asset sources.** A page may load its code from more than one place. caw names each request by the path below the environment URL and by every `assetUrlPattern`; the first name a source knows wins. `assetUrlPattern` is a string or a list, one pattern per source, group 1 the file name. An FA214-like portal loads the theme by a plain path (covered by the default) and app and packages through a proxy servlet:

```json
"assetUrlPattern": [
  "[?&]url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)",
  "^https://cdn\\.example\\.com/js/(?:[^?#]*/)?([^/?#]+\\.js)"
]
```

You don't have to write these by hand: `npx caw-ai overlay check` loads the app once, lists per part whether it came local or deployed, and suggests one pattern per missing source; `--apply` adds them. ExtJS overlay setup is done when `overlay check` reports complete. caw never starts the Sencha watch by itself, only with `--start`.

**`validate`** prints the code per test and target and where `--overlay` would apply:

```
smoke (local): dev server localhost:5173, your current version
smoke (dev): deployed; with --overlay: overlay, build dist
smoke (dev): deployed; with --overlay build or dev: overlay, build dist | overlay, dev server http://localhost:5173
```

It also notes an app with `overlay` while no environment has `"overlay": true`.

## Everything else

| Field | Default | |
|---|---|---|
| `language` | detected | `en` or `de` for UI, CLI and reports. `CAW_LANG` overrides it. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` or `extjs`. Decides how targets are stored and when a page counts as ready. |
| `agent.sandbox` | `local` | Where Claude runs: `local` (Claude Code on your machine, read-only tools) or `docker`. Always `docker` in CI. |
| `extraAllowedHosts` | `[]` | More hosts Chrome may reach, e.g. login or CDN. Everything else is blocked. |
| `insecureTls` | `false` | Accept self-signed certificates. |
| `browser` | system Chrome | `{ "channel": "msedge" }` or `{ "executablePath": "/path/to/chromium" }` |
| `browser.locale`, `browser.timezone` | as recorded | Language and time zone of the test browser, e.g. `"de-DE"` and `"Europe/Berlin"`. Without them a replay uses the values stored with the recording, and a recording (or an older recording) uses the host's. Dates, numbers and translations then look the same on every machine and CI runner. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS selectors for error messages without ARIA roles. |
| `consoleIgnore` | `[]` | Regexes for known, harmless console errors. Keep them narrow. |
| `foreignCode` | `[]` | Regexes for third-party scripts, e.g. `"/vendor/"`. Their errors become warnings. |
| `requestKeys` | `[]` | Query parameters that name a request, e.g. `["action"]` for single-endpoint APIs. |
| `effects.fail` | `["controls", "console"]` | Which learned effects fail a step when they change. `[]` makes all of them warnings. |
| `maxSteps` | `100` | Claude's action budget when recording and fixing. |
| `readyTimeoutMs` | | How long to wait for the app to settle. |
| `readyIgnore` | `[]` | CSS selectors of areas that change by themselves, e.g. `["#ticker", ".clock", "footer [role=progressbar]"]`. Their DOM changes and progress indicators don't count when waiting for a quiet page. Spinners without size, hidden or outside the viewport never count. If a page never gets quiet, the report says so once per step. |
| `lintCommand` | | Your check command, e.g. `npm run lint`. Claude mentions it in code suggestions. |
| `assetUrlPattern` | | Regex, or a list of them (one per asset source), for requests that load app code; group 1 is the name for `overlay.statics`, the path inside `overlay.build`, or the build name of an ExtJS app or package. Used with `--overlay` in addition to the path below the environment URL. `caw-ai overlay check` suggests missing ones. |
| `sites` | | Same app for several tenants: `["north", "south"]`, then `urls` per environment. |
| `extends` | | Shared defaults from a file, e.g. `"./caw/base.json"`. |
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
