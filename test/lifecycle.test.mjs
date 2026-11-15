// The environment lifecycle (§2.9) with real shell commands: small Node scripts in a temporary project root.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { environmentLifecycle, logPath, probeReady, resetEnvironment, startEnvironment } from '../src/host/lifecycle.mjs';

const project = () => mkdtempSync(join(tmpdir(), 'caw-lifecycle-'));
const script = (root, name, code) => {
    writeFileSync(join(root, name), code);
    return `node ${name}`;
};
const listen = (status) => new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(status); res.end(); });
    server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = (server) => new Promise((resolve) => { server.close(resolve); });
const envAt = (port, extra = {}) => ({ name: 'ci', url: `http://localhost:${port}`, insecureTls: false, ready: { path: '/healthz', timeoutMs: 15000 }, ...extra });
const freePort = async () => {
    const server = await listen(200);
    const { port } = server.address();
    await close(server);
    return port;
};
// A server that writes its pid and listens on the port given as argument; long-running like npm run dev.
const SERVER = `const http = require('http');
const fs = require('fs');
fs.writeFileSync('server.pid', String(process.pid));
http.createServer((req, res) => { res.writeHead(req.url === '/healthz' ? 200 : 404); res.end(); }).listen(Number(process.argv[2]), '127.0.0.1');
`;

test('probeReady: any answer below 500 is ready, 5xx and no server are not', async () => {
    const notFound = await listen(404);
    const failing = await listen(503);
    try {
        assert.equal(await probeReady(envAt(notFound.address().port)), true, 'a 404 means the server is up');
        assert.equal(await probeReady(envAt(failing.address().port)), false);
        assert.equal(await probeReady(envAt(await freePort())), false);
    } finally {
        await Promise.all([close(notFound), close(failing)]);
    }
});

test('startEnvironment: already running is used and never stopped; nothing is started', async () => {
    const root = project();
    const said = [];
    const handle = await startEnvironment(root, envAt(1, { start: 'never-run', stop: 'never-run' }), {
        info: (text) => said.push(text), probe: async () => true, spawnImpl: () => { throw new Error('nothing may start'); },
    });
    assert.equal(handle.started, false);
    await handle.stop();
    assert.match(said.join('\n'), /ci läuft schon: caw nutzt sie und stoppt sie nicht/);
});

test('startEnvironment: a long-running start is polled until ready and ended as a process tree; CAW_ENV and CAW_ENV_URL are set', async () => {
    const root = project();
    const port = await freePort();
    script(root, 'server.js', SERVER);
    // Through a second process, as npm run dev → vite: the tree must go.
    const start = script(root, 'start.js', `require('fs').writeFileSync('env.txt', process.env.CAW_ENV + ' ' + process.env.CAW_ENV_URL);
require('child_process').spawn(process.execPath, ['server.js', '${port}'], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`);
    const env = envAt(port, { start });
    const handle = await startEnvironment(root, env, { pollMs: 200 });
    assert.equal(handle.started, true);
    assert.equal(await probeReady(env), true);
    assert.equal(readFileSync(join(root, 'env.txt'), 'utf8'), `ci http://localhost:${port}`);
    assert.ok(existsSync(join(root, logPath('ci', 'start'))), 'the start log is under .caw/env');
    await handle.stop();
    assert.equal(await probeReady(env), false, 'the child server is gone with the tree');
});

test('startEnvironment: a detaching start exits 0 and is polled on; stop runs at the end', async () => {
    const root = project();
    const ready = { value: false };
    const start = script(root, 'up.js', `require('fs').writeFileSync('up.txt', 'up');`);
    const stop = script(root, 'down.js', `require('fs').writeFileSync('down.txt', 'down');`);
    const handle = await startEnvironment(root, envAt(1, { start, stop }), {
        pollMs: 100,
        // Ready only once up.js has run, as with docker compose up -d --wait.
        probe: async () => {
            if (existsSync(join(root, 'up.txt'))) ready.value = true;
            return ready.value;
        },
    });
    assert.equal(handle.started, true);
    assert.equal(existsSync(join(root, 'down.txt')), false);
    await handle.stop();
    assert.equal(readFileSync(join(root, 'down.txt'), 'utf8'), 'down');
    await handle.stop();
});

