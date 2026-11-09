// `caw-ai doctor`: prueft, ob das Projekt laufen kann, und nennt je Problem den naechsten Schritt. Liest keine Werte von Geheimnissen:
// Vom Token und von den Zugangsdaten zaehlt nur, ob sie gesetzt sind.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AUTH_DIR, TODO, agentSandbox, allTargets, authOf, browserLaunch, loadConfig, resolveTarget, sessionPath } from '../shared/config.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, ENV_FILE, RECORDING_DIR, RUN_DIR } from '../shared/names.mjs';
import { parseEnvFile } from './linux.mjs';
import { claudeVersion } from './local-agent.mjs';

const browserName = (config) => {
    const launch = browserLaunch(config);
    return launch.executablePath ?? launch.channel;
};

const MIN_NODE = 22;

/**
 * Die einzelnen Pruefungen. Jede liefert { ok, text, next?, optional? }; `optional` heisst: nur fuer Laeufe mit Claude noetig.
 * @param probes nur fuer Tests: ersetzt Chrome, Docker und Netz
 */
/** @param agent wo Claude laufen soll (local, docker, session), sonst aus der Config wie bei run */
export const doctorChecks = async (root, { env = process.env, nodeVersion = process.versions.node, probes = {}, agent } = {}) => {
    const results = [];
    const add = (entry) => results.push(entry);
    const major = Number(nodeVersion.split('.')[0]);
    add(major >= MIN_NODE
        ? { ok: true, text: `Node ${nodeVersion}` }
        : { ok: false, text: t('cli.doctorNodeOld', { version: nodeVersion }), next: t('cli.doctorNodeNext', { min: MIN_NODE }) });

    let config = null;
    try {
        config = loadConfig(root);
        add({ ok: true, text: t('cli.doctorConfigOk', { file: CONFIG_FILE }) });
        const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
        if (todo.length > 0) add({ ok: false, text: t('cli.doctorTodo', { keys: todo.join(', ') }), next: t('cli.doctorTodoNext') });
    } catch (error) {
        add(existsSync(join(root, CONFIG_FILE))
            ? { ok: false, text: error.message.split('\n')[0].replace(/\.$/, ''), next: t('cli.doctorConfigNextValidate') }
            : { ok: false, text: t('cli.doctorConfigMissing', { file: CONFIG_FILE }), next: t('cli.doctorConfigNextInit') });
    }

    const chrome = probes.chrome ?? (async () => {
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({ ...browserLaunch(config), headless: true });
        await browser.close();
    });
    try {
        await chrome();
        add({ ok: true, text: t('cli.doctorBrowserOk', { browser: browserName(config) }) });
    } catch (error) {
        add({ ok: false, text: t('cli.doctorBrowserFail', { browser: browserName(config), error: String(error?.message ?? error).split('\n')[0] }), next: t('cli.doctorBrowserNext') });
    }

    // Claude braucht es nur fuer record, fix und den Chat; lokal reicht Claude Code, in Docker kommen Docker und Token dazu.
    const sandbox = agent ?? agentSandbox(config ?? {}, env);
    if (sandbox === 'session') {
        // Die eigene Claude-Code-Session uebernimmt ueber caw-ai mcp: Dafuer braucht es nur den Eintrag in .mcp.json.
        const mcp = join(root, '.mcp.json');
        let listed = false;
        try {
            listed = existsSync(mcp) && JSON.parse(readFileSync(mcp, 'utf8'))?.mcpServers?.['caw-ai'] !== undefined;
        } catch {
            // Kaputte .mcp.json: zaehlt wie ein fehlender Eintrag.
        }
        add(listed
            ? { ok: true, optional: true, text: t('cli.doctorSessionOk') }
            : { ok: false, optional: true, text: t('cli.doctorSessionMissing'), next: t('cli.doctorSessionNext') });
    } else if (sandbox === 'local') {
        const version = (probes.claude ?? claudeVersion)();
        add(version !== undefined
            ? { ok: true, optional: true, text: t('cli.doctorClaudeOk', { version }) }
            : { ok: false, optional: true, text: t('cli.doctorClaudeMissing'), next: t('cli.doctorClaudeNext') });
    } else {
        const docker = probes.docker ?? (async () => (await import('./docker.mjs')).selectDocker());
        try {
            const found = await docker();
            add({ ok: true, optional: true, text: t('cli.doctorDockerOk', { label: found.label }) });
        } catch (error) {
            add({ ok: false, optional: true, text: String(error?.message ?? error).split('\n')[0], next: t('cli.doctorDockerNext') });
        }
        add(typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' && env.CLAUDE_CODE_OAUTH_TOKEN !== ''
            ? { ok: true, optional: true, text: t('cli.doctorTokenOk') }
            : { ok: false, optional: true, text: t('cli.doctorTokenMissing'), next: t('cli.doctorTokenNext') });
    }

    // Locker verglichen: "/.caw", ".caw/" und "**/.caw/" meinen dasselbe; Kommentare und Negationen zaehlen nicht.
    const normalize = (line) => line.trim().replace(/^(\*\*\/|\/)/, '').replace(/\/(\*\*?)?$/, '');
    const ignore = existsSync(join(root, '.gitignore'))
        ? readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).filter((line) => !/^\s*(#|!)/.test(line)).map(normalize)
        : [];
    const unignored = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`].filter((line) => !ignore.includes(normalize(line)) && !(line === ENV_FILE && ignore.includes('.env')));
    add(unignored.length === 0
        ? { ok: true, text: t('cli.doctorIgnoreOk') }
        : { ok: false, text: t('cli.doctorIgnoreMissing', { lines: unignored.join(', ') }), next: t('cli.doctorIgnoreNext') });

    if (config === null) return results;

    const auth = authOf(config);
    if (auth.type === 'form' || auth.type === 'basic') {
        const file = join(root, ENV_FILE);
        const values = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
        for (const [name, role] of Object.entries(config.roles ?? {})) {
            const missing = [role.loginEnv, role.passwordEnv, role.totpEnv].filter((key) => key !== undefined && !env[key] && !values[key]);
            add(missing.length === 0
                ? { ok: true, text: t('cli.doctorRoleOk', { name }) }
                : { ok: false, text: t('cli.doctorRoleMissing', { name, missing: missing.join(', '), count: missing.length, file: ENV_FILE }), next: t('cli.doctorRoleNext', { file: ENV_FILE }) });
        }
    }
    if (auth.type === 'storageState') {
        for (const name of Object.keys(config.roles ?? {})) {
            for (const target of allTargets(config).filter((candidate) => !resolveTarget(config, candidate).production)) {
                add(existsSync(join(root, sessionPath(target, name)))
                    ? { ok: true, text: t('cli.doctorSessionSaved', { name, target }) }
                    : { ok: false, optional: true, text: t('cli.doctorSessionNone', { name, target }), next: `caw-ai auth ${name} --target ${target}` });
            }
        }
    }

    const reach = probes.reachable ?? (async (url) => (await import('./run.mjs')).reachable(url));
    for (const target of allTargets(config)) {
        const { url, production } = resolveTarget(config, target);
        // Produktion fragt das Tool nicht an, auch nicht zur Probe.
        if (production) continue;
        add(await reach(url)
            ? { ok: true, optional: true, text: t('cli.doctorReachOk', { target, url }) }
            : { ok: false, optional: true, text: t('cli.doctorReachFail', { target, url }), next: t('cli.doctorReachNext') });
    }
    return results;
};

/** Gibt die Pruefungen aus. Exit 0, wenn alles Noetige stimmt; fehlt nur Optionales, ebenfalls 0. */
export const doctor = async (root, options = {}) => {
    const { ui } = options;
    const results = await doctorChecks(root, options);
    // Die Marke steht im Text, damit auch die schlichte Ausgabe ohne Symbole und Farben lesbar bleibt.
    for (const { ok, optional, text, next } of results) {
        if (ok) ui.success(`${t('cli.doctorMarkOk')}${text}`);
        else if (optional) ui.note(`${t('cli.doctorMarkOptional')}${text}. ${next}`);
        else ui.warn(`${t('cli.doctorMarkMissing')}${text}. ${next}`);
    }
    const blocking = results.filter(({ ok, optional }) => !ok && !optional).length;
    const optionalMissing = results.filter(({ ok, optional }) => !ok && optional).length;
    const summary = t('cli.doctorSummary', { ok: results.length - blocking - optionalMissing, blocking, optional: optionalMissing });
    // Der naechste Schritt haengt davon ab, ob es schon aufgenommene Tests gibt: Ein nur beschriebener (wie das Beispiel aus init)
    // laesst sich noch nicht abspielen, zuerst aufnehmen.
    const dir = join(root, RECORDING_DIR);
    const tests = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const ready = tests.length === 0 ? t('cli.doctorReadyFirst') : t('cli.doctorReady');
    if (blocking === 0) ui.success(`${summary}. ${ready}`);
    else ui.warn(t('cli.doctorFixFirst', { summary }));
    return blocking === 0 ? 0 : 2;
};
