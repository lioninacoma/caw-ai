// Das Overlay: lokaler Code ueber einer ausgelieferten Umgebung, nur mit --overlay. Seite, API, Cookies und Anmeldung bleiben von der
// Umgebung; Code-Requests beantwortet die gewaehlte Quelle der App:
// - build: ein Build-Ordner (exakt oder gleicher Name bis auf den Hash)
// - dev:   ein Dev-Server (Vite, webpack, Angular), dazu sein HMR-WebSocket
// - watch: der Sencha-Watch (ExtJS), Quellen laut bootstrap.json; Wissen darueber im ExtJS-Adapter
// - files: nur overlay.statics
// overlay.statics gilt bei jeder Quelle zuerst. Projektkopien (public/env.js) kommen immer vom Server: Die Umgebung setzt sie.
//
// Vor dem Browser prueft prepareOverlay, ob die Quelle bereit ist. Ist sie es nicht und nennt die Config den Befehl dafuer
// (buildCommand, devCommand), startet caw ihn und sagt das; sonst Exit 2 mit dem Befehl. Die Quelle wechselt nie still.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import { defaultAssetPattern } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RUN_DIR } from '../shared/names.mjs';
import { ago, newestFile } from './code-source.mjs';
import { frameworkOf } from './framework/index.mjs';
import { buildCheck, contentTypeOf, localPages, moduleAlias, resolveLocalBuild, scriptKind, servesBuild, withoutIntegrity } from './local-build.mjs';
import { baseOf, codeTags, ssrMarker, swapPage } from './page-swap.mjs';
import { processRunning } from './processes.mjs';
import { isProjectCopy, isProjectCopyFile } from './project-files.mjs';

const DEV_START_MS = 60_000;
const WATCH_START_MS = 180_000;
const POLL_MS = 500;
const PROBE_MS = 2_000;
const LOG_TAIL = 15;

// Welche Namen ein Request traegt: die erste Gruppe eines Musters, Trenner zusammengefasst, ohne fuehrenden Schraegstrich.
const compiled = new Map();
export const deriveName = (url, pattern) => {
    if (typeof pattern !== 'string' || pattern === '') return null;
    if (!compiled.has(pattern)) compiled.set(pattern, new RegExp(pattern));
    const match = compiled.get(pattern).exec(url);
    if (match === null) return null;
    const name = (match[1] ?? '').replace(/\/{2,}/g, '/').replace(/^\//, '');
    return name === '' ? null : name;
};

const tail = (file) => {
    try {
        return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL).join('\n');
    } catch {
        return '';
    }
};

const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms); });

const waitFor = async (check, timeoutMs, { exited = () => false } = {}) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (await check()) return true;
        if (exited()) return false;
        await sleep(POLL_MS);
    }
    return check();
};

/** Ein Befehl der Config im App-Ordner, im Hintergrund; seine Ausgabe in log. stop() beendet ihn samt Kindern (npm -> vite). */
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
    // Endet caw ohne Aufraeumen (process.exit, Absturz), bleibt kein Dev-Server stehen.
    const stop = () => {
        process.removeListener('exit', stop);
        if (exited || child.pid === undefined) return;
        try {
            if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            else process.kill(-child.pid, 'SIGTERM');
        } catch {
            // schon beendet
        }
    };
    process.once('exit', stop);
    child.on?.('exit', () => { exited = true; process.removeListener('exit', stop); });
    child.on?.('error', () => { exited = true; process.removeListener('exit', stop); });
    return { exited: () => exited, stop };
};

/** Antwortet ein Server unter der Adresse? Jede HTTP-Antwort zaehlt, auch 404: Dann laeuft er. */
export const probeServer = async (url, fetchImpl = fetch) => {
    try {
        await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
        return true;
    } catch {
        return false;
    }
};

const logFile = (root, app, what) => join(root, RUN_DIR, `${app}-${what}.log`);

// ---- Quellen ------------------------------------------------------------------------------------------------------------------

