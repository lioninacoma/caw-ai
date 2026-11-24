// The host commands. init and validate need neither browser code nor Docker.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_DIR, FRAMEWORK_NAMES, TODO, agentMode, browserLaunch, environmentsWith, isLoopback, loadConfig, isStartPath, productionLike, loadConfigWithNotes, navigationHosts, sessionPath, todoFields, urlOverride, urlVariable } from '../shared/config.mjs';
import { credentialNames } from '../shared/credentials.mjs';
import { NAME, blockedHosts, chooseEnvironment, effectiveEnvironment, environmentCandidates, startPath, usesCredentials, usesTotp } from '../shared/environments.mjs';
import { CawError, EXIT, exitOf, worstExit } from '../shared/errors.mjs';
import { inLanguage, language, t, teamLanguage } from '../shared/i18n.mjs';
import { cawCommand } from '../shared/invocation.mjs';
import { CONFIG_FILE, CONTEXT_FILE, DRAFT_DIR, ENV_FILE, PROJECT_DIR, RECORDING_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { closest } from '../shared/suggest.mjs';
import { createUi } from '../shared/ui.mjs';
import { SKILL_PATH, skillState, writeSkill } from './skill.mjs';
import { selectDocker } from './docker.mjs';
import { DEFAULT_MAX_ACTIONS } from './step-budget.mjs';
import { CLAUDE_TIMEOUT_MIN, optionValue, parseRunArgs, toWslPath } from './linux.mjs';
import { EXPLORE_FILE, explore } from './explore.mjs';
import { environmentLifecycle } from './lifecycle.mjs';
import { maskArgs, parseJsonc, projectImage, renderDockerfile, templatePath, toolFingerprint } from './sandbox-config.mjs';
import { describeCode } from './code-source.mjs';
import { ignoreAuthDir, requireTestUser } from './test-users.mjs';
import { ensureMcpEntry } from './mcp-entry.mjs';
import { decide } from './decisions.mjs';
import { promptTerminal } from './decision-prompt.mjs';
import { textMatcher } from './patterns.mjs';
import { projectPath } from './project-path.mjs';
import { aboutRun, descriptionItems, readDescription } from './delta.mjs';
import { changedFiles, changedLines, dirtyFiles, shortHead } from './git.mjs';
import { brokenChain, checkTest, draftIds, draftPath, environmentProblems, isDesignDraft, loadDraft, loadTest, pendingSteps, recordingHints, setStepLooks, staleSteps, testExists, testPath, withDefaults, writeTest } from './test-file.mjs';
import { DESIGN_REPORT, FIX_REPORT, designMet, designOf, deviationsOf, fixState } from './bugfix.mjs';
import { withLearning } from './learning.mjs';

const TOOL_DIR = fileURLToPath(new URL('../../', import.meta.url));
// Only what the container runs. Browser code and devlink stay out.
const TOOL_PARTS = ['bin', 'src/sandbox', 'src/shared', 'package.json'];
const IMAGE_TEMPLATES = ['Dockerfile.tpl', 'init-firewall.sh', 'entrypoint.sh'];
const SANDBOX_USER = 'devuser';
/** Without a project image: Node LTS on Debian. Claude Code only needs Node. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';
const ui = createUi();
// Labels are resolved on use: at import time the language is not set yet.
const SHOW = () => ({ id: 'show', label: t('cli.choiceShow'), primary: true });
const FOLLOW = () => ({ id: 'follow', label: t('cli.choiceFollow') });
const DESCRIBE = () => ({ id: 'describe', label: t('cli.choiceDescribe') });
/** How long a demonstration stays reusable, e.g. when login or Claude failed afterwards. */
const REUSE_MS = 24 * 60 * 60 * 1000;

/** The latest non-empty demonstration of this test, no older than REUSE_MS, otherwise null. */
export const lastDemonstration = (root, id, now = Date.now()) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (!existsSync(runs)) return null;
    const suffix = `-${id}-demonstration`;
    for (const name of readdirSync(runs).filter((entry) => entry.endsWith(suffix)).sort().reverse()) {
        const file = join(runs, name, 'demonstration.json');
        if (!existsSync(file)) continue;
        const at = Date.parse(name.slice(0, -suffix.length).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z'));
        if (!Number.isFinite(at) || now - at > REUSE_MS) return null;
        try {
            const items = JSON.parse(readFileSync(file, 'utf8'));
            if (Array.isArray(items) && items.length > 0) return { items, dir: join(runs, name), at };
        } catch {
            // broken file: try older ones
        }
    }
    return null;
};

/** The framework from a folder's package.json; `web` if none matches. */
const frameworkIn = (dir) => {
    let pkg = {};
    try {
        pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
        pkg = {};
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    if (deps['@angular/core'] !== undefined) return 'angular';
    if (deps.vue !== undefined || deps.nuxt !== undefined) return 'vue';
    if (deps.react !== undefined || deps.next !== undefined) return 'react';
    if (Object.keys(deps).some((name) => name === 'ext' || name.startsWith('@sencha/')) || existsSync(join(dir, 'workspace.json'))) return 'extjs';
    return 'web';
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor']);

const subdirs = (dir) => {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
            .map(({ name }) => name)
            .sort();
    } catch {
        return [];
    }
};

/**
 * Framework and folder of the application. If it is not in the root (repo with backend and `frontend/`, monorepo with `apps/web`),
 * caw-ai looks one or two levels deeper for a package.json with a known framework; with several, the first by name wins.
 */
export const detectApp = (root) => {
    const own = frameworkIn(root);
    if (own !== 'web') return { framework: own, dir: '.' };
    for (const first of subdirs(root)) {
        const framework = frameworkIn(join(root, first));
        if (framework !== 'web') return { framework, dir: first };
    }
    for (const first of subdirs(root)) {
        for (const second of subdirs(join(root, first))) {
            const framework = frameworkIn(join(root, first, second));
            if (framework !== 'web') return { framework, dir: `${first}/${second}` };
        }
    }
    return { framework: 'web', dir: '.' };
};

/** The application's framework, see detectApp. */
export const detectFramework = (root) => detectApp(root).framework;

/**
 * Answers for `init` from the suggestions of `explore` (caw/.explore.json). What explore is unsure about stays at the template default.
 * @returns { framework, url, signIn, login, start, messageSelectors, consoleIgnore, language, allowHosts }
 */
export const answersFromExplore = (suggestion) => {
    if (suggestion === null || typeof suggestion !== 'object' || typeof suggestion.url !== 'string') throw new CawError('usage', t('cli.notExploreResult'));
    const { type, ...login } = suggestion.signIn ?? { type: 'form' };
    delete login.confidence;
    return {
        framework: suggestion.framework?.value,
        url: suggestion.url,
        signIn: type,
        login,
        explored: true,
        ...(suggestion.start === undefined ? {} : { start: suggestion.start }),
        ...(suggestion.messageSelectors === undefined ? {} : { messageSelectors: suggestion.messageSelectors }),
        ...(suggestion.consoleIgnore === undefined ? {} : { consoleIgnore: suggestion.consoleIgnore }),
        ...(typeof suggestion.language === 'string' ? { language: suggestion.language } : {}),
        ...(Array.isArray(suggestion.allowHosts) && suggestion.allowHosts.length > 0 ? { allowHosts: suggestion.allowHosts } : {}),
    };
};

/** Role when none is given. */
const DEFAULT_ROLE = 'tester';
/** A team language as the config takes it: a primary subtag. */
const TEAM_LANGUAGE = /^[a-z]{2,3}$/;

/**
 * The name of the first environment (SC-15): on this machine "local", otherwise the first DNS label (staging.example.com →
 * staging), made a valid environment name.
 */
export const defaultEnvName = (url) => {
    if (url === undefined) return 'local';
    const { hostname } = new URL(url);
    if (isLoopback(hostname)) return 'local';
    const label = hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '');
    return NAME.test(label) ? label : 'app';
};

/** The init flags that are no questions: --env, --language, --insecure-tls, --allow-http, checked up front. */
const initFlags = (args) => {
    const env = optionValue(args, '--env');
    if (env !== undefined && !NAME.test(env)) throw new CawError('usage', t('cli.initEnvBad', { env }));
    const team = optionValue(args, '--language');
    if (team !== undefined && !TEAM_LANGUAGE.test(team)) throw new CawError('usage', t('cli.initLanguageBad', { language: team }));
    return {
        ...(env === undefined ? {} : { env }),
        ...(team === undefined ? {} : { language: team }),
        ...(args.includes('--insecure-tls') ? { insecureTls: true } : {}),
        ...(args.includes('--allow-http') ? { allowHttp: true } : {}),
        ...(args.includes('--no-mcp') ? { mcp: false } : {}),
    };
};
const checkUrl = (value) => {
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol) ? null : t('cli.askUrlProtocol');
    } catch {
        return t('cli.askUrlInvalid');
    }
};
const checkRoles = (value) => {
    const bad = value.split(',').map((name) => name.trim()).find((name) => !/^[a-z][a-z0-9-]*$/.test(name));
    return bad === undefined ? null : t('cli.askRolesBad', { name: bad });
};

/** A terminal question, checked at once; an invalid answer asks again with the reason. One readline per question, since explore reads Enter in between. */
const askLine = async ({ input, output }, question, fallback, check) => {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input, output });
    try {
        for (;;) {
            const answer = (await rl.question(`${question} [${fallback}]: `)).trim() || fallback;
            const problem = check(answer);
            if (problem === null) return answer;
            output.write(`  ${problem}
`);
        }
    } finally {
        rl.close();
    }
};

/**
 * The answers for `init`. explore is required: --from <file>, else an existing caw/.explore.json, else explore runs now,
 * on --url or the address init asks for in the terminal. Without a terminal and without --url init falls back to offline.
 * @returns { answers }, or { code } if explore did not complete (e.g. window closed)
 */
export const initAnswers = async (root, args, { interactive, runExplore = explore, input = process.stdin, output = process.stdout } = {}) => {
    const from = optionValue(args, '--from');
    let url = optionValue(args, '--url');
    let file = from;
    if (url !== undefined && checkUrl(url) !== null) throw new CawError('usage', checkUrl(url));
    const flags = initFlags(args);
    // Without an application: the template with TODO in the login. Also without a terminal and --url, instead of aborting.
    const offline = args.includes('--offline') || (file === undefined && url === undefined && !interactive && !existsSync(join(root, EXPLORE_FILE)));
    if (offline && from === undefined) {
        if (!args.includes('--offline')) ui.info(t('cli.initOfflineFallback'));
        const answers = { ...(url === undefined ? {} : { url }), offline: true, ...flags };
        if (interactive) answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
        if (interactive) await askNaming(answers, { input, output }, flags);
        return { answers };
    }
    if (file === undefined && url === undefined && existsSync(join(root, EXPLORE_FILE))) {
        file = EXPLORE_FILE;
        ui.info(t('cli.initUsesExplore', { file }));
    }
    if (file === undefined) {
        if (url === undefined) {
            url = await askLine({ input, output }, t('cli.askUrl'), 'http://localhost:5173', checkUrl);
        }
        const passed = ['--yes', '--insecure-tls', '--login', '--no-login'].filter((flag) => args.includes(flag));
        const code = await runExplore(root, ['--url', url, ...passed], { next: false });
        if (code !== undefined && code !== EXIT.pass) return { code };
        file = EXPLORE_FILE;
    }
    let suggestion;
    try {
        suggestion = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    } catch (error) {
        throw new CawError('usage', t('cli.fromUnreadable', { from: file, message: error.message }));
    }
    // The flags win over what explore suggested (e.g. --language over the page's <html lang>).
    const answers = { ...answersFromExplore(suggestion), ...flags };
    // Roles: asked in the terminal, or a neutral default without one.
    if (interactive && answers.signIn !== 'none' && answers.roles === undefined) answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
    if (interactive) await askNaming(answers, { input, output }, flags);
    return { answers };
};

/** In a terminal: the environment's name (if not on this machine) and the team language, unless given as flags. */
const askNaming = async (answers, terminal, given = {}) => {
    if (answers.env === undefined && answers.url !== undefined && defaultEnvName(answers.url) !== 'local') {
        answers.env = await askLine(terminal, t('cli.askEnv'), defaultEnvName(answers.url), (value) => (NAME.test(value) ? null : t('cli.initEnvBad', { env: value })));
    }
    if (given.language === undefined) {
        answers.language = await askLine(terminal, t('cli.askLanguage'), answers.language ?? language(), (value) => (TEAM_LANGUAGE.test(value) ? null : t('cli.initLanguageBad', { language: value })));
    }
};

