// What a recording stores for an element, in real Chrome (headless): Playwright's generated locator, made to hold up on the next
// run (full name with exact, row scoping, <select> in a <label>), relative to the application's frame. Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { roleAndName, webPick } from '../src/host/accessible-name.mjs';
import { locatorFor } from '../src/host/agent-commands.mjs';
import { markedTarget } from '../src/host/demonstrate.mjs';
import { frameView } from '../src/host/app-view.mjs';
import { buildLocator, parseLocator } from '../src/host/locator.mjs';
import { MARK_ATTRIBUTE, recordLocator } from '../src/host/record-locator.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;

const APP = `<h1>Todos</h1>
<button>Complete Feed the raven CAW-2026111219000012 and keep going until the name is well beyond eighty characters long</button>
<button>Complete Feed the raven CAW-2026111219000013</button>
<label>Tag <select><option value="work">#work</option><option value="home">#home</option></select></label>
<ul><li>Order CAW-1 <button>Edit</button></li><li>Order CAW-2 <button>Edit</button></li></ul>
<ol><li><span>Akte CAW-1</span> <button>Bearbeiten</button> <button>Löschen</button></li><li><span>Akte CAW-2</span> <button>Bearbeiten</button> <button>Löschen</button></li></ol>
<table><tr><td>INV-1</td><td><button>Open</button></td></tr><tr><td>INV-2</td><td><button>Open</button></td></tr></table>
<button>Retry</button><button>Retry</button>
<div id="ext-element-12" class="x-btn">Speichern</div>
<x-card></x-card>
<iframe title="Payment" srcdoc="<label>Amount <input></label><iframe title='Bank' srcdoc='<button>Confirm</button>'></iframe>"></iframe>
<script>customElements.define('x-card', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = '<button>Rate</button>'; } });</script>`;

/** The application in a frame named like the workbench's, beside a workbench button with the same name as one in the app. */
const openApp = async () => {
    const srcdoc = APP.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    await page.setContent(`<button>Retry</button><iframe name="caw-app" style="width:900px;height:900px" srcdoc="${srcdoc}"></iframe>`);
    const frame = page.frame({ name: 'caw-app' });
    await frame.locator('iframe[title="Payment"]').contentFrame().locator('iframe[title="Bank"]').contentFrame().getByRole('button').waitFor();
    return frame;
};
const refs = (snapshot) => new Map([...snapshot.matchAll(/^\s*- (.*?) \[ref=([fe\d]+)\]/gm)].map(([, line, ref]) => [line.replace(/\s*\[.*$/, ''), ref]));

test('record: snapshot references inside the workbench frame become frame-relative locators, and the references stay usable', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const app = await openApp();
    const view = frameView(page, app);
    const byLine = refs(await view.ariaSnapshot({ mode: 'ai' }));
    const record = async (line) => recordLocator(view.mainFrame(), locatorFor(view, byLine.get(line)));
    assert.equal(await record('button "Complete Feed the raven CAW-2026111219000013"'), "getByRole('button', { name: 'Complete Feed the raven CAW-2026111219000013', exact: true })",
        'the full name with exact, not the prefix the generator shortens it to');
    const long = await record(`button "${(await app.locator('button').nth(0).textContent()).trim()}"`);
    assert.match(long, /^getByRole\('button', \{ name: 'Complete .* characters long', exact: true \}\)$/, 'over 80 characters too');
    assert.equal(await record('combobox "Tag"'), "getByRole('combobox', { name: 'Tag', exact: true })", 'the label without the options');
    assert.equal(await record('textbox "Amount"'), "locator('iframe[title=\"Payment\"]').contentFrame().getByRole('textbox', { name: 'Amount', exact: true })");
    assert.equal(await record('button "Confirm"'), "locator('iframe[title=\"Payment\"]').contentFrame().locator('iframe[title=\"Bank\"]').contentFrame().getByRole('button', { name: 'Confirm', exact: true })", 'nested frames');
    assert.equal(await record('button "Rate"'), "getByRole('button', { name: 'Rate', exact: true })", 'open shadow root');
    // Recording does not take another snapshot: the references Claude is about to use still work.
    await locatorFor(view, byLine.get('combobox "Tag"')).selectOption('home');
    assert.equal(await app.locator('select').inputValue(), 'home');
    return undefined;
});

