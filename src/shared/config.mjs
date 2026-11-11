// The environments come from the project config, optionally extended by a fragment in the project (`extends`). The tool itself
// knows no environment, portal or customer.
//
// The normal case is flat: one application, a few environments with one URL each.
//   "environments": { "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
//                     "staging": { "url": "https://staging.example.com" } }
//   Target: "local"
// A local dev server serves the local code itself: that is the environment "local", without any option. The overlay puts local
// code on top of a deployed environment (portal, shell, backend only on staging), only with --overlay and only where the
// environment allows it: "dev": { "url": "https://dev.example.com", "claude": true, "overlay": true }
// If the same application runs for several sites (tenants) under their own URLs, `sites` names them and each environment has `urls`:
//   "sites": ["nord", "sued"], "environments": { "dev": { "urls": { "nord": "https://…", "sued": "https://…" }, "claude": true } }
//   Target: "nord/dev"

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';
import { CONFIG_FILE } from './names.mjs';
import { projectThemeProblems, setProjectTheme } from './theme-package.mjs';
import { didYouMean } from './suggest.mjs';

export { CONFIG_FILE } from './names.mjs';

const ENVIRONMENT_FLAGS = ['claude', 'overlay', 'writable', 'production'];
// A production environment must be declared explicitly, and then has no Claude, no local code and no writing.
// Names containing it count too, e.g. prod-de or live_eu. If such an environment is not production, say so with "production": false.
const PRODUCTION_NAME = /(^|[-_.])(prod|production|produktion|produktiv|prd|live)([-_.]|\d|$)/i;
const PRODUCTION_EXACT = /^(prod|production|produktion|produktiv|prd|live)$/i;
const NAME = /^[a-z][\w-]*$/;
export const DEFAULT_MESSAGE_SELECTORS = ['[role=alert]', '[role=alertdialog]'];
/** The framework adapters in src/host/framework/; `web` is the default. */
export const FRAMEWORK_NAMES = ['web', 'extjs', 'react', 'vue', 'angular'];
/** Login types. */
export const AUTH_TYPES = ['form', 'basic', 'storageState', 'none'];
const AUTH_FIELDS = {
    form: ['type', 'path', 'userSelector', 'passwordSelector', 'submitSelector', 'codeSelector', 'signedInSelector'],
    basic: ['type', 'signedInSelector'],
    storageState: ['type', 'path', 'signedInSelector'],
    none: ['type'],
};
/** Folder of saved sessions (`auth.type: storageState`): one file per role, never checked in. */
export const AUTH_DIR = 'caw/.auth';
/** Value of a login selector explore did not find: doctor reports it until it is filled in. */
export const TODO = 'TODO';
/** The saved session of a role on a target, relative to the project: caw/.auth/<environment>/<role>.json, with sites caw/.auth/<site>/<environment>/<role>.json. */
export const sessionPath = (target, role) => posix.join(AUTH_DIR, ...String(target).split('/'), `${role}.json`);

const TOP_FIELDS = ['framework', 'extends', 'environments', 'sites', 'auth', 'apps', 'roles', 'messageSelectors', 'insecureTls', 'requestKeys',
    'consoleIgnore', 'foreignCode', 'extraAllowedHosts', 'assetUrlPattern', 'effects', 'maxSteps', 'sandboxImage', 'sandboxUser', 'lintCommand', 'readyTimeoutMs',
    'browser', 'agent', 'language', 'theme'];

/** Where Claude runs: locally with restricted tools (default) or isolated in Docker. */
export const AGENT_SANDBOXES = ['local', 'docker'];

/** The sandbox for Claude from the config. Always Docker in CI: nobody is there to watch a local agent. */
export const agentSandbox = (config, env = process.env) => {
    const chosen = isObject(config?.agent) && typeof config.agent.sandbox === 'string' ? config.agent.sandbox : 'local';
    return env.CI !== undefined && env.CI !== '' ? 'docker' : chosen;
};

/** Chromium browsers Playwright finds on the system. Other browsers have no host block via launch arguments. */
export const BROWSER_CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'msedge-beta', 'msedge-dev'];

