English · [Deutsch](overlay.de.md)

# Extension: overlay (local code on a deployed environment)

For apps that only work inside a deployed environment, e.g. in a portal or a shell, or with a backend that only exists on
staging. Page, API, cookies and sign-in stay those of the environment; only the app's code comes from your machine. A dev server
on your machine needs no overlay: it is simply an environment (`"local": { "url": "http://localhost:5173" }`).

The extension is active only when `caw.config.json` has an `overlay` block. Without it, `caw overlay` and `--overlay` do not
exist (they name this page), and help, `validate`, `doctor` and the MCP tools say nothing about it. `init` never writes the block.

## Config

```json
"overlay": {
  "environments": ["dev"],
  "parts": {
    "orders": { "dir": "apps/orders", "url": "http://localhost:5173/", "start": "npm run dev" },
    "admin":  { "dir": "apps/admin", "build": "dist", "start": "npm run build" }
  },
  "assetUrlPattern": "/static/([^/?#]+\\.js)"
}
```

| Key | Rule |
|---|---|
| `environments` | Where `--overlay` is allowed. They must exist, must not be production and must not be a dev server on this machine |
| `parts.<part>` | One per separately built app. Names like environments; not `build` or `dev` |
| `dir` | The part's folder, relative, without `..` |
| `url` | The local code server (dev server, Sencha watch). ExtJS default `http://localhost:1841/` |
| `build` | A build folder instead of a server (not with ExtJS) |
| `start` | Starts or builds the source; needs `url` or `build` (or ExtJS) |
| `statics` | `[{ name, path }]`: fixed files served from your workspace (a `path` relative to `dir`, may lead into a neighbouring package with `..`, never outside the workspace or to a secret file) |
| `assetUrlPattern` | RegExp with group 1 = the file name, top level or per part; `overlay check --apply` suggests them |

## On the command line

`--overlay` on `run`, `record` and `open`. Without a value every part with its source; otherwise a comma list:
`orders`, `orders:dev`, `admin:build`, `build`, `dev`, or one URL when there is only one part (`--overlay http://localhost:5174`).
Parts not listed stay deployed. Every run names the code in its first lines (`Code: overlay, dev server …`).

`--start` starts what the command needs and is not running, and stops it afterwards: the environment's `start` first, then each
selected part's `start`.

### caw overlay status

```bash
npx caw overlay status --env dev --part orders --json
```

Is the part's local code server ready? No browser, starts nothing.

| State | Meaning | Exit |
|---|---|---|
| `ready` | The server answers (ExtJS: serves this app); a build folder or fixed files are `ready` too | 0 |
| `moved` | The ExtJS watch runs at `foundUrl` instead of `url` (port taken); runs use it; set `url` | 0 |
| `down` | Nothing answers at `url`; the output names `start` and the part folder | 2 |
| `wrong-app` | Another app (or no Sencha watch) answers at `url` | 2 |
| `stale` | The watch lists files in `bootstrap.json` it doesn't serve | 2 |
| `static-missing` | A `statics` file is missing | 2 |
| `not-overlay`, `no-part`, `no-app` | The environment is not in `overlay.environments`, the part is unknown, or has no `app.json` (ExtJS) | 3 |
| `static-invalid` | A `statics` path leads outside the workspace or to a secret file | 3 |

`--json` prints `{ state, framework, part, partDir, url, foundUrl?, start, statics?, message? }` as the only line on stdout.

### caw overlay check

```bash
npx caw overlay check --env dev --apply
```

Opens the app headless with `--overlay` (signed in, no steps, no Claude) and compares the page's script requests with what the
overlay should replace. Per part `local`, `deployed` (a mixed version) or `not loaded`. For a source that came from the server it
suggests an `assetUrlPattern`; `--apply` writes the missing ones into the config (validated) and checks again. It runs `overlay
status` first and starts nothing unless `--start`. The result also goes to `.caw/overlay-check.json`. Exit 0 complete, 2
incomplete or server problem, 3 no overlay environment or part. `--env` defaults to the only overlay environment, `--part` and
`--role` to the only part and the first role.

## From Claude Code

With the block, the MCP server lists `caw_overlay` (`status`, `check`, `apply`) and the guide topic `overlay`, and `caw_start`
takes `overlay`. caw never starts your local code server from the session: Claude asks you and starts it in its own session, unless
your project's rules say otherwise.

## Error codes

| Code | Exit | Fix |
|---|---|---|
| `overlay-not-ready` | 2 | The local code server at `overlay.parts.<part>.url` doesn't answer, serves another app, or the build is missing: run the `start` command the message names in the app folder, or add `--start` |
| `overlay-ssr` | 2 | Server-rendered page: test local code with the dev server as the environment (`--env local`) |
| `overlay-incomplete` | 2 | Parts came from the server instead of local code (mixed version): add the suggested `assetUrlPattern`, or run `overlay check --apply` |
| `overlay-unused` | 2 | Nothing came from local code: do build or dev server match the app, does `assetUrlPattern` cover its requests? |
| `overlay-ambiguous` | 2 | ExtJS: give one app its own `output.js.path` in `app.json` |
| `overlay-stale` | 2 | ExtJS: the watch's `bootstrap.json` names files it doesn't serve. Wait until the watch has finished building, or restart it |
