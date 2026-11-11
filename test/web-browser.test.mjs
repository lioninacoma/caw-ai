// The in-browser functions of the `web` adapter, against a real DOM in Chrome (headless). Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';


import { webBusy, webPageState, webProbe, webTargets } from '../src/host/framework/web.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;

const describe = (selector) => page.locator(selector).evaluate(webTargets, { mode: 'describe' });
const find = async (target) => {
    const handle = await page.evaluateHandle(`(${webTargets})(null, ${JSON.stringify({ mode: 'find', target })})`);
    return handle.asElement();
};

// A web component with an open shadow root, as Lit, Ionic or Angular with ViewEncapsulation.ShadowDom create them.
const SHADOW = `
<main>
  <section role="region" aria-label="Bestellung"><x-card id="a"></x-card></section>
  <section role="region" aria-label="Rechnung"><x-card id="b"></x-card></section>
</main>
<script>
customElements.define('x-card', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<div role="group" aria-label="Aktionen"><label for="f">Menge</label><input id="f"><button><span>Speichern</span></button></div>';
  }
});
</script>`;

test('web: describe and find targets in open shadow roots, tell identical buttons apart by their area', { skip: false }, async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(SHADOW);
    const second = page.locator('#b').locator('button span');
    const described = await second.evaluate(webTargets, { mode: 'describe' });
    assert.deepEqual(described, { role: 'button', name: 'Speichern', inside: { role: 'group', name: 'Aktionen' }, index: 1 }, 'a click on the inside belongs to the button');
    const field = await page.locator('#a').locator('input').evaluate(webTargets, { mode: 'describe' });
    assert.equal(field.name, 'Menge', 'label from the shadow root');
    const found = await find(described);
    assert.ok(found !== null, 'found again');
    assert.equal(await found.evaluate((node) => node.getRootNode().host.id), 'b');
    return undefined;
});

