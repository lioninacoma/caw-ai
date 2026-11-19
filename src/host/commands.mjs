// The host commands. init and validate need neither browser code nor Docker.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_DIR, FRAMEWORK_NAMES, TODO, agentMode, browserLaunch, environmentsWith, isLoopback, loadConfig, isStartPath, productionLike, loadConfigWithNotes, navigationHosts, sessionPath, todoFields } from '../shared/config.mjs';
import { credentialNames } from '../shared/credentials.mjs';
import { NAME, blockedHosts, chooseEnvironment, effectiveEnvironment, environmentCandidates, startPath, usesCredentials, usesTotp } from '../shared/environments.mjs';
import { CawError, EXIT, exitOf, worstExit } from '../shared/errors.mjs';
import { language, t, teamLanguage } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, ENV_FILE, PROJECT_DIR, RECORDING_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { closest } from '../shared/suggest.mjs';
import { createUi } from '../shared/ui.mjs';
import { selectDocker } from './docker.mjs';
import { DEFAULT_MAX_ACTIONS } from './step-budget.mjs';
import { CLAUDE_TIMEOUT_MIN, optionValue, parseRunArgs, toWslPath } from './linux.mjs';
import { EXPLORE_FILE, explore } from './explore.mjs';
import { environmentLifecycle } from './lifecycle.mjs';
import { maskArgs, parseJsonc, projectImage, renderDockerfile, templatePath, toolFingerprint } from './sandbox-config.mjs';
import { describeCode } from './code-source.mjs';
import { ignoreAuthDir, requireTestUser } from './test-users.mjs';
import { ensureMcpEntry } from './mcp-entry.mjs';
import { projectPath } from './project-path.mjs';
import { brokenChain, checkTest, environmentProblems, loadTest, recordingHints, staleSteps, testPath, withDefaults, writeTest } from './test-file.mjs';

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
    const flags = productionLike(envName) ? { production: true } : isLoopback(hostname) ? { claude: true, writable: true } : { claude: true, writable: false };
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
    for (const file of files) {
        try {
            // Description plus recording from caw/recordings; loadTest reports a mismatching id.
            const spec = withDefaults(loadTest(root, file.slice(0, -'.yaml'.length)), config);
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
            else for (const { id, why } of stale) hints.push(`${file}: ${id} ${why}.`);
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
        `caw record ${id}`,
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
    if (!existsSync(testPath(root, id))) throw testMissing(root, config, id, given);
    const spec = withDefaults(loadTest(root, id), config);
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

/** How far a test is recorded: recorded, stale (with the steps) or none. */
const recordingState = (spec) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) return { state: 'none', ids: [] };
    const stale = staleSteps(spec).map(({ id }) => id);
    const chain = brokenChain(spec);
    if (stale.length === 0 && chain === null) return { state: 'recorded', ids: [] };
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
        if (!existsSync(testPath(root, test))) {
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
        out(t('cli.listTestHead', { test: spec.id, start: startPath(displayConfig(root), spec), role: spec.role ?? '–', environments: (spec.runsOn ?? spec.environments ?? []).join(', '), writes: writesText(spec) }));
        const rows = spec.steps.map((step) => {
            let state = 'cli.listStepRecorded';
            if (step.recording === undefined) state = 'cli.listStepNotRecorded';
            else if (stale.has(step.id)) state = 'cli.listStepStale';
            return [`  ${step.id}`, step.name ?? '', `(${t(state)})`];
        });
        if (rows.length > 0) columns(rows).forEach((line) => out(line));
        const chain = brokenChain(spec);
        if (chain !== null) out(`  ${t('cli.validateChain', { file: `${TEST_DIR}/${test}.yaml`, chain })}`);
        return EXIT.pass;
    }
    const ids = testIds(root);
    if (ids.length === 0) {
        out(t('cli.listNone', { dir: TEST_DIR }));
        return EXIT.pass;
    }
    const invalid = [];
    const load = testLoader(root);
    const rows = ids.map((id) => {
        try {
            const spec = load(id);
            const { state, ids: staleIds, chain } = recordingState(spec);
            let text = t('cli.listRecorded');
            if (state === 'none') text = t('cli.listNotRecorded');
            else if (state === 'stale') text = t('cli.listStale', { ids: staleIds.join(', ') || chain });
            return [id, (spec.runsOn ?? spec.environments ?? []).join(', '), text, writesText(spec)];
        } catch (error) {
            // The table stays narrow, the reason goes below it; validate lists all findings.
            invalid.push(`${id}: ${String(error.message).split('\n')[0]}`);
            return [id, '', t('cli.listInvalid'), ''];
        }
    });
    columns([t('cli.listHead').split('|'), ...rows]).forEach((line) => out(line));
    invalid.forEach((line) => out(line));
    return EXIT.pass;
};
/** The environments Claude may work on, as text: "dev" or "dev, local". */
const agentEnvironments = (config) => environmentsWith(config, 'claude').join(', ') || t('cli.noEnvironment');

