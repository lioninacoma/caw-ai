English · [Deutsch](upgrading.de.md)

# Upgrading from 0.1.0

0.3.0 changes config keys, exit codes and file names. caw-ai has no compatibility layer: old keys are rejected, and `validate` and `doctor` say where each one went. Work through the list, then run `npx caw-ai validate`.

## 1. Node

Node 22.4 or later.

## 2. `caw.config.json`

### Environments: `agent` → `claude`, `localCode` → `overlay`

Before:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "agent": true, "writable": true },
  "dev":   { "url": "https://dev.example.com", "agent": true, "localCode": true, "writable": true }
}
```

After:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":   { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true }
}
```

`localCode: true` switched to local code by itself. `overlay: true` only allows it: add `--overlay` to `run`, `record`, `fix` or `open` when you want your local code. Without it every run, also `run --until`, tests the deployed version. A dev server on your machine (`local` above) needs neither; it is an environment of its own.

`agent.sandbox` at the top level of the config stays as it is.

### Apps: `statics`, `redirects`, `constants` → `overlay`

Before:

```json
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "statics": [{ "name": "main.js", "path": "dist/main.js" }]
  }
}
```

After, with a build folder:

```json
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "overlay": {
      "build": "dist",
      "start": "npm run build"
    }
  }
}
```

Or with a dev server:

```json
"overlay": {
  "url": "http://localhost:5173",
  "start": "npm run dev"
}
```

Files with a fixed name that are not part of the build stay as `overlay.statics`: `"overlay": { "statics": [{ "name": "Fx/Static.js", "path": "static.js" }] }`.

**ExtJS:** `redirects` and `constants` have no replacement. With `"framework": "extjs"` the web server of the Sencha watch is the source (`overlay.url`, default `http://localhost:1841/`); caw-ai reads the build names of app and packages from `app.json`, `.sencha/app/*.properties` and the watch's `bootstrap.json`. Delete both keys. Keep `statics` under `overlay` if you had any, and set `"start"` to your watch command (e.g. `"sencha app watch"`). A `statics` `path` is relative to the app folder: if the app has its own folder and the file sits in a neighbouring package, lead there with `..` (e.g. `../../packages/Model/resources/Const.js`); it has to stay inside the workspace (see [Configuration](configuration.md)).

### Overlay: one model, `url` and `start`

If you used a pre-release of 0.3.0 with `overlay.dev`, `devCommand` or `buildCommand`:

| Before | Now |
|---|---|
| `overlay.dev` | `overlay.url` |
| `overlay.devCommand`, `overlay.buildCommand` | `overlay.start` |
| caw started `devCommand` or built with `buildCommand` when needed | caw starts nothing; the run ends with exit 2 (`overlay-not-ready`) and names `start`. Add `--start` for the old behaviour (CI). |
| ExtJS: sources read from the app folder on disk; "running" meant any `sencha app watch` process | ExtJS: sources come over HTTP from the watch at `overlay.url` (default `http://localhost:1841/`), checked to be the watch of *this* app; a watch on a random port is found and used |
| error codes `watch-missing`, `watch-stale` | `overlay-not-ready`, `overlay-stale` |
| MCP tool `caw_overlay_check` | `caw_overlay` with `action: status`, `check` or `apply` |

The old names still work, `validate` notes each one (`overlay.dev is now overlay.url`); an old and a new name side by side is an error. CI scripts that relied on caw starting the dev server or the watch add `--start`. `npx caw-ai overlay status` shows whether the server is ready.

**`assetUrlPattern`:** group 1 now names an `overlay.statics` entry, a path inside `overlay.build` or the build name of an ExtJS app or package.

Details: [Testing local code](configuration.md#testing-local-code).

## 3. Test files

`caw/tests/<test>.yaml` holds only the description. A `recording` block in a step or a `knownMessages` list there is now an error (`test-invalid`); 0.1.0 still read such single files and split them on the next write.

- Still on 0.1.0: run `fix` or `record` for those tests once before upgrading; the write moves the recording to `caw/recordings/<test>.yaml`.
- Already upgraded: move each step's `recording` and the `knownMessages` list into `caw/recordings/<test>.yaml` by hand, or delete them and run `record` again.

## 4. Exit codes in CI scripts

| Situation | 0.1.0 | now |
|---|---|---|
| Recording missing or stale (`replay-missing`, `replay-stale`) | `3` | `4` |
| Unexpected internal error | `1` | `2` |
| Session file missing (`auth-missing`), `TODO` sign-in selectors on `run` | `2` | `3` |
| `record`, `fix`, `open`, `run --until`, `run --handover` with `CI` set | waited for a person | `3` |

`1` now always means the app failed the test. A script that treated `3` as "needs recording" checks `4`. With several tests (`run a b c`, `run --all`) the worst exit code wins: `2` > `1` > `4` > `3` > `0`. See [Exit codes](commands.md#exit-codes).

## 5. Files in `.caw/`

Scripts that read run folders need the new names:

| 0.1.0 | now |
|---|---|
| `agent/claude-gespraech.log` | `agent/claude-talk.log` |
| `agent/claude-empfehlung.log` | `agent/claude-advice.log` |
| `test-entwurf.yaml` | `test-draft.yaml` |
| `report-testlauf.md` | `report-test-run.md` |
| `vorfuehrung.json` | `demonstration.json` |
| `punkt-N.png` | `point-N.png` |
| `fehler.json` | `failures.json` |
| `netzwerk.json` | `network.json` |
| `fehler-schritt-N.png` | `failure-step-N.png` |
| `agent/anleitung.md` | `agent/instructions.md` |
| `.caw/auswahl.json` | `.caw/selection.json` |
| run folder `…-vorfuehrung` | `…-demonstration` |

`result.json`, `report.md` and `trace.zip` keep their names. Old run folders are not renamed; delete `.caw/runs/` if you don't need them.

## 6. Claude Code skill

The skill changed with the commands. Update the installed copy and the `.mcp.json` entry:

```bash
npx caw-ai skill
```

With the `docker` agent the image is rebuilt on the next run; it now installs Claude Code pinned to major version 2.

## 7. Personal settings

The light theme and the `fed` setting are gone. A `"theme": "light"` or `"dark"` in `prefs.json` falls back to `nacht`. Pick a theme with `npx caw-ai theme use <name>` (`nacht`, `bernstein`, `phosphor`, `kachel`, `cockpit`).

## 8. Check

```bash
npx caw-ai validate   # config and tests, offline
npx caw-ai list       # recording status per test
npx caw-ai doctor     # machine, credentials, environments
```

`validate` names every old key and where it went, e.g. "environments.dev.agent was renamed to claude in 0.3.0", and every key it doesn't know.
