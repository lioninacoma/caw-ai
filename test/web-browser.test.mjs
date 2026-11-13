// The in-browser functions of the `web` adapter, against a real DOM in Chrome (headless). Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { webBusy, webPageState, webProbe } from '../src/host/framework/web.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;

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

test('web: shadow DOM also for marker, messages, form in dialog and counting', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(SHADOW_PARTS);
    const state = await page.evaluate(webPageState, { marker: '[data-testid=user-menu]', selectors: ['[role=alert]', '[role=status]'] });
    assert.equal(state.signedIn, true, 'marker in the shadow root');
    assert.deepEqual(state.notes, ['Ticket # gespeichert'], 'status in the shadow root is a note, with text from all parts');
    assert.deepEqual(state.messages, ['Wirklich löschen?'], 'the dialog with a field is regular use, its alert is a message');
    assert.equal((await page.evaluate(webProbe, '.zeile')).counts, 2, 'counting in shadow roots');
    const { webCount } = await import('../src/host/framework/web.mjs');
    assert.equal(await page.evaluate(webCount, null), null);
    return undefined;
});

