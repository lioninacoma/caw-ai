// Texts: cli (en). Keys prefixed with "cli.".
export default {
    // bin/caw.mjs and help.mjs: help, one block per command. caw --help shows all blocks, caw <command> --help only its own.
    'cli.help.intro': `caw - Context-Aware Web Testing
End-to-end regression tests for your web app: plain-language steps, recorded once with {agent} or by demonstration,
replayed with Playwright locally and in CI without AI.

Set up (in the project folder, app running):
  npx caw init --url http://localhost:5173       sign in once in the window; writes caw.config.json, caw/.env.example
                                                 and .mcp.json; fill in caw/.env and anything left TODO
  npx caw doctor                                 until nothing is MISSING

Commands:`,
    'cli.help.init': `  init [--url <address>]                 Set up the project: looks at the app (you sign in in the window), writes config
                                         and .mcp.json; without --url it asks for the address
      [--explore-only]                   only look at the app: suggestions in caw/.explore.json, no config
      [--env <name>]                     name of the environment (default: local on this machine, else the first part
                                         of the host name)
      [--language <code>]                team language for plans and {agent}'s texts (default: the app's own, asked)
      [--login | --no-login]             answer the sign-in question up front (scripts)
      [--insecure-tls]                   accept self-signed certificates; stored on the environment
      [--allow-http]                     allow plain http to another machine; stored on the environment
      [--yes]                            without sign-in and without questions
      [--from <file>]                    take an existing --explore-only result
      [--no-mcp]                         no entry in .mcp.json
      [--offline]                        don't look at the app: template with TODO for the sign-in (also without
                                         terminal and --url)`,
    'cli.help.record': `  record <test> [--env <name>]           Record a test plan or replace its recording, with {agent} at the chat; only on
                                         environments where {agent} may work{here}
  record <test>@<S4>                     Re-record from S4 to the end: the steps before it replay without {agent}, then
                                         {agent} follows the old plan from S4 while you steer in the chat. From S4 on the
                                         plan may change, the steps before it stay. @S1 records the whole test
      [--role <role>]                    First time only, not with @<S4>; not needed if the config has just one
      [--read-only]                      First time only: the test doesn't write (writes: false); if it does, it's
                                         marked as writing
      [--agent-timeout <duration>]       Time limit for {agent}, default 60m
      [--max-actions <n>]                Limit on the agent's actions, else maxActions from the config, else 100
      [--step-timeout <duration>]        Time limit per step in the check run, default 30s
      [--agent local|docker]             as for run
      [--attach [<key>]]                 as for run
      [--start] [--reset]                as for run (--reset only when given)
      [--overlay[=<parts>]]              as for run`,
    'cli.help.run': `  run <test> [--env <name>]              Replay the test without AI. On environments where {agent} may work{here}, the
                                         chat sits alongside: if a step fails, sort it out there with {agent}
      [--explain]                        On errors or warnings {agent} explains unasked, costs tokens; only on
                                         environments where {agent} may work
      [--no-chat]                        No chat and no {agent}, like in CI
      [--headless]                       No window and no chat
      [--learn]                          In CI: learn missing baselines and effects into caw/recordings/ (outside CI
                                         every run does)
      [--strict]                         Pending steps (the unrecorded tail) fail the run with exit 4 instead of
                                         passing without them
      [--promote]                        A draft from caw/drafts: when it passes and so does run --all on the same
                                         environment, it moves to caw/tests and the run folder gets fix-report.md
      [--start]                          Start the environment with its start command if it doesn't answer, stop it at
                                         the end; with --overlay also the parts' local code servers
      [--reset] | [--no-reset]           The environment's reset runs once before the first writing test; --reset
                                         before the first test, --no-reset never
      [--step-timeout <duration>]        Time limit per step, default 30s
      [--agent-timeout <duration>]       Time limit for {agent} when clarifying and fixing, default 60m
      [--max-actions <n>]                Limit on the agent's actions when fixing, else maxActions from the config, else 100
      [--agent local|docker]             Where caw starts {agent}; default from agent.mode in the config (local)
      [--attach [<key>]]                 Your own {agent} session answers instead (after /caw-attach there),
                                         no extra tokens; <key> names one of several listening sessions
      [--overlay[=<parts>]]              Lay local code over the deployed environment. Without a value every part of
                                         overlay.parts with its source; build or dev for that source; <url> for the
                                         only part; or parts: --overlay=orders,admin:dev. Only on overlay.environments
  run <test> <test> … | --all            Several tests in a row, for CI: no chat, a table at the end, exit code of the
      [--env <name>]                     worst run. --all takes every test that lists the environment
      [--headless]                       No window
      [--report <kind>=<file>]           Also write the result: junit (XML), summary (Markdown) or json;
                                         repeatable, e.g. --report junit=out/junit.xml --report summary=out/summary.md
      [--retry-env <n>]                  Run a test again up to n times while it fails on the environment
      [--learn] [--strict] [--start] [--reset | --no-reset]  as for one test; start and reset once for the whole row`,
    'cli.help.open': `  open [<test>[@<S4>]] [--env <name>]    Open the app with workbench and chat. Without a test: navigate, try
                                         things, develop with the agent. With <test>: replay it first. With @<S4>: up to the
                                         entry of S4 (its navigation runs, its inputs and check stay open). Learns
                                         nothing, writes no test file
      [--design]                         With @<S4>: through S4, its target design over the app (F7)
      [--role <role>]                    Without a test only; not needed if the config has just one
      [--step-timeout <duration>]        Time limit per step while replaying, default 30s
      [--agent local|docker] [--attach [<key>]] [--agent-timeout <duration>] [--max-actions <n>]
      [--start] [--reset]                as for run (--reset only when given)
      [--overlay[=<parts>]]              as for run`,
    'cli.help.reproduce': `  reproduce "<bug report>" [--env <name>]  {agent} reproduces a bug on its own, signed in as a test role: no plan
                                         to approve, no decisions. Writes a report and a draft test plan to the run
                                         folder, never into caw/tests. Only where {agent} may work{here}, never on
                                         production; read-only unless the environment is writable; no code changes.
                                         Exit 0 reproduced, 1 not reproduced or unclear
      [--file <file>] | -                The bug report from a file, or from stdin
      [--from <test>[@<S4>]]             Start in a test's state: its steps up to the entry of S4, without {agent}
      [--role <role>]                    Without --from; not needed if the config has just one
      [--ref <id>]                       An id from another tool (a ticket), kept in report, result and draft;
                                         caw never looks it up
      [--headless]                       No window
      [--agent local|docker] [--attach [<key>]]`,
    'cli.help.list': `  list [<test>]                          Tests with environments, recording state (recorded, stale, not recorded) and
                                         whether they write; with <test> one line per step`,
    'cli.help.validate': '  validate                               Check config and tests offline, without browser or {agent} (CI, pre-commit)',
    'cli.help.doctor': `  doctor [--agent local|docker]          Check Node, Chrome, {agent} (local) or Docker and token (docker),
                                         test users and environments, each with the next step
      [--attach]                         instead: what your own {agent} session needs (caw in .mcp.json)
      [--env <name>]                     only this environment's test users and address`,
    'cli.help.skill': `  skill                                  Write or update the {agent} skill caw-attach (.claude/skills/caw-attach):
                                         it tells your session when and how to work with you in a caw window. Check it in.`,
    'cli.help.role': `  role [list] [--json]                   Roles, whether a test user is set (never the values), and which tests use them
  role add <role>                        Add the role to the config and its variable names to caw/.env.example; you put
                                         the test user into caw/.env (or CI secrets) by hand
  role remove <role>                     Remove a role no test uses; caw/.env stays, its lines there are named
  role login <role> --env <name>         With signIn type session: sign in once by hand (e.g. SSO), the session goes
                                         to caw/.auth/<env>/<role>.json`,
    'cli.help.export': `  export <test> [--env <name>]           The recorded test as a Playwright test that runs without caw (@playwright/test):
      [--out <dir>]                      <test>.spec.mjs, caw-support.mjs and playwright.config.mjs, in caw/export/playwright`,
    'cli.help.overlay': `  overlay status [--env <name>]          Is the local code server ready (url of the part)? No browser, starts nothing: ready,
                                         moved (runs on another port), down, wrong-app, stale
      [--part <part>] [--json]           Not needed if overlay.parts has just one; --json: the status as one JSON line
  overlay check [--env <name>]           Token-free check that the overlay replaces everything it should: loads the app
                                         headless with --overlay, per part local, deployed or not loaded
      [--part <part>] [--role <role>]    Not needed if overlay.parts has just one
      [--apply]                          Add the suggested overlay.assetUrlPattern entries and check again
      [--start]                          Run the part's start if the server doesn't answer, stop it afterwards
      [--json]                           Result as one JSON line (also in .caw/overlay-check.json)`,
    'cli.help.overlayStartClause': '; with --overlay also the parts\' local code servers',
    'cli.help.version': '  --version                              Package version',
    'cli.help.here': ' (here: {names})',
    'cli.help.footer': `--env <name>: a name from environments, e.g. local. Left out when the choice is clear: the only one that fits, or for run
outside CI the only one where {agent} may work; production only when named.
Durations take units: --step-timeout 30s, --agent-timeout 60m.

caw <command> --help for details.
Exit codes: 0 pass, 1 fail, 2 error (environment), 3 rejected (input), 4 needs recording.`,
    'cli.help.agent': `caw agent <command>: for {agent} during a run (sandbox, local, or your session with --attach), drives the browser:
  task                                   Show the task of the open run
  snapshot                               Page structure with references (e1, e2, ...)
  url                                    Current URL
  click <target> [--optional]            Target: reference, locator code or CSS selector; --optional: skip if absent
  dblclick <target>                      Double-click, e.g. a grid row that opens on double-click
  upload <target> <file>...              Files from caw/fixtures (fixtures/brief.pdf) into a file field or the chooser its
                                         button opens
  fill <target> <text>                   Set a field; a select list: the option with this value or label
  type <target> <text>                   Type character by character
  press <key>                            Press a key, e.g. Enter
  eval <expression>                      Evaluate JavaScript in the page
  check <S1> <expression>                Check a step: the expression must return exactly true
  screenshot <name.png>                  Save a screenshot in the agent folder
  goto <url>                             Navigate to an allowed host
  reload                                 Reload the page
  wait-ready [--for <selector>] [--min-count <n>] [--timeout <duration>]
                                         Wait until the page is quiet, optionally until enough entries are there
  console                                Fetch new hard console errors
  network                                Recent app requests with outcome and duration, no parameter values
  plan --file <plan.yaml>                Present the plan in the chat, waits for approval or changes
  ask-operator "<what's missing>"        Ask the human or request a demo, the steps go into the test
  remember <name> <expression>           Remember a value only the run creates, e.g. an order number
  chat                                   Read messages, waits for the human while paused and in conversation
  say <text>                             Write to the human, doesn't wait for a reply
  recording                              Show the steps recorded so far, numbered
  finish --file <result.json>            Submit the verdict; recorded only with "omit"
  advise --file <advice.json>            Submit advice, also when fixing; the human decides per card`,
    // The synopsis per command, shown below a usage error.
    'cli.synopsis.init': 'caw init [--url <address>] [--env <name>] [--language <code>] [--explore-only] [--login | --no-login] [--yes] [--from <file>] [--offline] [--insecure-tls] [--allow-http] [--no-mcp]',
    'cli.synopsis.export': 'caw export <test> [--env <name>] [--out <dir>]',
    'cli.synopsis.reproduce': 'caw reproduce "<bug report>" | --file <file> | -  [--env <name>] [--role <role>] [--from <test>[@<S4>]] [--ref <id>] [--headless] [--agent local|docker] [--attach [<key>]]',
    'cli.reproduceOneSource': 'Give the bug report as the argument, with --file or with - from stdin, only once.',
    'cli.reproduceBugMissing': 'Which bug? caw reproduce "After saving, the list does not show the entry" (or --file <file>, or - for stdin).',
    'cli.reproduceBugLong': 'The bug report is longer than {max} characters. Cut it down to what happens and what you expect.',
    'cli.reproduceBugControl': 'The bug report contains control characters.',
    'cli.reproduceFileMissing': '{file} does not exist or is no file.',
    'cli.reproduceNotAllowed': 'caw reproduce runs only on environments {agent} may work on (agent: true), never on production. {target} is none. Allowed: {environments}',
    'cli.reproduceRoles': 'Several roles in the config: --role <role> picks one ({roles}), or --from <test> takes the test\'s role.',
    'cli.reproduceStart': 'Reproducing on {env} as {role} ({writes}).',
    'cli.reproduceWrites': 'writing allowed',
    'cli.reproduceReadOnly': 'read-only: caw aborts every write request',
    'cli.reproduceVerdict.yes': 'Reproduced.',
    'cli.reproduceVerdict.no': 'Not reproduced.',
    'cli.reproduceVerdict.unclear': 'Unclear whether the bug occurs.',
    'cli.reproduceRef': '--ref {ref} is no reference: up to 64 letters, digits and . _ # : / -, e.g. --ref TCK-1234.',
    'cli.reproduceDraft': 'Draft test: {file}. Review it, then record it red: {record}',
    'cli.synopsis.list': 'caw list [<test>]',
    'cli.synopsis.doctor': 'caw doctor [--agent local|docker | --attach] [--env <name>]',
    'cli.synopsis.skill': 'caw skill',
    'cli.synopsis.role': 'caw role [list [--json] | add <role> | remove <role> | login <role> --env <name>]',
    'cli.synopsis.run': 'caw run <test> [--env <name>]  or  caw run <test> <test> … | --all [--env <name>] [--agent local|docker | --attach [<key>]]  or  caw run <draft> --promote [--env <name>]',
    'cli.synopsis.record': 'caw record <test> [--env <name>] [--role <role>]  or  caw record <test>@<S4> [--env <name>] [--agent local|docker | --attach [<key>]]',
    'cli.synopsis.open': 'caw open [--env <name>] [--role <role>]  or  caw open <test>[@<S4>] [--design] [--env <name>] [--agent local|docker | --attach [<key>]]',
    'cli.synopsis.overlay': 'caw overlay status|check [--env <name>] [--part <part>] [--apply] [--start] [--json]',
    'cli.usageLine': 'Usage: {synopsis}',
    'cli.errorCode': '(code: {code}, exit {exit})',
    'cli.reportOutside': '--report {kind}={file} must name a file inside the project.',
    'cli.fromOutside': '{from} is not inside the project.',
    'cli.fromMissing': 'not found',
    'cli.fromNotJson': 'not an explore result (JSON)',
    'cli.fromUnreadable': "Can't read {from}: {message}",
    'cli.doctorUnknownArg': "doctor doesn't know {arg}. Allowed: --agent local|docker, --attach, --env <name>",
    'cli.doctorAgentValue': '--agent expects local or docker; for your own session: --attach.',
    'cli.mcpAgentOnly': 'caw agent mcp only starts for the agent of a run.',
    'cli.unknownCommand': 'Unknown command: {command}.{suggestion} See caw --help.',
    'cli.export.usage': 'caw export takes one test: caw export <test> [--env <name>] [--out <dir>].',
    'cli.export.unknownArg': 'caw export does not know {arg}.',
    'cli.export.notRecorded': '{test} is not recorded completely ({steps}): record it first, then export.',
    'cli.export.stale': '{test} has outdated steps ({steps}): re-record from there with caw record {test}@{from}, then export.',
    'cli.export.todo': 'The sign-in is still TODO ({keys}): fill it in, then export.',
    'cli.export.foreignFile': '{file} was not written by caw export: move it away or choose another --out.',
    'cli.export.done': 'Exported {test} for {env}: {files}.',
    'cli.export.configKept': '{file} already exists and stays as it is.',
    'cli.export.next': 'Run it with Playwright: npm i -D @playwright/test, then npx playwright test -c {dir} (report: npx playwright show-report {dir}/playwright-report). Test users as for caw (CAW_<ROLE>_USER …), CAW_BASE_URL for another address.',
    'cli.movedCommand': 'caw {command} is now caw {now}.',
    'cli.overlayCommandInactive': 'caw overlay is an extension and is not active here: it needs an overlay block in caw.config.json. See docs/extensions/overlay.md.',
    'cli.overlayFlagInactive': '--overlay is an extension and is not active here: it needs an overlay block in caw.config.json. See docs/extensions/overlay.md.',
    'cli.skillCreated': 'Skill written: {file}. Check it in; your Claude Code session uses it from its next start (or /reload-plugins).',
    'cli.skillUpdated': 'Skill updated: {file}.',
    'cli.skillCurrent': 'Skill is up to date: {file}.',
    'cli.skillForeign': '{file} exists and was not written by caw; it stays as it is. Move it away, then run caw skill again.',
    'cli.unknownAgentCommand': 'Unknown command: caw agent {command}.{suggestion} See caw agent --help.',
    'cli.didYouMean': ' Did you mean {name}?',

    // commands.mjs: explore file, config, init
    'cli.notExploreResult': "This file doesn't look like a caw init --explore-only result.",
    'cli.unknownFramework': 'caw doesn\'t know framework "{framework}" ({names}).',
    'cli.initAuthUnknown': 'init has no sign-in type "{auth}" (form, session, none).',
    'cli.badRoleName': 'Role "{name}": lowercase letters, digits and hyphens only, starting with a letter (e.g. admin, clerk).',
    'cli.mcpInvalid': '.mcp.json is not valid JSON, please add the caw entry by hand (see README).',
    'cli.mcpUpdated': '.mcp.json: the caw entry now starts the installed copy instead of npx. Restart {agent} in the project.',
    'cli.initCreated': 'Created: {files}',
    'cli.initAlready': 'Already set up.',
    'cli.initNeedsUrl': 'Usage: npx caw init --url <address>. init looks at the app first; you sign in in the window.',
    'cli.initUsesExplore': 'Using the suggestions from {file}.',
    'cli.envExampleHead': '# Copy to caw/.env (gitignored) and enter test accounts with few rights.\n# The agent cannot see this file but drives a signed-in browser: do not use personal accounts.',
    'cli.initTodo': 'Still to fill in caw.config.json: {keys} (not found by explore, see notes in caw/.explore.json).',
    'cli.initTodoOffline': 'Still to fill in caw.config.json: {keys}. caw init --explore-only --url <address> finds the selectors once the app is running.',
    'cli.doctorTodo': ({ keys, count }) => `${keys} ${count > 1 ? 'are' : 'is'} still TODO`,
    'cli.doctorTodoNext': 'Fill in caw.config.json: path and field selectors from the sign-in page, signedInSelector from the page after signing in. caw init --explore-only --url <address> finds them.',
    'cli.initNext': 'Next: caw doctor, then record the first test: caw record <test> --env {target}.',
    'cli.askEnv': 'Name of this environment',
    'cli.askLanguage': 'Team language (plans and {agent}\'s texts), a code such as en, de, fr',
    'cli.initEnvBad': 'Environment "{env}": lowercase letters, digits and -, starting with a letter, at most 32 characters.',
    'cli.initLanguageBad': 'Team language "{language}": a language code such as en, de or fr.',
    'cli.initNeedsAllowHttp': '{host} is plain http and not on this machine: add --allow-http if that is really meant (everything, also the sign-in, travels unencrypted).',
    'cli.initProductionLike': 'Environment {env} looks like production: written with production: true, so caw never writes there and {agent} does not work there. Rename it with --env if it is not production.',
    'cli.initNextExplore': ' No fitting selectors yet? Run caw init --explore-only --url <address> first.',
    'cli.initOfflineFallback': 'No terminal and no --url: init writes the template, the sign-in stays TODO. Later: caw init --explore-only --url <address>.',
    'cli.contextTemplate': '# Notes for {agent}\n\nWhat {agent} should know in every test but can\'t see in the code. No personal data.\n\n- Example: The search remembers the last input. Click "Clear filter" first.\n',

    // commands.mjs: init dialog
    'cli.askUrl': 'Address of the local environment',
    'cli.askUrlProtocol': 'Please enter an address with http:// or https://.',
    'cli.askUrlInvalid': "That's not an address, e.g. http://localhost:5173.",
    'cli.askRoles': 'Roles, comma-separated',
    'cli.askRolesBad': '"{name}": lowercase letters, digits and hyphens only, e.g. admin, clerk.',

    // commands.mjs: auth
    'cli.authUsage': 'Usage: caw role login <role> --env <env>',
    'cli.authStorageOnly': 'caw role login only works where the sign-in is of type session; on {target} it is {type}.',
    'cli.authRoleUnknown': 'Role {role} is not in roles ({roles}).',
    'cli.targetProduction': '{target} is production.',
    'cli.authSignIn': 'Sign in as {role} in the Chrome window. As soon as {selector} appears, caw saves the session.',
    'cli.authClosed': 'Window closed, nothing saved.',
    'cli.authSaved': "Saved: {file}. The file holds login cookies and doesn't belong in the repository.",
    'cli.authIgnored': 'Added {dir} to .gitignore: saved sessions don\'t belong in the repository.',

    // commands.mjs: validate
    'cli.validateChain': '{file}: {chain}, record again.',
    'cli.validateNotRecorded': '{file}: not recorded yet.',
    'cli.validatePending': '{file}: {ids} pending, not recorded yet (run passes without them, --strict does not).',
    'cli.validateOk': '{config} and {count} test(s) are valid.',
    'cli.validateCode': '{id} ({target}): {code}',
    'cli.validateCodeOverlay': '{id} ({target}): {code}; with --overlay: {overlay}',
    'cli.validateCodeOverlayChoose': '{id} ({target}): {code}; with --overlay build or dev: {overlay}',
    'cli.validateTodo': '{key} is still TODO: {what}',
    'cli.validateTodo.path': 'enter the path of the sign-in page, e.g. "/login"',
    'cli.validateTodo.userSelector': 'enter the CSS selector of the user name field',
    'cli.validateTodo.passwordSelector': 'enter the CSS selector of the password field',
    'cli.validateTodo.submitSelector': 'enter the CSS selector of the sign-in button or remove the field (then Enter submits)',
    'cli.validateTodo.codeSelector': 'enter the CSS selector of the one-time code field',
    'cli.validateTodo.signedInSelector': 'enter a CSS selector that only exists when signed in, e.g. the user menu',

    // commands.mjs: list
    'cli.listNone': 'No tests in {dir} yet. Record the first with caw record <test>.',
    'cli.listHead': 'Test|Environments|Recording|Data',
    'cli.listRecorded': 'recorded',
    'cli.listStale': 'stale ({ids})',
    'cli.listNotRecorded': 'not recorded',
    'cli.listPending': 'pending ({ids})',
    'cli.listInvalid': 'invalid',
    'cli.listWrites': 'writes',
    'cli.listReadOnly': 'read-only',
    'cli.listStepRecorded': 'recorded',
    'cli.listStepStale': 'stale',
    'cli.listStepNotRecorded': 'not recorded',
    'cli.listStepPending': 'pending',
    'cli.listTestHead': '{test}: start {start}, role {role}, environments {environments}, {writes}',
    'cli.knownTests': 'Known tests: {tests}.',
    'cli.noTests': 'There are no tests in caw/tests yet.',
    'cli.knownSteps': 'Steps: {steps}.',

    // commands.mjs: sandbox, run, record, open
    'cli.imageBuilding': 'Building the sandbox image (only on the first run and after tool changes) ...',
    'cli.imageBuildFailed': "Couldn't build the sandbox image (exit {code}). Missing registry login for {image}?",
    'cli.testMissing': 'Test not found: {file}. {known} Record it: {hint}',
    'cli.testMissingNear': 'Test not found: {file}. Did you mean {name}? {known} To record a new test of this name: {hint}',
    'cli.envChosen': 'Environment: {env} ({why})',
    'cli.envWhyTest': 'only environment of {test}',
    'cli.envWhyTests': 'only environment of the tests',
    'cli.envWhyNew': 'only environment where {agent} may work',
    'cli.envWhyOnlyClaude': 'the only one where {agent} may work',
    'cli.validateNowhere': '{id} runs nowhere: no environment fits (a writing test needs a writable environment)',
    'cli.noEnvironment': 'no environment',
    'cli.verbRecord': 'Recording',
    'cli.verbReproduce': 'Reproducing',
    'cli.agentOnly': '{verb} needs environments.{environment}.agent: true (currently only: {environments}).',
    'cli.agentNotInCi': "--agent {agent} doesn't work in CI (variable CI set), there {agent} runs in Docker only.",
    'cli.attachUsage': 'caw attach --watch <key> is for your session’s Monitor after caw_attach; the key is four characters such as k7f2.',
    'cli.attachListening': 'caw: listening as {key}. Each line below is something a caw window wants from you.',
    'cli.attachGone': 'caw: listener {key} is gone (its session ended). Call caw_attach again to listen.',
    'cli.sessionAgent': 'Your own {agent} session answers (--attach): it hears of this window after /caw-attach there.',
    'cli.sessionLabel': 'your {agent} session',
    'cli.localAgent': '{agent} runs locally without Docker, with read access and the browser tool only ({agent} {version}). Isolated: agent.mode "docker".',
    'cli.usingDocker': 'Using {label}.',
    'cli.tokenMissing': '{hint} {agent} in Docker needs an API key from the Claude Console. Without one, use --agent local: it runs with your own {agent} login.',
    'cli.and': ' and ',
    'cli.draftMissing': 'The new test {id} needs {missing}. Usage: {hint}',
    'cli.choiceShow': 'Show it myself',
    'cli.choiceDescribe': 'Describe it, {agent} records',
    'cli.describeNoted': '{id} noted (page {path}). Describe more, or "{button}".',
    'cli.describeNothing': 'Nothing described yet. Write what the test should do, then "Hand over to {agent}".',
    'cli.choiceFollow': '{agent} follows the test plan',
    'cli.choiceReuse': 'Use last demo ({time}, {count} entries)',
    'cli.recordAborted': 'Recording was cancelled.',
    'cli.questionNew': 'How should {id} be created?',
    'cli.questionRecorded': 'How should the new recording of {id} be created?',
    'cli.questionRecordedWhy': '{id} is already recorded. The recording is only replaced if you agree at the end.',
    'cli.questionDescribed': 'Will you show {id}, or should {agent} follow the test plan?',
    'cli.questionDescribedWhy': '{id} is described but not recorded yet.',
    'cli.demoNote': 'Only show test data: your input goes to {agent} and ends up in the recording. Passwords are never captured.',
    'cli.dialogAsks': 'The app asks',
    'cli.dialogSays': 'The app says',
    'cli.dialogLeave': 'The app asks before leaving the page',
    'cli.dialogValue': 'The app asks for a value',
    'cli.dialogPrompt': 'Type the value here and send it, or choose OK (keeps "{value}") or Cancel.',
    'cli.dialogQuoted': '"{message}"',
    'cli.dialogOk': 'OK',
    'cli.dialogCancel': 'Cancel',
    'cli.demoRecorded': 'Recorded: {line}',
    'cli.demoFailure': "{label}. It's at this point in the recording.",
    'cli.demoNothingFollow': 'Nothing shown: {agent} follows the test plan.',
    'cli.demoNothing': 'Nothing shown yet. Click through the flow in the app, then "Finish demo".',
    'cli.modeLine': 'Mode on {env} (team language {language}): {how}; learns: {learns}.',
    'cli.modeNoAgent': 'no chat, {agent} may only work on {environments}',
    'cli.modeHeadless': 'no window and no chat (--headless)',
    'cli.modeNoChat': 'no chat (--no-chat)',
    'cli.modeCi': 'no chat, because the variable CI is set',
    'cli.modeChat': 'with chat{advice}',
    'cli.modeLearnsNo': 'no',
    'cli.modeLearnsYes': 'yes, missing baselines and effects into {file}',
    'cli.modeAdvice': ' and advice from {agent} (--explain, costs tokens)',
    'cli.changed': 'Changed: {files}',
    'cli.changedWhat': '{file} ({what})',
    'cli.changedBaselines': 'baselines {ids}',
    'cli.changedEffects': 'effects {ids}',
    'cli.changedSteps': 'steps {ids}',
    'cli.changedPlan': 'test plan',
    'cli.unchanged': 'Test file unchanged.',
    'cli.batchStart': '{count} test(s) on {target}, one after another and without chat{headless}.',
    'cli.batchWindow': ' (no window with --headless)',
    'cli.batchNone': 'No test runs on {target}.',
    'cli.batchHeading': ({ count, target }) => `Result: ${count} ${count === 1 ? 'test' : 'tests'} on ${target}`,
    'cli.batchStatus.pass': 'PASS',
    'cli.batchStatus.fail': 'FAIL',
    'cli.batchStatus.error': 'ERROR',
    'cli.batchStatus.rejected': 'REJECTED',
    'cli.batchStatus.needsRecording': 'NEEDS RECORDING',
    'cli.batchAt': 'at {step}',
    'cli.batchPending': '{steps} pending',
    'cli.junitWritten': 'JUnit report: {file}',
    'cli.stepUnknown': '{test} has no step {step}.{suggestion} {steps}',
    'cli.adviseAgentOnly': '--explain only on environments where {agent} may work (here: {environments}), not on {target}.',
    'cli.ciHandover': '{option} hands the browser to a person; in CI (variable CI set) there is none.',
    'cli.ciNeedsHuman': 'caw {command} needs a person in the chat (demonstration, plan, decisions); in CI (variable CI set) there is none.',
    'cli.adviseNeedsChat': "--explain needs the chat; in CI (variable CI set) {agent} doesn't advise.",
    'cli.failedHintAgent': '{step} failed. Find the cause: caw run {test} --env {target} in the terminal, the chat shows the assessment and lets {agent} investigate. Only if the app changed on purpose, re-record from there: caw record {test}@{step} --env {target}',
    'cli.failedHint': '{step} failed. Find the cause in a run with chat: caw run {test} --env {target}',
    'cli.failedHintNoAgent': '{step} failed. A run with chat finds the cause, on an environment where {agent} may work (here: {environments}).',
    'cli.untilHint': 'Up to the entry of the step: caw open {test}@{step} --env {target}',
    'cli.pendingSteps': 'Pending, not recorded yet: {ids}. They did not run. Record them: caw record {test}@{step} --env {target}',
    'cli.recordExists': 'Test {test} already exists, its metadata stays. --role and --read-only must match the file or be left out.',
    'cli.recordStepUnknown': '{test} has no step {step}.{suggestion} {steps} Add a new step to {file} first.',
    'cli.recordFromReason': 'Re-recording from {step} on was requested',

    // doctor.mjs
    'cli.doctorNodeOld': 'Node {version} is too old',
    'cli.doctorNodeNext': 'Install Node {min} or newer.',
    'cli.doctorConfigOk': '{file} is valid',
    'cli.doctorConfigNextValidate': ({ count }) => (count > 1 ? `caw validate shows all ${count} findings.` : 'caw validate shows all findings.'),
    'cli.doctorConfigMissing': '{file} is missing',
    'cli.doctorConfigNextInit': 'caw init creates it.',
    'cli.doctorBrowserOk': 'Browser starts ({browser})',
    'cli.doctorBrowserFail': "Browser doesn't start ({browser}): {error}",
    'cli.doctorBrowserNext': 'Install Google Chrome (Stable), caw uses the system Chrome; or set browser.channel or browser.executablePath in the config.',
    'cli.doctorPersonalOk': 'Personal notes for {agent}: {path} ({lines} lines), read in every project before caw/caw.md',
    'cli.doctorPersonalNone': 'No personal notes for {agent} (optional: {path})',
    'cli.doctorSkillMissing': 'No skill caw-attach for your {agent} session ({file})',
    'cli.doctorSkillOld': 'The skill caw-attach is older than this caw ({file})',
    'cli.doctorSkillNext': 'caw skill writes it; then check it in.',
    'cli.doctorSkillOk': 'Skill caw-attach for your {agent} session ({file})',
    'cli.doctorSkillForeign': '{file} exists and is not caw’s; caw leaves it as it is',
    'cli.doctorSessionOk': 'Your {agent} session takes over (caw entry in .mcp.json)',
    'cli.doctorSessionMissing': 'caw entry in .mcp.json is missing',
    'cli.doctorSessionNpx': 'The caw entry in .mcp.json starts caw through npx although caw is installed in the project',
    'cli.doctorSessionNpxNext': 'npx caw init points it at the installed copy; then restart {agent} in the project.',
    'cli.doctorSessionNext': 'claude mcp add caw --scope project -- npx caw-ai mcp (or npx caw init) adds it; then restart {agent} in the project.',
    'cli.doctorClaudeOk': '{agent} {version} ({agent} runs locally, without Docker)',
    'cli.doctorClaudeMissing': '{agent} (claude) is not in PATH',
    'cli.doctorClaudeNext': 'Only for runs with {agent}: install {agent} and sign in once, or agent.mode "docker".',
    'cli.doctorDockerOk': 'Docker: {label}',
    'cli.doctorDockerNext': 'Only needed for record and {agent} in the chat: start Docker (Linux containers).',
    'cli.doctorTokenOk': 'Access for {agent} in Docker: {name}',
    'cli.doctorTokenMissing': 'No access for {agent} in Docker (ANTHROPIC_API_KEY)',
    'cli.doctorTokenNext': 'Only for runs with {agent} in Docker: set an API key from the Claude Console as ANTHROPIC_API_KEY. Locally {agent} uses your {agent} login.',
    'cli.doctorIgnoreOk': '.gitignore protects runs, credentials and sessions',
    'cli.doctorIgnoreMissing': '.gitignore is missing: {lines}',
    'cli.doctorIgnoreNext': 'caw init adds the entries.',
    'cli.doctorRoleOk': 'Role {name} on {target}: test user set',
    'cli.doctorRoleMissing': ({ name, target, missing, count, file }) => `Role ${name} on ${target}: ${missing} ${count > 1 ? 'are' : 'is'} missing in ${file}`,
    'cli.doctorRoleNext': 'Put the variables into {file} by hand ({file}.example names them); in CI set them as environment variables.',
    'cli.doctorGateOk': 'Gate on {target}: account set',
    'cli.doctorGateMissing': ({ target, missing, count, file }) => `Gate on ${target}: ${missing} ${count > 1 ? 'are' : 'is'} missing in ${file}`,
    'cli.doctorGateNext': 'Enter the account of the Basic gate in {file} (in CI as environment variables).',
    'cli.doctorEnvUnknown': '{file}: {names} belong to no role and not to the gate (typo?)',
    'cli.doctorEnvUnknownNext': 'Names are CAW_<ROLE>_USER, CAW_<ROLE>_PASSWORD, CAW_<ROLE>_TOTP, optionally with __<ENV>; roles: {roles}',
    'cli.doctorSessionSaved': 'Role {name} on {target}: session saved',
    'cli.doctorSessionNone': 'Role {name} on {target}: no session',
    'cli.doctorReachOk': '{target}: {url} responds',
    'cli.doctorReachFail': "{target}: {url} doesn't respond",
    'cli.doctorReachNext': 'Check VPN, dev server or the address in environments.',
    'cli.doctorReachPlaceholder': '{target}: {url} is a placeholder',
    'cli.doctorReachPlaceholderNext': 'Enter the real address in environments or remove the environment.',
    // overlay-check.mjs
    'cli.overlayCheck.usage': 'overlay knows status and check, not "{sub}".',
    'cli.overlayCheck.unknownArg': 'overlay {sub} doesn\'t know {arg}. Allowed: {allowed}',
    'cli.overlayCheck.target': 'Which environment? Use --env, choices: {choices}',
    'cli.overlayCheck.noPart': 'No part "{part}" in overlay.parts. Use --part, choices: {parts}',
    'cli.overlayCheck.noAppJson': 'Part {app}: no app.json in {dir}. Is overlay.parts.{app}.dir right?',
    'cli.overlayCheck.noExpected': '{framework} has no expected list: nothing to check.',
    'cli.overlayCheck.noDiagnosis': 'The session returned no overlay diagnosis.',
    'cli.overlayCheck.head': 'Overlay check on {target}, part {part}',
    'cli.overlayCheck.part.local': '{label}: local',
    'cli.overlayCheck.part.deployed': '{label}: deployed',
    'cli.overlayCheck.part.not-loaded': '{label}: not loaded (maybe later)',
    'cli.overlayCheck.suggestion': '{source} ({count} script(s)): overlay.assetUrlPattern {pattern}',
    'cli.overlayCheck.unresolved': '{source}: no matching pattern found, e.g. {urls}',
    'cli.overlayCheck.applied': 'Added {count} pattern(s) to overlay.assetUrlPattern and checked again',
    'cli.overlayCheck.command': 'Command: {command} (in {dir})',
    'cli.overlayCheck.complete': 'Complete: everything expected came from local code.',
    'cli.overlayStatus.static.ok': 'static {name}: {path}',
    'cli.overlayStatus.static.missing': 'static {name}: {path} is missing',
    'cli.overlayStatus.static.outside': 'static {name}: {path} leads outside the workspace {boundary}',
    'cli.overlayStatus.static.secret': 'static {name}: {path} is a secret file, never served',
    'cli.overlayCheck.static.local': 'static {name}: local ({path})',
    'cli.overlayCheck.static.deployed': 'static {name}: came from the server; the asset pattern does not yield this name',
    'cli.overlayCheck.static.not-loaded': 'static {name}: not loaded by the page',
    'cli.overlayCheck.incomplete': 'Incomplete: {count} script(s) came from the server.',
    'cli.overlayCheck.incompleteApply': 'Incomplete: {count} script(s) came from the server. caw overlay check --apply adds the patterns.',
    'cli.overlayStatus.ready': 'Local code for {app} is ready: {url}',
    'cli.overlayStatus.readyNoServer': 'Local code for {app} is ready (no server needed)',
    'cli.overlayStatus.moved': 'The local code server of {app} runs at {found}, not at {url}. caw uses it; set overlay.parts.{app}.url to {found}.',
    'cli.doctorOverlayBootstrap': '{target}, part {app}: bootstrap.json is current',
    'cli.doctorOverlayBootstrapBad': '{target}, part {app}: {problem}',
    'cli.doctorOverlayServerOk': '{target}, part {app}: local code at {url} serves {app}',
    'cli.doctorOverlayServerMoved': '{target}, part {app}: local code runs at {found}, not at {url}',
    'cli.doctorOverlayServerMovedNext': 'Set overlay.parts.{app}.url to {found}.',
    'cli.doctorOverlayServerDown': '{target}, part {app}: local code at {url} doesn\'t answer',
    'cli.doctorOverlayServerBad': '{target}, part {app}: local code at {url}: {problem}',
    'cli.doctorOverlayStartNext': 'Start {start} in {dir}; caw starts it only with --start.',
    'cli.doctorOverlayStartUnknown': 'Name the start command in overlay.parts.{app}.start.',
    'cli.doctorOverlayPart': '{target}, part {app}: {label} {status} (checked {ago})',
    'cli.doctorOverlayStatus.local': 'local',
    'cli.doctorOverlayStatus.deployed': 'deployed',
    'cli.doctorOverlayStatus.not-loaded': 'not loaded',
    'cli.doctorOverlayPartNext': 'caw overlay check shows the missing pattern, --apply adds it.',
    'cli.doctorOverlayNoCheck': '{target}, part {app}: overlay not checked yet',
    'cli.doctorOverlayNoCheckNext': 'caw overlay check --env {target}',
    'cli.doctorMarkOk': 'OK        ',
    'cli.doctorMarkInfo': 'INFO      ',
    'cli.doctorMarkOptional': 'OPTIONAL  ',
    'cli.doctorMarkMissing': 'MISSING   ',
    'cli.doctorSummary': ({ ok, blocking, optional }) => `${ok} OK, ${blocking} missing, ${optional} optional open`,
    'cli.doctorReadyFirst': 'Ready. Next step: record the first test, caw record <test> --env <env>.',
    'cli.doctorReady': 'Ready for caw run.',
    'cli.doctorFixFirst': '{summary}. Fix the MISSING ones first.',

    // explore.mjs
    'cli.exploreWhyState': 'state on html/body, the same for every account',
    'cli.exploreWhyLogout': 'sign-out only exists when signed in',
    'cli.exploreWhyAccount': 'user or account area, only there after sign-in',
    'cli.exploreWhyLandmark': 'named navigation, on every page of the signed-in app',
    'cli.exploreWhyFresh': 'only there after sign-in',
    'cli.exploreHttp': '{host} without https: the config only allows http on your own machine (localhost, 127.0.0.1, *.localhost). Use the https address.',
    'cli.exploreWhyRuntime': 'detected at runtime',
    'cli.exploreWhyNeutral': 'no framework detected, neutral adapter',
    'cli.exploreWhyPackage': 'from package.json',
    'cli.exploreMismatch': 'Runtime shows {runtime}, package.json {detected}.',
    'cli.exploreReads': 'Write requests seen: {requests}. If one of them only reads (e.g. a search sent as POST), add it to reads in caw.config.json; otherwise tests that use it count as writing.',
    'cli.exploreForeign': 'The sign-in went to {hosts}, but no page there had user name and password fields caw can fill. For SSO: signIn type session, save the session once with caw role login; {hosts} goes into allowHosts.',
    'cli.exploreIdpSteps': 'The sign-in runs on {hosts}: steps fill the user name and password there, and {hosts} goes into allowHosts. Check the steps before the first run.',
    'cli.exploreNoFieldSelector': 'No unique selector found for name or password; a data-testid on the fields helps.',
    'cli.exploreNoSignedIn': 'No new element with a stable selector appeared after sign-in; please set signedInSelector by hand.',
    'cli.exploreNoLogin': 'No login form seen. If the app does need a sign-in, run explore again and sign in.',
    'cli.exploreConsole': 'Console errors already appeared on opening. Only take what is known noise, otherwise it hides errors.',
    'cli.exploreAskLogin': 'Does the app need a sign-in?',
    'cli.exploreOpening': 'Chrome opening {host}',
    'cli.exploreOpened': 'Chrome open on {host}',
    'cli.exploreStepSignIn': 'Sign in',
    'cli.exploreSignIn': 'Sign in with a test account in the Chrome window.',
    'cli.exploreWaitingSignIn': 'Waiting for sign-in',
    'cli.exploreSignedInDone': 'Signed in',
    'cli.exploreSignInSkipped': 'Sign-in skipped',
    'cli.exploreStepStart': 'Start page',
    'cli.exploreGoStart': 'Go to the page where tests should start and click "Done" at the bottom right.',
    'cli.exploreWaitingDone': 'Waiting for "Done" in the window',
    'cli.exploreStartChosen': 'Start page chosen',
    'cli.exploreCardWait': 'Page loading',
    'cli.exploreCardSignIn': "Sign in with a test account. I'll notice when you're in.",
    'cli.exploreCardStart': 'Go to the page where tests should start.',
    'cli.exploreCardReading': 'Reading the page',
    'cli.exploreCardDone': 'Saved. The window closes in a moment.',
    'cli.exploreCardPage': 'PAGE',
    'cli.exploreCardSaved': 'Saved',
    'cli.exploreDoneButton': 'Done',
    'cli.exploreClosed': 'Window closed, cancelled',
    'cli.exploreReading': 'Reading the page twice (only stable parts count)',
    'cli.exploreRead': 'Page read',
    'cli.exploreStepResult': 'Result',
    'cli.exploreFoundFramework': 'Framework: {framework}',
    'cli.exploreFoundNoLogin': 'No sign-in',
    'cli.exploreFoundLogin': 'Sign-in: {type}',
    'cli.exploreFoundSignedIn': 'Signed in recognised by {selector} ({why})',
    'cli.exploreFoundStart': 'Start page: {path}',
    'cli.exploreSavedTo': 'Saved to {file}',
    'cli.exploreLoginNotFound': 'You said there\'s a sign-in, but I saw no sign-in form. Check auth in the config.',
    'cli.yesNoDefaultYes': '[Y/n]',
    'cli.yesNoDefaultNo': '[y/N]',
    'cli.exploreUsage': 'Usage: caw init --explore-only --url <address>, e.g. --url http://app.localhost:5173',
    'cli.exploreNeedsTty': 'explore needs a terminal to ask about sign-in. Without a terminal: --yes.',
    'cli.exploreUnreachable': "{url} doesn't respond. Is the dev server running, is the address right?",
    'cli.exploreNext': 'Next: npx caw init takes over {file}. Fill in what stays TODO in caw.config.json.',

    // ui.mjs
    'cli.uiOn': 'on',
    'cli.uiLocal': 'local build',
    'cli.uiDeployed': 'deployed',
    'cli.uiCode': 'Code: {code}',
    'cli.code.deployed': 'deployed',
    'cli.code.devServer': 'dev server {host}, your current version',
    'cli.code.overlay': 'overlay, {details}',
    'cli.code.build': 'build {dir}',
    'cli.code.built': 'build {dir}, built {time}, {ago}',
    'cli.code.dev': 'dev server {url}',
    'cli.code.watch': 'Sencha watch {url}',
    'cli.code.files': '{count} fixed file(s) from statics',
    'cli.code.withStatics': '{text}, plus {count} from statics',
    'cli.code.ofPart': '{text} (part {part})',
    'cli.code.skipped': 'part {part} deployed (no source)',
    'cli.code.agoNow': 'just now',
    'cli.code.agoMinutes': '{count} min ago',
    'cli.code.agoHours': '{count} h ago',
    'cli.code.agoDays': '{count} days ago',
    'cli.uiMaxActions': 'up to {count} browser actions',
    'cli.uiLanguage': 'team language {language}',
    'cli.uiWarnings': '{count} warning(s) in the report.',
    'cli.uiReport': 'Report:',
    'cli.uiMoreFailures': 'and {count} more in the report',
    'cli.uiAs': 'as',
    'cli.uiRun': 'Run',
    'cli.uiNotReached': 'not reached',
    'cli.uiStatus.pass': 'Passed.',
    'cli.uiStatus.fail': 'Failed.',
    'cli.uiStatus.error': 'Error.',
    'cli.uiStepsPassed': ({ passed, total }) => `${passed} of ${total} ${total === 1 ? 'step' : 'steps'} passed.`,
    'cli.uiWarningCount': ({ count }) => `${count} ${count === 1 ? 'warning' : 'warnings'}`,
    'cli.uiReportLabel': 'report',
    'cli.uiNextLabel': 'next',
    'cli.roleSynopsis': 'Usage: caw role [list [--json] | add <role> | remove <role> | login <role> --env <name>]',
    'cli.roleUnknownArg': 'role doesn\'t know {arg}. Allowed: --env, --json',
    'cli.envFileHead': '# Test users for caw. Never commit this file.',
    'cli.testUserRoleBad': 'Role "{role}": lowercase letters, digits and hyphens, starting with a letter, at most 32 characters.',
    'cli.roleGitignore': '{file} added to .gitignore.',
    'cli.roleUnknown': 'Unknown role {role}. Known: {roles}',
    'cli.roleInUse': 'Role {role} is still used by: {tests}',
    'cli.roleNone': 'No roles yet. caw role add <role>',
    'cli.roleStateMissing': 'not in the config',
    'cli.roleStateSet': 'test user set',
    'cli.roleStateNoUser': 'no test user',
    'cli.roleStateNoPassword': 'no password needed',
    'cli.roleStateSession': 'session saved',
    'cli.roleStateNoSession': 'no session',
    'cli.roleAddHint': 'Add the role: caw role add {role}',
    'cli.roleLoginHint': 'Save a session: caw role login {role} --env {target}',
    'cli.roleRemoved': 'Role {role} removed from the config.',
    'cli.roleLeftInEnv': '{file} still has {names}; delete those lines yourself if you no longer need them.',
    'cli.roleFillIn': 'Put the test user into {file} yourself (or set CI secrets): {names}. caw never asks for the values; the names are also in caw/.env.example.',
    'cli.roleKnown': 'Role {role} is already in the config.',
    'cli.roleAdded': 'Role {role} added to the config.',
    'cli.roleFillHint': 'Test user for {role} on {target}: put {names} into caw/.env yourself (or set them as CI secrets).',
    // audit.mjs and git.mjs: caw audit <ref>
    'cli.help.audit': `  audit <ref> [--json]                   What changed in the tests since the branch left <ref> (e.g. origin/main): lists
                                         every weakening (a check changed while its expected result stayed, a test or
                                         step removed, retries, timeouts, ignored errors …) as Markdown for the PR.
                                         Exit 0 nothing weakened, 1 weakened, 3 unknown ref or no Git`,
    'cli.synopsis.audit': 'caw audit <ref> [--json]',
    'cli.audit.refMissing': 'Name the branch or commit to compare with, e.g. caw audit origin/main.',
    'cli.audit.unknownArg': 'Unknown argument for audit: {arg}',
    'cli.audit.gitMissing': 'git was not found. caw audit needs Git on the PATH.',
    'cli.audit.notRepository': '{root} is not in a Git repository; caw audit compares commits.',
    'cli.audit.badRef': 'Git does not know {ref}. In CI fetch it first, e.g. git fetch origin main (with fetch-depth: 0).',
    'cli.audit.noBase': '{ref} and HEAD have no common history. In CI fetch the whole history (fetch-depth: 0).',
    'cli.audit.title': 'caw audit: tests compared with {ref} (merge base {base})',
    'cli.audit.unchanged': 'No test, recording or config changed.',
    'cli.audit.ok': 'Nothing weakened.',
    'cli.audit.weakened': ({ count }) => (count === 1
        ? '1 change lets a test pass that would have failed before. Check that it is intended; to change a check on purpose, change the step\'s expected result.'
        : `${count} changes let tests pass that would have failed before. Check that they are intended; to change a check on purpose, change the step's expected result.`),
    'cli.audit.section.weakening': 'Weakened',
    'cli.audit.section.listed': 'Changed',
    'cli.audit.section.info': 'For information',
    'cli.audit.before': 'before',
    'cli.audit.after': 'now',
    'cli.audit.kind.test-removed': 'The test was removed.',
    'cli.audit.kind.test-added': 'New test.',
    'cli.audit.kind.unreadable': '{path} cannot be read, so it was not compared; caw validate shows why.',
    'cli.audit.kind.step-removed': '{step} was removed: nothing checks "{expect}" any more.',
    'cli.audit.kind.step-added': 'New step {step}: "{expect}".',
    'cli.audit.kind.check-changed': 'The check of {step} changed although its expected result "{expect}" stayed the same.',
    'cli.audit.kind.expect-changed': 'The expected result of {step} changed from "{was}" to "{expect}".',
    'cli.audit.kind.expect-changed-check': 'The expected result of {step} changed from "{was}" to "{expect}", and with it the check.',
    'cli.audit.kind.environments-narrowed': 'The test no longer runs on {list}.',
    'cli.audit.kind.known-messages-added': 'Messages now accepted as known: {list}.',
    'cli.audit.kind.retry-added': '{step} is now retried, up to {times} times.',
    'cli.audit.kind.retry-raised': '{step} is retried up to {times} times instead of {was}.',
    'cli.audit.kind.timeout-raised': 'The check of {step} waits up to {now} instead of {was}.',
    'cli.audit.kind.action-timeout-raised': 'Action {number} of {step} ({action}) waits up to {now} instead of {was}.',
    'cli.audit.kind.action-optional': 'Action {number} of {step} ({action}) is now optional: the step goes on when its target is missing.',
    'cli.audit.kind.effects-forgotten': 'The learned effects of {step} were dropped: until they are learned again, a page that behaves differently does not fail the step.',
    'cli.audit.kind.effects-dropped': 'Learned effects of {step} that fail the step were dropped: {lines}.',
    'cli.audit.kind.effects-accepted': 'Console errors of {step} are now learned and no longer fail it: {lines}.',
    'cli.audit.kind.effects-pruned': 'Learned effects of {step} that only warn were dropped: {lines}.',
    'cli.audit.kind.baselines-changed': 'The request baselines of {step} changed.',
    'cli.audit.kind.config-console-ignore': 'consoleIgnore ignores more console errors: {list}.',
    'cli.audit.kind.config-foreign-code': 'foreignCode turns errors of more scripts into warnings: {list}.',
    'cli.audit.kind.config-reads': 'reads counts more requests as reading (they pass on production): {list}.',
    'cli.audit.kind.config-message-selectors': 'messageSelectors no longer watches: {list}.',
    'cli.audit.kind.config-effects-fail': 'effects.fail no longer fails a step for: {list}.',
    'cli.audit.kind.config-guarded': 'Guarded settings changed (commands caw runs, what may run where): {list}.',
    'cli.summaryWritten': 'Summary: {file}',
    'cli.jsonWritten': 'JSON report: {file}',
    'cli.modeUrl': 'Address from {variable}: {url}.',
    'cli.retryEnv': '{test}: attempt {attempt} failed on the environment, running it again.',
    'cli.retriedPass': 'passed on attempt {attempt} (environment)',
    'cli.retriedOther': 'on attempt {attempt}, after failures on the environment',
    'cli.attemptLine': 'Attempt {attempt}: {status}{why}',
    'cli.summary.heading': 'caw: {count} test(s) on {target}, exit {exit}',
    'cli.summary.columns': 'Result | Test | Failed step | Assessment | Finding | Report',
    // bisect.mjs: caw bisect <test> --env <name> for git bisect run
    'cli.help.bisect': `  bisect <test> --env <name>             One step of git bisect run: starts the environment with its start command, plays
                                         the test headless as it is in --tests-from, without chat and without learning
      [--tests-from <ref>]               Where test, recording and caw.config.json come from, default refs/bisect/bad
      [--step-timeout <duration>]        Time limit per step, default 30s
                                         Exit 0 good, 1 bad (a step failed on the app), 125 skip (environment, test,
                                         unclear, error), 128 stops the bisect (call, test or environment not usable)`,
    'cli.synopsis.bisect': 'caw bisect <test> --env <name> [--tests-from <ref>] [--step-timeout <duration>]',
    'cli.bisect.envMissing': 'Name the environment: caw bisect <test> --env <name>. Its start command builds every commit fresh.',
    'cli.bisect.noBisect': '{ref} does not exist: run caw bisect from git bisect run (after git bisect start <bad> <good>), or name the commit with the tests to use with --tests-from <ref>.',
    'cli.bisect.missingAtRef': '{path} is not in the commit of --tests-from.',
    'cli.bisect.noStart': '{env} has no start command: caw bisect starts the environment on every commit so it runs that commit\'s code. Give it environments.{env}.start in caw.config.json.',
    'cli.bisect.alreadyRunning': '{env} already answers at {url} before caw started it: that could be any commit\'s build. Stop it, then run git bisect run again.',
    'cli.bisect.line': 'caw bisect {commit}: {result}, assessment {side}, exit {exit} ({meaning})',
    'cli.bisect.result.pass': 'passed',
    'cli.bisect.result.failed': 'failed',
    'cli.bisect.result.failedAt': 'failed at {step}',
    'cli.bisect.result.error': 'no verdict ({code})',
    'cli.bisect.result.notRun': 'not run ({code})',
    'cli.bisect.meaning.good': 'good',
    'cli.bisect.meaning.bad': 'bad',
    'cli.bisect.meaning.skip': 'skip',
    'cli.bisect.meaning.abort': 'git bisect stops',
    'cli.audit.kind.locator-changed': 'Action {number} of {step} uses another element, its check stayed: {was} → {now}.',
    'cli.listDrafts': 'Drafts in {dir} (not in run --all until promoted):',
    'cli.listDraftRed': 'red at {step} (run {run})',
    'cli.listDraftNotRed': 'recorded, not red yet',
    'cli.validateDrafts': '{count} draft(s) in {dir} checked as well.',
    'cli.draftGreen': 'The draft passes now, also {step}: the bug is fixed. Promote it once the other tests pass too: caw run {test} --promote --env {target}',
    'cli.promoteNoDraft': 'There is no draft {test} in {dir}. --promote moves a draft from caw reproduce to caw/tests.',
    'cli.promoteExists': '{file} exists already. Rename the draft or the test; --promote never overwrites a test.',
    'cli.promoteNotRecorded': '{test} is not fully recorded: record it first with caw record {test}. Nothing promoted.',
    'cli.promoteNotRed': '{test} was never shown red: without the red run there is no proof the test catches the bug. Record it while the bug is there: caw record {test}. Nothing promoted.',
    'cli.promoteDraftFailed': '{test} does not pass yet ({step} is the step that catches the bug). Nothing promoted.',
    'cli.promoteOthersFailed': 'Not every other test on {target} passed. {test} stays a draft until they do.',
    'cli.promoted': '{test} promoted: {files}. Fix report: {report}',
    'cli.fixReport.title': 'Fix report: {test}',
    'cli.fixReport.red': 'Red at {step}: run {run}, commit {head}',
    'cli.fixReport.green': 'Green: run {run}',
    'cli.fixReport.others': '{count} other test(s) on {target} green',
    'cli.fixReport.changed': 'Changed files since {head} (without caw/ and .caw/)',
    'cli.fixReport.changedNone': 'None.',
    'cli.fixReport.changedUnknown': 'Unknown: no commit was recorded with the red run, or git could not tell.',
    'cli.changedLooks': 'look {ids}',
    'cli.audit.kind.look-adopted': 'A person adopted a new look for {step} on {day}: its styles count from now on, its image is learned anew by the next headless runs.',
    'cli.audit.kind.look-on': '{step} now learns and compares its look (look: true).',
    'cli.audit.kind.look-off': '{step} no longer compares its learned look (look: true removed): a step that looks different no longer fails.',
};
