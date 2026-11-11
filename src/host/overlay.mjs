// The overlay: local code on top of a deployed environment, only with --overlay. Page, API, cookies and login stay with the
// environment; code requests are answered by the app's chosen source:
// - build: a build folder (exact name or same name except for the hash)
// - dev:   a dev server (Vite, webpack, Angular), plus its HMR WebSocket
// - watch: the Sencha watch's web server (ExtJS), sources per its bootstrap.json; the details live in the ExtJS adapter
// - files: only overlay.statics
// overlay.statics take precedence for every source. Project copies (public/env.js) always come from the server: the environment sets them.
//
// Before the browser starts, prepareOverlay checks that the source is ready: the server at overlay.url answers (for ExtJS: it is
// the watch of this app), the build is there and current. caw starts nothing on its own: if the source is not ready the run ends
// with exit 2 and the project's start command (overlay.start). Only with --start caw runs that command itself and stops it at the
// end (CI). The source never switches silently; a Sencha watch found on another port is used and named.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { assetPatterns, defaultAssetPattern } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RUN_DIR } from '../shared/names.mjs';
import { ago, newestFile } from './code-source.mjs';
import { frameworkOf } from './framework/index.mjs';
import { buildCheck, contentTypeOf, localPages, moduleAlias, resolveLocalBuild, scriptKind, servesBuild, withoutIntegrity } from './local-build.mjs';
import { baseOf, codeTags, ssrMarker, swapPage } from './page-swap.mjs';
import { listeningPorts, matchingPids } from './processes.mjs';
import { isProjectCopy, isProjectCopyFile } from './project-files.mjs';
import { staticFile } from './static-files.mjs';

const DEV_START_MS = 60_000;
const WATCH_START_MS = 180_000;
const POLL_MS = 500;
const PROBE_MS = 2_000;
const LOG_TAIL = 15;

// The name a request carries: the first group of a pattern, repeated slashes collapsed, without leading slash.
const compiled = new Map();
export const deriveName = (url, pattern) => {
    if (typeof pattern !== 'string' || pattern === '') return null;
    if (!compiled.has(pattern)) compiled.set(pattern, new RegExp(pattern));
    const match = compiled.get(pattern).exec(url);
    if (match === null) return null;
    const name = (match[1] ?? '').replace(/\/{2,}/g, '/').replace(/^\//, '');
    return name === '' ? null : name;
};

const decoded = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

/** The last segment of a path-like value, without query or fragment. */
const lastSegment = (value) => value.replace(/[?#].*$/, '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';

/** The raw query parameters of a URL, in order, as [name, raw value]: the pattern must match the URL as Chrome writes it. */
const rawParams = (url) => url.search.replace(/^\?/, '').split('&').filter(Boolean).map((pair) => {
    const index = pair.indexOf('=');
    return index < 0 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)];
});

/**
 * The script names a request may carry, independent of any pattern: the last path segment and the last segment of every `.js`
 * value in the query (`/proxy?url=repo:///Root/dir/x.js` -> proxy, x.js). Only for the diagnosis, never for serving.
 */
export const scriptNames = (url) => {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return [];
    }
    const names = new Set();
    const own = lastSegment(decoded(parsed.pathname));
    if (own !== '') names.add(own);
    for (const [, value] of rawParams(parsed)) {
        const name = lastSegment(decoded(value));
        if (/\.js$/i.test(name)) names.add(name);
    }
    return [...names];
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = (name) => posix.basename(name);

/** The longest common prefix of strings (by character) or arrays (by element). */
const commonPrefix = (values) => values.reduce((prefix, value) => {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) index += 1;
    return prefix.slice(0, index);
});

/**
 * Patterns for the asset sources the current patterns miss. Groups the missed URLs by source (origin + path, or origin + path +
 * query parameter) and proposes one pattern per group:
 * - name in a query parameter p after a common value prefix V: [?&]p=V(?:[^&#]*\/)?([^/&#]+\.js)(?:[&#]|$)
 * - name as the last path segment below a common folder D:       ^D/(?:[^?#]*\/)?([^/?#]+\.js)
 * A candidate counts only if it yields an expected name for every URL of its group (as the watch source resolves: last segment)
 * and changes nothing for URLs that are already local. Groups without such a candidate come back as unresolved.
 * @param urls     the missed URLs (from the server, carrying an expected name)
 * @param expected the expected names (x.js, x-debug.js, …)
 * @param current  { patterns, local }: the patterns in use (with the default) and the URLs served locally
 * @returns { suggestions: [{ source, pattern, urls }], unresolved: [{ source, urls }] }
 */