/** How the browser starts: the system Chrome by default, otherwise `browser.channel` or `browser.executablePath` from the config. */
export const browserLaunch = (config) => {
    const browser = isObject(config?.browser) ? config.browser : {};
    if (typeof browser.executablePath === 'string' && browser.executablePath !== '') return { executablePath: browser.executablePath };
    return { channel: typeof browser.channel === 'string' ? browser.channel : 'chrome' };
};
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const HOST = /^[a-z0-9.-]+$/i;
/** The host from an address like "https://login.example.com/" or "login.example.com:443", otherwise null. */
const hostOf = (value) => {
    if (typeof value !== 'string') return null;
    try {
        const { hostname } = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `https://${value}`);
        return HOST.test(hostname) && hostname !== value ? hostname : null;
    } catch {
        return null;
    }
};

/** The suggestion for an unknown field as a suffix, e.g. " (did you mean insecureTls?)", otherwise empty. */
const hintFor = (key, allowed) => {
    const name = didYouMean(key, allowed);
    return name === undefined ? '' : t('config.didYouMean', { name });
};

/**
 * Reads the fragment from `extends` (`"extends": "./caw/presets/basis.json"`): fields as in the config, without its own `extends`.
 * @returns the fragment or a text describing the problem
 */
const loadFragment = (spec, root) => {
    if (typeof spec !== 'string' || !(spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) || !spec.endsWith('.json')) {
        return t('config.fragment.path', { spec: String(spec) });
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(isAbsolute(spec) ? spec : join(root, spec), 'utf8'));
    } catch (error) {
        return t('config.fragment.unreadable', { spec, error: error.message.split('\n')[0] });
    }
    if (!isObject(raw)) return t('config.fragment.notObject', { spec });
    if (raw.extends !== undefined) return t('config.fragment.nested', { spec });
    return raw;
};

/**
 * The effective config: the fragment from `extends`, with the project config on top. Environments are merged by name with
 * project fields winning; everything else the project replaces entirely.
 * @returns { config, issues }
 */
export const effectiveConfig = (config, root = process.cwd()) => {
    if (config.extends === undefined) return { config, issues: [] };
    const fragment = loadFragment(config.extends, root);
    if (typeof fragment === 'string') return { config, issues: [fragment] };
    const environments = { ...(fragment.environments ?? {}) };
    for (const [name, entry] of Object.entries(config.environments ?? {})) environments[name] = { ...(environments[name] ?? {}), ...(entry ?? {}) };
    const merged = { ...fragment, ...config, ...(Object.keys(environments).length === 0 ? {} : { environments }) };
    return { config: merged, issues: [] };
};

/** The environments with abilities and URLs; without `sites` the URL is stored under the empty site. */
export const environmentDefs = (config) => Object.fromEntries(Object.entries(config.environments ?? {}).map(([name, raw]) => {
    const entry = raw ?? {};
    const urls = config.sites === undefined ? (entry.url === undefined ? {} : { '': entry.url }) : Object.fromEntries((config.sites ?? []).filter((site) => entry.urls?.[site] !== undefined).map((site) => [site, entry.urls[site]]));
    // Internally the ability is still called `agent`: Claude may work here.
    return [name, { agent: entry.claude === true, overlay: entry.overlay === true, writable: entry.writable === true, production: entry.production === true, urls }];
}));

/** Environments with an ability, for messages like "only on dev". */
export const environmentsWith = (config, ability) => Object.entries(environmentDefs(config)).filter(([, entry]) => entry[ability]).map(([name]) => name);

/**
 * This machine: localhost, 127.0.0.1 and names under .localhost (RFC 6761). They always point to loopback and Chrome treats them
 * as secure, so http is allowed there too, e.g. for a local dev server.
 */
export const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');

/** Why an address is not an allowed origin, or null. http only on this machine (isLoopback), otherwise https. */
const originProblem = (value) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return t('config.origin.invalid', { value: String(value ?? '') });
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
        return t('config.origin.http', { value: String(value) });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return t('config.origin.protocol', { value: String(value) });
    if (url.origin !== value) return t('config.origin.path', { value: String(value), origin: url.origin });
    return null;
};

