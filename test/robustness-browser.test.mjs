// Robustness in real Chrome (headless, skipped without Chrome): no sign-in in the trace, readiness on live-updating pages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';


import { createTrace } from '../src/host/browser-session.mjs';
import { basicAuthToken } from '../src/host/trace-scrub.mjs';
import { waitQuiet } from '../src/host/framework/index.mjs';
import { web } from '../src/host/framework/web.mjs';
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

test('trace: Basic credentials in the context options are masked in the saved trace, the trace stays readable', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const dir = mkdtempSync(join(tmpdir(), 'caw-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const context = await browser.newContext({ httpCredentials: { username: 'gate.user', password: PASSWORD, origin: base } });
    const page = await context.newPage();
    const raw = createTrace(context, { path: join(dir, 'raw.zip'), options: { screenshots: false, snapshots: false } });
    await raw.start();
    await page.goto(base);
    await raw.stop();
    assert.ok(countInZip(join(dir, 'raw.zip'), PASSWORD) > 0, 'without secrets Playwright keeps the password (the case this guards)');
    const trace = createTrace(context, { path: join(dir, 'trace.zip'), options: { screenshots: true, snapshots: true }, secrets: () => [PASSWORD] });
    await trace.start();
    await page.goto(base);
    await page.click('#app');
    await trace.stop();
    await context.close();
    assert.equal(countInZip(join(dir, 'trace.zip'), PASSWORD), 0);
    assert.ok(countInZip(join(dir, 'trace.zip'), 'gate.user') > 0, 'the rest of the options is kept');
    assert.ok(countInZip(join(dir, 'trace.zip'), 'Application') > 0, 'the page is still in the trace');
});

test('trace: a gate\'s Authorization header (base64 of user:password) is masked too, with snapshots on', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const dir = mkdtempSync(join(tmpdir(), 'caw-trace-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // A gate: 401 with a Basic challenge until the browser sends the credentials.
    const gate = createServer((req, res) => {
        if (req.headers.authorization === undefined) {
            res.writeHead(401, { 'www-authenticate': 'Basic realm="gate"' });
            res.end();
            return;
        }
        res.setHeader('content-type', 'text/html');
        res.end('<p id="app">Application</p><script>fetch("/api/data")</script>');
    });
    await new Promise((ok) => { gate.listen(0, '127.0.0.1', ok); });
    t.after(() => gate.close());
    const gateBase = `http://127.0.0.1:${gate.address().port}`;
    const token = basicAuthToken('gate.user', PASSWORD);
    const run = async (name, secrets) => {
        const context = await browser.newContext({ httpCredentials: { username: 'gate.user', password: PASSWORD, origin: gateBase } });
        const page = await context.newPage();
        const trace = createTrace(context, { path: join(dir, name), options: { screenshots: false, snapshots: true }, secrets: () => secrets });
        await trace.start();
        await page.goto(gateBase);
        await page.waitForLoadState('networkidle');
        await trace.stop();
        await context.close();
    };
    await run('plain.zip', [PASSWORD]);
    assert.ok(countInZip(join(dir, 'plain.zip'), token) > 0, 'masking the password alone leaves the encoded header (the case this guards)');
    await run('trace.zip', [PASSWORD, token]);
    assert.equal(countInZip(join(dir, 'trace.zip'), token), 0);
    assert.equal(countInZip(join(dir, 'trace.zip'), PASSWORD), 0);
    assert.ok(countInZip(join(dir, 'trace.zip'), 'Application') > 0, 'the snapshots stay');
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
