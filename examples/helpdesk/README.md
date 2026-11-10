# Example: Helpdesk

A small helpdesk app to try caw-ai on: sign-in, dashboard, ticket list with search, a "New ticket" dialog and a detail page with a status change. No dependencies, data lives in memory, the API answers with a little latency.

The test `create-ticket` comes with its recording (`caw/recordings/create-ticket.yaml`), so you can replay it right away, without Claude:

```bash
cd examples/helpdesk
node server.mjs                                    # http://localhost:4173, account demo / demo
```

In a second terminal:

```bash
cd examples/helpdesk
printf 'CAW_LOGIN_USER=demo\nCAW_PW_USER=demo\n' > caw/.env
node ../../bin/caw-ai.mjs run create-ticket --target local              # workbench window, chat next to the app
node ../../bin/caw-ai.mjs run create-ticket --target local --headless   # no window, result in the terminal
```

The run creates a ticket "Printer offline CAW-…", finds it in the list and sets it to "In progress". The report is in `.caw/runs/`.

Things to try next:

- Rename the "Create ticket" button in `server.mjs`, restart, and `run` again. The step fails; ask Claude in the chat why.
- Add a step at the end of `caw/tests/create-ticket.yaml` and record just that one with `fix create-ticket S5 --target local`.
- Record the whole test yourself with Claude in the chat: `node ../../bin/caw-ai.mjs record create-ticket --target local`. That replaces the shipped recording.
- Try the setup flow in a copy of this folder: delete `caw.config.json`, then `node <repo>/bin/caw-ai.mjs init --url http://localhost:4173`.

In your own project the command is `npx caw-ai`.
