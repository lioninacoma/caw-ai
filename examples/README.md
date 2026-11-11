# Examples

| Example | What it shows |
|---|---|
| [`errand`](errand) | A small todo app with sign-in, search, a dialog and a detail page. The test `first-errand` is recorded, so `run` works right away, without Claude. Then: restore states with F1, ask Claude about an element, let it find a bug. |

Each example is a project of its own: `caw.config.json`, tests in `caw/tests/`, recordings in `caw/recordings/`, and a `server.mjs` without dependencies. The examples run from a clone of this repository: run `npm ci` in the repository root once, so caw-ai finds its own dependencies. Then start the server and run the test from the example folder with `node ../../bin/caw-ai.mjs`; on the first run the sign-in window asks for the demo account and saves it to `caw/.env`. In your own project it is `npx caw-ai`.

The [framework matrix](../e2e/frameworks) has the same kind of app in React, Vue, Angular, Next.js and Nuxt; it is for testing caw-ai itself.