/** The first config from the answers of `init`; without answers the template with the detected framework. */
export const starterConfig = ({ framework = 'web', language: projectLanguage = language(), url, env, insecureTls = false, allowHttp = false, allowHosts, signIn = 'form', login = {}, explored = false, offline = false, roles, start, messageSelectors, consoleIgnore } = {}) => {
    if (!FRAMEWORK_NAMES.includes(framework)) throw new CawError('usage', t('cli.unknownFramework', { framework, names: FRAMEWORK_NAMES.join(', ') }));
    if (!['form', 'session', 'none'].includes(signIn)) throw new CawError('usage', t('cli.initAuthUnknown', { auth: signIn }));
    const names = roles ?? [DEFAULT_ROLE];
    const bad = names.find((name) => !/^[a-z][a-z0-9-]*$/.test(name));
    if (bad !== undefined || names.length === 0) throw new CawError('usage', t('cli.badRoleName', { name: bad ?? '' }));
    // The language comes first: it applies to workbench, chat, output and report of this project.
    const config = { language: projectLanguage, ...JSON.parse(readFileSync(templatePath('caw.config.example.json'), 'utf8')) };
    config.framework = framework;
    // One environment (SC-15): on this machine Claude may work and write; elsewhere Claude may work but not write; a name that
    // looks like production is production and nothing else.
    const address = url ?? config.environments.local.url;
    const { protocol, hostname } = new URL(address);
    if (protocol === 'http:' && !isLoopback(hostname) && !allowHttp) throw new CawError('usage', t('cli.initNeedsAllowHttp', { host: hostname }));
    const envName = env ?? defaultEnvName(url);
    const flags = productionLike(envName) ? { production: true } : isLoopback(hostname) ? { agent: true, writable: true } : { agent: true, writable: false };
    config.environments = {
        [envName]: {
            url: address,
            ...flags,
            ...(insecureTls ? { insecureTls: true } : {}),
            ...(allowHttp ? { allowHttp: true } : {}),
            ...(Array.isArray(allowHosts) && allowHosts.length > 0 ? { allowHosts } : {}),
        },
    };
    // A role is an empty object; its test user follows the naming convention (CAW_<ROLE>_USER …) in caw/.env.
    config.roles = Object.fromEntries(names.map((name) => [name, {}]));
    if (signIn === 'none') {
        delete config.signIn;
        delete config.roles;
    }
    if (signIn === 'session') config.signIn = { type: 'session', signedInSelector: login.signedInSelector ?? config.signIn.signedInSelector };
    // From explore: found selectors instead of the template placeholders.
    if (signIn === 'form' && Array.isArray(login.steps) && login.steps.length > 0) {
        // A sign-in at an IdP: steps from the pages the person went through, starting on the app path that led there.
        config.signIn = {
            type: 'form',
            path: typeof login.path === 'string' && login.path !== '' ? login.path : '/',
            steps: login.steps,
            signedInSelector: typeof login.signedInSelector === 'string' && login.signedInSelector !== '' ? login.signedInSelector : TODO,
        };
    } else if (signIn === 'form') {
        for (const key of ['path', 'userSelector', 'passwordSelector', 'submitSelector', 'signedInSelector']) {
            if (typeof login[key] === 'string' && login[key] !== '') config.signIn[key] = login[key];
            // What explore did not find gets no real-looking placeholder: doctor reports TODO until the human fills it in.
            else if ((explored || offline) && key !== 'submitSelector') config.signIn[key] = TODO;
        }
    }
    if (isStartPath(start)) config.start = start;
    // Never an overlay block: the overlay is an extension the team adds when it wants local code on a deployed environment.
    if (Array.isArray(messageSelectors) && messageSelectors.length > 0) config.messageSelectors = messageSelectors;
    if (Array.isArray(consoleIgnore) && consoleIgnore.length > 0) config.consoleIgnore = consoleIgnore;
    return config;
};

/** The caw entry in .mcp.json for init, with what the person needs to know. @returns true if the file was written */
const addMcpEntry = (root) => {
    const state = ensureMcpEntry(root);
    if (state === 'invalid') ui.warn(t('cli.mcpInvalid'));
    if (state === 'updated') ui.note(t('cli.mcpUpdated'));
    return state === 'created' || state === 'updated';
};

/**
 * caw/.env.example for a new config: the unsuffixed names of every role whose sign-in reads a test user, without values.
 * @returns the file content, or null when nothing signs in with a password
 */
export const envExample = (config) => {
    if (!usesCredentials(config.signIn)) return null;
    const names = Object.keys(config.roles ?? {}).flatMap((role) => {
        const { user, password, totp } = credentialNames(role).default;
        return usesTotp(config.signIn) ? [user, password, totp] : [user, password];
    });
    return `${t('cli.envExampleHead')}\n${names.map((name) => `${name}=`).join('\n')}\n`;
};

/**
 * Creates config, .env example, notes, the MCP entry and .gitignore entries. Existing files stay untouched.
 * @param answers from the `init` dialog (`framework`, `url`, `signIn`); without: template with the detected framework
 */
export const init = (root, answers = {}) => {
    const created = [];
    const write = (target, content) => {
        const path = join(root, target);
        if (existsSync(path)) return;
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
        created.push(target);
    };
    const detected = detectApp(root);
    const config = starterConfig({ framework: detected.framework, ...answers });
    write(CONFIG_FILE, `${JSON.stringify(config, null, 4)}\n`);
    // No example test: it would not fit the application. record creates the first test.
    const example = envExample(config);
    if (example !== null) write(`${ENV_FILE}.example`, example);
    // The folder for test plans and the notes for Claude: shows right away where things belong.
    if (!existsSync(join(root, TEST_DIR))) write(`${TEST_DIR}/.gitkeep`, '');
    write(CONTEXT_FILE, t('cli.contextTemplate'));
    if (answers.mcp !== false && addMcpEntry(root)) created.push('.mcp.json');
    // With the MCP entry the skill that lets the person's session attach to caw windows; a file somebody wrote stays as it is.
    if (answers.mcp !== false) {
        if (skillState(root) !== 'foreign' && writeSkill(root) !== 'current') created.push(SKILL_PATH);
    }

    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    // The explore result too: it holds what the page showed (start page, hosts, messages), not something to share.
    const lines = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`, EXPLORE_FILE].filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length > 0) {
        appendFileSync(ignore, `\n# caw\n${lines.join('\n')}\n`);
        created.push('.gitignore');
    }
    ui.success(created.length > 0 ? t('cli.initCreated', { files: created.join(', ') }) : t('cli.initAlready'));
    const todo = todoFields(config);
    if (created.includes(CONFIG_FILE) && todo.length > 0) ui.warn(t(answers.offline ? 'cli.initTodoOffline' : 'cli.initTodo', { keys: todo.join(', ') }));
    // If explore just ran, advising to run it first would be confusing.
    const first = Object.keys(config.environments)[0];
    if (created.includes(CONFIG_FILE) && config.environments[first].production === true) ui.warn(t('cli.initProductionLike', { env: first }));
    else if (created.includes(CONFIG_FILE)) ui.note(`${t('cli.initNext', { target: first })}${answers.explored ? '' : t('cli.initNextExplore')}`);
    return EXIT.pass;
};

/**
 * Saves a role's session for an environment with `signIn.type: session` (e.g. SSO): Chrome opens the sign-in, the human
 * signs in, the session goes to caw/.auth/<env>/<role>.json. Without Claude and Docker.
 * @param capture tests only: replaces Chrome
 */
export const roleLogin = async (root, { role: roleName, target }, { capture } = {}) => {
    if (roleName === undefined || target === undefined) throw new CawError('usage', t('cli.authUsage'));
    const config = loadConfig(root);
    const resolved = effectiveEnvironment(config, target);
    // The validator guarantees signedInSelector for a session sign-in.
    const { type, path = '/', signedInSelector } = resolved.signIn;
    if (type !== 'session') throw new CawError('usage', t('cli.authStorageOnly', { type, target }));
    if (config.roles?.[roleName] === undefined) throw new CawError('usage', t('cli.authRoleUnknown', { role: roleName, roles: Object.keys(config.roles ?? {}).join(', ') }));
    if (resolved.production) throw new CawError('env-denied', t('cli.targetProduction', { target }));
    const file = join(root, sessionPath(target, roleName));
    // The session signs in as the role: never into git, also in a project set up without init.
    if (ignoreAuthDir(root)) ui.info(t('cli.authIgnored', { dir: `${AUTH_DIR}/` }));
    const save = capture ?? (await import('./browser-session.mjs')).captureSession;
    ui.info(t('cli.authSignIn', { role: roleName, selector: signedInSelector }));
    const saved = await save({ url: `${resolved.url}${path}`, signedInSelector, hosts: navigationHosts(config, target), blocked: blockedHosts(config, target), insecureTls: resolved.insecureTls, file, launch: browserLaunch(config) });
    if (!saved) {
        ui.info(t('cli.authClosed'));
        return EXIT.error;
    }
    ui.success(t('cli.authSaved', { file: sessionPath(target, roleName) }));
    return EXIT.pass;
};

/** Checks the config and all tests on all their environments, without Docker or network. Stale steps are a hint, not an error. */
export const validate = (root) => {
    const { config, notes, todo } = loadConfigWithNotes(root);
    const dir = join(root, TEST_DIR);
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const problems = [];
    const hints = [...notes];
    // One line per test and target saying which code runs there, so an unnoticed deployed build stands out here already.
    const codeLines = [];
    // Drafts from caw reproduce are checked the same way, named by their path in caw/drafts.
    const drafts = draftIds(root);
    const entries = [
        ...files.map((file) => ({ file, load: () => loadTest(root, file.slice(0, -'.yaml'.length)) })),
        ...drafts.map((id) => ({ file: `${DRAFT_DIR}/${id}.yaml`, load: () => loadDraft(root, id) })),
    ];
    for (const { file, load } of entries) {
        try {
            // Description plus recording from caw/recordings; loadTest reports a mismatching id.
            const spec = withDefaults(load(), config);
            // Role and listed environments all at once: checkTest stops at the first.
            const basics = [...testBasics(spec, config), ...environmentProblems(spec, config)];
            const badTargets = [];
            // A writing test in a project without a writable environment: valid on its own, but it runs nowhere.
            if (spec.runsOn.length === 0) badTargets.push(`${file}: ${t('cli.validateNowhere', { id: spec.id })}`);
            if (basics.length > 0 || badTargets.length > 0) {
                problems.push(...basics.map((text) => `${file}: ${text}`), ...badTargets);
                continue;
            }
            for (const target of spec.runsOn) {
                try {
                    const checked = checkTest(spec, target, config);
                    // Where an overlay is possible it is listed, although without --overlay the deployed build runs. If the app has
                    // both build and dev server, a bare --overlay requires a choice; then both are listed with their value.
                    const overlayWith = (flag) => {
                        try {
                            return describeCode(config, spec, checkTest(spec, target, config, { overlay: flag }));
                        } catch {
                            return null;
                        }
                    };
                    const plain = overlayWith(true);
                    const overlay = plain ?? (['build', 'dev'].map((flag) => overlayWith(flag)).filter((text) => text !== null).join(' | ') || null);
                    const code = describeCode(config, spec, checked);
                    codeLines.push(t(overlay === null ? 'cli.validateCode' : plain === null ? 'cli.validateCodeOverlayChoose' : 'cli.validateCodeOverlay', { id: spec.id, target, code, overlay }));
                } catch (error) {
                    problems.push(`${file} (${target}): ${error.message}`);
                }
            }
            const chain = brokenChain(spec);
            if (chain !== null) hints.push(t('cli.validateChain', { file, chain }));
            const stale = staleSteps(spec);
            if (stale.length === spec.steps.length && spec.steps.every(({ recording }) => recording === undefined)) hints.push(t('cli.validateNotRecorded', { file }));
            else {
                // Pending steps are no defect: they are named once as the tail still to be recorded.
                const pending = pendingSteps(spec);
                for (const { id, why } of stale.filter(({ id: staleId }) => !pending.includes(staleId))) hints.push(`${file}: ${id} ${why}.`);
                if (pending.length > 0) hints.push(t('cli.validatePending', { file, ids: pending.join(', ') }));
            }
        } catch (error) {
            problems.push(error.message);
        }
    }
    try {
        hints.push(...recordingHints(root));
    } catch (error) {
        problems.push(error.message);
    }
    // A login value still TODO is no typo, but nothing that signs in can run: rejected like an invalid config, never "valid".
    const todoLines = todo.map((key) => t('cli.validateTodo', { key, what: t(`cli.validateTodo.${key.slice(key.lastIndexOf('.') + 1)}`) }));
    if (problems.length > 0 || todoLines.length > 0) {
        codeLines.forEach((line) => ui.info(line));
        hints.forEach((hint) => ui.note(hint));
        const todoBlock = todoLines.length === 0 ? [] : [`${CONFIG_FILE}:`, ...todoLines.map((line) => `- ${line}`)];
        throw new CawError(todoLines.length > 0 ? 'config-invalid' : 'test-invalid', [...todoBlock, ...problems].join('\n'));
    }
    codeLines.forEach((line) => ui.info(line));
    hints.forEach((hint) => ui.note(hint));
    ui.success(t('cli.validateOk', { config: CONFIG_FILE, count: files.length }));
    if (drafts.length > 0) ui.info(t('cli.validateDrafts', { count: drafts.length, dir: DRAFT_DIR }));
    return EXIT.pass;
};

const namesIn = (map) => Object.keys(map ?? {}).join(', ') || '–';

