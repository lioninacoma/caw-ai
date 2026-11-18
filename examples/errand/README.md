# Example: Errand

A small todo app to try caw on, mobile first: sign-in, a list with progress ring, filters and search, a "New todo" dialog with selects and a detail page where you move a todo to another day. No dependencies, data lives in memory, the API answers with a little latency.

The test `first-errand` comes with its recording (`caw/recordings/first-errand.yaml`), so you can replay it right away, without Claude. It runs from a clone of the caw-ai repository; run `npm ci` in the repository root once:

```bash
npm ci                                             # in the repository root, once
cd examples/errand
node server.mjs                                    # http://localhost:4174, account demo / demo
```

Put the example's fictitious account into `caw/.env` (role `user`; caw never asks for it, you write it yourself):

```
CAW_USER_USER=demo
CAW_USER_PASSWORD=demo
```

In a second terminal, run the test:

```bash
cd examples/errand
node ../../bin/caw.mjs run first-errand --env local              # workbench window, chat next to the app
```

caw signs in with that account. It also runs without the window:

```bash
node ../../bin/caw.mjs run first-errand --env local --headless   # no window, result in the terminal
```

Without `caw/.env` (CI) set the same two variables in the environment.

The run adds a todo "Feed the raven CAW-…", finds it with the search, ticks it off and moves it to "Tomorrow". The report is in `.caw/runs/`.

Things to try next:

- `open first-errand@S3 --env local` replays S1 and S2 and hands you the window right before the todo is ticked off. F1 opens any test at any step again, in a fresh session.
- In that window, pick the "+" button with the crosshair and ask Claude why "Add todo" starts disabled.
- Paste a bug into the chat: searching for "home" finds nothing although todos are tagged #home. Claude reproduces it and proposes the fix in `server.mjs`.
- Rename the "Add todo" button in `server.mjs`, restart, and `run` again. The step fails; ask Claude in the chat why.
- Record the whole test yourself with Claude in the chat: `node ../../bin/caw.mjs record first-errand --env local`. That replaces the shipped recording.
- Try the setup flow in a copy of this folder: delete `caw.config.json`, then `node <repo>/bin/caw.mjs init --url http://localhost:4174`.

In your own project the command is `npx caw-ai`.
