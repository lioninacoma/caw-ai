// Die Umgebung kommt aus der Config des Projekts, optional ergaenzt um ein Fragment im Projekt (`extends`). Das Tool selbst kennt
// keine Umgebung, kein Portal und keine Kunden.
//
// Der Normalfall ist flach: eine Anwendung, ein paar Umgebungen mit je einer Adresse.
//   "environments": { "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
//                     "staging": { "url": "https://staging.example.com" } }
//   Ziel: "local"
// Ein lokaler Dev-Server liefert den lokalen Code schon selbst aus. localCode braucht nur eine entfernte Umgebung, in die der lokale
// Build (apps.<name>.localBuild) eingespielt wird: "dev": { "url": "https://dev.example.com", "claude": true, "localCode": true }
// Laeuft dieselbe Anwendung fuer mehrere Mandanten unter eigenen Adressen, nennt `sites` die Mandanten und jede Umgebung `urls`:
//   "sites": ["nord", "sued"], "environments": { "dev": { "urls": { "nord": "https://…", "sued": "https://…" }, "claude": true } }
//   Ziel: "nord/dev"

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

import { CawError } from './errors.mjs';
import { t } from './i18n.mjs';
import { CONFIG_FILE } from './names.mjs';
import { didYouMean } from './suggest.mjs';

export { CONFIG_FILE } from './names.mjs';

// `claude` hiess frueher `agent`, wie das Objekt `agent` oben in der Config. Der alte Name gilt weiter, mit Hinweis.
const ENVIRONMENT_FLAGS = ['claude', 'localCode', 'writable', 'production'];
const OLD_ENVIRONMENT_FLAGS = ['agent'];
// Eine Produktionsumgebung gibt es nur ausdruecklich, und dann ohne Claude, ohne lokalen Code und ohne Schreiben.
// Auch als Bestandteil, etwa prod-de oder live_eu. Wer so eine Umgebung nicht als Produktion meint, sagt das mit "production": false.
const PRODUCTION_NAME = /(^|[-_.])(prod|production|produktion|produktiv|prd|live)([-_.]|\d|$)/i;
const PRODUCTION_EXACT = /^(prod|production|produktion|produktiv|prd|live)$/i;
const NAME = /^[a-z][\w-]*$/;
export const DEFAULT_MESSAGE_SELECTORS = ['[role=alert]', '[role=alertdialog]'];
/** Die Framework-Adapter unter src/host/framework/; `web` ist der Standard. */
export const FRAMEWORK_NAMES = ['web', 'extjs', 'react', 'vue', 'angular'];
/** Arten der Anmeldung. */
export const AUTH_TYPES = ['form', 'basic', 'storageState', 'none'];
const AUTH_FIELDS = {
    form: ['type', 'path', 'userSelector', 'passwordSelector', 'submitSelector', 'codeSelector', 'signedInSelector'],
    basic: ['type', 'signedInSelector'],
    storageState: ['type', 'path', 'signedInSelector'],
    none: ['type'],
};
/** Ordner der gespeicherten Sitzungen (`auth.type: storageState`): je Rolle eine Datei, nie eingecheckt. */
export const AUTH_DIR = 'caw/.auth';
/** Wert eines Anmelde-Selektors, den explore nicht fand: doctor meldet ihn, bis er eingetragen ist. */
export const TODO = 'TODO';
/** Die gespeicherte Sitzung einer Rolle auf einem Ziel, relativ zum Projekt: caw/.auth/<umgebung>/<rolle>.json, mit Mandanten caw/.auth/<mandant>/<umgebung>/<rolle>.json. */
export const sessionPath = (target, role) => posix.join(AUTH_DIR, ...String(target).split('/'), `${role}.json`);

const TOP_FIELDS = ['framework', 'extends', 'environments', 'sites', 'auth', 'apps', 'roles', 'messageSelectors', 'insecureTls', 'requestKeys',
    'consoleIgnore', 'foreignCode', 'extraAllowedHosts', 'assetUrlPattern', 'effects', 'maxSteps', 'sandboxImage', 'sandboxUser', 'lintCommand', 'readyTimeoutMs',
    'browser', 'agent', 'language'];

/** Wo Claude laeuft: lokal mit engen Werkzeugen (Standard) oder abgeschottet in Docker. */
export const AGENT_SANDBOXES = ['local', 'docker'];

/** Der Weg fuer Claude aus der Config. In CI immer Docker: Dort sitzt niemand, der einem lokalen Agenten zusieht. */
export const agentSandbox = (config, env = process.env) => {
    const chosen = isObject(config?.agent) && typeof config.agent.sandbox === 'string' ? config.agent.sandbox : 'local';
    return env.CI !== undefined && env.CI !== '' ? 'docker' : chosen;
};