/** What makes a test unrunnable on every environment: its role. Texts as in checkTest. */
const testBasics = (spec, config) => {
    const problems = [];
    const id = String(spec.id);
    if (spec.role === undefined && config.roles !== undefined) problems.push(t('config.test.check.role', { id, roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.role !== undefined && config.roles?.[spec.role] === undefined) problems.push(t('config.test.check.unknownRole', { role: String(spec.role), roles: namesIn(config.roles), config: CONFIG_FILE }));
    return problems;
};

/** Builds the sandbox image unless one exists for this base image, user and tool version. */
const ensureImage = async (docker, baseImage, user) => {
    const parts = [...TOOL_PARTS, ...IMAGE_TEMPLATES.map((name) => `templates/${name}`)];
    const tag = `caw-sandbox:${toolFingerprint(TOOL_DIR, parts, `${baseImage} ${user}`)}`;
    if ((await docker.run(['image', 'inspect', tag], { capture: true })).code === 0) return tag;

    ui.progress(t('cli.imageBuilding'));
    const files = {
        Dockerfile: renderDockerfile({ image: baseImage, user }),
        'init-firewall.sh': readFileSync(templatePath('init-firewall.sh'), 'utf8'),
        'entrypoint.sh': readFileSync(templatePath('entrypoint.sh'), 'utf8').replaceAll('{{user}}', user),
    };
    // realpath: on Windows the temp path may contain a short name like FSCHUB~1 that WSL does not know.
    const context = mkdtempSync(join(realpathSync.native(tmpdir()), 'caw-build-'));
    try {
        for (const part of TOOL_PARTS) cpSync(join(TOOL_DIR, part), join(context, 'tool', part), { recursive: true });
        for (const [name, content] of Object.entries(files)) writeFileSync(join(context, name), content.replaceAll('\r\n', '\n'));
        const { code } = await docker.run(['build', '-q', '-t', tag, docker.hostPath(context)]);
        if (code !== 0) throw new CawError('image-build-failed', t('cli.imageBuildFailed', { code, image: baseImage }));
    } finally {
        rmSync(context, { recursive: true, force: true });
    }
    return tag;
};

/**
 * The sandbox base image and its user: `sandboxImage` from the config, else the image from .devcontainer/devcontainer.json,
 * else a plain Node image. Claude and the container part of the tool are added on top.
 */
export const sandboxBase = (root, config) => {
    if (config.sandboxImage !== undefined) return { image: config.sandboxImage, user: config.sandboxUser ?? SANDBOX_USER };
    const devcontainer = join(root, '.devcontainer/devcontainer.json');
    if (existsSync(devcontainer)) return { image: projectImage(parseJsonc(readFileSync(devcontainer, 'utf8'))), user: config.sandboxUser ?? SANDBOX_USER };
    // The node user has uid 1000 there, like the usual owner of the project folder, so it may write to the run folder.
    return { image: DEFAULT_SANDBOX_IMAGE, user: config.sandboxUser ?? 'node' };
};

/** Everything `docker run` needs. */
const prepareSandbox = async (root, docker, config) => {
    const { image: baseImage, user } = sandboxBase(root, config);
    const image = await ensureImage(docker, baseImage, user);
    const emptyFile = join(root, RUN_DIR, 'empty');
    mkdirSync(join(root, RUN_DIR), { recursive: true });
    writeFileSync(emptyFile, '');
    const containerRoot = toWslPath(root);
    return { docker, image, hostRoot: docker.hostPath(root), containerRoot, masks: maskArgs(root, containerRoot, docker.hostPath(emptyFile)) };
};

/** With only one role or app, a new test needs no flag for it. */
const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/** The command that records the test anew: flags only for what the config does not determine. */
const recordHint = (config, id, target) => {
    // Without --env the command needs none if there is only one environment for Claude; otherwise list the choices.
    const choices = environmentCandidates(config, { command: 'record' });
    let targetFlag = [];
    if (target !== undefined) targetFlag = [`--env ${target}`];
    else if (choices.length !== 1) targetFlag = [`--env <${choices.join('|') || 'env'}>`];
    return [
        `${cawCommand()} record ${id}`,
        ...targetFlag,
        ...(onlyKey(config.roles) === undefined ? [`--role <${Object.keys(config.roles ?? {}).join('|') || 'role'}>`] : []),
    ].join(' ');
};

/** The names of all tests in caw/tests, sorted. */
const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

/** " Did you mean x?" or nothing. */
const suggestion = (word, candidates) => {
    const near = closest(word, candidates);
    return near === undefined ? '' : t('cli.didYouMean', { name: near });
};

/** The test does not exist: with a suggestion, the known tests and the command that records it. */
const testMissing = (root, config, id, target) => {
    const known = testIds(root);
    const near = closest(id, known);
    // For a typo the closest name is the answer; recording under the typo would only create a second test.
    return new CawError('test-missing', t(near === undefined ? 'cli.testMissing' : 'cli.testMissingNear', {
        file: `${TEST_DIR}/${id}.yaml`,
        name: near,
        known: known.length === 0 ? t('cli.noTests') : t('cli.knownTests', { tests: known.join(', ') }),
        hint: recordHint(config, id, target),
    }));
};

/** The steps as text: "S1–S6" when contiguous, otherwise listed. */
export const stepsText = (spec) => {
    const ids = spec.steps.map(({ id }) => id);
    const plain = ids.every((id, index) => id === `S${index + 1}`);
    return plain && ids.length > 2 ? `${ids[0]}–${ids.at(-1)}` : ids.join(', ');
};

/** Pending steps are one tail in a row: "S4–S6", or "S4" alone. */
const stepRange = (ids) => (ids.length === 1 ? ids[0] : `${ids[0]}–${ids.at(-1)}`);

/** The step does not exist: with a suggestion and the test's steps. */
const stepUnknown = (key, spec, step, extra = {}) => new CawError('step-unknown', t(key, {
    test: spec.id,
    step,
    suggestion: suggestion(step, spec.steps.map(({ id }) => id)),
    steps: t('cli.knownSteps', { steps: stepsText(spec) }),
    ...extra,
}));

/**
 * The environment when --env is missing (see chooseEnvironment): the only candidate, for run outside CI the only one with Claude.
 * The choice is logged; ambiguity is a usage error listing the candidates.
 * @param specs the tests of the call; none for a new test (record) or open without a test
 * @param writes record of a new test: whether it may write (not --read-only)
 */
export const chooseEnv = (config, specs, { env, command, writes = true, ci = Boolean(process.env.CI), log = ui.info }) => {
    const model = specs.map((spec) => ({ id: spec.id, writes: spec.writes === true, ...(Array.isArray(spec.environments) ? { environments: spec.environments } : {}) }));
    const candidates = environmentCandidates(config, { command, specs: model, writes });
    const { name, why } = chooseEnvironment(config, { given: env, candidates, command, ci });
    if (why !== 'given') {
        const reason = why === 'onlyClaude' ? t('cli.envWhyOnlyClaude') : specs.length === 1 ? t('cli.envWhyTest', { test: specs[0].id }) : specs.length > 1 ? t('cli.envWhyTests') : t('cli.envWhyNew');
        log(t('cli.envChosen', { env: name, why: reason }));
    }
    return name;
};

const loadChecked = (root, id, given, command, { overlay, start } = {}) => {
    const config = loadConfig(root);
    if (!testExists(root, id)) throw testMissing(root, config, id, given);
    // A run sees what this machine is still learning (.caw/learning) as part of the recording.
    const spec = withLearning(root, withDefaults(loadTest(root, id), config));
    const target = chooseEnv(config, [spec], { env: given, command });
    return { config, spec, target, checked: checkTest(spec, target, config, { overlay, start }) };
};

/**
 * Loads tests with the config defaults (role, runsOn). Without a readable config as written: list works without one.
 */
/** The config for display, or {} if it is missing or invalid. */
const displayConfig = (root) => {
    try {
        return loadConfig(root);
    } catch {
        return {};
    }
};

const testLoader = (root) => {
    let config = null;
    try {
        config = loadConfig(root);
    } catch {
        config = null;
    }
    return (id) => (config === null ? loadTest(root, id) : withDefaults(loadTest(root, id), config));
};

/**
 * How far a test is recorded: recorded, pending (recorded up to an unrecorded tail, with its steps), stale (with the steps) or
 * none. Stale wins over pending: such a test does not run.
 */
const recordingState = (spec) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) return { state: 'none', ids: [] };
    const pending = pendingSteps(spec);
    const stale = staleSteps(spec).map(({ id }) => id).filter((id) => !pending.includes(id));
    const chain = brokenChain(spec);
    if (stale.length === 0 && chain === null) return pending.length === 0 ? { state: 'recorded', ids: [] } : { state: 'pending', ids: pending };
    return { state: 'stale', ids: stale, chain };
};

/** Spaced columns without borders: readable in the terminal and easy to process with grep and awk. */
const columns = (rows) => {
    const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
    return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ').trimEnd());
};

/**
 * `caw list`: per test its environments, recording state and whether it writes; `caw list <test>` one line per step. Without browser,
 * Claude or config.
 */
export const list = (root, args, { out = console.log } = {}) => {
    const [test, ...rest] = args;
    const extra = rest[0] ?? (test?.startsWith('-') ? test : undefined);
    if (extra !== undefined) throw new CawError('usage', t('session.args.unexpected', { arg: extra }));
    // Without a config there is no project here, like for every other command; an invalid one still lists the tests.
    if (!existsSync(join(root, CONFIG_FILE))) loadConfig(root);
    const writesText = (spec) => t(spec.writes === false ? 'cli.listReadOnly' : 'cli.listWrites');
    if (test !== undefined) {
        if (!testExists(root, test)) {
            let config = {};
            try {
                config = loadConfig(root);
            } catch {
                // Without a valid config the hint just lacks role and app.
            }
            throw testMissing(root, config, test, undefined);
        }
        const spec = testLoader(root)(test);
        const stale = new Set(staleSteps(spec).map(({ id }) => id));
        const pending = new Set(pendingSteps(spec));
        out(t('cli.listTestHead', { test: spec.id, start: startPath(displayConfig(root), spec), role: spec.role ?? '–', environments: (spec.runsOn ?? spec.environments ?? []).join(', '), writes: writesText(spec) }));
        const rows = spec.steps.map((step) => {
            let state = 'cli.listStepRecorded';
            if (pending.has(step.id)) state = 'cli.listStepPending';
            else if (step.recording === undefined) state = 'cli.listStepNotRecorded';
            else if (stale.has(step.id)) state = 'cli.listStepStale';
            return [`  ${step.id}`, step.name ?? '', `(${t(state)})`];
        });
        if (rows.length > 0) columns(rows).forEach((line) => out(line));
        const chain = brokenChain(spec);
        if (chain !== null) out(`  ${t('cli.validateChain', { file: `${spec.draft === true ? DRAFT_DIR : TEST_DIR}/${test}.yaml`, chain })}`);
        if (spec.draft === true) out(`  ${draftState(root, spec)}`);
        return EXIT.pass;
    }
    const ids = testIds(root);
    const drafts = draftIds(root);
    const invalid = [];
    const load = testLoader(root);
    /** One row per test or draft; a draft's state says whether it is red yet. */
    const rowOf = (id, loadOne, draft) => {
        try {
            const spec = loadOne(id);
            const { state, ids: staleIds, chain } = recordingState(spec);
            let text = t('cli.listRecorded');
            if (state === 'none') text = t('cli.listNotRecorded');
            else if (state === 'stale') text = t('cli.listStale', { ids: staleIds.join(', ') || chain });
            else if (state === 'pending') text = t('cli.listPending', { ids: staleIds.join(', ') });
            if (draft && state === 'recorded') text = draftState(root, spec);
            // A draft's red proof also while steps are pending (a design draft's red step), and where a design draft came from.
            else if (draft && spec.red !== undefined) text = `${text}, ${draftState(root, spec)}`;
            if (draft && isDesignDraft(spec)) text = t('cli.listDraftDesign', { state: text });
            return [id, (spec.runsOn ?? spec.environments ?? []).join(', '), text, writesText(spec)];
        } catch (error) {
            // The table stays narrow, the reason goes below it; validate lists all findings.
            invalid.push(`${id}: ${String(error.message).split('\n')[0]}`);
            return [id, '', t('cli.listInvalid'), ''];
        }
    };
    if (ids.length === 0) out(t('cli.listNone', { dir: TEST_DIR }));
    else columns([t('cli.listHead').split('|'), ...ids.map((id) => rowOf(id, load, false))]).forEach((line) => out(line));
    // Drafts from caw reproduce stand apart: they are not in run --all until promoted.
    if (drafts.length > 0) {
        const config = displayConfig(root);
        const loadOne = (id) => (Object.keys(config).length === 0 ? loadDraft(root, id) : withDefaults(loadDraft(root, id), config));
        out('');
        out(t('cli.listDrafts', { dir: DRAFT_DIR }));
        columns([t('cli.listHead').split('|'), ...drafts.map((id) => rowOf(id, loadOne, true))]).forEach((line) => out(line));
    }
    invalid.forEach((line) => out(line));
    return EXIT.pass;
};

/**
 * A recorded draft: not yet proven red, red at its step (proven, with the run), or green and ready to promote once a run after
 * the red proof showed it so, as caw_status says (bugfix.mjs fixState).
 */
const draftState = (root, spec) => {
    if (spec.red === undefined) return t('cli.listDraftNotRed');
    const now = fixState(root, spec.id);
    if (now?.phase === 'green' && now.next?.promote === true) return t('cli.listDraftGreen', { step: spec.red.step });
    return t('cli.listDraftRed', { step: spec.red.step, run: spec.red.run });
};
/** The environments Claude may work on, as text: "dev" or "dev, local". */
const agentEnvironments = (config) => environmentsWith(config, 'agent').join(', ') || t('cli.noEnvironment');

/** Claude only works on environments with `claude`: the others are meant to fail when something is off. */
const requireAgent = (config, checked, target, verb) => {
    if (!checked.agent) throw new CawError('write-protected', t('cli.agentOnly', { verb, environments: agentEnvironments(config), target, environment: checked.environment }));
};

/**
 * Where Claude runs. Locally (default) it only needs Claude Code on the PATH; with Docker also token and image. Scripted flows
 * instead of Claude need neither Claude Code nor a token.
 */
const openSandbox = async (root, { config, containerCommand, adviseCommand, talkCommand, docker: chosenDocker, agent, attach }) => {
    const scripted = containerCommand !== undefined || adviseCommand !== undefined || talkCommand !== undefined;
    const inCi = process.env.CI !== undefined && process.env.CI !== '';
    if (agent !== undefined && agent !== 'docker' && inCi) throw new CawError('usage', t('cli.agentNotInCi', { agent }));
    // --attach, or agent.mode "session" in the config: the person's own session answers, caw starts no agent of its own.
    if (attach !== undefined || (agent === undefined && agentMode(config) === 'session')) {
        if (inCi) throw new CawError('usage', t('cli.agentNotInCi', { agent: '--attach' }));
        ui.info(t('cli.sessionAgent'));
        return { kind: 'session', attach: attach ?? true, label: t('cli.sessionLabel') };
    }
    const mode = agent ?? agentMode(config);
    if (chosenDocker === undefined && mode === 'local') {
        const { localBox, requireClaude } = await import('./local-agent.mjs');
        if (!scripted) ui.info(t('cli.localAgent', { version: requireClaude() }));
        return localBox();
    }
    const docker = chosenDocker ?? await selectDocker();
    ui.info(t('cli.usingDocker', { label: docker.label }));
    // Before building the image: without a token nobody should wait for the build.
    if (!scripted && !await docker.hasToken()) {
        throw new CawError('token-missing', t('cli.tokenMissing', { hint: docker.tokenHint }));
    }
    return prepareSandbox(root, docker, config);
};

/** A test in the making. The metadata is fixed before Claude starts: the human decides role and target. */
const draftTest = (root, config, { id, target, role: chosenRole, readOnly = false }) => {
    // Without sign-in there is no role; with one, a single role applies, several need --role.
    const role = chosenRole ?? onlyKey(config.roles);
    if (role === undefined && config.roles !== undefined) {
        throw new CawError('usage', t('cli.draftMissing', { id, missing: '--role', hint: recordHint(config, id, target) }));
    }
    return {
        id,
        ...(role === undefined ? {} : { role }),
        // Writing unless the human says otherwise; a read-only test that does write becomes writing on adoption. No environments:
        // the test runs wherever the config allows, not only where it was recorded.
        writes: !readOnly,
        notes: '',
        steps: [],
        expectations: [],
    };
};

const DIALOG_OK = () => ({ id: 'ok', label: t('cli.dialogOk'), primary: true });
const DIALOG_CANCEL = () => ({ id: 'cancel', label: t('cli.dialogCancel') });
const quoted = (message) => t('cli.dialogQuoted', { message });
/**
 * A native dialog of the app during a demonstration: the chat shows its text with OK and Cancel (an alert only OK); for a prompt
 * the human may type the value. @returns { accept, value? }, or null when the chat is gone (the dialog is then dismissed)
 */