/** Ist der Build aelter als die letzte Aenderung unter dem App-Ordner? @returns null oder { file, ago } */
export const staleBuild = (buildDir, appDir, root, now = Date.now()) => {
    const built = newestFile(buildDir, { skipNames: new Set(['node_modules']) });
    if (built === null) return null;
    const changed = newestFile(appDir, { skip: [buildDir, join(root, 'caw')] });
    if (changed === null || changed.mtimeMs <= built.mtimeMs) return null;
    return { file: relative(appDir, changed.path).replaceAll('\\', '/'), ago: ago(now - changed.mtimeMs) };
};

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
            if (choice.command === undefined) throw new CawError('overlay-not-ready', t('session.overlay.buildHint', { problem: before, app: name }));
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
                // Eine unveraenderte Kopie aus dem Projekt (public/env.js) setzt die Umgebung: Sie kommt vom Server.
                if (found.alias === undefined && isProjectCopyFile(appDir, found.file, { skip: [dir] })) continue;
                const raw = readFileSync(found.file);
                // Unter dem deployten Namen eines ES-Moduls nur ein Verweis auf das lokale, sonst liefe es zweimal.
                const body = found.alias === undefined ? raw : moduleAlias(found.alias, raw.toString('utf8'), scriptKind(dir, found.alias)) ?? raw;
                return { contentType: found.contentType, body, file: found.file };
            }
            return null;
        },
        page: ({ base, deployed, namesOf }) => buildPage({ dir, appDir, base, deployed, namesOf }),
    };
};

/** Die lokale Datei, die ein Request auf url bekaeme (wie resolve: ueber die Namen aus dem Muster). */
const routedFile = (dir, namesOf, url) => {
    for (const name of namesOf(url)) {
        const found = resolveLocalBuild(dir, name);
        if (found !== null) return found.file;
    }
    return undefined;
};

/** Die lokale Datei zu einer URL, bei fremden Origins (CDN) und Pfaden ausserhalb des Musters ueber den Pfad. */
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
 * Was beim Build getauscht wird. Die lokale Seite ist die mit den meisten Treffern unter den ausgelieferten Tags (ein Build kann mehrere
 * Seiten haben). Ein ausgelieferter Tag gehoert der App, wenn der Build seine Datei kennt und sie keine Projektkopie ist, oder wenn er
 * im Asset-Ordner der lokalen Seite liegt; ein Inline-Skript, wenn es diesen Ordner nennt (webpack-Laufzeit mit publicPath).
 * @returns { owned, local } | { issue } | null (keine passende Seite: kein Tausch, die Requests einzeln)
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
    // Zeigt ein lokaler Tag auf eine Datei, die der Build unter dieser Adresse nicht hat (anderer base-Pfad als die Umgebung), liefe die
    // getauschte Seite ins Leere: dann nicht tauschen.
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

// Was beim Dev-Server Code ist: Skripte, Stile, Schriften, Bilder; per fetch nur Code (Vite laedt CSS als Modul mit ?import).
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
            if (choice.command === undefined) throw new CawError('overlay-not-ready', t('session.overlay.devDown', { url: choice.url, app: name }));
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
 * Was beim Dev-Server getauscht wird. Die lokale Seite ist sein HTML unter demselben Pfad (Vite, webpack, Angular liefern es fuer jede
 * Route). Ein ausgelieferter Tag gehoert der App, wenn er unter der Adresse der Umgebung liegt, die Dev-Seite ihn nicht selbst laedt
 * und der Dev-Server darunter keine Projektkopie liefert (public/env.js setzt die Umgebung).
 */
