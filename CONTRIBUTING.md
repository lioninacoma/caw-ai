# Contributing to caw-ai

Thanks for helping. Bug reports, ideas and pull requests are welcome, in English or German.

## Setup

You need Node 22+ and Google Chrome. Claude Code is only needed to record or fix tests, Docker only for `--agent docker`.

```bash
git clone https://github.com/lioninacoma/caw-ai.git
cd caw-ai
npm ci
npm test              # unit tests, no browser, no tokens
npm run pack:check    # what `npm pack` would ship
```

To try your changes in a real project, link the checkout there:

```bash
npm i -D ../caw-ai    # or pnpm add -D link:../caw-ai
npx caw-ai doctor
```

`examples/helpdesk` is a small app with a recorded test you can replay right away (`run create-ticket --target local`).

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
| `assets/mascot/` | Crow sprite sheet from Blender via Pixor (work in progress, not used yet), see its README (needs Blender and Pixor, not part of the package) |

## Pull requests

- Keep a PR to one topic. Open an issue first for larger changes.
- Add or update unit tests. `npm test` and `npm run pack:check` must pass; CI runs both on Linux and Windows.
- User-facing text goes into both `src/shared/locales/en` and `src/shared/locales/de`. Keep it short.
- Add a line under `[Unreleased]` in `CHANGELOG.md`.
- caw-ai stays framework-independent. Framework specifics belong in `src/host/framework/`.
- Nothing in the package may depend on one particular project or company.

## End-to-end tests

`npm run e2e` starts Chrome and a fake app over HTTPS and takes a while. It runs nightly in CI (Linux with xvfb). Run it locally when you touch replay, the workbench or the browser session.

## Security

Please don't open a public issue for security problems (for example a way around the host allowlist or a credential leak). Use GitHub's private vulnerability reporting on this repository instead.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