const askDialog = async (chat, { type, message, defaultValue }) => {
    if (type === 'prompt') {
        const card = { kind: 'result', tone: 'ask', title: t('cli.dialogValue'), text: quoted(message), muted: t('cli.dialogPrompt', { value: defaultValue ?? '' }) };
        const answer = await decide(chat, { id: 'app.dialog', context: { type, message }, kind: 'discussing', options: [DIALOG_OK(), DIALOG_CANCEL()], card });
        if (answer === null) return null;
        if (typeof answer === 'object') return { accept: true, value: answer.message };
        return answer === 'ok' ? { accept: true, value: defaultValue ?? '' } : { accept: false };
    }
    // An alert only tells; confirm and beforeunload ask.
    let title = t('cli.dialogAsks');
    if (type === 'alert') title = t('cli.dialogSays');
    else if (type === 'beforeunload') title = t('cli.dialogLeave');
    const card = { kind: 'result', tone: type === 'alert' ? 'info' : 'ask', title, text: quoted(message) };
    const answer = await decide(chat, { id: 'app.dialog', context: { type, message }, question: title, options: type === 'alert' ? [DIALOG_OK()] : [DIALOG_OK(), DIALOG_CANCEL()], card });
    return answer === null ? null : { accept: answer === 'ok' };
};

/**
 * The human describes the new test in the chat instead of showing it. Each message is a note with the page it was written on;
 * clicks are not recorded. Claude gets the notes as a demonstration without steps and finds the way itself.
 * @returns the description as demonstration items
 */
const describeTest = async (chat, session, dir, { aborted, closed, handOver }) => {
    for (;;) {
        chat.enter('describing');
        const items = [];
        for (;;) {
            const line = await chat.operator.nextLine({ page: session.page() });
            if (line === null) throw aborted();
            if (line === '') break;
            const text = typeof line === 'string' ? line : line.note;
            if (text === undefined) continue;
            const path = new URL(session.page().url()).pathname;
            items.push({ action: 'note', text, path, ...(line.element === undefined ? {} : { element: line.element }) });
            // The notes are numbered as Claude gets them (withNoteIds) and as the approval card shows them.
            chat.progress(t('cli.describeNoted', { id: `H${items.length}`, path, button: t('chat.status.describing.button') }));
        }
        if (!chat.available() || closed()) throw aborted();
        if (items.length > 0) {
            writeFileSync(join(dir, 'demonstration.json'), JSON.stringify(items, null, 2));
            handOver();
            return { items, dir };
        }
        chat.notice(t('cli.describeNothing'));
    }
};

/**
 * The human picks how to start and, if needed, demonstrates in their own browser. The window closes afterwards so Claude
 * starts fresh.
 * @returns the demonstration, or undefined if Claude follows the old test plan
 */
const startRecording = async (root, config, spec, checked, { exists, conversation }) => {
    const [{ badgeOf, benchFacts, benchSettings, openRunSession, titleOf }, { openChat }, { demonstrate, feedLabel, itemLabel }] = await Promise.all([import('./run.mjs'), import('./chat.mjs'), import('./demonstrate.mjs')]);
    const dir = join(root, RUN_DIR, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${spec.id}-demonstration`);
    mkdirSync(dir, { recursive: true });
    const session = await openRunSession({ root, config, spec, checked, runDir: dir, interactive: true });
    await session.workbench?.facts(benchFacts(config, spec, checked, titleOf(spec, 'start'), badgeOf('start')));
    await session.workbench?.settings?.(benchSettings({ root, config, spec, checked, mode: 'record', run: basename(dir) }));
    let chat = null;
    // The page under test touched the chat frame: the chat is closed and the recording ends with that error.
    let tampered = null;
    const aborted = () => tampered ?? new CawError('aborted', t('cli.recordAborted'));
    try {
        let windowClosed = false;
        session.closed.then(() => { windowClosed = true; });
        chat = await openChat({ session, logPath: join(dir, 'chat.log'), onAbort: () => process.emit('SIGINT'), onOpen: conversation.onChatOpen, onWaiting: ui.note, onTampered: (error) => { tampered = error; }, transcript: conversation.transcript });
        // This window is about to close and Claude gets a new one: chat and terminal announce it.
        const handOver = () => {
            const line = t('run.newWindow', { what: t('run.newWindow.claude') });
            chat.notice(line);
            ui.note(line);
        };
        // If the last recording failed after the demonstration (login, Claude), the human need not demonstrate again.
        const last = lastDemonstration(root, spec.id);
        const reuse = last === null ? null : { id: 'reuse', label: t('cli.choiceReuse', { time: new Date(last.at).toLocaleTimeString(language() === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }), count: last.items.length }), primary: true };
        // A new test: shown or described. An existing one has a plan Claude can follow instead.
        const options = [...(reuse === null ? [] : [reuse]), reuse === null ? SHOW() : { ...SHOW(), primary: false }, exists ? FOLLOW() : DESCRIBE()];
        if (options.length > 1) {
            // Described but never recorded is no old plan: there is nothing to replace.
            const recorded = exists && spec.steps.some((step) => step.recording !== undefined);
            let card = { kind: 'result', tone: 'ask', title: t('cli.questionNew', { id: spec.id }) };
            if (recorded) card = { ...card, title: t('cli.questionRecorded', { id: spec.id }), text: t('cli.questionRecordedWhy', { id: spec.id }) };
            else if (exists) card = { ...card, title: t('cli.questionDescribed', { id: spec.id }), text: t('cli.questionDescribedWhy', { id: spec.id }) };
            const choice = await Promise.race([decide(chat, { id: 'record.start', context: { test: spec.id, exists, recorded, ...(reuse === null ? {} : { reuse: last.items.length }) }, kind: 'choosing', options, card }), session.closed.then(() => null)]);
            if (choice === null) throw aborted();
            if (choice === 'follow' || choice === 'reuse') handOver();
            if (choice === 'follow') return undefined;
            if (choice === 'reuse') return { items: last.items, dir: last.dir };
            if (choice === 'describe') return await describeTest(chat, session, dir, { aborted, closed: () => windowClosed, handOver });
        }
        ui.note(t('cli.demoNote'));
        for (;;) {
            chat.enter('showing');
            const items = await demonstrate({ session, operator: chat.operator, ui, dir, filesDir: join(root, PROJECT_DIR), onDialog: (info) => askDialog(chat, info), onItem: (item) => { const line = feedLabel(item); if (line !== null) chat.progress(t('cli.demoRecorded', { line })); }, onFailure: (item) => chat.notice(t('cli.demoFailure', { label: itemLabel(item) })) });
            if (!chat.available() || windowClosed) throw aborted();
            if (items.length > 0) {
                writeFileSync(join(dir, 'demonstration.json'), JSON.stringify(items, null, 2));
                handOver();
                return { items, dir };
            }
            // Nothing demonstrated: with a test plan Claude follows it, otherwise there is nothing to build a plan from.
            if (exists) {
                ui.note(t('cli.demoNothingFollow'));
                handOver();
                return undefined;
            }
            chat.notice(t('cli.demoNothing'));
        }
    } finally {
        chat?.human.closed();
        await session.close();
    }
};

/**
 * What every run with Claude needs. The chat accompanies everything that has a conclusion.
 * `lazyChat` true opens it only on a failed step, 'warnings' also on errors and warnings; `testing` shows a test run in the
 * chat instead of a verification run.
 */
const claudeRuns = (root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, conversation: shared, ...rest }) => {
    // The guided bug fix chains reproduce, record and run in one process: the next phase keeps the chat so far.
    const conversation = shared ?? { transcript: [], onChatOpen };
    // A run without a window that stopped at a decision only a person takes (record --headless): the first such decision.
    let undecided;
    return {
        conversation,
        undecided: () => undecided,
        execute: async ({ lazyChat, testing, ...options }) => {
            const { executeRun } = await import('./run.mjs');
            const result = await executeRun(root, config, options.sandbox ?? null, {
                spec,
                checked,
                target,
                timeoutMin,
                containerCommand,
                adviseCommand,
                talkCommand,
                stepTimeoutMs: stepTimeoutSec * 1000,
                maxActions: maxActions ?? config.maxActions ?? DEFAULT_MAX_ACTIONS,
                ...rest,
                ...options,
                ...(options.conclude === undefined ? {} : { conversation: { ...conversation, lazy: lazyChat !== undefined, alsoOnWarnings: lazyChat === 'warnings', testing: testing === true } }),
            });
            undecided ??= result.undecided === undefined ? undefined : { ...result.undecided, report: result.report };
            return result;
        },
    };
};

/** Recording and opening need a human for demonstration, plan, decisions or the window. CI has none: reject instead of waiting. */
const requireHuman = (command, interactive) => {
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    if (inCi) throw new CawError('usage', t('cli.ciNeedsHuman', { command }));
};

/** A line at the start of the run: what the run may do and why, so no mode silently follows from the environment. */
export const runMode = ({ withAgent, noChat, headless, inCi, withAdvice, environments, env, language: team, learn = false, opened = false, file = RECORDING_DIR }) => {
    let how;
    if (!withAgent) how = t('cli.modeNoAgent', { environments });
    else if (headless) how = t('cli.modeHeadless');
    else if (noChat) how = t('cli.modeNoChat');
    else if (inCi) how = t('cli.modeCi');
    else how = t('cli.modeChat', { advice: withAdvice && !opened ? t('cli.modeAdvice') : '' });
    // open never learns; a run outside CI always learns (in CI only with --learn), and then names the file it may change.
    const learns = learn && !opened ? t('cli.modeLearnsYes', { file }) : t('cli.modeLearnsNo');
    return `${t('cli.modeLine', { env, language: team, how, learns })}${urlLine(env)}`;
};

/** The address a CAW_URL__<ENV> variable gave the environment, so a run against a PR preview says where it went. */
const urlLine = (env) => (urlOverride(env) === undefined ? '' : ` ${t('cli.modeUrl', { variable: urlVariable(env), url: urlOverride(env) })}`);

/**
 * The environment lifecycle of one invocation (§2.9). --start needs a start command unless it only starts overlay parts; --reset
 * needs a reset command. run resets once before the first writing test unless --no-reset; record and open only with --reset.
 */
const lifecycleOf = (root, config, target, { start = false, reset, overlay }, command) => {
    const env = effectiveEnvironment(config, target);
    if (start && env.start === undefined && overlay === undefined) throw new CawError('usage', t('session.args.startWithoutCommand', { env: target }));
    if (reset === 'force' && env.reset === undefined) throw new CawError('usage', t('session.args.resetWithoutCommand', { env: target }));
    return environmentLifecycle(root, env, {
        start: start && env.start !== undefined,
        reset: reset ?? (command === 'run' ? 'auto' : 'off'),
        info: (text) => ui.info(text),
        warn: (text) => ui.warn(text),
    });
};

/** Runs work between begin and end of the lifecycle: what caw started is stopped also after an error or Ctrl+C. */
const withLifecycle = async (lifecycle, work) => {
    try {
        await lifecycle.begin();
        return await work(lifecycle);
    } finally {
        await lifecycle.end();
    }
};

/**
 * Tracks what a run changes in the test files, for the closing line: "Changed: caw/recordings/x.yaml
 * (baselines S2, S5)" or "Test file unchanged".
 */
export const changeTracker = (root) => {
    const changes = new Map();
    const unchanged = t('config.test.unchanged');
    return {
        adopt: (draft, only, options = {}) => {
            const result = writeTest(root, draft, only, options);
            if (result === unchanged) return result;
            let key = only === undefined ? 'cli.changedPlan' : 'cli.changedSteps';
            if (options.learned === 'baselines') key = 'cli.changedBaselines';
            else if (options.learned === 'effects') key = 'cli.changedEffects';
            else if (options.learned === 'looks') key = 'cli.changedLooks';
            for (const file of result.split(', ')) {
                const kinds = changes.get(file) ?? new Map();
                const ids = kinds.get(key) ?? new Set();
                for (const id of only ?? []) ids.add(id);
                kinds.set(key, ids);
                changes.set(file, kinds);
            }
            return result;
        },
        summary: () => {
            if (changes.size === 0) return t('cli.unchanged');
            const files = [...changes].map(([file, kinds]) => t('cli.changedWhat', {
                file,
                what: [...kinds].map(([key, ids]) => t(key, { ids: [...ids].join(', ') }).trim()).join('; '),
            }));
            return t('cli.changed', { files: files.join(', ') });
        },
    };
};

/**
 * A test run by plan, without Claude, Docker or token. On environments Claude may work on, the chat is there from the start,
 * except in CI (variable CI); if a step fails, the human clarifies it there and can have it fixed. For open (`handover`) the
 * run prepares a state and hands over the window, to continue working on the local build from there: with `entry` at the
 * entry of that step, otherwise after the whole test. With --explain Claude advises on errors and warnings, which costs
 * tokens. --no-chat runs as in CI, --headless additionally without a window. Outside CI every run writes missing baselines
 * and effects of its passed steps; in CI only with --learn. A pending tail (pendingSteps) does not play and does not fail the
 * run; with --strict it stops the run before anything starts (exit 4).
 * @param quiet in a batch: no mode line, the batch prints it once
 * @param nextSteps false: no "next" hints after a failed step (caw bisect, where neither a chat nor a re-record belongs)
 * @param guided false: no guided bug fix for a draft (promoting runs it as proof only)
 * @param conversation the chat so far, when an earlier phase of the guided bug fix ran in this process
 * @returns { code, failed, verdict, report, pending } with the failed step ({ id, reason, diagnosis }), if one failed, the
 *          playback's verdict, its report.md relative to the project, and the pending steps' ids
 */
export const runOne = async (root, options, deps = {}, loaded = undefined) => {
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive, git } = deps;
    const { test, handover = false, stepTimeoutSec, entry, through, design = false, advise: withAdvice, headless, noChat, learn = false, strict = false, agent, attach, timeoutMin, maxActions, overlay, start, lifecycle, quiet = false, nextSteps = true, guided = true, conversation, snapshot } = options;
    const { config, spec, target, checked } = loaded ?? loadChecked(root, test, options.target, 'run', { overlay, start });
    const position = entry === undefined ? -1 : spec.steps.findIndex(({ id }) => id === entry);
    if (entry !== undefined && position === -1) throw stepUnknown('cli.stepUnknown', spec, entry);
    const { assertPlayable } = await import('./replay.mjs');
    // open without a test has no steps: nothing to play back, just log in and hand over. At the entry of a step the steps before
    // it must be playable; the step itself only leads in, and if it is stale, nothing of it runs. The whole test may end in
    // pending steps: they are the part still to be built, the run plays up to the last recorded one (unless --strict).
    if (loaded === undefined && through !== undefined) assertPlayable(spec, target, through);
    else if (loaded === undefined && entry === undefined) assertPlayable(spec, target, undefined, { pending: !strict });
    else if (loaded === undefined && position > 0) assertPlayable(spec, target, spec.steps[position - 1].id);
    const pending = entry === undefined && through === undefined ? pendingSteps(spec) : [];
    // The environment's reset before the first writing test (or the first test with --reset), before anything signs in.
    await lifecycle?.beforeTest(spec);
    // A missing test user stops the run here, before Chrome or Claude start.
    requireTestUser(root, config, spec.role, target);
    const withAgent = checked.agent;
    // The chat lives in the workbench and needs no terminal. Only in CI nobody waits for it.
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const canFix = withAgent && !noChat && !inCi;
    // Baselines are learned by every run outside CI, headless or in the window; a CI job only with --learn (its files are
    // usually gone after the job). open never learns.
    // A snapshot (caw design snapshot) only reads, like open.
    const learns = !handover && snapshot === undefined && (learn || !inCi);
    // Reject right away rather than run silently without advice: whoever passes --explain expects it.
    if (withAdvice && !withAgent) throw new CawError('usage', t('cli.adviseAgentOnly', { environments: agentEnvironments(config), target }));
    if (withAdvice && !canFix) throw new CawError('usage', t('cli.adviseNeedsChat'));
    // Nobody waits in CI: a handover would keep the job open until the runner times out.
    if (inCi && handover) throw new CawError('usage', t('cli.ciHandover', { option: 'open' }));
    if (!quiet) ui.head();
    if (!quiet) ui.info(runMode({ withAgent, noChat, headless, inCi, withAdvice, environments: agentEnvironments(config), env: target, language: teamLanguage(config), learn: learns, opened: handover, file: `${spec.draft === true ? DRAFT_DIR : RECORDING_DIR}/${test}.yaml` }));
    const { runFlow } = await import('./flows.mjs');
    // A draft in the window: the chat guides through the fix (red: fix it, test again; green: promote). Headless, CI and
    // promoting run it as before.
    const guiding = canFix && guided && !handover && entry === undefined && through === undefined && spec.draft === true;
    const { flowOf, reproductionOf } = await import('./bugfix.mjs');
    const runs = claudeRuns(root, config, { spec, checked, target, about: aboutRun(root, options, checked), ...(guiding ? { flow: flowOf(root, spec) } : {}), timeoutMin: timeoutMin ?? CLAUDE_TIMEOUT_MIN, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, conversation, headless, withDesign: design, ...(snapshot === undefined ? {} : { snapshot, command: 'open' }) });
    const { execute } = runs;
    // A design not met: "Open with design" opens the window at that step with the design beside the app, as open <test>@S<n>
    // --design does (the step passed its check, so it is played through), in this process with the chat so far.
    const openDesign = canFix && !handover ? async (step) => (await runOne(root, { ...options, target, entry: undefined, through: step, design: true, handover: true, learn: false, advise: false, headless: false, noChat: false, quiet: true, guided: false, conversation: runs.conversation }, deps)).code : undefined;
    const guide = guiding ? {
        env: target,
        cause: reproductionOf(root, spec.id)?.cause,
        changed: () => changedSinceRed(root, loadDraft(root, test).red, git),
        // The red proof as the file has it now: a run that proved it red first wrote it only after that run.
        promote: ({ runId }) => promoteGreen(root, { ...options, target }, deps, { config, test, target, red: loadDraft(root, test).red, report: posix.join(RUN_DIR, 'runs', runId, 'report.md') }),
    } : undefined;
    const tracker = changeTracker(root);
    let failed;
    let played;
    // Where the human can clarify the failure in the chat: the test's first environment Claude may work on.
    const claude = new Set(environmentsWith(config, 'agent'));
    const chatTarget = spec.runsOn.find((name) => claude.has(name));
    const code = await runFlow({
        spec,
        env: target,
        entry,
        through,
        handover,
        canFix,
        advise: withAdvice,
        // The developer's Claude Code session is there at once and costs nothing here: it may read the page in the state right away.
        sessionAgent: attach !== undefined || (agent === undefined && agentMode(config) === 'session'),
        reads: config.reads ?? [],
        fillBaselines: learns,
        openSandbox: () => openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent, attach }),
        execute,
        adopt: tracker.adopt,
        head: () => headOf(root, git),
        log: ui.info,
        guide,
        openDesign,
        server: lifecycle?.server,
        onPlayed: (result) => {
            played = result;
            failed = result.failed;
        },
        // Cause first, then change: `record <test>@<step>` re-records without looking for a cause, which only suits an intended change.
        // In the terminal the first line is labelled "next", the commands stand out.
        hint: (step, { canFix: hadChat }) => {
            if (!nextSteps) return;
            ui.next(failureHints(step, { hadChat, test, target, withAgent, chatTarget, environments: agentEnvironments(config), steps: spec.steps }));
        },
    });
    if (canFix || learns) ui.info(tracker.summary());
    // After the result, so the pending steps are not mistaken for a failure; a batch names them in its table instead.
    if (pending.length > 0 && !quiet) ui.info(pendingLine(pending, { test, target, verdict: played?.verdict }));
    // A draft proven red that passes now: the bug is fixed, promoting proves it against all other tests. A design draft once
    // its design is met after the check of its recorded step (a design shows the screen after its step).
    const green = !quiet && !handover && existsSync(draftPath(root, test)) ? draftGreenLine(spec, { code, verdict: played?.verdict, target, promoting: options.promote === true }) : undefined;
    if (green !== undefined) ui.info(green);
    // The batch reports carry the playback's verdict (diagnosis, steps) and its report.md.
    return { code, failed, verdict: played?.verdict, report: played?.report, pending };
};

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
// XML 1.0 forbids these control characters.
// eslint-disable-next-line no-control-regex
const xmlText = (text) => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&"']/g, (char) => XML_ESCAPES[char]);
/** A run's outcome by exit code, as the JSON report and an error without its own code name it. */
const STATUS = { [EXIT.pass]: 'pass', [EXIT.fail]: 'fail', [EXIT.error]: 'error', [EXIT.rejected]: 'rejected', [EXIT.needsRecording]: 'needs-recording' };
const LABELS = { [EXIT.pass]: 'pass', [EXIT.fail]: 'fail', [EXIT.error]: 'error', [EXIT.rejected]: 'rejected', [EXIT.needsRecording]: 'needsRecording' };
const statusLabel = (exit) => t(`cli.batchStatus.${LABELS[exit] ?? 'error'}`);
const firstLine = (text) => String(text ?? '').split('\n')[0];
/** The assessment as the report words it: "app bug (clear)"; unclear has no strength. */
const assessmentText = ({ side, strength }) => (side === 'unclear' ? t('config.diag.side.unclear') : `${t(`config.diag.side.${side}`)} (${t(`config.diag.${strength}`)})`);
/** One earlier or final attempt for system-out: "Attempt 1: ERROR, browser-closed, .caw/runs/…/report.md". */
const attemptLine = (attempt, index) => t('cli.attemptLine', {
    attempt: index + 1,
    status: statusLabel(attempt.exit),
    why: [attempt.side === undefined ? attempt.code : assessmentText(attempt), attempt.report].filter(Boolean).map((part) => `, ${part}`).join(''),
});

/** A test's warnings as lines: "Warning S2: <text>", "(2×)" when one came more than once. They change no verdict. */
const warningLines = (row) => (row.warnings ?? []).map(({ step, text, count = 1 }) => `${t(step === undefined ? 'cli.reportWarning' : 'cli.reportWarningAt', { step, text: firstLine(text) })}${count > 1 ? ` (${count}×)` : ''}`);
/** Which steps still learn their effects (a deviation of theirs fails nothing yet) and whether this run learned; or undefined. */
const learningLine = ({ learning }) => (learning === undefined ? undefined : [
    t('cli.reportLearning', { steps: learning.effects.map(({ id, runs }) => `${id} ${runs}/${learning.of}`).join(', ') }),
    ...(learning.learns ? [] : [t('cli.reportLearnsNot')]),
].join(' '));

/**
 * The run table as JUnit XML, as CI systems read it. A failed step is a failure typed by its assessment (app, environment, test,
 * unclear) with "S3: <reason>" as message and the findings as text; everything else that did not pass is an error typed by its
 * error code. Retried tests list every attempt in system-out. A pass with pending steps stays a pass and carries its note in
 * system-out: `<skipped>` would count the whole test as skipped, though its recorded steps ran and passed. Warnings and the
 * steps still learning their effects go into system-out too.
 */
export const junitXml = ({ target, rows }) => {
    const failures = rows.filter(({ exit }) => exit === EXIT.fail).length;
    const errors = rows.filter(({ exit }) => exit !== EXIT.fail && exit !== EXIT.pass).length;
    const time = rows.reduce((sum, { seconds = 0 }) => sum + seconds, 0).toFixed(3);
    const cases = rows.map((row) => {
        const { test, exit, seconds = 0, note = '', attempts = [] } = row;
        const open = `    <testcase classname="caw.${xmlText(target)}" name="${xmlText(test)}" time="${seconds.toFixed(3)}"`;
        const pendingNote = exit === EXIT.pass && (row.pending ?? []).length > 0 ? [note] : [];
        const lines = [...pendingNote, ...(attempts.length > 1 ? [row.retried, ...attempts.map(attemptLine)] : []), ...warningLines(row), learningLine(row)].filter((line) => line !== undefined);
        const out = lines.length > 0 ? [`      <system-out>${xmlText(lines.join('\n'))}</system-out>`] : [];
        if (exit === EXIT.pass) return out.length === 0 ? `${open}/>` : [`${open}>`, ...out, '    </testcase>'].join('\n');
        const failure = exit === EXIT.fail;
        const tag = failure ? 'failure' : 'error';
        // Without an assessment (no failed step was found) a failure is unclear; an error without a code is named by its exit.
        const type = failure ? row.side ?? 'unclear' : row.code ?? STATUS[exit] ?? 'error';
        const message = failure && row.step !== undefined ? `${row.step}: ${firstLine(row.reason)}` : note;
        const body = [...(failure && row.side !== undefined ? [row.assessment, ...(row.findings ?? [])] : []), row.report].filter(Boolean).join('\n');
        const element = `      <${tag} type="${xmlText(type)}" message="${xmlText(message)}"${body === '' ? '/>' : `>${xmlText(body)}</${tag}>`}`;
        return [`${open}>`, element, ...out, '    </testcase>'].join('\n');
    });
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites name="caw" tests="${rows.length}" failures="${failures}" errors="${errors}" time="${time}">`,
        `  <testsuite name="caw ${xmlText(target)}" tests="${rows.length}" failures="${failures}" errors="${errors}" skipped="0" time="${time}">`,
        ...cases,
        '  </testsuite>',
        '</testsuites>',
        '',
    ].join('\n');
};