export const suggestAssetPatterns = ({ urls, expected, current = {} }) => {
    const names = new Set(expected);
    const patterns = current.patterns ?? [];
    const groups = new Map();
    const unresolved = [];
    const add = (key, entry, url) => {
        if (!groups.has(key)) groups.set(key, { ...entry, urls: [], values: [] });
        groups.get(key).urls.push(url);
        return groups.get(key);
    };
    for (const url of new Set(urls)) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            unresolved.push({ source: url, urls: [url] });
            continue;
        }
        if (names.has(lastSegment(decoded(parsed.pathname)))) {
            add(`path ${parsed.origin}`, { kind: 'path', origin: parsed.origin }, url).values.push(posix.dirname(parsed.pathname));
            continue;
        }
        const param = rawParams(parsed).find(([, value]) => names.has(lastSegment(decoded(value))));
        if (param === undefined) {
            unresolved.push({ source: `${parsed.origin}${parsed.pathname}`, urls: [url] });
            continue;
        }
        add(`query ${parsed.origin}${parsed.pathname} ${param[0]}`, { kind: 'query', origin: parsed.origin, path: parsed.pathname, param: param[0] }, url).values.push(param[1]);
    }
    // The name a URL resolves to: the first name from the patterns that is expected, as the watch source tries them in order.
    const firstExpected = (url, list) => list.map((pattern) => deriveName(url, pattern)).find((name) => name !== null && names.has(baseName(name))) ?? null;
    const suggestions = [];
    for (const group of groups.values()) {
        let source;
        let pattern;
        if (group.kind === 'path') {
            const dir = commonPrefix(group.values.map((path) => path.replace(/\/+$/, '').split('/'))).join('/');
            source = `${group.origin}${dir}/`;
            pattern = `^${escapeRegExp(`${group.origin}${dir}`)}/(?:[^?#]*/)?([^/?#]+\\.js)`;
        } else {
            const prefix = commonPrefix(group.values);
            const value = prefix.slice(0, prefix.lastIndexOf('/') + 1);
            source = `${group.origin}${group.path}?${group.param}=${value}`;
            pattern = `[?&]${escapeRegExp(group.param)}=${escapeRegExp(value)}(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)`;
        }
        const covers = group.urls.every((url) => {
            const name = deriveName(url, pattern);
            return name !== null && names.has(baseName(name));
        });
        const keepsLocal = (current.local ?? []).every((url) => firstExpected(url, patterns) === firstExpected(url, [...patterns, pattern]));
        if (!covers || !keepsLocal) {
            unresolved.push({ source, urls: group.urls });
            continue;
        }
        const same = suggestions.find((entry) => entry.pattern === pattern);
        if (same === undefined) suggestions.push({ source, pattern, urls: group.urls });
        else same.urls.push(...group.urls);
    }
    return { suggestions, unresolved };
};

/** The message for a mixed state: which parts came from the server, up to five URLs, and the pattern(s) that would fix it. */
export const incompleteText = ({ missed, suggestions, unresolved }) => {
    const parts = [...new Set(missed.map(({ part }) => part))];
    const urls = missed.slice(0, 5).map(({ url }) => `  ${url}`).join('\n');
    const next = suggestions.length > 0
        ? t('session.overlay.suggestion', { patterns: suggestions.map(({ source, pattern }) => `  ${source}: ${JSON.stringify(pattern)}`).join('\n') })
        : t('session.overlay.noSuggestion');
    return t('session.overlay.incomplete', { parts: parts.join(', '), count: missed.length, urls, next, unresolved: unresolved.length });
};

const tail = (file) => {
    try {
        return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL).join('\n');
    } catch {
        return '';
    }
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const waitFor = async (check, timeoutMs, { exited = () => false } = {}) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await check()) return true;
        if (exited()) return false;
        await sleep(POLL_MS);
    }
    return check();
};

/** Runs a config command in the app folder in the background, output to log. stop() ends it with its children (npm -> vite). */
export const startCommand = (command, cwd, log, spawnImpl = spawn) => {
    mkdirSync(join(log, '..'), { recursive: true });
    const out = openSync(log, 'w');
    let child;
    try {
        child = spawnImpl(command, { cwd, shell: true, stdio: ['ignore', out, out], windowsHide: true, detached: process.platform !== 'win32' });
    } finally {
        closeSync(out);
    }
    let exited = false;
    // If caw ends without cleanup (process.exit, crash), no dev server is left running.
    const stop = () => {
        process.removeListener('exit', stop);
        if (exited || child.pid === undefined) return;
        try {
            if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else process.kill(-child.pid, 'SIGTERM');
        } catch {
            // already gone
        }
    };
    process.once('exit', stop);
    child.on?.('exit', () => { exited = true; process.removeListener('exit', stop); });
    child.on?.('error', () => { exited = true; process.removeListener('exit', stop); });
    return { exited: () => exited, stop };
};

/** Does a server answer at the address? Any HTTP response counts, even 404: then it is running. */
export const probeServer = async (url, fetchImpl = fetch) => {
    try {
        await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
        return true;
    } catch {
        return false;
    }
};

const logFile = (root, app, what) => join(root, RUN_DIR, `${app}-${what}.log`);

// ---- Sources ------------------------------------------------------------------------------------------------------------------

