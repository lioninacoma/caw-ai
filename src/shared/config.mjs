// The project config caw.config.json: one application, its environments (src/shared/environments.mjs), sign-in, roles and
// what replays need to know. The tool itself knows no environment, portal or customer.

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';
import { CONFIG_FILE } from './names.mjs';
import { projectThemeProblems, setProjectTheme } from './theme-package.mjs';
import { didYouMean } from './suggest.mjs';
import { NAME, effectiveEnvironment, environmentNames } from './environments.mjs';

export { CONFIG_FILE } from './names.mjs';
export { environmentsWith } from './environments.mjs';

const ENVIRONMENT_FLAGS = ['claude', 'writable', 'production', 'insecureTls', 'allowHttp'];
const ENVIRONMENT_KEYS = ['url', 'extends', 'allowHosts', ...ENVIRONMENT_FLAGS];
// A production environment must be declared explicitly, and then has no Claude, no local code and no writing.
// Names containing it count too, e.g. prod-de or live_eu. If such an environment is not production, say so with "production": false.
const PRODUCTION_NAME = /(^|[-_.])(prod|production|produktion|produktiv|prd|live)([-_.]|\d|$)/i;
const PRODUCTION_EXACT = /^(prod|production|produktion|produktiv|prd|live)$/i;
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
/** The login fields still TODO since init, as "auth.<field>". */
export const todoFields = (config) => Object.entries(isObject(config?.auth) ? config.auth : {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
/** The saved session of a role on an environment, relative to the project: caw/.auth/<environment>/<role>.json. */
export const sessionPath = (env, role) => posix.join(AUTH_DIR, String(env), `${role}.json`);

const TOP_FIELDS = ['framework', 'environments', 'auth', 'apps', 'roles', 'messageSelectors', 'requestKeys',
    'consoleIgnore', 'foreignCode', 'allowHosts', 'overlay', 'effects', 'maxSteps', 'sandboxImage', 'sandboxUser', 'lintCommand', 'readyTimeoutMs',
    'browser', 'agent', 'language', 'theme', 'readyIgnore'];
const BROWSER_FIELDS = ['channel', 'executablePath', 'locale', 'timezone'];

/**
 * Keys that existed before 1.0. They are not read: the message says what replaced them or why they went. A static table, so
 * an old config fails with a clear message instead of an "unknown key".
 */
export const REMOVED_KEYS = {
    sites: { why: 'config.removed.sites' },
    extends: { why: 'config.removed.extends' },
    insecureTls: { now: 'environments.<env>.insecureTls' },
    extraAllowedHosts: { now: 'allowHosts' },
    assetUrlPattern: { now: 'overlay.assetUrlPattern' },
};
const ENVIRONMENT_REMOVED = { urls: { why: 'config.removed.urls' }, overlay: { now: 'overlay.environments' } };
const APP_REMOVED = { dir: { now: 'overlay.parts.<part>.dir' }, overlay: { now: 'overlay.parts.<part>' } };
/** The message for a removed key: renamed (now) or gone (why). */
const removedKey = (path, entry) => (entry.now === undefined ? t('config.removed.gone', { key: path, why: t(entry.why) }) : t('config.removed.renamed', { key: path, now: entry.now }));

/** Where Claude runs: locally with restricted tools (default) or isolated in Docker. */
export const AGENT_SANDBOXES = ['local', 'docker'];
const AGENT_KEYS = ['sandbox', 'model', 'maxBudgetUsd'];
/** A Claude Code model alias or name, e.g. "haiku" or "claude-sonnet-5-5": no spaces, no options. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/;

/**
 * Cost limits for Claude, passed on to Claude Code (`--model`, `--max-budget-usd`): from the environment (CAW_CLAUDE_MODEL,
 * CAW_CLAUDE_BUDGET, e.g. for one run) or from `agent.model` / `agent.maxBudgetUsd`. Invalid values are left out.
 * @returns the variables for the agent process, e.g. { CAW_CLAUDE_MODEL: 'haiku', CAW_CLAUDE_BUDGET: '0.5' }
 */
export const claudeLimits = (config, env = process.env) => {
    const agent = isObject(config?.agent) ? config.agent : {};
    const model = env.CAW_CLAUDE_MODEL || agent.model;
    const budget = env.CAW_CLAUDE_BUDGET || (agent.maxBudgetUsd === undefined ? undefined : String(agent.maxBudgetUsd));
    return {
        ...(typeof model === 'string' && MODEL_NAME.test(model) ? { CAW_CLAUDE_MODEL: model } : {}),
        ...(typeof budget === 'string' && /^\d+(\.\d+)?$/.test(budget) && Number(budget) > 0 ? { CAW_CLAUDE_BUDGET: budget } : {}),
    };
};

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
/** A BCP 47 language tag such as "de-DE" or "en". */
const isLocale = (value) => {
    if (typeof value !== 'string' || value === '') return false;
    try {
        return Intl.getCanonicalLocales(value).length === 1;
    } catch {
        return false;
    }
};
/** An IANA time zone such as "Europe/Berlin" or "UTC". */
const isTimezone = (value) => {
    if (typeof value !== 'string' || value === '') return false;
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
        return true;
    } catch {
        return false;
    }
};

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
 * This machine: localhost, 127.0.0.1 and names under .localhost (RFC 6761). They always point to loopback and Chrome treats them
 * as secure, so http is allowed there too, e.g. for a local dev server.
 */
export const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');

/** Why an address is not an allowed origin, or null. http only on this machine (isLoopback) or with allowHttp, otherwise https. */
const originProblem = (value, { allowHttp = false } = {}) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return t('config.origin.invalid', { value: String(value ?? '') });
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname) && !allowHttp) {
        return t('config.origin.http', { value: String(value) });
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return t('config.origin.protocol', { value: String(value) });
    if (url.origin !== value) return t('config.origin.path', { value: String(value), origin: url.origin });
    return null;
};