const checkEnvironments = (config, issues) => {
    if (!isObject(config.environments) || Object.keys(config.environments).length === 0) {
        issues.push(t('config.env.missing'));
        return;
    }
    const sites = config.sites;
    if (sites !== undefined && !(Array.isArray(sites) && sites.length > 0 && sites.every((site) => typeof site === 'string' && NAME.test(site)))) {
        issues.push(t('config.sites.invalid'));
    }
    for (const [name, raw] of Object.entries(config.environments)) {
        if (!NAME.test(name)) issues.push(t('config.env.name', { name }));
        if (!isObject(raw)) {
            issues.push(t('config.env.notObject', { name }));
            continue;
        }
        const unknown = Object.keys(raw).find((key) => !['url', 'urls', ...ENVIRONMENT_FLAGS].includes(key));
        if (unknown !== undefined) issues.push(t('config.env.unknown', { name, key: unknown, flags: ENVIRONMENT_FLAGS.join(', '), hint: hintFor(unknown, ['url', 'urls', ...ENVIRONMENT_FLAGS]) }));
        const notBoolean = ENVIRONMENT_FLAGS.find((key) => raw[key] !== undefined && typeof raw[key] !== 'boolean');
        if (notBoolean !== undefined) issues.push(t('config.env.notBoolean', { name, key: notBoolean }));
        if (sites === undefined) {
            if (raw.urls !== undefined) issues.push(t('config.env.urlsWithoutSites', { name }));
            else if (originProblem(raw.url) !== null) issues.push(t('config.env.url', { name, problem: originProblem(raw.url) }));
        } else if (raw.url !== undefined) {
            issues.push(t('config.env.urlWithSites', { name }));
        } else if (!isObject(raw.urls)) {
            issues.push(t('config.env.urlsMissing', { name, site: String((Array.isArray(sites) ? sites[0] : undefined) ?? 'nord') }));
        } else {
            for (const [site, url] of Object.entries(raw.urls)) {
                if (!NAME.test(site)) issues.push(t('config.env.siteName', { name, site }));
                if (originProblem(url) !== null) issues.push(t('config.env.siteUrl', { name, site, problem: originProblem(url) }));
            }
        }
        if (PRODUCTION_EXACT.test(name) && raw.production !== true) issues.push(t('config.env.productionExact', { name }));
        else if (PRODUCTION_NAME.test(name) && raw.production === undefined) issues.push(t('config.env.productionLike', { name }));
        if (raw.production === true && (raw.claude === true || raw.overlay === true || raw.writable === true)) issues.push(t('config.env.productionFlags', { name }));
    }
    for (const site of Array.isArray(sites) ? sites : []) {
        if (PRODUCTION_NAME.test(site)) issues.push(t('config.site.production', { site: String(site) }));
        if (!Object.values(config.environments).some((raw) => isObject(raw?.urls) && raw.urls[site] !== undefined)) issues.push(t('config.site.noUrl', { site: String(site) }));
    }
};

/** The login as the tool uses it. Without `auth`: no login. */
export const authOf = (config) => (isObject(config.auth) ? config.auth : { type: 'none' });

const checkAuth = (config, issues) => {
    if (config.auth === undefined) return;
    const auth = config.auth;
    if (!isObject(auth) || !AUTH_TYPES.includes(auth.type)) {
        issues.push(t('config.auth.type', { types: AUTH_TYPES.join(', ') }));
        return;
    }
    const foreign = Object.keys(auth).find((key) => !AUTH_FIELDS[auth.type].includes(key) || typeof auth[key] !== 'string' || auth[key] === '');
    if (foreign !== undefined) {
        const hint = AUTH_FIELDS[auth.type].includes(foreign) ? '' : hintFor(foreign, AUTH_FIELDS[auth.type]);
        issues.push(t('config.auth.foreign', { type: auth.type, key: foreign, fields: AUTH_FIELDS[auth.type].join(', '), hint }));
    }
    if (auth.type === 'form') {
        const missing = ['path', 'userSelector', 'passwordSelector', 'signedInSelector'].filter((key) => typeof auth[key] !== 'string' || auth[key] === '');
        if (missing.length > 0) issues.push(t('config.auth.formMissing', { missing: missing.join(', ') }));
    }
    if (typeof auth.path === 'string' && !auth.path.startsWith('/')) issues.push(t('config.auth.path'));
};

