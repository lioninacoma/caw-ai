import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { bridgeWebSocket, discoverServer, incompleteText, prepareOverlay, probeServer, serverState } from '../src/host/overlay.mjs';
import { extjs } from '../src/host/framework/extjs.mjs';
import { folderFetch } from './static-server.mjs';

// An ExtJS app as the Sencha watch leaves it: app Bestellung, packages modell and theme, bootstrap.json in load order.
const extjsProject = (t) => project(t, {
    'app/app.json': JSON.stringify({ name: 'Bestellung', output: { js: { path: 'Bestellung.js' } } }),
    'app/app/Main.js': 'window.APP = "lokal";',
    'packages/modell/src/M.js': 'window.MODELL = "lokal";',
    'packages/theme/src/T.js': 'window.THEME = "lokal";',
    'app/bootstrap.json': JSON.stringify({ loadOrder: [{ path: '../packages/modell/src/M.js' }, { path: '../packages/theme/src/T.js' }, { path: 'app/Main.js' }], packages: { modell: { files: [0] }, theme: { files: [1] } } }),
});
const PORTAL = 'https://portal.example';
// The watch's web server serves the workspace: the app at /app/, its packages at /packages/.
const WATCH = 'http://watch.test/app/';
const watchChecked = { url: PORTAL, apps: { web: { kind: 'watch', url: WATCH, statics: [] } } };
const watchDeps = (root) => ({ fetchImpl: folderFetch(root, WATCH), discover: async () => null });
const extjsConfig = (extra = {}) => ({ framework: 'extjs', apps: { web: { dir: 'app' } }, ...extra });
const PROXY_PATTERN = '[?&]url=repo:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)';

/** What routeOverlay does per request: local if the overlay answers, otherwise the server. */
const load = async (overlay, urls) => {
    for (const url of urls) {
        const found = await overlay.resolve(url, 'script');
        overlay.served[found === null ? 'server' : 'local'].set(url, 'script');
    }
};

const project = (t, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-overlay-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};

const freePort = () => new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

// A tiny dev server: code under its paths, HTML for everything else (like Vite's SPA fallback), public/env.js as a copy.
const DEV_SERVER = `const { readFileSync } = require('node:fs');
const types = { '.js': 'text/javascript', '.css': 'text/css' };
require('node:http').createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (path === '/src/main.js') return response.writeHead(200, { 'content-type': types['.js'] }).end('console.log("dev")');
    if (path === '/src/style.css') return response.writeHead(200, { 'content-type': types['.css'] }).end('body{color:red}');
    if (path === '/env.js') return response.writeHead(200, { 'content-type': types['.js'] }).end(readFileSync('public/env.js'));
    response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
}).listen(Number(process.argv[2]), '127.0.0.1');
`;

const devChecked = (url, command) => ({ url: 'https://staging.example', apps: { web: { kind: 'dev', url, statics: [], ...(command === undefined ? {} : { command }) } } });

test('Overlay dev: if the dev server does not answer, caw starts nothing and names overlay.start (or asks for it)', async (t) => {
    const root = project(t, {});
    const url = `http://127.0.0.1:${await freePort()}`;
    assert.equal(await probeServer(url), false);
    await assert.rejects(prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: devChecked(url) }),
        (error) => error.code === 'overlay-not-ready' && error.message.includes(`Der lokale Code-Server ${url} antwortet nicht`) && /apps\.web\.overlay\.start/.test(error.message));
    // overlay.start without --start: named, not run.
    const named = { url: 'https://staging.example', apps: { web: { kind: 'dev', url, start: 'npm run dev', statics: [] } } };
    await assert.rejects(prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: named }),
        (error) => error.code === 'overlay-not-ready' && /Starte npm run dev in \. oder starte den Lauf mit --start/.test(error.message));
});

