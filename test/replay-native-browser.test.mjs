// Replay with native locators in real Chrome (headless): strict with tolerance for dialog transitions, virtual lists, nested
// frames, shadow DOM, the application inside the workbench frame, and why a target was not clickable. Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { frameView } from '../src/host/app-view.mjs';
import { AMBIGUOUS_MS, explainLocator, explainText, frameworkOf, waitForLocator } from '../src/host/framework/index.mjs';
import { playReplay } from '../src/host/replay.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage({ viewport: { width: 1000, height: 700 } });
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;
const web = frameworkOf();

/** Plays steps against `view` (the page, or the application's frame view in the workbench); checks run in its main frame. */
const play = (steps, { view = page, stepTimeoutMs = 5000 } = {}) => playReplay({
    replay: { steps },
    handler: async (command) => {
        if (command.action !== 'check') return 'ok';
        const value = await view.mainFrame().evaluate(command.code);
        return { pass: value === true, value };
    },
    session: { page: () => view, waitReady: async () => ({ settled: true }) },
    base: 'https://caw.test',
    stepTimeoutMs,
});
const click = (target) => ({ action: 'click', target });
const check = (code) => ({ action: 'check', id: 'S1', code });

// A wizard: "Next" opens the next dialog at once, while the old one still fades out next to it for 600 ms.
const WIZARD = `<style>dialog { position: fixed; margin: 0; top: 40px; } #d2 { left: 400px; } #d3 { left: 700px; }</style>
<button id="start" onclick="document.getElementById('d1').show()">Start</button>
<dialog id="d1" style="left:40px"><button onclick="go(this, 'd2')">Next</button></dialog>
<dialog id="d2"><button onclick="go(this, 'd3')">Next</button></dialog>
<dialog id="d3"><button onclick="document.title = 'wizard done'">Next</button></dialog>
<script>function go(button, next) { const old = button.closest('dialog'); document.getElementById(next).show(); setTimeout(() => old.close(), 600); }</script>`;

test('replay: two matches during a dialog transition are tolerated; a true twin fails after the grace with its candidates', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(WIZARD);
    await page.click('#start');
    const next = "getByRole('button', { name: 'Next', exact: true })";
    const wizard = await play([click(next), click(next), click(next), check("document.title === 'wizard done'")]);
    assert.equal(wizard.broken, null, wizard.broken?.message);
    assert.equal(wizard.results.get('S1').status, 'pass');

    await page.setContent('<div><p>Invoice 17</p><button>Delete</button></div><div><p>Invoice 18</p><button>Delete</button></div>');
    const start = Date.now();
    const twin = await play([click("getByRole('button', { name: 'Delete', exact: true })"), check('true')]);
    const waited = Date.now() - start;
    assert.equal(twin.broken.kind, 'target');
    assert.match(twin.broken.message, /trifft 2 Elemente.*#1 bei \d+,\d+ neben "Invoice 17"; #2 bei \d+,\d+ neben "Invoice 18"/);
    assert.ok(waited >= AMBIGUOUS_MS && waited < 4500, `after the grace, not the timeout: ${waited} ms`);
    return undefined;
});

