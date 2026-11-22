# Contributing to caw-ai

Thanks for helping. Bug reports, ideas and pull requests are welcome, in English or German.

## Setup

You need Node 22.4+ and Google Chrome. Claude Code is only needed to record or fix tests, Docker only for `--agent docker`.

```bash
git clone https://github.com/lioninacoma/caw-ai.git
cd caw-ai
npm ci
npm run lint          # ESLint (recommended rules of ESLint and eslint-plugin-n)
npm test              # unit tests, no tokens; the *-browser, login and explore tests start a headless Chrome
npm run pack:check    # what `npm pack` would ship: no secrets, no tests, no project terms
```

Without Chrome the browser tests are skipped locally. CI sets `CAW_REQUIRE_CHROME=1`: with it, a browser test must fail instead of skipping when Chrome is missing.

To try your changes in a real project, link the checkout there:

```bash
npm i -D ../caw-ai    # or pnpm add -D link:../caw-ai
npx caw doctor
```

`examples/errand` is a small todo app with a recorded test you can replay right away (`run first-errand --env local`).

## Layout

| Folder | What lives there |
|---|---|
| `bin/` | CLI entry |
| `src/host/` | Everything on your machine: browser session, replay, workbench and chat UI, reports |
| `src/sandbox/` | The commands the agent may use while recording |
| `src/shared/` | Config, i18n (`locales/de`, `locales/en`), reports, helpers |
| `templates/` | Config template, Docker sandbox and the guide topics `caw_guide` serves (`templates/guide/`) |
| `test/` | Unit tests (`node --test`) |
| `e2e/` | End-to-end run against a fake app in a real Chrome |
| `assets/fonts/` | Fonts of the workbench, Geist and Geist Mono (OFL) |

## Pull requests

- Keep a PR to one topic. Open an issue first for larger changes.
- Add or update unit tests. `npm run lint`, `npm test` and `npm run pack:check` must pass. CI lints once and runs the tests on Linux and Windows with Node 22.4, 22 and 24; the end-to-end run runs nightly or by hand, not on a PR.
- Code, names and comments are in English. UI texts live in `src/shared/locales/` (de and en).
- User-facing text goes into both `src/shared/locales/en` and `src/shared/locales/de`. Keep it short.
- Workbench, chat, report page and the explore card share one look from `src/host/style.mjs`: its tokens for light and dark, fonts, icons and base components. Use them instead of own colours, and check a UI change in both modes.
- Add a line under `[Unreleased]` in `CHANGELOG.md`.
- caw stays framework-independent. Framework specifics belong in `src/host/framework/`.
- Nothing in the package may depend on one particular project or company.

## End-to-end tests

`npm run e2e` starts Chrome and a fake portal under `e2e/` over HTTPS, with scripts in place of the agent and the human, and takes a while. It runs nightly in CI (Linux with xvfb). Run it locally when you touch replay, the workbench or the browser session.

On Windows the E2E runs best from PowerShell via `e2e/watchdog.ps1`: the watchdog ends the run when the log stays silent too long. What counts are the results in `<log>.result` with the summary `RESULT OK=… FAIL=…`, also in `<log>.status`: the agent's processes write into the log too and can overwrite lines. If there is a FAIL, the E2E ends with exit 1. On its first run the E2E builds the sandbox image from `node:22-bookworm-slim` and needs Docker for it, but no token.

## Tested frameworks and platforms

caw has been tried with ExtJS 6.5.3 Modern, React 19 (Vite dev server), Vue 3.5 and Angular 19. `e2e/frameworks` tests React 19 (Vite 8), Vue 3.5 (Vite 8), Angular 21 (zoneless and with Zone.js), Next.js 16 and Nuxt 4, each on the dev server, as a production build over HTTPS and, where possible, with `--overlay` (`node e2e/frameworks/matrix.mjs`). Windows and Linux are officially supported as hosts; macOS is untested. For the `docker` agent, Docker in WSL has been tried; Docker Desktop is untested: firewall in the container, write permissions in the agent folder and the channel over its file sharing.

## Releases

Maintainers only.

1. Move the `[Unreleased]` entries in `CHANGELOG.md` to a new version section and update the compare links at the bottom.
2. Set `version` in `package.json` (`npm version 0.3.0 --no-git-tag-version`) and commit.
3. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.

The tag starts `.github/workflows/release.yml`: a first job checks that the tag matches `package.json` and runs `npm ci --ignore-scripts`, lint, tests and `pack:check`; only then a second job, the only one with the OIDC token (`id-token: write`) and without a dependency cache, installs with `npm ci --ignore-scripts` and runs `npm stage publish --provenance --access public`. A version with a pre-release part (`v0.3.0-beta.1`) is staged under the `next` dist-tag. A staged version goes live only once a maintainer approves it with 2FA: on npmjs.com under **Staged Packages**, or with `npm stage list` and `npm stage approve <stage-id>`.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), no token: on npmjs.com, package `caw-ai` → Settings → Trusted publisher → GitHub Actions, repository `lioninacoma/caw-ai`, workflow `release.yml`, no environment, direct publishing left unchecked (staging only). The workflow installs exactly npm 11.15.0 (`npm stage` needs 11.15.0 or later); raise it there on purpose. Once it works, set the package to require 2FA and disallow tokens.

## Security

Please don't open a public issue for security problems (for example a way around the host allowlist or a credential leak). Use GitHub's private vulnerability reporting on this repository instead.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
