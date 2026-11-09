// Die Befehle auf dem Host. Init und validate kommen ohne Browser-Code und Docker aus.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTH_DIR, FRAMEWORK_NAMES, TODO, agentSandbox, authOf, browserHosts, browserLaunch, environmentsWith, hasLocalCode, loadConfig, resolveTarget, sessionPath } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { language, t } from '../shared/i18n.mjs';
import { CONFIG_FILE, ENV_FILE, RECORDING_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { selectDocker } from './docker.mjs';
import { frameworkOf } from './framework/index.mjs';
import { processRunning } from './processes.mjs';
import { DEFAULT_MAX_STEPS } from './step-budget.mjs';
import { CLAUDE_TIMEOUT_MIN, parseRunArgs, toWslPath } from './linux.mjs';
import { EXPLORE_FILE, explore } from './explore.mjs';
import { maskArgs, parseJsonc, projectImage, renderDockerfile, templatePath, toolFingerprint } from './sandbox-config.mjs';
import { brokenChain, checkTest, loadTest, recordingHints, staleSteps, testPath, writeTest } from './test-file.mjs';

const SKILL_DIR = '.claude/skills/caw-ai';
/** Eintrag fuer .mcp.json: ueber node statt npx, das geht auf allen Systemen gleich und braucht unter Windows kein cmd /c. */
export const MCP_ENTRY = { command: 'node', args: ['node_modules/caw-ai/bin/caw-ai.mjs', 'mcp'] };
const TOOL_DIR = fileURLToPath(new URL('../../', import.meta.url));
// Nur das, was der Container ausfuehrt. Browser-Code und devlink bleiben draussen.
const TOOL_PARTS = ['bin', 'src/sandbox', 'src/shared', 'package.json'];
const IMAGE_TEMPLATES = ['Dockerfile.tpl', 'init-firewall.sh', 'entrypoint.sh', 'skill.md'];
const SANDBOX_USER = 'devuser';
/** Ohne Image des Projekts: Node LTS, Debian. Claude Code braucht nur Node. */
export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';
const ui = createUi();
// Die Beschriftungen erst beim Gebrauch: Beim Import steht die Sprache noch nicht fest.
const SHOW = () => ({ id: 'show', label: t('cli.choiceShow'), primary: true });
const FOLLOW = () => ({ id: 'follow', label: t('cli.choiceFollow') });
/** Eine Vorfuehrung bleibt so lange wiederverwendbar, etwa wenn danach die Anmeldung oder Claude gescheitert ist. */
const REUSE_MS = 24 * 60 * 60 * 1000;

/** Die juengste Vorfuehrung dieses Tests mit Inhalt, nicht aelter als REUSE_MS, sonst null. */
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
            // kaputte Datei: aeltere pruefen
        }
    }
    return null;
};

/** Das Framework aus der package.json eines Ordners; ohne Treffer `web`. */
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
 * Framework und Ordner der Anwendung. Liegt sie nicht im Wurzelordner (Repo mit Backend und `frontend/`, Monorepo mit `apps/web`),
 * sucht caw-ai ein bis zwei Ebenen tiefer nach einer package.json mit bekanntem Framework; bei mehreren gilt der erste nach Namen.
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

/** Das Framework der Anwendung, siehe detectApp. */
export const detectFramework = (root) => detectApp(root).framework;

/**
 * Antworten fuer `init` aus den Vorschlaegen von `explore` (caw/.explore.json). Was explore nicht sicher weiss, bleibt Vorgabe der Vorlage.
 * @returns { framework, url, auth, login, startUrl, messageSelectors, consoleIgnore }
 */