const ROLE_FIELDS = ['loginEnv', 'passwordEnv', 'totpEnv'];
const checkRoles = (config, issues) => {
    const { type } = authOf(config);
    if (config.roles === undefined) {
        if (type !== 'none') issues.push(t('config.roles.missing', { type }));
        return;
    }
    if (!isObject(config.roles) || Object.keys(config.roles).length === 0) {
        issues.push(type === 'none' ? t('config.roles.withoutAuth') : t('config.roles.notObject'));
        return;
    }
    for (const [name, role] of Object.entries(config.roles)) {
        if (!NAME.test(name)) issues.push(t('config.role.name', { name }));
        if (!isObject(role)) {
            issues.push(t('config.role.notObject', { name }));
            continue;
        }
        const needsSecrets = type === 'form' || type === 'basic';
        if (needsSecrets && (!role.loginEnv || !role.passwordEnv)) issues.push(t('config.role.secrets', { name }));
        if (needsSecrets) {
            // Names of environment variables in caw/.env; a typo in the key (passwortEnv) would otherwise only show up at login.
            for (const [key, value] of Object.entries(role)) {
                if (!ROLE_FIELDS.includes(key)) issues.push(t('config.role.unknownField', { name, key, allowed: ROLE_FIELDS.join(', '), hint: hintFor(key, ROLE_FIELDS) }));
                else if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) issues.push(t('config.role.envName', { name, key }));
            }
        }
        if (!needsSecrets && Object.keys(role).length > 0) issues.push(t('config.role.noFields', { name, type, why: type === 'storageState' ? t('config.role.sessionFile', { dir: AUTH_DIR, name }) : t('config.role.noAuth') }));
    }
};

/**
 * Checks a config and collects all findings, so `validate` can report them in one pass.
 * @param given the config as in the file; the fragment from `extends` is read relative to `root`
 */