/** A list of host names (allowHosts): a full address is an error that suggests its host. */
const hostListIssues = (key, value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return [t('config.allowHosts', { key })];
    return value.flatMap((entry) => {
        if (typeof entry === 'string' && HOST.test(entry)) return [];
        const host = hostOf(entry);
        return [host === null ? t('config.allowHosts.entry', { key, value: JSON.stringify(entry) }) : t('config.allowHosts.url', { key, value: JSON.stringify(entry), host })];
    });
};

const checkEnvironments = (config, issues, notes) => {
    if (!isObject(config.environments) || Object.keys(config.environments).length === 0) {
        issues.push(t('config.env.missing'));
        return;
    }
    const names = environmentNames(config);
    for (const [name, raw] of Object.entries(config.environments)) {
        if (!NAME.test(name)) issues.push(t('config.env.name', { name }));
        if (!isObject(raw)) {
            issues.push(t('config.env.notObject', { name }));
            continue;
        }
        for (const key of Object.keys(raw).filter((candidate) => !ENVIRONMENT_KEYS.includes(candidate))) {
            const removed = ENVIRONMENT_REMOVED[key];
            issues.push(removed === undefined
                ? t('config.env.unknown', { name, key, keys: ENVIRONMENT_KEYS.join(', '), hint: hintFor(key, ENVIRONMENT_KEYS) })
                : removedKey(`environments.${name}.${key}`, removed));
        }
        const notBoolean = ENVIRONMENT_FLAGS.find((key) => raw[key] !== undefined && typeof raw[key] !== 'boolean');
        if (notBoolean !== undefined) issues.push(t('config.env.notBoolean', { name, key: notBoolean }));
        if (raw.extends !== undefined && (typeof raw.extends !== 'string' || !names.includes(raw.extends))) {
            issues.push(t('config.env.extendsUnknown', { name, parent: String(raw.extends), names: names.filter((other) => other !== name).join(', ') || '–' }));
        }
        issues.push(...hostListIssues(`environments.${name}.allowHosts`, raw.allowHosts));
        if (PRODUCTION_EXACT.test(name) && raw.production !== true) issues.push(t('config.env.productionExact', { name }));
        else if (PRODUCTION_NAME.test(name) && raw.production === undefined) issues.push(t('config.env.productionLike', { name }));
    }
    // What a run sees: after extends. Cycles and unknown parents are reported above or here, once.
    const effective = [];
    for (const name of names) {
        if (!isObject(config.environments[name])) continue;
        try {
            effective.push(effectiveEnvironment(config, name));
        } catch (error) {
            if (error.code === 'config-invalid' && !issues.includes(error.message)) issues.push(error.message);
        }
    }
    const productionHosts = new Map();
    for (const env of effective.filter((candidate) => candidate.production)) {
        try {
            productionHosts.set(new URL(env.url).hostname, env.name);
        } catch {
            // reported below
        }
    }
    for (const env of effective) {
        const { name } = env;
        if (env.url === undefined) issues.push(t('config.env.urlMissing', { name }));
        else {
            const problem = originProblem(env.url, { allowHttp: env.allowHttp });
            if (problem !== null) issues.push(t('config.env.url', { name, problem }));
            else {
                const { hostname, protocol } = new URL(env.url);
                if (env.allowHttp && (protocol !== 'http:' || isLoopback(hostname))) notes.push(t('config.note.allowHttp', { name }));
                const production = productionHosts.get(hostname);
                if (!env.production && production !== undefined) issues.push(t('config.env.productionHost', { name, host: hostname, production }));
            }
        }
        if (env.production && (env.claude || env.writable)) issues.push(t('config.env.productionFlags', { name }));
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
    // TODO is not a wrong path but a gap from init: validateConfig reports it under `todo`.
    if (typeof auth.path === 'string' && auth.path !== TODO && !auth.path.startsWith('/')) issues.push(t('config.auth.path'));
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

/** Checks a config and collects all findings, so `validate` can report them in one pass. */
export const validateConfig = (given) => {
    if (!isObject(given)) return { ok: false, issues: [t('config.notObject')], notes: [], todo: [] };
    const issues = [];
    // Notes that block nothing: settings that have no effect as they are.
    const notes = [];
    for (const key of Object.keys(given)) {
        if (REMOVED_KEYS[key] !== undefined) issues.push(removedKey(key, REMOVED_KEYS[key]));
        else if (!TOP_FIELDS.includes(key)) issues.push(t('config.unknownField', { key, hint: hintFor(key, TOP_FIELDS) }));
    }
    if (given.language !== undefined && !['de', 'en'].includes(given.language)) issues.push(t('config.language', { value: String(JSON.stringify(given.language)) }));
    const config = given;

    checkEnvironments(config, issues, notes);
    checkAuth(config, issues);
    checkRoles(config, issues);
    if (!isObject(config.apps) || Object.keys(config.apps).length === 0) issues.push(t('config.apps.missing'));
    if (config.messageSelectors !== undefined && !(Array.isArray(config.messageSelectors) && config.messageSelectors.every((selector) => typeof selector === 'string' && selector !== ''))) {
        issues.push(t('config.messageSelectors'));
    }
    if (config.theme !== undefined) for (const { key } of projectThemeProblems(config.theme)) issues.push(t('config.theme', { key }));
    if (config.framework !== undefined && !FRAMEWORK_NAMES.includes(config.framework)) issues.push(t('config.framework', { names: FRAMEWORK_NAMES.join(', ') }));
    for (const key of ['sandboxImage', 'sandboxUser', 'lintCommand']) {
        if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].trim() === '')) issues.push(t('config.text', { key }));
    }
    if (config.agent !== undefined) {
        if (!isObject(config.agent)) issues.push(t('config.agent.notObject'));
        else {
            const unknown = Object.keys(config.agent).find((key) => !AGENT_KEYS.includes(key));
            if (unknown !== undefined) issues.push(t('config.agent.unknown', { key: unknown, hint: hintFor(unknown, AGENT_KEYS) }));
            if (config.agent.sandbox !== undefined && !AGENT_SANDBOXES.includes(config.agent.sandbox)) issues.push(t('config.agent.sandbox', { names: AGENT_SANDBOXES.join(', ') }));
            if (config.agent.model !== undefined && (typeof config.agent.model !== 'string' || !MODEL_NAME.test(config.agent.model))) issues.push(t('config.agent.model'));
            if (config.agent.maxBudgetUsd !== undefined && !(typeof config.agent.maxBudgetUsd === 'number' && config.agent.maxBudgetUsd > 0)) issues.push(t('config.agent.budget'));
        }
    }
    if (config.browser !== undefined) {
        if (!isObject(config.browser)) issues.push(t('config.browser.notObject'));
        else {
            const unknown = Object.keys(config.browser).find((key) => !BROWSER_FIELDS.includes(key));
            if (unknown !== undefined) issues.push(t('config.browser.unknown', { key: unknown, fields: BROWSER_FIELDS.join(', '), hint: hintFor(unknown, BROWSER_FIELDS) }));
            if (config.browser.locale !== undefined && !isLocale(config.browser.locale)) issues.push(t('config.browser.locale'));
            if (config.browser.timezone !== undefined && !isTimezone(config.browser.timezone)) issues.push(t('config.browser.timezone'));
            if (config.browser.channel !== undefined && !BROWSER_CHANNELS.includes(config.browser.channel)) issues.push(t('config.browser.channel', { names: BROWSER_CHANNELS.join(', ') }));
            if (config.browser.executablePath !== undefined && (typeof config.browser.executablePath !== 'string' || !isAbsolute(config.browser.executablePath))) issues.push(t('config.browser.executablePath'));
            if (config.browser.channel !== undefined && config.browser.executablePath !== undefined) issues.push(t('config.browser.both'));
        }
    }
    if (typeof config.sandboxImage === 'string' && !/^[\w./:@-]+$/.test(config.sandboxImage)) issues.push(t('config.sandboxImage'));
    if (config.sandboxUser !== undefined && !/^[a-z_][a-z0-9_-]*$/.test(config.sandboxUser)) issues.push(t('config.sandboxUser'));
    if (config.maxSteps !== undefined && (!Number.isInteger(config.maxSteps) || config.maxSteps <= 0)) issues.push(t('config.maxSteps'));
    if (config.readyTimeoutMs !== undefined && (!Number.isInteger(config.readyTimeoutMs) || config.readyTimeoutMs <= 0)) issues.push(t('config.readyTimeoutMs'));
    issues.push(...hostListIssues('allowHosts', config.allowHosts));
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
    if (config.readyIgnore !== undefined && !(Array.isArray(config.readyIgnore) && config.readyIgnore.every((selector) => typeof selector === 'string' && selector.trim() !== ''))) {
        issues.push(t('config.readyIgnore'));
    }
    if (config.requestKeys !== undefined && (!Array.isArray(config.requestKeys) || !config.requestKeys.every((key) => typeof key === 'string' && /^[\w.-]+$/.test(key)))) {
        issues.push(t('config.requestKeys'));
    }
    const effectLists = ['controls', 'view', 'requests', 'responses', 'console'];
    if (config.effects !== undefined && !(isObject(config.effects) && Object.keys(config.effects).every((key) => key === 'fail')
        && (config.effects.fail === undefined || (Array.isArray(config.effects.fail) && config.effects.fail.every((list) => effectLists.includes(list)))))) {
        issues.push(t('config.effects', { lists: effectLists.join(', ') }));
    }
    for (const [name, app] of Object.entries(isObject(config.apps) ? config.apps : {})) {
        if (!isObject(app)) {
            issues.push(t('config.app.notObject', { name }));
            continue;
        }
        // Without startUrl the app is only reached along the way, e.g. via a task.
        if (app.startUrl !== undefined && (typeof app.startUrl !== 'string' || !app.startUrl.startsWith('/'))) issues.push(t('config.app.startUrl', { name }));
        for (const unknown of Object.keys(app).filter((key) => !APP_KEYS.includes(key))) {
            issues.push(APP_REMOVED[unknown] === undefined
                ? t('config.app.unknown', { name, key: unknown, hint: hintFor(unknown, APP_KEYS) })
                : removedKey(`apps.${name}.${unknown}`, APP_REMOVED[unknown]));
        }
    }
    if (config.overlay !== undefined) checkOverlay(config, issues);
    // Gaps from init: not wrong, but nothing that signs in can run until they are filled in.
    return { ok: issues.length === 0, issues, notes, todo: todoFields(config) };
};

