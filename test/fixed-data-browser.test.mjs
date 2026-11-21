// Fixed data in real Chrome (headless): the frozen answer reaches the app instead of the backend's, the real request still goes
// out and its shape is compared, other requests pass. Chrome is launched with caw's host lock flags and the app is served under a
// name below .localhost, as caw serves a local app: only Chrome resolves it (the lock pins it to 127.0.0.1), Node does not, so
// the real request must go out through Chrome. Skipped without Chrome. Invented data only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { answerBook, answerChanges, requestKey, serveAnswers } from '../src/host/fixed-data.mjs';
import { browserArgs, installHostLock } from '../src/host/host-lock.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let server = null;
let base = '';
// What the backend answers right now, and what it was asked.
let contacts = [{ id: 1, name: 'Live Person', city: 'Livetown' }];
const asked = [];
const PAGE = `<!doctype html><body><p id="out">-</p><script>
fetch('/api/contacts').then((answer) => answer.json()).then((list) => { document.getElementById('out').textContent = list.map(({ name, city }) => name + ' / ' + city).join('; '); });
fetch('/api/save', { method: 'POST', body: '{}' }).then((answer) => answer.text(), () => 'held').then((text) => { document.body.dataset.saved = text; });
</script></body>`;

before(async () => {
    browser = await launchChrome({ args: browserArgs() });
    server = createServer((request, response) => {
        asked.push(`${request.method} ${request.url}`);
        if (request.url === '/api/contacts') return response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(contacts));
        if (request.url === '/api/save') return response.writeHead(200, { 'content-type': 'text/plain' }).end('saved');
        return response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    base = `http://fixed.localhost:${server.address().port}`;
});
after(async () => {
    await browser?.close();
    await new Promise((resolve) => { server?.close(resolve); });
});

const FROZEN = [{ step: 'S1', name: 'GET /api/contacts', key: 'by-url', status: 200, type: 'application/json', body: [{ id: 7, name: 'Frozen Person', city: 'Frozentown' }] }];

/**
 * Opens the page with the frozen answers served; returns what the page shows, the real answers and the shape changes seen.
 * `routes(context)` registers caw's other routes first (host lock, write block), as the session does.
 */
const visit = async ({ routes = async () => {} } = {}) => {
    const context = await browser.newContext();
    const changes = [];
    const reals = [];
    try {
        await routes(context);
        const stop = await serveAnswers(context, {
            book: answerBook(FROZEN.map((answer) => ({ ...answer, key: requestKey({ method: 'GET', url: `${base}/api/contacts` }) }))),
            isRead: (request) => (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/') ? { name: `GET ${new URL(request.url()).pathname}`, key: requestKey({ method: request.method(), url: request.url() }) } : null),
            onAnswer: ({ answer, real }) => {
                reals.push(real);
                changes.push(...answerChanges(answer, real));
            },
        });
        const page = await context.newPage();
        await page.goto(`${base}/`);
        await page.waitForFunction(() => document.getElementById('out').textContent !== '-' && document.body.dataset.saved !== undefined);
        const shown = await page.evaluate(() => [document.getElementById('out').textContent, document.body.dataset.saved]);
        await stop();
        return { shown, changes, reals };
    } finally {
        await context.close();
    }
};

test('fixed data: the app shows the frozen answer, the backend is still asked and its values do not matter; a write passes on', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    asked.length = 0;
    contacts = [{ id: 2, name: 'Other Live Person', city: 'Elsewhere' }, { id: 3, name: 'Third', city: 'Far' }];
    const { shown, changes, reals } = await visit();
    assert.deepEqual(shown, ['Frozen Person / Frozentown', 'saved']);
    assert.deepEqual(reals, [{ status: 200, json: contacts }], 'the real answer came back through Chrome (the name resolves only there)');
    assert.deepEqual(changes, [], 'other values, the same shape');
    assert.ok(asked.includes('GET /api/contacts'), 'the real request went out');
    assert.ok(asked.includes('POST /api/save'), 'what has no frozen answer goes to the backend');
});

test('fixed data: a backend whose answer has another shape is named, the app still gets the frozen answer', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    contacts = { items: [{ id: 2, fullName: 'Other Live Person' }] };
    const { shown, changes } = await visit();
    assert.equal(shown[0], 'Frozen Person / Frozentown');
    assert.deepEqual(changes, [{ change: 'kind', path: '/', was: 'array', now: 'object' }]);
});

test('fixed data: beside the host lock and a write block (Playwright routes) the write is held, the read still served and compared', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    asked.length = 0;
    contacts = [{ id: 4, name: 'Someone', city: 'Somewhere' }];
    const held = [];
    const { shown, changes, reals } = await visit({
        routes: async (context) => {
            await installHostLock(context, { navigation: [new URL(base).hostname] });
            await context.route((url) => /^https?:$/.test(url.protocol), async (route) => {
                if (route.request().method() === 'GET') return route.fallback();
                held.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
                return route.abort('blockedbyclient');
            });
        },
    });
    assert.deepEqual(shown, ['Frozen Person / Frozentown', 'held']);
    assert.deepEqual(held, ['POST /api/save']);
    assert.ok(!asked.includes('POST /api/save'), 'the held write never reached the backend');
    assert.ok(asked.includes('GET /api/contacts'), 'the real read went out');
    assert.deepEqual(reals, [{ status: 200, json: contacts }]);
    assert.deepEqual(changes, []);
});
