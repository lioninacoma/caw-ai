// The project config caw.config.json: one application, its environments (src/shared/environments.mjs), sign-in, roles and
// what replays need to know. The tool itself knows no environment, portal or customer.

import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';
import { CONFIG_FILE } from './names.mjs';
import { compileRead } from './requests.mjs';
import { projectThemeProblems, setProjectTheme } from './theme-package.mjs';
import { didYouMean } from './suggest.mjs';
import { RESERVED_ROLES } from './credentials.mjs';
import { NAME, effectiveEnvironment, effectiveEnvironments, environmentNames, signInTypes } from './environments.mjs';

export { CONFIG_FILE } from './names.mjs';
export { environmentsWith } from './environments.mjs';

const ENVIRONMENT_FLAGS = ['claude', 'writable', 'production', 'insecureTls', 'allowHttp'];
/** The lifecycle commands of an environment (§2.9): shell commands run in the project root. */
const LIFECYCLE_COMMANDS = ['start', 'stop', 'reset'];
const ENVIRONMENT_KEYS = ['url', 'extends', 'signIn', 'gate', 'allowHosts', 'thirdPartyHosts', ...ENVIRONMENT_FLAGS, ...LIFECYCLE_COMMANDS, 'ready'];
/** Limits of ready.timeoutMs: one second to half an hour. */
const READY_TIMEOUT_MS = { min: 1000, max: 1_800_000 };
// A production environment must be declared explicitly, and then has no Claude, no local code and no writing.
// Names containing it count too, e.g. prod-de or live_eu. If such an environment is not production, say so with "production": false.
const PRODUCTION_NAME = /(^|[-_.])(prod|production|produktion|produktiv|prd|live)([-_.]|\d|$)/i;
const PRODUCTION_EXACT = /^(prod|production|produktion|produktiv|prd|live)$/i;
/** Does the name look like production (prod, live-eu …)? init then writes production: true and nothing else. */
export const productionLike = (name) => PRODUCTION_NAME.test(String(name));
export const DEFAULT_MESSAGE_SELECTORS = ['[role=alert]', '[role=alertdialog]'];
/** The framework adapters in src/host/framework/; `web` is the default. */
export const FRAMEWORK_NAMES = ['web', 'extjs', 'react', 'vue', 'angular'];
/** Sign-in types: none, a form (with or without steps), HTTP Basic, or a saved session per environment and role. */
export const SIGN_IN_TYPES = ['none', 'form', 'basic', 'session'];
const SIGN_IN_FIELDS = {
    none: ['type'],
    form: ['type', 'path', 'userSelector', 'passwordSelector', 'submitSelector', 'codeSelector', 'signedInSelector', 'steps'],
    basic: ['type', 'signedInSelector'],
    session: ['type', 'path', 'signedInSelector'],
};
/** The verbs of a sign-in step; each step has exactly one. */
export const STEP_VERBS = ['fill', 'click', 'press', 'waitFor'];
const STEP_KEYS = [...STEP_VERBS, 'with', 'value', 'on', 'optional', 'timeoutMs'];
/** What a fill step may put in from the test user: user name, password or the current one-time code. */
export const FILL_WITH = ['user', 'password', 'totp'];
/** Folder of saved sessions (`signIn.type: session`): one file per environment and role, never checked in. */
export const AUTH_DIR = 'caw/.auth';
/** Value of a sign-in selector explore did not find: doctor reports it until it is filled in. */
export const TODO = 'TODO';
/** Every sign-in object as written, with where it stands: "signIn" or "environments.<env>.signIn". */
const signInPlaces = (config) => [
    ...(isObject(config?.signIn) ? [['signIn', config.signIn]] : []),
    ...Object.entries(isObject(config?.environments) ? config.environments : {})
        .filter(([, env]) => isObject(env) && isObject(env.signIn)).map(([name, env]) => [`environments.${name}.signIn`, env.signIn]),
];
/** The sign-in fields still TODO since init, as "signIn.<field>" or "environments.<env>.signIn.<field>". */
export const todoFields = (config) => signInPlaces(config).flatMap(([at, signIn]) => Object.entries(signIn).filter(([, value]) => value === TODO).map(([key]) => `${at}.${key}`));
/** The saved session of a role on an environment, relative to the project: caw/.auth/<environment>/<role>.json. */
export const sessionPath = (env, role) => posix.join(AUTH_DIR, String(env), `${role}.json`);

