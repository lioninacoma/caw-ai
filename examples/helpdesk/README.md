# Example: Helpdesk

A small helpdesk app to try caw-ai on: sign-in, dashboard, ticket list with search, a "New ticket" dialog and a detail page with a status change. No dependencies, data lives in memory, the API answers with a little latency.

```bash
cd examples/helpdesk
node server.mjs                                    # http://localhost:4173, account demo / demo
```

In a second terminal:

```bash
printf 'CAW_LOGIN_USER=demo\nCAW_PW_USER=demo\n' > caw/.env
node ../../bin/caw-ai.mjs doctor
node ../../bin/caw-ai.mjs record create-ticket --target local   # record once, with Claude in the chat
node ../../bin/caw-ai.mjs run create-ticket --target local      # replay, no AI
```

Things to try next:

- Rename the "Create ticket" button in `server.mjs`, restart, and `run` again. The step fails; ask Claude in the chat why.
- Add a step at the end of `caw/tests/create-ticket.yaml` and record just that one with `fix create-ticket S5 --target local`.
- Try the setup flow in a copy of this folder: delete `caw.config.json`, then `node <repo>/bin/caw-ai.mjs init --url http://localhost:4173`.

In your own project the command is `npx caw-ai`.