test('web: a select inside a label is named by the label, without its options', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<label>Customer <select id="c"><option>Acme</option><option>Globex</option></select></label>
<label for="p">Priority</label><select id="p"><option>Low</option></select>`);
    assert.equal((await describe('#c')).name, 'Customer');
    assert.equal((await describe('#p')).name, 'Priority');
    // When an option is added, the search still finds the field.
    await page.evaluate(() => document.querySelector('#c').append(new Option('Initech')));
    assert.ok(await find({ role: 'combobox', name: 'Customer' }));
    return undefined;
});

test('web: a covered button in a shadow root does not count as clickable', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`${SHADOW}<div style="position:fixed;inset:0;background:#fff"></div>`);
    assert.equal(await describe('#a'), null, 'nothing clickable');
    assert.equal(await find({ role: 'button', name: 'Speichern' }), null);
    return undefined;
});

test('web: indeterminate progress and aria-busy mean loading, also in a shadow root; determinate progress does not', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<div role="progressbar" aria-valuenow="40"></div><x-spin></x-spin><script>customElements.define("x-spin", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<div role=progressbar style=\'width:9px;height:9px\'></div>"; } });</script>');
    assert.equal(await page.evaluate(webBusy, {}), 1);
    const state = await page.evaluate(webPageState, { marker: 'body', selectors: ['[role=status]'] });
    assert.equal(state.loading, true);
    await page.setContent('<div role="progressbar" aria-valuenow="100"></div><div aria-busy="false"></div>');
    assert.equal(await page.evaluate(webBusy, {}), 0);
    return undefined;
});

test('web: DOM quiet only after domQuietMs; attributes do not count', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<ul id="l"></ul>');
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0, 'the first call only attaches the observer');
    await page.evaluate(() => { document.getElementById('l').append(document.createElement('li')); });
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 1, 'just rendered');
    await page.waitForTimeout(250);
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0);
    await page.evaluate(() => { document.getElementById('l').setAttribute('class', 'tick'); });
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0, 'attribute, e.g. an animation');
    return undefined;
});

test('web: status messages (toast, snackbar) as notes, digits as #; without a marker counts as signed in', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent('<div role="status">3 Einträge gespeichert</div><div role="status"></div>');
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]', '[role=status]'] });
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.notes, ['# Einträge gespeichert']);
    assert.equal(state.signedIn, true);
    return undefined;
});

test('web: a form in a dialog is not a message, an alert in it and a confirmation are', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<div role="dialog" aria-modal="true"><h2>Akte anlegen</h2><input aria-label="Name"><div role="alert">Diesen Namen trägt schon eine Akte.</div><button>Anlegen</button></div>
<div role="dialog" aria-modal="true"><p>Akte auflösen?</p><label><input type="checkbox"> Ich weiß</label><button>Auflösen</button></div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]'] });
    assert.deepEqual(state.messages, ['Akte auflösen? Ich weiß Auflösen', 'Diesen Namen trägt schon eine Akte.']);
    return undefined;
});

test('web: a toast stack yields one message per toast, a message with inline parts stays whole', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<div class="toasts" aria-live="polite"><div class="toast">„Akte 7“ ist angelegt.</div><div class="toast">Gespeichert</div></div>
<div role="alert"><b>Fehler:</b> <span>Name fehlt</span></div>
<div role="status"><div>EULA nicht angenommen. <a href="#e">EULA</a></div><div><button>Annehmen</button></div></div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]', '[role=status]', '[aria-live=polite]'] });
    assert.deepEqual(state.messages, ['Fehler: Name fehlt'], 'only the error can fail the step');
    assert.deepEqual(state.notes.sort(), ['EULA nicht angenommen. EULA Annehmen', 'Gespeichert', '„Akte #“ ist angelegt.']);
    return undefined;
});

test('web: why a target is not clickable: missing, invisible, or under a dialog with a message', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const explain = (target) => page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target })})`);
    await page.setContent(`<nav aria-label="Haupt"><a href="#e">Einstellungen</a><a href="#v" style="display:none">Versteckt</a></nav>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff8"><h2>Akte anlegen</h2><div role="alert">Diesen Namen trägt schon eine Akte.</div></div>`);
    assert.deepEqual(await explain({ role: 'link', name: 'Einstellungen' }), { covered: { role: 'dialog', name: 'Akte anlegen', messages: ['Diesen Namen trägt schon eine Akte.'] } });
    assert.deepEqual(await explain({ role: 'link', name: 'Versteckt' }), { hidden: true });
    // If it is missing entirely, the visible names of the same role come along; the host looks for a renamed target among them.
    assert.deepEqual(await explain({ role: 'link', name: 'Gibt es nicht' }), { missing: true, names: ['Einstellungen'] });
    // An invisible twin in another area explains nothing: the target itself is missing.
    await page.setContent(`<nav aria-label="Haupt"><a id="p" href="#p">Profil</a></nav><nav aria-label="Mobil"><a href="#p" style="display:none">Profil</a></nav>`);
    const described = await page.evaluate(`(${webTargets})(document.getElementById('p'), { mode: 'describe' })`);
    assert.ok(described.inside !== undefined, 'same name in another area: the target names its area');
    await page.evaluate(() => document.getElementById('p').remove());
    assert.deepEqual(await explain(described), { elsewhere: true });
    return undefined;
});

test('web: virtualized list, the search keeps scrolling until the row is in the DOM', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    // Only the visible rows are in the DOM, as with react-window or CDK Virtual Scroll.
    await page.setContent(`<div id="v" role="list" aria-label="Akten" style="height:100px;overflow:auto"><div id="s" style="height:20000px;position:relative"></div></div>
<script>
const v = document.getElementById('v'); const s = document.getElementById('s');
const draw = () => { const first = Math.floor(v.scrollTop / 20); s.innerHTML = Array.from({ length: 6 }, (_, i) => first + i).map((n) => '<div role="listitem" style="position:absolute;top:' + n * 20 + 'px;height:20px">Akte ' + n + ' <button>Öffnen</button></div>').join(''); };
v.addEventListener('scroll', draw); draw();
</script>`);
    const target = { role: 'button', name: 'Öffnen', inside: { role: 'listitem', name: 'Akte 300 Öffnen' } };
    let found = null;
    for (let tries = 0; tries < 200 && found === null; tries += 1) {
        found = (await page.evaluateHandle(`(${webTargets})(null, ${JSON.stringify({ mode: 'find', target })})`)).asElement();
        // Let it redraw first: otherwise on slow machines the search scrolls several times before the list catches up and skips row 300.
        if (found === null) await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));
    }
    assert.ok(found !== null, 'row 300 reached');
    assert.match(await found.evaluate((node) => node.parentElement.textContent), /Akte 300/);
    return undefined;
});