const TOP_FIELDS = ['framework', 'start', 'source', 'environments', 'signIn', 'roles', 'messageSelectors', 'requestKeys', 'reads',
    'consoleIgnore', 'foreignCode', 'allowHosts', 'thirdPartyHosts', 'overlay', 'effects', 'maxActions', 'sandboxImage', 'sandboxUser', 'lintCommand', 'readyTimeoutMs',
    'browser', 'agent', 'language', 'theme', 'readyIgnore'];
const BROWSER_FIELDS = ['channel', 'executablePath', 'locale', 'timezone', 'viewport', 'noSandbox'];
/** A CSS viewport { width, height } in whole pixels, as a recording stores it and browser.viewport sets it. */
export const isViewport = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every((key) => key === 'width' || key === 'height')
    && Number.isInteger(value.width) && value.width >= 320 && value.width <= 7680
    && Number.isInteger(value.height) && value.height >= 240 && value.height <= 4320;

/**
 * Keys that existed before 1.0. They are not read: the message says what replaced them or why they went. A static table, so
 * an old config fails with a clear message instead of an "unknown key".
 */
export const REMOVED_KEYS = {
    sites: { why: 'config.removed.sites' },
    extends: { why: 'config.removed.extends' },
    insecureTls: { now: 'environments.<env>.insecureTls' },
    extraAllowedHosts: { now: 'allowHosts' },
    auth: { now: 'signIn' },
    assetUrlPattern: { now: 'overlay.assetUrlPattern' },
    apps: { why: 'config.removed.apps' },
    maxSteps: { now: 'maxActions' },
};
const ENVIRONMENT_REMOVED = { urls: { why: 'config.removed.urls' }, overlay: { now: 'overlay.environments' } };
/** The message for a removed key: renamed (now) or gone (why). */
const removedKey = (path, entry) => (entry.now === undefined ? t('config.removed.gone', { key: path, why: t(entry.why) }) : t('config.removed.renamed', { key: path, now: entry.now }));

/** Where Claude runs: locally with restricted tools (default), isolated in Docker, or the developer's own Claude Code session. */
export const AGENT_MODES = ['local', 'docker', 'session'];
const AGENT_KEYS = ['mode', 'model', 'maxBudgetUsd'];
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

/** Where Claude runs by the config (`agent.mode`, default local). Always Docker in CI: nobody is there to watch a local agent or a session. */
export const agentMode = (config, env = process.env) => {
    const chosen = isObject(config?.agent) && typeof config.agent.mode === 'string' ? config.agent.mode : 'local';
    return env.CI !== undefined && env.CI !== '' ? 'docker' : chosen;
};

/** Chromium browsers Playwright finds on the system. Other browsers have no host block via launch arguments. */
export const BROWSER_CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'msedge-beta', 'msedge-dev'];

/** How the browser starts: the system Chrome by default, otherwise `browser.channel` or `browser.executablePath` from the config. */
// Always with Chrome's sandbox: Playwright starts Chromium without it unless asked. Only `browser.noSandbox: true` turns it off,
// for a machine where it cannot start (Linux as root, some containers). That is unsafe: a page that breaks the renderer then
// runs with the user's rights.
export const browserLaunch = (config) => {
    const browser = isObject(config?.browser) ? config.browser : {};
    const chromiumSandbox = browser.noSandbox !== true;
    if (typeof browser.executablePath === 'string' && browser.executablePath !== '') return { executablePath: browser.executablePath, chromiumSandbox };
    return { channel: typeof browser.channel === 'string' ? browser.channel : 'chrome', chromiumSandbox };
};
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/**
 * A browser on this machine: an absolute path, not on a network share (\\host\share, //host/share), not a device or
 * long-path namespace (\\?\, \\.\) and not under /proc (/proc/self/fd/…, a file a process holds open).
 */
