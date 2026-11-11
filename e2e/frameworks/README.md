# Framework matrix

Test projects that check whether caw-ai works with the major frameworks: locally on the dev server, deployed as a production build, and with local code laid over the deployed version (`--overlay`). Claude is never started. `project.mjs` writes the recordings by hand, as `record` would write them; `caw-ai run` replays them.

| Project | Framework | caw-ai adapter |
|---|---|---|
| `react-vite` | React 19, Vite 8, React Router 7 | `react` |
| `react-webpack` | the same sources as `react-vite`, built with webpack 5 (classic scripts, chunks via JSONP, `[contenthash]` after a dot); called `webpack` in the matrix | `react` |
| `vue-vite` | Vue 3.5, Vite 8, Vue Router 4 | `vue` |
| `angular` | Angular 21, zoneless (default) and the `zone` configuration with Zone.js and Testability; called `angular` and `angular-zone` in the matrix | `angular` |
| `next` | Next.js 16, App Router (SSR, `hydrateRoot(document)`) | `react` |
| `nuxt` | Nuxt 4.4 (SSR) | `vue` |

All show the same UI: login, a ticket list with a loading indicator, a "New ticket" dialog, a lazily loaded "Info" route and a button that throws an error in `explode.ts`. `shared/api.mjs` is the shared backend, `shared/serve.mjs` serves builds over HTTPS on `<name>.localhost`.

## Scenarios

Each scenario is named `<variant>/<scenario>`, e.g. `react/dev` or `angular-zone/overlay-build`.

| Scenario | Environment | Expected |
|---|---|---|
| `dev` | dev server with HMR on `http://localhost:<port>` | `smoke` passes, `error` fails in the app |
| `deployed` | production build behind HTTPS (`https://<name>.localhost:844x`, `insecureTls`) | as `dev` |
| `no-option` | deployed build "deployed" plus a running build watch "local", run without `--overlay` | `smoke` passes against the deployed version |
| `overlay-build` | as `no-option`, with `--overlay build`; for React and webpack the local build has a different chunk split (`CAW_SPLIT=1`). The Angular production build has `subresourceIntegrity`: the local code only arrives because caw-ai takes the `integrity` attributes from the deployed HTML. | `smoke` passes with the page swapped, `error` fails in the app |
| `build-missing` | `--overlay build` without a local build and without `buildCommand` | exit 2 |
| `overlay-build-command` | `--overlay build` without a local build, with `buildCommand`: caw builds once itself | `smoke` passes |
| `build-stale` | `--overlay build` after a source changed since the build, without `buildCommand` | exit 2 |
| `overlay-dev` | `--overlay dev` with `devCommand`: caw starts the dev server and stops it at the end | `smoke` passes |
| `dev-server-down` | `--overlay dev` without `devCommand` and without a running dev server | exit 2 |
| `overlay-ssr` | only next and nuxt: `--overlay dev` over the SSR production server | exit 2 with the hint to use the dev server as the environment |

The overlay scenarios run for react, webpack, vue, angular and angular-zone. Two tests exist: `smoke` must pass; `error` must fail as an application error, and the `source` column shows whether it points to `explode.ts`. `smoke` creates a ticket and checks the build id (S1), opens Info and checks the id there again, since Info is a lazy chunk (S2). For react and webpack S3 also fills a field in an iframe (`frame` in the target) and one in a web component with an open shadow root.

## Running

```bash
cd e2e/frameworks
for d in react-vite react-webpack vue-vite angular next nuxt; do (cd $d && npm install); done
node matrix.mjs            # everything, about 10 minutes
node matrix.mjs nuxt       # only scenarios whose name contains "nuxt"
```

Needs Node 22.12+, Chrome and `openssl` (on Windows from Git for Windows): the self-signed certificate for `*.localhost` is created on the first run in `shared/.cert/` and never checked in. Results, server logs and, per run, output and `report.md` go to `result/`, the summary to `result/matrix.json`.
