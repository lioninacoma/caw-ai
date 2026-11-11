# Notices / Hinweise

caw-ai is licensed under the MIT License, see `LICENSE`. It ships or uses the following third-party parts:

- **Fonts:** VT323 (headings, marks, logo) and IBM Plex Mono (text) in `assets/fonts/`, under the SIL Open Font License 1.1, see the `OFL-*.txt` files there.
  - The files are the latin woff2 subsets from the npm packages `@fontsource/vt323` (5.2.6) and `@fontsource/ibm-plex-mono` (5.3.0), built by Fontsource from the Google Fonts release. caw-ai ships them byte for byte as published there.
  - IBM Plex declares the Reserved Font Name "Plex" (`Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"`). If you modify these files (subset, convert, change glyphs) and distribute the result, the OFL requires a different font name without "Plex". VT323 has no Reserved Font Name.
- **Themes and logo:** the theme packages in `themes/` and the ASCII raven were made for caw-ai and are part of the package under its MIT License.
- **Playwright:** caw-ai drives Chrome via `playwright-core` (Apache-2.0). It does not download a browser of its own; it uses the installed Google Chrome.
- **Claude Code:** The Docker sandbox installs `@anthropic-ai/claude-code` when the image is built; its own terms apply. Runs with the `docker` agent need your own `CLAUDE_CODE_OAUTH_TOKEN`; the `local` agent uses your own Claude Code sign-in. caw-ai never stores the token and only reads it from the environment.