test('Overlay dev with --start: caw runs overlay.start, waits for the address, forwards code and stops the server at the end', async (t) => {
    const port = await freePort();
    const root = project(t, { 'server.cjs': DEV_SERVER, 'public/env.js': "window.ENV='local'" });
    const url = `http://127.0.0.1:${port}`;
    const lines = [];
    const overlay = await prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: devChecked(url, `node server.cjs ${port}`), info: (text) => lines.push(text) });
    t.after(() => overlay.stop());
    assert.match(lines.join('\n'), new RegExp(`Der Dev-Server ${url} läuft nicht, starte node server\\.cjs`));
    const js = await overlay.resolve('https://staging.example/src/main.js?t=1', 'script');
    assert.equal(String(js.body), 'console.log("dev")');
    assert.equal(js.contentType, 'text/javascript');
    assert.equal(String((await overlay.resolve('https://staging.example/src/style.css?import', 'fetch')).body), 'body{color:red}', 'Vite loads CSS as a module via fetch');
    assert.equal(await overlay.resolve('https://staging.example/env.js', 'script'), null, 'a copy from public/ is set by the environment');
    assert.equal(await overlay.resolve('https://staging.example/assets/index-OLD.js', 'script'), null, 'HTML instead of code: the server');
    assert.equal(await overlay.resolve('https://staging.example/api/orders', 'fetch'), null, 'never data');
    assert.equal(await overlay.resolve('https://staging.example/', 'document'), null);
    assert.deepEqual(overlay.devServers, [url]);
    overlay.stop();
    const until = Date.now() + 10_000;
    while (await probeServer(url) && Date.now() < until) await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.equal(await probeServer(url), false, 'the started dev server ends with the run');
});

test('Overlay dev with --start: if the command does not start the server, the message shows its output', async (t) => {
    const root = project(t, {});
    const url = `http://127.0.0.1:${await freePort()}`;
    await assert.rejects(prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: devChecked(url, 'node -e "console.log(\'Port belegt\'); process.exit(1)"') }),
        (error) => error.code === 'overlay-not-ready' && /hat den Dev-Server .* nicht gestartet/.test(error.message) && /Port belegt/.test(error.message));
});

test('HMR: dev server sockets go to it with its origin; others go unchanged to their target', () => {
    const made = [];
    class FakeSocket {
        constructor(url, options) {
            this.url = url;
            this.options = options;
            this.sent = [];
            this.readyState = 0;
            made.push(this);
        }

        send(message) { this.sent.push(message); }

        close() { this.closed = true; }
    }
    const page = (url, protocols = []) => {
        const ws = { url: () => url, protocols: () => protocols, sent: [], handlers: {} };
        ws.connectToServer = () => {
            ws.direct = { sent: [], onMessage: (handler) => { ws.direct.message = handler; }, onClose: () => {}, send: (message) => ws.direct.sent.push(message), close: async () => {} };
            return ws.direct;
        };
        ws.send = (message) => ws.sent.push(message);
        ws.close = async () => { ws.closed = true; };
        ws.onMessage = (handler) => { ws.handlers.message = handler; };
        ws.onClose = (handler) => { ws.handlers.close = handler; };
        return ws;
    };
    const vite = page('wss://staging.example/?token=abc', ['vite-hmr']);
    bridgeWebSocket(vite, 'http://localhost:5173', 'localhost:5173', FakeSocket);
    assert.equal(made[0].url, 'ws://localhost:5173/?token=abc');
    assert.deepEqual(made[0].options, { protocols: ['vite-hmr'], headers: { origin: 'http://localhost:5173' } });
    vite.handlers.message('frueh');
    made[0].readyState = 1;
    made[0].onopen();
    assert.deepEqual(made[0].sent, ['frueh'], 'what the page sends before connecting is not lost');
    made[0].onmessage({ data: '{"type":"connected"}' });
    assert.deepEqual(vite.sent, ['{"type":"connected"}']);
    const webpack = page('ws://localhost:5173/ws');
    bridgeWebSocket(webpack, 'http://localhost:5173', 'localhost:5173', FakeSocket);
    assert.equal(made[1].url, 'ws://localhost:5173/ws');
    // An application socket: first the dev server at the same path; if it refuses, the original, without losing anything.
    const app = page('wss://staging.example/live');
    bridgeWebSocket(app, 'http://localhost:5173', 'localhost:5173', FakeSocket);
    assert.equal(made[2].url, 'ws://localhost:5173/live');
    app.handlers.message('hallo');
    made[2].onclose({ code: 1006 });
    assert.deepEqual(app.direct.sent, ['hallo']);
    app.direct.message('vom Server');
    assert.deepEqual(app.sent, ['vom Server']);
    // webpack-dev-server with webSocketURL auto: page host, but the dev server accepts the handshake.
    const auto = page('wss://staging.example/ws');
    bridgeWebSocket(auto, 'http://localhost:5173', 'localhost:5173', FakeSocket);
    made[3].readyState = 1;
    made[3].onopen();
    auto.handlers.message('{"type":"hash"}');
    assert.deepEqual(made[3].sent, ['{"type":"hash"}']);
    assert.equal(auto.direct, undefined);
});