const localExecutable = (value) => typeof value === 'string' && isAbsolute(value) && !/^[\\/]{2}/.test(value)
    && !/^\/proc(\/|$)/.test(value);
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
            if (key === 'reads') {
                issues.push(t('config.env.readsTopLevel', { name }));
                continue;
            }
            issues.push(removed === undefined
                ? t('config.env.unknown', { name, key, keys: ENVIRONMENT_KEYS.join(', '), hint: hintFor(key, ENVIRONMENT_KEYS) })
                : removedKey(`environments.${name}.${key}`, removed));
        }
        const notBoolean = ENVIRONMENT_FLAGS.find((key) => raw[key] !== undefined && typeof raw[key] !== 'boolean');
        if (notBoolean !== undefined) issues.push(t('config.env.notBoolean', { name, key: notBoolean }));
        if (raw.extends !== undefined && (typeof raw.extends !== 'string' || !names.includes(raw.extends))) {
            issues.push(t('config.env.extendsUnknown', { name, parent: String(raw.extends), names: names.filter((other) => other !== name).join(', ') || '–' }));
        }
        for (const key of ['allowHosts', 'thirdPartyHosts']) issues.push(...hostListIssues(`environments.${name}.${key}`, raw[key]));
        if (raw.signIn !== undefined && !isObject(raw.signIn)) issues.push(t('config.signIn.notObject', { at: `environments.${name}.signIn` }));
        if (raw.gate !== undefined && !(isObject(raw.gate) && raw.gate.type === 'basic' && Object.keys(raw.gate).length === 1)) issues.push(t('config.gate.shape', { name }));
        for (const key of LIFECYCLE_COMMANDS.filter((command) => raw[command] !== undefined && (typeof raw[command] !== 'string' || raw[command].trim() === ''))) {
            issues.push(t('config.env.command', { name, key }));
        }
        if (raw.ready !== undefined && !readyValid(raw.ready)) issues.push(t('config.env.ready', { name, min: READY_TIMEOUT_MS.min, max: READY_TIMEOUT_MS.max }));
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
        // Starting, stopping or resetting production is never caw's job; reset writes, so it needs a writable environment.
        const commands = LIFECYCLE_COMMANDS.filter((key) => env[key] !== undefined);
        if (env.production && commands.length > 0) issues.push(t('config.env.productionLifecycle', { name, keys: commands.join(', ') }));
        if (env.stop !== undefined && env.start === undefined) issues.push(t('config.env.stopWithoutStart', { name }));
        if (env.reset !== undefined && !env.writable && !env.production) issues.push(t('config.env.resetNotWritable', { name }));
        // The gate's Basic credentials and a Basic sign-in would both be the browser's HTTP credentials: one would hide the other.
        if (env.gate !== undefined && env.signIn.type === 'basic') issues.push(t('config.gate.withBasic', { name }));
    }
};

/** ready: { path?: "/…", timeoutMs?: 1000–1800000 }, nothing else. */
const readyValid = (ready) => isObject(ready)
    && Object.keys(ready).every((key) => ['path', 'timeoutMs'].includes(key))
    && (ready.path === undefined || (typeof ready.path === 'string' && ready.path.startsWith('/') && !ready.path.startsWith('//')))
    && (ready.timeoutMs === undefined || (Number.isInteger(ready.timeoutMs) && ready.timeoutMs >= READY_TIMEOUT_MS.min && ready.timeoutMs <= READY_TIMEOUT_MS.max));

/**
 * One sign-in object (§2.5): its type's fields only, as text; a form with path and signedInSelector plus either the user and
 * password selectors or steps; a session with signedInSelector.
 * @param at where it stands, for the messages
 */
const checkSignIn = (at, signIn, issues) => {
    if (signIn.type === 'storageState') {
        issues.push(t('config.removed.renamed', { key: `${at}.type "storageState"`, now: `${at}.type "session"` }));
        return;
    }
    if (!SIGN_IN_TYPES.includes(signIn.type)) {
        issues.push(t('config.signIn.type', { at, types: SIGN_IN_TYPES.join(', ') }));
        return;
    }
    const allowed = SIGN_IN_FIELDS[signIn.type];
    for (const key of Object.keys(signIn)) {
        if (!allowed.includes(key)) issues.push(t('config.signIn.foreign', { at, type: signIn.type, key, fields: allowed.join(', '), hint: hintFor(key, allowed) }));
        else if (key !== 'steps' && (typeof signIn[key] !== 'string' || signIn[key] === '')) issues.push(t('config.signIn.text', { at, key }));
    }
    // TODO is not a wrong path but a gap from init: validateConfig reports it under `todo`.
    if (typeof signIn.path === 'string' && signIn.path !== TODO && !isStartPath(signIn.path)) issues.push(t('config.signIn.path', { at }));
    const absent = (keys) => keys.filter((key) => typeof signIn[key] !== 'string' || signIn[key] === '');
    if (signIn.type === 'session' && absent(['signedInSelector']).length > 0) issues.push(t('config.signIn.missing', { at, type: 'session', missing: 'signedInSelector' }));
    if (signIn.type !== 'form') return;
    const withSteps = signIn.steps !== undefined;
    const missing = absent(['path', 'signedInSelector', ...(withSteps ? [] : ['userSelector', 'passwordSelector'])]);
    if (missing.length > 0) issues.push(t(withSteps ? 'config.signIn.missing' : 'config.signIn.formMissing', { at, type: 'form', missing: missing.join(', ') }));
    if (!withSteps) return;
    const both = ['userSelector', 'passwordSelector', 'submitSelector', 'codeSelector'].filter((key) => signIn[key] !== undefined);
    if (both.length > 0) issues.push(t('config.signIn.stepsOr', { at, keys: both.join(', ') }));
    checkSteps(at, signIn.steps, issues);
};