/** The error for an invalid config: one finding per line; `issues` keeps them for doctor, which shows only the first. */
const configInvalid = (issues) => Object.assign(new CawError('config-invalid', `${CONFIG_FILE}:\n- ${issues.join('\n- ')}`), { issues });

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
    const { issues, notes, todo } = validateConfig(config);
    if (issues.length > 0) throw configInvalid(issues);
    // The team default theme applies to everything this process shows: workbench, chat, card, terminal.
    setProjectTheme(config.theme);
    return { config, notes, todo };
};

export const loadConfig = (root) => loadConfigWithNotes(root).config;

// Keys that would hold a secret. Names of environment variables (loginEnv, passwordEnv) and selectors (passwordSelector) are fine.
const SECRET_KEY = /(password|passwd|secret|token)/i;
const NAMED_ONLY = /(Env|Selector)$/;

/** The keys of a patch that would write a secret, as paths. */
const secretKeys = (value, path = []) => (isObject(value) ? Object.entries(value).flatMap(([key, entry]) => [
    ...(SECRET_KEY.test(key) && !NAMED_ONLY.test(key) ? [[...path, key].join('.')] : []),
    ...secretKeys(entry, [...path, key]),
]) : []);

/** Deep merge for a config patch: objects merge, arrays and values replace, null deletes the key. */
const mergePatch = (base, patch) => {
    if (!isObject(patch)) return patch;
    const out = isObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete out[key];
        else out[key] = isObject(value) ? mergePatch(out[key], value) : value;
    }
    return out;
};