const devPage = async ({ origin, appDir, envUrl, url, base, deployed, fetchImpl }) => {
    const page = new URL(url);
    let text;
    try {
        const response = await fetchImpl(`${origin}${page.pathname}${page.search}`, { headers: { accept: 'text/html' }, redirect: 'follow' });
        if (response.status !== 200 || !/text\/html/i.test(response.headers.get('content-type') ?? '')) return null;
        // Wie die ausgelieferte Seite ein Byte-String: Eingefuegt wird Byte fuer Byte.
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

const watchSource = ({ root, name, appDir, choice, config, info, running = processRunning }) => {
    const { watch, overlay } = frameworkOf(config);
    const source = overlay.createWatchSource(appDir);
    let started = null;
    const hint = t('session.overlay.watchHint', { start: choice.command ?? watch.start });
    return {
        kind: 'watch',
        label: watch.label,
        ready: async () => {
            const isRunning = () => running(watch.command) !== false;
            if (isRunning()) {
                overlay.checkAppFiles(appDir, hint);
                return;
            }
            if (choice.command === undefined) throw new CawError('watch-missing', t('cli.noWatch', { label: watch.label, start: watch.start }));
            const log = logFile(root, name, 'watch');
            info(t('session.overlay.watchStarting', { label: watch.label, command: choice.command }));
            started = startCommand(choice.command, appDir, log);
            // Den Watch haben wir selbst gestartet: Er laeuft, solange sein Prozess lebt (waitFor bricht sonst ab).
            const ok = () => {
                try {
                    overlay.checkAppFiles(appDir, hint);
                    return true;
                } catch {
                    return false;
                }
            };
            if (await waitFor(ok, WATCH_START_MS, { exited: started.exited })) return;
            started.stop();
            started = null;
            throw new CawError('watch-missing', t('session.overlay.watchStartFailed', { label: watch.label, command: choice.command, seconds: WATCH_START_MS / 1000, log, tail: tail(log) }));
        },
        stop: () => started?.stop(),
        resolve: async ({ type, names }) => {
            if (type === 'document') return null;
            for (const requested of names) {
                const found = source.resolve(requested);
                if (found !== null) return { contentType: 'application/javascript', body: found.body };
            }
            return null;
        },
        replaced: source.replaced,
    };
};

const filesOnly = () => ({ kind: 'files', label: 'statics', ready: async () => {}, resolve: async () => null });

const SOURCES = { build: buildSource, dev: devSource, watch: watchSource, files: filesOnly };

/** overlay.statics: feste Namen, Datei relativ zum App-Ordner, bei jedem Laden frisch von der Platte. */
const staticsOf = (appDir, statics) => {
    const byName = new Map(statics.map((entry) => [entry.name, join(appDir, entry.path)]));
    return {
        check: () => {
            for (const file of byName.values()) if (!existsSync(file)) throw new CawError('overlay-not-ready', t('session.overlay.staticMissing', { file }));
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
 * Prueft und startet die Quellen aller Apps des Laufs mit Overlay (checked.apps aus checkTest), vor dem Browser.
 * @returns { apps: [{ name, kind, label, source, statics }], resolve, fileFor, devServers, stop }
 */
export const prepareOverlay = async ({ root, config, checked, info = () => {}, deps = {} }) => {
    const apps = [];
    const stopAll = () => { for (const { source } of apps) source.stop?.(); };
    try {
        for (const [name, choice] of Object.entries(checked.apps ?? {})) {
            const appDir = join(root, config.apps[name].dir);
            const source = SOURCES[choice.kind]({ root, name, appDir, choice, config, info, envUrl: checked.url, ...deps });
            apps.push({ name, kind: choice.kind, label: source.label, source, statics: staticsOf(appDir, choice.statics ?? []) });
            await source.ready();
            apps.at(-1).statics.check();
        }
    } catch (error) {
        stopAll();
        throw error;
    }
    const patterns = [defaultAssetPattern(checked.url), config.assetUrlPattern].filter((pattern) => typeof pattern === 'string');
    const namesOf = (url) => [...new Set(patterns.map((pattern) => deriveName(url, pattern)).filter((name) => name !== null))];
    const pages = [];
    // Je URL, ob Skript oder Stylesheet aus dem lokalen Code kam oder vom Server (routeOverlay traegt ein).
    const served = { local: new Map(), server: new Map() };
    return {
        apps,
        /**
         * Jede HTML-Seite der Anwendung (Byte-String, siehe rewriteBytes): die Code-Tags der App gegen die der lokalen Seite getauscht,
         * dann ohne integrity. Ohne passende lokale Seite bleibt sie, wie sie ist; die Requests beantwortet dann resolve einzeln.
         * Eine SSR-Seite wird nie getauscht. Was geschah, steht in pages (fuer die Diagnose).
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
                    const plan = await app.source.page({ url, base, deployed, namesOf });
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
        /** Die Antwort aus dem lokalen Code fuer einen Request, oder null: dann der Server. Die App des Tests zuerst. */
        resolve: async (url, type) => {
            if (type === 'document') return null;
            const request = { url, type, names: namesOf(url) };
            for (const app of apps) {
                const found = app.statics.resolve(request) ?? await app.source.resolve(request);
                if (found !== null) return { ...found, app: app.name };
            }
            return null;
        },
        /** Die lokale Datei hinter einer URL (Build, statics), fuer Quellkarten; sonst undefined. */
        fileFor: (url) => {
            const request = { url, type: undefined, names: namesOf(url) };
            for (const app of apps) {
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
         * Was nach dem Laden lief, fuer die Diagnose: nie still den ausgelieferten Stand testen.
         * @returns { ssr, local, server, swapped, localBase, mixed: [urls], label }
         */
        diagnose: () => {
            const folder = (url) => {
                const parsed = new URL(url);
                return { key: `${parsed.origin}${posix.dirname(parsed.pathname)}`, root: posix.dirname(parsed.pathname) === '/' };
            };
            // Der Wurzelordner zaehlt nicht: Dort liegen bei Angular alle Dateien, aber auch env.js, die die Umgebung setzt.
            const localFolders = new Set([...served.local.keys()].map(folder).filter(({ root: top }) => !top).map(({ key }) => key));
            return {
                ssr: pages.find((page) => page.ssr !== null)?.ssr ?? null,
                local: served.local.size,
                server: served.server.size,
                swapped: pages.some(({ swaps }) => swaps.some(({ removed }) => removed !== undefined)),
                localBase: pages.some(({ swaps }) => swaps.some(({ skipped }) => skipped === 'local-base')),
                mixed: [...served.server.keys()].filter((url) => localFolders.has(folder(url).key)),
                label: apps.map(({ name, label }) => (apps.length > 1 ? `${name}: ${label}` : label)).join(', '),
            };
        },
        stop: stopAll,
    };
};

/** Seit wann gibt es die Datei? Fuer Quellkarten: Ein Watch baut neu, die Karte gilt nur fuer dieselbe Datei. */
export const fileVersion = (file) => {
    try {
        return String(statSync(file).mtimeMs);
    } catch {
        return 'fehlt';
    }
};

/**
 * Leitet die Code-Requests der Seite an das Overlay. Spaeter registrierte Routen laufen zuerst; was das Overlay nicht kennt, geht
 * weiter (fallback). Scheitert eine Quelle, bricht der Request ab, und onProblem erfaehrt den Grund: Nie still der ausgelieferte Stand.
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
    // HMR: Das WebSocket der Seite geht an den Dev-Server, auch wenn es den Host der Umgebung nennt (Vite) oder den des Dev-Servers
    // (webpack-dev-server baut ihn ein). connectToServer() verbindet nur zur Original-URL, darum bruecken wir selbst.
    const [devOrigin] = overlay.devServers;
    if (devOrigin === undefined) return;
    const devHost = new URL(devOrigin).host;
    await context.routeWebSocket(() => true, (ws) => bridgeWebSocket(ws, devOrigin, devHost));
};

/** Ein WebSocket der Seite zum Dev-Server. Andere Sockets (die der Anwendung) gehen unveraendert an ihr Ziel. */
// Codes, die nur der Browser meldet (1005 ohne Code, 1006 abgebrochen), darf niemand selbst senden.
const closeCode = (code) => (code === undefined || code === 1005 || code === 1006 ? 1000 : code);

export const bridgeWebSocket = (ws, devOrigin, devHost, WebSocketImpl = WebSocket) => {
    const requested = new URL(ws.url());
    // Vite (auch Angular ab 17) meldet sich mit dem Protokoll vite-hmr; webpack-dev-server nennt seinen eigenen Host. Ein anderes
    // Socket kann trotzdem dem Dev-Server gehoeren (webpack-dev-server mit webSocketURL auto: Host der Seite, Pfad /ws): Es versucht
    // zuerst ihn unter demselben Pfad; nimmt er den Handshake nicht an, geht es unveraendert an sein Ziel.
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
    // Der Dev-Server prueft den Origin (webpack-dev-server): Er bekommt seinen eigenen.
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