export const validateConfig = (given, root = process.cwd()) => {
    if (!isObject(given)) return { ok: false, issues: [t('config.notObject')], notes: [] };
    const issues = [];
    // Notes that block nothing: settings that have no effect as they are.
    const notes = [];
    for (const key of Object.keys(given)) if (!TOP_FIELDS.includes(key)) issues.push(t('config.unknownField', { key, hint: hintFor(key, TOP_FIELDS) }));
    if (given.language !== undefined && !['de', 'en'].includes(given.language)) issues.push(t('config.language', { value: String(JSON.stringify(given.language)) }));
    const { config, issues: loaded } = effectiveConfig(given, root);
    issues.push(...loaded);
    if (config.extends !== undefined && given.extends === undefined) issues.push(t('config.extendsOnlyProject'));

    checkEnvironments(config, issues);
    checkAuth(config, issues);
    checkRoles(config, issues);
    if (!isObject(config.apps) || Object.keys(config.apps).length === 0) issues.push(t('config.apps.missing'));
    if (config.messageSelectors !== undefined && !(Array.isArray(config.messageSelectors) && config.messageSelectors.every((selector) => typeof selector === 'string' && selector !== ''))) {
        issues.push(t('config.messageSelectors'));
    }
    if (config.insecureTls !== undefined && typeof config.insecureTls !== 'boolean') issues.push(t('config.insecureTls'));
    if (config.theme !== undefined) for (const { key } of projectThemeProblems(config.theme)) issues.push(t('config.theme', { key }));
    if (config.framework !== undefined && !FRAMEWORK_NAMES.includes(config.framework)) issues.push(t('config.framework', { names: FRAMEWORK_NAMES.join(', ') }));
    for (const key of ['sandboxImage', 'sandboxUser', 'lintCommand']) {
        if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].trim() === '')) issues.push(t('config.text', { key }));
    }
    if (config.agent !== undefined) {
        if (!isObject(config.agent)) issues.push(t('config.agent.notObject'));
        else {
            const unknown = Object.keys(config.agent).find((key) => key !== 'sandbox');
            if (unknown !== undefined) issues.push(t('config.agent.unknown', { key: unknown, hint: hintFor(unknown, ['sandbox']) }));
            if (config.agent.sandbox !== undefined && !AGENT_SANDBOXES.includes(config.agent.sandbox)) issues.push(t('config.agent.sandbox', { names: AGENT_SANDBOXES.join(', ') }));
        }
    }
    if (config.browser !== undefined) {
        if (!isObject(config.browser)) issues.push(t('config.browser.notObject'));
        else {
            const unknown = Object.keys(config.browser).find((key) => !['channel', 'executablePath'].includes(key));
            if (unknown !== undefined) issues.push(t('config.browser.unknown', { key: unknown, hint: hintFor(unknown, ['channel', 'executablePath']) }));
            if (config.browser.channel !== undefined && !BROWSER_CHANNELS.includes(config.browser.channel)) issues.push(t('config.browser.channel', { names: BROWSER_CHANNELS.join(', ') }));
            if (config.browser.executablePath !== undefined && (typeof config.browser.executablePath !== 'string' || !isAbsolute(config.browser.executablePath))) issues.push(t('config.browser.executablePath'));
            if (config.browser.channel !== undefined && config.browser.executablePath !== undefined) issues.push(t('config.browser.both'));
        }
    }
    if (typeof config.sandboxImage === 'string' && !/^[\w./:@-]+$/.test(config.sandboxImage)) issues.push(t('config.sandboxImage'));
    if (config.sandboxUser !== undefined && !/^[a-z_][a-z0-9_-]*$/.test(config.sandboxUser)) issues.push(t('config.sandboxUser'));
    if (config.maxSteps !== undefined && (!Number.isInteger(config.maxSteps) || config.maxSteps <= 0)) issues.push(t('config.maxSteps'));
    if (config.readyTimeoutMs !== undefined && (!Number.isInteger(config.readyTimeoutMs) || config.readyTimeoutMs <= 0)) issues.push(t('config.readyTimeoutMs'));
    if (config.extraAllowedHosts !== undefined && !Array.isArray(config.extraAllowedHosts)) issues.push(t('config.extraAllowedHosts'));
    else for (const value of config.extraAllowedHosts ?? []) {
        if (typeof value === 'string' && HOST.test(value)) continue;
        // Usually a full address was given: then suggest its host.
        const host = hostOf(value);
        issues.push(host === null ? t('config.extraAllowedHosts.entry', { value: JSON.stringify(value) }) : t('config.extraAllowedHosts.url', { value: JSON.stringify(value), host }));
    }
    for (const key of ['consoleIgnore', 'foreignCode']) {
        if (config[key] !== undefined && !(Array.isArray(config[key]) && config[key].every((pattern) => typeof pattern === 'string'))) {
            issues.push(t('config.patterns.list', { key }));
            continue;
        }
        for (const pattern of config[key] ?? []) {
            try {
                new RegExp(pattern);
            } catch {
                issues.push(t('config.patterns.invalid', { key, pattern }));
            }
        }
    }
    if (config.requestKeys !== undefined && (!Array.isArray(config.requestKeys) || !config.requestKeys.every((key) => typeof key === 'string' && /^[\w.-]+$/.test(key)))) {
        issues.push(t('config.requestKeys'));
    }
    const effectLists = ['controls', 'view', 'requests', 'responses', 'console'];
    if (config.effects !== undefined && !(isObject(config.effects) && Object.keys(config.effects).every((key) => key === 'fail')
        && (config.effects.fail === undefined || (Array.isArray(config.effects.fail) && config.effects.fail.every((list) => effectLists.includes(list)))))) {
        issues.push(t('config.effects', { lists: effectLists.join(', ') }));
    }
    if (config.assetUrlPattern !== undefined) {
        let groups = -1;
        try {
            groups = new RegExp(`${config.assetUrlPattern}|`).exec('').length - 1;
        } catch {
            issues.push(t('config.patterns.invalid', { key: 'assetUrlPattern', pattern: String(config.assetUrlPattern) }));
        }
        if (groups === 0) issues.push(t('config.assetUrlPattern.group'));
    }
    const extjs = config.framework === 'extjs';
    for (const [name, app] of Object.entries(isObject(config.apps) ? config.apps : {})) {
        if (!isObject(app)) {
            issues.push(t('config.app.notObject', { name }));
            continue;
        }
        if (typeof app.dir !== 'string' || app.dir === '' || /^([\\/]|[A-Za-z]:)/.test(app.dir) || app.dir.split(/[\\/]/).includes('..')) {
            issues.push(t('config.app.dir', { name }));
        }
        // Without startUrl the app is only reached along the way, e.g. via a task.
        if (app.startUrl !== undefined && (typeof app.startUrl !== 'string' || !app.startUrl.startsWith('/'))) issues.push(t('config.app.startUrl', { name }));
        const unknown = Object.keys(app).find((key) => !APP_KEYS.includes(key));
        if (unknown !== undefined) issues.push(t('config.app.unknown', { name, key: unknown, hint: hintFor(unknown, APP_KEYS) }));
        if (app.overlay !== undefined) issues.push(...overlayIssues(name, app.overlay, extjs));
    }
    if (issues.length === 0) notes.push(...overlayNotes(config));
    return { ok: issues.length === 0, issues, notes };
};

