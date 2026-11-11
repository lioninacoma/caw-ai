English · [Deutsch](upgrading.de.md)

# Upgrading from 0.1.0

The next release changes config keys, exit codes and file names. caw-ai has no compatibility layer: old keys are rejected, and `validate` and `doctor` say where each one went. Work through the list, then run `npx caw-ai validate`.

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
      "buildCommand": "npm run build"
    }
  }
}
```

Or with a dev server:

```json
"overlay": {
  "dev": "http://localhost:5173",
  "devCommand": "npm run dev -- --port 5173 --strictPort"
}
```

Files with a fixed name that are not part of the build stay as `overlay.statics`: `"overlay": { "statics": [{ "name": "Fx/Static.js", "path": "static.js" }] }`.

**ExtJS:** `redirects` and `constants` have no replacement. With `"framework": "extjs"` the Sencha watch is the source; caw-ai reads the build names of app and packages from `app.json`, `.sencha/app/*.properties` and `bootstrap.json`. Delete both keys. Keep `statics` under `overlay` if you had any, and set `"devCommand": "sencha app watch"` if caw-ai should start the watch.

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

The light theme and the `fed` setting are gone. A `"theme": "light"` or `"dark"` in `prefs.json` falls back to `nacht`. Pick a theme with `npx caw-ai theme use <name>` (`nacht`, `bernstein`, `phosphor`).

## 8. Check

```bash
npx caw-ai validate   # config and tests, offline
npx caw-ai list       # recording status per test
npx caw-ai doctor     # machine, credentials, environments
```

`validate` names every old key and where it went, e.g. "environments.dev.agent was renamed to claude in 0.2.0", and every key it doesn't know.
