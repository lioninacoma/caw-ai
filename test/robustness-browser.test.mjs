// Robustness in real Chrome (headless, skipped without Chrome): no sign-in in the trace, readiness on live-updating pages,
// ambiguous targets.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';


import { createTrace } from '../src/host/browser-session.mjs';
import { waitForTarget, waitQuiet } from '../src/host/framework/index.mjs';
import { web, webTargets } from '../src/host/framework/web.mjs';
import { playReplay } from '../src/host/replay.mjs';
import { launchChrome } from './chrome.mjs';

const PASSWORD = 'Hunter2-SuperSecret';
let browser = null;
let server = null;
let base = '';
before(async () => {
    browser = await launchChrome();
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            res.setHeader('content-type', 'text/html');
            if (req.method === 'POST') res.end(`<p id="done">signed in ${body.length}</p>`);
            else res.end('<p id="app">Application</p><form method="post" action="/login"><input name="user"><input type="password" name="password"><button>Sign in</button></form>');
        });
    });
    await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await browser?.close();
    server?.close();
});

/** How often `needle` appears in the entries of a zip, read via its central directory (Playwright writes data descriptors). */
const countInZip = (file, needle) => {
    const buffer = readFileSync(file);
    const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let at = buffer.readUInt32LE(end + 16);
    let count = 0;
    for (let entry = buffer.readUInt16LE(end + 10); entry > 0; entry -= 1) {
        const method = buffer.readUInt16LE(at + 10);
        const size = buffer.readUInt32LE(at + 20);
        const offset = buffer.readUInt32LE(at + 42);
        at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
        const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
        const data = buffer.subarray(start, start + size);
        count += (method === 8 ? inflateRawSync(data) : data).toString('latin1').split(needle).length - 1;
    }
    return count;
};

test('trace: a sign-in after the start is paused out of the trace, before and after are kept', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const dir = mkdtempSync(join(tmpdir(), 'caw-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const context = await browser.newContext();
    const page = await context.newPage();
    const trace = createTrace(context, { path: join(dir, 'trace.zip'), options: { screenshots: true, snapshots: true } });
    await trace.start();
    await page.goto(base);
    await trace.pause(async () => {
        await page.fill('input[name=user]', 'tester');
        await page.fill('input[type=password]', PASSWORD);
        await Promise.all([page.waitForSelector('#done'), page.click('button')]);
    });
    await page.goto(base);
    await page.click('#app');
    await trace.stop();
    await context.close();
    assert.equal(trace.parts(), 1);
    assert.deepEqual(readdirSync(dir).sort(), ['trace-1.zip', 'trace.zip']);
    for (const name of ['trace-1.zip', 'trace.zip']) assert.equal(countInZip(join(dir, name), PASSWORD), 0, name);
    assert.ok(countInZip(join(dir, 'trace.zip'), 'Application') > 0, 'what follows the sign-in is traced');
});

test('readiness: a ticker and a permanent spinner settle with readyIgnore; spinners outside the view never count', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent('<main>Form</main><footer id="live"><span id="tick"></span><div role="progressbar" style="width:20px;height:20px"></div></footer><script>setInterval(() => { document.getElementById("tick").textContent = Date.now(); }, 50);</script>');
    assert.equal((await waitQuiet(web, page, { timeout: 1200 })).settled, false, 'without readyIgnore it never settles');
    assert.equal((await waitQuiet(web, page, { timeout: 3000, ignore: ['#live'] })).settled, true);
    assert.equal((await waitQuiet(web, page, { timeout: 3000, ignore: ['#live', '[[invalid'] })).settled, true, 'an invalid selector does not block');

    await page.setContent('<main>Form</main><div role="progressbar"></div><div role="progressbar" style="position:absolute;top:5000px;width:20px;height:20px"></div><div role="progressbar" style="width:20px;height:20px;visibility:hidden"></div>');
    assert.equal((await waitQuiet(web, page, { timeout: 3000 })).settled, true, 'no size, below the viewport, hidden');
    await page.setContent('<main>Form</main><div role="progressbar" style="width:20px;height:20px"></div>');
    assert.equal((await waitQuiet(web, page, { timeout: 800 })).settled, false, 'a visible spinner still counts');
});

const TWINS = '<div><p>Invoice 17</p><button>Delete</button></div><div><p>Invoice 18</p><button>Delete</button></div><p id="out"></p><script>document.querySelectorAll("button").forEach((b, i) => b.addEventListener("click", () => { document.getElementById("out").textContent = "deleted " + i; }));</script>';

test('ambiguity: describing stores the index whenever several match; finding reports the candidates', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(TWINS);
    const first = await page.locator('button').first().evaluate(webTargets, { mode: 'describe' });
    const second = await page.locator('button').nth(1).evaluate(webTargets, { mode: 'describe' });
    assert.equal(first.index, 0, 'the first of two gets index 0');
    assert.equal(second.index, 1);
    await page.setContent('<button>Alone</button>');
    assert.equal((await page.locator('button').evaluate(webTargets, { mode: 'describe' })).index, undefined, 'a unique target stays without index');

    await page.setContent(TWINS);
    const target = { role: 'button', name: 'Delete' };
    const report = {};
    assert.equal(await waitForTarget(web, page, target, { timeoutMs: 5000, unique: 'fail', report }), null);
    assert.equal(report.ambiguous.count, 2);
    assert.deepEqual(report.ambiguous.candidates.map(({ near }) => near), ['Invoice 17', 'Invoice 18']);
    const warned = {};
    assert.notEqual(await waitForTarget(web, page, target, { timeoutMs: 1000, unique: 'warn', report: warned }), null);
    assert.equal(warned.ambiguous.count, 2);
    const chosen = {};
    assert.notEqual(await waitForTarget(web, page, { ...target, index: 1 }, { timeoutMs: 1000, unique: 'fail', report: chosen }), null);
    assert.equal(chosen.ambiguous, undefined);
});

test('ambiguity on replay: a new recording fails with candidates, an old one takes the first with a warning', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const page = await browser.newPage();
    t.after(() => page.close());
    const play = async (unique) => {
        await page.setContent(TWINS);
        const warnings = [];
        const session = { page: () => page, framework: web, waitReady: async () => ({ settled: true }), warn: (entry) => warnings.push(entry) };
        const handler = async (command) => (command.action === 'check' ? { pass: true, value: true } : command.action === 'screenshot' ? undefined : 'ok');
        const steps = [{ action: 'click', target: { role: 'button', name: 'Delete' }, ...(unique ? { unique: true } : {}) }, { action: 'check', id: 'S1', code: 'true' }];
        const outcome = await playReplay({ replay: { steps }, handler, session, base, stepTimeoutMs: 5000 });
        return { ...outcome, warnings, out: await page.textContent('#out') };
    };
    const strict = await play(true);
    assert.equal(strict.broken.kind, 'target');
    assert.match(strict.broken.message, /trifft 2 Elemente.*Invoice 17.*Invoice 18/);
    assert.equal(strict.out, '', 'nothing was clicked');
    const old = await play(false);
    assert.equal(old.broken, null);
    assert.equal(old.out, 'deleted 0');
    assert.match(old.warnings.map(({ text }) => text).join(' '), /trifft 2 Elemente; die Wiedergabe nahm wie bisher das erste/);
});