// A table cell holds one line, and | would end the cell.
const cell = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|');

/**
 * The run table as Markdown, one line per test: result, failed step, assessment, first finding and report. Made to be appended
 * to a CI job summary ($GITHUB_STEP_SUMMARY).
 */
export const summaryMarkdown = ({ target, exit, rows }) => {
    const heads = t('cli.summary.columns').split(' | ');
    const lines = rows.map((row) => {
        const result = [statusLabel(row.exit), row.retried].filter(Boolean).join(' · ');
        const failure = row.exit === EXIT.fail && row.step !== undefined ? `${row.step}: ${firstLine(row.reason)}` : row.exit === EXIT.pass ? '' : row.note;
        let assessment = '';
        if (row.exit !== EXIT.pass) assessment = row.side === undefined ? row.code ?? '' : assessmentText(row);
        const report = row.report === undefined ? '' : `\`${row.report}\``;
        return `| ${[result, row.test, failure, assessment, row.findings?.[0] ?? '', report].map((text, index) => (index === 5 ? text : cell(text))).join(' | ')} |`;
    });
    // Below the table, one line each: what only warned and which steps still learn their effects.
    const oneLine = (text) => String(text).replace(/\s*\n\s*/g, ' ');
    const notes = rows.flatMap((row) => [
        ...(row.warnings ?? []).map(({ step, text, count = 1 }) => `- \`${oneLine(row.test)}\`${step === undefined ? '' : ` ${step}`}: ${oneLine(text)}${count > 1 ? ` (${count}×)` : ''}`),
        ...(row.learning === undefined ? [] : [`- \`${oneLine(row.test)}\`: ${learningLine(row)}`]),
    ]);
    return [
        `### ${cell(t('cli.summary.heading', { count: rows.length, target, exit }))}`,
        '',
        `| ${heads.join(' | ')} |`,
        `|${heads.map(() => ' --- ').join('|')}|`,
        ...lines,
        '',
        ...(notes.length === 0 ? [] : [`**${t('cli.summary.notes')}**`, '', ...notes, '']),
    ].join('\n');
};

/** The run table for machines: per test its outcome, the failed step with its assessment, the steps, the report and every attempt. */
export const reportJson = ({ target, startedAt, exit, rows }) => {
    const outcome = (row) => ({
        status: STATUS[row.exit] ?? 'error',
        exit: row.exit,
        ...(row.step === undefined ? {} : { failedStep: row.step, reason: row.reason }),
        ...(row.side === undefined ? {} : { side: row.side, strength: row.strength, findings: row.findings ?? [] }),
        ...(row.code === undefined ? {} : { code: row.code }),
    });
    const tests = rows.map((row) => ({
        id: row.test,
        ...outcome(row),
        seconds: Math.round((row.seconds ?? 0) * 1000) / 1000,
        steps: row.steps ?? [],
        ...((row.warnings ?? []).length === 0 ? {} : { warnings: row.warnings }),
        ...(row.learning === undefined ? {} : { learning: row.learning }),
        ...(row.report === undefined ? {} : { report: row.report }),
        attempts: (row.attempts ?? [row]).map((attempt) => ({ ...outcome(attempt), seconds: Math.round((attempt.seconds ?? 0) * 1000) / 1000, ...(attempt.report === undefined ? {} : { report: attempt.report }) })),
    }));
    return `${JSON.stringify({ target, startedAt, exit, tests }, null, 2)}\n`;
};