test('replay: a covered match does not count, the free one is clicked; the topmost dialog wins', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<button onclick="document.title = 'form'">Speichern</button>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><button onclick="document.title = 'sheet'">Speichern</button></div>`);
    const { broken } = await play([click("getByRole('button', { name: 'Speichern', exact: true })"), check("document.title === 'sheet'")]);
    assert.equal(broken, null, broken?.message);
    return undefined;
});

test('replay: a virtual list is scrolled until the entry exists', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    // Only the visible rows are in the DOM, as with react-window or CDK Virtual Scroll.
    await page.setContent(`<div id="v" role="list" aria-label="Akten" style="height:400px;overflow:auto"><div id="s" style="height:20000px;position:relative"></div></div>
<script>
const v = document.getElementById('v'); const s = document.getElementById('s');
const draw = () => { const first = Math.floor(v.scrollTop / 20); s.innerHTML = Array.from({ length: 22 }, (_, i) => first + i).map((n) => '<div role="listitem" style="position:absolute;top:' + n * 20 + 'px;height:20px">Akte ' + n + ' <button onclick="document.title = \\'Akte ' + n + '\\'">Öffnen</button></div>').join(''); };
v.addEventListener('scroll', draw); draw();
</script>`);
    const { broken } = await play([click("getByRole('listitem').filter({ hasText: 'Akte 300 ' }).getByRole('button', { name: 'Öffnen', exact: true })"), check("document.title === 'Akte 300'")], { stepTimeoutMs: 20000 });
    assert.equal(broken, null, broken?.message);
    return undefined;
});

const FRAMES = `<x-rating></x-rating>
<script>
customElements.define('x-rating', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.title = \\'bewertet\\'">Bewerten</button>'; } });
const pay = document.createElement('iframe');
pay.title = 'Zahlung';
pay.style.cssText = 'width:600px;height:300px';
pay.srcdoc = '<label>Betrag <input></label><iframe title="Bank"></iframe>';
pay.onload = () => { pay.contentDocument.querySelector('iframe').srcdoc = '<button onclick="top.document.title = \\'bezahlt\\'">Bestätigen</button>'; };
document.body.append(pay);
</script>`;

test('replay: nested frames and an open shadow root; a missing frame is named', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(FRAMES);
    const amount = "locator('iframe[title=\"Zahlung\"]').contentFrame().getByRole('textbox', { name: 'Betrag', exact: true })";
    const confirm = "locator('iframe[title=\"Zahlung\"]').contentFrame().locator('iframe[title=\"Bank\"]').contentFrame().getByRole('button', { name: 'Bestätigen', exact: true })";
    const nested = await play([{ action: 'fill', target: amount, value: '12' }, click(confirm), check("document.title === 'bezahlt'")]);
    assert.equal(nested.broken, null, nested.broken?.message);
    assert.equal(await page.frameLocator('iframe[title="Zahlung"]').getByRole('textbox').inputValue(), '12');
    const shadow = await play([click("getByRole('button', { name: 'Bewerten', exact: true })"), check("document.title === 'bewertet'")]);
    assert.equal(shadow.broken, null, shadow.broken?.message);
    const gone = await play([click("locator('iframe[title=\"Kasse\"]').contentFrame().getByRole('button', { name: 'Bestätigen', exact: true })"), check('true')], { stepTimeoutMs: 1000 });
    assert.match(gone.broken.message, /Der Frame iframe "Kasse" fehlt auf der Seite/);
    assert.deepEqual(gone.broken.blocker, { frameMissing: 'iframe "Kasse"' });
    return undefined;
});

test('replay: in the workbench the locator starts at the application\'s frame, not at the workbench', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const app = '<button onclick="document.title = \'app\'">Speichern</button>';
    await page.setContent(`<button onclick="document.title = 'workbench'">Speichern</button><iframe name="caw-app" srcdoc="${app.replace(/"/g, '&quot;')}"></iframe>`);
    const frame = page.frame({ name: 'caw-app' });
    await frame.getByRole('button').waitFor();
    const view = frameView(page, frame);
    const { broken } = await play([click("getByRole('button', { name: 'Speichern', exact: true })"), check("document.title === 'app'")], { view });
    assert.equal(broken, null, broken?.message);
    assert.equal(await page.title(), '', 'the workbench\'s twin was not touched');
    return undefined;
});

test('explain: covered by a dialog with its message, hidden, or missing with a similar name', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<button>Delete all</button><button style="display:none">Hidden action</button>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff8"><h2>Hinweis</h2><p role="alert">Sitzung abgelaufen.</p></div>`);
    const root = page.mainFrame();
    const covered = await explainLocator(web, root, "getByRole('button', { name: 'Delete all', exact: true })");
    assert.deepEqual(covered, { covered: { role: 'dialog', name: 'Hinweis', messages: ['Sitzung abgelaufen.'] } });
    assert.match(explainText(covered), /verdeckt von dialog "Hinweis", der meldet: "Sitzung abgelaufen\."/);
    assert.deepEqual(await explainLocator(web, root, "getByRole('button', { name: 'Hidden action', exact: true })"), { hidden: true });
    const renamed = await explainLocator(web, root, "getByRole('button', { name: 'Delete everything', exact: true })");
    assert.deepEqual(renamed, { missing: true, similar: [{ role: 'button', name: 'Delete all' }] });
    assert.match(explainText(renamed), /Ähnlich: button "Delete all"/);
    // The whole replay step says so too, and hands the blocker to the diagnosis.
    const { broken } = await play([click("getByRole('button', { name: 'Delete all', exact: true })"), check('true')], { stepTimeoutMs: 800 });
    assert.equal(broken.kind, 'target');
    assert.deepEqual(broken.blocker, covered);
    // Waiting never moves the page: checking whether an element is free restores the scroll position.
    await page.setContent('<button>Oben</button><div style="height:3000px"></div><button>Unten</button>');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    const { element } = await waitForLocator(web, root, "getByRole('button', { name: 'Oben', exact: true })", { timeoutMs: 1000 });
    assert.ok(element !== null);
    await element.dispose();
    assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'no jump to the top');
    return undefined;
});
