// The host commands. init and validate need neither browser code nor Docker.

// cpSync is stable from Node 22.3; the engine range only says >=22.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_DIR, FRAMEWORK_NAMES, TODO, agentSandbox, allTargets, authOf, browserHosts, browserLaunch, environmentsWith, loadConfig, loadConfigWithNotes, resolveTarget, sessionPath } from '../shared/config.mjs';
import { CawError, EXIT, exitOf, worstExit } from '../shared/errors.mjs';
import { language, t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, ENV_FILE, RECORDING_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { closest } from '../shared/suggest.mjs';
import { createUi } from '../shared/ui.mjs';
import { selectDocker } from './docker.mjs';
import { DEFAULT_MAX_STEPS } from './step-budget.mjs';
import { CLAUDE_TIMEOUT_MIN, optionValue, parseRunArgs, toWslPath } from './linux.mjs';
import { EXPLORE_FILE, explore } from './explore.mjs';
import { maskArgs, parseJsonc, projectImage, renderDockerfile, templatePath, toolFingerprint } from './sandbox-config.mjs';
import { describeCode } from './code-source.mjs';
import { brokenChain, checkTest, loadTest, recordingHints, staleSteps, testPath, withDefaults, writeTest } from './test-file.mjs';

const SKILL_DIR = '.claude/skills/caw-ai';
/** Entry for .mcp.json: node instead of npx works the same on every system and needs no cmd /c on Windows. */
export const MCP_ENTRY = { command: 'node', args: ['node_modules/caw-ai/bin/caw-ai.mjs', 'mcp'] };
const TOOL_DIR = fileURLToPath(new URL('../../', import.meta.url));
// Only what the container runs. Browser code and devlink stay out.
const TOOL_PARTS = ['bin', 'src/sandbox', 'src/shared', 'package.json'];
const IMAGE_TEMPLATES = ['Dockerfile.tpl', 'init-firewall.sh', 'entrypoint.sh', 'skill.md'];
const SANDBOX_USER = 'devuser';
/** Without a project image: Node LTS on Debian. Claude Code only needs Node. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';
const ui = createUi();
// Labels are resolved on use: at import time the language is not set yet.
const SHOW = () => ({ id: 'show', label: t('cli.choiceShow'), primary: true });
const FOLLOW = () => ({ id: 'follow', label: t('cli.choiceFollow') });
/** How long a demonstration stays reusable, e.g. when login or Claude failed afterwards. */
const REUSE_MS = 24 * 60 * 60 * 1000;

/** The latest non-empty demonstration of this test, no older than REUSE_MS, otherwise null. */
export const lastDemonstration = (root, id, now = Date.now()) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (!existsSync(runs)) return null;
    const suffix = `-${id}-vorfuehrung`;
    for (const name of readdirSync(runs).filter((entry) => entry.endsWith(suffix)).sort().reverse()) {
        const file = join(runs, name, 'vorfuehrung.json');
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
 * @returns { framework, url, auth, login, startUrl, messageSelectors, consoleIgnore }
 */
export const answersFromExplore = (suggestion) => {
    if (suggestion === null || typeof suggestion !== 'object' || typeof suggestion.url !== 'string') throw new CawError('usage', t('cli.notExploreResult'));
    const { type, ...login } = suggestion.auth ?? { type: 'form' };
    delete login.confidence;
    return {
        framework: suggestion.framework?.value,
        url: suggestion.url,
        auth: type,
        login,
        explored: true,
        ...(suggestion.startUrl === undefined ? {} : { startUrl: suggestion.startUrl }),
        ...(suggestion.messageSelectors === undefined ? {} : { messageSelectors: suggestion.messageSelectors }),
        ...(suggestion.consoleIgnore === undefined ? {} : { consoleIgnore: suggestion.consoleIgnore }),
    };
};

/** Role when none is given. */
const DEFAULT_ROLE = 'tester';
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
    // Without an application: the template with TODO in the login. Also without a terminal and --url, instead of aborting.
    const offline = args.includes('--offline') || (file === undefined && url === undefined && !interactive && !existsSync(join(root, EXPLORE_FILE)));
    if (offline && from === undefined) {
        if (!args.includes('--offline')) ui.info(t('cli.initOfflineFallback'));
        const answers = { ...(url === undefined ? {} : { url }), offline: true };
        if (interactive) answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
        if (args.includes('--no-mcp')) answers.mcp = false;
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
        const passed = ['--yes', '--insecure-tls'].filter((flag) => args.includes(flag));
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
    const answers = answersFromExplore(suggestion);
    // explore does not know roles: ask in the terminal, otherwise use a neutral default.
    if (interactive && answers.auth !== 'none') answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
    if (args.includes('--no-mcp')) answers.mcp = false;
    return { answers };
};

/** The first config from the answers of `init`; without answers the template with the detected framework. */
export const starterConfig = ({ framework = 'web', language: projectLanguage = language(), appDir, url, auth = 'form', login = {}, explored = false, offline = false, roles, startUrl, messageSelectors, consoleIgnore } = {}) => {
    if (!FRAMEWORK_NAMES.includes(framework)) throw new CawError('usage', t('cli.unknownFramework', { framework, names: FRAMEWORK_NAMES.join(', ') }));
    if (!['form', 'storageState', 'none'].includes(auth)) throw new CawError('usage', t('cli.initAuthUnknown', { auth }));
    const names = roles ?? [DEFAULT_ROLE];
    const bad = names.find((name) => !/^[a-z][a-z0-9-]*$/.test(name));
    if (bad !== undefined || names.length === 0) throw new CawError('usage', t('cli.badRoleName', { name: bad ?? '' }));
    // The language comes first: it applies to workbench, chat, output and report of this project.
    const config = { language: projectLanguage, ...JSON.parse(readFileSync(templatePath('caw.config.example.json'), 'utf8')) };
    config.framework = framework;
    if (url !== undefined) config.environments = { local: { ...config.environments.local, url } };
    // Separate credential variables per role, e.g. CAW_LOGIN_ADMIN and CAW_PW_ADMIN.
    const envName = (name) => name.toUpperCase().replaceAll('-', '_');
    config.roles = Object.fromEntries(names.map((name) => [name, { loginEnv: `CAW_LOGIN_${envName(name)}`, passwordEnv: `CAW_PW_${envName(name)}` }]));
    if (auth === 'none') {
        delete config.auth;
        delete config.roles;
    }
    if (auth === 'storageState') {
        config.auth = { type: 'storageState', signedInSelector: login.signedInSelector ?? config.auth.signedInSelector };
        config.roles = Object.fromEntries(names.map((name) => [name, {}]));
    }
    // From explore: found selectors instead of the template placeholders.
    if (auth === 'form') {
        for (const key of ['path', 'userSelector', 'passwordSelector', 'submitSelector', 'signedInSelector']) {
            if (typeof login[key] === 'string' && login[key] !== '') config.auth[key] = login[key];
            // What explore did not find gets no real-looking placeholder: doctor reports TODO until the human fills it in.
            else if ((explored || offline) && key !== 'submitSelector') config.auth[key] = TODO;
        }
    }
    if (typeof startUrl === 'string' && startUrl.startsWith('/')) config.apps.web.startUrl = startUrl;
    if (typeof appDir === 'string' && appDir !== '') config.apps.web.dir = appDir;
    if (Array.isArray(messageSelectors) && messageSelectors.length > 0) config.messageSelectors = messageSelectors;
    if (Array.isArray(consoleIgnore) && consoleIgnore.length > 0) config.consoleIgnore = consoleIgnore;
    return config;
};

/**
 * The tools for the developer's Claude Code session; the entry is added to .mcp.json unless it is already there or the file is invalid.
 * @returns true if the file was written
 */
const addMcpEntry = (root) => {
    const mcpFile = join(root, '.mcp.json');
    let mcp = { mcpServers: {} };
    try {
        mcp = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, 'utf8')) : mcp;
    } catch {
        mcp = null;
    }
    if (mcp === null) {
        ui.warn(t('cli.mcpInvalid'));
        return false;
    }
    if (mcp.mcpServers?.['caw-ai'] !== undefined) return false;
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), 'caw-ai': MCP_ENTRY };
    writeFileSync(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`);
    return true;
};

/**
 * `caw-ai skill`: only the skill (and the MCP entry), without a config, so Claude Code can guide the setup itself
 * ("set up caw"). An existing skill is updated to this version.
 */
export const installSkill = (root) => {
    const file = join(root, SKILL_DIR, 'SKILL.md');
    const content = readFileSync(templatePath('skill.md'), 'utf8');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (before !== content) {
        mkdirSync(join(root, SKILL_DIR), { recursive: true });
        writeFileSync(file, content);
    }
    const mcp = addMcpEntry(root);
    const skillText = before === null ? t('cli.skillCreated', { file: `${SKILL_DIR}/SKILL.md` }) : before === content ? t('cli.skillCurrent') : t('cli.skillUpdated', { file: `${SKILL_DIR}/SKILL.md` });
    ui.success(`${skillText}${mcp ? ', .mcp.json' : ''}.`);
    if (!existsSync(join(root, CONFIG_FILE))) ui.note(t('cli.skillNext'));
    return EXIT.pass;
};

/**
 * Creates config, .env example, skill, notes and .gitignore entries. Existing files stay untouched.
 * @param answers from the `init` dialog (`framework`, `url`, `auth`); without: template with the detected framework
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
    const template = (name) => readFileSync(templatePath(name), 'utf8');
    const detected = detectApp(root);
    const config = starterConfig({ framework: detected.framework, appDir: detected.dir, ...answers });
    write(CONFIG_FILE, `${JSON.stringify(config, null, 4)}\n`);
    // No example test: it never fit the application and broke validate once roles were renamed. record creates the first test.
    if (config.auth?.type === 'form' || config.auth?.type === 'basic') {
        // The names come from the config roles so example and config match.
        const names = Object.values(config.roles ?? {}).flatMap(({ loginEnv, passwordEnv }) => [loginEnv, passwordEnv]).filter(Boolean);
        write(`${ENV_FILE}.example`, `${t('cli.envExampleHead')}\n${names.map((name) => `${name}=`).join('\n')}\n`);
    }
    write(`${SKILL_DIR}/SKILL.md`, template('skill.md'));
    // The folder for test plans and the notes for Claude: shows right away where things belong.
    if (!existsSync(join(root, TEST_DIR))) write(`${TEST_DIR}/.gitkeep`, '');
    write(CONTEXT_FILE, t('cli.contextTemplate'));
    if (answers.mcp !== false && addMcpEntry(root)) created.push('.mcp.json');

    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    const lines = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`].filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length > 0) {
        appendFileSync(ignore, `\n# caw-ai\n${lines.join('\n')}\n`);
        created.push('.gitignore');
    }
    ui.success(created.length > 0 ? t('cli.initCreated', { files: created.join(', ') }) : t('cli.initAlready'));
    const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
    if (created.includes(CONFIG_FILE) && todo.length > 0) ui.warn(t(answers.offline ? 'cli.initTodoOffline' : 'cli.initTodo', { keys: todo.join(', ') }));
    // If explore just ran, advising to run it first would be confusing.
    if (created.includes(CONFIG_FILE)) ui.note(`${t('cli.initNext', { target: Object.keys(config.environments)[0] })}${answers.explored ? '' : t('cli.initNextExplore')}`);
    return EXIT.pass;
};