/**
 * Changes caw.config.json: merges the patch into the file as written (not the effective config), validates the result and writes
 * it atomically, only if valid and not dryRun. Never writes a secret: keys like password, secret or token are refused; credentials
 * stay in caw/.env, which this never touches.
 * @returns { ok, issues, config } with config as it would be written
 */
export const writeConfig = (root, patch, { dryRun = false } = {}) => {
    if (!isObject(patch)) return { ok: false, issues: [t('config.write.patch')], config: null };
    const secrets = secretKeys(patch);
    if (secrets.length > 0) return { ok: false, issues: [t('config.write.secret', { keys: secrets.join(', ') })], config: null };
    const file = join(root, CONFIG_FILE);
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        return { ok: false, issues: [error?.code === 'ENOENT' ? t('config.load.missing', { file: CONFIG_FILE, root }) : t('config.load.invalidJson', { file: CONFIG_FILE, error: error.message })], config: null };
    }
    const config = mergePatch(raw, patch);
    const { issues } = validateConfig(config);
    if (issues.length > 0 || dryRun) return { ok: issues.length === 0, issues, config };
    // One temp file per process, so two concurrent writers never leave a half-written file.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(config, null, 4)}\n`);
    renameSync(temp, file);
    return { ok: true, issues: [], config };
};

