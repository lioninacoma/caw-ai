// Die Funktionen des Adapters `web`, die im Browser laufen, gegen echtes DOM in Chrome (headless). Ohne Chrome uebersprungen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { webBusy, webPageState, webProbe, webTargets } from '../src/host/framework/web.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;

const describe = (selector) => page.locator(selector).evaluate(webTargets, { mode: 'describe' });
const find = async (target) => {
    const handle = await page.evaluateHandle(`(${webTargets})(null, ${JSON.stringify({ mode: 'find', target })})`);
    return handle.asElement();
};

// Eine Web Component mit offenem Shadow Root, wie Lit, Ionic oder Angular mit ViewEncapsulation.ShadowDom sie erzeugen.
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

test('web: Ziele in offenen Shadow Roots beschreiben und wiederfinden, gleiche Knöpfe über den Bereich unterscheiden', { skip: false }, async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(SHADOW);
    const second = page.locator('#b').locator('button span');
    const described = await second.evaluate(webTargets, { mode: 'describe' });
    assert.deepEqual(described, { role: 'button', name: 'Speichern', inside: { role: 'group', name: 'Aktionen' }, index: 1 }, 'Klick aufs Innere gehört zum Knopf');
    const field = await page.locator('#a').locator('input').evaluate(webTargets, { mode: 'describe' });
    assert.equal(field.name, 'Menge', 'Beschriftung aus dem Shadow Root');
    const found = await find(described);
    assert.ok(found !== null, 'wiedergefunden');
    assert.equal(await found.evaluate((node) => node.getRootNode().host.id), 'b');
    return undefined;
});

test('web: Ein Auswahlfeld im Label heißt wie die Beschriftung, ohne seine Optionen', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(`<label>Customer <select id="c"><option>Acme</option><option>Globex</option></select></label>
<label for="p">Priority</label><select id="p"><option>Low</option></select>`);
    assert.equal((await describe('#c')).name, 'Customer');
    assert.equal((await describe('#p')).name, 'Priority');
    // Kommt eine Option dazu, findet die Suche das Feld weiter.
    await page.evaluate(() => document.querySelector('#c').append(new Option('Initech')));
    assert.ok(await find({ role: 'combobox', name: 'Customer' }));
    return undefined;
});

test('web: Ein überdeckter Knopf im Shadow Root zählt nicht als klickbar', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(`${SHADOW}<div style="position:fixed;inset:0;background:#fff"></div>`);
    assert.equal(await describe('#a'), null, 'nichts Klickbares');
    assert.equal(await find({ role: 'button', name: 'Speichern' }), null);
    return undefined;
});

test('web: unbestimmter Fortschritt und aria-busy laden, auch im Shadow Root; bestimmter Fortschritt nicht', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent('<div role="progressbar" aria-valuenow="40"></div><x-spin></x-spin><script>customElements.define("x-spin", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<div role=progressbar style=\'width:9px;height:9px\'></div>"; } });</script>');
    assert.equal(await page.evaluate(webBusy, {}), 1);
    const state = await page.evaluate(webPageState, { marker: 'body', selectors: ['[role=status]'] });
    assert.equal(state.loading, true);
    await page.setContent('<div role="progressbar" aria-valuenow="100"></div><div aria-busy="false"></div>');
    assert.equal(await page.evaluate(webBusy, {}), 0);
    return undefined;
});

test('web: DOM-Ruhe, erst still nach domQuietMs; Attribute zählen nicht', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent('<ul id="l"></ul>');
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0, 'erster Aufruf hängt nur den Beobachter an');
    await page.evaluate(() => { document.getElementById('l').append(document.createElement('li')); });
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 1, 'gerade gerendert');
    await page.waitForTimeout(250);
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0);
    await page.evaluate(() => { document.getElementById('l').setAttribute('class', 'tick'); });
    assert.equal((await page.evaluate(webProbe, null)).loadingStores, 0, 'Attribut, etwa eine Animation');
    return undefined;
});

test('web: Statusmeldungen (Toast, Snackbar) als Hinweis, Zahlen als #; ohne Marker gilt angemeldet', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent('<div role="status">3 Einträge gespeichert</div><div role="status"></div>');
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]', '[role=status]'] });
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.notes, ['# Einträge gespeichert']);
    assert.equal(state.signedIn, true);
    return undefined;
});