/** Is the build older than the last change below the app folder? @returns null or { file, ago } */
export const staleBuild = (buildDir, appDir, root, now = Date.now()) => {
    const built = newestFile(buildDir, { skipNames: new Set(['node_modules']) });
    if (built === null) return null;
    const changed = newestFile(appDir, { skip: [buildDir, join(root, 'caw')] });
    if (changed === null || changed.mtimeMs <= built.mtimeMs) return null;
    return { file: relative(appDir, changed.path).replaceAll('\\', '/'), ago: ago(now - changed.mtimeMs) };
};

/** What to do when a source is not ready: start overlay.start, or name it first. */
const startHint = (choice, name, appDir, root) => (choice.start === undefined
    ? t('session.overlay.startUnknown', { app: name })
    : t('session.overlay.startKnown', { start: choice.start, dir: relative(root, appDir).replaceAll('\\', '/') || '.' }));

const buildSource = ({ root, name, appDir, choice, info }) => {
    const dir = join(root, choice.dir);
    const shown = choice.dir.replaceAll('\\', '/').replace(/\/+$/, '');
    const problem = () => {
        const checked = buildCheck(dir);
        if (!checked.ok) return checked.hint === undefined ? t('session.overlay.buildMissing', { dir: shown }) : t('session.overlay.buildBelow', { dir: shown, path: `${shown}/${checked.hint}` });
        const stale = staleBuild(dir, appDir, root);
        return stale === null ? null : t('session.overlay.buildStale', { dir: shown, file: stale.file, ago: stale.ago });
    };
    return {
        kind: 'build',
        label: shown,
        ready: async () => {
            const before = problem();
            if (before === null) return;
            if (choice.command === undefined) {
                const hint = choice.start === undefined ? t('session.overlay.buildHintUnknown', { problem: before, app: name }) : t('session.overlay.buildHint', { problem: before, start: choice.start });
                throw new CawError('overlay-not-ready', hint);
            }
            info(t('session.overlay.building', { problem: before, command: choice.command }));
            const log = logFile(root, name, 'build');
            const result = spawnSync(choice.command, { cwd: appDir, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
            mkdirSync(join(log, '..'), { recursive: true });
            writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`);
            if (result.status !== 0) throw new CawError('overlay-not-ready', t('session.overlay.buildFailed', { command: choice.command, log, tail: tail(log) }));
            const after = problem();
            if (after !== null) throw new CawError('overlay-not-ready', t('session.overlay.buildStillBad', { command: choice.command, problem: after }));
        },
        resolve: async ({ type, names }) => {
            for (const requested of names) {
                if (!servesBuild(type, requested)) continue;
                const found = resolveLocalBuild(dir, requested);
                if (found === null) continue;
                // An unchanged copy from the project (public/env.js) is set by the environment: it comes from the server.
                if (found.alias === undefined && isProjectCopyFile(appDir, found.file, { skip: [dir] })) continue;
                const raw = readFileSync(found.file);
                // Under the deployed name of an ES module only a re-export of the local one, otherwise it would run twice.
                const body = found.alias === undefined ? raw : moduleAlias(found.alias, raw.toString('utf8'), scriptKind(dir, found.alias)) ?? raw;
                return { contentType: found.contentType, body, file: found.file };
            }
            return null;
        },
        page: ({ base, deployed, namesOf }) => buildPage({ dir, appDir, base, deployed, namesOf }),
    };
};

/** The local file a request for url would get (like resolve: via the names from the pattern). */
const routedFile = (dir, namesOf, url) => {
    for (const name of namesOf(url)) {
        const found = resolveLocalBuild(dir, name);
        if (found !== null) return found.file;
    }
    return undefined;
};

/** The local file for a URL; for foreign origins (CDN) and paths outside the pattern via the path. */
const builtFile = (dir, namesOf, url) => {
    const routed = routedFile(dir, namesOf, url);
    if (routed !== undefined) return routed;
    try {
        return resolveLocalBuild(dir, decodeURIComponent(new URL(url).pathname).replace(/^\//, ''))?.file;
    } catch {
        return undefined;
    }
};

const urlDir = (url) => posix.dirname(new URL(url).pathname);

/**
 * What gets swapped for a build. The local page is the one with the most hits among the deployed tags (a build may have several
 * pages). A deployed tag belongs to the app if the build knows its file and it is no project copy, or if it lies in the asset
 * folder of the local page; an inline script if it names that folder (webpack runtime with publicPath).
 * @returns { owned, local } | { issue } | null (no matching page: no swap, requests are answered one by one)
 */
const buildPage = ({ dir, appDir, base, deployed, namesOf }) => {
    const served = new Map();
    const fileOf = (url) => {
        if (!served.has(url)) served.set(url, builtFile(dir, namesOf, url));
        return served.get(url);
    };
    const copies = new Map();
    const copy = (file) => {
        if (!copies.has(file)) copies.set(file, isProjectCopyFile(appDir, file, { skip: [dir] }));
        return copies.get(file);
    };
    let best = null;
    for (const { text } of localPages(dir)) {
        const tags = codeTags(text, base);
        const files = new Set(tags.flatMap(({ urls }) => urls.map(fileOf)).filter((file) => file !== undefined && !copy(file)));
        const hits = deployed.filter(({ urls }) => urls.some((url) => files.has(fileOf(url)))).length;
        if (hits > 0 && (best === null || hits > best.hits)) best = { tags, hits };
    }
    if (best === null) return null;
    // If a local tag points to a file the build does not have at that address (base path differs from the environment), the
    // swapped page would break: then do not swap.
    const loading = best.tags.filter(({ inline }) => !inline);
    if (loading.some(({ urls }) => urls.some((url) => routedFile(dir, namesOf, url) === undefined))) return { issue: 'local-base' };
    const local = best.tags.filter(({ inline, urls }) => inline || !urls.some((url) => copy(fileOf(url))));
    const dirs = new Set(loading.flatMap(({ urls }) => urls.map(urlDir)).filter((path) => path !== '/'));
    const owned = (tag) => {
        if (tag.inline) return [...dirs].some((path) => tag.tag.includes(`${path}/`));
        return tag.urls.some((url) => {
            const file = fileOf(url);
            return file === undefined ? dirs.has(urlDir(url)) : !copy(file);
        });
    };
    const kept = new Set(deployed.filter((tag) => !owned(tag)).flatMap(({ urls }) => urls));
    const keptInline = new Set(deployed.filter((tag) => tag.inline && !owned(tag)).map(({ tag }) => tag));
    return { owned, local: local.filter(({ inline, tag, urls }) => (inline ? !keptInline.has(tag) : !urls.some((url) => kept.has(url)))) };
};

// What counts as code for a dev server: scripts, styles, fonts, images; via fetch only code (Vite loads CSS as a module with ?import).
const DEV_TYPES = new Set(['script', 'stylesheet', 'font', 'image', 'media']);
const DEV_FETCHED = /\.(m?[jt]sx?|css|wasm|json)$|[?&](import|v=|t=)/;

const devSource = ({ root, name, appDir, choice, info, envUrl, fetchImpl = fetch }) => {
    const origin = new URL(choice.url).origin;
    let started = null;
    return {
        kind: 'dev',
        label: choice.url,
        origin,
        ready: async () => {
            if (await probeServer(choice.url, fetchImpl)) return;
            if (choice.command === undefined) throw new CawError('overlay-not-ready', t('session.overlay.serverDown', { url: choice.url, next: startHint(choice, name, appDir, root) }));
            const log = logFile(root, name, 'dev-server');
            info(t('session.overlay.devStarting', { url: choice.url, command: choice.command }));
            started = startCommand(choice.command, appDir, log);
            if (await waitFor(() => probeServer(choice.url, fetchImpl), DEV_START_MS, { exited: started.exited })) return;
            started.stop();
            started = null;
            throw new CawError('overlay-not-ready', t('session.overlay.devStartFailed', { url: choice.url, command: choice.command, seconds: DEV_START_MS / 1000, log, tail: tail(log) }));
        },
        stop: () => started?.stop(),
        resolve: async ({ url, type }) => {
            const request = new URL(url);
            const path = `${request.pathname}${request.search}`;
            const code = DEV_TYPES.has(type) || ((type === 'fetch' || type === 'xhr' || type === 'other') && DEV_FETCHED.test(path));
            if (!code) return null;
            let response;
            try {
                response = await fetchImpl(`${origin}${path}`, { redirect: 'manual' });
            } catch {
                return null;
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (response.status !== 200 || /text\/html/i.test(contentType)) return null;
            const body = Buffer.from(await response.arrayBuffer());
            if (isProjectCopy(appDir, body)) return null;
            return { contentType: contentType || contentTypeOf(request.pathname), body };
        },
        page: ({ url, base, deployed }) => devPage({ origin, appDir, envUrl, url, base, deployed, fetchImpl }),
    };
};

/**
 * What gets swapped for a dev server. The local page is its HTML at the same path (Vite, webpack, Angular serve it for every
 * route). A deployed tag belongs to the app if it lies below the environment URL, the dev page does not load it itself, and the
 * dev server does not serve a project copy under it (public/env.js is set by the environment).
 */
const devPage = async ({ origin, appDir, envUrl, url, base, deployed, fetchImpl }) => {
    const page = new URL(url);
    let text;
    try {
        const response = await fetchImpl(`${origin}${page.pathname}${page.search}`, { headers: { accept: 'text/html' }, redirect: 'follow' });
        if (response.status !== 200 || !/text\/html/i.test(response.headers.get('content-type') ?? '')) return null;
        // A byte string like the deployed page: insertion happens byte for byte.
        text = Buffer.from(await response.arrayBuffer()).toString('latin1');
    } catch {
        return null;
    }
    const local = codeTags(text, base);
    const localUrls = new Set(local.flatMap(({ urls }) => urls));
    const scope = new URL(envUrl);
    const scopePath = scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`;
    const inScope = (value) => {
        const parsed = new URL(value);
        return parsed.origin === page.origin && `${parsed.pathname}/`.startsWith(scopePath);
    };
    const candidates = [...new Set([...deployed.flatMap(({ urls }) => urls).filter(inScope), ...localUrls].filter((value) => new URL(value).origin === page.origin))];
    const copies = new Map(await Promise.all(candidates.map(async (value) => {
        const parsed = new URL(value);
        try {
            const response = await fetchImpl(`${origin}${parsed.pathname}${parsed.search}`, { redirect: 'manual' });
            if (response.status !== 200 || /text\/html/i.test(response.headers.get('content-type') ?? '')) return [value, false];
            return [value, isProjectCopy(appDir, Buffer.from(await response.arrayBuffer()))];
        } catch {
            return [value, false];
        }
    })));
    const owned = (tag) => !tag.inline && tag.urls.length > 0 && tag.urls.every((value) => inScope(value) && !localUrls.has(value) && copies.get(value) !== true);
    const deployedUrls = new Set(deployed.flatMap(({ urls }) => urls));
    const keptInline = new Set(deployed.filter(({ inline }) => inline).map(({ tag }) => tag));
    return {
        owned,
        local: local.filter(({ inline, tag, urls }) => (inline ? !keptInline.has(tag) : !urls.some((value) => deployedUrls.has(value) || copies.get(value) === true))),
    };
};

/**
 * Where else the server of this app runs, when it does not answer at url or another app's does: processes matching the adapter's
 * watch command, the ports they listen on, each asked with identify. Only for adapters with a watch (Sencha picks a random port
 * when 1841 is taken).
 * @returns the found address (url with that port) or null
 */
export const discoverServer = async ({ url, appDir, adapter, fetchImpl = fetch, pids = matchingPids, ports = listeningPorts }) => {
    if (adapter.watch?.command === undefined || adapter.overlay?.identify === undefined) return null;
    const found = pids(adapter.watch.command);
    if (found.length === 0) return null;
    const configured = new URL(url);
    for (const port of ports(found)) {
        const candidate = new URL(configured.href);
        candidate.hostname = 'localhost';
        candidate.port = String(port);
        if (candidate.href === configured.href) continue;
        if ((await adapter.overlay.identify(candidate.href, appDir, fetchImpl)).state === 'ready') return candidate.href;
    }
    return null;
};

/**
 * Is the local code server at url ready? Without an identify hook (dev servers) any HTTP answer counts. With one (ExtJS) it
 * must be the watch of this app with a usable bootstrap.json and all own sources; if not, discover looks for it on another port.
 * Never starts anything.
 * @returns { state: 'ready' | 'down' | 'wrong-app' | 'stale' | 'moved', url?, bootstrap?, message? }; url only with moved
 */
export const serverState = async ({ url, appDir, adapter, hint, fetchImpl = fetch, discover = discoverServer }) => {
    const identify = adapter.overlay?.identify;
    if (identify === undefined) return { state: (await probeServer(url, fetchImpl)) ? 'ready' : 'down' };
    const found = await identify(url, appDir, fetchImpl, hint);
    if (found.state === 'ready') {
        const stale = await adapter.overlay.stale?.(url, appDir, found.bootstrap, fetchImpl, hint) ?? null;
        return stale === null ? found : { state: 'stale', message: stale };
    }
    if (found.state === 'stale') return found;
    const moved = await discover({ url, appDir, adapter, fetchImpl });
    return moved === null ? found : { state: 'moved', url: moved };
};

const watchSource = ({ root, name, appDir, choice, config, info, fetchImpl = fetch, discover = discoverServer }) => {
    const adapter = frameworkOf(config);
    const { watch, overlay } = adapter;
    const hint = t('session.overlay.watchHint', { start: choice.start ?? watch.start });
    let base = choice.url;
    let source = overlay.createWatchSource(base, appDir, fetchImpl, hint);
    let started = null;
    const use = (url) => {
        base = url;
        source = overlay.createWatchSource(base, appDir, fetchImpl, hint);
    };
    const self = {
        kind: 'watch',
        label: t('session.overlay.watchAt', { label: watch.label(), url: base }),
        ready: async () => {
            const found = await serverState({ url: base, appDir, adapter, hint, fetchImpl, discover });
            if (found.state === 'moved') {
                info(t('session.overlay.moved', { label: watch.label(), url: base, found: found.url, app: name }));
                use(found.url);
                self.label = t('session.overlay.watchAt', { label: watch.label(), url: base });
            }
            if (found.state === 'ready' || found.state === 'moved') {
                await source.load();
                return;
            }
            if (found.state === 'stale') throw new CawError('overlay-stale', found.message);
            if (found.state === 'wrong-app' || choice.command === undefined) {
                throw new CawError('overlay-not-ready', found.message ?? t('session.overlay.serverDown', { url: base, next: startHint(choice, name, appDir, root) }));
            }
            const log = logFile(root, name, 'watch');
            info(t('session.overlay.watchStarting', { label: watch.label(), url: base, command: choice.command }));
            started = startCommand(choice.command, appDir, log);
            // We started the watch ourselves: it is ready once its server serves this app with all sources.
            const ok = async () => (await serverState({ url: base, appDir, adapter, hint, fetchImpl, discover: async () => null })).state === 'ready';
            if (await waitFor(ok, WATCH_START_MS, { exited: started.exited })) {
                await source.load();
                return;
            }
            started.stop();
            started = null;
            throw new CawError('overlay-not-ready', t('session.overlay.watchStartFailed', { label: watch.label(), url: base, command: choice.command, seconds: WATCH_START_MS / 1000, log, tail: tail(log) }));
        },
        stop: () => started?.stop(),
        // A new page load: the watch may have rewritten bootstrap.json since.
        document: () => source.refresh(),
        resolve: async ({ type, names }) => {
            if (type === 'document') return null;
            for (const requested of names) {
                const found = await source.resolve(requested);
                if (found !== null) return { contentType: 'application/javascript', body: found.body };
            }
            return null;
        },
        replaced: () => source.replaced(),
        // What the watch should replace, for the completeness check; empty if the adapter does not say.
        expected: () => source.expected?.() ?? [],
    };
    return self;
};

const filesOnly = () => ({ kind: 'files', label: 'statics', ready: async () => {}, resolve: async () => null });

const SOURCES = { build: buildSource, dev: devSource, watch: watchSource, files: filesOnly };

/**
 * overlay.statics: fixed names, file relative to the app folder, read fresh from disk on every load. The path may leave the app
 * folder (a neighbouring package), but not the workspace (static-files.mjs); `check` resolves and checks every file before the browser.
 */
const staticsOf = (root, appDir, statics) => {
    const byName = new Map();
    return {
        entries: statics,
        check: () => {
            for (const { name, path } of statics) {
                const found = staticFile(root, appDir, path);
                if (found.state === 'outside') throw new CawError('config-invalid', t('session.overlay.staticOutside', { path, boundary: found.boundary }));
                if (found.state === 'secret') throw new CawError('config-invalid', t('session.overlay.staticSecret', { path }));
                if (found.state === 'missing') throw new CawError('overlay-not-ready', t('session.overlay.staticMissing', { file: found.file }));
                byName.set(name, found.file);
            }
        },
        resolve: ({ type, names }) => {
            if (type === 'document') return null;
            for (const requested of names) {
                const file = byName.get(requested);
                if (file !== undefined) return { contentType: contentTypeOf(file), body: readFileSync(file), file };
            }
            return null;
        },
    };
};


/**
 * Per overlay.statics entry what the page got: local (served from the file), deployed (a script with that name came from the
 * server: the asset pattern does not yield the name) or not-loaded.
 */
const staticsServed = (apps, served) => apps.flatMap((app) => app.statics.entries.map(({ name, path }) => {
    const named = (url) => app.namesOf(url).includes(name);
    if ([...served.local.keys()].some(named)) return { app: app.name, name, path, status: 'local' };
    const fromServer = [...served.server.keys()].some((url) => named(url) || decoded(url).split(/[?&#=]/).some((part) => part.endsWith(`/${name}`)));
    return { app: app.name, name, path, status: fromServer ? 'deployed' : 'not-loaded' };
}));

const namesWith = (patterns) => (url) => [...new Set(patterns.map((pattern) => deriveName(url, pattern)).filter((name) => name !== null))];

/** The expected parts of every app whose source names them; a source that breaks meanwhile (bootstrap.json) names none. */
const expectedOf = (apps) => apps.flatMap(({ source }) => {
    try {
        return source.expected?.() ?? [];
    } catch {
        return [];
    }
});

/** Per expected part: local, deployed or not loaded; the missed server URLs and patterns for them. See diagnose. */
const completeness = ({ apps, served, patterns }) => {
    const expected = expectedOf(apps);
    const partOf = new Map(expected.flatMap((part) => part.names.map((name) => [name, part])));
    const hits = (url) => scriptNames(url).filter((name) => partOf.has(name));
    const missed = [...served.server.entries()].filter(([, type]) => type === 'script').flatMap(([url]) => {
        const [name] = hits(url);
        return name === undefined ? [] : [{ url, name, part: partOf.get(name).label }];
    });
    const local = new Set([...served.local.keys()].flatMap(hits).map((name) => partOf.get(name).label));
    for (const name of apps.flatMap(({ source }) => source.replaced?.() ?? [])) if (partOf.has(name)) local.add(partOf.get(name).label);
    const deployed = new Set(missed.map(({ part }) => part));
    const parts = expected.map(({ label, kind, names }) => ({ label, kind, names, status: deployed.has(label) ? 'deployed' : local.has(label) ? 'local' : 'not-loaded' }));
    const { suggestions, unresolved } = missed.length === 0
        ? { suggestions: [], unresolved: [] }
        : suggestAssetPatterns({ urls: missed.map(({ url }) => url), expected: [...partOf.keys()], current: { patterns, local: [...served.local.keys()] } });
    return { parts, missed, notLoaded: parts.filter(({ status }) => status === 'not-loaded').map(({ label }) => label), suggestions, unresolved };
};

/**
 * Checks and starts the sources of all overlay apps of the run (checked.apps from checkTest), before the browser.
 * @returns { apps: [{ name, kind, label, source, statics }], resolve, fileFor, devServers, stop }
 */
export const prepareOverlay = async ({ root, config, checked, info = () => {}, deps = {} }) => {
    const apps = [];
    const stopAll = () => { for (const { source } of apps) source.stop?.(); };
    try {
        for (const [name, choice] of Object.entries(checked.apps ?? {})) {
            const appDir = join(root, config.apps[name].dir);
            const source = SOURCES[choice.kind]({ root, name, appDir, choice, config, info, envUrl: checked.url, ...deps });
            // The default pattern, the top-level list, then the app's own: the first name a source can resolve wins.
            const patterns = [defaultAssetPattern(checked.url), ...assetPatterns(config, name)];
            apps.push({ name, kind: choice.kind, label: source.label, source, patterns, namesOf: namesWith(patterns), statics: staticsOf(root, appDir, choice.statics ?? []) });
            await source.ready();
            // The label may name another address now (a watch found on another port).
            apps.at(-1).label = source.label;
            apps.at(-1).statics.check();
        }
    } catch (error) {
        stopAll();
        throw error;
    }
    const allPatterns = [...new Set(apps.flatMap(({ patterns }) => patterns))];
    const pages = [];
    // Per URL, whether a script or stylesheet came from local code or from the server (filled in by routeOverlay).
    const served = { local: new Map(), server: new Map() };
    return {
        apps,
        /**
         * Every HTML page of the application (byte string, see rewriteBytes): the app's code tags swapped for those of the local
         * page, then without integrity. Without a matching local page it stays as is; resolve then answers requests one by one.
         * An SSR page is never swapped. What happened is recorded in pages (for the diagnosis).
         */
        rewritePage: async (html, { url }) => {
            const ssr = ssrMarker(html);
            const seen = { url, ssr, swaps: [] };
            let out = html;
            if (ssr === null) {
                for (const app of apps) {
                    if (app.source.page === undefined) continue;
                    const base = baseOf(out, url);
                    const deployed = codeTags(out, base);
                    const plan = await app.source.page({ url, base, deployed, namesOf: app.namesOf });
                    if (plan === null || plan.issue !== undefined || !deployed.some(plan.owned)) {
                        seen.swaps.push({ app: app.name, skipped: plan?.issue ?? 'no-match' });
                        continue;
                    }
                    const swapped = swapPage(out, { base, owned: plan.owned, local: plan.local });
                    out = swapped.html;
                    seen.swaps.push({ app: app.name, removed: swapped.removed, inserted: swapped.inserted });
                }
            }
            pages.push(seen);
            if (pages.length > 50) pages.shift();
            return withoutIntegrity(out);
        },
        pages,
        /** The response from local code for a request, or null for the server. The test's app comes first. */
        resolve: async (url, type) => {
            if (type === 'document') {
                for (const app of apps) app.source.document?.();
                return null;
            }
            for (const app of apps) {
                const request = { url, type, names: app.namesOf(url) };
                const found = app.statics.resolve(request) ?? await app.source.resolve(request);
                if (found !== null) return { ...found, app: app.name };
            }
            return null;
        },
        /** The local file behind a URL (build, statics), for source maps; otherwise undefined. */
        fileFor: (url) => {
            for (const app of apps) {
                const request = { url, type: undefined, names: app.namesOf(url) };
                const found = app.statics.resolve(request);
                if (found !== null) return found.file;
                if (app.kind !== 'build') continue;
                for (const requested of request.names) {
                    const file = resolveLocalBuild(join(root, checked.apps[app.name].dir), requested)?.file;
                    if (file !== undefined) return file;
                }
            }
            return undefined;
        },
        devServers: apps.filter(({ kind }) => kind === 'dev').map(({ source }) => source.origin),
        served,
        /**
         * What ran after loading, for the diagnosis: never silently test the deployed state.
         * With an adapter that names the expected parts (ExtJS), also per part whether it came local, deployed or not at all:
         * missed are script URLs from the server that carry an expected name (found pattern-independently via scriptNames), with
         * suggestions for patterns that would catch them.
         * @returns { ssr, local, server, swapped, localBase, mixed: [urls], label, parts, missed, notLoaded, suggestions, unresolved }
         */
        diagnose: () => {
            const folder = (url) => {
                const parsed = new URL(url);
                return { key: `${parsed.origin}${posix.dirname(parsed.pathname)}`, root: posix.dirname(parsed.pathname) === '/' };
            };
            // The root folder does not count: Angular puts all files there, but also env.js, which the environment sets.
            const localFolders = new Set([...served.local.keys()].map(folder).filter(({ root: top }) => !top).map(({ key }) => key));
            return {
                ssr: pages.find((page) => page.ssr !== null)?.ssr ?? null,
                local: served.local.size,
                server: served.server.size,
                swapped: pages.some(({ swaps }) => swaps.some(({ removed }) => removed !== undefined)),
                localBase: pages.some(({ swaps }) => swaps.some(({ skipped }) => skipped === 'local-base')),
                mixed: [...served.server.keys()].filter((url) => localFolders.has(folder(url).key)),
                label: apps.map(({ name, label }) => (apps.length > 1 ? `${name}: ${label}` : label)).join(', '),
                statics: staticsServed(apps, served),
                ...completeness({ apps, served, patterns: allPatterns }),
            };
        },
        stop: stopAll,
    };
};

/** The file's version (mtime), for source maps: a watch rebuilds, and a map is only valid for the same file. */
export const fileVersion = (file) => {
    try {
        return String(statSync(file).mtimeMs);
    } catch {
        return 'missing';
    }
};

/**
 * Routes the page's code requests to the overlay. Routes registered later run first; what the overlay does not know falls through
 * (fallback). If a source fails, the request is aborted and onProblem gets the reason: never silently the deployed state.
 */
export const routeOverlay = async (context, overlay, { onProblem = () => {} } = {}) => {
    await context.route(() => true, async (route) => {
        const request = route.request();
        let found;
        try {
            found = await overlay.resolve(request.url(), request.resourceType());
        } catch (error) {
            onProblem(error, request.url());
            await route.abort().catch(() => {});
            return;
        }
        const type = request.resourceType();
        const counted = type === 'script' || type === 'stylesheet';
        if (found === null) {
            if (counted) overlay.served?.server.set(request.url(), type);
            await route.fallback();
            return;
        }
        if (type !== 'document') overlay.served?.local.set(request.url(), type);
        await route.fulfill({ status: 200, contentType: found.contentType, headers: { 'content-type': found.contentType, 'cache-control': 'no-store' }, body: found.body });
    });
    // HMR: the page's WebSocket goes to the dev server, whether it names the environment host (Vite) or the dev server host
    // (built in by webpack-dev-server). connectToServer() only connects to the original URL, so we bridge it ourselves.
    const [devOrigin] = overlay.devServers;
    if (devOrigin === undefined) return;
    const devHost = new URL(devOrigin).host;
    await context.routeWebSocket(() => true, (ws) => bridgeWebSocket(ws, devOrigin, devHost));
};

// Codes only the browser reports (1005 no code, 1006 aborted) must not be sent by anyone.
const closeCode = (code) => (code === undefined || code === 1005 || code === 1006 ? 1000 : code);

/** Bridges a page WebSocket to the dev server. Other sockets (the application's own) go unchanged to their target. */
export const bridgeWebSocket = (ws, devOrigin, devHost, WebSocketImpl = WebSocket) => {
    const requested = new URL(ws.url());
    // Vite (also Angular 17+) uses the vite-hmr protocol; webpack-dev-server names its own host. Another socket may still belong to
    // the dev server (webpack-dev-server with webSocketURL auto: page host, path /ws): try the dev server at the same path first;
    // if it rejects the handshake, the socket goes unchanged to its target.
    const sure = requested.host === devHost || ws.protocols().includes('vite-hmr');
    const target = `${devOrigin.replace(/^http/, 'ws')}${requested.pathname}${requested.search}`;
    const queue = [];
    let forward = (message) => queue.push(message);
    ws.onMessage((message) => forward(message));
    const toOriginal = () => {
        const original = ws.connectToServer();
        original.onMessage((message) => ws.send(message));
        original.onClose((code, reason) => { ws.close({ code: closeCode(code), reason }).catch(() => {}); });
        forward = (message) => original.send(message);
        for (const message of queue.splice(0)) original.send(message);
        ws.onClose((code, reason) => { original.close({ code: closeCode(code), reason }).catch(() => {}); });
    };
    // The dev server checks the origin (webpack-dev-server): give it its own.
    const server = new WebSocketImpl(target, { protocols: ws.protocols(), headers: { origin: devOrigin } });
    server.binaryType = 'arraybuffer';
    let opened = false;
    const giveUp = sure ? null : setTimeout(() => {
        if (opened) return;
        server.onclose = null;
        server.close();
        toOriginal();
    }, PROBE_MS);
    server.onopen = () => {
        opened = true;
        if (giveUp !== null) clearTimeout(giveUp);
        forward = (message) => server.send(message);
        for (const message of queue.splice(0)) server.send(message);
    };
    server.onmessage = (event) => ws.send(typeof event.data === 'string' ? event.data : Buffer.from(event.data));
    server.onclose = (event) => {
        if (!opened && !sure) {
            clearTimeout(giveUp);
            toOriginal();
            return;
        }
        ws.close({ code: closeCode(event.code) }).catch(() => {});
    };
    server.onerror = () => {};
    ws.onClose(() => { if (opened || sure) server.close(); });
};
