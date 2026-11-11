import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { bridgeWebSocket, prepareOverlay, probeServer } from '../src/host/overlay.mjs';

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

test('Overlay dev: if the dev server does not answer and devCommand is missing, the run ends with the start command', async (t) => {
    const root = project(t, {});
    const url = `http://127.0.0.1:${await freePort()}`;
    assert.equal(await probeServer(url), false);
    await assert.rejects(prepareOverlay({ root, config: { apps: { web: { dir: '.' } } }, checked: devChecked(url) }),
        (error) => error.code === 'overlay-not-ready' && error.message.includes(`Der Dev-Server ${url} antwortet nicht`) && /apps\.web\.overlay\.devCommand/.test(error.message));
});

test('Overlay dev: caw runs devCommand, waits for the address, forwards code and stops the server at the end', async (t) => {
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

test('Overlay dev: if devCommand does not start the server, the message shows its output', async (t) => {
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