/**
 * Saves a role's session for `auth.type: storageState` (e.g. SSO): Chrome opens the login, the human signs in,
 * the session goes to caw/.auth/<role>.json. Without Claude and Docker.
 * @param capture tests only: replaces Chrome
 */
export const auth = async (root, args, { capture } = {}) => {
    const [roleName] = args;
    const target = optionValue(args, '--target');
    if (roleName === undefined || roleName.startsWith('--') || target === undefined) throw new CawError('usage', t('cli.authUsage'));
    const config = loadConfig(root);
    const { type, path = '/', signedInSelector } = authOf(config);
    if (type !== 'storageState') throw new CawError('usage', t('cli.authStorageOnly', { type }));
    if (signedInSelector === undefined) throw new CawError('config-invalid', t('cli.authNeedsSelector'));
    if (config.roles?.[roleName] === undefined) throw new CawError('usage', t('cli.authRoleUnknown', { role: roleName, roles: Object.keys(config.roles ?? {}).join(', ') }));
    const resolved = resolveTarget(config, target);
    if (resolved.production) throw new CawError('target-denied', t('cli.targetProduction', { target }));
    const file = join(root, sessionPath(resolved.target, roleName));
    const save = capture ?? (await import('./browser-session.mjs')).captureSession;
    ui.info(t('cli.authSignIn', { role: roleName, selector: signedInSelector }));
    const saved = await save({ url: `${resolved.url}${path}`, signedInSelector, hosts: browserHosts(config, resolved), insecureTls: config.insecureTls === true, file, launch: browserLaunch(config) });
    if (!saved) {
        ui.info(t('cli.authClosed'));
        return EXIT.error;
    }
    ui.success(t('cli.authSaved', { file: sessionPath(resolved.target, roleName) }));
    return EXIT.pass;
};