export const answersFromExplore = (suggestion) => {
    if (suggestion === null || typeof suggestion !== 'object' || typeof suggestion.url !== 'string') throw new CawError('usage', t('cli.notExploreResult'));
    const { confidence, type, ...login } = suggestion.auth ?? { type: 'form' };
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

/** Rolle, wenn niemand eine nennt. */
const DEFAULT_ROLE = 'tester';
const optionOf = (args, name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
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

/** Eine Frage im Terminal, sofort geprueft; eine falsche Antwort fragt mit Grund noch einmal. Je Frage ein eigenes readline, denn explore liest dazwischen Enter. */
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
 * Die Antworten fuer `init`. explore ist Pflicht: --from <datei>, sonst ein vorhandenes caw/.explore.json, sonst laeuft explore jetzt,
 * auf --url oder der Adresse, nach der init im Terminal fragt. Ohne Terminal und ohne --url nennt init den Aufruf.
 * @returns { answers } oder { code }, wenn explore nicht durchlief (etwa Fenster geschlossen)
 */
export const initAnswers = async (root, args, { interactive, runExplore = explore, input = process.stdin, output = process.stdout } = {}) => {
    const from = optionOf(args, '--from');
    let url = optionOf(args, '--url');
    let file = from;
    if (file === undefined && url === undefined && existsSync(join(root, EXPLORE_FILE))) {
        file = EXPLORE_FILE;
        console.log(t('cli.initUsesExplore', { file }));
    }
    if (file === undefined) {
        if (url === undefined) {
            if (!interactive) throw new CawError('usage', t('cli.initNeedsUrl'));
            url = await askLine({ input, output }, t('cli.askUrl'), 'http://localhost:5173', checkUrl);
        } else if (checkUrl(url) !== null) throw new CawError('usage', checkUrl(url));
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
    // Rollen kennt explore nicht: im Terminal fragen, sonst eine neutrale Vorgabe.
    if (interactive && answers.auth !== 'none') answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
    if (args.includes('--no-mcp')) answers.mcp = false;
    return { answers };
};

/** Die erste Config aus den Antworten von `init`; ohne Antworten die Vorlage mit erkanntem Framework. */
export const starterConfig = ({ framework = 'web', language: projectLanguage = language(), appDir, url, auth = 'form', login = {}, explored = false, roles, startUrl, messageSelectors, consoleIgnore } = {}) => {
    if (!FRAMEWORK_NAMES.includes(framework)) throw new CawError('usage', t('cli.unknownFramework', { framework, names: FRAMEWORK_NAMES.join(', ') }));
    if (!['form', 'storageState', 'none'].includes(auth)) throw new CawError('usage', t('cli.initAuthUnknown', { auth }));
    const names = roles ?? [DEFAULT_ROLE];
    const bad = names.find((name) => !/^[a-z][a-z0-9-]*$/.test(name));
    if (bad !== undefined || names.length === 0) throw new CawError('usage', t('cli.badRoleName', { name: bad ?? '' }));
    // Die Sprache steht vorn: Sie gilt fuer Werkbank, Chat, Ausgaben und Bericht dieses Projekts.
    const config = { language: projectLanguage, ...JSON.parse(readFileSync(templatePath('caw.config.example.json'), 'utf8')) };
    config.framework = framework;
    if (url !== undefined) config.environments = { local: { ...config.environments.local, url } };
    // Je Rolle eigene Variablen fuer die Zugangsdaten, etwa CAW_LOGIN_ADMIN und CAW_PW_ADMIN.
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
    // Aus explore: gefundene Selektoren statt der Platzhalter der Vorlage.
    if (auth === 'form') {
        for (const key of ['path', 'userSelector', 'passwordSelector', 'submitSelector', 'signedInSelector']) {
            if (typeof login[key] === 'string' && login[key] !== '') config.auth[key] = login[key];
            // Was explore nicht fand, ist kein Platzhalter, der echt aussieht: TODO meldet doctor, bis der Mensch es eintraegt.
            else if (explored && key !== 'submitSelector') config.auth[key] = TODO;
        }
    }
    if (typeof startUrl === 'string' && startUrl.startsWith('/')) config.apps.web.startUrl = startUrl;
    if (typeof appDir === 'string' && appDir !== '') config.apps.web.dir = appDir;
    if (Array.isArray(messageSelectors) && messageSelectors.length > 0) config.messageSelectors = messageSelectors;
    if (Array.isArray(consoleIgnore) && consoleIgnore.length > 0) config.consoleIgnore = consoleIgnore;
    return config;
};

/**
 * Die Werkzeuge fuer die eigene Claude-Code-Session; eine vorhandene .mcp.json bekommt den Eintrag dazu, sonst bleibt sie, wie sie ist.
 * @returns true, wenn die Datei geschrieben wurde
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
        console.log(t('cli.mcpInvalid'));
        return false;
    }
    if (mcp.mcpServers?.['caw-ai'] !== undefined) return false;
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), 'caw-ai': MCP_ENTRY };
    writeFileSync(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`);
    return true;
};

/**
 * `caw-ai skill`: nur der Skill (und der MCP-Eintrag), ohne Config. Damit kann Claude Code das Einrichten selbst fuehren
 * („richte caw ein“). Ein vorhandener Skill wird auf den Stand dieser Version gebracht.
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
    console.log(`${skillText}${mcp ? ', .mcp.json' : ''}.`);
    if (!existsSync(join(root, CONFIG_FILE))) console.log(t('cli.skillNext'));
    return EXIT.pass;
};

/**
 * Legt Config, Beispiel-Test, Skill und .gitignore-Eintraege an. Vorhandenes bleibt unangetastet.
 * @param answers aus dem Dialog von `init` (`framework`, `url`, `auth`); ohne: Vorlage mit erkanntem Framework
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
    // Kein Beispieltest: Er passte nie zur Anwendung und brach validate, sobald Rollen umbenannt waren. Den ersten Test nimmt record auf.
    if (config.auth?.type === 'form' || config.auth?.type === 'basic') {
        // Die Namen kommen aus den Rollen der Config, damit Beispiel und Config zusammenpassen.
        const names = Object.values(config.roles ?? {}).flatMap(({ loginEnv, passwordEnv }) => [loginEnv, passwordEnv]).filter(Boolean);
        write(`${ENV_FILE}.example`, `${t('cli.envExampleHead')}\n${names.map((name) => `${name}=`).join('\n')}\n`);
    }
    write(`${SKILL_DIR}/SKILL.md`, template('skill.md'));
    if (answers.mcp !== false && addMcpEntry(root)) created.push('.mcp.json');

    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    const lines = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`].filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length > 0) {
        appendFileSync(ignore, `\n# caw-ai\n${lines.join('\n')}\n`);
        created.push('.gitignore');
    }
    console.log(created.length > 0 ? t('cli.initCreated', { files: created.join(', ') }) : t('cli.initAlready'));
    const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
    if (created.includes(CONFIG_FILE) && todo.length > 0) console.log(t('cli.initTodo', { keys: todo.join(', ') }));
    if (created.includes(CONFIG_FILE)) console.log(t('cli.initNext', { target: Object.keys(config.environments)[0] }));
    return EXIT.pass;
};

/**
 * Sitzung einer Rolle speichern, fuer `auth.type: storageState` (etwa SSO): Chrome oeffnet die Anmeldung, der Mensch meldet sich an,
 * die Sitzung landet in caw/.auth/<rolle>.json. Ohne Claude und ohne Docker.
 * @param capture nur fuer Tests: ersetzt Chrome
 */
export const auth = async (root, args, { capture } = {}) => {
    const [roleName] = args;
    const index = args.indexOf('--target');
    const target = index === -1 ? undefined : args[index + 1];
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
    console.log(t('cli.authSaved', { file: sessionPath(resolved.target, roleName) }));
    return EXIT.pass;
};

/** Prueft Config und alle Tests gegen alle ihre Ziele, ohne Docker oder Netz. Veraltete Schritte sind kein Fehler, nur ein Hinweis. */
export const validate = (root) => {
    const config = loadConfig(root);
    const dir = join(root, TEST_DIR);
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const problems = [];
    const hints = [];
    for (const file of files) {
        try {
            // Beschreibung samt Aufzeichnung aus caw/recordings; eine fremde id meldet loadTest.
            const spec = loadTest(root, file.slice(0, -'.yaml'.length));
            for (const target of spec.targets) {
                try {
                    checkTest(spec, target, config);
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
    hints.forEach((hint) => ui.note(hint));
    console.log(t('cli.validateOk', { config: CONFIG_FILE, count: files.length }));
    return EXIT.pass;
};

/** Baut das Sandbox-Image, falls es zu Image, Benutzer und Tool-Stand noch keines gibt. */
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
    // realpath: Der Temp-Pfad kann unter Windows eine Kurzform wie FSCHUB~1 enthalten, die WSL nicht kennt.
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
 * Das Basis-Image der Sandbox und sein Benutzer: `sandboxImage` aus der Config, sonst das Image aus .devcontainer/devcontainer.json,
 * sonst ein schlichtes Node-Image. Hinein kommen Claude und der Container-Teil des Tools.
 */
export const sandboxBase = (root, config) => {
    if (config.sandboxImage !== undefined) return { image: config.sandboxImage, user: config.sandboxUser ?? SANDBOX_USER };
    const devcontainer = join(root, '.devcontainer/devcontainer.json');
    if (existsSync(devcontainer)) return { image: projectImage(parseJsonc(readFileSync(devcontainer, 'utf8'))), user: config.sandboxUser ?? SANDBOX_USER };
    // Der Benutzer node hat dort die uid 1000 wie meist der Besitzer des Projektordners: So darf er in den Lauf-Ordner schreiben.
    return { image: DEFAULT_SANDBOX_IMAGE, user: config.sandboxUser ?? 'node' };
};

/** Alles, was `docker run` braucht. */
const prepareSandbox = async (root, docker, config) => {
    const { image: baseImage, user } = sandboxBase(root, config);
    const image = await ensureImage(docker, baseImage, user);
    const emptyFile = join(root, RUN_DIR, 'empty');
    mkdirSync(join(root, RUN_DIR), { recursive: true });
    writeFileSync(emptyFile, '');
    const containerRoot = toWslPath(root);
    return { docker, image, hostRoot: docker.hostPath(root), containerRoot, masks: maskArgs(root, containerRoot, docker.hostPath(emptyFile)) };
};

/** Abweisen, bevor irgendetwas Teures startet. */
/**
 * Lokaler Code nur, wenn der Watch des Frameworks laeuft (sofern der Adapter einen kennt). Sonst ersetzt caw-ai nichts und testet den
 * deployten Stand, damit ein veralteter oder halber Build keinen Fehler vortaeuscht.
 */
export const withRunningWatch = (config, checked, running = processRunning) => {
    if (checked.source !== 'watch') return checked;
    const { watch } = frameworkOf(config);
    if (watch === undefined || running(watch.command) !== false) return checked;
    ui.note(t('cli.noWatch', { label: watch.label }));
    return { ...checked, source: 'deployed' };
};

/** Gibt es nur eine Rolle bzw. App, braucht der neue Test kein Flag dafuer. */
const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/** Der Aufruf, der den Test neu aufnimmt: Flags nur fuer das, was die Config nicht eindeutig vorgibt. */
const recordHint = (config, id, target) => [
    `caw-ai record ${id} --target ${target}`,
    ...(onlyKey(config.roles) === undefined ? [`--role <${Object.keys(config.roles ?? {}).join('|') || 'role'}>`] : []),
    ...(onlyKey(config.apps) === undefined ? [`--app <${Object.keys(config.apps ?? {}).join('|') || 'app'}>`] : []),
].join(' ');

const loadChecked = (root, id, target) => {
    const config = loadConfig(root);
    if (!existsSync(testPath(root, id))) throw new CawError('test-missing', t('cli.testMissing', { file: `${TEST_DIR}/${id}.yaml`, hint: recordHint(config, id, target) }));
    const spec = loadTest(root, id);
    return { config, spec, checked: withRunningWatch(config, checkTest(spec, target, config)) };
};

/** Die Umgebungen, auf denen Claude arbeiten darf, als Text: "dev" oder "dev, local". */
const agentEnvironments = (config) => environmentsWith(config, 'agent').join(', ') || t('cli.noEnvironment');

/** Claude arbeitet nur auf Umgebungen mit `agent`: Die anderen sollen scheitern, wenn etwas nicht passt. */
const requireAgent = (config, checked, target, verb) => {
    if (!checked.agent) throw new CawError('write-protected', t('cli.agentOnly', { verb, environments: agentEnvironments(config), target }));
};

/**
 * Wo Claude laeuft. Lokal (Standard) braucht es nur Claude Code im PATH; mit Docker auch Token und Image. Mit festen Ablaeufen statt
 * Claude braucht es weder Claude Code noch Token.
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
    // Vor dem Image-Bau: Ohne Token muss niemand auf den Bau warten.
    if (!scripted && !await docker.hasToken()) {
        throw new CawError('token-missing', t('cli.tokenMissing', { hint: docker.tokenHint }));
    }
    return prepareSandbox(root, docker, config);
};

/** Ein Test im Entstehen. Die Metadaten stehen fest, bevor Claude startet: Rolle und Ziel entscheidet der Mensch. */
const draftTest = (root, config, { id, target, role: chosenRole, app: chosenApp, also, readOnly = false }) => {
    const role = chosenRole ?? onlyKey(config.roles);
    const app = chosenApp ?? onlyKey(config.apps);
    if (role === undefined || app === undefined) {
        const missing = [...(role === undefined ? ['--role'] : []), ...(app === undefined ? ['--app'] : [])];
        throw new CawError('usage', t('cli.draftMissing', { id, missing: missing.join(t('cli.and')), hint: recordHint(config, id, target) }));
    }
    for (const name of [app, ...also]) {
        if (config.apps[name] === undefined) throw new CawError('test-invalid', t('cli.unknownApp', { name }));
    }
    return {
        id,
        app,
        role,
        targets: [target],
        // Gibt es lokalen Code zum Einspielen, testet der Test den lokalen Stand, sonst den deployten.
        source: hasLocalCode(config, [app, ...also]) ? 'watch' : 'deployed',
        // Schreibend, ausser der Mensch sagt es anders; schreibt ein lesender Test doch, wird er beim Uebernehmen schreibend.
        mutates: !readOnly,
        also,
        notes: '',
        steps: [],
        expectations: [],
    };
};

/**
 * Der Mensch waehlt den Start und fuehrt gegebenenfalls im eigenen Browser vor. Danach ist das Fenster wieder zu: Claude
 * beginnt frisch.
 * @returns die Vorfuehrung, undefined wenn Claude dem alten Testplan nachgeht
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
        chat = await openChat({ session, logPath: join(dir, 'chat.log'), onAbort: () => process.emit('SIGINT'), onOpen: conversation.onChatOpen, transcript: conversation.transcript });
        // Ist die letzte Aufnahme nach der Vorfuehrung gescheitert (Anmeldung, Claude), muss der Mensch nicht noch einmal vorfuehren.
        const last = lastDemonstration(root, spec.id);
        const reuse = last === null ? null : { id: 'reuse', label: t('cli.choiceReuse', { time: new Date(last.at).toLocaleTimeString(language() === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }), count: last.items.length }), primary: true };
        const options = [...(reuse === null ? [] : [reuse]), reuse === null ? SHOW() : { ...SHOW(), primary: false }, ...(exists ? [FOLLOW()] : [])];
        if (options.length > 1) {
            // Beschrieben, aber nie aufgenommen, ist kein alter Plan: Dann gibt es nichts, was abgeloest wuerde.
            const recorded = exists && spec.steps.some((step) => step.recording !== undefined);
            let question = t('cli.questionNew', { id: spec.id });
            if (recorded) question = t('cli.questionRecorded', { id: spec.id });
            else if (exists) question = t('cli.questionDescribed', { id: spec.id });
            const choice = await Promise.race([chat.choose('choosing', question, options), session.closed.then(() => null)]);
            if (choice === null) throw aborted();
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
                return { items, dir };
            }
            // Nichts vorgefuehrt: Mit Testplan geht Claude ihm nach, sonst gibt es nichts, woraus Claude den Plan machen koennte.
            if (exists) {
                ui.note(t('cli.demoNothingFollow'));
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
 * Was ein Lauf mit Claude immer gleich braucht. Der Chat ist bei allem dabei, was einen Abschluss hat.
 * `lazyChat` true oeffnet ihn erst bei einem gescheiterten Schritt, 'warnings' auch bei Fehlern und Warnungen; `testing` zeigt im
 * Chat einen Testlauf statt eines Pruefdurchlaufs.
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

/** Eine Zeile zu Beginn des Laufs: was der Lauf darf und warum, damit sich kein Modus still aus der Umgebung ergibt. */
export const runMode = ({ withAgent, noChat, headless, inCi, withAdvice, environments }) => {
    if (!withAgent) return t('cli.modeNoAgent', { environments });
    if (headless) return t('cli.modeHeadless');
    if (noChat) return t('cli.modeNoChat');
    if (inCi) return t('cli.modeCi');
    return t('cli.modeChat', { advice: withAdvice ? t('cli.modeAdvice') : '', dir: RECORDING_DIR });
};

/**
 * Testlauf nach Plan, ohne Claude, Docker und Token. Auf Umgebungen mit agent steht der Chat von Anfang an daneben, ausser in CI (Variable CI); scheitert ein Schritt,
 * klaert der Mensch ihn dort und kann ihn beheben lassen. Mit --until stellt der Lauf einen Zustand her und uebergibt das Fenster, damit
 * sich von dort aus am lokalen Code weiterarbeiten laesst. Mit --advise empfiehlt Claude bei Fehlern und Warnungen, das kostet Token.
 * --no-chat laeuft wie in CI, --headless zusaetzlich ohne Fenster.
 * @param interactive   nur fuer Tests: ersetzt die Erkennung von CI
 * @param adviseCommand nur fuer Tests: ersetzt Claude beim Empfehlen
 * @param talkCommand   nur fuer Tests: ersetzt Claude im Gespraech
 */
export const run = async (root, args, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}) => {
    const { test, target, handover, stepTimeoutSec, until, advise: withAdvice, headless, noChat, agent, timeoutMin, maxSteps } = parseRunArgs('run', args);
    const { config, spec, checked: resolved } = loadChecked(root, test, target);
    if (until !== undefined && !spec.steps.some(({ id }) => id === until)) throw new CawError('step-unknown', t('cli.stepUnknown', { test, step: until }));
    const { assertPlayable } = await import('./replay.mjs');
    assertPlayable(spec, target, until);
    // Ein Zustand fuer die Entwicklung braucht den lokalen Code, wo es ihn gibt.
    const checked = until !== undefined && resolved.localCode ? withRunningWatch(config, { ...resolved, source: 'watch' }) : resolved;
    const withAgent = resolved.agent;
    // Der Chat liegt in der Werkbank und braucht kein Terminal. Nur in CI wartet niemand auf ihn.
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const canFix = withAgent && !noChat && !inCi;
    // Lieber gleich abweisen als still ohne Empfehlung laufen: Wer --advise angibt, erwartet sie.
    if (withAdvice && !withAgent) throw new CawError('usage', t('cli.adviseAgentOnly', { environments: agentEnvironments(config), target }));
    if (withAdvice && !canFix) throw new CawError('usage', t('cli.adviseNeedsChat'));
    ui.info(runMode({ withAgent, noChat, headless, inCi, withAdvice, environments: agentEnvironments(config) }));
    const { runFlow } = await import('./flows.mjs');
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin: timeoutMin ?? CLAUDE_TIMEOUT_MIN, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen, headless });
    return runFlow({
        spec,
        until,
        handover: handover || until !== undefined,
        canFix,
        advise: withAdvice,
        // Die eigene Claude-Code-Session ist sofort da und kostet hier nichts: Sie darf die Seite im Zustand gleich lesen.
        sessionAgent: agent === 'session',
        // Nur auf dev mit Chat: Ohne Chat, etwa in CI, aendert ein Lauf die Testdatei nicht.
        fillBaselines: canFix,
        openSandbox: () => openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent }),
        execute,
        adopt: (draft, only, options) => writeTest(root, draft, only, options),
        log: ui.info,
        // Erst die Ursache, dann aendern: `fix` nimmt den Schritt neu auf und sucht keine Ursache, das passt nur zu einer gewollten Aenderung.
        hint: (failed) => ui.info(withAgent
            ? t('cli.failedHintAgent', { step: failed.id, test, target })
            : t('cli.failedHint', { step: failed.id, environments: agentEnvironments(config) })),
    });
};

/**
 * Widersprechen --role, --app, --also oder --read-only einem Test, der schon in der Datei steht (etwa von Claude beschrieben)?
 * Wiederholte, passende Angaben sind kein Widerspruch.
 */
export const contradicts = (spec, { role, app, also = [], readOnly = false }) => (role !== undefined && role !== spec.role)
    || (app !== undefined && app !== spec.app)
    || also.some((name) => !(spec.also ?? []).includes(name))
    || (readOnly && spec.mutates !== false);

/**
 * Testplan neu aufnehmen oder abloesen, immer mit Chat. `containerCommand` ersetzt Claude durch einen festen Ablauf, damit
 * sich der Weg durch Container, Kanal und Browser ohne Modell und Token pruefen laesst.
 */
export const record = async (root, args, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen } = {}) => {
    const { test, target, timeoutMin, stepTimeoutSec, maxSteps, role, app, also, readOnly, agent } = parseRunArgs('record', args);
    const config = loadConfig(root);
    const exists = existsSync(testPath(root, test));
    const spec = exists ? loadTest(root, test) : draftTest(root, config, { id: test, target, role, app, also, readOnly });
    if (exists && contradicts(spec, { role, app, also, readOnly })) throw new CawError('usage', t('cli.recordExists', { test }));
    const checked = withRunningWatch(config, checkTest(spec, target, config));
    requireAgent(config, checked, target, t('cli.verbRecord'));

    const { recordFlow } = await import('./flows.mjs');
    // Vor der Vorfuehrung: Scheitert Docker erst danach, waere die Arbeit des Menschen umsonst.
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

/** Genau diesen Schritt aendern, auch wenn er nicht scheitert. So bekommt ein von Hand geaenderter oder neuer Schritt seine Aufzeichnung. */
export const fix = async (root, args, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen } = {}) => {
    const { test, step, target, timeoutMin, stepTimeoutSec, maxSteps, agent } = parseRunArgs('fix', args);
    const { config, spec, checked } = loadChecked(root, test, target);
    requireAgent(config, checked, target, t('cli.verbFix'));
    const position = spec.steps.findIndex(({ id }) => id === step);
    if (position === -1) throw new CawError('step-unknown', t('cli.fixStepUnknown', { test, step, file: `${TEST_DIR}/${test}.yaml` }));
    const { assertPlayable } = await import('./replay.mjs');
    if (position > 0) assertPlayable(spec, target, spec.steps[position - 1].id);
    const { fixFlow, runFlow } = await import('./flows.mjs');
    const sandbox = await openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent });
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen });
    const [stale] = staleSteps(spec).filter(({ id }) => id === step);
    // Erst die Ursache: Ein aufgezeichneter Schritt wird zuerst abgespielt. Scheitert er, geht es wie bei run um die Ursache, und eine
    // neue Aufnahme koennte einen Fehler der Anwendung umgehen. Nur ein bestandener oder veralteter Schritt wird neu aufgenommen.
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
        // Nicht gescheitert: Der Mensch will den Schritt neu aufnehmen, etwa nach einer Aenderung von Hand.
        target: { id: step, reason: stale === undefined ? 'Der Mensch möchte diesen Schritt neu aufnehmen, er ist nicht gescheitert' : `${step} ${stale.why}`, rerecord: true },
        sandbox,
        execute,
        adopt: (draft, only, options) => writeTest(root, draft, only, options),
        log: ui.info,
    });
};
