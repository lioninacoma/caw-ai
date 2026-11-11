// `caw-ai doctor`: checks whether the project can run and names the next step for each problem. Never reads secret values:
// for the token and credentials only their presence counts.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AUTH_DIR, agentSandbox, allTargets, authOf, browserLaunch, loadConfig, overlaySettings, resolveTarget, sessionPath, todoFields } from '../shared/config.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, ENV_FILE, RECORDING_DIR, RUN_DIR } from '../shared/names.mjs';
import { ago } from './code-source.mjs';
import { frameworkOf } from './framework/index.mjs';
import { parseEnvFile } from './linux.mjs';
import { claudeVersion } from './local-agent.mjs';
import { OVERLAY_CHECK_FILE, overlayStatus } from './overlay-check.mjs';

const browserName = (config) => {
    const launch = browserLaunch(config);
    return launch.executablePath ?? launch.channel;
};

const MIN_NODE = 22;

/** Reserved example names (RFC 2606, RFC 6761): example.com/.net/.org and everything under .example, .invalid and .test. */
export const isPlaceholderHost = (url) => {
    let hostname;
    try {
        ({ hostname } = new URL(url));
    } catch {
        return false;
    }
    return /(^|\.)(example\.(com|net|org)|example|invalid|test)$/i.test(hostname);
};