const REPORT_WRITTEN = { junit: 'cli.junitWritten', summary: 'cli.summaryWritten', json: 'cli.jsonWritten' };
/** A --report file inside the project only, also after links: a session passes --report through caw_start's args. */
const reportFile = (root, kind, given) => {
    const file = projectPath(root, given);
    if (file === null) throw new CawError('usage', t('cli.reportOutside', { kind, file: given }));
    return file;
};
const writeReport = (root, kind, given, text) => {
    const file = reportFile(root, kind, given);
    mkdirSync(dirname(file), { recursive: true });
    // Again after creating the folders: one of them may be a link out of the project.
    reportFile(root, kind, given);
    // A new file, not one a link points to.
    rmSync(file, { force: true });
    writeFileSync(file, text, { flag: 'wx' });
    ui.info(t(REPORT_WRITTEN[kind], { file: given }));
};

/**
 * Several tests one after another, for CI: no chat, one test does not abort the others, at the end the table and the exit code of
 * the worst run (see worstExit). Without --env the tests' only target applies.
 */
const runMany = async (root, options, deps) => {
    const known = testIds(root);
    let tests = options.all ? known : options.tests;
    const specs = new Map();
    const load = testLoader(root);
    for (const id of tests) {
        try {
            if (known.includes(id)) specs.set(id, load(id));
        } catch {
            // A broken file is reported as rejected by its own run.
        }
    }
    const target = chooseEnv(loadConfig(root), [...specs.values()], { env: options.target, command: 'run' });
    // --all: every test that runs on the environment; an unreadable one stays in and shows up as rejected.
    if (options.all) tests = tests.filter((id) => !specs.has(id) || (specs.get(id).runsOn ?? []).includes(target));
    if (tests.length === 0) throw new CawError('usage', t('cli.batchNone', { target }));
    if (options.batch) ui.info(`${t('cli.batchStart', { count: tests.length, target, headless: options.headless ? '' : t('cli.batchWindow') })}${urlLine(target)}`);
    return withLifecycle(lifecycleOf(root, loadConfig(root), target, options, 'run'), (lifecycle) => runBatch(root, { ...options, lifecycle }, deps, { tests, target }));
};

/**
 * One attempt of a test in a batch: exit, time, the failed step with its assessment or the error code, the steps and the report.
 * A failed reset ends the batch.
 */
const attemptTest = async (root, options, deps, { test, target }) => {
    const started = Date.now();
    const seconds = () => (Date.now() - started) / 1000;
    try {
        const { code: exit, failed, verdict, report, pending = [] } = await (deps.runOne ?? runOne)(root, { ...options, test, target, quiet: options.batch === true }, deps);
        const diagnosis = exit === EXIT.pass ? undefined : failed?.diagnosis;
        const step = exit === EXIT.pass ? undefined : failed?.id;
        const code = exit === EXIT.pass ? undefined : verdict?.code;
        return {
            exit,
            seconds: seconds(),
            note: step !== undefined ? t('cli.batchAt', { step }) : exit === EXIT.pass && pending.length > 0 ? t('cli.batchPending', { steps: stepRange(pending) }) : firstLine(code === undefined ? '' : verdict?.reason),
            pending,
            ...(step === undefined ? {} : { step, reason: failed.reason }),
            ...(diagnosis === undefined ? {} : { side: diagnosis.side, strength: diagnosis.strength, findings: diagnosis.findings ?? [], assessment: diagnosis.text }),
            ...(code === undefined ? {} : { code }),
            steps: (verdict?.steps ?? []).map(({ id, status, seconds: took }) => ({ id, status, ...(took === undefined ? {} : { seconds: took }) })),
            // What only warned (an effect that deviates in a list outside effects.fail, a design, a console error of a third party):
            // the verdict stays, the CI reports name them.
            warnings: (verdict?.warnings ?? []).map(({ type, step: at, text, count }) => ({ type, ...(at === undefined ? {} : { step: at }), text, count: count ?? 1 })),
            ...(report === undefined ? {} : { report }),
        };
    } catch (error) {
        if (error?.code === 'env-reset-failed') throw error;
        // As in bin/caw.mjs: an expected error by its code, an unexpected one is error.
        const known = error instanceof CawError;
        return { exit: known ? exitOf(error.code) : EXIT.error, seconds: seconds(), note: firstLine(error?.message ?? error), ...(known ? { code: error.code } : {}) };
    }
};

/**
 * Worth another attempt with --retry-env: an environment error (exit 2) or a failed step the diagnosis puts on the environment.
 * The exit code stays 1 for every failed step whatever the assessment: the diagnosis is a heuristic; it only decides the retry.
 */
const environmental = ({ exit, side }) => exit === EXIT.error || (exit === EXIT.fail && side === 'environment');

/**
 * The tests of a batch in a row, then table, the --report files and the worst exit code. With --retry-env a test that failed on
 * the environment runs again, at most that many times; its last attempt counts, every attempt is kept for the reports.
 */
const runBatch = async (root, options, deps, { tests, target }) => {
    const startedAt = new Date().toISOString();
    const rows = [];
    // As runOne decides it: outside CI every run learns, in CI only with --learn.
    const learns = options.learn === true || (deps.interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const { effectsLearning } = await import('./replay.mjs');
    const { LEARN_RUNS } = await import('./effects.mjs');
    /** The test's effects still being learned after its run (.caw/learning as the run left it), or undefined when none are. */
    const learningOf = (dir, test, env, learning) => {
        let effects;
        try {
            effects = effectsLearning(withLearning(dir, testLoader(dir)(test)), env);
        } catch {
            return undefined; // a test that does not load is reported as rejected by its own run
        }
        return effects.length === 0 ? undefined : { learns: learning, effects, of: LEARN_RUNS };
    };
    for (const test of tests) {
        const attempts = [];
        for (;;) {
            const attempt = await attemptTest(root, options, deps, { test, target });
            attempts.push(attempt);
            if (attempts.length > (options.retryEnv ?? 0) || !environmental(attempt)) break;
            ui.info(t('cli.retryEnv', { test, attempt: attempts.length }));
        }
        const last = attempts.at(-1);
        let retried = '';
        if (attempts.length > 1) retried = last.exit === EXIT.pass ? t('cli.retriedPass', { attempt: attempts.length }) : t('cli.retriedOther', { attempt: attempts.length });
        const seconds = attempts.reduce((sum, attempt) => sum + attempt.seconds, 0);
        const learning = learningOf(root, test, target, learns);
        rows.push({ test, ...last, seconds, note: [last.note, retried].filter(Boolean).join('; '), attempts, ...(retried === '' ? {} : { retried }), ...(learning === undefined ? {} : { learning }) });
    }
    ui.batch({ target, rows });
    const exit = worstExit(rows.map((row) => row.exit));
    const reports = options.reports ?? {};
    if (reports.junit !== undefined) writeReport(root, 'junit', reports.junit, junitXml({ target, rows }));
    if (reports.summary !== undefined) writeReport(root, 'summary', reports.summary, summaryMarkdown({ target, exit, rows }));
    if (reports.json !== undefined) writeReport(root, 'json', reports.json, reportJson({ target, startedAt, exit, rows }));
    return exit;
};

/**
 * `caw run`: one test as usual; several tests or --all run one after another without chat (runMany). With --report or
 * --retry-env a single test takes that path too, so CI always gets the files and the retry.
 * @param interactive   tests only: replaces CI detection
 * @param adviseCommand tests only: replaces Claude when advising
 * @param talkCommand   tests only: replaces Claude in the conversation
 * @param runOne        tests only: replaces one test's run in a batch
 */
export const run = async (root, args, deps = {}) => {
    const options = parseRunArgs('run', args);
    if (options.promote) return promote(root, options, deps);
    for (const [kind, given] of Object.entries(options.reports ?? {})) reportFile(root, kind, given);
    if (options.batch || options.reports !== undefined || options.retryEnv !== undefined) return runMany(root, options, deps);
    const { config, target } = loadChecked(root, options.test, options.target, 'run', { overlay: options.overlay, start: options.start });
    return withLifecycle(lifecycleOf(root, config, target, options, 'run'), async (lifecycle) => (await runOne(root, { ...options, target, lifecycle }, deps)).code);
};

/**
 * Do --role or --read-only contradict a test already in the file (e.g. described by Claude)? Repeated matching values are no
 * contradiction.
 */
export const contradicts = (spec, { role, readOnly = false }) => (role !== undefined && role !== spec.role)
    || (readOnly && spec.writes !== false);

/**
 * Re-records a test from a step to its end, always with chat: the steps before it replay without Claude, then Claude follows the
 * old plan from there, the human steers in the chat. Claude may add, remove, rename or reorder steps from there on; the steps
 * before stay as they are. Without a demonstration: it would start at the sign-in, not at the step.
 */
const recordFrom = async (root, options, deps = {}) => {
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = deps;
    const { test, step, target: given, timeoutMin, stepTimeoutSec, maxActions, agent, attach, overlay, start } = options;
    const { config, spec, target, checked } = loadChecked(root, test, given, 'record', { overlay, start });
    const position = spec.steps.findIndex(({ id }) => id === step);
    if (position === -1) throw stepUnknown('cli.recordStepUnknown', spec, step, { file: `${TEST_DIR}/${test}.yaml` });
    requireAgent(config, checked, target, t('cli.verbRecord'));
    requireHuman('record', interactive);
    // Before any Claude cost: the steps before must replay. The steps from here on may be stale or not recorded at all.
    const { assertPlayable } = await import('./replay.mjs');
    assertPlayable(spec, target, spec.steps[position - 1].id);
    return withLifecycle(lifecycleOf(root, config, target, options, 'record'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        requireTestUser(root, config, spec.role, target);
        const { fixFlow } = await import('./flows.mjs');
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent, attach });
        const { flowOf } = await import('./bugfix.mjs');
        const { execute, conversation } = claudeRuns(root, config, { spec, checked, target, about: aboutRun(root, options, checked), timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, conversation: options.conversation, ...(spec.draft === true ? { flow: flowOf(root, spec) } : {}) });
        return fixFlow({
            draft: spec,
            env: target,
            server: lifecycle?.server,
            target: { id: step, reason: t('cli.recordFromReason', { step }), rerecord: true, from: true },
            guide: await fixGuide(root, options, deps, { spec, target, lifecycle, conversation }),
            sandbox,
            execute,
            adopt: (draft, only, adoptOptions) => writeTest(root, draft, only, adoptOptions),
            head: () => headOf(root, deps.git),
            log: ui.info,
        });
    });
};

/**
 * Records a new test plan or replaces one, always with chat. `containerCommand` replaces Claude with a scripted flow so
 * the path through container, channel and browser can be tested without model or token. `<test>@S<n>` re-records from that
 * step to the end (recordFrom); at the first step that is the same as the whole test.
 */
export const record = async (root, args, deps = {}) => recordTest(root, parseRunArgs('record', args), deps);

/**
 * After a draft's red proof the guided bug fix tests again in a new window of this process: a run of the draft, with the chat
 * so far. Undefined for a test that is no draft.
 */
const fixGuide = async (root, options, deps, { spec, target, lifecycle, conversation }) => {
    if (spec.draft !== true) return undefined;
    const { reproductionOf } = await import('./bugfix.mjs');
    const { test, agent, attach, overlay, timeoutMin, maxActions, stepTimeoutSec } = options;
    const again = { ...parseRunArgs('run', [test]), target, lifecycle, conversation, stepTimeoutSec, ...(agent === undefined ? {} : { agent }), ...(attach === undefined ? {} : { attach }), ...(overlay === undefined ? {} : { overlay }), ...(timeoutMin === undefined ? {} : { timeoutMin }), ...(maxActions === undefined ? {} : { maxActions }) };
    return {
        env: target,
        cause: reproductionOf(root, spec.id)?.cause,
        fixNow: options.fixNow === true,
        rerun: async () => (await runOne(root, again, deps)).code,
    };
};

/**
 * `caw record` with parsed options.
 * @param options.fixNow the bug is fixed by the agent right after the test is created (the choice after reproducing)
 * @param options.conversation the chat so far, when the guided bug fix continues a reproduction in this process
 */