test('web: a name pattern matches a changing number, an area and a name over 80 characters', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const long = `Max Mustermann — Person, abgedeckt als <PERSON_1> ${'und noch mehr Text '.repeat(4)}`;
    await page.setContent(`<div role="toolbar" aria-label="Dokumente 12"><button id="p">Prüfen 3</button></div><button id="l">${long}</button>`);
    const id = async (target) => (await find(target))?.evaluate((node) => node.id) ?? null;
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen( \\d+)?$' } }), 'p');
    assert.equal(await id({ role: 'button', name: 'Prüfen' }), null, 'a fixed name stays exact');
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen' }, inside: { role: 'toolbar', name: { pattern: '^Dokumente \\d+$' } } }), 'p');
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen' }, inside: { role: 'toolbar', name: { pattern: '^Akten' } } }), null);
    assert.equal(await id({ role: 'button', name: { pattern: '^Max Mustermann — Person' } }), 'l', 'the pattern sees the whole name');
    assert.equal(await id({ role: 'button', name: long.trim() }), null, 'as a fixed name it is too long');
    return undefined;
});

test('web: a message over 300 characters comes whole, so it matches its entry in knownMessages', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const text = `Prüfung abschließen. ${'Ein langer Satz im Dialog. '.repeat(15)}Freigeben`;
    await page.setContent(`<div role="alertdialog">${text}</div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: [] });
    assert.deepEqual(state.messages, [text.replace(/\s+/g, ' ').trim()]);
    assert.ok(state.messages[0].length > 300);
    return undefined;
});

// Web components like Shoelace or Ionic: label around the field, message and marker in the shadow root, dialog as a web component.
const SHADOW_PARTS = `
<x-field id="feld"></x-field>
<x-menu></x-menu>
<x-toast></x-toast>
<ul><x-row></x-row><x-row></x-row></ul>
<x-dialog></x-dialog>
<script>
const define = (name, html) => customElements.define(name, class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = html; } });
define('x-field', '<label>Betrag <input id="i"></label>');
define('x-menu', '<nav data-testid="user-menu">Konto</nav>');
define('x-toast', '<div role="status">Ticket <b>4</b> gespeichert</div>');
define('x-row', '<li class="zeile">Zeile</li>');
define('x-dialog', '<div role="dialog" aria-modal="true" aria-label="Rückfrage"><p role="alert">Wirklich löschen?</p><input></div>');
</script>`;

test('web: shadow DOM also for label, marker, messages, form in dialog and counting', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(SHADOW_PARTS);
    const field = await page.locator('#feld').locator('input').evaluate(webTargets, { mode: 'describe' });
    assert.equal(field.name, 'Betrag', 'enclosing label in the shadow root');
    const state = await page.evaluate(webPageState, { marker: '[data-testid=user-menu]', selectors: ['[role=alert]', '[role=status]'] });
    assert.equal(state.signedIn, true, 'marker in the shadow root');
    assert.deepEqual(state.notes, ['Ticket # gespeichert'], 'status in the shadow root is a note, with text from all parts');
    assert.deepEqual(state.messages, ['Wirklich löschen?'], 'the dialog with a field is regular use, its alert is a message');
    assert.equal((await page.evaluate(webProbe, '.zeile')).counts, 2, 'counting in shadow roots');
    const { webCount } = await import('../src/host/framework/web.mjs');
    assert.equal(await page.evaluate(webCount, null), null);
    return undefined;
});

test('web: a dialog web component over a button reports name and message', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<button>Speichern</button>
<x-modal></x-modal>
<script>customElements.define('x-modal', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><h2>Hinweis</h2><p role="alert">Sitzung läuft ab</p></div>'; } });</script>`);
    const why = await page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target: { role: 'button', name: 'Speichern' } })})`);
    assert.deepEqual(why, { covered: { role: 'dialog', name: 'Hinweis', messages: ['Sitzung läuft ab'] } });
    return undefined;
});

test('web: searching for a target outside the viewport leaves the page where it was', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setViewportSize({ width: 800, height: 400 });
    await page.setContent('<button>Oben</button><div style="height:3000px"></div><button>Unten</button>');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    assert.ok(scrolled > 1000);
    assert.ok(await find({ role: 'button', name: 'Oben' }) !== null, 'found');
    assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'no jump to the top');
    const explain = (target) => page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target })})`);
    await explain({ role: 'button', name: 'Oben' });
    assert.equal(await page.evaluate(() => window.scrollY), scrolled, 'not when explaining either');
    return undefined;
});