test('web: Ein Formular im Dialog ist keine Meldung, ein Hinweis darin und eine Rückfrage schon', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(`<div role="dialog" aria-modal="true"><h2>Akte anlegen</h2><input aria-label="Name"><div role="alert">Diesen Namen trägt schon eine Akte.</div><button>Anlegen</button></div>
<div role="dialog" aria-modal="true"><p>Akte auflösen?</p><label><input type="checkbox"> Ich weiß</label><button>Auflösen</button></div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]'] });
    assert.deepEqual(state.messages, ['Akte auflösen? Ich weiß Auflösen', 'Diesen Namen trägt schon eine Akte.']);
    return undefined;
});

test('web: Ein Toast-Stapel ergibt je Toast eine Meldung, eine Meldung mit Inline-Teilen bleibt ganz', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(`<div class="toasts" aria-live="polite"><div class="toast">„Akte 7“ ist angelegt.</div><div class="toast">Gespeichert</div></div>
<div role="alert"><b>Fehler:</b> <span>Name fehlt</span></div>
<div role="status"><div>EULA nicht angenommen. <a href="#e">EULA</a></div><div><button>Annehmen</button></div></div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: ['[role=alert]', '[role=status]', '[aria-live=polite]'] });
    assert.deepEqual(state.messages, ['Fehler: Name fehlt'], 'Nur der Fehler kann scheitern lassen');
    assert.deepEqual(state.notes.sort(), ['EULA nicht angenommen. EULA Annehmen', 'Gespeichert', '„Akte #“ ist angelegt.']);
    return undefined;
});

test('web: Warum ein Ziel nicht klickbar ist: fehlt, unsichtbar, oder unter einem Dialog mit Meldung', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    const explain = (target) => page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target })})`);
    await page.setContent(`<nav aria-label="Haupt"><a href="#e">Einstellungen</a><a href="#v" style="display:none">Versteckt</a></nav>
<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff8"><h2>Akte anlegen</h2><div role="alert">Diesen Namen trägt schon eine Akte.</div></div>`);
    assert.deepEqual(await explain({ role: 'link', name: 'Einstellungen' }), { covered: { role: 'dialog', name: 'Akte anlegen', messages: ['Diesen Namen trägt schon eine Akte.'] } });
    assert.deepEqual(await explain({ role: 'link', name: 'Versteckt' }), { hidden: true });
    // Fehlt es ganz, kommen die sichtbaren Namen derselben Rolle mit, der Host sucht darin ein umbenanntes Ziel.
    assert.deepEqual(await explain({ role: 'link', name: 'Gibt es nicht' }), { missing: true, names: ['Einstellungen'] });
    // Ein unsichtbarer Zwilling in einem anderen Bereich erklaert nichts: Das Ziel selbst fehlt.
    await page.setContent(`<nav aria-label="Haupt"><a id="p" href="#p">Profil</a></nav><nav aria-label="Mobil"><a href="#p" style="display:none">Profil</a></nav>`);
    const described = await page.evaluate(`(${webTargets})(document.getElementById('p'), { mode: 'describe' })`);
    assert.ok(described.inside !== undefined, 'gleicher Name im anderen Bereich: das Ziel nennt seinen Bereich');
    await page.evaluate(() => document.getElementById('p').remove());
    assert.deepEqual(await explain(described), { elsewhere: true });
    return undefined;
});

test('web: virtualisierte Liste, die Suche rollt weiter, bis die Zeile im DOM ist', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    // Nur die sichtbaren Zeilen stehen im DOM, wie bei react-window oder CDK Virtual Scroll.
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
        // Erst neu zeichnen lassen: Sonst rollt die Suche auf langsamen Rechnern mehrmals, bevor die Liste nachzieht, und springt über Zeile 300.
        if (found === null) await page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); }));
    }
    assert.ok(found !== null, 'Zeile 300 erreicht');
    assert.match(await found.evaluate((node) => node.parentElement.textContent), /Akte 300/);
    return undefined;
});

