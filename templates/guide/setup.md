# caw: set up a project

Use this when there is no `caw.config.json` yet or the person wants to set up caw. Detection runs without AI; you add what can
only be learned from the code or from the person.

1. **Find the address.** Take it from the project: `package.json` dev scripts and ports, `.env.example`, Vite, Angular or
   Webpack config, compose files, README, deployed environments named in configs and docs. Ask for a URL only if none of
   that names one.
2. **Explore:** `caw_init` with `mode: "explore"`, `url` and `login` (`true` if the app has a sign-in, `false` if not; `yes: true`
   looks at the page unattended). A window opens: the person signs in with a test account, picks the start page and clicks
   Done; the card asks for the role of that account and saves it as a test user in `caw/.env` ("+ Another role" for more).
   `http` works only on the own machine (`localhost`, `127.0.0.1`, `*.localhost`); elsewhere pass `allowHttp: true` only if the
   person confirms. Self-signed certificates: `insecureTls: true`. The call waits until the window is done and returns the
   suggestions (also in `caw/.explore.json`): framework, sign-in (with proposed `steps` and identity-provider hosts), start page,
   messages, console noise, observed write requests as `reads` candidates, third-party hosts and the saved roles, each with
   `confidence` and `notes`.
3. **Write:** `caw_init` with `mode: "write"` and `fromExplore: true`. Existing files stay. Without a reachable app:
   `mode: "offline"` writes a template with `TODO` in the sign-in.
4. **Complete from the code** with `caw_config` (`patch`; `dryRun: true` first if unsure). Topic `config` has every key.
   - Further environments (staging, test, CI) from configs and docs. Tenants of the same app are environments with `extends`.
   - Role names from seed data, fixtures or permission code; the most important screens from the router (`start`).
   - Lifecycle: `start`, `stop`, `reset` and `ready` from compose files and package scripts, e.g. `docker compose up -d --wait`.
   - Domain terms and peculiarities (date formats, slow services, known messages) go into `caw/caw.md`.
5. **Decide, don't ask.** Set these yourself and list them at the end as "how I set it up":
   - An environment on the own machine: `claude: true`, `writable: true`. dev/test/staging: `claude: true`, `writable: true` only
     if the code shows test data or seeds there. Anything named prod/live or on the public domain: `production: true`.
   - Sign-in: top-level `signIn` applies to every environment. One that signs in differently gets `environments.<env>.signIn`,
     e.g. `{ "type": "none" }` where the code bypasses the login locally. Multi-page or identity-provider sign-in: `steps`, and
     the provider's host in that environment's `allowHosts`. SSO that caw cannot fill: `{ "type": "session", "signedInSelector": … }`
     and `caw_role` with `action: "login"`. An HTTP Basic prompt: `{ "type": "basic" }`. Roles are empty objects
     (`{ "clerk": {} }`); `roles` only if something signs in.
   - Console noise and messages with `confidence: certain` are adopted; `likely` ones go into the closing list.
   - `reads`: only from requests explore observed, and only after the person confirms each one reads (a search, a filter).
     Never guess them from the code: a wrong entry lets a writing test run where it must not.
   Ask only what you cannot decide from the code: an environment you cannot classify, a `reads` candidate.
6. **Test users:** never ask for user names or passwords and never read or write `caw/.env`. More roles with `caw_role`
   (`action: "add"`, `name`, `env`): the window opens, the person signs in and saves. `caw_role` `list` shows per environment
   which role has no test user yet. The names in `caw/.env` follow `CAW_<ROLE>_USER` and `CAW_<ROLE>_PASSWORD` (`__<ENV>` at the
   end for an account of one environment); in CI they are secrets with the same names.
7. **Check:** `caw_doctor` and `caw_validate` until nothing is blocking.
8. **First test:** write a short read-only plan (topic `tests`), e.g. "Sign in and see the start page", check it with
   `caw_validate` and record it with `caw_start` (`command: "record"`) as the agent in your session (topic `session`). Then
   show the closing list and the result.

If the person later installs caw into the project (`npm i -D caw-ai`), run `caw_init` with `mode: "write"` again: it points the
`.mcp.json` entry at the installed copy. Claude Code then needs a restart.
