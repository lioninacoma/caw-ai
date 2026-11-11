# Example: Errand

A small todo app to try caw-ai on, mobile first: sign-in, a list with progress ring, filters and search, a "New todo" dialog with selects and a detail page where you move a todo to another day. No dependencies, data lives in memory, the API answers with a little latency.

The test `first-errand` comes with its recording (`caw/recordings/first-errand.yaml`), so you can replay it right away, without Claude. It runs from a clone of the caw-ai repository; run `npm ci` in the repository root once:

```bash
npm ci                                             # in the repository root, once
cd examples/errand
node server.mjs                                    # http://localhost:4174, account demo / demo
```

In a second terminal, put the demo account into `caw/.env`. This line works in bash, PowerShell and cmd:

```bash
cd examples/errand
node -e "require('fs').writeFileSync('caw/.env', 'CAW_LOGIN_USER=demo\nCAW_PW_USER=demo\n')"
```

Or by shell:

```bash
printf 'CAW_LOGIN_USER=demo\nCAW_PW_USER=demo\n' > caw/.env                # bash, zsh
Set-Content caw/.env "CAW_LOGIN_USER=demo`nCAW_PW_USER=demo"             # PowerShell
(echo CAW_LOGIN_USER=demo& echo CAW_PW_USER=demo) > caw\.env             # cmd
```

Then run the test:

```bash
node ../../bin/caw-ai.mjs run first-errand --target local              # workbench window, chat next to the app
node ../../bin/caw-ai.mjs run first-errand --target local --headless   # no window, result in the terminal
```

The run adds a todo "Feed the raven CAW-…", finds it with the search, ticks it off and moves it to "Tomorrow". The report is in `.caw/runs/`.

Things to try next:

- `run first-errand --target local --until S2` stops after S2 and hands you the window. F1 restores any step again, in a fresh session.
- In that window, pick the "+" button with the crosshair and ask Claude why "Add todo" starts disabled.
- Paste a bug into the chat: searching for "home" finds nothing although todos are tagged #home. Claude reproduces it and proposes the fix in `server.mjs`.
- Rename the "Add todo" button in `server.mjs`, restart, and `run` again. The step fails; ask Claude in the chat why.
- Record the whole test yourself with Claude in the chat: `node ../../bin/caw-ai.mjs record first-errand --target local`. That replaces the shipped recording.
- Try the setup flow in a copy of this folder: delete `caw.config.json`, then `node <repo>/bin/caw-ai.mjs init --url http://localhost:4174`.

In your own project the command is `npx caw-ai`.