/** The steps of a form sign-in: 1–20, each with exactly one verb; fill takes `with` or `value`; at least one `with`. */
const checkSteps = (at, steps, issues) => {
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 20) {
        issues.push(t('config.signIn.steps', { at }));
        return;
    }
    steps.forEach((step, index) => {
        const where = `${at}.steps[${index}]`;
        if (!isObject(step)) {
            issues.push(t('config.signIn.stepVerb', { at: where, verbs: STEP_VERBS.join(', ') }));
            return;
        }
        for (const key of Object.keys(step).filter((candidate) => !STEP_KEYS.includes(candidate))) {
            issues.push(t('config.signIn.stepUnknown', { at: where, key, keys: STEP_KEYS.join(', '), hint: hintFor(key, STEP_KEYS) }));
        }
        const verbs = STEP_VERBS.filter((verb) => step[verb] !== undefined);
        if (verbs.length !== 1) {
            issues.push(t('config.signIn.stepVerb', { at: where, verbs: STEP_VERBS.join(', ') }));
            return;
        }
        const [verb] = verbs;
        if (typeof step[verb] !== 'string' || step[verb] === '') issues.push(t('config.signIn.stepText', { at: where, key: verb }));
        if (verb === 'fill') {
            if ((step.with === undefined) === (step.value === undefined)) issues.push(t('config.signIn.stepFill', { at: where }));
            else if (step.with !== undefined && !FILL_WITH.includes(step.with)) issues.push(t('config.signIn.stepWith', { at: where, values: FILL_WITH.join(', ') }));
            else if (step.value !== undefined && typeof step.value !== 'string') issues.push(t('config.signIn.stepFill', { at: where }));
        } else if (step.with !== undefined || step.value !== undefined) issues.push(t('config.signIn.stepFillOnly', { at: where }));
        if (step.on !== undefined && (verb !== 'press' || typeof step.on !== 'string' || step.on === '')) issues.push(t('config.signIn.stepOn', { at: where }));
        if (step.optional !== undefined && typeof step.optional !== 'boolean') issues.push(t('config.signIn.stepOptional', { at: where }));
        if (step.timeoutMs !== undefined && !(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 100 && step.timeoutMs <= 600000)) issues.push(t('config.signIn.stepTimeout', { at: where }));
    });
    if (!steps.some((step) => isObject(step) && step.with !== undefined)) issues.push(t('config.signIn.stepsWith', { at }));
};

