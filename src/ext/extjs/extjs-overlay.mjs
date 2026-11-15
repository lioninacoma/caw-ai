// Local code of an ExtJS app from the Sencha watch, without config: what the page loads under the build name of the app or a
// package comes from the sources listed in bootstrap.json. Both come from the watch's own web server (overlay.url, default
// http://localhost:1841/): that proves the watch of this app runs, not just any watch. bootstrap.json on disk is only read for
// doctor's offline line.
//
// Build names as Sencha Cmd builds them (checked against Cmd 7.5, ant/build/app/defaults.properties and ant/build/package/defaults.properties):
// - App: output.js.path (or output.js as a string) in app.json, also in the stages production, testing, development; otherwise
//   app.output.js.path or app.output.js from .sencha/app/*.properties; otherwise app.js. caw does not know which stage is deployed,
//   so every one of these names counts. They come from the project config on disk.
// - Package: <name>.js and <name>-debug.js, name from package.json (as in bootstrap.packages).
// Only the last path segment of the request is compared: the folder before it is where the portal repository keeps it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CawError } from '../../shared/errors.mjs';
import { t } from '../../shared/i18n.mjs';

const BOOTSTRAP = 'bootstrap.json';
const STAGES = ['production', 'testing', 'development'];
const APP_SOURCE = /^app\//;
// Ext JS itself and its packages (charts, ux, themes): never from local code, otherwise the framework would come from node_modules.
const FRAMEWORK_SOURCE = /(^|\/)(ext|node_modules\/@sencha)\//;
const PROBE_MS = 2_000;
const FETCH_MS = 30_000;
// Requests to the watch's server at a time: enough to be quick, few enough for its small Jetty.
const PARALLEL = 8;

/** JSON with comments and trailing commas before } or ], as Sencha writes it. Comment markers inside strings are kept. */
export const parseSenchaJson = (text) => {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '"') {
            const start = i;
            for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
            out += text.slice(start, i + 1);
        } else if (char === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i += 1;
            out += '\n';
        } else if (char === '/' && text[i + 1] === '*') {
            i = text.indexOf('*/', i + 2);
            if (i < 0) break;
            i += 1;
        } else {
            out += char;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
};