const recordTest = async (root, options, deps = {}) => {
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = deps;
    const { test, step, target: given, timeoutMin, stepTimeoutSec, maxActions, role, readOnly, agent, attach, overlay, start, headless = false, file } = options;
    // In CI nobody demonstrates or decides: said first, before --role or the environment. Without a window nobody is needed.
    if (!headless) requireHuman('record', interactive);
    const description = file === undefined ? undefined : readDescription(root, file);
    const config = loadConfig(root);
    // A draft in caw/drafts records like a test; its last step must then fail while the bug is there.
    const exists = testExists(root, test);
    // Without a window there is nobody to demonstrate, describe or steer a re-recording from a step: only a whole test with a plan.
    if (headless && (step !== undefined || !exists || loadTest(root, test).steps.length === 0)) throw new CawError('usage', t(step === undefined ? 'cli.recordHeadlessPlan' : 'cli.recordHeadlessStep', { command: `${cawCommand()} record ${test}${given === undefined ? '' : ` --env ${given}`}`, file: `${TEST_DIR}/${test}.yaml` }));
    if (step !== undefined) {
        if (!exists) throw testMissing(root, config, test, given);
        const known = withDefaults(loadTest(root, test), config);
        const position = known.steps.findIndex(({ id }) => id === step);
        if (position === -1) throw stepUnknown('cli.recordStepUnknown', known, step, { file: `${TEST_DIR}/${test}.yaml` });
        if (position > 0) return recordFrom(root, options, deps);
    }
    const known = exists ? withLearning(root, withDefaults(loadTest(root, test), config)) : null;
    const target = chooseEnv(config, known === null ? [] : [known], { env: given, command: 'record', writes: !readOnly });
    const spec = known ?? draftTest(root, config, { id: test, target, role, readOnly });
    if (exists && contradicts(spec, { role, readOnly })) throw new CawError('usage', t('cli.recordExists', { test }));
    return withLifecycle(lifecycleOf(root, config, target, options, 'record'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        const checked = checkTest(spec, target, config, { overlay, start });
        requireTestUser(root, config, spec.role, target);
        requireAgent(config, checked, target, t('cli.verbRecord'));
        const about = aboutRun(root, options, checked);

        const { recordFlow } = await import('./flows.mjs');
        // Before the demonstration: if Docker failed only afterwards, the human's work would be wasted.
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent, attach });
        const previous = exists ? spec : undefined;
        // Without a window, a person at this terminal answers a decision that needs one; in CI or started by a session nobody does.
        const terminal = headless ? deps.terminal ?? promptTerminal({ interactive }) : undefined;
        // A draft in the window is the guided fix: its own plan and its red proof change nothing the test checks, caw takes them
        // like a run without a window does; the person's clicks are fixing and adopting.
        const guidedDraft = spec.draft === true && !headless;
        const { flowOf } = await import('./bugfix.mjs');
        const { execute, conversation, undecided } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, previous, about, conversation: options.conversation, headless, ...(guidedDraft ? { autoDecide: ['plan.approve', 'red.proof'], flow: flowOf(root, spec) } : {}), ...(terminal === undefined ? {} : { terminal }) });
        if (headless) ui.info(t('cli.recordHeadless', { test, env: target }));
        // Driven from the developer's Claude Code session: it follows an existing test plan without asking the human first.
        // A new test without a plan still starts with the human's demonstration; without a window the agent follows the plan.
        // A draft follows its own plan (from reproduce or the person): nothing to show or describe first.
        // A description (--file) stands for what the person would describe in the chat: the plan comes from it.
        const described = description === undefined ? undefined : { items: descriptionItems(description) };
        const demonstration = described ?? (((attach !== undefined || (agent === undefined && agentMode(config) === 'session')) && exists) || headless || guidedDraft ? undefined : await startRecording(root, config, spec, checked, { exists, conversation }));
        const code = await recordFlow({
            sandbox,
            env: target,
            server: lifecycle?.server,
            execute: (call) => execute({ ...call, ...(call.replay === undefined && call.repair === undefined ? { demonstration } : {}) }),
            adopt: (draft, only, adoptOptions) => writeTest(root, draft, only, adoptOptions),
            // The steps the human ticked in the check run's card get look: true, after adopting.
            markLooks: (draft, steps) => setStepLooks(root, draft, steps),
            head: () => headOf(root, deps.git),
            log: ui.info,
            previous,
            // The guided bug fix needs a person: without a window a draft ends with its red proof saved.
            guide: headless ? undefined : await fixGuide(root, options, deps, { spec, target, lifecycle, conversation }),
        });
        // A decision only a person takes stopped the run: nothing was written, the decision is named.
        const open = undecided();
        if (open === undefined) return code;
        ui.next([{ text: t('cli.recordHeadlessOpen', { id: open.id, report: open.report, options: open.options.map(({ id, gate }) => `${id} (${gate})`).join(', ') }), commands: [`${cawCommand()} record ${test} --env ${target}`] }]);
        return EXIT.decision;
    });
};

/**
 * The git state for a draft's red proof: the checked-out commit and, when git gives them, the tracked files modified in the
 * working tree ({ head, dirty }); undefined outside a git repository.
 */
const headOf = (root, git) => {
    const used = git ?? gitDefault;
    try {
        const head = used.head(root);
        if (head === undefined || used.dirty === undefined) return head;
        return { head, dirty: used.dirty(root) };
    } catch (error) {
        if (error instanceof CawError) return undefined;
        throw error;
    }
};
const gitDefault = {
    head: (root) => shortHead(root),
    dirty: (root) => dirtyFiles(root),
    changedFiles: (root, since, dirty) => changedFiles(root, since, dirty),
    changedLines: (root, since, files) => changedLines(root, since, files),
};

/** The files changed since a red proof with their lines added and removed ([{ file, added?, removed? }]), null without git. */
const changedSinceRed = (root, red, git = gitDefault) => {
    if (red?.head === undefined) return null;
    try {
        const files = git.changedFiles(root, red.head, red.dirty ?? []);
        // Modified before the proof already: its lines since the commit are not the fix's alone.
        const dirty = new Set((red.dirty ?? []).map(({ file }) => file));
        const lines = git.changedLines?.(root, red.head, files.filter((file) => ![...dirty].some((path) => path === file || path.endsWith(`/${file}`)))) ?? new Map();
        return files.map((file) => ({ file, ...lines.get(file) }));
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        return null;
    }
};

/** A draft as a test for caw/tests: without the draft mark, its origin and the red proof. */
const asTest = ({ draft: _draft, origin: _origin, red: _red, ...test }) => test;

/** The run id of a report path `.caw/runs/<run>/report.md`. */
const runOf = (report) => basename(dirname(report));

/**
 * The fix report of a promoted draft: red at its step before (run, commit), green now (run), the files changed since the red
 * commit outside caw/ and .caw/, and how many other tests passed on the environment. Of a design draft (design: { file,
 * count? }) the design report: red with the design not met and its number of deviations in the red run, green with it met.
 */
export const fixReport = ({ id, red, green, target, others, changed, design, known }) => {
    const head = red.head ?? '–';
    let redLine = t('cli.fixReport.red', { step: red.step, run: red.run, head });
    if (design !== undefined) redLine = t(design.count === undefined ? 'cli.designReport.redUnknown' : 'cli.designReport.red', { step: red.step, design: design.file, count: design.count, run: red.run, head });
    const lines = [
        `# ${t(design === undefined ? 'cli.fixReport.title' : 'cli.designReport.title', { test: id })}`,
        '',
        `- ${redLine}`,
        `- ${t(design === undefined ? 'cli.fixReport.green' : 'cli.designReport.green', { run: green })}`,
        `- ${t('cli.fixReport.others', { count: others, target })}`,
        '',
        `## ${t('cli.fixReport.changed', { head: red.head ?? '–' })}`,
        '',
    ];
    if (changed === null) lines.push(t('cli.fixReport.changedUnknown'));
    else if (changed.length === 0) lines.push(t('cli.fixReport.changedNone'));
    else lines.push(...changed.map((file) => `- ${file}`));
    // What the red step knows from now on: the green run's messages instead of the bug's.
    if (known !== undefined) {
        const parts = [['knownAdded', known.added], ['knownDropped', known.dropped], ['knownKept', known.kept]].filter(([, messages]) => messages.length > 0);
        lines.push('', `## ${t('cli.fixReport.known', { step: known.step })}`, '');
        if (parts.length === 0) lines.push(t('cli.fixReport.knownNone'));
        else lines.push(...parts.map(([key, messages]) => `- ${t(`cli.fixReport.${key}`, { list: messages.join('; ') })}`));
    }
    return `${lines.join('\n')}\n`;
};

/**
 * The line after a run that ended before its pending steps: record them from the first, unless the run found that step not
 * ready yet (its needs, or its target design's controls at its entry, still missing; their own line said what).
 */
export const pendingLine = (pending, { test, target, verdict }) => {
    const [step] = pending;
    const needs = verdict?.needs?.step === step ? verdict.needs : undefined;
    const design = verdict?.pendingDesign?.step === step ? verdict.pendingDesign : undefined;
    const notReady = needs !== undefined ? needs.ready === false : design?.verdict === 'not-ready';
    return t(notReady ? 'cli.pendingStepsNotReady' : 'cli.pendingSteps', { ids: pending.join(', '), count: pending.length, test, step, target });
};

/**
 * The line after a green run of a draft proven red: the bug is fixed (a design draft: its design met after the check of its
 * recorded step), promote it. Not while promoting: that is the command it would name.
 * @returns the line, or undefined
 */
export const draftGreenLine = (spec, { code, verdict, target, promoting = false }) => {
    if (promoting || spec.draft !== true || spec.red === undefined || code !== EXIT.pass) return undefined;
    if (!isDesignDraft(spec)) return t('cli.draftGreen', { test: spec.id, step: spec.red.step, target });
    const recorded = spec.steps.find(({ id }) => id === spec.red.step)?.recording !== undefined;
    return recorded && designMet(spec, verdict) ? t('cli.designGreen', { test: spec.id, step: spec.red.step, target }) : undefined;
};

/**
 * The "next" lines after a failed step, without a chat that already led on. A step whose screen does not match its target design
 * is fixed in the app, never by recording it again: the hint names building and the comparison with the design (open --design).
 * @param step     the failed step: { id, kind? }
 * @param hadChat  the run had a chat that fixes, the failure was handled there
 * @returns [{ text, commands }] for ui.next
 */
export const failureHints = (step, { hadChat, test, target, withAgent, chatTarget, environments, steps }) => {
    const lines = [];
    const known = steps.some(({ id }) => id === step.id);
    if (step.kind === 'design') {
        const rerun = `${cawCommand()} run ${test} --env ${target}`;
        if (!hadChat) lines.push({ text: t('cli.failedHintDesign', { step: step.id, test, target }), commands: [rerun] });
        if (known) lines.push({ text: t('cli.untilHintDesign', { test, target, step: step.id }), commands: [`${cawCommand()} open ${test}@${step.id} --env ${target} --design`] });
        return lines;
    }
    const rerun = (env) => `${cawCommand()} run ${test} --env ${env}`;
    if (!hadChat) {
        if (withAgent) lines.push({ text: t('cli.failedHintAgent', { step: step.id, test, target }), commands: [rerun(target), `${cawCommand()} record ${test}@${step.id} --env ${target}`] });
        else if (chatTarget !== undefined) lines.push({ text: t('cli.failedHint', { step: step.id, test, target: chatTarget }), commands: [rerun(chatTarget)] });
        else lines.push({ text: t('cli.failedHintNoAgent', { step: step.id, environments }), commands: [] });
    }
    // open lands at the entry of the failed step: everything before it done, the step itself still open.
    if (known) lines.push({ text: t('cli.untilHint', { test, target, step: step.id }), commands: [`${cawCommand()} open ${test}@${step.id} --env ${target}`] });
    return lines;
};

/**
 * `caw run <draft> --promote`: the draft must pass (its red step green, the bug fixed) and so must every other test that runs
 * on the same environment (`run --all`). Then the test goes to caw/tests and caw/recordings, the draft is deleted and the
 * draft's run folder gets fix-report.md.
 * @param git tests only: { head(root), dirty?(root), changedFiles(root, since, dirty) }
 * @returns 0 promoted, 1 the draft or another test did not pass, 4 the draft is not recorded or never proven red
 */
const promote = async (root, options, deps) => {
    const { test } = options;
    if (!existsSync(draftPath(root, test))) throw new CawError('usage', t('cli.promoteNoDraft', { test, dir: DRAFT_DIR }));
    // A test of the same name would be overwritten: that stays the human's decision.
    if (existsSync(testPath(root, test))) throw new CawError('usage', t('cli.promoteExists', { test, file: `${TEST_DIR}/${test}.yaml` }));
    const { config, spec, target } = loadChecked(root, test, options.target, 'run', { overlay: options.overlay, start: options.start });
    if (spec.steps.length === 0 || staleSteps(spec).length > 0) {
        ui.warn(t('cli.promoteNotRecorded', { test }));
        return EXIT.needsRecording;
    }
    const design = isDesignDraft(spec);
    if (spec.red === undefined) {
        ui.warn(t(design ? 'cli.promoteDesignNotRed' : 'cli.promoteNotRed', { test }));
        return EXIT.needsRecording;
    }
    const red = { ...spec.red };
    const played = await withLifecycle(lifecycleOf(root, config, target, options, 'run'), async (lifecycle) => (deps.runOne ?? runOne)(root, { ...options, target, lifecycle, guided: false }, deps));
    // A design draft adopts only with its design met: with design.fail without target a design not met passes the run.
    if (played.code !== EXIT.pass || (design && !designMet(spec, played.verdict))) {
        ui.warn(t(design ? 'cli.promoteDesignNotMet' : 'cli.promoteDraftFailed', { test, step: red.step }));
        return EXIT.fail;
    }
    const promoted = await promoteGreen(root, options, deps, { config, test, target, red, report: played.report });
    return promoted.ok ? EXIT.pass : EXIT.fail;
};

/**
 * The part of promoting after the draft's green run: every other test on the environment (`run --all`) must pass, then the
 * draft moves to caw/tests and the green run's folder gets fix-report.md. The guided bug fix calls it from the green run's chat.
 * @param red    the draft's red proof
 * @param report the green run's report.md, relative to the project
 * @returns { ok: true, test, files, report, others } or { ok: false, reason }
 */
const promoteGreen = async (root, options, deps, { config, test, target, red, report }) => {
    const refused = (reason) => {
        ui.warn(reason);
        return { ok: false, reason };
    };
    if (existsSync(testPath(root, test))) return refused(t('cli.promoteExists', { test, file: `${TEST_DIR}/${test}.yaml` }));
    // The other tests on the same environment, as `run --all` picks them.
    const load = testLoader(root);
    const others = testIds(root).filter((id) => {
        try {
            return (load(id).runsOn ?? []).includes(target);
        } catch {
            // An unreadable test counts: run --all reports it as rejected.
            return true;
        }
    });
    if (others.length > 0) {
        const code = await runMany(root, { ...options, promote: false, test: undefined, tests: [], all: true, batch: true, noChat: true, target, guided: false, conversation: undefined }, deps);
        if (code !== EXIT.pass) return refused(t('cli.promoteOthersFailed', { test, target }));
    }
    // The draft as the green run left it, learned baselines included, becomes the test; red stays in the fix report only.
    const loaded = loadDraft(root, test);
    const design = isDesignDraft(loaded) ? { file: loaded.steps.find(({ id }) => id === red.step)?.design, ...redDeviations(root, red) } : undefined;
    // The red recording knew the bug's messages: the red step knows what the green run showed there instead.
    const { draft, known } = withGreenKnown(loaded, red.step, greenMessages(root, report, red.step));
    const written = writeTest(root, withLearning(root, asTest(draft)));
    rmSync(draftPath(root, test));
    const git = deps.git ?? gitDefault;
    let changed = null;
    if (red.head !== undefined) {
        try {
            changed = git.changedFiles(root, red.head, red.dirty ?? []);
        } catch (error) {
            if (!(error instanceof CawError)) throw error;
        }
    }
    const runDir = dirname(join(root, report));
    const text = inLanguage(teamLanguage(config), () => fixReport({ id: test, red, green: runOf(report), target, others: others.length, changed, ...(design === undefined ? {} : { design }), ...(known === undefined ? {} : { known }) }));
    const name = design === undefined ? FIX_REPORT : DESIGN_REPORT;
    writeFileSync(join(runDir, name), text);
    const shownReport = posix.join(dirname(report), name);
    ui.success(t(design === undefined ? 'cli.promoted' : 'cli.designAdopted', { test, files: written, report: shownReport }));
    return { ok: true, test, files: written, report: shownReport, others: others.length, target };
};