/**
 * The overlay only works when environment and app match: overlay on the environment, a source on the app. If either is missing,
 * --overlay works nowhere; with an address on the command line (--overlay http://…) the app needs none.
 */
const overlayNotes = (config) => {
    const apps = Object.keys(config.apps ?? {});
    const environments = environmentsWith(config, 'overlay');
    const notes = [];
    if (environments.length === 0) {
        for (const name of apps.filter((app) => config.apps[app]?.overlay !== undefined)) notes.push(t('config.note.overlayNoEnv', { name }));
    }
    return notes;
};

/** The config as loadConfig returns it, plus the validation notes (settings without effect). */
export const loadConfigWithNotes = (root) => {
    let raw;
    try {
        raw = readFileSync(join(root, CONFIG_FILE), 'utf8');
    } catch {
        throw new CawError('config-missing', t('config.load.missing', { file: CONFIG_FILE, root }));
    }
    let config;
    try {
        config = JSON.parse(raw);
    } catch (error) {
        throw new CawError('config-invalid', t('config.load.invalidJson', { file: CONFIG_FILE, error: error.message }));
    }
    const { issues, notes } = validateConfig(config, root);
    if (issues.length > 0) throw new CawError('config-invalid', `${CONFIG_FILE}:\n- ${issues.join('\n- ')}`);
    const effective = effectiveConfig(config, root).config;
    // The team default theme applies to everything this process shows: workbench, chat, card, terminal.
    setProjectTheme(effective.theme);
    return { config: effective, notes };
};

export const loadConfig = (root) => loadConfigWithNotes(root).config;