/** Checks the config and all tests against all their targets, without Docker or network. Stale steps are a hint, not an error. */
export const validate = (root) => {
    const { config, notes } = loadConfigWithNotes(root);
    const dir = join(root, TEST_DIR);
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const problems = [];
    const hints = [...notes, ...todoNotes(config)];
    // One line per test and target saying which code runs there, so an unnoticed deployed build stands out here already.
    const codeLines = [];
    for (const file of files) {
        try {
            // Description plus recording from caw/recordings; loadTest reports a mismatching id.
            const spec = withDefaults(loadTest(root, file.slice(0, -'.yaml'.length)), config);
            for (const target of spec.targets) {
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
    if (problems.length > 0) throw new CawError('test-invalid', problems.join('\n'));
    codeLines.forEach((line) => ui.info(line));
    hints.forEach((hint) => ui.note(hint));
    ui.success(t('cli.validateOk', { config: CONFIG_FILE, count: files.length }));
    return EXIT.pass;
};

/** One hint per login value still TODO since init, saying what belongs there. */
const todoNotes = (config) => Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO)
    .map(([key]) => t('cli.validateTodo', { key: `auth.${key}`, what: t(`cli.validateTodo.${key}`) }));

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
        'skill.md': readFileSync(templatePath('skill.md'), 'utf8'),
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

/** The targets Claude may work on (environments with agent), one per tenant where there are tenants. */
const claudeTargets = (config) => allTargets(config).filter((name) => {
    try {
        return resolveTarget(config, name).agent;
    } catch {
        return false;
    }
});

/** The command that records the test anew: flags only for what the config does not determine. */
const recordHint = (config, id, target) => {
    // Without --target the command needs none if there is only one environment for Claude; otherwise list the choices.
    const choices = claudeTargets(config);
    let targetFlag = [];
    if (target !== undefined) targetFlag = [`--target ${target}`];
    else if (choices.length !== 1) targetFlag = [`--target <${choices.join('|') || 'env'}>`];
    return [
        `caw-ai record ${id}`,
        ...targetFlag,
        ...(onlyKey(config.roles) === undefined ? [`--role <${Object.keys(config.roles ?? {}).join('|') || 'role'}>`] : []),
        ...(onlyKey(config.apps) === undefined ? [`--app <${Object.keys(config.apps ?? {}).join('|') || 'app'}>`] : []),
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
    return new CawError('test-missing', t('cli.testMissing', {
        file: `${TEST_DIR}/${id}.yaml`,
        suggestion: suggestion(id, known),
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
 * The target when --target is missing: the test's only target; for record and fix the only one of them Claude may work on;
 * for a new test the only environment Claude may work on. The choice is logged; ambiguity is a usage error.
 * @param spec the test, null for a new one
 */
export const chooseTarget = (config, spec, { target, command, log = ui.info }) => {
    if (target !== undefined) return target;
    let choices;
    let why;
    if (spec === null) {
        choices = claudeTargets(config);
        why = t('cli.targetWhyAgent');
    } else {
        choices = spec.targets;
        why = t('cli.targetWhyTest', { test: spec.id });
        const claude = new Set(claudeTargets(config));
        const narrowed = choices.filter((name) => claude.has(name));
        if ((command === 'record' || command === 'fix') && choices.length > 1 && narrowed.length === 1) {
            choices = narrowed;
            why = t('cli.targetWhyTestAgent', { test: spec.id });
        }
    }
    if (choices.length !== 1) throw new CawError('usage', t('session.args.targetMissing', { choices: (choices.length > 0 ? choices : allTargets(config)).join(', ') }));
    log(t('cli.targetChosen', { target: choices[0], why }));
    return choices[0];
};

const loadChecked = (root, id, given, command, { overlay } = {}) => {
    const config = loadConfig(root);
    if (!existsSync(testPath(root, id))) throw testMissing(root, config, id, given);
    const spec = withDefaults(loadTest(root, id), config);
    const target = chooseTarget(config, spec, { target: given, command });
    return { config, spec, target, checked: checkTest(spec, target, config, { overlay }) };
};

/**
 * Loads tests with the config defaults (id, app, role, targets). Without a readable config as written: list works without one.
 */
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
 * `caw-ai list`: per test its targets, recording state and whether it writes; `caw-ai list <test>` one line per step. Without browser,
 * Claude or config.
 */
export const list = (root, args, { out = console.log } = {}) => {
    const [test, ...rest] = args;
    const extra = rest[0] ?? (test?.startsWith('-') ? test : undefined);
    if (extra !== undefined) throw new CawError('usage', t('session.args.unexpected', { arg: extra }));
    const mutatesText = (spec) => t(spec.mutates === false ? 'cli.listReadOnly' : 'cli.listWrites');
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
        out(t('cli.listTestHead', { test: spec.id, app: spec.app, role: spec.role ?? '–', targets: (spec.targets ?? []).join(', '), mutates: mutatesText(spec) }));
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
            return [id, (spec.targets ?? []).join(', '), text, mutatesText(spec)];
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
const agentEnvironments = (config) => environmentsWith(config, 'agent').join(', ') || t('cli.noEnvironment');

/** Claude only works on environments with `agent`: the others are meant to fail when something is off. */
const requireAgent = (config, checked, target, verb) => {
    if (!checked.agent) throw new CawError('write-protected', t('cli.agentOnly', { verb, environments: agentEnvironments(config), target, environment: checked.environment }));
};

/**
 * Where Claude runs. Locally (default) it only needs Claude Code on the PATH; with Docker also token and image. Scripted flows
 * instead of Claude need neither Claude Code nor a token.
 */
const openSandbox = async (root, { config, containerCommand, adviseCommand, talkCommand, docker: chosenDocker, agent }) => {
    const scripted = containerCommand !== undefined || adviseCommand !== undefined || talkCommand !== undefined;
    const inCi = process.env.CI !== undefined && process.env.CI !== '';
    if (agent !== undefined && agent !== 'docker' && inCi) throw new CawError('usage', t('cli.agentNotInCi', { agent }));
    if (agent === 'session') {
        ui.info(t('cli.sessionAgent'));
        return { kind: 'session', label: t('cli.sessionLabel') };
    }
    if (chosenDocker === undefined && (agent ?? agentSandbox(config)) === 'local') {
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
const draftTest = (root, config, { id, target, role: chosenRole, app: chosenApp, also, readOnly = false }) => {
    const role = chosenRole ?? onlyKey(config.roles);
    const app = chosenApp ?? onlyKey(config.apps);
    if (role === undefined || app === undefined) {
        const missing = [...(role === undefined ? ['--role'] : []), ...(app === undefined ? ['--app'] : [])];
        throw new CawError('usage', t('cli.draftMissing', { id, missing: missing.join(t('cli.and')), hint: recordHint(config, id, target) }));
    }
    for (const name of [app, ...also]) {
        if (config.apps[name] === undefined) throw new CawError('test-invalid', t('cli.unknownApp', { name, apps: Object.keys(config.apps).join(', '), config: CONFIG_FILE }));
    }
    return {
        id,
        app,
        role,
        targets: [target],
        // Writing unless the human says otherwise; a read-only test that does write becomes writing on adoption.
        mutates: !readOnly,
        also,
        notes: '',
        steps: [],
        expectations: [],
    };
};

/**
 * The human picks how to start and, if needed, demonstrates in their own browser. The window closes afterwards so Claude
 * starts fresh.
 * @returns the demonstration, or undefined if Claude follows the old test plan
 */
const startRecording = async (root, config, spec, checked, { exists, conversation }) => {
    const [{ openRunSession }, { openChat }, { demonstrate, feedLabel, itemLabel }] = await Promise.all([import('./run.mjs'), import('./chat.mjs'), import('./demonstrate.mjs')]);
    const dir = join(root, RUN_DIR, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${spec.id}-vorfuehrung`);
    mkdirSync(dir, { recursive: true });
    const session = await openRunSession({ root, config, spec, checked, runDir: dir, interactive: true });
    let chat = null;
    const aborted = () => new CawError('aborted', t('cli.recordAborted'));
    try {
        let windowClosed = false;
        session.closed.then(() => { windowClosed = true; });
        chat = await openChat({ session, logPath: join(dir, 'chat.log'), onAbort: () => process.emit('SIGINT'), onOpen: conversation.onChatOpen, onWaiting: ui.note, transcript: conversation.transcript });
        // This window is about to close and Claude gets a new one: chat and terminal announce it.
        const handOver = () => {
            const line = t('run.newWindow', { what: t('run.newWindow.claude') });
            chat.notice(line);
            ui.note(line);
        };
        // If the last recording failed after the demonstration (login, Claude), the human need not demonstrate again.
        const last = lastDemonstration(root, spec.id);
        const reuse = last === null ? null : { id: 'reuse', label: t('cli.choiceReuse', { time: new Date(last.at).toLocaleTimeString(language() === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }), count: last.items.length }), primary: true };
        const options = [...(reuse === null ? [] : [reuse]), reuse === null ? SHOW() : { ...SHOW(), primary: false }, ...(exists ? [FOLLOW()] : [])];
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
        }
        ui.note(t('cli.demoNote'));
        for (;;) {
            chat.enter('showing');
            const items = await demonstrate({ session, operator: chat.operator, ui, dir, onItem: (item) => { const line = feedLabel(item); if (line !== null) chat.progress(t('cli.demoRecorded', { line })); }, onFailure: (item) => chat.notice(t('cli.demoFailure', { label: itemLabel(item) })) });
            if (!chat.available() || windowClosed) throw aborted();
            if (items.length > 0) {
                writeFileSync(join(dir, 'vorfuehrung.json'), JSON.stringify(items, null, 2));
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
const claudeRuns = (root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen, ...rest }) => {
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
                maxSteps: maxSteps ?? config.maxSteps ?? DEFAULT_MAX_STEPS,
                ...rest,
                ...options,
                ...(options.conclude === undefined ? {} : { conversation: { ...conversation, lazy: lazyChat !== undefined, alsoOnWarnings: lazyChat === 'warnings', testing: testing === true } }),
            });
        },
    };
};

/** Recording and fixing need a human for demonstration, plan and decisions. CI has none: reject instead of waiting. */
const requireHuman = (command, interactive) => {
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    if (inCi) throw new CawError('usage', t('cli.ciNeedsHuman', { command }));
};

/** A line at the start of the run: what the run may do and why, so no mode silently follows from the environment. */
export const runMode = ({ withAgent, noChat, headless, inCi, withAdvice, environments, learn = true, file = RECORDING_DIR }) => {
    if (!withAgent) return t('cli.modeNoAgent', { environments });
    if (headless) return t('cli.modeHeadless');
    if (noChat) return t('cli.modeNoChat');
    if (inCi) return t('cli.modeCi');
    const advice = withAdvice ? t('cli.modeAdvice') : '';
    return learn ? t('cli.modeChat', { advice, file }) : t('cli.modeChatNoLearn', { advice });
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
 * except in CI (variable CI); if a step fails, the human clarifies it there and can have it fixed. With --until the run
 * prepares a state and hands over the window, to continue working on the local build from there. With --advise Claude
 * advises on errors and warnings, which costs tokens. --no-chat runs as in CI, --headless additionally without a window.
 * --no-learn keeps the chat but learns no baselines.
 * @param quiet in a batch: no mode line, the batch prints it once
 * @returns { code, failed } with the failed step ({ id, reason }), if one failed
 */
const runOne = async (root, options, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}, loaded = undefined) => {
    const { test, handover, stepTimeoutSec, until, advise: withAdvice, headless, noChat, learn, agent, timeoutMin, maxSteps, overlay, quiet = false } = options;
    const { config, spec, target, checked } = loaded ?? loadChecked(root, test, options.target, 'run', { overlay });
    if (until !== undefined && !spec.steps.some(({ id }) => id === until)) throw stepUnknown('cli.stepUnknown', spec, until);
    const { assertPlayable } = await import('./replay.mjs');
    // open has no steps: nothing to play back, just log in and hand over.
    if (loaded === undefined) assertPlayable(spec, target, until);
    const withAgent = checked.agent;
    // The chat lives in the workbench and needs no terminal. Only in CI nobody waits for it.
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const canFix = withAgent && !noChat && !inCi;
    // Reject right away rather than run silently without advice: whoever passes --advise expects it.
    if (withAdvice && !withAgent) throw new CawError('usage', t('cli.adviseAgentOnly', { environments: agentEnvironments(config), target }));
    if (withAdvice && !canFix) throw new CawError('usage', t('cli.adviseNeedsChat'));
    // Nobody waits in CI: a handover would keep the job open until the runner times out.
    if (inCi && (handover || until !== undefined)) throw new CawError('usage', t('cli.ciHandover', { option: until !== undefined ? '--until' : '--handover' }));
    if (!quiet) ui.info(runMode({ withAgent, noChat, headless, inCi, withAdvice, environments: agentEnvironments(config), learn, file: `${RECORDING_DIR}/${test}.yaml` }));
    const { runFlow } = await import('./flows.mjs');
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin: timeoutMin ?? CLAUDE_TIMEOUT_MIN, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen, headless });
    const tracker = changeTracker(root);
    let failed;
    // Where the human can clarify the failure in the chat: the test's first target Claude may work on.
    const claude = new Set(claudeTargets(config));
    const chatTarget = spec.targets.find((name) => claude.has(name));
    const code = await runFlow({
        spec,
        until,
        handover: handover || until !== undefined,
        canFix,
        advise: withAdvice,
        // The developer's Claude Code session is there at once and costs nothing here: it may read the page in the state right away.
        sessionAgent: agent === 'session',
        // Only with chat and without --no-learn: without chat, e.g. in CI, a run does not change the test file.
        fillBaselines: canFix && learn,
        openSandbox: () => openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent }),
        execute,
        adopt: tracker.adopt,
        log: ui.info,
        onPlayed: (played) => { failed = played.failed; },
        // Cause first, then change: `fix` re-records the step without looking for a cause, which only suits an intended change.
        hint: (step, { canFix: hadChat }) => {
            if (!hadChat) {
                if (withAgent) ui.info(t('cli.failedHintAgent', { step: step.id, test, target }));
                else if (chatTarget !== undefined) ui.info(t('cli.failedHint', { step: step.id, test, target: chatTarget }));
                else ui.info(t('cli.failedHintNoAgent', { step: step.id, environments: agentEnvironments(config) }));
            }
            const position = spec.steps.findIndex(({ id }) => id === step.id);
            if (position > 0) ui.info(t('cli.untilHint', { test, target, step: spec.steps[position - 1].id }));
        },
    });
    if (canFix) ui.info(tracker.summary());
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
        const open = `    <testcase classname="caw-ai.${xmlText(target)}" name="${xmlText(test)}" time="${seconds.toFixed(3)}"`;
        if (exit === EXIT.pass) return `${open}/>`;
        const tag = exit === EXIT.fail ? 'failure' : 'error';
        return `${open}>\n      <${tag} type="${JUNIT_TYPES[exit] ?? 'error'}" message="${xmlText(note)}"/>\n    </testcase>`;
    });
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites name="caw-ai" tests="${rows.length}" failures="${failures}" errors="${errors}" time="${time}">`,
        `  <testsuite name="caw-ai ${xmlText(target)}" tests="${rows.length}" failures="${failures}" errors="${errors}" skipped="0" time="${time}">`,
        ...cases,
        '  </testsuite>',
        '</testsuites>',
        '',
    ].join('\n');
};

/**
 * Several tests one after another, for CI: no chat, one test does not abort the others, at the end the table and the exit code of
 * the worst run (see worstExit). Without --target the tests' only target applies.
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
    let { target } = options;
    if (target === undefined) {
        const union = [...new Set([...specs.values()].flatMap((spec) => spec.targets ?? []))];
        if (union.length !== 1) throw new CawError('usage', t('session.args.targetMissing', { choices: (union.length > 0 ? union : allTargets(loadConfig(root))).join(', ') }));
        [target] = union;
        ui.info(t('cli.targetChosen', { target, why: t('cli.targetWhyTests') }));
    }
    // --all: every test naming the target; an unreadable one stays in and shows up as rejected.
    if (options.all) tests = tests.filter((id) => !specs.has(id) || (specs.get(id).targets ?? []).includes(target));
    if (tests.length === 0) throw new CawError('usage', t('cli.batchNone', { target }));
    if (options.batch) ui.info(t('cli.batchStart', { count: tests.length, target, headless: options.headless ? '' : t('cli.batchWindow') }));
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
            // As in bin/caw-ai.mjs: an expected error by its code, an unexpected one is error.
            exit = error instanceof CawError ? exitOf(error.code) : EXIT.error;
            note = String(error?.message ?? error).split('\n')[0];
        }
        rows.push({ test, exit, seconds: (Date.now() - started) / 1000, note });
    }
    ui.batch({ target, rows });
    if (options.junit !== undefined) {
        const file = resolve(root, options.junit);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, junitXml({ target, rows }));
        ui.info(t('cli.junitWritten', { file: options.junit }));
    }
    return worstExit(rows.map(({ exit }) => exit));
};

/**
 * `caw-ai run`: one test as usual; several tests or --all run one after another without chat (runMany). With --report junit=<file>
 * a single test takes that path too, so CI always gets the file.
 * @param interactive   tests only: replaces CI detection
 * @param adviseCommand tests only: replaces Claude when advising
 * @param talkCommand   tests only: replaces Claude in the conversation
 */
export const run = async (root, args, deps = {}) => {
    const options = parseRunArgs('run', args);
    if (options.batch || options.junit !== undefined) return runMany(root, options, deps);
    return (await runOne(root, options, deps)).code;
};

/**
 * Do --role, --app, --also or --read-only contradict a test already in the file (e.g. described by Claude)?
 * Repeated matching values are no contradiction.
 */
export const contradicts = (spec, { role, app, also = [], readOnly = false }) => (role !== undefined && role !== spec.role)
    || (app !== undefined && app !== spec.app)
    || also.some((name) => !(spec.also ?? []).includes(name))
    || (readOnly && spec.mutates !== false);

/**
 * Records a new test plan or replaces one, always with chat. `containerCommand` replaces Claude with a scripted flow so
 * the path through container, channel and browser can be tested without model or token.
 */
export const record = async (root, args, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}) => {
    const { test, target: given, timeoutMin, stepTimeoutSec, maxSteps, role, app, also, readOnly, agent, overlay } = parseRunArgs('record', args);
    const config = loadConfig(root);
    const exists = existsSync(testPath(root, test));
    const known = exists ? withDefaults(loadTest(root, test), config) : null;
    const target = chooseTarget(config, known, { target: given, command: 'record' });
    const spec = known ?? draftTest(root, config, { id: test, target, role, app, also, readOnly });
    if (exists && contradicts(spec, { role, app, also, readOnly })) throw new CawError('usage', t('cli.recordExists', { test }));
    const checked = checkTest(spec, target, config, { overlay });
    requireAgent(config, checked, target, t('cli.verbRecord'));
    requireHuman('record', interactive);

    const { recordFlow } = await import('./flows.mjs');
    // Before the demonstration: if Docker failed only afterwards, the human's work would be wasted.
    const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent });
    const previous = exists ? spec : undefined;
    const { execute, conversation } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen, previous });
    const demonstration = await startRecording(root, config, spec, checked, { exists, conversation });
    return recordFlow({
        sandbox,
        execute: (options) => execute({ ...options, ...(options.replay === undefined && options.repair === undefined ? { demonstration } : {}) }),
        adopt: (draft, only, options) => writeTest(root, draft, only, options),
        log: ui.info,
    });
};

const playable = (assertPlayable, spec, target, step) => {
    try {
        assertPlayable(spec, target, step);
        return true;
    } catch {
        return false;
    }
};

/** The name open runs under: report and window title. A test of that name stays untouched, open reads and writes none. */
const OPEN_ID = 'open';

/**
 * Opens the application logged in, without a test: workbench with chat, for navigating and developing. Like run --until, just without
 * steps before; with --overlay on local code. Learns nothing and writes no test file.
 */
export const open = async (root, args, deps = {}) => {
    const options = parseRunArgs('open', args);
    const config = loadConfig(root);
    const target = chooseTarget(config, null, { target: options.target, command: 'open' });
    // The run is named after the app, e.g. in the window title.
    const spec = draftTest(root, config, { id: options.app ?? onlyKey(config.apps) ?? OPEN_ID, target, role: options.role, app: options.app, also: [], readOnly: true });
    const checked = checkTest(spec, target, config, { overlay: options.overlay });
    requireHuman('open', deps.interactive);
    const runOptions = { ...options, test: spec.id, handover: true, learn: false, advise: false, headless: false, noChat: false, quiet: true };
    return (await runOne(root, runOptions, deps, { config, spec, target, checked })).code;
};

/** Changes exactly this step, even if it does not fail. That way a hand-edited or new step gets its recording. */
export const fix = async (root, args, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}) => {
    const { test, step, target: given, timeoutMin, stepTimeoutSec, maxSteps, agent, overlay } = parseRunArgs('fix', args);
    const { config, spec, target, checked } = loadChecked(root, test, given, 'fix', { overlay });
    requireAgent(config, checked, target, t('cli.verbFix'));
    requireHuman('fix', interactive);
    const position = spec.steps.findIndex(({ id }) => id === step);
    if (position === -1) throw stepUnknown('cli.fixStepUnknown', spec, step, { file: `${TEST_DIR}/${test}.yaml` });
    const { assertPlayable } = await import('./replay.mjs');
    if (position > 0) assertPlayable(spec, target, spec.steps[position - 1].id);
    const { fixFlow, runFlow } = await import('./flows.mjs');
    const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent });
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen });
    const [stale] = staleSteps(spec).filter(({ id }) => id === step);
    // Cause first: a recorded step is played back first. If it fails, the cause matters as with run, and a new recording
    // could work around an application bug. Only a passing or stale step is re-recorded.
    if (stale === undefined && spec.steps[position].recording !== undefined && playable(assertPlayable, spec, target, step)) {
        ui.info(t('cli.fixReplayFirst', { step }));
        let clean = false;
        const code = await runFlow({
            spec,
            until: step,
            handover: false,
            canFix: true,
            openSandbox: async () => sandbox,
            execute,
            adopt: (draft, only, options) => writeTest(root, draft, only, options),
            log: ui.info,
            onPlayed: (played) => { clean = !played.failed && played.exitCode === EXIT.pass; },
        });
        if (!clean || code !== EXIT.pass) return code;
        ui.info(t('cli.fixPassed', { step }));
    }
    return fixFlow({
        draft: spec,
        // Not failed: the human wants to re-record the step, e.g. after a manual change.
        target: { id: step, reason: stale === undefined ? 'The human wants to re-record this step; it did not fail' : `${step} ${stale.why}`, rerecord: true },
        sandbox,
        execute,
        adopt: (draft, only, options) => writeTest(root, draft, only, options),
        log: ui.info,
    });
};