/** Claude only works on environments with `claude`: the others are meant to fail when something is off. */
const requireAgent = (config, checked, target, verb) => {
    if (!checked.claude) throw new CawError('write-protected', t('cli.agentOnly', { verb, environments: agentEnvironments(config), target, environment: checked.environment }));
};

/**
 * Where Claude runs. Locally (default) it only needs Claude Code on the PATH; with Docker also token and image. Scripted flows
 * instead of Claude need neither Claude Code nor a token.
 */
const openSandbox = async (root, { config, containerCommand, adviseCommand, talkCommand, docker: chosenDocker, agent }) => {
    const scripted = containerCommand !== undefined || adviseCommand !== undefined || talkCommand !== undefined;
    const inCi = process.env.CI !== undefined && process.env.CI !== '';
    if (agent !== undefined && agent !== 'docker' && inCi) throw new CawError('usage', t('cli.agentNotInCi', { agent }));
    const mode = agent ?? agentMode(config);
    if (mode === 'session') {
        ui.info(t('cli.sessionAgent'));
        return { kind: 'session', label: t('cli.sessionLabel') };
    }
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
/**
 * A native dialog of the app during a demonstration: the chat shows its text with OK and Cancel (an alert only OK); for a prompt
 * the human may type the value. @returns { accept, value? }, or null when the chat is gone (the dialog is then dismissed)
 */
const askDialog = async (chat, { type, message, defaultValue }) => {
    if (type === 'prompt') {
        const answer = await chat.choose('discussing', t('cli.dialogPrompt', { message, value: defaultValue ?? '' }), [DIALOG_OK(), DIALOG_CANCEL()]);
        if (answer === null) return null;
        if (typeof answer === 'object') return { accept: true, value: answer.message };
        return answer === 'ok' ? { accept: true, value: defaultValue ?? '' } : { accept: false };
    }
    const answer = await chat.choose('deciding', t(type === 'beforeunload' ? 'cli.dialogLeave' : 'cli.dialogAsks', { message }), type === 'alert' ? [DIALOG_OK()] : [DIALOG_OK(), DIALOG_CANCEL()]);
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
    await session.workbench?.settings?.(benchSettings({ root, config, spec, checked }));
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
            let question = t('cli.questionNew', { id: spec.id });
            if (recorded) question = t('cli.questionRecorded', { id: spec.id });
            else if (exists) question = t('cli.questionDescribed', { id: spec.id });
            const choice = await Promise.race([chat.choose('choosing', question, options), session.closed.then(() => null)]);
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
const claudeRuns = (root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, ...rest }) => {
    const conversation = { transcript: [], onChatOpen };
    return {
        conversation,
        execute: async ({ lazyChat, testing, ...options }) => {
            const { executeRun } = await import('./run.mjs');
            return executeRun(root, config, options.sandbox ?? null, {
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
    // open never learns; a run learns only with --learn (Q7), and then names the file it may change.
    const learns = learn && !opened ? t('cli.modeLearnsYes', { file }) : t('cli.modeLearnsNo');
    return t('cli.modeLine', { env, language: team, how, learns });
};

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
 * tokens. --no-chat runs as in CI, --headless additionally without a window. --learn writes missing baselines in every mode.
 * @param quiet in a batch: no mode line, the batch prints it once
 * @returns { code, failed } with the failed step ({ id, reason }), if one failed
 */
const runOne = async (root, options, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}, loaded = undefined) => {
    const { test, handover = false, stepTimeoutSec, entry, advise: withAdvice, headless, noChat, learn = false, agent, timeoutMin, maxActions, overlay, start, lifecycle, quiet = false } = options;
    const { config, spec, target, checked } = loaded ?? loadChecked(root, test, options.target, 'run', { overlay, start });
    const position = entry === undefined ? -1 : spec.steps.findIndex(({ id }) => id === entry);
    if (entry !== undefined && position === -1) throw stepUnknown('cli.stepUnknown', spec, entry);
    const { assertPlayable } = await import('./replay.mjs');
    // open without a test has no steps: nothing to play back, just log in and hand over. At the entry of a step the steps before
    // it must be playable; the step itself only leads in, and if it is stale, nothing of it runs.
    if (loaded === undefined && entry === undefined) assertPlayable(spec, target);
    else if (loaded === undefined && position > 0) assertPlayable(spec, target, spec.steps[position - 1].id);
    // The environment's reset before the first writing test (or the first test with --reset), before anything signs in.
    await lifecycle?.beforeTest(spec);
    // A missing test user stops the run here, before Chrome or Claude start.
    requireTestUser(root, config, spec.role, target);
    const withAgent = checked.claude;
    // The chat lives in the workbench and needs no terminal. Only in CI nobody waits for it.
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const canFix = withAgent && !noChat && !inCi;
    // Reject right away rather than run silently without advice: whoever passes --explain expects it.
    if (withAdvice && !withAgent) throw new CawError('usage', t('cli.adviseAgentOnly', { environments: agentEnvironments(config), target }));
    if (withAdvice && !canFix) throw new CawError('usage', t('cli.adviseNeedsChat'));
    // Nobody waits in CI: a handover would keep the job open until the runner times out.
    if (inCi && handover) throw new CawError('usage', t('cli.ciHandover', { option: 'open' }));
    if (!quiet) ui.info(runMode({ withAgent, noChat, headless, inCi, withAdvice, environments: agentEnvironments(config), env: target, language: teamLanguage(config), learn, opened: handover, file: `${RECORDING_DIR}/${test}.yaml` }));
    const { runFlow } = await import('./flows.mjs');
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin: timeoutMin ?? CLAUDE_TIMEOUT_MIN, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, headless });
    const tracker = changeTracker(root);
    let failed;
    // Where the human can clarify the failure in the chat: the test's first environment Claude may work on.
    const claude = new Set(environmentsWith(config, 'claude'));
    const chatTarget = spec.runsOn.find((name) => claude.has(name));
    const code = await runFlow({
        spec,
        entry,
        handover,
        canFix,
        advise: withAdvice,
        // The developer's Claude Code session is there at once and costs nothing here: it may read the page in the state right away.
        sessionAgent: (agent ?? agentMode(config)) === 'session',
        reads: config.reads ?? [],
        // Only with --learn, in every mode (SC-21): otherwise a run never changes tracked files on its own (Q7). With chat the end
        // card offers to learn this run's baselines instead.
        fillBaselines: learn && !handover,
        offerLearning: canFix && !learn && !handover,
        openSandbox: () => openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent }),
        execute,
        adopt: tracker.adopt,
        log: ui.info,
        onPlayed: (played) => { failed = played.failed; },
        // Cause first, then change: `record <test>@<step>` re-records without looking for a cause, which only suits an intended change.
        hint: (step, { canFix: hadChat }) => {
            if (!hadChat) {
                if (withAgent) ui.info(t('cli.failedHintAgent', { step: step.id, test, target }));
                else if (chatTarget !== undefined) ui.info(t('cli.failedHint', { step: step.id, test, target: chatTarget }));
                else ui.info(t('cli.failedHintNoAgent', { step: step.id, environments: agentEnvironments(config) }));
            }
            // open lands at the entry of the failed step: everything before it done, the step itself still open.
            if (spec.steps.some(({ id }) => id === step.id)) ui.info(t('cli.untilHint', { test, target, step: step.id }));
        },
    });
    if (canFix || learn) ui.info(tracker.summary());
    return { code, failed };
};

