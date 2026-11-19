# Notices / Hinweise

caw-ai is licensed under the MIT License, see `LICENSE`. It ships or uses the following third-party parts:

- **Fonts:** Geist and Geist Mono (all text) in `assets/fonts/`, under the SIL Open Font License 1.1, see `OFL-geist.txt` there.
  - `geist.woff2` and `geist-mono.woff2` are the variable fonts (weights 100 to 900) of the official Geist release 1.9.2 (github.com/vercel/geist-font), shipped byte for byte; only the file names are shortened. `OFL-geist.txt` is the release's license file.
- **Logo:** the caw logo in `src/host/style.mjs` is part of the package under its MIT License.
- **Icons:** the line icons in `src/host/style.mjs` follow the style of Lucide (lucide.dev), and some paths may be taken from it. Lucide is under the ISC License: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.
- **Playwright:** caw-ai drives Chrome via `playwright-core` (Apache-2.0). It does not download a browser of its own; it uses the installed Google Chrome.
- **Claude Code:** The Docker sandbox installs `@anthropic-ai/claude-code` when the image is built; its own terms apply. Runs with the `docker` agent need your own API key from the Claude Console (`ANTHROPIC_API_KEY`); the `local` and `session` agents use your own Claude Code sign-in. caw-ai passes the key to Docker by name only and never reads or stores it.
- **Trademarks:** Claude and Claude Code are trademarks of Anthropic, PBC. caw-ai is not affiliated with or endorsed by Anthropic. caw-ai names the agent it runs in plain text and uses a generic sparkle icon of its own for it, no vendor's logo.