const ROLE_REMOVED = { loginEnv: 'config.removed.roleEnv', passwordEnv: 'config.removed.roleEnv', totpEnv: 'config.removed.roleEnv' };
/** Roles exactly when some environment signs in; each an empty object, named like an environment, never "gate". */
const checkRoles = (config, issues) => {
    const types = signInTypes(config).filter((type) => type !== 'none');
    if (config.roles === undefined) {
        if (types.length > 0) issues.push(t('config.roles.missing', { types: types.join(', ') }));
        return;
    }
    if (types.length === 0) {
        issues.push(t('config.roles.withoutSignIn'));
        return;
    }
    if (!isObject(config.roles) || Object.keys(config.roles).length === 0) {
        issues.push(t('config.roles.notObject'));
        return;
    }
    for (const [name, role] of Object.entries(config.roles)) {
        if (!NAME.test(name)) issues.push(t('config.role.name', { name }));
        else if (RESERVED_ROLES.includes(name)) issues.push(t('config.role.reserved', { name }));
        if (!isObject(role)) {
            issues.push(t('config.role.notObject', { name }));
            continue;
        }
        for (const key of Object.keys(role)) {
            issues.push(ROLE_REMOVED[key] === undefined ? t('config.role.unknownField', { name, key }) : removedKey(`roles.${name}.${key}`, { why: ROLE_REMOVED[key] }));
        }
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
    // The team language: a primary language subtag (de, en, fr, pt …). caw's own texts stay de/en, Claude writes in it.
    if (given.language !== undefined && !(typeof given.language === 'string' && /^[a-z]{2,3}$/.test(given.language))) issues.push(t('config.language', { value: String(JSON.stringify(given.language)) }));
    const config = given;

    checkEnvironments(config, issues, notes);
    for (const [at, signIn] of signInPlaces(config)) checkSignIn(at, signIn, issues);
    if (config.signIn !== undefined && !isObject(config.signIn)) issues.push(t('config.signIn.notObject', { at: 'signIn' }));
    checkRoles(config, issues);
    if (config.start !== undefined && !isStartPath(config.start)) issues.push(t('config.start'));
    // Where the application's source is, relative to the project (default "."); false: no source here (no code changes, no code advice).
    if (config.source !== undefined && config.source !== false && !relativePath(config.source)) issues.push(t('config.source'));
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
            if (config.agent.sandbox !== undefined) issues.push(t('config.removed.renamed', { key: 'agent.sandbox', now: 'agent.mode' }));
            const unknown = Object.keys(config.agent).find((key) => !AGENT_KEYS.includes(key) && key !== 'sandbox');
            if (unknown !== undefined) issues.push(t('config.agent.unknown', { key: unknown, hint: hintFor(unknown, AGENT_KEYS) }));
            if (config.agent.mode !== undefined && !AGENT_MODES.includes(config.agent.mode)) issues.push(t('config.agent.mode', { names: AGENT_MODES.join(', ') }));
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
            if (config.browser.viewport !== undefined && !isViewport(config.browser.viewport)) issues.push(t('config.browser.viewport'));
            if (config.browser.channel !== undefined && !BROWSER_CHANNELS.includes(config.browser.channel)) issues.push(t('config.browser.channel', { names: BROWSER_CHANNELS.join(', ') }));
            if (config.browser.executablePath !== undefined && !localExecutable(config.browser.executablePath)) issues.push(t('config.browser.executablePath'));
            if (config.browser.channel !== undefined && config.browser.executablePath !== undefined) issues.push(t('config.browser.both'));
            if (config.browser.noSandbox !== undefined && typeof config.browser.noSandbox !== 'boolean') issues.push(t('config.browser.noSandbox'));
        }
    }
    if (typeof config.sandboxImage === 'string' && !/^[\w./:@-]+$/.test(config.sandboxImage)) issues.push(t('config.sandboxImage'));
    if (config.sandboxUser !== undefined && !/^[a-z_][a-z0-9_-]*$/.test(config.sandboxUser)) issues.push(t('config.sandboxUser'));
    if (config.maxActions !== undefined && (!Number.isInteger(config.maxActions) || config.maxActions <= 0)) issues.push(t('config.maxActions'));
    if (config.readyTimeoutMs !== undefined && (!Number.isInteger(config.readyTimeoutMs) || config.readyTimeoutMs <= 0)) issues.push(t('config.readyTimeoutMs'));
    for (const key of ['allowHosts', 'thirdPartyHosts']) issues.push(...hostListIssues(key, config[key]));
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
    if (config.reads !== undefined) {
        if (!Array.isArray(config.reads)) issues.push(t('config.reads.notList'));
        else for (const pattern of config.reads.filter((entry) => compileRead(entry) === null)) issues.push(t('config.reads.invalid', { pattern: String(pattern) }));
    }
    if (config.requestKeys !== undefined && (!Array.isArray(config.requestKeys) || !config.requestKeys.every((key) => typeof key === 'string' && /^(json\.)?[\w-]+$/.test(key)))) {
        issues.push(t('config.requestKeys'));
    }
    const effectLists = ['controls', 'view', 'requests', 'responses', 'console'];
    if (config.effects !== undefined && !(isObject(config.effects) && Object.keys(config.effects).every((key) => key === 'fail')
        && (config.effects.fail === undefined || (Array.isArray(config.effects.fail) && config.effects.fail.every((list) => effectLists.includes(list)))))) {
        issues.push(t('config.effects', { lists: effectLists.join(', ') }));
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

// Keys that would hold a secret. Selectors (passwordSelector) are fine.
const SECRET_KEY = /(password|passwd|secret|token)/i;
const NAMED_ONLY = /Selector$/;

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

/** Per environment: the keys that run commands or decide what Claude and caw may do there (compared after extends). */
const GUARDED_ENVIRONMENT_KEYS = [...LIFECYCLE_COMMANDS, 'ready', ...ENVIRONMENT_FLAGS];
/** Top-level keys that run a command, start a program or choose where Claude runs. */
const GUARDED_PATHS = [['lintCommand'], ['sandboxImage'], ['sandboxUser'], ['browser', 'executablePath'], ['agent', 'mode']];
const valueAt = (config, path) => path.reduce((value, key) => (isObject(value) ? value[key] : undefined), config);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** What an environment that does not exist counts as: every flag off, no command, the default ready check. */
const absentEnvironment = () => effectiveEnvironment({ environments: { absent: { url: 'https://absent.invalid' } } }, 'absent');

/**
 * The guarded keys a change touches, as paths: lifecycle commands, ready, the environment flags (production, claude, writable,
 * allowHttp, insecureTls) as runs see them after extends, overlay part start commands, lintCommand, sandboxImage, sandboxUser,
 * browser.executablePath and agent.mode. An environment added or removed counts with every guarded key it has, so deleting a
 * production environment or adding one with claude: true is a guarded change too. They change only by an edit the human sees.
 */
export const guardedChanges = (before, after) => {
    const changed = [];
    const environmentsBefore = effectiveEnvironments(isObject(before) ? before : {});
    const environmentsAfter = effectiveEnvironments(isObject(after) ? after : {});
    for (const name of new Set([...Object.keys(environmentsBefore), ...Object.keys(environmentsAfter)])) {
        const was = environmentsBefore[name] ?? absentEnvironment();
        const now = environmentsAfter[name] ?? absentEnvironment();
        for (const key of GUARDED_ENVIRONMENT_KEYS.filter((candidate) => !same(was[candidate], now[candidate]))) changed.push(`environments.${name}.${key}`);
    }
    const partsBefore = overlayParts(before);
    const partsAfter = overlayParts(after);
    for (const part of new Set([...Object.keys(partsBefore), ...Object.keys(partsAfter)])) {
        if (!same(partsBefore[part]?.start, partsAfter[part]?.start)) changed.push(`overlay.parts.${part}.start`);
    }
    for (const path of GUARDED_PATHS.filter((candidate) => !same(valueAt(before, candidate), valueAt(after, candidate)))) changed.push(path.join('.'));
    return changed;
};

/**
 * Changes caw.config.json: merges the patch into the file as written (not the effective config), validates the result and writes
 * it atomically, only if valid and not dryRun. Never writes a secret: keys like password, secret or token are refused; credentials
 * stay in caw/.env, which this never touches. Never changes a guarded key (guardedChanges): commands caw runs, where Claude runs
 * and what it may do are edited in the file, where the human sees the diff.
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
    const guarded = guardedChanges(raw, config);
    if (guarded.length > 0) return { ok: false, issues: [t('config.write.guarded', { keys: guarded.join(', '), file: CONFIG_FILE })], config: null, guarded };
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
/** A start path: from the root of the environment, not protocol-relative; query and hash allowed. */
export const isStartPath = (value) => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
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
 * Builds the config the devlink host expects from project config and environment: environment, start path, login marker. It
 * does not inject local code; the overlay (src/ext/overlay/overlay.mjs) does that with its own route.
 */
export const buildDevlinkConfig = (config, resolved, start) => {
    const siteUuid = uuidOf(`portal:${resolved.name}`);
    const signedIn = resolved.signIn?.signedInSelector;
    return {
        activePortal: siteUuid,
        ...(config.overlay?.assetUrlPattern === undefined ? {} : { assetUrlPattern: config.overlay.assetUrlPattern }),
        authMarker: signedIn ?? null,
        portals: [{ uuid: siteUuid, name: resolved.name, url: resolved.url }],
        projects: [{
            uuid: uuidOf('project:app'),
            name: 'app',
            active: true,
            startUrl: start,
        }],
    };
};