// A path inside the project: relative, without `..`. Like `dir` and `overlay.build`.
const relativePath = (value) => typeof value === 'string' && value !== '' && !/^([\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..');
const APP_KEYS = ['dir', 'startUrl', 'overlay'];
/** A server address: http(s), with host. Like --overlay <url>. */
export const isServerUrl = (value) => {
    if (typeof value !== 'string' || !/^https?:\/\/[^\s/]+/i.test(value)) return false;
    try {
        return new URL(value).hostname !== '';
    } catch {
        return false;
    }
};
const OVERLAY_KEYS = ['build', 'dev', 'buildCommand', 'devCommand', 'statics'];
const STATIC_KEYS = ['name', 'path'];

/** The errors in `apps.<name>.overlay`. With ExtJS the source is the Sencha watch: no build and no dev URL. */
const overlayIssues = (name, overlay, extjs) => {
    if (!isObject(overlay)) return [t('config.overlay.notObject', { name })];
    const issues = [];
    const unknown = Object.keys(overlay).find((key) => !OVERLAY_KEYS.includes(key));
    if (unknown !== undefined) issues.push(t('config.overlay.unknown', { name, key: unknown, hint: hintFor(unknown, OVERLAY_KEYS) }));
    if (overlay.build !== undefined && !relativePath(overlay.build)) issues.push(t('config.overlay.build', { name }));
    if (overlay.dev !== undefined && !isServerUrl(overlay.dev)) issues.push(t('config.overlay.dev', { name }));
    if (extjs && (overlay.build !== undefined || overlay.dev !== undefined || overlay.buildCommand !== undefined)) issues.push(t('config.overlay.extjs', { name }));
    for (const key of ['buildCommand', 'devCommand']) {
        if (overlay[key] !== undefined && (typeof overlay[key] !== 'string' || overlay[key].trim() === '')) issues.push(t('config.overlay.command', { name, key }));
    }
    if (overlay.buildCommand !== undefined && overlay.build === undefined) issues.push(t('config.overlay.commandWithout', { name, key: 'buildCommand', needs: 'build' }));
    if (overlay.devCommand !== undefined && overlay.dev === undefined && !extjs) issues.push(t('config.overlay.commandWithout', { name, key: 'devCommand', needs: 'dev' }));
    if (overlay.statics !== undefined && !Array.isArray(overlay.statics)) issues.push(t('config.overlay.statics', { name }));
    else (overlay.statics ?? []).forEach((entry, index) => {
        const extra = isObject(entry) ? Object.keys(entry).find((key) => !STATIC_KEYS.includes(key)) : undefined;
        if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '' || !relativePath(entry.path) || extra !== undefined) {
            issues.push(t('config.overlay.static', { name, index }));
        }
    });
    return issues;
};

/** Without `assetUrlPattern`: the path below the environment URL, e.g. `assets/index-X.js` from `https://host/app/assets/index-X.js`. */
export const defaultAssetPattern = (url) => {
    // As Chrome writes a request URL: lowercase host, no default port. Otherwise the pattern would silently never match.
    const parsed = new URL(String(url));
    const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    return `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^?#]+)`;
};

/** How a target is written: `environment`, with sites `site/environment`. */
export const targetForm = (config) => (config.sites === undefined ? t('config.targetForm.plain') : t('config.targetForm.sites'));

/** All targets the config knows, for messages and `init`. */
export const allTargets = (config) => Object.entries(environmentDefs(config))
    .flatMap(([name, entry]) => Object.keys(entry.urls).map((site) => (site === '' ? name : `${site}/${name}`)));

/** Resolves a target: the environment (and the site, with sites), with URL and abilities. */
export const resolveTarget = (config, target) => {
    const text = String(target);
    const parts = text.split('/');
    const withSites = config.sites !== undefined;
    if (parts.length !== (withSites ? 2 : 1) || parts.some((part) => part === '')) {
        throw new CawError('target-invalid', t('config.target.form', { target: text, form: targetForm(config), hint: withSites ? '' : t('config.target.formHint') }));
    }
    const [site, environment] = withSites ? parts : ['', parts[0]];
    const defs = environmentDefs(config);
    if (defs[environment] === undefined) throw new CawError('target-invalid', t('config.target.environment', { environment, names: Object.keys(defs).join(', ') }));
    if (withSites && !config.sites.includes(site)) throw new CawError('target-invalid', t('config.target.site', { site, sites: config.sites.join(', ') }));
    const url = defs[environment].urls[site];
    if (url === undefined) throw new CawError('target-invalid', t('config.target.siteUrl', { site, environment }));
    const abilities = { ...defs[environment] };
    delete abilities.urls;
    return { target: text, ...(withSites ? { site } : {}), environment, url, ...abilities };
};

/**
 * What Chrome may reach: the environment hosts and project-specific exceptions, e.g. a login service.
 * Never production unless the run targets it: otherwise a run on dev could reach production via goto, eval or a link,
 * possibly with a shared login.
 * @param target the resolved target of the run (resolveTarget); without a target only non-production environments
 */
export const browserHosts = (config, target) => {
    const hosts = Object.values(environmentDefs(config)).filter(({ production }) => !production)
        .flatMap(({ urls }) => Object.values(urls).map((url) => new URL(url).hostname));
    const own = target?.url === undefined ? [] : [new URL(target.url).hostname];
    const production = new Set(Object.values(environmentDefs(config)).filter(({ production: isProduction }) => isProduction)
        .flatMap(({ urls }) => Object.values(urls).map((url) => new URL(url).hostname)));
    // An exception must not re-enable production.
    const extra = (config.extraAllowedHosts ?? []).filter((host) => target?.production === true || !production.has(host));
    return [...new Set([...own, ...hosts, ...extra])];
};

/** Stable, unique UUID-shaped id per entry; devlink requires identities, but they carry no meaning. */
const uuidOf = (seed) => {
    const hash = createHash('sha256').update(seed).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

/**
 * Builds the config the devlink host expects from project config and target: environment, start page, login marker. It does not
 * inject local code; the overlay (src/host/overlay.mjs) does that with its own route.
 */
export const buildDevlinkConfig = (config, resolved, appName) => {
    const app = config.apps[appName];
    const siteUuid = uuidOf(`portal:${resolved.target}`);
    const signedIn = authOf(config).signedInSelector;
    return {
        activePortal: siteUuid,
        ...(config.assetUrlPattern === undefined ? {} : { assetUrlPattern: config.assetUrlPattern }),
        authMarker: signedIn ?? null,
        portals: [{ uuid: siteUuid, name: resolved.target, url: resolved.url }],
        projects: [{
            uuid: uuidOf(`project:${appName}`),
            name: appName,
            active: true,
            startUrl: app.startUrl,
        }],
    };
};
