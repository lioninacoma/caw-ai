# caw: local code on a deployed environment (overlay)

Use the overlay (`--overlay`, `caw_start` with `overlay`) only when the person asks to test or develop their local code on a
deployed environment; otherwise runs use the deployed code. A dev server on the own machine is simply an environment (`local`)
and needs no overlay. caw starts no process for the overlay: the project's local code server must run. The config's `overlay`
block lists the environments where it is allowed (`overlay.environments`) and the parts with their sources
(`overlay.parts.<part>`: `dir`, `url` or `build`, `start`, `statics`). `overlay: true` brings every part with a source;
`"orders,admin:dev"` only those parts (on the command line `--overlay=orders,admin:dev`).

## Set it up

Only if the app does not run locally as delivered (portal, shell, backend only on staging): that environment in
`overlay.environments` and one part per separately built app in `overlay.parts`, derived from the project:

- `dir`: the app's folder.
- `url`: the local code server. Vite: `server.port` in `vite.config.*` (default 5173); Angular: `serve.options.port` in
  `angular.json` (default 4200); Sencha: the watch server `http://localhost:1841/` (also the default when `url` is missing).
- `start`: the app's own start command from its `package.json` scripts (e.g. `pnpm run watch`, `npm run dev`) or its README, as
  it is run in the app folder.
- Only a build folder without a server: `build` (and `start` = the build script).

List the parts' `url` and `start` you set under "how I set it up".

## Before a run

1. **Check:** `caw_overlay` with `action: "status"`, with `env` as for the run and `part` when there are several parts.
   - `ready`: start the run.
   - `moved`: the part's server runs at `foundUrl`. Set `overlay.parts.<part>.url` to it with `caw_config` and tell the person.
   - `down`: ask the person "Start `<start>` in `<partDir>`?". On yes run it in your own session in the background (never
     through caw), then poll `status` until `ready` (a Sencha watch needs a few minutes for its first build). Without `start`
     ask for the command.
   - `wrong-app` (another app answers at `url`) or `stale` (the watch serves files that no longer exist): tell the person what
     `message` says; do not start a second server on the same port.
   - `not-overlay`, `no-part` or `no-app` (no app.json in the part's `dir`): fix the config or tell the person.
   - `static-missing` or `static-invalid`: a `statics` entry of the part points to a missing file, leads outside the workspace
     or to a secret file. A `path` is relative to the part's `dir` and may lead into a neighbouring package with `..`.
2. **Parts:** if the run or `caw_overlay` `check` reports parts that still come from the server (`incomplete`), run
   `caw_overlay` with `action: "apply"` and check again. Several sources give several patterns; only if a source stays
   unresolved, show the person its URLs.
3. **Project rules win:** if the project forbids starting such processes (e.g. a `CLAUDE.md` saying the person starts the
   watch), only name the command and wait.

`caw_start` with `overlay` runs this check itself: if the server is not ready it returns `state`, `url`, `start` and `partDir`
instead of starting.