test('startEnvironment: a start that fails first is env-start-failed with the log tail; one never ready is env-not-ready and cleaned up', async () => {
    const root = project();
    const failing = script(root, 'fail.js', `console.log('port 18080 already in use'); process.exit(3);`);
    await assert.rejects(startEnvironment(root, envAt(1, { start: failing }), { pollMs: 100, probe: async () => false }), (error) => error.code === 'env-start-failed'
        && /start von ci endete mit Exit-Code 3/.test(error.message) && /port 18080 already in use/.test(error.message) && /\.caw\/env\/ci-start\.log/.test(error.message));
    const port = await freePort();
    script(root, 'server.js', SERVER);
    const slow = script(root, 'slow.js', `require('child_process').spawn(process.execPath, ['server.js', '${port}'], { stdio: 'inherit' }); setInterval(() => {}, 1000);`);
    const stop = script(root, 'stop.js', `require('fs').writeFileSync('stopped.txt', 'yes');`);
    await assert.rejects(startEnvironment(root, envAt(port, { start: slow, stop, ready: { path: '/healthz', timeoutMs: 1000 } }), { pollMs: 100, probe: async () => false }),
        (error) => error.code === 'env-not-ready' && /ci war nach 1 s nicht bereit/.test(error.message));
    assert.equal(readFileSync(join(root, 'stopped.txt'), 'utf8'), 'yes', 'stop runs for what caw started');
    assert.equal(await probeReady(envAt(port)), false, 'and the start tree is ended');
});

test('resetEnvironment: exit 0 passes, anything else is env-reset-failed with the tail', async () => {
    const root = project();
    await resetEnvironment(root, envAt(1, { reset: script(root, 'ok.js', `require('fs').appendFileSync('resets.txt', 'x');`) }));
    assert.equal(readFileSync(join(root, 'resets.txt'), 'utf8'), 'x');
    const broken = script(root, 'broken.js', `console.error('seed failed: table missing'); process.exit(1);`);
    await assert.rejects(resetEnvironment(root, envAt(1, { reset: broken })), (error) => error.code === 'env-reset-failed' && /kein Test lief/.test(error.message) && /seed failed: table missing/.test(error.message));
    const hanging = script(root, 'hang.js', `setInterval(() => {}, 1000);`);
    await assert.rejects(resetEnvironment(root, envAt(1, { reset: hanging }), { limitMs: 500 }), (error) => error.code === 'env-reset-failed' && /länger als 1 s/.test(error.message));
});

test('environmentLifecycle: auto resets once before the first writing test, force before the first test, off never', async () => {
    const root = project();
    const reset = script(root, 'reset.js', `require('fs').appendFileSync('resets.txt', 'x');`);
    const count = () => (existsSync(join(root, 'resets.txt')) ? readFileSync(join(root, 'resets.txt'), 'utf8').length : 0);
    const auto = environmentLifecycle(root, envAt(1, { reset }), { reset: 'auto' });
    await auto.begin();
    await auto.beforeTest({ writes: false });
    assert.equal(count(), 0, 'a read-only test needs no reset');
    await auto.beforeTest({ writes: true });
    await auto.beforeTest({ writes: true });
    assert.equal(count(), 1, 'once per invocation');
    const force = environmentLifecycle(root, envAt(1, { reset }), { reset: 'force' });
    await force.beforeTest({ writes: false });
    assert.equal(count(), 2, '--reset before a read-only test');
    const off = environmentLifecycle(root, envAt(1, { reset }), { reset: 'off' });
    await off.beforeTest({ writes: true });
    assert.equal(count(), 2, '--no-reset');
    const none = environmentLifecycle(root, envAt(1), { reset: 'auto' });
    await none.beforeTest({ writes: true });
    await none.end();
});