test('Overlay watch: diagnose names parts from the server (missed), parts never loaded, and the pattern that catches them', async (t) => {
    const root = extjsProject(t);
    const overlay = await prepareOverlay({ root, config: extjsConfig(), checked: watchChecked, deps: watchDeps(root) });
    // The theme via a plain path below the environment (default pattern), app and modell via a proxy parameter.
    await load(overlay, [`${PORTAL}/html/js/theme/theme.js`, `${PORTAL}/o/Proxy?url=repo:///Root/Fa/Bestellung.js`, `${PORTAL}/o/Proxy?url=repo:///Root/public/Other.js`]);
    const seen = overlay.diagnose();
    assert.equal(seen.local, 1);
    assert.deepEqual(seen.parts.map(({ label, status }) => [label, status]), [['Bestellung', 'deployed'], ['modell', 'not-loaded'], ['theme', 'local']]);
    assert.deepEqual(seen.missed, [{ url: `${PORTAL}/o/Proxy?url=repo:///Root/Fa/Bestellung.js`, name: 'Bestellung.js', part: 'Bestellung' }]);
    assert.deepEqual(seen.notLoaded, ['modell']);
    assert.deepEqual(seen.suggestions.map(({ pattern }) => pattern), ['[?&]url=repo:///Root/Fa/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)']);
    const text = incompleteText(seen);
    assert.match(text, /^Mischstand: 1 Skript\(e\) von Bestellung kamen vom Server statt aus dem lokalen Code:\n {2}https:\/\/portal\.example\/o\/Proxy/);
    assert.match(text, /caw-ai overlay check --apply/);
    assert.match(incompleteText({ ...seen, suggestions: [] }), /assetUrlPattern, dessen Gruppe 1 der Dateiname ist/);
});

test('Overlay watch: assetUrlPattern as a string, as a list and per app all resolve; then nothing is missed', async (t) => {
    const root = extjsProject(t);
    const urls = [`${PORTAL}/html/js/theme/theme.js`, `${PORTAL}/o/Proxy?url=repo:///Root/Fa/Bestellung.js`, `https://cdn.example/js/modell.js`];
    const configs = {
        string: extjsConfig({ assetUrlPattern: PROXY_PATTERN }),
        list: extjsConfig({ assetUrlPattern: [PROXY_PATTERN, '^https://cdn\\.example/js/([^/?#]+\\.js)'] }),
        perApp: extjsConfig({ assetUrlPattern: [PROXY_PATTERN], apps: { web: { dir: 'app', overlay: { assetUrlPattern: '^https://cdn\\.example/js/([^/?#]+\\.js)' } } } }),
    };
    for (const [name, config] of Object.entries(configs)) {
        const overlay = await prepareOverlay({ root, config, checked: watchChecked, deps: watchDeps(root) });
        await load(overlay, urls);
        assert.match(String((await overlay.resolve(urls[1], 'script')).body), /window\.APP = "lokal"/, name);
        const seen = overlay.diagnose();
        if (name === 'string') {
            assert.deepEqual(seen.missed.map(({ part }) => part), ['modell'], 'the CDN needs its own entry');
            assert.equal(seen.suggestions[0].source, 'https://cdn.example/js/');
        } else {
            assert.deepEqual(seen.missed, [], name);
            assert.deepEqual(seen.parts.map(({ status }) => status), ['local', 'local', 'local'], name);
        }
    }
});