/**
 * The messages and status notes the green run showed at a step (result.json steps[].messages), or undefined when the run did not
 * keep them (production, a run before they were kept).
 */
const greenMessages = (root, report, step) => {
    try {
        const result = JSON.parse(readFileSync(join(root, dirname(report), 'result.json'), 'utf8'));
        const shown = (Array.isArray(result.steps) ? result.steps : []).find((item) => item?.id === step)?.messages;
        return Array.isArray(shown) && shown.every((message) => typeof message === 'string') ? shown : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The draft whose red step knows what the green run showed there (`known` of its recording): the bug's messages go, the fixed
 * app's come. A message a pattern in knownMessages covers stays out, as when recording.
 * @returns { draft, known?: { step, added, dropped, kept } } for the report; without `shown` the draft as it is
 */
export const withGreenKnown = (draft, step, shown) => {
    const at = draft.steps.findIndex(({ id }) => id === step);
    const recording = draft.steps[at]?.recording;
    if (shown === undefined || recording === undefined) return { draft };
    const covered = textMatcher((draft.knownMessages ?? []).filter((entry) => typeof entry !== 'string'));
    const now = [...new Set(shown)].filter((message) => !covered(message)).sort();
    const before = (recording.known ?? []).filter((entry) => typeof entry === 'string');
    const rest = { ...recording };
    delete rest.known;
    const steps = draft.steps.map((item, index) => (index === at ? { ...item, recording: now.length === 0 ? rest : { ...rest, known: now } } : item));
    return {
        draft: { ...draft, steps },
        known: { step, added: now.filter((message) => !before.includes(message)), dropped: before.filter((message) => !now.includes(message)), kept: now.filter((message) => before.includes(message)) },
    };
};

/** How many deviations the red run of a design draft judged at its red step: { count }, or {} once its run folder is gone. */
const redDeviations = (root, red) => {
    try {
        const judged = designOf(JSON.parse(readFileSync(join(root, RUN_DIR, 'runs', red.run, 'result.json'), 'utf8')), red.step);
        return judged === undefined ? {} : { count: deviationsOf(judged).length };
    } catch {
        return {};
    }
};

/** The name a reproduction runs under: report and window title. */
const REPRODUCE_ID = 'reproduce';

/**
 * caw reproduce "<bug report>": Claude reproduces a bug on its own, signed in as a test role, optionally from a test's state
 * (--from <test>[@<step>]). Only on environments with claude, never on production; without writable every write request is
 * blocked. No plan, no decisions, no code change; the run folder gets the report, caw/drafts a draft when reproduced, caw/tests nothing.
 * @returns 0 reproduced, 1 not reproduced or unclear, 2 environment error, 3 invalid input
 */
export const reproduce = async (root, args, deps = {}) => {
    const { parseReproduceArgs } = await import('./reproduce.mjs');
    const options = parseReproduceArgs(args, { root, ...(deps.readStdin === undefined ? {} : { readStdin: deps.readStdin }) });
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen } = deps;
    const config = loadConfig(root);
    // With a window outside CI the chat guides on: reproduced, a card asks whether to create the test next, in this process.
    const guided = !options.headless && (deps.interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    let known = null;
    if (options.from !== undefined) {
        const { test, step } = options.from;
        if (!existsSync(testPath(root, test))) throw testMissing(root, config, test, options.target);
        known = withDefaults(loadTest(root, test), config);
        if (step !== undefined && !known.steps.some(({ id }) => id === step)) throw stepUnknown('cli.stepUnknown', known, step);
    }
    // The role: the test's, the one given, or the only one; several without a choice are a question for the human.
    const roles = Object.keys(config.roles ?? {});
    const role = known?.role ?? options.role ?? (roles.length === 1 ? roles[0] : undefined);
    if (role === undefined && roles.length > 1) throw new CawError('usage', t('cli.reproduceRoles', { roles: roles.join(', ') }));
    if (options.role !== undefined && config.roles !== undefined && !roles.includes(options.role)) throw new CawError('usage', t('cli.reproduceRoles', { roles: roles.join(', ') }));
    const allowed = environmentsWith(config, 'agent').filter((name) => effectiveEnvironment(config, name).production !== true);
    if (options.target !== undefined && !allowed.includes(options.target) && config.environments?.[options.target] !== undefined) {
        throw new CawError('reproduce-not-allowed', t('cli.reproduceNotAllowed', { target: options.target, environments: allowed.join(', ') || t('cli.noEnvironment') }));
    }
    const target = chooseEnv(config, known === null ? [] : [known], { env: options.target, command: 'reproduce' });
    const env = effectiveEnvironment(config, target);
    if (env.agent !== true || env.production === true) {
        throw new CawError('reproduce-not-allowed', t('cli.reproduceNotAllowed', { target, environments: allowed.join(', ') || t('cli.noEnvironment') }));
    }
    const writable = env.writable === true;
    const spec = known ?? { id: REPRODUCE_ID, ...(role === undefined ? {} : { role }), writes: writable, notes: '', steps: [], expectations: [] };
    if (known !== null) {
        const { assertPlayable } = await import('./replay.mjs');
        const position = options.from.step === undefined ? known.steps.length : known.steps.findIndex(({ id }) => id === options.from.step);
        if (position > 0) assertPlayable(known, target, known.steps[position - 1].id);
    }
    return withLifecycle(lifecycleOf(root, config, target, {}, 'reproduce'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        // Without writable the browser blocks every write request like on production, also on the way to the state.
        const checked = { ...checkTest(spec, target, config, {}), ...(writable ? {} : { blockWrites: true }) };
        requireTestUser(root, config, spec.role, target);
        requireAgent(config, checked, target, t('cli.verbReproduce'));
        ui.info(t('cli.reproduceStart', { env: target, role: spec.role ?? '-', writes: t(writable ? 'cli.reproduceWrites' : 'cli.reproduceReadOnly') }));
        const { replayOf, replayToEntry } = await import('./replay.mjs');
        const prefix = known === null ? undefined : options.from.step === undefined ? replayOf(known) : replayToEntry(known, options.from.step, { reads: config.reads ?? [] });
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent: options.agent, attach: options.attach });
        const { bugTitle } = await import('./bugfix.mjs');
        const { creates, decideReproduced, fixesNow } = await import('./flows.mjs');
        const { execute, conversation } = claudeRuns(root, config, { spec, checked, target, timeoutMin: CLAUDE_TIMEOUT_MIN, stepTimeoutSec: 30, containerCommand, adviseCommand, talkCommand, onChatOpen, ...(guided ? { flow: { kind: 'fix', title: bugTitle(options.bug) } } : {}) });
        let choice = null;
        const result = await execute({
            sandbox,
            headless: options.headless,
            // With a window the chat shows what the agent does; reproduced, its card asks whether to create the test.
            ...(options.headless ? {} : { conversation }),
            ...(guided ? {
                conclude: async ({ verdict, chat }) => {
                    const draft = verdict.reproduce?.draft;
                    if (draft === undefined) return undefined;
                    choice = await decideReproduced(chat, { test: basename(draft.file, '.yaml'), outcome: verdict.reproduce });
                    if (creates(choice)) return { next: 'record' };
                    return choice === null ? undefined : { outcome: t('run.guide.later', { command: draft.record }) };
                },
            } : {}),
            reproduce: {
                bug: options.bug,
                writes: writable,
                ...(options.ref === undefined ? {} : { ref: options.ref }),
                ...(prefix === undefined ? {} : { prefix }),
                ...(options.from === undefined ? {} : { from: options.from }),
            },
        });
        const outcome = result.verdict?.reproduce;
        if (outcome?.draft !== undefined) ui.info(t('cli.reproduceDraft', outcome.draft));
        if (!creates(choice) || outcome?.draft === undefined) return result.exitCode;
        // The test is created next, as `caw record <draft>` would, with the chat so far; the choice stays in this process.
        const id = basename(outcome.draft.file, '.yaml');
        return recordTest(root, { ...parseRunArgs('record', [id]), target, conversation, fixNow: fixesNow(choice), ...(options.agent === undefined ? {} : { agent: options.agent }), ...(options.attach === undefined ? {} : { attach: options.attach }) }, deps);
    });
};

/** The name open runs under: report and window title. A test of that name stays untouched, open reads and writes none. */
const OPEN_ID = 'open';

/**
 * Opens the application logged in: workbench with chat, for navigating and developing. Without a test just signed in on the
 * app's start page; with --overlay on local code. `open <test>` replays the whole test first, `open <test>@S<n>` the steps
 * before S<n> and the entry of S<n> (replayToEntry). Learns nothing and writes no test file.
 */
export const open = async (root, args, deps = {}) => {
    const options = parseRunArgs('open', args);
    requireHuman('open', deps.interactive);
    if (options.test !== undefined) {
        const { config, target } = loadChecked(root, options.test, options.target, 'run', { overlay: options.overlay, start: options.start });
        // --design: through the step, so its screen is reached, with the design over it; a pending step has no screen yet, so
        // it opens at its entry as without --design.
        const spec = options.design === true && options.step !== undefined ? loadTest(root, options.test) : null;
        const through = spec?.steps.find(({ id }) => id === options.step)?.recording === undefined ? undefined : options.step;
        const runOptions = { ...options, target, ...(through === undefined ? { entry: options.step } : { through }), handover: true, learn: false, advise: false, headless: false, noChat: false };
        return withLifecycle(lifecycleOf(root, config, target, options, 'open'), async (lifecycle) => (await runOne(root, { ...runOptions, lifecycle }, deps)).code);
    }
    const config = loadConfig(root);
    const target = chooseEnv(config, [], { env: options.target, command: 'open' });
    // No test file, so no runsOn from loading one: the session runs on the chosen environment only.
    const spec = { ...draftTest(root, config, { id: OPEN_ID, target, role: options.role, readOnly: true }), runsOn: [target] };
    return withLifecycle(lifecycleOf(root, config, target, options, 'open'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        const checked = checkTest(spec, target, config, { overlay: options.overlay, start: options.start });
        requireTestUser(root, config, spec.role, target);
        const runOptions = { ...options, test: spec.id, handover: true, learn: false, advise: false, headless: false, noChat: false, quiet: true };
        return (await runOne(root, runOptions, deps, { config, spec, target, checked })).code;
    });
};

/**
 * `caw design snapshot <test>@S<n> [--env e] [--name n]`: plays the test headless to the entry of the step, like open <test>@S<n>
 * but without window, chat or learning, and writes the screen as a design page design/<n>.html (default <test>-S<n>) with the
 * app's stylesheets and the files they need under design/assets/<n>/ (design-snapshot.mjs). Only reads the app; whoever drafts
 * starts from it and adds what is new with the app's own classes. --json: one JSON line with the result (caw_design snapshot).
 * @returns 0 written, 1 the way to the step failed, 2 the snapshot could not be written, 3 invalid input
 */
export const design = async (root, args, deps = {}) => {
    const [action, ...rest] = args;
    if (action !== 'snapshot') throw new CawError('usage', t('cli.designAction', { action: action ?? '' }));
    const options = parseRunArgs('design', rest);
    if (options.step === undefined) throw new CawError('usage', t('cli.designSnapshotStep', { test: options.test }));
    const { assetsDirOf, snapshotName, snapshotOf, writeSnapshot } = await import('./design-snapshot.mjs');
    const name = options.name ?? `${options.test}-${options.step}`;
    const file = snapshotName(name);
    if (file === null) throw new CawError('usage', t('cli.designSnapshotName', { name }));
    const { config, spec, target } = loadChecked(root, options.test, options.target, 'run', { overlay: options.overlay, start: options.start });
    if (!spec.steps.some(({ id }) => id === options.step)) throw stepUnknown('cli.stepUnknown', spec, options.step);
    // A snapshot lands in caw/design, in the repository: never one of production, whose screens hold real data.
    if (effectiveEnvironment(config, target).production) throw new CawError('env-denied', t('cli.designSnapshotProduction', { target }));
    const cawDir = join(root, PROJECT_DIR);
    // A design a step links is what that step is judged against: replacing it is the person's decision, said with --replace.
    if (options.replace !== true && existsSync(join(cawDir, ...file.split('/')))) {
        const linked = [...testIds(root).map((id) => [id, () => loadTest(root, id)]), ...draftIds(root).map((id) => [id, () => loadDraft(root, id)])].flatMap(([id, load]) => {
            try {
                return load().steps.filter((step) => step.design === file).map((step) => `${id} ${step.id}`);
            } catch {
                return [];
            }
        });
        if (linked.length > 0) throw new CawError('usage', t('cli.designSnapshotReplace', { file: `${PROJECT_DIR}/${file}`, steps: linked.join(', ') }));
    }
    let written;
    let failure;
    const snapshot = async ({ page, secrets }) => {
        try {
            const taken = await snapshotOf(page, file, { secrets });
            written = { ...writeSnapshot(cawDir, file, taken), notes: taken.notes };
        } catch (error) {
            failure = error;
        }
    };
    const runOptions = { ...options, target, entry: options.step, headless: true, noChat: true, learn: false, advise: false, handover: false, guided: false, nextSteps: false, snapshot };
    const played = await withLifecycle(lifecycleOf(root, config, target, options, 'open'), async (lifecycle) => (deps.runOne ?? runOne)(root, { ...runOptions, lifecycle }, deps));
    const assets = `${PROJECT_DIR}/${assetsDirOf(file)}/`;
    let result;
    if (written !== undefined) {
        result = { ok: true, file: `${PROJECT_DIR}/${file}`, design: file, ...(written.assets > 0 ? { assets } : {}), bytes: written.bytes, files: written.assets, assetBytes: written.assetBytes, replaced: written.replaced, notes: written.notes, test: options.test, step: options.step, env: target, report: played.report };
        ui.success(t('cli.designSnapshotWritten', { file: result.file, count: result.files, assets }));
        for (const note of written.notes) ui.info(t(`cli.designSnapshotNote.${note.kind}`, { detail: note.detail }));
    } else {
        const why = failure?.message ?? t('cli.designSnapshotNotReached', { test: options.test, step: options.step, report: played.report ?? '' });
        result = { ok: false, test: options.test, step: options.step, env: target, reason: why, report: played.report };
        ui.warn(why);
    }
    if (options.json === true) process.stdout.write(`${JSON.stringify(result)}\n`);
    if (written !== undefined) return EXIT.pass;
    if (failure !== undefined) return EXIT.error;
    return played.code === EXIT.pass ? EXIT.fail : played.code;
};