/**
 * The individual checks. Each yields { ok, text, next?, optional? }; `optional` means: only needed for runs with Claude.
 * @param probes tests only: replaces Chrome, Docker and network
 * @param agent where Claude should run (local, docker, session), otherwise from the config as for run
 */
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
        const todo = todoFields(config);
        if (todo.length > 0) add({ ok: false, text: t('cli.doctorTodo', { keys: todo.join(', '), count: todo.length }), next: t('cli.doctorTodoNext') });
    } catch (error) {
        // The first real finding; the message itself starts with "caw.config.json:" and lists them below.
        const issues = Array.isArray(error?.issues) ? error.issues : [];
        const first = issues.length > 0 ? `${CONFIG_FILE}: ${issues[0]}` : String(error?.message ?? error).split('\n')[0];
        add(existsSync(join(root, CONFIG_FILE))
            ? { ok: false, text: first.replace(/\.$/, ''), next: t('cli.doctorConfigNextValidate', { count: issues.length }) }
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

    // Claude is only needed for record, fix and the chat; locally Claude Code suffices, Docker also needs Docker and the token.
    const sandbox = agent ?? agentSandbox(config ?? {}, env);
    if (sandbox === 'session') {
        // The developer's own Claude Code session takes over via caw-ai mcp: that only needs the entry in .mcp.json.
        const mcp = join(root, '.mcp.json');
        let listed = false;
        try {
            listed = existsSync(mcp) && JSON.parse(readFileSync(mcp, 'utf8'))?.mcpServers?.['caw-ai'] !== undefined;
        } catch {
            // A broken .mcp.json counts as a missing entry.
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
        // Docker only with an API key; the value is never shown.
        add(typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== ''
            ? { ok: true, optional: true, text: t('cli.doctorTokenOk', { name: 'ANTHROPIC_API_KEY' }) }
            : { ok: false, optional: true, text: t('cli.doctorTokenMissing'), next: t('cli.doctorTokenNext') });
    }

    // Loose comparison: "/.caw", ".caw/" and "**/.caw/" mean the same; comments and negations do not count.
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
        // The tool never contacts production, not even to probe it.
        if (production) continue;
        // A placeholder such as staging.example.com never answers: say so instead of probing it.
        if (isPlaceholderHost(url)) {
            add({ ok: false, optional: true, text: t('cli.doctorReachPlaceholder', { target, url }), next: t('cli.doctorReachPlaceholderNext') });
            continue;
        }
        add(await reach(url)
            ? { ok: true, optional: true, text: t('cli.doctorReachOk', { target, url }) }
            : { ok: false, optional: true, text: t('cli.doctorReachFail', { target, url }), next: t('cli.doctorReachNext') });
    }
    for (const entry of await overlayLines(root, config, probes)) add(entry);
    return results;
};

/**
 * The overlay lines for ExtJS: per environment with overlay and app with app.json, bootstrap.json on disk, the local code server
 * (overlay.url: the watch of this app, or found on another port) and the last `caw-ai overlay check`. All optional: only runs
 * with --overlay need them. Never starts anything.
 * @param probes.overlay tests only: (root, { target, app }) -> the result of overlayStatus
 */
const overlayLines = async (root, config, probes, now = Date.now()) => {
    const adapter = frameworkOf(config);
    if (adapter.watch === undefined || adapter.overlay === undefined) return [];
    const targets = allTargets(config).filter((target) => {
        const resolved = resolveTarget(config, target);
        return resolved.overlay && !resolved.production;
    });
    const apps = Object.entries(config.apps ?? {}).filter(([, app]) => typeof app?.dir === 'string' && existsSync(join(root, app.dir, 'app.json')));
    if (targets.length === 0 || apps.length === 0) return [];
    const status = probes.overlay ?? ((dir, options) => overlayStatus(dir, { ...options, config }));
    let last = null;
    try {
        last = JSON.parse(readFileSync(join(root, RUN_DIR, OVERLAY_CHECK_FILE), 'utf8'));
    } catch {
        // No check yet or unreadable: the line says how to run one.
    }
    const firstLine = (text) => String(text ?? '').split('\n')[0].trim().replace(/\.$/, '');
    const lines = [];
    for (const target of targets) {
        for (const [app, { dir, overlay }] of apps) {
            const start = overlaySettings(overlay).start;
            const next = start === undefined ? t('cli.doctorOverlayStartUnknown', { app }) : t('cli.doctorOverlayStartNext', { start, dir: dir.replaceAll('\\', '/') });
            try {
                adapter.overlay.checkAppFiles(join(root, dir), '');
                lines.push({ ok: true, optional: true, text: t('cli.doctorOverlayBootstrap', { target, app }) });
            } catch (error) {
                lines.push({ ok: false, optional: true, text: t('cli.doctorOverlayBootstrapBad', { target, app, problem: firstLine(error?.message ?? error) }), next });
            }
            let found;
            try {
                found = await status(root, { target, app });
            } catch (error) {
                found = { state: 'error', message: error?.message ?? String(error) };
            }
            const url = found.url ?? '–';
            if (found.state === 'ready') lines.push({ ok: true, optional: true, text: t('cli.doctorOverlayServerOk', { target, app, url }) });
            else if (found.state === 'moved') lines.push({ ok: false, optional: true, text: t('cli.doctorOverlayServerMoved', { target, app, url, found: found.foundUrl }), next: t('cli.doctorOverlayServerMovedNext', { app, found: found.foundUrl }) });
            else if (found.state === 'down') lines.push({ ok: false, optional: true, text: t('cli.doctorOverlayServerDown', { target, app, url }), next });
            else lines.push({ ok: false, optional: true, text: t('cli.doctorOverlayServerBad', { target, app, url, problem: firstLine(found.message) }), next });
            const checked = last !== null && last.target === target && last.app === app && Array.isArray(last.parts) && last.parts.length > 0;
            if (!checked) {
                lines.push({ ok: false, optional: true, text: t('cli.doctorOverlayNoCheck', { target, app }), next: t('cli.doctorOverlayNoCheckNext', { target }) });
                continue;
            }
            const age = ago(Math.max(0, now - Date.parse(last.at)));
            for (const { label: part, status: partStatus } of last.parts) {
                const text = t('cli.doctorOverlayPart', { target, app, label: part, status: t(`cli.doctorOverlayStatus.${partStatus}`), ago: age });
                lines.push(partStatus === 'deployed' ? { ok: false, optional: true, text, next: t('cli.doctorOverlayPartNext') } : { ok: true, optional: true, text });
            }
        }
    }
    return lines;
};

/** Prints the checks. Exit 0 when everything required is fine, also when only optional items are missing. */
export const doctor = async (root, options = {}) => {
    const { ui } = options;
    const results = await doctorChecks(root, options);
    // The mark is part of the text so plain output without symbols and colours stays readable.
    for (const { ok, optional, text, next } of results) {
        if (ok) ui.success(`${t('cli.doctorMarkOk')}${text}`);
        else if (optional) ui.note(`${t('cli.doctorMarkOptional')}${text}. ${next}`);
        else ui.warn(`${t('cli.doctorMarkMissing')}${text}. ${next}`);
    }
    const blocking = results.filter(({ ok, optional }) => !ok && !optional).length;
    const optionalMissing = results.filter(({ ok, optional }) => !ok && optional).length;
    const summary = t('cli.doctorSummary', { ok: results.length - blocking - optionalMissing, blocking, optional: optionalMissing });
    // The next step depends on whether recorded tests exist: a merely described one (like the example from init)
    // cannot be played back yet and must be recorded first.
    const dir = join(root, RECORDING_DIR);
    const tests = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')) : [];
    const ready = tests.length === 0 ? t('cli.doctorReadyFirst') : t('cli.doctorReady');
    if (blocking === 0) ui.success(`${summary}. ${ready}`);
    else ui.warn(t('cli.doctorFixFirst', { summary }));
    return blocking === 0 ? 0 : 2;
};
