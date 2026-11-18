#!/usr/bin/env node
// One-off migration of a caw-ai project from the pre-1.0 shape to the 1.0 core model (spec §8). Internal: not in the npm package.
//
//   node scripts/migrate-config.mjs <project folder> [--dry-run]
//
// 1. caw.config.json per §8.1: an `extends` fragment merged in; `sites` × `environments` become `<site>-<env>` environments,
//    the first site concrete, the others `extends` it with their own url; `auth` → `signIn`; `apps` → `start` and overlay parts;
//    roles become empty objects; the other renamed keys.
// 2. caw/tests/*.yaml: `app` → `start`, `targets` → `environments`, `mutates` → `writes`, `also` dropped.
// 3. caw/recordings/*.yaml: `recordedOn` mapped, wait-ready `store` → `for`.
// 4. caw/.env: variable names renamed to CAW_<ROLE>_USER / _PASSWORD / _TOTP. Values are moved, never printed.
// 5. caw/.auth/<site>/<env>/<role>.json → caw/.auth/<site>-<env>/<role>.json.
// 6. .claude/skills/caw-ai/ removed. 7. .mcp.json key caw-ai → caw.
// Afterwards: `caw validate` and a dry run of every test on a writable environment (8., by hand).
// Every file is read whole and written whole; --dry-run only reports what would change.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMap, isScalar, parseDocument, visit } from 'yaml';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const variablePart = (name) => String(name).toUpperCase().replaceAll('-', '_');

/** The old `extends` fragment merged in (environments by name, project fields winning), as the old loader did. */
export const withFragment = (config, root) => {
    if (config.extends === undefined) return config;
    const path = isAbsolute(config.extends) ? config.extends : join(root, config.extends);
    const fragment = JSON.parse(readFileSync(path, 'utf8'));
    const environments = { ...(fragment.environments ?? {}) };
    for (const [name, entry] of Object.entries(config.environments ?? {})) environments[name] = { ...(environments[name] ?? {}), ...(entry ?? {}) };
    const merged = { ...fragment, ...config, ...(Object.keys(environments).length === 0 ? {} : { environments }) };
    delete merged.extends;
    return merged;
};

/**
 * The environment names, old → new: with sites `<site>/<env>` → `<site>-<env>` (and a bare `<env>` → every site's), without
 * sites unchanged.
 * @returns { map: Map old target → [new names], first: new name of the first site per env }
 */
export const targetMap = (config) => {
    const map = new Map();
    const sites = Array.isArray(config.sites) ? config.sites : [];
    for (const env of Object.keys(config.environments ?? {})) {
        if (sites.length === 0) {
            map.set(env, [env]);
            continue;
        }
        const names = sites.filter((site) => config.environments[env]?.urls?.[site] !== undefined).map((site) => `${site}-${env}`);
        for (const site of sites) if (config.environments[env]?.urls?.[site] !== undefined) map.set(`${site}/${env}`, [`${site}-${env}`]);
        map.set(env, names);
    }
    return map;
};