const readJson = (file) => {
    try {
        return parseSenchaJson(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

/** key=value from Ant properties, ignoring comments; continuation lines are not supported. */
const readProperties = (file) => {
    const values = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
        if (match !== null && !/^\s*[#!]/.test(line)) values[match[1]] = match[2];
    }
    return values;
};

const jsPathOf = (output) => {
    const js = output?.js;
    if (typeof js === 'string') return js;
    return typeof js?.path === 'string' ? js.path : undefined;
};

/** The file name of a build path; a placeholder before it (${build.id}/x.js) is fine, one in the name is not. */
const fileName = (path) => {
    const name = basename(path.replaceAll('\\', '/'));
    return name === '' || name.includes('${') ? null : name;
};

/** The app's name from app.json on disk: what the watch's app.json must say. */
export const appNameOf = (appDir) => readJson(join(appDir, 'app.json'))?.name ?? basename(appDir);

/** The names under which a build of the app may be deployed. */
export const appBuildNames = (appDir) => {
    const appJson = readJson(join(appDir, 'app.json')) ?? {};
    const names = new Set();
    const fromJson = [jsPathOf(appJson.output), ...STAGES.map((stage) => jsPathOf(appJson[stage]?.output))].filter((path) => path !== undefined);
    const propertiesDir = join(appDir, '.sencha', 'app');
    const properties = {};
    if (existsSync(propertiesDir)) {
        for (const file of readdirSync(propertiesDir).filter((name) => name.endsWith('.properties')).sort()) {
            Object.assign(properties, readProperties(join(propertiesDir, file)));
        }
    }
    const expand = (value, depth = 0) => (depth > 5 ? value : value.replace(/\$\{([\w.-]+)\}/g, (all, key) => {
        if (key === 'app.name' && typeof appJson.name === 'string') return appJson.name;
        return properties[key] === undefined ? all : expand(properties[key], depth + 1);
    }));
    const fromProperties = ['app.output.js.path', 'app.output.js'].filter((key) => properties[key] !== undefined).map((key) => expand(properties[key]));
    // A setting in app.json takes precedence over the properties; it does not change what a stage sets in the properties.
    for (const path of fromJson.length > 0 ? fromJson : fromProperties) {
        const name = fileName(path);
        if (name !== null) names.add(name);
    }
    if (names.size === 0) names.add('app.js');
    return names;
};

const usable = (bootstrap) => Array.isArray(bootstrap?.loadOrder) && bootstrap.loadOrder.length > 0;

/** bootstrap.json as the watch last wrote it into the app folder. Errors are messages with the command to start the watch. */
const readBootstrap = (appDir, hint) => {
    const file = join(appDir, BOOTSTRAP);
    if (!existsSync(file)) throw new CawError('overlay-not-ready', t('session.appFiles.missing', { file, hint }));
    let bootstrap;
    try {
        bootstrap = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new CawError('overlay-not-ready', t('session.appFiles.unreadable', { file, hint }));
    }
    if (!usable(bootstrap)) throw new CawError('overlay-not-ready', t('session.appFiles.empty', { file, hint }));
    return bootstrap;
};

/** The message for a stale bootstrap.json: it names sources that are not there. */
const staleText = (appDir, missing, hint) => t('session.appFiles.stale', { bootstrap: BOOTSTRAP, app: basename(appDir), count: missing.length, examples: missing.slice(0, 3).join(', '), hint });

/** Does bootstrap.json on disk match the files? Only for doctor's line without network; runs ask the watch's server. */
export const checkAppFiles = (appDir, hint = t('session.appFiles.hint')) => {
    const bootstrap = readBootstrap(appDir, hint);
    const missing = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path !== 'string' || !existsSync(join(appDir, path)));
    if (missing.length > 0) throw new CawError('overlay-stale', staleText(appDir, missing, hint));
    return bootstrap;
};

// ---- Over HTTP: the watch's web server ----------------------------------------------------------------------------------------

const get = (url, fetchImpl, ms = FETCH_MS) => fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(ms) });

/** Runs fn over the items, at most PARALLEL at a time; results in order. */
const inBatches = async (items, fn) => {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
    return results;
};

/** bootstrap.json from the watch's server. Errors: overlay-not-ready (no answer) or overlay-stale (missing, unreadable, empty). */
export const fetchBootstrap = async (base, fetchImpl = fetch, hint = t('session.appFiles.hint')) => {
    const url = new URL(BOOTSTRAP, base).href;
    let response;
    try {
        response = await get(url, fetchImpl);
    } catch {
        throw new CawError('overlay-not-ready', t('session.overlay.serverDown', { url: base, next: hint }));
    }
    if (response.status !== 200) throw new CawError('overlay-stale', t('session.appFiles.missing', { file: url, hint }));
    let bootstrap;
    try {
        bootstrap = JSON.parse(await response.text());
    } catch {
        throw new CawError('overlay-stale', t('session.appFiles.unreadable', { file: url, hint }));
    }
    if (!usable(bootstrap)) throw new CawError('overlay-stale', t('session.appFiles.empty', { file: url, hint }));
    return bootstrap;
};

/**
 * Is the server at base the watch of this app? Its app.json must name the app (another project's watch on the same port does
 * not count), its bootstrap.json must list sources.
 * @returns { state: 'ready', bootstrap } | { state: 'down' } | { state: 'wrong-app' | 'stale', message }
 */
export const identifyWatch = async (base, appDir, fetchImpl = fetch, hint = t('session.appFiles.hint')) => {
    const label = t('session.overlay.senchaWatch');
    const app = appNameOf(appDir);
    let response;
    try {
        response = await get(new URL('app.json', base).href, fetchImpl, PROBE_MS);
    } catch {
        return { state: 'down' };
    }
    let served;
    try {
        served = response.status === 200 ? parseSenchaJson(await response.text())?.name : undefined;
    } catch {
        served = undefined;
    }
    if (typeof served !== 'string') return { state: 'wrong-app', message: t('session.overlay.notWatch', { url: base, label, app }) };
    if (served !== app) return { state: 'wrong-app', message: t('session.overlay.otherApp', { url: base, label, served, app }) };
    try {
        return { state: 'ready', bootstrap: await fetchBootstrap(base, fetchImpl, hint) };
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        return { state: error.code === 'overlay-not-ready' ? 'down' : 'stale', message: error.message };
    }
};

/**
 * The own sources of bootstrap.json (app and packages, not Ext JS) the server does not deliver: then bootstrap.json is stale.
 * @returns null if all are there, otherwise the message
 */
export const staleSources = async (base, appDir, bootstrap, fetchImpl = fetch, hint = t('session.appFiles.hint')) => {
    const paths = [...new Set(bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path === 'string' && !FRAMEWORK_SOURCE.test(path)))];
    const found = await inBatches(paths, async (path) => {
        try {
            const response = await get(new URL(path, base).href, fetchImpl);
            await response.body?.cancel?.();
            return response.status === 200;
        } catch {
            return false;
        }
    });
    const missing = paths.filter((path, index) => !found[index]);
    return missing.length === 0 ? null : staleText(appDir, missing, hint);
};

