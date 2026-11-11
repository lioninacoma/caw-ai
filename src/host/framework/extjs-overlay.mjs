// Local code of an ExtJS app from the Sencha watch, without config: what the page loads under the build name of the app or a
// package comes from the sources listed in bootstrap.json. The watch writes bootstrap.json into the app folder; it is read from disk.
//
// Build names as Sencha Cmd builds them (checked against Cmd 7.5, ant/build/app/defaults.properties and ant/build/package/defaults.properties):
// - App: output.js.path (or output.js as a string) in app.json, also in the stages production, testing, development; otherwise
//   app.output.js.path or app.output.js from .sencha/app/*.properties; otherwise app.js. caw does not know which stage is deployed,
//   so every one of these names counts.
// - Package: <name>.js and <name>-debug.js, name from package.json (as in bootstrap.packages).
// Only the last path segment of the request is compared: the folder before it is where the portal repository keeps it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CawError } from '../../shared/errors.mjs';
import { t } from '../../shared/i18n.mjs';

const BOOTSTRAP = 'bootstrap.json';
const STAGES = ['production', 'testing', 'development'];
const APP_SOURCE = /^app\//;
// Ext JS itself and its packages (charts, ux, themes): never from disk, otherwise the framework would come from node_modules.
const FRAMEWORK_SOURCE = /(^|\/)(ext|node_modules\/@sencha)\//;

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

/** bootstrap.json as the watch last wrote it. Errors are messages with the command to start the watch. */
const readBootstrap = (appDir, hint) => {
    const file = join(appDir, BOOTSTRAP);
    if (!existsSync(file)) throw new CawError('watch-missing', t('session.appFiles.missing', { file, hint }));
    let bootstrap;
    try {
        bootstrap = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        throw new CawError('watch-missing', t('session.appFiles.unreadable', { file, hint }));
    }
    if (!Array.isArray(bootstrap?.loadOrder) || bootstrap.loadOrder.length === 0) throw new CawError('watch-missing', t('session.appFiles.empty', { file, hint }));
    return bootstrap;
};

/**
 * Does bootstrap.json match the files? The caller checks the watch process itself; the most common damage of a stale state
 * shows up here instead of in the middle of a test.
 */
export const checkAppFiles = (appDir, hint = t('session.appFiles.hint')) => {
    const bootstrap = readBootstrap(appDir, hint);
    const missing = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path !== 'string' || !existsSync(join(appDir, path)));
    if (missing.length > 0) {
        throw new CawError('watch-stale', t('session.appFiles.stale', { bootstrap: BOOTSTRAP, app: basename(appDir), count: missing.length, examples: missing.slice(0, 3).join(', '), hint }));
    }
    return bootstrap;
};

/** The packages from bootstrap.json with their sources, excluding the framework's. */
const ownPackages = (bootstrap) => {
    const packages = new Map();
    for (const [name, entry] of Object.entries(bootstrap.packages ?? {})) {
        const paths = (Array.isArray(entry?.files) ? entry.files : []).map((index) => bootstrap.loadOrder[index]?.path).filter((path) => typeof path === 'string');
        if (paths.length === 0 || paths.some((path) => FRAMEWORK_SOURCE.test(path))) continue;
        packages.set(name, paths);
    }
    return packages;
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
    const appPaths = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path === 'string' && APP_SOURCE.test(path));
    const appName = readJson(join(appDir, 'app.json'))?.name ?? basename(appDir);
    if (appPaths.length > 0) for (const file of appBuildNames(appDir)) add(file, { label: appName, kind: 'app', paths: appPaths });
    for (const [name, paths] of ownPackages(bootstrap)) {
        for (const file of [`${name}.js`, `${name}-debug.js`]) add(file, { label: name, kind: 'package', paths });
    }
    return parts;
};

/**
 * What the overlay is expected to replace, one entry per part: an app or package with all its build names (x.js and x-debug.js
 * are one part). The completeness check compares the page's script requests against these names.
 * @returns [{ label, kind, names }]
 */
export const expectedParts = (appDir) => {
    const parts = new Map();
    for (const [file, part] of replaceable(appDir, checkAppFiles(appDir))) {
        if (!parts.has(part.label)) parts.set(part.label, { label: part.label, kind: part.kind, names: [] });
        parts.get(part.label).names.push(file);
    }
    return [...parts.values()];
};

/**
 * The overlay source: resolve(name) returns the content for a name from assetUrlPattern, or null. bootstrap.json is reread per
 * request, since the watch rewrites it when classes are added.
 */
export const createWatchSource = (appDir) => {
    const used = new Map();
    return {
        /** @returns { body, label, kind } | null */
        resolve: (name) => {
            const file = basename(name);
            const bootstrap = checkAppFiles(appDir);
            const part = replaceable(appDir, bootstrap).get(file);
            if (part === undefined) return null;
            // Two requests from different folders with the same name (two apps with app.js): replace neither.
            const first = used.get(file);
            if (first !== undefined && first !== name) throw new CawError('overlay-ambiguous', t('session.overlay.ambiguousPath', { file, first, second: name }));
            used.set(file, name);
            const body = part.paths.map((path) => `${readFileSync(join(appDir, path), 'utf8')}\n`).join('');
            return { body, label: part.label, kind: part.kind };
        },
        /** What this run replaced, for the line in the report. */
        replaced: () => [...used.keys()],
    };
};