/** caw.config.json per §8.1. @returns { config, notes } */
export const migrateConfig = (old) => {
    const notes = [];
    const sites = Array.isArray(old.sites) ? old.sites : [];
    const apps = isObject(old.apps) ? old.apps : {};
    const appNames = Object.keys(apps);
    const out = {};
    const keep = (key) => { if (old[key] !== undefined) out[key] = old[key]; };
    keep('language');
    keep('framework');
    // The first app's start page is the project's; other apps' start pages move to their tests (`start`).
    const firstStart = appNames.length > 0 ? apps[appNames[0]]?.startUrl : undefined;
    if (typeof firstStart === 'string' && firstStart !== '/') out.start = firstStart;
    if (isObject(old.agent)) {
        out.agent = Object.fromEntries(Object.entries(old.agent).map(([key, value]) => [key === 'sandbox' ? 'mode' : key, value]));
    }
    if (isObject(old.auth)) {
        const signIn = { ...old.auth, ...(old.auth.type === 'storageState' ? { type: 'session' } : {}) };
        if (signIn.type !== 'none') out.signIn = signIn;
    }
    if (isObject(old.roles) && out.signIn !== undefined) out.roles = Object.fromEntries(Object.keys(old.roles).map((name) => [name, {}]));
    if (isObject(old.roles) && out.signIn === undefined) notes.push('roles dropped: nothing signs in');
    for (const key of ['messageSelectors', 'requestKeys', 'consoleIgnore', 'foreignCode', 'readyIgnore', 'readyTimeoutMs', 'effects', 'lintCommand', 'sandboxImage', 'sandboxUser', 'browser']) keep(key);
    if (old.maxSteps !== undefined) out.maxActions = old.maxSteps;
    keep('maxActions');
    if (Array.isArray(old.extraAllowedHosts) && old.extraAllowedHosts.length > 0) {
        out.allowHosts = old.extraAllowedHosts;
        notes.push('extraAllowedHosts → top-level allowHosts; move hosts onto the environments whose sign-in goes there if only some need them');
    }
    keep('allowHosts');

    // Environments: tenants become environments; the first site concrete, the others extend it (production stated again).
    const environments = {};
    const overlayEnvs = [];
    for (const [env, raw] of Object.entries(old.environments ?? {})) {
        const entry = raw ?? {};
        const flags = Object.fromEntries(['claude', 'writable', 'production'].filter((flag) => entry[flag] === true).map((flag) => [flag, true]));
        if (old.insecureTls === true && entry.production !== true) flags.insecureTls = true;
        const own = Object.fromEntries(['allowHosts', 'insecureTls', 'allowHttp'].filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
        if (sites.length === 0) {
            environments[env] = { url: entry.url, ...flags, ...own };
            if (entry.overlay === true) overlayEnvs.push(env);
            continue;
        }
        const present = sites.filter((site) => entry.urls?.[site] !== undefined);
        present.forEach((site, index) => {
            const name = `${site}-${env}`;
            environments[name] = index === 0 ? { url: entry.urls[site], ...flags, ...own }
                : { extends: `${present[0]}-${env}`, url: entry.urls[site], ...(entry.production === true ? { production: true } : {}) };
            if (entry.overlay === true) overlayEnvs.push(name);
        });
    }
    out.environments = environments;

    // Overlay: apps with an overlay block become parts; the top-level assetUrlPattern moves into the overlay block.
    const parts = {};
    for (const [name, app] of Object.entries(apps)) {
        if (!isObject(app?.overlay)) continue;
        parts[name] = { dir: app.dir ?? '.', ...app.overlay };
    }
    if (Object.keys(parts).length > 0 || overlayEnvs.length > 0) {
        out.overlay = {
            environments: overlayEnvs,
            ...(old.assetUrlPattern === undefined ? {} : { assetUrlPattern: old.assetUrlPattern }),
            parts,
        };
        if (Object.keys(parts).length === 0) notes.push('overlay.parts is empty: add the parts (dir, url or build) before using --overlay');
    } else if (old.assetUrlPattern !== undefined) notes.push('assetUrlPattern dropped: no overlay');
    if (old.extends !== undefined) notes.push('extends (file fragment) merged in');
    return { config: out, notes };
};

/** One test plan's fields per §8.2, on the YAML document (comments stay). @returns true if changed */
export const migrateTestDoc = (doc, { apps = {}, start, targets }) => {
    let changed = false;
    const app = doc.get('app');
    if (app !== undefined) {
        const startUrl = apps[app]?.startUrl;
        doc.delete('app');
        if (typeof startUrl === 'string' && startUrl !== (start ?? '/')) doc.set('start', startUrl);
        changed = true;
    }
    if (doc.has('also')) {
        doc.delete('also');
        changed = true;
    }
    if (doc.has('mutates')) {
        doc.set('writes', doc.get('mutates'));
        doc.delete('mutates');
        changed = true;
    }
    if (doc.has('targets')) {
        const old = doc.get('targets')?.toJSON?.() ?? doc.get('targets');
        const mapped = [...new Set((Array.isArray(old) ? old : [old]).flatMap((target) => targets.get(String(target)) ?? [String(target)]))];
        doc.delete('targets');
        const node = doc.createNode(mapped);
        node.flow = true;
        doc.set('environments', node);
        changed = true;
    }
    return changed;
};

/** One recording file per §8.2: `recordedOn` mapped (a site/env pair to its environment), wait-ready `store` → `for`. */
export const migrateRecordingDoc = (doc, { targets }) => {
    let changed = false;
    visit(doc, {
        Pair(_, pair) {
            if (!isScalar(pair.key)) return undefined;
            if (pair.key.value === 'recordedOn' && isScalar(pair.value)) {
                const mapped = targets.get(String(pair.value.value));
                if (mapped !== undefined && mapped.length === 1 && mapped[0] !== pair.value.value) {
                    pair.value.value = mapped[0];
                    changed = true;
                }
            }
            if (pair.key.value === 'wait-ready' && isMap(pair.value)) {
                const store = pair.value.items.find((item) => isScalar(item.key) && item.key.value === 'store');
                if (store !== undefined) {
                    store.key.value = 'for';
                    changed = true;
                }
            }
            return undefined;
        },
    });
    return changed;
};

/** caw/.env names old → new for each role (its custom loginEnv/passwordEnv/totpEnv, else the old init names). */
export const envRenames = (oldRoles = {}) => {
    const renames = {};
    for (const [role, entry] of Object.entries(oldRoles)) {
        const base = `CAW_${variablePart(role)}`;
        renames[entry?.loginEnv ?? `CAW_LOGIN_${variablePart(role)}`] = `${base}_USER`;
        renames[entry?.passwordEnv ?? `CAW_PW_${variablePart(role)}`] = `${base}_PASSWORD`;
        if (entry?.totpEnv !== undefined) renames[entry.totpEnv] = `${base}_TOTP`;
    }
    return renames;
};

/** The .env text with renamed variable names; values and every other line untouched. @returns { text, renamed: [old → new] } */
export const renameEnvText = (text, renames) => {
    const renamed = [];
    const lines = text.split(/(\r?\n)/).map((part) => {
        const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/.exec(part);
        if (match === null || renames[match[2]] === undefined) return part;
        renamed.push(`${match[2]} → ${renames[match[2]]}`);
        return `${match[1]}${renames[match[2]]}${part.slice(match[1].length + match[2].length)}`;
    });
    return { text: lines.join(''), renamed };
};

const yamlFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => join(dir, name)) : []);

