// Lokaler Code einer ExtJS-App aus dem Sencha-Watch, ohne Config: Was die Seite unter dem Build-Namen der App oder eines Pakets laedt,
// kommt aus den Quellen, die bootstrap.json nennt. Der Watch schreibt bootstrap.json in den App-Ordner; gelesen wird von der Platte.
//
// Build-Namen, wie Sencha Cmd baut (geprueft an Cmd 7.5, ant/build/app/defaults.properties und ant/build/package/defaults.properties):
// - App: output.js.path (oder output.js als Text) in app.json, auch in den Stages production, testing, development; sonst
//   app.output.js.path bzw. app.output.js aus .sencha/app/*.properties; sonst app.js. Welche Stage ausgeliefert ist, weiss caw nicht,
//   darum zaehlt jeder dieser Namen.
// - Paket: <name>.js und <name>-debug.js, name aus package.json (so steht es in bootstrap.packages).
// Verglichen wird der letzte Pfadteil des Requests: Der Ordner davor ist der Ablageort im Repository des Portals.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { CawError } from '../../shared/errors.mjs';
import { t } from '../../shared/i18n.mjs';

const BOOTSTRAP = 'bootstrap.json';
const STAGES = ['production', 'testing', 'development'];
const APP_SOURCE = /^app\//;
// Ext JS selbst und seine Pakete (charts, ux, Themes): nie von der Platte, sonst kaeme das Framework aus node_modules.
const FRAMEWORK_SOURCE = /(^|\/)(ext|node_modules\/@sencha)\//;

/** JSON mit Kommentaren und Kommas vor } oder ], wie Sencha es schreibt. Kommentare in Texten bleiben. */
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

/** key=value aus Ant-Properties, ohne Kommentare und Fortsetzungszeilen. */
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

/** Der Dateiname eines Build-Pfads; ein Platzhalter davor (${build.id}/x.js) stoert nicht, einer im Namen schon. */
const fileName = (path) => {
    const name = basename(path.replaceAll('\\', '/'));
    return name === '' || name.includes('${') ? null : name;
};

/** Die Namen, unter denen ein Build der App ausgeliefert sein kann. */
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
    // Eine Vorgabe aus app.json gilt vor den Properties; sie aendert aber nicht, was eine Stage in den Properties setzt.
    for (const path of fromJson.length > 0 ? fromJson : fromProperties) {
        const name = fileName(path);
        if (name !== null) names.add(name);
    }
    if (names.size === 0) names.add('app.js');
    return names;
};

/** bootstrap.json, wie der Watch es gerade geschrieben hat. Fehler sind Meldungen mit dem Befehl zum Starten. */
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
 * Passt bootstrap.json zu den Dateien? Ob der Watch laeuft, prueft der Aufrufer am Prozess; der haeufigste Schaden eines veralteten
 * Stands faellt hier auf statt mitten im Test.
 */
export const checkAppFiles = (appDir, hint = t('session.appFiles.hint')) => {
    const bootstrap = readBootstrap(appDir, hint);
    const missing = bootstrap.loadOrder.map((entry) => entry?.path).filter((path) => typeof path !== 'string' || !existsSync(join(appDir, path)));
    if (missing.length > 0) {
        throw new CawError('watch-stale', t('session.appFiles.stale', { bootstrap: BOOTSTRAP, app: basename(appDir), count: missing.length, examples: missing.slice(0, 3).join(', '), hint }));
    }
    return bootstrap;
};

/** Die Pakete aus bootstrap.json mit ihren Quellen, ohne die des Frameworks. */
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
 * Was ersetzt werden kann: Dateiname des Builds -> Teil (App oder Paket) mit seinen Quellen, in Ladereihenfolge.
 * Ein Name, der zu mehr als einem Teil passt, ist ein Fehler: Sonst ersetzte caw womoeglich den falschen.
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
 * Die Quelle fuer das Overlay: resolve(name) liefert den Inhalt fuer einen Namen aus assetUrlPattern oder null. bootstrap.json wird je
 * Request neu gelesen, denn der Watch schreibt es bei neuen Klassen neu.
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
            // Zwei Requests aus verschiedenen Ordnern mit demselben Namen (zwei Apps mit app.js): keinen ersetzen.
            const first = used.get(file);
            if (first !== undefined && first !== name) throw new CawError('overlay-ambiguous', t('session.overlay.ambiguousPath', { file, first, second: name }));
            used.set(file, name);
            const body = part.paths.map((path) => `${readFileSync(join(appDir, path), 'utf8')}\n`).join('');
            return { body, label: part.label, kind: part.kind };
        },
        /** Was dieser Lauf ersetzt hat, fuer die Zeile im Bericht. */
        replaced: () => [...used.keys()],
    };
};