/** Chromium-Browser, die Playwright ueber das System findet. Ein anderer Browser hat keine Host-Sperre ueber Startparameter. */
export const BROWSER_CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'msedge', 'msedge-beta', 'msedge-dev'];

/** Wie der Browser startet: Standard ist Chrome des Systems, sonst `browser.channel` oder `browser.executablePath` aus der Config. */
export const browserLaunch = (config) => {
    const browser = isObject(config?.browser) ? config.browser : {};
    if (typeof browser.executablePath === 'string' && browser.executablePath !== '') return { executablePath: browser.executablePath };
    return { channel: typeof browser.channel === 'string' ? browser.channel : 'chrome' };
};
// Alte Namen: kein Rueckfall, aber ein Hinweis auf den neuen (Text unter config.renamed.<name>).
const RENAMED = Object.fromEntries(['portals', 'customPortals', 'stages', 'login', 'authMarker', 'preset', 'writableStages', 'ui']
    .map((name) => [name, `config.renamed.${name}`]));

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const HOST = /^[a-z0-9.-]+$/i;
/** Der Host aus einer Adresse wie "https://login.example.com/" oder "login.example.com:443", sonst null. */
const hostOf = (value) => {
    if (typeof value !== 'string') return null;
    try {
        const { hostname } = new URL(/^[a-z][\w+.-]*:\/\//i.test(value) ? value : `https://${value}`);
        return HOST.test(hostname) && hostname !== value ? hostname : null;
    } catch {
        return null;
    }
};

/** Der Vorschlag zu einem unbekannten Feld als Zusatz, etwa " (meintest du insecureTls?)", sonst leer. */
const hintFor = (key, allowed) => {
    const name = didYouMean(key, allowed);
    return name === undefined ? '' : t('config.didYouMean', { name });
};

/**
 * Liest das Fragment aus `extends` (`"extends": "./caw/presets/basis.json"`): Felder wie in der Config, ohne eigenes `extends`.
 * @returns das Fragment oder ein Text mit dem Problem
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
 * Die wirksame Config: das Fragment aus `extends`, darueber die Config des Projekts. Umgebungen werden je Name zusammengefuehrt,
 * Felder des Projekts gewinnen; alles andere ersetzt das Projekt ganz.
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

/** Die Umgebungen mit Faehigkeiten und Adressen; ohne `sites` steht die Adresse unter dem leeren Mandanten. */
export const environmentDefs = (config) => Object.fromEntries(Object.entries(config.environments ?? {}).map(([name, raw]) => {
    const entry = raw ?? {};
    const urls = config.sites === undefined ? (entry.url === undefined ? {} : { '': entry.url }) : Object.fromEntries((config.sites ?? []).filter((site) => entry.urls?.[site] !== undefined).map((site) => [site, entry.urls[site]]));
    // Intern heisst die Faehigkeit weiter `agent`: Claude darf hier arbeiten.
    return [name, { agent: entry.claude === true || entry.agent === true, localCode: entry.localCode === true, writable: entry.writable === true, production: entry.production === true, urls }];
}));

/** Umgebungen mit einer Faehigkeit, fuer Meldungen wie "nur auf dev". */
export const environmentsWith = (config, ability) => Object.entries(environmentDefs(config)).filter(([, entry]) => entry[ability]).map(([name]) => name);

/**
 * Der eigene Rechner: localhost, 127.0.0.1 und Namen unter .localhost (RFC 6761). Sie zeigen fest auf Loopback und gelten in
 * Chrome als sicher, darum ist dort auch http erlaubt, etwa fuer einen lokalen Dev-Server.
 */
export const isLoopback = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');

/** Warum eine Adresse kein erlaubter Origin ist, oder null. http nur auf dem eigenen Rechner (isLoopback), sonst https. */
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


const checkEnvironments = (config, issues, notes) => {
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
        const unknown = Object.keys(raw).find((key) => !['url', 'urls', ...ENVIRONMENT_FLAGS, ...OLD_ENVIRONMENT_FLAGS].includes(key));
        if (unknown !== undefined) issues.push(t('config.env.unknown', { name, key: unknown, flags: ENVIRONMENT_FLAGS.join(', '), hint: hintFor(unknown, ['url', 'urls', ...ENVIRONMENT_FLAGS]) }));
        if (raw.agent !== undefined) notes.push(t('config.env.agentRenamed', { name, value: String(raw.agent) }));
        const notBoolean = [...ENVIRONMENT_FLAGS, ...OLD_ENVIRONMENT_FLAGS].find((key) => raw[key] !== undefined && typeof raw[key] !== 'boolean');
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
        if (raw.production === true && (raw.claude === true || raw.agent === true || raw.localCode === true || raw.writable === true)) issues.push(t('config.env.productionFlags', { name }));
    }
    for (const site of Array.isArray(sites) ? sites : []) {
        if (PRODUCTION_NAME.test(site)) issues.push(t('config.site.production', { site: String(site) }));
        if (!Object.values(config.environments).some((raw) => isObject(raw?.urls) && raw.urls[site] !== undefined)) issues.push(t('config.site.noUrl', { site: String(site) }));
    }
};

