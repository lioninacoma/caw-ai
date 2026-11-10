// Texte: cli (en). Schluessel mit Praefix "cli.".
export default {
    // bin/caw-ai.mjs und help.mjs: Hilfe, je Befehl ein Block. caw-ai --help zeigt alle Bloecke, caw-ai <befehl> --help nur seinen.
    'cli.help.intro': `caw-ai - AI-driven integration tests for web apps (Constrained Agentic Webtester)

Getting started (in the project folder, with the app running):
  1. npx caw-ai init --url http://localhost:5173      sign in in the window, Enter: creates caw.config.json, caw/.env.example
                                                      and the skill; fill in anything left TODO yourself
  2. copy caw/.env.example to caw/.env and enter the credentials of a test account
  3. npx caw-ai doctor                                until nothing is MISSING
  4. describe a test (see Test plan), then record <test>, then run <test>

Test plan caw/tests/<test>.yaml (one action and exactly one checkable result per step):
  id: order-list
  app: web                 # a name from apps in caw.config.json
  role: admin              # a name from roles
  targets: [local]         # environments from environments
  mutates: false           # true if the test creates or changes data
  steps:
    - id: S1
      name: List open
      do: Open "Orders" in the navigation.
      expect: The list "Orders" is visible.
  record writes the recording to caw/recordings/; you only edit the test plan by hand.

On the host (in the project folder):`,
    'cli.help.skill': `  skill                                  Create or update only the Claude Code skill (and .mcp.json); then
                                         Claude Code sets up caw-ai with you ("Set up caw-ai")`,
    'cli.help.explore': `  explore --url <address>                Open the app once, you sign in; suggests framework, login, signed-in
                                         marker, start page and messages (caw/.explore.json), writes no config
      [--yes]                            no sign-in, no questions, just look at the page
      [--insecure-tls]                   accept self-signed certificates (local environments only)`,
    'cli.help.init': `  init [--url <address>]                 Set up: looks at the app (you sign in in the window), creates config, skill
                                         and .mcp.json; without --url it asks for the address
      [--yes]                            without sign-in and without questions
      [--from <file>]                    take an existing explore result
      [--no-mcp]                         no entry in .mcp.json
      [--offline]                        don't look at the app: template with TODO for the sign-in (also without
                                         terminal and --url)`,
    'cli.help.validate': '  validate                               Check config and tests, without browser or Claude',
    'cli.help.list': `  list [<test>]                          Tests with targets, recording status (recorded, stale, not recorded) and whether
                                         they write; with <test> one line per step`,
    'cli.help.doctor': `  doctor [--agent local|docker|session]  Check Node, Chrome, Claude Code (local) or Docker and token (docker),
                                         credentials and environments, with next step`,
    'cli.help.auth': `  auth <role> --target <env>             With auth.type storageState: sign in once by hand (e.g. SSO), the
                                         session goes to caw/.auth/<env>/<role>.json`,
    'cli.help.version': '  --version                              Package version',
    'cli.help.mcp': `  mcp                                    Tools for your Claude Code session (add to .mcp.json): start runs,
                                         work as agent (--agent session), read the selected element`,
    'cli.help.run': `  run <test> [--target <env>]            Run the test by plan, without Claude. On environments where Claude may
                                         work{here}, the chat sits alongside: if a step fails, sort it out there with
                                         Claude
      [--until <S4>]                     Stop after S4, the window stays open (implies --handover; local build where the
                                         environment allows it)
      [--code local|deployed]            Which code runs: local build or deployed; default from test and config
      [--handover]                       Keep the Chrome window open after the run and hand it to you
      [--advise]                         On errors or warnings Claude offers advice unasked, costs tokens; only on
                                         environments where Claude may work
      [--no-chat]                        No chat and no Claude, like in CI
      [--headless]                       No window and no chat
      [--no-learn]                       With chat, but learns no baselines: the test file only changes if you adopt
                                         something in the chat
      [--step-timeout <seconds>]         Time limit per step, default 30
      [--timeout <minutes>]              Time limit for Claude when clarifying and fixing, default 60
      [--max-steps <n>]                  Limit on Claude's actions when fixing, else maxSteps from the config, else 100
      [--agent local|docker|session]     Where Claude works; default from agent.sandbox in the config (local). session:
                                         your Claude Code session takes over via caw-ai mcp, caw starts no Claude
  run <test> <test> … | --all            Several tests in a row, for CI: no chat, a table at the end, exit code of the
      [--target <env>]                   worst run. --all takes every test that lists the target
      [--headless]                       No window
      [--report junit=<file>]            Also write the result as JUnit XML`,
    'cli.help.record': `  record <test> [--target <env>]         Record or replace a test plan, always with chat; only on environments where
                                         Claude may work{here}
      [--role <role> --app <app>]        First time only; not needed if the config has just one
      [--also <app>]                     First time only: the flow leads into another app of the project
      [--read-only]                      First time only: the test doesn't write (mutates: false); if it does, it's
                                         marked as writing
      [--timeout <minutes>]              Time limit for Claude, default 60
      [--agent local|docker|session]     as for run
      [--code local|deployed]            as for run; deployed is kept in a new test (code: deployed)
      [--max-steps <n>]                  Limit on Claude's actions, else maxSteps from the config, else 100
      [--step-timeout <seconds>]         Time limit per step in the check run, default 30`,
    'cli.help.fix': `  fix <test> <S4> [--target <env>]       Change exactly this step, always with chat; only on environments where Claude
                                         may work{here}
      [--timeout <minutes>] [--max-steps <n>] [--step-timeout <seconds>] [--agent local|docker|session]
      [--code local|deployed]`,
    'cli.help.here': ' (here: {names})',
    'cli.help.footer': `<env>: a name from environments, e.g. local; with sites tenant/env, e.g. nord/dev. Without --target caw-ai takes the
test's only target (for record of a new test the only environment where Claude may work).

Help on one command: caw-ai <command> --help. Commands for the agent: caw-ai help agent.

Exit codes: 0 pass, 1 fail, 2 error (environment), 3 input rejected, 4 needs recording (record or fix).`,
    'cli.help.agent': `For the agent (sandbox, local, or your session with --agent session), drives the browser:
  task                                   Show the task of the open run
  snapshot                               Page structure with references (e1, e2, ...)
  url                                    Current URL
  click <target>                         Target: reference or selector
  fill <target> <text>                   Set a field
  type <target> <text>                   Type character by character
  press <key>                            Press a key, e.g. Enter
  eval <expression>                      Evaluate JavaScript in the page
  check <S1> <expression>                Check a step: the expression must return exactly true
  screenshot <name.png>                  Save a screenshot in the agent folder
  goto <url>                             Navigate to an allowed host
  reload                                 Reload the page
  wait-ready [--store <id>] [--min-count <n>] [--timeout <ms>]
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
    // Die Kurzform je Befehl, unter einem Aufruffehler.
    'cli.synopsis.init': 'caw-ai init [--url <address>] [--yes] [--from <file>] [--no-mcp] [--offline]',
    'cli.synopsis.explore': 'caw-ai explore --url <address> [--yes] [--insecure-tls]',
    'cli.synopsis.list': 'caw-ai list [<test>]',
    'cli.synopsis.doctor': 'caw-ai doctor [--agent local|docker|session]',
    'cli.synopsis.auth': 'caw-ai auth <role> --target <env>',
    'cli.synopsis.run': 'caw-ai run <test> [--target <env>]  or  caw-ai run <test> <test> … | --all [--target <env>]',
    'cli.synopsis.record': 'caw-ai record <test> [--target <env>] [--role <role>] [--app <app>]',
    'cli.synopsis.fix': 'caw-ai fix <test> <S4> [--target <env>]',
    'cli.usageLine': 'Usage: {synopsis}',
    'cli.errorCode': '(code: {code}, exit {exit})',
    'cli.fromUnreadable': "Can't read {from}: {message}",
    'cli.doctorUnknownArg': "doctor doesn't know {arg}. Allowed: --agent local|docker|session",
    'cli.doctorAgentValue': '--agent expects local, docker or session.',
    'cli.mcpAgentOnly': 'mcp-agent only starts for the agent of a run.',
    'cli.unknownCommand': 'Unknown command: {command}.{suggestion} See caw-ai --help.',
    'cli.didYouMean': ' Did you mean {name}?',

    // commands.mjs: explore-Datei, Config, Skill, init
    'cli.notExploreResult': "This file doesn't look like a caw-ai explore result.",
    'cli.unknownFramework': 'caw-ai doesn\'t know framework "{framework}" ({names}).',
    'cli.initAuthUnknown': 'init has no login type "{auth}" (form, storageState, none).',
    'cli.badRoleName': 'Role "{name}": lowercase letters, digits and hyphens only, starting with a letter (e.g. admin, clerk).',
    'cli.mcpInvalid': '.mcp.json is not valid JSON, please add the caw-ai entry by hand (see README).',
    'cli.skillCreated': 'Created: {file}',
    'cli.skillCurrent': 'Skill is up to date',
    'cli.skillUpdated': 'Updated: {file}',
    'cli.skillNext': 'Next, in Claude Code: "Set up caw-ai". The skill walks you through explore, init and doctor.',
    'cli.initCreated': 'Created: {files}',
    'cli.initAlready': 'Already set up.',
    'cli.initNeedsUrl': 'Usage: npx caw-ai init --url <address>. init looks at the app first; you sign in in the window.',
    'cli.initUsesExplore': 'Using the suggestions from {file}.',
    'cli.envExampleHead': '# Copy to caw/.env (gitignored) and enter test accounts with few rights.\n# The agent cannot see this file but drives a signed-in browser: do not use personal accounts.',
    'cli.initTodo': 'Still to fill in caw.config.json: {keys} (explore did not find them, see notes in caw/.explore.json).',
    'cli.initTodoOffline': 'Still to fill in caw.config.json: {keys}. caw-ai explore --url <address> finds the selectors once the app is running.',
    'cli.doctorTodo': '{keys} is still TODO',
    'cli.doctorTodoNext': 'Enter the selector in caw.config.json, e.g. from the source of the sign-in page.',
    'cli.initNext': 'Next: caw-ai doctor, then record the first test: caw-ai record <test> --target {target}.',
    'cli.initNextExplore': ' No fitting selectors yet? Run caw-ai explore --url <address> first.',
    'cli.initOfflineFallback': 'No terminal and no --url: init writes the template, the sign-in stays TODO. Later: caw-ai explore --url <address>.',
    'cli.contextTemplate': '# Notes for Claude\n\nWhat Claude should know in every test but can\'t see in the code. No personal data.\n\n- Example: The search remembers the last input. Click "Clear filter" first.\n',

    // commands.mjs: Dialog von init
    'cli.askUrl': 'Address of the local environment',
    'cli.askUrlProtocol': 'Please enter an address with http:// or https://.',
    'cli.askUrlInvalid': "That's not an address, e.g. http://localhost:5173.",
    'cli.askRoles': 'Roles, comma-separated',
    'cli.askRolesBad': '"{name}": lowercase letters, digits and hyphens only, e.g. admin, clerk.',

    // commands.mjs: auth
    'cli.authUsage': 'Usage: caw-ai auth <role> --target <env>',
    'cli.authStorageOnly': 'caw-ai auth only works with auth.type storageState; here it is {type}.',
    'cli.authNeedsSelector': 'caw-ai auth needs auth.signedInSelector: that\'s how it knows the sign-in is done.',
    'cli.authRoleUnknown': 'Role {role} is not in roles ({roles}).',
    'cli.targetProduction': '{target} is production.',
    'cli.authSignIn': 'Sign in as {role} in the Chrome window. As soon as {selector} appears, caw-ai saves the session.',
    'cli.authClosed': 'Window closed, nothing saved.',
    'cli.authSaved': "Saved: {file}. The file holds login cookies and doesn't belong in the repository.",

    // commands.mjs: validate
    'cli.validateChain': '{file}: {chain}, record again.',
    'cli.validateNotRecorded': '{file}: not recorded yet.',
    'cli.validateOk': '{config} and {count} test(s) are valid.',
    'cli.validateCode': '{id} ({target}): {code}',
    'cli.validateCodeDeployed': '{file}: code: deployed, but app {app} now has local code. Without code it tests the local build on environments with localCode.',
    'cli.validateTodo': '{key} is still TODO: {what}',
    'cli.validateTodo.path': 'enter the path of the sign-in page, e.g. "/login"',
    'cli.validateTodo.userSelector': 'enter the CSS selector of the user name field',
    'cli.validateTodo.passwordSelector': 'enter the CSS selector of the password field',
    'cli.validateTodo.submitSelector': 'enter the CSS selector of the sign-in button or remove the field (then Enter submits)',
    'cli.validateTodo.codeSelector': 'enter the CSS selector of the one-time code field',
    'cli.validateTodo.signedInSelector': 'enter a CSS selector that only exists when signed in, e.g. the user menu',

    // commands.mjs: list
    'cli.listNone': 'No tests in {dir} yet. Record the first with caw-ai record <test>.',
    'cli.listHead': 'Test|Targets|Recording|Data',
    'cli.listRecorded': 'recorded',
    'cli.listStale': 'stale ({ids})',
    'cli.listNotRecorded': 'not recorded',
    'cli.listInvalid': 'invalid',
    'cli.listWrites': 'writes',
    'cli.listReadOnly': 'read-only',
    'cli.listStepRecorded': 'recorded',
    'cli.listStepStale': 'stale',
    'cli.listStepNotRecorded': 'not recorded',
    'cli.listTestHead': '{test}: {app}, role {role}, targets {targets}, {mutates}',
    'cli.knownTests': 'Known tests: {tests}.',
    'cli.noTests': 'There are no tests in caw/tests yet.',
    'cli.knownSteps': 'Steps: {steps}.',

    // commands.mjs: Sandbox, Lauf, Aufnahme, Beheben
    'cli.imageBuilding': 'Building the sandbox image (only on the first run and after tool changes) ...',
    'cli.imageBuildFailed': "Couldn't build the sandbox image (exit {code}). Missing registry login for {image}?",
    'cli.noWatch': 'no {label} running',
    'cli.noWatchLocal': 'No {label} running; with --code local the local version runs anyway: it may be outdated.',
    'cli.testMissing': 'Test not found: {file}.{suggestion} {known} Record it: {hint}',
    'cli.targetChosen': 'Target: {target} ({why})',
    'cli.targetWhyTest': 'only target of {test}',
    'cli.targetWhyTestAgent': 'only target of {test} where Claude may work',
    'cli.targetWhyAgent': 'only environment where Claude may work',
    'cli.targetWhyTests': 'only target of the tests',
    'cli.noEnvironment': 'no environment',
    'cli.verbRecord': 'Recording',
    'cli.verbFix': 'Fixing',
    'cli.agentOnly': '{verb} needs environments.{environment}.claude: true (currently only: {environments}).',
    'cli.agentNotInCi': "--agent {agent} doesn't work in CI (variable CI set), there Claude runs in Docker only.",
    'cli.sessionAgent': 'Claude works in your Claude Code session: tell it "take over the caw run". It finds the run via the caw tool (caw-ai mcp) or caw-ai <command>.',
    'cli.sessionLabel': 'your Claude Code session',
    'cli.localAgent': 'Claude runs locally without Docker, with read access and the browser tool only (Claude Code {version}). Isolated: agent.sandbox "docker".',
    'cli.usingDocker': 'Using {label}.',
    'cli.tokenMissing': '{hint} Create one e.g. with claude setup-token.',
    'cli.and': ' and ',
    'cli.draftMissing': 'The new test {id} needs {missing}. Usage: {hint}',
    'cli.unknownApp': 'Unknown app: {name} (apps in {config}: {apps})',
    'cli.choiceShow': 'Show it myself',
    'cli.choiceFollow': 'Claude follows the test plan',
    'cli.choiceReuse': 'Use last demo ({time}, {count} entries)',
    'cli.recordAborted': 'Recording was cancelled.',
    'cli.questionNew': 'How should {id} be created?',
    'cli.questionRecorded': "{id} is already recorded. The recording is only replaced if you agree at the end. How should the new one be created?",
    'cli.questionDescribed': '{id} is described but not recorded yet. Will you show it, or should Claude follow the test plan?',
    'cli.demoNote': 'Only show test data: your input goes to Claude and ends up in the recording. Passwords are never captured.',
    'cli.demoRecorded': 'Recorded: {line}',
    'cli.demoFailure': "{label}. It's at this point in the recording.",
    'cli.demoNothingFollow': 'Nothing shown: Claude follows the test plan.',
    'cli.demoNothing': 'Nothing shown yet. Click through the flow in the app, then "Finish demo".',
    'cli.modeNoAgent': 'Mode: no chat, Claude may only work on {environments}. The test file stays unchanged.',
    'cli.modeHeadless': 'Mode: no window and no chat (--headless). The test file stays unchanged.',
    'cli.modeNoChat': 'Mode: no chat (--no-chat). The test file stays unchanged.',
    'cli.modeCi': 'Mode: no chat, because the variable CI is set. The test file stays unchanged.',
    'cli.modeChat': 'Mode: with chat{advice}. The run learns missing baselines in {file} (turn off with --no-learn).',
    'cli.modeChatNoLearn': 'Mode: with chat{advice}, no learning (--no-learn). The test file only changes if you adopt something in the chat.',
    'cli.modeAdvice': ' and advice from Claude (--advise, costs tokens)',
    'cli.changed': 'Changed: {files}',
    'cli.changedWhat': '{file} ({what})',
    'cli.changedBaselines': 'baselines {ids}',
    'cli.changedEffects': 'effects {ids}',
    'cli.changedSteps': 'steps {ids}',
    'cli.changedPlan': 'test plan',
    'cli.unchanged': 'Test file unchanged.',
    'cli.batchStart': '{count} test(s) on {target}, one after another and without chat{headless}.',
    'cli.batchWindow': ' (no window with --headless)',
    'cli.batchNone': 'No test lists {target} in targets.',
    'cli.batchHeading': ({ count, target }) => `Result: ${count} ${count === 1 ? 'test' : 'tests'} on ${target}`,
    'cli.batchStatus.pass': 'PASS',
    'cli.batchStatus.fail': 'FAIL',
    'cli.batchStatus.error': 'ERROR',
    'cli.batchStatus.rejected': 'REJECTED',
    'cli.batchStatus.needsRecording': 'NEEDS RECORDING',
    'cli.batchAt': 'at {step}',
    'cli.junitWritten': 'JUnit report: {file}',
    'cli.stepUnknown': '{test} has no step {step}.{suggestion} {steps}',
    'cli.adviseAgentOnly': '--advise only on environments where Claude may work (here: {environments}), not on {target}.',
    'cli.ciHandover': '{option} hands the browser to a person; in CI (variable CI set) there is none.',
    'cli.ciNeedsHuman': 'caw-ai {command} needs a person in the chat (demonstration, plan, decisions); in CI (variable CI set) there is none.',
    'cli.adviseNeedsChat': "--advise needs the chat; in CI (variable CI set) Claude doesn't advise.",
    'cli.failedHintAgent': '{step} failed. Find the cause: caw-ai run {test} --target {target} in the terminal, the chat shows the assessment and lets Claude investigate. Only if the app changed on purpose: caw-ai fix {test} {step} --target {target}',
    'cli.failedHint': '{step} failed. Find the cause in a run with chat: caw-ai run {test} --target {target}',
    'cli.failedHintNoAgent': '{step} failed. A run with chat finds the cause, on an environment where Claude may work (here: {environments}).',
    'cli.untilHint': 'Up to just before the failure: caw-ai run {test} --target {target} --until {step}',
    'cli.recordExists': 'Test {test} already exists, its metadata stays. --role, --app, --also and --read-only must match the file or be left out.',
    'cli.fixStepUnknown': '{test} has no step {step}.{suggestion} {steps} Add a new step to {file} first.',
    'cli.fixReplayFirst': 'Replaying up to {step} first. If the step fails, the chat finds the cause instead of re-recording.',
    'cli.fixPassed': '{step} passes. Claude now records it again.',

    // doctor.mjs
    'cli.doctorNodeOld': 'Node {version} is too old',
    'cli.doctorNodeNext': 'Install Node {min} or newer.',
    'cli.doctorConfigOk': '{file} is valid',
    'cli.doctorConfigNextValidate': 'caw-ai validate shows all findings.',
    'cli.doctorConfigMissing': '{file} is missing',
    'cli.doctorConfigNextInit': 'caw-ai init creates it.',
    'cli.doctorBrowserOk': 'Browser starts ({browser})',
    'cli.doctorBrowserFail': "Browser doesn't start ({browser}): {error}",
    'cli.doctorBrowserNext': 'Install Google Chrome (Stable), caw-ai uses the system Chrome; or set browser.channel or browser.executablePath in the config.',
    'cli.doctorSessionOk': 'Your Claude Code session takes over (caw-ai entry in .mcp.json)',
    'cli.doctorSessionMissing': 'caw-ai entry in .mcp.json is missing',
    'cli.doctorSessionNext': 'caw-ai skill adds it; then restart Claude Code in the project.',
    'cli.doctorClaudeOk': 'Claude Code {version} (Claude runs locally, without Docker)',
    'cli.doctorClaudeMissing': 'Claude Code (claude) is not in PATH',
    'cli.doctorClaudeNext': 'Only for runs with Claude: install Claude Code and sign in once, or agent.sandbox "docker".',
    'cli.doctorDockerOk': 'Docker: {label}',
    'cli.doctorDockerNext': 'Only needed for record, fix and Claude in the chat: start Docker (Linux containers).',
    'cli.doctorTokenOk': 'CLAUDE_CODE_OAUTH_TOKEN is set',
    'cli.doctorTokenMissing': 'CLAUDE_CODE_OAUTH_TOKEN is missing',
    'cli.doctorTokenNext': 'Only for runs with Claude in Docker: create a token with "claude setup-token" and set it as an environment variable.',
    'cli.doctorIgnoreOk': '.gitignore protects runs, credentials and sessions',
    'cli.doctorIgnoreMissing': '.gitignore is missing: {lines}',
    'cli.doctorIgnoreNext': 'caw-ai init adds the entries.',
    'cli.doctorRoleOk': 'Role {name}: credentials set',
    'cli.doctorRoleMissing': ({ name, missing, count, file }) => `Role ${name}: ${missing} ${count > 1 ? 'are' : 'is'} missing in ${file}`,
    'cli.doctorRoleNext': 'Set as environment variable (CI) or copy {file}.example to {file} and enter a test account.',
    'cli.doctorSessionSaved': 'Role {name} on {target}: session saved',
    'cli.doctorSessionNone': 'Role {name} on {target}: no session',
    'cli.doctorReachOk': '{target}: {url} responds',
    'cli.doctorReachFail': "{target}: {url} doesn't respond",
    'cli.doctorReachNext': 'Check VPN, dev server or the address in environments.',
    'cli.doctorMarkOk': 'OK        ',
    'cli.doctorMarkOptional': 'OPTIONAL  ',
    'cli.doctorMarkMissing': 'MISSING   ',
    'cli.doctorSummary': ({ ok, blocking, optional }) => `${ok} OK, ${blocking} missing, ${optional} optional open`,
    'cli.doctorReadyFirst': 'Ready. Next step: record the first test, caw-ai record <test> --target <env>.',
    'cli.doctorReady': 'Ready for caw-ai run.',
    'cli.doctorFixFirst': '{summary}. Fix the MISSING ones first.',

    // explore.mjs
    'cli.exploreWhyLogout': 'sign-out only exists when signed in',
    'cli.exploreWhyAccount': 'user or account area, only there after sign-in',
    'cli.exploreWhyLandmark': 'named navigation, on every page of the signed-in app',
    'cli.exploreWhyFresh': 'only there after sign-in',
    'cli.exploreHttp': '{host} without https: the config only allows http on your own machine (localhost, 127.0.0.1, *.localhost). Use the https address.',
    'cli.exploreWhyRuntime': 'detected at runtime',
    'cli.exploreWhyNeutral': 'no framework detected, neutral adapter',
    'cli.exploreWhyPackage': 'from package.json',
    'cli.exploreMismatch': 'Runtime shows {runtime}, package.json {detected}.',
    'cli.exploreForeign': 'The sign-in tried to go to {hosts}; the tool blocked it. For SSO: auth.type storageState, save the session once with caw-ai auth; add the sign-in service to extraAllowedHosts if needed.',
    'cli.exploreNoFieldSelector': 'No unique selector found for name or password; a data-testid on the fields helps.',
    'cli.exploreNoSignedIn': 'No new element with a stable selector appeared after sign-in; please set signedInSelector by hand.',
    'cli.exploreNoLogin': 'No login form seen. If the app does need a sign-in, run explore again and sign in.',
    'cli.exploreConsole': 'Console errors already appeared on opening. Only take what is known noise, otherwise it hides errors.',
    'cli.exploreUsage': 'Usage: caw-ai explore --url <address>, e.g. --url http://app.localhost:5173',
    'cli.exploreNeedsTty': 'explore needs a terminal: you sign in in the window and confirm here. Without sign-in: --yes.',
    'cli.exploreUnreachable': "{url} doesn't respond. Is the dev server running, is the address right?",
    'cli.exploreSignIn': 'In the window: sign in with a test account if the app asks for it, and go to the app\'s start page.',
    'cli.explorePressEnter': 'Then press Enter here: ',
    'cli.exploreSaved': 'Suggestions in {file}: framework {framework}, login {auth}{signedIn}.',
    'cli.exploreSignedIn': ', signed in recognizable by {selector}',
    'cli.exploreNext': 'Next: npx caw-ai init takes over {file}. Fill in what stays TODO in caw.config.json.',

    // ui.mjs
    'cli.uiOn': 'on',
    'cli.uiLocal': 'local build',
    'cli.uiDeployed': 'deployed',
    'cli.uiCode': 'Code: {code}',
    'cli.code.deployed': 'deployed',
    'cli.code.deployedWhy': 'deployed ({reason})',
    'cli.code.local': 'local build ({details})',
    'cli.code.localFrom': 'local build from {details}',
    'cli.code.built': '{dir}, built {time}, {ago}',
    'cli.code.entries': '{kinds} in {dir}',
    'cli.code.stale': 'The local build ({dir}) is older than your last change ({file}, {ago}). Is the build watch running? Otherwise --code deployed.',
    'cli.code.agoNow': 'just now',
    'cli.code.agoMinutes': '{count} min ago',
    'cli.code.agoHours': '{count} h ago',
    'cli.code.agoDays': '{count} days ago',
    'cli.uiMaxSteps': 'up to {count} steps',
    'cli.uiWarnings': '{count} warning(s) in the report.',
    'cli.uiReport': 'Report:',
    'cli.uiMoreFailures': 'and {count} more in the report',
    'cli.uiWarningsShort': '! {count} warning(s) in the report',
};