const XML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
// XML 1.0 forbids these control characters.
// eslint-disable-next-line no-control-regex
const xmlText = (text) => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&"']/g, (char) => XML_ESCAPES[char]);
const JUNIT_TYPES = { [EXIT.fail]: 'fail', [EXIT.error]: 'error', [EXIT.rejected]: 'rejected', [EXIT.needsRecording]: 'needs-recording' };

/** The run table as JUnit XML, as CI systems read it: fail as failure, everything else except pass as error. */
export const junitXml = ({ target, rows }) => {
    const failures = rows.filter(({ exit }) => exit === EXIT.fail).length;
    const errors = rows.filter(({ exit }) => exit !== EXIT.fail && exit !== EXIT.pass).length;
    const time = rows.reduce((sum, { seconds = 0 }) => sum + seconds, 0).toFixed(3);
    const cases = rows.map(({ test, exit, seconds = 0, note = '' }) => {
        const open = `    <testcase classname="caw.${xmlText(target)}" name="${xmlText(test)}" time="${seconds.toFixed(3)}"`;
        if (exit === EXIT.pass) return `${open}/>`;
        const tag = exit === EXIT.fail ? 'failure' : 'error';
        return `${open}>\n      <${tag} type="${JUNIT_TYPES[exit] ?? 'error'}" message="${xmlText(note)}"/>\n    </testcase>`;
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
    if (options.batch) ui.info(t('cli.batchStart', { count: tests.length, target, headless: options.headless ? '' : t('cli.batchWindow') }));
    return withLifecycle(lifecycleOf(root, loadConfig(root), target, options, 'run'), (lifecycle) => runBatch(root, { ...options, lifecycle }, deps, { tests, target }));
};

/** The tests of a batch in a row, then table, JUnit and the worst exit code. A failed reset ends the batch: no further test runs. */
const runBatch = async (root, options, deps, { tests, target }) => {
    const rows = [];
    for (const test of tests) {
        const started = Date.now();
        let exit;
        let note = '';
        try {
            const result = await runOne(root, { ...options, test, target, quiet: options.batch === true }, deps);
            exit = result.code;
            if (result.failed !== undefined && exit !== EXIT.pass) note = t('cli.batchAt', { step: result.failed.id });
        } catch (error) {
            if (error?.code === 'env-reset-failed') throw error;
            // As in bin/caw.mjs: an expected error by its code, an unexpected one is error.
            exit = error instanceof CawError ? exitOf(error.code) : EXIT.error;
            note = String(error?.message ?? error).split('\n')[0];
        }
        rows.push({ test, exit, seconds: (Date.now() - started) / 1000, note });
    }
    ui.batch({ target, rows });
    if (options.junit !== undefined) {
        // Inside the project only, also after links: a session passes --report through caw_start's args.
        const file = projectPath(root, options.junit);
        if (file === null) throw new CawError('usage', t('cli.junitOutside', { file: options.junit }));
        mkdirSync(dirname(file), { recursive: true });
        if (projectPath(root, options.junit) === null) throw new CawError('usage', t('cli.junitOutside', { file: options.junit }));
        // A new file, not one a link points to.
        rmSync(file, { force: true });
        writeFileSync(file, junitXml({ target, rows }), { flag: 'wx' });
        ui.info(t('cli.junitWritten', { file: options.junit }));
    }
    return worstExit(rows.map(({ exit }) => exit));
};

/**
 * `caw run`: one test as usual; several tests or --all run one after another without chat (runMany). With --report junit=<file>
 * a single test takes that path too, so CI always gets the file.
 * @param interactive   tests only: replaces CI detection
 * @param adviseCommand tests only: replaces Claude when advising
 * @param talkCommand   tests only: replaces Claude in the conversation
 */
export const run = async (root, args, deps = {}) => {
    const options = parseRunArgs('run', args);
    if (options.junit !== undefined && projectPath(root, options.junit) === null) throw new CawError('usage', t('cli.junitOutside', { file: options.junit }));
    if (options.batch || options.junit !== undefined) return runMany(root, options, deps);
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
const recordFrom = async (root, options, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}) => {
    const { test, step, target: given, timeoutMin, stepTimeoutSec, maxActions, agent, overlay, start } = options;
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
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent });
        const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen });
        return fixFlow({
            draft: spec,
            target: { id: step, reason: t('cli.recordFromReason', { step }), rerecord: true, from: true },
            sandbox,
            execute,
            adopt: (draft, only, adoptOptions) => writeTest(root, draft, only, adoptOptions),
            log: ui.info,
        });
    });
};