/** Die Anmeldung, wie sie das Tool benutzt. Ohne `auth`: keine Anmeldung. */
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
            // Namen von Umgebungsvariablen in caw/.env; ein Tippfehler im Schluessel (passwortEnv) fiele sonst erst beim Anmelden auf.
            for (const [key, value] of Object.entries(role)) {
                if (!ROLE_FIELDS.includes(key)) issues.push(t('config.role.unknownField', { name, key, allowed: ROLE_FIELDS.join(', '), hint: hintFor(key, ROLE_FIELDS) }));
                else if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) issues.push(t('config.role.envName', { name, key }));
            }
        }
        if (!needsSecrets && Object.keys(role).length > 0) issues.push(t('config.role.noFields', { name, type, why: type === 'storageState' ? t('config.role.sessionFile', { dir: AUTH_DIR, name }) : t('config.role.noAuth') }));
    }
};

/**
 * Prueft eine Config und sammelt alle Befunde, damit `validate` sie in einem Durchgang nennen kann.
 * @param given die Config wie in der Datei; das Fragment aus `extends` wird relativ zu `root` gelesen
 */
export const validateConfig = (given, root = process.cwd()) => {
    if (!isObject(given)) return { ok: false, issues: [t('config.notObject')], notes: [] };
    const issues = [];
    // Hinweise, die nichts verhindern: alte Namen, die noch gelten, und Einstellungen, die so nichts bewirken.
    const notes = [];
    for (const [key, text] of Object.entries(RENAMED)) if (given[key] !== undefined) issues.push(t(text));
    for (const key of Object.keys(given)) if (!TOP_FIELDS.includes(key) && RENAMED[key] === undefined) issues.push(t('config.unknownField', { key, hint: hintFor(key, TOP_FIELDS) }));
    if (given.language !== undefined && !['de', 'en'].includes(given.language)) issues.push(t('config.language', { value: String(JSON.stringify(given.language)) }));
    const { config, issues: loaded } = effectiveConfig(given, root);
    issues.push(...loaded);
    if (config.extends !== undefined && given.extends === undefined) issues.push(t('config.extendsOnlyProject'));

    checkEnvironments(config, issues, notes);
    checkAuth(config, issues);
    checkRoles(config, issues);
    if (!isObject(config.apps) || Object.keys(config.apps).length === 0) issues.push(t('config.apps.missing'));
    if (config.messageSelectors !== undefined && !(Array.isArray(config.messageSelectors) && config.messageSelectors.every((selector) => typeof selector === 'string' && selector !== ''))) {
        issues.push(t('config.messageSelectors'));
    }
    if (config.insecureTls !== undefined && typeof config.insecureTls !== 'boolean') issues.push(t('config.insecureTls'));
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
        // Meist steht dort eine ganze Adresse: Dann den Host daraus nennen.
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
    // `localBuild` kommt ohne Muster aus: Dann ist der Name der Pfad der URL unterhalb der Umgebung.
    const withEntries = Object.entries(isObject(config.apps) ? config.apps : {}).filter(([, app]) => namedEntries(app).length > 0).map(([name]) => name);
    if (config.assetUrlPattern === undefined && withEntries.length > 0) {
        issues.push(t('config.assetUrlPattern.missing', { apps: withEntries.join(', ') }));
    }
    for (const [name, app] of Object.entries(isObject(config.apps) ? config.apps : {})) {
        if (!isObject(app)) {
            issues.push(t('config.app.notObject', { name }));
            continue;
        }
        if (typeof app.dir !== 'string' || app.dir === '' || /^([\\/]|[A-Za-z]:)/.test(app.dir) || app.dir.split(/[\\/]/).includes('..')) {
            issues.push(t('config.app.dir', { name }));
        }
        // Ohne startUrl: Die App wird nur unterwegs erreicht, etwa ueber eine Aufgabe.
        if (app.startUrl !== undefined && (typeof app.startUrl !== 'string' || !app.startUrl.startsWith('/'))) issues.push(t('config.app.startUrl', { name }));
        for (const key of ['redirects', 'constants', 'statics']) {
            if (app[key] !== undefined && !Array.isArray(app[key])) issues.push(t('config.app.list', { name, key }));
            else (app[key] ?? []).forEach((entry, index) => {
                if (entryOk(key, entry)) return;
                const problems = entryProblems(key, entry);
                issues.push(problems.length === 0
                    ? t('config.app.entry', { name, key, index, fields: ENTRY_FIELDS[key] })
                    : t('config.app.entryProblems', { name, key, index, problems: problems.join('; '), fields: ENTRY_FIELDS[key] }));
            });
        }
        if (app.localBuild !== undefined && (typeof app.localBuild !== 'string' || app.localBuild === '' || /^([\\/]|[A-Za-z]:)/.test(app.localBuild) || app.localBuild.split(/[\\/]/).includes('..'))) {
            issues.push(t('config.app.localBuild', { name }));
        }
    }
    if (issues.length === 0) notes.push(...localCodeNotes(config));
    return { ok: issues.length === 0, issues, notes };
};

