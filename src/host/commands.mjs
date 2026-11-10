// Die Befehle auf dem Host. Init und validate kommen ohne Browser-Code und Docker aus.

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
import { frameworkOf } from './framework/index.mjs';
import { DEFAULT_MAX_STEPS } from './step-budget.mjs';
import { CLAUDE_TIMEOUT_MIN, optionValue, parseRunArgs, toWslPath } from './linux.mjs';
import { EXPLORE_FILE, explore } from './explore.mjs';
import { maskArgs, parseJsonc, projectImage, renderDockerfile, templatePath, toolFingerprint } from './sandbox-config.mjs';
import { describeCode } from './code-source.mjs';
import { brokenChain, checkTest, loadTest, recordingHints, staleSteps, testPath, withDefaults, writeTest } from './test-file.mjs';

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
    const from = optionValue(args, '--from');
    let url = optionValue(args, '--url');
    let file = from;
    if (url !== undefined && checkUrl(url) !== null) throw new CawError('usage', checkUrl(url));
    // Ohne Anwendung: die Vorlage mit TODO in der Anmeldung. Auch ohne Terminal und ohne --url, statt abzubrechen.
    const offline = args.includes('--offline') || (file === undefined && url === undefined && !interactive && !existsSync(join(root, EXPLORE_FILE)));
    if (offline && from === undefined) {
        if (!args.includes('--offline')) console.log(t('cli.initOfflineFallback'));
        const answers = { ...(url === undefined ? {} : { url }), offline: true };
        if (interactive) answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
        if (args.includes('--no-mcp')) answers.mcp = false;
        return { answers };
    }
    if (file === undefined && url === undefined && existsSync(join(root, EXPLORE_FILE))) {
        file = EXPLORE_FILE;
        console.log(t('cli.initUsesExplore', { file }));
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
    // Rollen kennt explore nicht: im Terminal fragen, sonst eine neutrale Vorgabe.
    if (interactive && answers.auth !== 'none') answers.roles = (await askLine({ input, output }, t('cli.askRoles'), DEFAULT_ROLE, checkRoles)).split(',').map((name) => name.trim());
    if (args.includes('--no-mcp')) answers.mcp = false;
    return { answers };
};

/** Die erste Config aus den Antworten von `init`; ohne Antworten die Vorlage mit erkanntem Framework. */
export const starterConfig = ({ framework = 'web', language: projectLanguage = language(), appDir, url, auth = 'form', login = {}, explored = false, offline = false, roles, startUrl, messageSelectors, consoleIgnore } = {}) => {
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
    // Der Ordner fuer die Testplaene und die Notizen fuer Claude: So sieht man gleich, wohin was gehoert.
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
    console.log(created.length > 0 ? t('cli.initCreated', { files: created.join(', ') }) : t('cli.initAlready'));
    const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
    if (created.includes(CONFIG_FILE) && todo.length > 0) console.log(t(answers.offline ? 'cli.initTodoOffline' : 'cli.initTodo', { keys: todo.join(', ') }));
    // Lief explore eben, waere der Rat, es erst laufen zu lassen, verwirrend.
    if (created.includes(CONFIG_FILE)) console.log(`${t('cli.initNext', { target: Object.keys(config.environments)[0] })}${answers.explored ? '' : t('cli.initNextExplore')}`);
    return EXIT.pass;
};