// A path inside the project: relative, without `..`. Like a part's `dir` and `build`.
const relativePath = (value) => typeof value === 'string' && value !== '' && !/^([\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..');
/** A part's statics path: relative, may leave the part folder with .. (a neighbouring package); the workspace bound is checked at run time. */
const staticPath = (value) => typeof value === 'string' && value.trim() !== '' && !/^([\\/]|[A-Za-z]:)/.test(value);
const APP_KEYS = ['startUrl'];
/** A server address: http(s), with host. Like --overlay <url>. */
export const isServerUrl = (value) => {
    if (typeof value !== 'string' || !/^https?:\/\/[^\s/]+/i.test(value)) return false;
    try {
        return new URL(value).hostname !== '';
    } catch {
        return false;
    }
};
const OVERLAY_KEYS = ['environments', 'parts', 'assetUrlPattern'];
const PART_KEYS = ['dir', 'url', 'start', 'build', 'statics', 'assetUrlPattern'];
/** Words of --overlay that select a source for all parts: a part must not be named like them. */
export const OVERLAY_KINDS = ['build', 'dev'];

/** assetUrlPattern as a list: one pattern or several, one per asset source (plain path, proxy parameter, CDN). */
export const patternList = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((pattern) => typeof pattern === 'string') : []);

/** The asset patterns for a part, without the default: overlay.assetUrlPattern plus the part's own. */
export const assetPatterns = (config, part) => [...new Set([...patternList(config?.overlay?.assetUrlPattern), ...patternList(config?.overlay?.parts?.[part]?.assetUrlPattern)])];

/** The overlay parts by name; empty without an overlay block. */
export const overlayParts = (config) => (isObject(config?.overlay?.parts) ? config.overlay.parts : {});
/** The environments where --overlay is allowed (overlay.environments); empty without an overlay block. */
export const overlayEnvironments = (config) => (Array.isArray(config?.overlay?.environments) ? config.overlay.environments.filter((name) => typeof name === 'string') : []);

/** The errors of an assetUrlPattern value: a string or a non-empty list of strings; each compiles and has group 1. */
const assetPatternIssues = (key, value) => {
    if (!(typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.every((pattern) => typeof pattern === 'string')))) return [t('config.assetUrlPattern.type', { key })];
    const issues = [];
    for (const pattern of patternList(value)) {
        let groups = -1;
        try {
            groups = new RegExp(`${pattern}|`).exec('').length - 1;
        } catch {
            issues.push(t('config.patterns.invalid', { key, pattern }));
        }
        if (groups === 0) issues.push(t('config.assetUrlPattern.group', { key, pattern }));
    }
    return issues;
};
const STATIC_KEYS = ['name', 'path'];

/**
 * The overlay block: environments where --overlay is allowed (existing, not production, not a dev server on this machine), shared
 * asset patterns and the parts with their sources.
 */