/**
 * Lokaler Code wirkt nur, wenn Umgebung und App zusammenpassen: localCode an der Umgebung, localBuild (oder Eintraege) an der App.
 * Fehlt eine Seite, bewirkt die andere nichts, still.
 */
const localCodeNotes = (config) => {
    const apps = Object.keys(config.apps ?? {});
    const withCode = apps.filter((name) => hasLocalCode(config, [name]));
    const environments = environmentsWith(config, 'localCode');
    const notes = [];
    if (withCode.length === 0) for (const name of environments) notes.push(t('config.note.localCodeNoApp', { name }));
    if (environments.length === 0) {
        for (const name of apps.filter((app) => hasLocalBuild(config.apps[app]))) notes.push(t('config.note.localBuildNoEnv', { name }));
    }
    return notes;
};

/** Die Config wie loadConfig, dazu die Hinweise der Pruefung (alte Namen, Einstellungen ohne Wirkung). */
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
    return { config: effectiveConfig(config, root).config, notes };
};

export const loadConfig = (root) => loadConfigWithNotes(root).config;

// Ein Pfad im Projekt: relativ, ohne `..`. Wie `dir` und `localBuild`.
const relativePath = (value) => typeof value === 'string' && value !== '' && !/^([\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes('..');
const ENTRY_FIELDS = { statics: 'name, path', constants: 'name, watchPath', redirects: 'name, target | app: true' };
const ENTRY_KEYS = { statics: ['name', 'path'], constants: ['name', 'watchPath'], redirects: ['name', 'target', 'app'] };
/** Was an einem Eintrag fehlt und was dort nichts zu suchen hat, mit Vorschlag; leer, wenn es kein Objekt ist. */
const entryProblems = (key, entry) => {
    if (!isObject(entry)) return [];
    const allowed = ENTRY_KEYS[key];
    const unknown = Object.keys(entry).filter((field) => !allowed.includes(field))
        .map((field) => t('config.app.entryUnknown', { field, hint: hintFor(field, allowed) }));
    const required = key === 'redirects' ? ['name', ...(entry.app === true ? [] : ['target'])] : allowed;
    const missing = required.filter((field) => entry[field] === undefined || entry[field] === '').map((field) => t('config.app.entryMissing', { field }));
    return [...missing, ...unknown];
};
/** Ein Eintrag aus `statics`, `constants` oder `redirects`: sonst scheiterte erst der Lauf mit einem TypeError. */
const entryOk = (key, entry) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '') return false;
    if (key === 'statics') return relativePath(entry.path);
    if (key === 'constants') return relativePath(entry.watchPath);
    return entry.app === true || (typeof entry.target === 'string' && entry.target !== '');
};
const namedEntries = (app) => [...(app?.redirects ?? []), ...(app?.constants ?? []), ...(app?.statics ?? [])];
const hasLocalBuild = (app) => typeof app?.localBuild === 'string' && app.localBuild !== '';

/**
 * Gibt es fuer diese Apps lokalen Code zum Einspielen? Ein Build-Ordner (`localBuild`) reicht allein; einzelne Eintraege
 * (`statics`, `redirects`, `constants`) brauchen dazu `assetUrlPattern`.
 */
export const hasLocalCode = (config, appNames) => appNames.some((name) => hasLocalBuild(config.apps?.[name])
    || (typeof config.assetUrlPattern === 'string' && namedEntries(config.apps?.[name]).length > 0));