test('Overlay watch: ready only if the server at overlay.url serves this app; down without --start names the command', async (t) => {
    const root = extjsProject(t);
    const config = extjsConfig();
    const down = { url: PORTAL, apps: { web: { kind: 'watch', url: 'http://127.0.0.1:9/', start: 'pnpm run watch', statics: [] } } };
    await assert.rejects(prepareOverlay({ root, config, checked: down, deps: watchDeps(root) }),
        (error) => error.code === 'overlay-not-ready' && /Der lokale Code-Server http:\/\/127\.0\.0\.1:9\/ antwortet nicht\. Starte pnpm run watch in app/.test(error.message));
    // Another project's watch on the port: never used, never replaced by a start.
    writeFileSync(join(root, 'app', 'app.json'), JSON.stringify({ name: 'Zertifizierung' }));
    await assert.rejects(prepareOverlay({ root, config, checked: { ...watchChecked, apps: { web: { ...watchChecked.apps.web, command: 'node -e 0' } } }, deps: { ...watchDeps(root), fetchImpl: folderFetch(join(root, 'other'), WATCH) } }),
        (error) => error.code === 'overlay-not-ready' && /keine app\.json/.test(error.message));
});

test('Overlay watch: a bootstrap.json naming a file the server lacks is overlay-stale before the browser', async (t) => {
    const root = extjsProject(t);
    writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Main.js' }, { path: 'app/Weg.js' }] }));
    await assert.rejects(prepareOverlay({ root, config: extjsConfig(), checked: watchChecked, deps: watchDeps(root) }),
        (error) => error.code === 'overlay-stale' && /app\/Weg\.js/.test(error.message));
});

test('Overlay watch: found on another port, the run uses it and says so; the label names the address', async (t) => {
    const root = extjsProject(t);
    const moved = 'http://moved.test/app/';
    const lines = [];
    const checked = { url: PORTAL, apps: { web: { kind: 'watch', url: 'http://localhost:1841/', statics: [] } } };
    const fetchImpl = folderFetch(root, moved);
    const overlay = await prepareOverlay({ root, config: extjsConfig(), checked, info: (text) => lines.push(text), deps: { fetchImpl, discover: async () => moved } });
    assert.match(lines.join('\n'), /Sencha-Watch läuft unter http:\/\/moved\.test\/app\/, nicht unter http:\/\/localhost:1841\/: nehme ihn/);
    assert.equal(overlay.apps[0].label, `Sencha-Watch ${moved}`);
    assert.match(String((await overlay.resolve(`${PORTAL}/html/js/Bestellung.js`, 'script')).body), /window\.APP = "lokal"/);
});

test('serverState and discoverServer: dev servers by any answer; the watch by identity, on another port via its process', async (t) => {
    const root = extjsProject(t);
    const appDir = join(root, 'app');
    const fetchImpl = folderFetch(root, 'http://localhost:52775/');
    assert.deepEqual(await serverState({ url: 'http://127.0.0.1:9/', appDir, adapter: { name: 'web' }, fetchImpl }), { state: 'down' });
    const pids = (pattern) => (pattern === extjs.watch.command ? [4321] : []);
    const ports = (found) => (found.includes(4321) ? [1841, 52775] : []);
    const moved = await discoverServer({ url: 'http://localhost:1841/app/', appDir, adapter: extjs, fetchImpl, pids, ports });
    assert.equal(moved, 'http://localhost:52775/app/', 'the configured port is skipped, the path is kept');
    assert.equal(await discoverServer({ url: 'http://localhost:1841/', appDir, adapter: { name: 'web' }, fetchImpl, pids, ports }), null, 'no watch: no search');
    const state = await serverState({ url: 'http://localhost:1841/app/', appDir, adapter: extjs, fetchImpl, discover: (options) => discoverServer({ ...options, pids, ports }) });
    assert.deepEqual(state, { state: 'moved', url: 'http://localhost:52775/app/' });
    assert.equal((await serverState({ url: 'http://localhost:52775/app/', appDir, adapter: extjs, fetchImpl })).state, 'ready');
});
