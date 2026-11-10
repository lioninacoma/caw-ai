# Notices / Hinweise

caw-ai is licensed under the MIT License, see `LICENSE`. It ships or uses the following third-party parts:

- **Fonts:** Silkscreen (logo and speech bubbles) and IBM Plex Mono (text), latin subset as woff2 from the `@fontsource` packages, in `assets/fonts/` under the SIL Open Font License 1.1, see the `OFL-*.txt` files there.
- **Raven and logo:** `assets/raven-sheet.png` and `assets/favicon-32.png` were made for caw-ai and are part of the package under its MIT License.
- **Crow model (work in progress):** `assets/mascot/crow.blend` is "Crow_rig" by RazielNozac (https://www.blendswap.com/blend/31727), CC BY. It is in the repository, not in the npm package; `npm run mascot` turns it into a pixel-art sprite sheet that is not used yet.
- **Playwright:** caw-ai drives Chrome via `playwright-core` (Apache-2.0). It does not download a browser of its own; it uses the installed Google Chrome.
- **Claude Code:** The Docker sandbox installs `@anthropic-ai/claude-code` when the image is built; its own terms apply. Runs with the `docker` agent need your own `CLAUDE_CODE_OAUTH_TOKEN`; the `local` agent uses your own Claude Code sign-in. caw-ai never stores the token and only reads it from the environment.