/** Woher der lokale Code einer App kommt, fuer Meldungen: der Build-Ordner, sonst die Arten der Eintraege (statics, redirects, …). */
export const localCodeOf = (config, name) => {
    const app = config.apps?.[name];
    if (hasLocalBuild(app)) return { localBuild: app.localBuild };
    if (typeof config.assetUrlPattern !== 'string') return null;
    const kinds = ['statics', 'redirects', 'constants'].filter((key) => (app?.[key] ?? []).length > 0);
    return kinds.length === 0 ? null : { kinds };
};

/** Ohne `assetUrlPattern`: der Pfad unterhalb der Umgebungs-URL, etwa `assets/index-X.js` aus `https://host/app/assets/index-X.js`. */
const defaultAssetPattern = (url) => {
    // Wie Chrome die Adresse eines Requests schreibt: Host klein, ohne Standardport. Sonst passte das Muster nie, still.
    const parsed = new URL(String(url));
    const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
    return `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^?#]+)`;
};

/** Wie ein Ziel geschrieben wird: `umgebung`, mit Mandanten `mandant/umgebung`. */
export const targetForm = (config) => (config.sites === undefined ? t('config.targetForm.plain') : t('config.targetForm.sites'));

/** Alle Ziele, die die Config kennt, fuer Meldungen und `init`. */
export const allTargets = (config) => Object.entries(environmentDefs(config))
    .flatMap(([name, entry]) => Object.keys(entry.urls).map((site) => (site === '' ? name : `${site}/${name}`)));

/** Loest ein Ziel auf: die Umgebung, mit Mandanten auch der Mandant, samt Adresse und Faehigkeiten. */
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
    const { urls, ...abilities } = defs[environment];
    return { target: text, ...(withSites ? { site } : {}), environment, url, ...abilities };
};

/**
 * Was Chrome erreichen darf: die Adressen der Umgebungen und projekteigene Ausnahmen, etwa ein Anmeldedienst.
 * Produktion nie, ausser der Lauf zielt selbst darauf: Sonst erreichte ein Lauf auf dev ueber goto, eval oder einen Link die
 * Produktion, womoeglich mit geteilter Anmeldung.
 * @param target das aufgeloeste Ziel des Laufs (resolveTarget); ohne Ziel nur Umgebungen ohne production
 */
export const browserHosts = (config, target) => {
    const hosts = Object.values(environmentDefs(config)).filter(({ production }) => !production)
        .flatMap(({ urls }) => Object.values(urls).map((url) => new URL(url).hostname));
    const own = target?.url === undefined ? [] : [new URL(target.url).hostname];
    const production = new Set(Object.values(environmentDefs(config)).filter(({ production: isProduction }) => isProduction)
        .flatMap(({ urls }) => Object.values(urls).map((url) => new URL(url).hostname)));
    // Eine Ausnahme darf keine Produktion wieder freischalten.
    const extra = (config.extraAllowedHosts ?? []).filter((host) => target?.production === true || !production.has(host));
    return [...new Set([...own, ...hosts, ...extra])];
};

/** Stabile, eindeutige UUID-Form je Eintrag; devlink verlangt Identitaeten, sie tragen aber keine Bedeutung. */
const uuidOf = (seed) => {
    const h = createHash('sha256').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Baut aus Projekt-Config und Ziel die Config, die der devlink-Host erwartet. */
export const buildDevlinkConfig = (config, resolved, appName, source, projectRoot) => {
    const app = config.apps[appName];
    const replace = source === 'watch';
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
            redirects: replace ? (app.redirects ?? []).map((entry) => ({
                uuid: uuidOf(`redirect:${entry.name}`),
                name: entry.name,
                app: entry.app === true,
                target: entry.app === true ? null : entry.target,
                active: true,
            })) : [],
            constants: replace ? (app.constants ?? []).map((entry) => ({
                uuid: uuidOf(`constant:${entry.name}`),
                name: entry.name,
                watchPath: entry.watchPath,
                active: true,
            })) : [],
            statics: replace ? (app.statics ?? []).map((entry) => ({
                uuid: uuidOf(`static:${entry.name}`),
                name: entry.name,
                localPath: posix.join(projectRoot, entry.path),
                active: true,
            })) : [],
            builds: replace && hasLocalBuild(app) ? [{
                uuid: uuidOf(`build:${app.localBuild}`),
                localDir: posix.join(projectRoot, app.localBuild),
                projectDir: posix.join(projectRoot, app.dir ?? '.'),
                // Der Name ist der Pfad unterhalb der Umgebung; ein globales assetUrlPattern (etwa fuer Sencha-statics) gilt zusaetzlich.
                urlPattern: defaultAssetPattern(resolved.url),
                active: true,
            }] : [],
        }],
    };
};