test('record: equal entries are told apart by their row, not by position; twins without a row stay positional', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const app = await openApp();
    const at = (selector) => recordLocator(app, app.locator(selector));
    assert.equal(await at('ul li:nth-child(2) button'), "getByRole('listitem').filter({ hasText: 'Order CAW-2 Edit' }).getByRole('button', { name: 'Edit', exact: true })", 'the generator scopes by the row, caw adds the exact name');
    // Either the generator or caw scopes a table row, depending on what else is on the page; never by position.
    assert.match(await at('tr:nth-child(1) button'), /^getByRole\('row'.*INV-1.*\.getByRole\('button', \{ name: 'Open', exact: true \}\)$/);
    assert.equal(await at('ol li:nth-child(2) button:first-of-type'), "getByRole('listitem').filter({ hasText: 'Akte CAW-2' }).getByRole('button', { name: 'Bearbeiten', exact: true })",
        'where the generator falls back to nth(1), caw scopes by the text of the entry');
    assert.equal(await at('body > button:nth-of-type(4)'), "getByRole('button', { name: 'Retry' }).nth(1)", 'nothing tells them apart: the step is listed as positional');
    // Every recorded locator finds exactly its element again.
    for (const selector of ['ul li:nth-child(2) button', 'ol li:nth-child(2) button:first-of-type', 'tr:nth-child(1) button', 'select']) {
        const code = await at(selector);
        const same = await buildLocator(app, parseLocator(code)).evaluate((node, wanted) => node === document.querySelector(wanted), selector);
        assert.equal(same, true, code);
    }
    return undefined;
});

