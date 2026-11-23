// Design snapshots (design-snapshot.mjs): the app's screen as a static design page with its own stylesheets, fonts and images
// as files under caw/design/assets, rendered offline from there. Real Chrome; skipped without it.
/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { compareDetailed, createDesignJudge, renderDesign, structureOf, writeDesign } from '../src/host/design.mjs';
import { assetsDirOf, snapshotName, snapshotOf, writeSnapshot } from '../src/host/design-snapshot.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
before(async () => {
    browser = await launchChrome();
});
after(async () => {
    await browser?.close();
});
const needsChrome = () => browser === null;

const tempCaw = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-snapshot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const FONT = readFileSync(new URL('../assets/fonts/geist-mono.woff2', import.meta.url));
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ORIGIN = 'http://app.test';
// The app: a linked stylesheet with a font and a background image, @import, a rule a script inserts, a script that would change
// the page, fields filled by the person, a password and a hidden field.
const APP = {
    '/screen': ['text/html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title>
<link rel="stylesheet" href="/css/app.css"><link rel="icon" href="/favicon.ico"><style id="dynamic"></style>
<script>document.getElementById('dynamic').sheet.insertRule('.btn{color:rgb(1, 2, 3)}');</script></head>
<body class="x-body"><main class="panel"><h1 class="title">Order</h1>
<label>Name <input id="name"></label><label>Secret <input id="pw" type="password"></label><input type="hidden" name="csrf" value="token-123">
<label><input type="checkbox" id="ok"> Agree</label><label>When <select id="when"><option>Today</option><option>Tomorrow</option></select></label>
<label>Note <textarea id="note"></textarea></label><img class="logo" src="/img/logo.png" alt="Logo" srcset="/img/logo.png 2x">
<button class="btn" onclick="document.title = 'x'">Save</button></main>
<script>document.body.dataset.ran = 'yes';</script></body></html>`],
    '/css/app.css': ['text/css', `@import url("base.css");
@font-face { font-family: AppMono; src: url("../fonts/app-mono.woff2") format("woff2"); }
.panel { background: url(../img/dot.png); padding: 12px; }
.title { font-family: AppMono, monospace; font-size: 26px; }`],
    '/css/base.css': ['text/css', 'body { margin: 0; color: rgb(10, 20, 30); }'],
    '/fonts/app-mono.woff2': ['font/woff2', FONT],
    '/img/dot.png': ['image/png', PNG],
    '/img/logo.png': ['image/png', PNG],
};

/** The app's screen with the fields filled, on a route that answers from APP (no server, no network). */
const openApp = async (viewport = { width: 800, height: 600 }) => {
    const context = await browser.newContext({ viewport });
    await context.route(`${ORIGIN}/**`, (route) => {
        const found = APP[new URL(route.request().url()).pathname];
        return found === undefined ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: found[0], body: found[1] });
    });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/screen`);
    await page.evaluate(() => document.fonts.ready);
    await page.fill('#name', 'Ada');
    await page.fill('#pw', 'hunter2');
    await page.check('#ok');
    await page.selectOption('#when', 'Tomorrow');
    await page.fill('#note', 'Bring seeds');
    return page;
};

test('snapshot names: design/<name>.html, not under assets/, plain segments', () => {
    assert.equal(snapshotName('order-form'), 'design/order-form.html');
    assert.equal(snapshotName('design/screens/order.html'), 'design/screens/order.html');
    assert.equal(snapshotName('first-errand-S4'), 'design/first-errand-S4.html');
    for (const name of ['', '../x', 'a/../b', 'assets/x', 'design/assets/x.html', 'a\\b', '.hidden']) assert.equal(snapshotName(name), null, name);
    assert.equal(assetsDirOf('design/order-form.html'), 'design/assets/order-form');
    assert.equal(assetsDirOf('design/screens/order.html'), 'design/assets/screens/order');
});

test('caw design: only snapshot, always with a step, a plain name; nothing is loaded before', async (t) => {
    const { design } = await import('../src/host/commands.mjs');
    const root = tempCaw(t);
    for (const [args, pattern] of [
        [['shot', 'order@S2'], /design kennt snapshot/],
        [[], /design kennt snapshot/],
        [['snapshot', 'order'], /braucht einen Schritt: caw design snapshot order@S2/],
        [['snapshot', 'order@S2', '--name', 'assets/x'], /kein Name für eine Entwurfsseite/],
        [['snapshot', 'order@S2', '--role', 'admin'], /--role/],
    ]) {
        await assert.rejects(design(root, args), (error) => error.code === 'usage' && pattern.test(error.message), args.join(' '));
    }
});

test('snapshot: static page without scripts, fields frozen (no password, no hidden value), the app\'s stylesheets, font and images as files', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    const page = await openApp();
    try {
        const taken = await snapshotOf(page, 'design/order.html', { secrets: ['Ada-secret'] });
        const written = writeSnapshot(caw, 'design/order.html', taken);
        const html = readFileSync(join(caw, 'design/order.html'), 'utf8');
        assert.doesNotMatch(html, /<script|onclick|favicon|srcset/i);
        assert.match(html, /id="name" value="Ada"/);
        assert.doesNotMatch(html, /hunter2|token-123/);
        assert.match(html, /id="ok" checked=""/);
        assert.match(html, /<option selected="">Tomorrow<\/option>/);
        assert.match(html, /<textarea id="note">Bring seeds<\/textarea>/);
        assert.match(html, /<link rel="stylesheet" href="assets\/order\/sheet-1\.css">/);
        assert.match(html, /\.btn \{ color: rgb\(1, 2, 3\); \}/, 'a rule a script inserted is kept');
        assert.match(html, /src="assets\/order\/\d+-logo\.png"/);
        const files = readdirSync(join(caw, 'design/assets/order')).sort();
        assert.equal(files.length, 4, files.join(', '));
        assert.equal(written.assets, 4);
        const css = readFileSync(join(caw, 'design/assets/order/sheet-1.css'), 'utf8');
        assert.match(css, /body \{ margin: 0px; color: rgb\(10, 20, 30\); \}/, '@import resolved in place');
        assert.match(css, /url\("\d+-app-mono\.woff2"\)/);
        assert.match(css, /url\("\d+-dot\.png"\)/);
        assert.deepEqual(taken.notes, []);
    } finally {
        await page.context().close();
    }
});

test('snapshot: rendered offline from caw/design it looks like the app and meets it with no deviation', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    const page = await openApp();
    try {
        const file = 'design/order.html';
        const taken = await snapshotOf(page, file);
        writeSnapshot(caw, file, taken);
        const rendered = await renderDesign(browser, readFileSync(join(caw, file), 'utf8'), { width: 800, height: 600 }, { cawDir: caw, file });
        try {
            const look = await rendered.evaluate(() => document.fonts.ready.then(() => ({
                fonts: [...document.fonts].map((face) => `${face.family} ${face.status}`),
                color: getComputedStyle(document.body).color,
                button: getComputedStyle(document.querySelector('.btn')).color,
                background: getComputedStyle(document.querySelector('.panel')).backgroundImage,
                logo: document.querySelector('.logo').naturalWidth,
                scripts: document.scripts.length,
            })));
            assert.deepEqual(look.fonts, ['AppMono loaded']);
            assert.equal(look.color, 'rgb(10, 20, 30)');
            assert.equal(look.button, 'rgb(1, 2, 3)');
            assert.match(look.background, /^url\("http:\/\/design\.caw\.invalid\/design\/assets\/order\/\d+-dot\.png"\)$/);
            assert.equal(look.logo, 1);
            assert.equal(look.scripts, 0);
            const found = compareDetailed(await structureOf(rendered), await structureOf(page));
            assert.deepEqual(found.deviations, []);
            assert.equal(found.met, true);
        } finally {
            await rendered.context().close();
        }
    } finally {
        await page.context().close();
    }
});

test('snapshot again: files of the earlier snapshot that are no longer needed go', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    mkdirSync(join(caw, 'design/assets/order'), { recursive: true });
    writeFileSync(join(caw, 'design/assets/order/99-old.png'), PNG);
    const page = await openApp();
    try {
        writeSnapshot(caw, 'design/order.html', await snapshotOf(page, 'design/order.html'));
        assert.equal(existsSync(join(caw, 'design/assets/order/99-old.png')), false);
    } finally {
        await page.context().close();
    }
});

test('rendered with its file: only files under caw/design are served, of the kinds a design needs', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    mkdirSync(join(caw, 'design/assets/x'), { recursive: true });
    mkdirSync(join(caw, 'tests'), { recursive: true });
    writeFileSync(join(caw, 'design/assets/x/a.css'), '.a{color:rgb(255, 0, 0)}');
    writeFileSync(join(caw, 'design/assets/x/b.js'), 'document.title = "ran"');
    writeFileSync(join(caw, 'tests/c.css'), '.c{color:rgb(0, 255, 0)}');
    const html = '<!doctype html><link rel="stylesheet" href="assets/x/a.css"><link rel="stylesheet" href="../tests/c.css"><script src="assets/x/b.js"></script><p class="a">A</p><p class="c">C</p>';
    const page = await renderDesign(browser, html, undefined, { cawDir: caw, file: 'design/x.html' });
    try {
        const seen = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => getComputedStyle(p).color));
        assert.deepEqual(seen, ['rgb(255, 0, 0)', 'rgb(0, 0, 0)']);
        assert.notEqual(await page.title(), 'ran');
    } finally {
        await page.context().close();
    }
});

// A click's ripple as ExtJS Material draws it: an element whose animation ends invisible and stays in the DOM.
const RIPPLE = `<!doctype html><html><head><style>
body{margin:0;font-family:Arial,sans-serif}.btn{position:relative;display:inline-block;margin:20px;padding:8px 16px;background:#2196f3;color:#fff}
.ripple{position:absolute;left:4px;top:4px;width:18px;height:18px;border-radius:50%;background:rgba(17,17,17,.4);animation:fade 400ms forwards}
@keyframes fade{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(4)}}
.line{height:1px;margin:12px 20px;background:#e2e2e2}
</style></head><body><h1>Order</h1><div class="btn">Save<div class="ripple"></div></div><div class="line"></div><p>Title</p><div class="line"></div><p>Note</p></body></html>`;

test('snapshot: an animation that ends invisible (a ripple) is taken at its end and stays there when the design is rendered', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    try {
        const page = await context.newPage();
        await page.setContent(RIPPLE);
        const file = 'design/ripple.html';
        writeSnapshot(caw, file, await snapshotOf(page, file));
        const rendered = await renderDesign(browser, readFileSync(join(caw, file), 'utf8'), { width: 600, height: 400 }, { cawDir: caw, file });
        try {
            const found = compareDetailed(await structureOf(rendered), await structureOf(page));
            assert.deepEqual(found.deviations, []);
        } finally {
            await rendered.context().close();
        }
    } finally {
        await context.close();
    }
});

test('the judge measures the app once it settled: a colour still animating is not a deviation', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    writeDesign(caw, 'design/order.html', Buffer.from('<!doctype html><html><head><style>body{margin:0;font-family:Arial,sans-serif}h1{color:rgb(0,0,0)}</style></head><body><h1>Order</h1></body></html>'));
    const judge = createDesignJudge({ cawDir: caw, launch: launchChrome, read: (path) => readFileSync(path, 'utf8') });
    const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><html><head><style>body{margin:0;font-family:Arial,sans-serif}h1{animation:ink 2500ms forwards}@keyframes ink{from{color:rgb(255,0,0)}to{color:rgb(0,0,0)}}</style></head><body><h1>Order</h1></body></html>');
        const judged = await judge.judge({ file: 'design/order.html', viewport: { width: 600, height: 400 } }, page);
        assert.equal(judged.verdict, 'met', JSON.stringify(judged.styleDiffs));
    } finally {
        await context.close();
        await judge.close();
    }
});