const checkOverlay = (config, issues) => {
    const overlay = config.overlay;
    if (!isObject(overlay)) {
        issues.push(t('config.overlay.block'));
        return;
    }
    for (const key of Object.keys(overlay).filter((candidate) => !OVERLAY_KEYS.includes(candidate))) {
        issues.push(t('config.overlay.blockUnknown', { key, hint: hintFor(key, OVERLAY_KEYS) }));
    }
    const names = environmentNames(config);
    if (!Array.isArray(overlay.environments) || overlay.environments.length === 0 || !overlay.environments.every((name) => typeof name === 'string')) {
        issues.push(t('config.overlay.environments'));
    } else {
        for (const name of overlay.environments) {
            if (!names.includes(name)) {
                issues.push(t('config.overlay.envUnknown', { name, names: names.join(', ') || '–' }));
                continue;
            }
            let env;
            try {
                env = effectiveEnvironment(config, name);
            } catch {
                continue; // reported with the environments
            }
            if (env.production) issues.push(t('config.overlay.envProduction', { name }));
            else if (typeof env.url === 'string' && URL.canParse(env.url)) {
                const { protocol, hostname, host } = new URL(env.url);
                if (protocol === 'http:' && isLoopback(hostname)) issues.push(t('config.overlay.envDevServer', { name, host }));
            }
        }
    }
    if (overlay.assetUrlPattern !== undefined) issues.push(...assetPatternIssues('overlay.assetUrlPattern', overlay.assetUrlPattern));
    if (!isObject(overlay.parts) || Object.keys(overlay.parts).length === 0) {
        issues.push(t('config.overlay.parts'));
        return;
    }
    const extjs = config.framework === 'extjs';
    for (const [name, part] of Object.entries(overlay.parts)) {
        if (!NAME.test(name) || OVERLAY_KINDS.includes(name)) issues.push(t('config.overlay.partName', { name }));
        issues.push(...partIssues(name, part, extjs));
    }
};

/** The errors in `overlay.parts.<name>`. With ExtJS the source is the Sencha watch at url: no build. */
const partIssues = (name, overlay, extjs) => {
    if (!isObject(overlay)) return [t('config.overlay.notObject', { name })];
    const issues = [];
    const unknown = Object.keys(overlay).find((key) => !PART_KEYS.includes(key));
    if (unknown !== undefined) issues.push(t('config.overlay.unknown', { name, key: unknown, hint: hintFor(unknown, PART_KEYS) }));
    if (!relativePath(overlay.dir)) issues.push(t('config.overlay.dir', { name }));
    if (overlay.build !== undefined && !relativePath(overlay.build)) issues.push(t('config.overlay.build', { name }));
    if (overlay.url !== undefined && !isServerUrl(overlay.url)) issues.push(t('config.overlay.dev', { name }));
    if (extjs && overlay.build !== undefined) issues.push(t('config.overlay.extjs', { name }));
    if (overlay.start !== undefined && (typeof overlay.start !== 'string' || overlay.start.trim() === '')) issues.push(t('config.overlay.command', { name }));
    if (overlay.start !== undefined && overlay.url === undefined && overlay.build === undefined && !extjs) issues.push(t('config.overlay.commandWithout', { name }));
    if (overlay.assetUrlPattern !== undefined) issues.push(...assetPatternIssues(`overlay.parts.${name}.assetUrlPattern`, overlay.assetUrlPattern));
    if (overlay.statics !== undefined && !Array.isArray(overlay.statics)) issues.push(t('config.overlay.statics', { name }));
    else (overlay.statics ?? []).forEach((entry, index) => {
        const extra = isObject(entry) ? Object.keys(entry).find((key) => !STATIC_KEYS.includes(key)) : undefined;
        if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '' || !staticPath(entry.path) || extra !== undefined) {
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

/** The environments a run's browser may reach, see navigationHosts. */
export { navigationHosts } from './environments.mjs';

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
    const siteUuid = uuidOf(`portal:${resolved.name}`);
    const signedIn = authOf(config).signedInSelector;
    return {
        activePortal: siteUuid,
        ...(config.overlay?.assetUrlPattern === undefined ? {} : { assetUrlPattern: config.overlay.assetUrlPattern }),
        authMarker: signedIn ?? null,
        portals: [{ uuid: siteUuid, name: resolved.name, url: resolved.url }],
        projects: [{
            uuid: uuidOf(`project:${appName}`),
            name: appName,
            active: true,
            startUrl: app.startUrl,
        }],
    };
};