test('record: a row text the generator cut before the run tag gets its full text; a click that renames keeps the earlier name; parallel resolutions on one element', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<ul><li><span>Errand Feed the raven CAW-2026111221403650368</span> <button>Complete</button></li>
<li><span>Errand Water the plants</span> <button>Complete</button></li></ul>
<label>Customer <input></label><button id="tan">Confirmed</button><button>Confirm with TAN</button>`);
    const frame = page.mainFrame();
    const row = await recordLocator(frame, page.locator('li:nth-child(1) button'));
    assert.equal(row, "getByRole('listitem').filter({ hasText: 'Errand Feed the raven CAW-2026111221403650368' }).getByRole('button', { name: 'Complete', exact: true })");
    // The page saw "Confirm with TAN" at the pointerdown; the click renamed it. Another element still carries the earlier name: unstable.
    assert.equal(await recordLocator(frame, page.locator('#tan'), { seen: { role: 'button', name: 'Confirm with TAN' } }), null);
    await page.evaluate(() => document.querySelector('button:not(#tan):not(li button)').remove());
    assert.equal(await recordLocator(frame, page.locator('#tan'), { seen: { role: 'button', name: 'Confirm with TAN' } }), "getByRole('button', { name: 'Confirm with TAN', exact: true })");
    assert.equal(await recordLocator(frame, page.locator('#tan'), { seen: { role: 'button', name: 'Confirmed' } }), "getByRole('button', { name: 'Confirmed', exact: true })", 'unchanged name');
    // The click into a field and the text typed into it are resolved at the same time.
    const both = await Promise.all([recordLocator(frame, page.locator('input')), recordLocator(frame, page.locator('input'))]);
    assert.deepEqual(both, Array(2).fill("getByRole('textbox', { name: 'Customer', exact: true })"));
    return undefined;
});

test('record, any framework: rows by their unique cells, everything in a dialog scoped by it, unnamed fields by their group', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.setContent(`<button>Speichern</button>
<div role="grid"><div role="row"><span role="gridcell">1000001</span><span role="gridcell">Muster, Erika</span><span role="gridcell">P</span><button>Öffnen</button></div>
<div role="row"><span role="gridcell">1000001</span><span role="gridcell">Muster, Erika</span><span role="gridcell">D</span><button>Öffnen</button></div>
<div role="row"><span role="gridcell">9000001</span><span role="gridcell">Muster, Erika</span><span role="gridcell">D</span><button>Öffnen</button></div></div>
<fieldset><legend>Lieferadresse</legend><input></fieldset><fieldset><legend>Rechnungsadresse</legend><input></fieldset>
<div role="dialog" aria-label="Neue Aufgabe"><button>Speichern</button></div>
<div role="dialog" aria-label="Aufgabe 9990001234567890001 bearbeiten"><button>Schließen</button></div>`);
    const frame = page.mainFrame();
    const at = (selector) => recordLocator(frame, page.locator(selector));
    assert.equal(await at('[role=row]:nth-child(3) button'), "getByRole('row').filter({ hasText: '9000001' }).getByRole('button', { name: 'Öffnen', exact: true })", 'the shortest cell only this row has');
    assert.equal(await at('[role=row]:nth-child(2) button'), "getByRole('row').filter({ hasText: '1000001' }).filter({ hasText: 'D' }).getByRole('button', { name: 'Öffnen', exact: true })", 'no single cell: two');
    assert.equal(await at('[role=row]:nth-child(1)'), "getByRole('row').filter({ hasText: 'P' })", 'the row itself');
    assert.equal(await at('[aria-label="Neue Aufgabe"] button'), "getByRole('dialog', { name: 'Neue Aufgabe', exact: true }).getByRole('button', { name: 'Speichern', exact: true })", 'in its dialog, beside the page\'s own "Speichern"');
    assert.equal(await at('[aria-label^="Aufgabe"] button'), "getByRole('dialog', { name: /^Aufgabe/ }).getByRole('button', { name: 'Schließen', exact: true })", 'a dialog name with data: only its beginning');
    assert.match(await at('fieldset:nth-of-type(2) input'), /^getByRole\('group', \{ name: 'Rechnungsadresse'(, exact: true)? \}\)\.getByRole\('textbox'\)$/, 'an unnamed field by its group');
    // The demonstration checked role and name at the pointerdown; after the click the option is gone (hidden).
    await page.setContent('<ul role="listbox" aria-label="Bereich"><li role="option" id="o">Sonstiges</li></ul>');
    await page.evaluate(() => { document.querySelector('[role=listbox]').hidden = true; });
    assert.equal(await recordLocator(frame, page.locator('#o'), { proposal: [{ role: 'option', name: 'Sonstiges' }] }), "getByRole('option', { name: 'Sonstiges', exact: true })");
    return undefined;
});

test('record, demonstration: a dialog the click closes is scoped as Playwright names it (never by its heading), with data only by its beginning', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const frame = page.mainFrame();
    // What the page checks at the pointerdown, then the click closes the dialog.
    const pickThenClose = async (selector) => {
        const proposal = await page.locator(selector).evaluate((element, [pick, name]) => new Function('element', `return (${pick})(element, ${name});`)(element), [String(webPick), String(roleAndName)]);
        await page.evaluate(() => { for (const dialog of document.querySelectorAll('dialog')) dialog.close(); for (const dialog of document.querySelectorAll('[role=dialog]')) dialog.hidden = true; });
        return recordLocator(frame, page.locator(selector), { proposal });
    };
    // A native dialog named only by its heading has no name for getByRole: scoped by the role while it is the one open dialog.
    await page.setContent('<button>Speichern</button><dialog><h2>Notiz anlegen</h2><button id="b">Speichern</button></dialog>');
    await page.evaluate(() => document.querySelector('dialog').showModal());
    const unnamed = await pickThenClose('#b');
    assert.equal(unnamed, "getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true })");
    await page.evaluate(() => document.querySelector('dialog').showModal());
    assert.equal(await buildLocator(frame, parseLocator(unnamed)).evaluate((element) => element.id), 'b', 'replays to the same button');
    // A dialog name with a record number: only its beginning, as on the Claude path.
    await page.setContent('<div role="dialog" aria-label="Vorgang 1000001 bearbeiten"><button id="c">Schließen</button></div><button>Schließen</button>');
    assert.equal(await pickThenClose('#c'), "getByRole('dialog', { name: /^Vorgang/ }).getByRole('button', { name: 'Schließen', exact: true })");
    return undefined;
});

test('record, demonstration: an element the click removed from the page before the host looked is recorded by what the page checked at the pointerdown', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const frame = page.mainFrame();
    // The click's handler removes the element at once; the host resolves the mark only afterwards (it races the click).
    const pickThenRemove = async (selector, remove, { pick = true } = {}) => {
        const proposal = pick ? await page.locator(selector).evaluate((element, [webPickCode, name]) => new Function('element', `return (${webPickCode})(element, ${name});`)(element), [String(webPick), String(roleAndName)]) : null;
        await page.locator(selector).evaluate((element, attribute) => element.setAttribute(attribute, 'm1'), MARK_ATTRIBUTE);
        await page.evaluate(remove);
        return (await markedTarget({}, frame, 'm1', null, proposal)).target;
    };
    await page.setContent('<div role="dialog" aria-labelledby="t"><h2 id="t">Vorgang 1000001 bearbeiten</h2><button id="c">Schließen</button></div><button>Schließen</button>');
    assert.equal(await pickThenRemove('#c', () => document.querySelector('[role=dialog]').remove()), "getByRole('dialog', { name: /^Vorgang/ }).getByRole('button', { name: 'Schließen', exact: true })", 'a dialog removed by its Schließen');
    await page.setContent('<input role="combobox" aria-label="Sachgebiet"><ul role="listbox"><li role="option" id="o">Beitrag</li><li role="option">Beratung</li></ul>');
    assert.equal(await pickThenRemove('#o', () => document.querySelector('[role=listbox]').remove()), "getByRole('option', { name: 'Beitrag', exact: true })", 'an option whose list the click removed');
    // Without what the page checked there is nothing to record.
    await page.setContent('<button id="x">Weg</button>');
    assert.equal(await pickThenRemove('#x', () => document.querySelector('#x').remove(), { pick: false }), null);
    return undefined;
});

test('record: nothing that only holds for this page state; the marker and elements outside the app are never recorded', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const app = await openApp();
    // ExtJS: a generated id is no target; the text the generator offers here is one.
    assert.equal(await recordLocator(app, app.locator('#ext-element-12'), { framework: 'extjs' }), "getByText('Speichern')");
    await app.evaluate(() => { document.querySelector('#ext-element-12').textContent = ''; });
    assert.equal(await recordLocator(app, app.locator('#ext-element-12'), { framework: 'extjs' }), null, 'only #ext-element-12 is left: unstable');
    assert.equal(await recordLocator(app, app.locator('#ext-element-12'), { framework: 'web' }), "locator('#ext-element-12')", 'outside ExtJS an id is the app\'s own');
    // An element the page marked for the demonstration: the marker never ends up in the locator.
    await app.evaluate((name) => { const input = document.createElement('input'); input.setAttribute(name, 'm1'); document.body.append(input); }, MARK_ATTRIBUTE);
    const marked = await recordLocator(app, app.locator(`[${MARK_ATTRIBUTE}="m1"]`));
    assert.ok(marked === null || !marked.includes(MARK_ATTRIBUTE), String(marked));
    assert.equal(await recordLocator(app, page.locator('body > button')), null, 'the workbench is not the application');
    assert.equal(await recordLocator(app, app.locator('#gone')), null);
    return undefined;
});

test('locatorFor: Claude may pass a reference, locator code (parsed, never evaluated) or CSS', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const app = await openApp();
    const view = frameView(page, app);
    assert.equal(await locatorFor(view, "getByRole('listitem').filter({ hasText: 'Order CAW-1' }).getByRole('button')").textContent(), 'Edit');
    assert.equal(await locatorFor(view, "locator('iframe[title=\"Payment\"]').contentFrame().getByRole('textbox')").count(), 1);
    assert.equal(await locatorFor(view, 'table button').count(), 2);
    assert.throws(() => locatorFor(view, "getByRole('button').evaluate(() => 1)"), { code: 'target-invalid' });
    return undefined;
});