test('web: Ein Name als Muster trifft eine wechselnde Zahl, einen Bereich und einen Namen über 80 Zeichen', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    const long = `Max Mustermann — Person, abgedeckt als <PERSON_1> ${'und noch mehr Text '.repeat(4)}`;
    await page.setContent(`<div role="toolbar" aria-label="Dokumente 12"><button id="p">Prüfen 3</button></div><button id="l">${long}</button>`);
    const id = async (target) => (await find(target))?.evaluate((node) => node.id) ?? null;
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen( \\d+)?$' } }), 'p');
    assert.equal(await id({ role: 'button', name: 'Prüfen' }), null, 'fester Name bleibt genau');
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen' }, inside: { role: 'toolbar', name: { pattern: '^Dokumente \\d+$' } } }), 'p');
    assert.equal(await id({ role: 'button', name: { pattern: '^Prüfen' }, inside: { role: 'toolbar', name: { pattern: '^Akten' } } }), null);
    assert.equal(await id({ role: 'button', name: { pattern: '^Max Mustermann — Person' } }), 'l', 'das Muster sieht den ganzen Namen');
    assert.equal(await id({ role: 'button', name: long.trim() }), null, 'als fester Name ist er zu lang');
    return undefined;
});

test('web: Eine Meldung über 300 Zeichen kommt ganz, damit sie ihren Eintrag in knownMessages trifft', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    const text = `Prüfung abschließen. ${'Ein langer Satz im Dialog. '.repeat(15)}Freigeben`;
    await page.setContent(`<div role="alertdialog">${text}</div>`);
    const state = await page.evaluate(webPageState, { marker: null, selectors: [] });
    assert.deepEqual(state.messages, [text.replace(/\s+/g, ' ').trim()]);
    assert.ok(state.messages[0].length > 300);
    return undefined;
});

// Web Components wie Shoelace oder Ionic: Label um das Feld, Meldung und Marker im Shadow Root, Dialog als Web Component.
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

test('web: Shadow DOM auch für Label, Marker, Meldungen, Formular im Dialog und Zählung', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(SHADOW_PARTS);
    const field = await page.locator('#feld').locator('input').evaluate(webTargets, { mode: 'describe' });
    assert.equal(field.name, 'Betrag', 'umschließendes Label im Shadow Root');
    const state = await page.evaluate(webPageState, { marker: '[data-testid=user-menu]', selectors: ['[role=alert]', '[role=status]'] });
    assert.equal(state.signedIn, true, 'Marker im Shadow Root');
    assert.deepEqual(state.notes, ['Ticket # gespeichert'], 'Status im Shadow Root ist ein Hinweis, mit Text aus allen Teilen');
    assert.deepEqual(state.messages, ['Wirklich löschen?'], 'der Dialog mit Feld ist Bedienung, sein Alarm eine Meldung');
    assert.equal((await page.evaluate(webProbe, '.zeile')).counts, 2, 'Zählung in Shadow Roots');
    const { webCount } = await import('../src/host/framework/web.mjs');
    assert.equal(await page.evaluate(webCount, null), null);
    return undefined;
});

test('web: Ein Dialog als Web Component über einem Knopf nennt Name und Meldung', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setContent(`<button>Speichern</button>
<x-modal></x-modal>
<script>customElements.define('x-modal', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#fff"><h2>Hinweis</h2><p role="alert">Sitzung läuft ab</p></div>'; } });</script>`);
    const why = await page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target: { role: 'button', name: 'Speichern' } })})`);
    assert.deepEqual(why, { covered: { role: 'dialog', name: 'Hinweis', messages: ['Sitzung läuft ab'] } });
    return undefined;
});

test('web: Die Suche nach einem Ziel außerhalb des Bildes lässt die Seite, wo sie war', async (t) => {
    if (needsChrome()) return t.skip('kein Chrome');
    await page.setViewportSize({ width: 800, height: 400 });
    await page.setContent('<button>Oben</button><div style="height:3000px"></div><button>Unten</button>');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const before = await page.evaluate(() => window.scrollY);
    assert.ok(before > 1000);
    assert.ok(await find({ role: 'button', name: 'Oben' }) !== null, 'gefunden');
    assert.equal(await page.evaluate(() => window.scrollY), before, 'kein Sprung nach oben');
    const explain = (target) => page.evaluate(`(${webTargets})(null, ${JSON.stringify({ mode: 'explain', target })})`);
    await explain({ role: 'button', name: 'Oben' });
    assert.equal(await page.evaluate(() => window.scrollY), before, 'auch nicht beim Erklären');
    return undefined;
});