/**
 * Sitzung einer Rolle speichern, fuer `auth.type: storageState` (etwa SSO): Chrome oeffnet die Anmeldung, der Mensch meldet sich an,
 * die Sitzung landet in caw/.auth/<rolle>.json. Ohne Claude und ohne Docker.
 * @param capture nur fuer Tests: ersetzt Chrome
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
    console.log(t('cli.authSaved', { file: sessionPath(resolved.target, roleName) }));
    return EXIT.pass;
};

/** Prueft Config und alle Tests gegen alle ihre Ziele, ohne Docker oder Netz. Veraltete Schritte sind kein Fehler, nur ein Hinweis. */
export const validate = (root) => {
    const { config, notes } = loadConfigWithNotes(root);
    const dir = join(root, TEST_DIR);
    const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const problems = [];
    const hints = [...notes, ...todoNotes(config)];
    // Je Test und Ziel eine Zeile, welcher Code dort laeuft: So faellt ein stiller ausgelieferter Stand schon hier auf.
    const codeLines = [];
    for (const file of files) {
        try {
            // Beschreibung samt Aufzeichnung aus caw/recordings; eine fremde id meldet loadTest.
            const spec = withDefaults(loadTest(root, file.slice(0, -'.yaml'.length)), config);
            for (const target of spec.targets) {
                try {
                    const checked = checkTest(spec, target, config);
                    // Wo das Overlay ginge, steht es dabei: Ohne --overlay laeuft trotzdem der ausgelieferte Stand. Stehen Build und
                    // Dev-Server an der App, verlangt ein blosses --overlay die Wahl; dann stehen beide da, mit ihrem Wert.
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
    console.log(t('cli.validateOk', { config: CONFIG_FILE, count: files.length }));
    return EXIT.pass;
};

/** Je Wert der Anmeldung, der seit init noch TODO ist, ein Hinweis mit dem, was dort hingehoert. */
const todoNotes = (config) => Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO)
    .map(([key]) => t('cli.validateTodo', { key: `auth.${key}`, what: t(`cli.validateTodo.${key}`) }));

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

/** Gibt es nur eine Rolle bzw. App, braucht der neue Test kein Flag dafuer. */
const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/** Die Ziele, auf denen Claude arbeiten darf (Umgebungen mit agent), mit Mandanten je Mandant. */
const claudeTargets = (config) => allTargets(config).filter((name) => {
    try {
        return resolveTarget(config, name).agent;
    } catch {
        return false;
    }
});

/** Der Aufruf, der den Test neu aufnimmt: Flags nur fuer das, was die Config nicht eindeutig vorgibt. */
const recordHint = (config, id, target) => {
    // Ohne --target genuegt der Aufruf ohne, wenn es nur eine Umgebung fuer Claude gibt; sonst die Auswahl.
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

/** Die Namen aller Tests in caw/tests, sortiert. */
const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

/** " Meintest du x?" oder nichts. */
const suggestion = (word, candidates) => {
    const near = closest(word, candidates);
    return near === undefined ? '' : t('cli.didYouMean', { name: near });
};

/** Den Test gibt es nicht: mit Vorschlag, den bekannten Tests und dem Aufruf, der ihn neu aufnimmt. */
const testMissing = (root, config, id, target) => {
    const known = testIds(root);
    return new CawError('test-missing', t('cli.testMissing', {
        file: `${TEST_DIR}/${id}.yaml`,
        suggestion: suggestion(id, known),
        known: known.length === 0 ? t('cli.noTests') : t('cli.knownTests', { tests: known.join(', ') }),
        hint: recordHint(config, id, target),
    }));
};

/** Die Schritte als Text: lueckenlos "S1–S6", sonst aufgezaehlt. */
export const stepsText = (spec) => {
    const ids = spec.steps.map(({ id }) => id);
    const plain = ids.every((id, index) => id === `S${index + 1}`);
    return plain && ids.length > 2 ? `${ids[0]}–${ids.at(-1)}` : ids.join(', ');
};

/** Den Schritt gibt es nicht: mit Vorschlag und den Schritten des Tests. */
const stepUnknown = (key, spec, step, extra = {}) => new CawError('step-unknown', t(key, {
    test: spec.id,
    step,
    suggestion: suggestion(step, spec.steps.map(({ id }) => id)),
    steps: t('cli.knownSteps', { steps: stepsText(spec) }),
    ...extra,
}));

/**
 * Das Ziel, wenn --target fehlt: das einzige Ziel des Tests; bei record und fix das einzige davon, auf dem Claude arbeiten darf;
 * fuer einen neuen Test die einzige Umgebung, auf der Claude arbeiten darf. Die Wahl steht im Terminal, mehrdeutig ist ein Aufruffehler.
 * @param spec der Test, null fuer einen neuen
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
 * Laedt Tests mit den Defaults der Config (id, app, role, targets). Ohne lesbare Config wie geschrieben: list kommt ohne aus.
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

/** Wie weit ein Test aufgenommen ist: recorded, stale (mit den Schritten) oder none. */
const recordingState = (spec) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) return { state: 'none', ids: [] };
    const stale = staleSteps(spec).map(({ id }) => id);
    const chain = brokenChain(spec);
    if (stale.length === 0 && chain === null) return { state: 'recorded', ids: [] };
    return { state: 'stale', ids: stale, chain };
};

/** Spalten mit Abstand, ohne Rahmen: liest sich im Terminal und laesst sich mit grep und awk weiterverarbeiten. */
const columns = (rows) => {
    const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
    return rows.map((row) => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join('  ').trimEnd());
};

/**
 * `caw-ai list`: je Test Ziele, Stand der Aufnahme und ob er schreibt; `caw-ai list <test>` je Schritt eine Zeile. Ohne Browser,
 * ohne Claude, und ohne Config.
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
                // Ohne gueltige Config fehlt dem Hinweis nur die Rolle und App.
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
            // Die Tabelle bleibt schmal, der Grund steht darunter; alle Befunde nennt validate.
            invalid.push(`${id}: ${String(error.message).split('\n')[0]}`);
            return [id, '', t('cli.listInvalid'), ''];
        }
    });
    columns([t('cli.listHead').split('|'), ...rows]).forEach((line) => out(line));
    invalid.forEach((line) => out(line));
    return EXIT.pass;
};
/** Die Umgebungen, auf denen Claude arbeiten darf, als Text: "dev" oder "dev, local". */
const agentEnvironments = (config) => environmentsWith(config, 'agent').join(', ') || t('cli.noEnvironment');

/** Claude arbeitet nur auf Umgebungen mit `agent`: Die anderen sollen scheitern, wenn etwas nicht passt. */
const requireAgent = (config, checked, target, verb) => {
    if (!checked.agent) throw new CawError('write-protected', t('cli.agentOnly', { verb, environments: agentEnvironments(config), target, environment: checked.environment }));
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
        if (config.apps[name] === undefined) throw new CawError('test-invalid', t('cli.unknownApp', { name, apps: Object.keys(config.apps).join(', '), config: CONFIG_FILE }));
    }
    return {
        id,
        app,
        role,
        targets: [target],
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
        chat = await openChat({ session, logPath: join(dir, 'chat.log'), onAbort: () => process.emit('SIGINT'), onOpen: conversation.onChatOpen, onWaiting: ui.note, transcript: conversation.transcript });
        // Gleich geht dieses Fenster zu und Claude bekommt ein neues: Das sagen Chat und Terminal vorher.
        const handOver = () => {
            const line = t('run.newWindow', { what: t('run.newWindow.claude') });
            chat.notice(line);
            ui.note(line);
        };
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
            // Nichts vorgefuehrt: Mit Testplan geht Claude ihm nach, sonst gibt es nichts, woraus Claude den Plan machen koennte.
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
/** Aufnehmen und Beheben brauchen einen Menschen fuer Vorfuehrung, Plan und Entscheidungen. In CI ist keiner da: abweisen statt warten. */
const requireHuman = (command, interactive) => {
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    if (inCi) throw new CawError('usage', t('cli.ciNeedsHuman', { command }));
};

export const runMode = ({ withAgent, noChat, headless, inCi, withAdvice, environments, learn = true, file = RECORDING_DIR }) => {
    if (!withAgent) return t('cli.modeNoAgent', { environments });
    if (headless) return t('cli.modeHeadless');
    if (noChat) return t('cli.modeNoChat');
    if (inCi) return t('cli.modeCi');
    const advice = withAdvice ? t('cli.modeAdvice') : '';
    return learn ? t('cli.modeChat', { advice, file }) : t('cli.modeChatNoLearn', { advice });
};

/**
 * Merkt sich, was ein Lauf an den Dateien des Tests aendert, fuer die Zeile am Ende: "Geaendert: caw/recordings/x.yaml
 * (Vergleichswerte S2, S5)" oder "Testdatei unveraendert".
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
 * Ein Testlauf nach Plan, ohne Claude, Docker und Token. Auf Umgebungen, auf denen Claude arbeiten darf, steht der Chat von Anfang an
 * daneben, ausser in CI (Variable CI); scheitert ein Schritt, klaert der Mensch ihn dort und kann ihn beheben lassen. Mit --until stellt
 * der Lauf einen Zustand her und uebergibt das Fenster, damit sich von dort aus am lokalen Build weiterarbeiten laesst. Mit --advise
 * empfiehlt Claude bei Fehlern und Warnungen, das kostet Token. --no-chat laeuft wie in CI, --headless zusaetzlich ohne Fenster.
 * --no-learn laesst den Chat, lernt aber keine Vergleichswerte.
 * @param quiet im Stapel: ohne Zeile zum Modus, die nennt der Stapel einmal
 * @returns { code, failed } mit dem gescheiterten Schritt ({ id, reason }), falls einer scheiterte
 */
const runOne = async (root, options, { containerCommand, adviseCommand, talkCommand, docker, onChatOpen, interactive } = {}, loaded = undefined) => {
    const { test, handover, stepTimeoutSec, until, advise: withAdvice, headless, noChat, learn, agent, timeoutMin, maxSteps, overlay, quiet = false } = options;
    const { config, spec, target, checked } = loaded ?? loadChecked(root, test, options.target, 'run', { overlay });
    if (until !== undefined && !spec.steps.some(({ id }) => id === until)) throw stepUnknown('cli.stepUnknown', spec, until);
    const { assertPlayable } = await import('./replay.mjs');
    // open hat keine Schritte: nichts abzuspielen, nur anmelden und uebergeben.
    if (loaded === undefined) assertPlayable(spec, target, until);
    const withAgent = checked.agent;
    // Der Chat liegt in der Werkbank und braucht kein Terminal. Nur in CI wartet niemand auf ihn.
    const inCi = !(interactive ?? (process.env.CI === undefined || process.env.CI === ''));
    const canFix = withAgent && !noChat && !inCi;
    // Lieber gleich abweisen als still ohne Empfehlung laufen: Wer --advise angibt, erwartet sie.
    if (withAdvice && !withAgent) throw new CawError('usage', t('cli.adviseAgentOnly', { environments: agentEnvironments(config), target }));
    if (withAdvice && !canFix) throw new CawError('usage', t('cli.adviseNeedsChat'));
    // In CI wartet niemand: Eine Uebergabe hielte den Job bis zum Timeout des Runners offen.
    if (inCi && (handover || until !== undefined)) throw new CawError('usage', t('cli.ciHandover', { option: until !== undefined ? '--until' : '--handover' }));
    if (!quiet) ui.info(runMode({ withAgent, noChat, headless, inCi, withAdvice, environments: agentEnvironments(config), learn, file: `${RECORDING_DIR}/${test}.yaml` }));
    const { runFlow } = await import('./flows.mjs');
    const { execute } = claudeRuns(root, config, { spec, checked, target, timeoutMin: timeoutMin ?? CLAUDE_TIMEOUT_MIN, stepTimeoutSec, maxSteps, containerCommand, adviseCommand, talkCommand, onChatOpen, headless });
    const tracker = changeTracker(root);
    let failed;
    // Wo der Mensch den Fehler mit Chat klaeren kann: das erste Ziel des Tests, auf dem Claude arbeiten darf.
    const claude = new Set(claudeTargets(config));
    const chatTarget = spec.targets.find((name) => claude.has(name));
    const code = await runFlow({
        spec,
        until,
        handover: handover || until !== undefined,
        canFix,
        advise: withAdvice,
        // Die eigene Claude-Code-Session ist sofort da und kostet hier nichts: Sie darf die Seite im Zustand gleich lesen.
        sessionAgent: agent === 'session',
        // Nur mit Chat und ohne --no-learn: Ohne Chat, etwa in CI, aendert ein Lauf die Testdatei nicht.
        fillBaselines: canFix && learn,
        openSandbox: () => openSandbox(root, { config, containerCommand, adviseCommand, talkCommand, docker, agent }),
        execute,
        adopt: tracker.adopt,
        log: ui.info,
        onPlayed: (played) => { failed = played.failed; },
        // Erst die Ursache, dann aendern: `fix` nimmt den Schritt neu auf und sucht keine Ursache, das passt nur zu einer gewollten Aenderung.
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
const xmlText = (text) => String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[<>&"']/g, (char) => XML_ESCAPES[char]);
const JUNIT_TYPES = { [EXIT.fail]: 'fail', [EXIT.error]: 'error', [EXIT.rejected]: 'rejected', [EXIT.needsRecording]: 'needs-recording' };

/** Die Tabelle der Laeufe als JUnit-XML, so wie CI-Systeme sie lesen: fail als failure, alles andere ausser pass als error. */
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
 * Mehrere Tests nacheinander, fuer CI: ohne Chat, ein Test bricht die anderen nicht ab, am Ende die Tabelle und der Exit-Code des
 * schlimmsten Laufs (siehe worstExit). Ohne --target gilt das einzige Ziel der Tests.
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
            // Eine kaputte Datei meldet ihr eigener Lauf als abgelehnt.
        }
    }
    let { target } = options;
    if (target === undefined) {
        const union = [...new Set([...specs.values()].flatMap((spec) => spec.targets ?? []))];
        if (union.length !== 1) throw new CawError('usage', t('session.args.targetMissing', { choices: (union.length > 0 ? union : allTargets(loadConfig(root))).join(', ') }));
        [target] = union;
        ui.info(t('cli.targetChosen', { target, why: t('cli.targetWhyTests') }));
    }
    // --all: jeder Test, der das Ziel nennt; einer, der sich nicht lesen laesst, bleibt dabei und erscheint als abgelehnt.
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
            // Wie bin/caw-ai.mjs: ein erwarteter Fehler nach seinem Code, ein unerwarteter ist error.
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
 * `caw-ai run`: ein Test wie gehabt; mehrere Tests oder --all laufen nacheinander ohne Chat (runMany). Mit --report junit=<datei>
 * geht auch ein einzelner Test diesen Weg, damit CI die Datei in jedem Fall bekommt.
 * @param interactive   nur fuer Tests: ersetzt die Erkennung von CI
 * @param adviseCommand nur fuer Tests: ersetzt Claude beim Empfehlen
 * @param talkCommand   nur fuer Tests: ersetzt Claude im Gespraech
 */
export const run = async (root, args, deps = {}) => {
    const options = parseRunArgs('run', args);
    if (options.batch || options.junit !== undefined) return runMany(root, options, deps);
    return (await runOne(root, options, deps)).code;
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

/** Der Name, unter dem open laeuft: Bericht und Fenstertitel. Ein Test dieses Namens bleibt unberuehrt, open liest und schreibt keinen. */
const OPEN_ID = 'open';

/**
 * Die Anwendung angemeldet oeffnen, ohne Test: Werkbank mit Chat, zum Navigieren und Entwickeln. Wie run --until, nur ohne Schritte
 * davor; mit --overlay mit lokalem Code. Lernt nichts und schreibt keine Testdatei.
 */
export const open = async (root, args, deps = {}) => {
    const options = parseRunArgs('open', args);
    const config = loadConfig(root);
    const target = chooseTarget(config, null, { target: options.target, command: 'open' });
    // Der Lauf heisst wie die App: "Öffnen: shop auf dev".
    const spec = draftTest(root, config, { id: options.app ?? onlyKey(config.apps) ?? OPEN_ID, target, role: options.role, app: options.app, also: [], readOnly: true });
    const checked = checkTest(spec, target, config, { overlay: options.overlay });
    requireHuman('open', deps.interactive);
    const run = { ...options, test: spec.id, handover: true, learn: false, advise: false, headless: false, noChat: false, quiet: true };
    return (await runOne(root, run, deps, { config, spec, target, checked })).code;
};

/** Genau diesen Schritt aendern, auch wenn er nicht scheitert. So bekommt ein von Hand geaenderter oder neuer Schritt seine Aufzeichnung. */
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