/**
 * Records a new test plan or replaces one, always with chat. `containerCommand` replaces Claude with a scripted flow so
 * the path through container, channel and browser can be tested without model or token. `<test>@S<n>` re-records from that
 * step to the end (recordFrom); at the first step that is the same as the whole test.
 */
export const record = async (root, args, deps = {}) => {
    const options = parseRunArgs('record', args);
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = deps;
    const { test, step, target: given, timeoutMin, stepTimeoutSec, maxActions, role, readOnly, agent, overlay, start } = options;
    // In CI nobody demonstrates or decides: said first, before --role or the environment.
    requireHuman('record', interactive);
    const config = loadConfig(root);
    const exists = existsSync(testPath(root, test));
    if (step !== undefined) {
        if (!exists) throw testMissing(root, config, test, given);
        const known = withDefaults(loadTest(root, test), config);
        const position = known.steps.findIndex(({ id }) => id === step);
        if (position === -1) throw stepUnknown('cli.recordStepUnknown', known, step, { file: `${TEST_DIR}/${test}.yaml` });
        if (position > 0) return recordFrom(root, options, deps);
    }
    const known = exists ? withDefaults(loadTest(root, test), config) : null;
    const target = chooseEnv(config, known === null ? [] : [known], { env: given, command: 'record', writes: !readOnly });
    const spec = known ?? draftTest(root, config, { id: test, target, role, readOnly });
    if (exists && contradicts(spec, { role, readOnly })) throw new CawError('usage', t('cli.recordExists', { test }));
    return withLifecycle(lifecycleOf(root, config, target, options, 'record'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        const checked = checkTest(spec, target, config, { overlay, start });
        requireTestUser(root, config, spec.role, target);
        requireAgent(config, checked, target, t('cli.verbRecord'));

        const { recordFlow } = await import('./flows.mjs');
        // Before the demonstration: if Docker failed only afterwards, the human's work would be wasted.
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent });
        const previous = exists ? spec : undefined;
        const { execute, conversation } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxActions, containerCommand, adviseCommand, talkCommand, onChatOpen, previous });
        // Driven from the developer's Claude Code session: it follows an existing test plan without asking the human first.
        // A new test without a plan still starts with the human's demonstration.
        const demonstration = (agent ?? agentMode(config)) === 'session' && exists ? undefined : await startRecording(root, config, spec, checked, { exists, conversation });
        return recordFlow({
            sandbox,
            execute: (call) => execute({ ...call, ...(call.replay === undefined && call.repair === undefined ? { demonstration } : {}) }),
            adopt: (draft, only, adoptOptions) => writeTest(root, draft, only, adoptOptions),
            log: ui.info,
        });
    });
};