/** The text of one source from the server; a 404 means bootstrap.json names a file the watch no longer has. */
const fetchSource = async (base, path, fetchImpl, hint) => {
    const url = new URL(path, base).href;
    let response;
    try {
        response = await get(url, fetchImpl);
    } catch {
        throw new CawError('overlay-not-ready', t('session.overlay.serverDown', { url: base, next: hint }));
    }
    if (response.status !== 200) throw new CawError('overlay-stale', t('session.overlay.sourceMissing', { url, status: response.status, hint }));
    return response.text();
};

/** The packages from bootstrap.json with their sources, excluding the framework's. */
const ownPackages = (bootstrap) => {
    const packages = new Map();
    const loaded = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path === 'string');
    for (const [name, entry] of Object.entries(bootstrap.packages ?? {})) {
        let paths = (Array.isArray(entry?.files) ? entry.files : []).map((index) => bootstrap.loadOrder[index]?.path).filter((path) => typeof path === 'string');
        // Newer Sencha Cmd (7.x) lists no files per package: then its sources are the ones below its namespace's path, e.g.
        // paths.Orders = "packages/local/orders-model/src".
        if (paths.length === 0 && typeof entry?.namespace === 'string' && typeof bootstrap.paths?.[entry.namespace] === 'string') {
            const dir = `${bootstrap.paths[entry.namespace].replace(/\/+$/, '')}/`;
            paths = loaded.filter((path) => path.startsWith(dir));
        }
        if (paths.length === 0 || paths.some((path) => FRAMEWORK_SOURCE.test(path))) continue;
        packages.set(name, paths);
    }
    // A theme package's build carries the JS of the themes it extends (aekwl-theme-material -> theme-material -> theme-neptune ->
    // theme-base): replacing it with its own files only would drop e.g. Material's Panel override (flat buttons on the right).
    // The SDK themes have no files in bootstrap.json; their sources are the loadOrder entries below <theme>/src or <theme>/overrides.
    for (const [name, paths] of packages) {
        const inherited = themeAncestors(bootstrap, name).filter((parent) => !packages.has(parent));
        if (inherited.length === 0) continue;
        const below = new RegExp(`(^|/)(${inherited.map(escapeRegex).join('|')})/(src|overrides)/`);
        const own = new Set(paths);
        packages.set(name, loaded.filter((path) => own.has(path) || below.test(path)));
    }
    return packages;
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The packages a package extends, nearest first (bootstrap.packages[name].extend, a name or a comma list). */
const themeAncestors = (bootstrap, name, seen = new Set([name])) => {
    const extend = bootstrap.packages?.[name]?.extend;
    const parents = (typeof extend === 'string' ? extend.split(',') : []).map((parent) => parent.trim()).filter((parent) => parent !== '' && !seen.has(parent));
    for (const parent of parents) seen.add(parent);
    return parents.flatMap((parent) => [parent, ...themeAncestors(bootstrap, parent, seen)]);
};

