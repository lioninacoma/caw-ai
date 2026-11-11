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
npm run pack:check    # what `npm pack` would ship
```

Without Chrome the browser tests are skipped locally. CI sets `CAW_REQUIRE_CHROME=1`: with it, a browser test must fail instead of skipping when Chrome is missing.

To try your changes in a real project, link the checkout there:

```bash
npm i -D ../caw-ai    # or pnpm add -D link:../caw-ai
npx caw-ai doctor
```

`examples/errand` is a small todo app with a recorded test you can replay right away (`run first-errand --target local`).

## Layout

| Folder | What lives there |
|---|---|
| `bin/` | CLI entry |
| `src/host/` | Everything on your machine: browser session, replay, workbench and chat UI, reports |
| `src/sandbox/` | The commands Claude may use while recording |
| `src/shared/` | Config, i18n (`locales/de`, `locales/en`), reports, helpers |
| `templates/` | Files `init` writes into a project (config, skill, Docker sandbox) |
| `test/` | Unit tests (`node --test`) |
| `e2e/` | End-to-end run against a fake app in a real Chrome |
| `assets/fonts/` | Fonts of the built-in themes (OFL) |
| `themes/` | Built-in theme packages and the schema, see `themes/README.md` |

## Pull requests

- Keep a PR to one topic. Open an issue first for larger changes.
- Add or update unit tests. `npm run lint`, `npm test` and `npm run pack:check` must pass. CI lints once and runs the tests on Linux and Windows with Node 22.4, 22 and 24; a macOS job runs too but does not block.
- Code, names and comments are in English. UI texts live in `src/shared/locales/` (de and en).
- User-facing text goes into both `src/shared/locales/en` and `src/shared/locales/de`. Keep it short.
- Add a line under `[Unreleased]` in `CHANGELOG.md`.
- caw-ai stays framework-independent. Framework specifics belong in `src/host/framework/`.
- Nothing in the package may depend on one particular project or company.

## End-to-end tests

`npm run e2e` starts Chrome and a fake app over HTTPS and takes a while. It runs nightly in CI (Linux with xvfb). Run it locally when you touch replay, the workbench or the browser session.

## Releases

Maintainers only.

1. Move the `[Unreleased]` entries in `CHANGELOG.md` to a new version section and update the compare links at the bottom.
2. Set `version` in `package.json` (`npm version 0.3.0 --no-git-tag-version`) and commit.
3. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.

The tag starts `.github/workflows/release.yml`: it checks that the tag matches `package.json`, runs `npm ci`, lint, tests and `pack:check`, then `npm publish --provenance --access public`. A version with a pre-release part (`v0.3.0-beta.1`) is published under the `next` dist-tag.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), no token: on npmjs.com, package `caw-ai` → Settings → Trusted publisher → GitHub Actions, repository `lioninacoma/caw-ai`, workflow `release.yml`. The workflow installs npm 11.5.1 or later, which trusted publishing requires. Once it works, set the package to require 2FA and disallow tokens.

## Security

Please don't open a public issue for security problems (for example a way around the host allowlist or a credential leak). Use GitHub's private vulnerability reporting on this repository instead.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