/** The name a reproduction runs under: report and window title. */
const REPRODUCE_ID = 'reproduce';

/**
 * caw reproduce "<bug report>": Claude reproduces a bug on its own, signed in as a test role, optionally from a test's state
 * (--from <test>[@<step>]). Only on environments with claude, never on production; without writable every write request is
 * blocked. No plan, no decisions, no code change; the run folder gets the report and a draft test plan, caw/tests nothing.
 * @returns 0 reproduced, 1 not reproduced or unclear, 2 environment error, 3 invalid input
 */
export const reproduce = async (root, args, deps = {}) => {
    const { parseReproduceArgs, draftId } = await import('./reproduce.mjs');
    const options = parseReproduceArgs(args, { root, ...(deps.readStdin === undefined ? {} : { readStdin: deps.readStdin }) });
    const { containerCommand, adviseCommand, talkCommand, docker, onChatOpen } = deps;
    const config = loadConfig(root);
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
    const allowed = environmentsWith(config, 'claude').filter((name) => effectiveEnvironment(config, name).production !== true);
    if (options.target !== undefined && !allowed.includes(options.target) && config.environments?.[options.target] !== undefined) {
        throw new CawError('reproduce-not-allowed', t('cli.reproduceNotAllowed', { target: options.target, environments: allowed.join(', ') || t('cli.noEnvironment') }));
    }
    const target = chooseEnv(config, known === null ? [] : [known], { env: options.target, command: 'reproduce' });
    const env = effectiveEnvironment(config, target);
    if (env.claude !== true || env.production === true) {
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
        const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent: options.agent });
        const { execute, conversation } = claudeRuns(root, config, { spec, checked, target, timeoutMin: CLAUDE_TIMEOUT_MIN, stepTimeoutSec: 30, containerCommand, adviseCommand, talkCommand, onChatOpen });
        const result = await execute({
            sandbox,
            headless: options.headless,
            // With a window the chat shows what Claude does; nobody decides anything there.
            ...(options.headless ? {} : { conversation }),
            reproduce: {
                bug: options.bug,
                writes: writable,
                draftId: draftId(root, options.bug),
                ...(prefix === undefined ? {} : { prefix }),
                ...(options.from === undefined ? {} : { from: options.from }),
            },
        });
        const outcome = result.verdict?.reproduce;
        if (outcome?.reproduced !== undefined) ui.info(t(`cli.reproduceVerdict.${outcome.reproduced}`));
        if (outcome?.draft !== undefined) ui.info(t('cli.reproduceDraft', outcome.draft));
        return result.exitCode;
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
        const runOptions = { ...options, target, entry: options.step, handover: true, learn: false, advise: false, headless: false, noChat: false };
        return withLifecycle(lifecycleOf(root, config, target, options, 'open'), async (lifecycle) => (await runOne(root, { ...runOptions, lifecycle }, deps)).code);
    }
    const config = loadConfig(root);
    const target = chooseEnv(config, [], { env: options.target, command: 'open' });
    const spec = draftTest(root, config, { id: OPEN_ID, target, role: options.role, readOnly: true });
    return withLifecycle(lifecycleOf(root, config, target, options, 'open'), async (lifecycle) => {
        await lifecycle.beforeTest(spec);
        const checked = checkTest(spec, target, config, { overlay: options.overlay, start: options.start });
        requireTestUser(root, config, spec.role, target);
        const runOptions = { ...options, test: spec.id, handover: true, learn: false, advise: false, headless: false, noChat: false, quiet: true };
        return (await runOne(root, runOptions, deps, { config, spec, target, checked })).code;
    });
};
