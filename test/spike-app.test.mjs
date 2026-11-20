// The spike's app (e2e/spike/app.mjs) over plain HTTP, no browser: environments by host name, the profile endpoint and the
// server-side regressions. The client-side ones (controls, console, view, missing request) live in the page script and are
// checked by their presence in it.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Script } from 'node:vm';

import { REGRESSIONS, profileOf, startApp } from '../e2e/spike/app.mjs';
import { testCall } from '../e2e/spike/capture.mjs';

let app;
before(async () => { app = await startApp({ port: 0 }); });
after(async () => { await app.close(); });

/** One request to an environment; resolves { status, headers, text } or { error } for a dropped connection. */
const call = (env, path, { method = 'GET', body, cookie } = {}) => new Promise((resolve) => {
    const headers = { host: `${env}.localhost:${app.port}`, ...(cookie === undefined ? {} : { cookie }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    const sent = request({ host: '127.0.0.1', port: app.port, path, method, headers }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    sent.on('error', (error) => resolve({ error: error.code }));
    sent.end(body);
});
const signIn = async (env) => {
    const response = await call(env, '/login', { method: 'POST', body: 'user=demo&password=demo' });
    assert.equal(response.status, 303);
    return response.headers['set-cookie'][0].split(';')[0];
};
const fast = { latency: { base: 1, jitter: 0 } };

test('profiles: unknown regressions are refused, defaults fill the rest', async () => {
    assert.throws(() => profileOf({ regression: 'nope' }), /unknown regression/);
    assert.equal(profileOf({ latency: { base: 5 } }).latency.jitter, 80);
    await assert.rejects(testCall(app.port, 'a', '/test/profile', { regression: 'nope' }), /HTTP 400/);
});

test('a and b are separate environments; b gets foreign rows and the third-party widget', async () => {
    await testCall(app.port, 'a', '/test/profile', { ...fast, reset: true });
    await testCall(app.port, 'b', '/test/profile', { ...fast, reset: true, foreignRows: { p: 1, n: 3 } });
    assert.deepEqual(await testCall(app.port, 'a', '/test/rows'), []);
    assert.ok((await testCall(app.port, 'b', '/test/rows')).length >= 3);
    const pageA = await call('a', '/', { cookie: await signIn('a') });
    const pageB = await call('b', '/', { cookie: await signIn('b') });
    assert.ok(!pageA.text.includes('cdn.localhost'));
    assert.match(pageB.text, /cdn\.localhost:\d+\/widget\.js\?e=0/);
    assert.match((await call('cdn', '/widget.js?e=1')).text, /console\.error/);
    assert.equal((await call('a', '/api/todos')).status, 401);
});

test('server-side regressions hit the save of the detail page and the item response', async () => {
    const cookie = await signIn('a');
    const create = async () => JSON.parse((await call('a', '/api/todos', { method: 'POST', cookie, body: JSON.stringify({ title: 'Feed the raven', tag: 'home' }) })).text);
    const save = (id) => call('a', `/api/todos/${id}`, { method: 'PATCH', cookie, body: JSON.stringify({ when: 'Tomorrow' }) });
    await testCall(app.port, 'a', '/test/profile', { ...fast, reset: true });
    const todo = await create();
    assert.equal((await save(todo.id)).status, 200);
    assert.ok('created' in JSON.parse((await call('a', `/api/todos/${todo.id}`, { cookie })).text));
    for (const [regression, expected] of [['app500', 500], ['gateway503', 503]]) {
        await testCall(app.port, 'a', '/test/profile', { ...fast, regression });
        assert.equal((await save(todo.id)).status, expected, regression);
    }
    await testCall(app.port, 'a', '/test/profile', { ...fast, regression: 'reset' });
    assert.ok((await save(todo.id)).error !== undefined, 'the connection is dropped');
    await testCall(app.port, 'a', '/test/profile', { ...fast, regression: 'response-shape' });
    const shaped = JSON.parse((await call('a', `/api/todos/${todo.id}`, { cookie })).text);
    assert.ok('createdAt' in shaped && !('created' in shaped));
});

test('client-side regressions are in the page script, and flicker is a response header', async () => {
    const cookie = await signIn('a');
    await testCall(app.port, 'a', '/test/profile', { ...fast, regression: 'control-removed' });
    assert.match((await call('a', '/', { cookie })).text, /const R = "control-removed"/);
    await testCall(app.port, 'a', '/test/profile', { ...fast, flicker: { p: 1 } });
    assert.equal((await call('a', '/api/todos?q=', { cookie })).headers['x-sync'], '1');
    await testCall(app.port, 'a', '/test/profile', { ...fast, flicker: { p: 0 } });
    assert.equal((await call('a', '/api/todos?q=', { cookie })).headers['x-sync'], '0');
});

test('the page script parses for every regression (no browser runs here, so a syntax slip would only show in the capture)', async () => {
    const cookie = await signIn('a');
    for (const regression of [null, ...REGRESSIONS]) {
        await testCall(app.port, 'a', '/test/profile', { ...fast, regression });
        const script = /<script>([\s\S]*)<\/script>/.exec((await call('a', '/', { cookie })).text)[1];
        assert.doesNotThrow(() => new Script(script), String(regression));
    }
    const widget = (await call('cdn', '/widget.js?e=1')).text;
    assert.doesNotThrow(() => new Script(widget));
});

test('latency follows the profile: slow4x is four times the base', async () => {
    const cookie = await signIn('a');
    const timed = async () => {
        const started = Date.now();
        await call('a', '/api/todos?q=', { cookie });
        return Date.now() - started;
    };
    await testCall(app.port, 'a', '/test/profile', { latency: { base: 40, jitter: 0 } });
    const plain = await timed();
    await testCall(app.port, 'a', '/test/profile', { latency: { base: 40, jitter: 0 }, regression: 'slow4x' });
    const slow = await timed();
    assert.ok(plain >= 35 && slow >= 150, `${plain} ms, ${slow} ms`);
});