/** The app's own scripts outside app/ (app.json "js", e.g. app.js with Ext.application), without the framework's. */
const appScripts = (appDir) => {
    const listed = readJson(join(appDir, 'app.json'))?.js;
    const paths = (Array.isArray(listed) ? listed : []).map((entry) => (typeof entry === 'string' ? entry : entry?.path))
        .filter((path) => typeof path === 'string' && !path.includes('${') && !FRAMEWORK_SOURCE.test(path));
    return new Set(paths.length > 0 ? paths : ['app.js']);
};

/**
 * What can be replaced: build file name -> part (app or package) with its sources, in load order.
 * A name matching more than one part is an error: otherwise caw might replace the wrong one.
 */
export const replaceable = (appDir, bootstrap) => {
    const parts = new Map();
    const add = (file, part) => {
        const known = parts.get(file);
        if (known !== undefined && known.label !== part.label) throw new CawError('overlay-ambiguous', t('session.overlay.ambiguousName', { file, first: known.label, second: part.label }));
        parts.set(file, part);
    };
    // The app's classes under app/ and its own scripts such as app.js, which calls Ext.application: without it the app never starts.
    const scripts = appScripts(appDir);
    const appPaths = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path === 'string' && (APP_SOURCE.test(path) || scripts.has(path)));
    const appName = appNameOf(appDir);
    if (appPaths.length > 0) for (const file of appBuildNames(appDir)) add(file, { label: appName, kind: 'app', paths: appPaths });
    for (const [name, paths] of ownPackages(bootstrap)) {
        for (const file of [`${name}.js`, `${name}-debug.js`]) add(file, { label: name, kind: 'package', paths });
    }
    return parts;
};

/**
 * What the overlay is expected to replace, one entry per part: an app or package with all its build names (x.js and x-debug.js
 * are one part). The completeness check compares the page's script requests against these names.
 * @param bootstrap from the watch's server; without it bootstrap.json from disk
 * @returns [{ label, kind, names }]
 */
export const expectedParts = (appDir, bootstrap = checkAppFiles(appDir)) => {
    const parts = new Map();
    for (const [file, part] of replaceable(appDir, bootstrap)) {
        if (!parts.has(part.label)) parts.set(part.label, { label: part.label, kind: part.kind, names: [] });
        parts.get(part.label).names.push(file);
    }
    return [...parts.values()];
};

/**
 * The overlay source over HTTP: resolve(name) returns the content for a name from assetUrlPattern, or null. bootstrap.json is
 * fetched once per page load (refresh() on every document request), since the watch rewrites it when classes are added; the
 * sources are fetched fresh for every request, resolved against base (../ included).
 * @param base the watch's address, e.g. http://localhost:1841/
 */
export const createWatchSource = (base, appDir, fetchImpl = fetch, hint = t('session.appFiles.hint')) => {
    const used = new Map();
    let pending = null;
    let last = null;
    const load = () => {
        pending ??= fetchBootstrap(base, fetchImpl, hint).then((bootstrap) => {
            last = bootstrap;
            return bootstrap;
        });
        return pending;
    };
    return {
        load,
        refresh: () => { pending = null; },
        /** @returns { body, label, kind } | null */
        resolve: async (name) => {
            const file = basename(name);
            const part = replaceable(appDir, await load()).get(file);
            if (part === undefined) return null;
            // Two requests from different folders with the same name (two apps with app.js): replace neither.
            const first = used.get(file);
            if (first !== undefined && first !== name) throw new CawError('overlay-ambiguous', t('session.overlay.ambiguousPath', { file, first, second: name }));
            used.set(file, name);
            const texts = await inBatches(part.paths, (path) => fetchSource(base, path, fetchImpl, hint));
            return { body: texts.map((text) => `${text}\n`).join(''), label: part.label, kind: part.kind };
        },
        /** What this run replaced, for the line in the report. */
        replaced: () => [...used.keys()],
        /** What the watch should replace, per the last bootstrap.json; empty before the first load. */
        expected: () => (last === null ? [] : expectedParts(appDir, last)),
    };
};