/** The whole project. @returns the report lines */
export const migrateProject = (root, { dryRun = false } = {}) => {
    const report = [];
    const write = (path, text) => { if (!dryRun) writeFileSync(path, text); };
    const configPath = join(root, 'caw.config.json');
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const old = withFragment(raw, root);
    const { config, notes } = migrateConfig(old);
    write(configPath, `${JSON.stringify(config, null, 4)}\n`);
    report.push(`caw.config.json: environments ${Object.keys(config.environments).join(', ')}`, ...notes.map((note) => `  note: ${note}`));
    const targets = targetMap(old);
    const apps = isObject(old.apps) ? old.apps : {};
    for (const file of yamlFiles(join(root, 'caw', 'tests'))) {
        const doc = parseDocument(readFileSync(file, 'utf8'));
        if (migrateTestDoc(doc, { apps, start: config.start, targets })) {
            write(file, doc.toString());
            report.push(`test ${file.slice(root.length + 1)}`);
        }
    }
    for (const file of yamlFiles(join(root, 'caw', 'recordings'))) {
        const doc = parseDocument(readFileSync(file, 'utf8'));
        if (migrateRecordingDoc(doc, { targets })) {
            write(file, doc.toString());
            report.push(`recording ${file.slice(root.length + 1)}`);
        }
    }
    const envFile = join(root, 'caw', '.env');
    if (existsSync(envFile)) {
        const { text, renamed } = renameEnvText(readFileSync(envFile, 'utf8'), envRenames(old.roles));
        if (renamed.length > 0) {
            write(envFile, text);
            report.push(`caw/.env: ${renamed.join(', ')}`);
        }
    }
    const authDir = join(root, 'caw', '.auth');
    for (const site of Array.isArray(old.sites) ? old.sites : []) {
        const siteDir = join(authDir, site);
        if (!existsSync(siteDir)) continue;
        for (const env of readdirSync(siteDir)) {
            const from = join(siteDir, env);
            const to = join(authDir, `${site}-${env}`);
            if (!dryRun) {
                mkdirSync(dirname(to), { recursive: true });
                renameSync(from, to);
            }
            report.push(`caw/.auth/${site}/${env} → caw/.auth/${site}-${env}`);
        }
        if (!dryRun) rmSync(siteDir, { recursive: true, force: true });
    }
    const skill = join(root, '.claude', 'skills', 'caw-ai');
    if (existsSync(skill)) {
        if (!dryRun) rmSync(skill, { recursive: true, force: true });
        report.push('.claude/skills/caw-ai removed');
    }
    const mcpFile = join(root, '.mcp.json');
    if (existsSync(mcpFile)) {
        const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
        if (mcp.mcpServers?.['caw-ai'] !== undefined && mcp.mcpServers.caw === undefined) {
            mcp.mcpServers = Object.fromEntries(Object.entries(mcp.mcpServers).map(([key, value]) => [key === 'caw-ai' ? 'caw' : key, value]));
            write(mcpFile, `${JSON.stringify(mcp, null, 2)}\n`);
            report.push('.mcp.json: caw-ai → caw');
        }
    }
    report.push('Next: caw validate, then a dry run of every test on a writable environment.');
    return report;
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    const [folder, ...flags] = process.argv.slice(2);
    if (folder === undefined) {
        console.error('Usage: node scripts/migrate-config.mjs <project folder> [--dry-run]');
        process.exit(3);
    }
    for (const line of migrateProject(folder, { dryRun: flags.includes('--dry-run') })) console.log(line);
}
