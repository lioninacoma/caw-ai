// ExtJS components as extjs= locators when nothing else is stable: a fake Ext in the style of ExtJS Modern (empty <button> with
// the text in a sibling, generated ids, itemId, labels, twin buttons in two windows). Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { registerEngines } from '../src/ext/extjs/extjs-engine.mjs';
import { extjsCandidates, extjsMatches } from '../src/ext/extjs/extjs-query.mjs';
import { buildLocator, parseLocator } from '../src/host/locator.mjs';
import { recordLocator } from '../src/host/record-locator.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    await registerEngines();
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

// Components with generated ids (ext-button-3), getters like Modern (getText, getLabel, getTitle) and a ComponentQuery that knows
// `xtype`, `[attr="v"]`/`[attr='v']` (getter first, then the property) and the descendant combinator.
const FAKE_EXT = () => {
    const all = [];
    let next = 0;
    const make = (xtype, { text, label, title, itemId, parent = null, inner = '' } = {}) => {
        next += 1;
        const dom = document.createElement('div');
        dom.id = `ext-${xtype}-${next}`;
        dom.className = `x-${xtype}`;
        dom.innerHTML = inner;
        (parent?.el.dom ?? document.body).append(dom);
        const component = {
            xtype, ownerCt: parent, el: { dom }, config: itemId === undefined ? {} : { itemId },
            itemId: itemId ?? dom.id,
            getText: text === undefined ? undefined : () => text,
            getLabel: label === undefined ? undefined : () => label,
            getTitle: title === undefined ? undefined : () => title,
            isVisible: () => true,
        };
        all.push(component);
        return component;
    };
    const value = (component, name) => {
        const getter = component[`get${name[0].toUpperCase()}${name.slice(1)}`];
        return typeof getter === 'function' ? getter() : component[name];
    };
    const simple = (part) => {
        const match = /^([\w.-]+)((?:\[\w+=(?:"[^"]*"|'[^']*')\])*)$/.exec(part);
        if (!match) throw new Error(`Invalid ComponentQuery selector: "${part}"`);
        const attributes = [...match[2].matchAll(/\[(\w+)=(?:"([^"]*)"|'([^']*)')\]/g)].map(([, name, a, b]) => [name, a ?? b]);
        return (component) => component.xtype === match[1] && attributes.every(([name, wanted]) => value(component, name) === wanted);
    };
    // Like Ext Modern: a comma separates queries, also inside quotes; an invalid part is logged and thrown.
    const invalid = (part) => {
        console.error(`[E] Invalid ComponentQuery selector: "${part}"`);
        return new Error(`Invalid ComponentQuery selector: "${part}"`);
    };
    const query = (selector) => [...new Set(selector.split(',').flatMap((one) => queryOne(one.trim())))];
    const queryOne = (selector) => {
        const parts = selector.match(/[\w.-]+(?:\[\w+=(?:"[^"]*"|'[^']*')\])*/g) ?? [];
        if (parts.join(' ') !== selector.replace(/\s+/g, ' ').trim()) throw invalid(selector);
        const tests = parts.map(simple);
        const under = (component, index) => {
            for (let parent = component.ownerCt; parent !== null; parent = parent.ownerCt) {
                if (tests[index](parent) && (index === 0 || under(parent, index - 1))) return true;
            }
            return false;
        };
        return all.filter((component) => tests.at(-1)(component) && (tests.length === 1 || under(component, tests.length - 2)));
    };
    window.Ext = { getCmp: (id) => all.find((component) => component.el.dom.id === id) ?? null, ComponentQuery: { query } };

    const button = (text, options = {}) => make('button', { text, inner: `<button id="ext-element-${next + 100}"></button><span>${text}</span>`, ...options });
    const form = make('formpanel', { title: 'Anliegen' });
    button('Speichern', { parent: form });
    button('Abbrechen', { parent: form, itemId: 'abortButton' });
    button('Sag "Hallo"', { parent: form });
    make('textfield', { label: 'Bereich*', parent: form, inner: '<input id="ext-element-201">' });
    make('textfield', { label: 'Betreff', parent: form, inner: '<input id="ext-element-202">' });
    const first = make('dialog', { title: 'Erster' });
    button('OK', { parent: first });
    const second = make('dialog', { title: 'Zweiter' });
    button('OK', { parent: second });
    // A comma in a title or text: ComponentQuery cannot quote it.
    const box = make('messagebox', { title: 'Muster, Erika' });
    button('Ja, abschließen', { parent: box, itemId: 'yes' });
};

const at = async (selector) => {
    await page.setContent('<main></main>');
    await page.evaluate(FAKE_EXT);
    return recordLocator(page.mainFrame(), page.locator(selector), { framework: 'extjs' });
};

test('extjs: an empty Modern button, a field without a name, an itemId, quotes and twins become extjs= locators', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    assert.equal(await at('#ext-button-2 button'), 'locator(\'extjs=button[text="Speichern"]\').locator(\'button\')', 'xtype with text, the <button> inside');
    assert.equal(await at('#ext-button-3 button'), 'locator(\'extjs=button[itemId="abortButton"]\').locator(\'button\')', 'the itemId first');
    assert.equal(await at('#ext-button-4 button'), 'locator(\'extjs=button[text=\\\'Sag "Hallo"\\\']\').locator(\'button\')', 'a text with " in single quotes');
    assert.equal(await at('#ext-element-201'), 'locator(\'extjs=textfield[label="Bereich*"]\').locator(\'input\')');
    assert.equal(await at('#ext-button-10 button'), 'locator(\'extjs=dialog[title="Zweiter"]\').locator(\'extjs=button[text="OK"]\').locator(\'button\')', 'twins: inside the named dialog');
    // Every proposal finds exactly its element again.
    for (const selector of ['#ext-button-2 button', '#ext-element-201', '#ext-button-10 button']) {
        const code = await at(selector);
        assert.equal(await buildLocator(page.mainFrame(), parseLocator(code)).evaluate((node, wanted) => node === document.querySelector(wanted), selector), true, code);
    }
    // A comma in the title or text: neither goes into the query, and the page logs no invalid query.
    const logged = [];
    const listen = (message) => logged.push(message.text());
    page.on('console', listen);
    try {
        const code = await at('#ext-button-12 button');
        assert.ok(code !== null && !code.includes(','), String(code));
        assert.equal(await buildLocator(page.mainFrame(), parseLocator(code)).evaluate((node) => node === document.querySelector('#ext-button-12 button')), true, code);
        assert.deepEqual(logged.filter((text) => text.includes('Invalid ComponentQuery')), []);
    } finally {
        page.off('console', listen);
    }
    return undefined;
});

// The cases measured on a real ExtJS Modern application, rebuilt: the drop-down list of a combobox (floating), a grid whose rows
// repeat cells, a dialog tool, a list entry with an icon button, fields named only by a heading beside them, a message box
// with generic itemIds and a radio inside a dialog. Components know their parent (getParent), floating ones say so.
const FAKE_EXT_DATA = () => {
    const all = [];
    let next = 0;
    const make = (xtype, { parent = null, inner = '', floated = false, ...props } = {}) => {
        next += 1;
        const dom = document.createElement('div');
        dom.id = `ext-${xtype}-${next}`;
        dom.className = `x-${xtype}`;
        dom.innerHTML = inner;
        (parent?.el.dom ?? document.body).append(dom);
        const component = { xtype, el: { dom }, config: props.itemId === undefined ? {} : { itemId: props.itemId }, getParent: () => parent, getFloated: () => floated, isVisible: () => true };
        for (const [key, value] of Object.entries(props)) if (key !== 'itemId') component[`get${key[0].toUpperCase()}${key.slice(1)}`] = () => value;
        if (props.itemId !== undefined) component.itemId = props.itemId;
        component.getItems = () => ({ items: all.filter((other) => other.getParent() === component) });
        all.push(component);
        return component;
    };
    const value = (component, name) => (typeof component[`get${name[0].toUpperCase()}${name.slice(1)}`] === 'function' ? component[`get${name[0].toUpperCase()}${name.slice(1)}`]() : component[name]);
    const simple = (part) => {
        const match = /^([\w.-]+)((?:\[\w+=(?:"[^"]*"|'[^']*')\])*)$/.exec(part);
        if (!match) throw new Error(`Invalid ComponentQuery selector: "${part}"`);
        const attributes = [...match[2].matchAll(/\[(\w+)=(?:"([^"]*)"|'([^']*)')\]/g)].map(([, name, a, b]) => [name, a ?? b]);
        return (component) => component.xtype === match[1] && attributes.every(([name, wanted]) => value(component, name) === wanted);
    };
    const query = (selector) => {
        const tests = (selector.match(/[\w.-]+(?:\[\w+=(?:"[^"]*"|'[^']*')\])*/g) ?? []).map(simple);
        const under = (component, index) => {
            for (let parent = component.getParent(); parent !== null; parent = parent.getParent()) if (tests[index](parent) && (index === 0 || under(parent, index - 1))) return true;
            return false;
        };
        return all.filter((component) => tests.at(-1)(component) && (tests.length === 1 || under(component, tests.length - 2)));
    };
    window.Ext = { getCmp: (id) => all.find((component) => component.el.dom.id === id) ?? null, ComponentQuery: { query } };

    // The drop-down list of a combobox, floating at the end of the body.
    const list = make('boundlist', { floated: true });
    for (const text of ['Sonstiges', 'Sonstiges Weiteres']) make('simplelistitem', { parent: list, inner: `<span class="x-list-label">${text}</span>` });
    // A grid: rows 1 and 2 share number and name.
    const grid = make('grid');
    for (const cells of [['1000001', 'Muster, Erika', 'P'], ['1000001', 'Muster, Erika', 'D'], ['9000001', 'Muster, Erika', 'D']]) {
        const row = make('gridrow', { parent: grid });
        row.el.dom.classList.add('x-listitem');
        for (const text of cells) { const cell = make('gridcell', { parent: row, inner: text }); cell.el.dom.classList.add('x-gridcell'); }
    }
    // Two pickers named only by the heading beside them; the second one's list has an entry with a remove icon.
    for (const heading of ['Zielgruppe*', 'Fachgebiete*']) {
        const picker = make('auswahl');
        const label = make('label', { parent: picker, html: `<b>${heading}</b>` });
        label.el.dom.textContent = heading;
        const row = make('container', { parent: picker });
        make('combobox', { parent: row, inner: '<input>' });
        const add = make('button', { parent: row, text: 'Hinzufügen', inner: '<button></button><span>Hinzufügen</span>' });
        add.isButton = true;
        const entries = make('list', { parent: picker });
        const entry = make('listitem', { parent: entries, inner: `<span>${heading === 'Zielgruppe*' ? 'Ärzte' : 'Zahnärzte'}</span>` });
        make('button', { parent: entry, iconCls: 'x-fa fa-trash', inner: '<button></button>' }).isButton = true;
    }
    // A dialog with a close tool and a radio, and a message box above it with generic itemIds.
    const dialog = make('dialog', { title: 'Termin anlegen', floated: true });
    make('tool', { parent: dialog, type: 'close' });
    make('radio', { parent: dialog, label: 'Ja', inner: '<input type="radio" id="radio-ja"><label for="radio-ja">Ja</label>' });
    const box = make('messagebox', { title: 'Fenster Schließen', floated: true });
    make('button', { parent: box, itemId: 'yes', text: 'Ja', inner: '<button></button><span>Ja</span>' });
    make('button', { parent: box, itemId: 'no', text: 'Nein', inner: '<button></button><span>Nein</span>' });
    // A task grid as measured: every cell knows its column (dataIndex), and the name is in two columns of the same row.
    const tasks = make('aufgabengrid');
    for (const [number, name] of [['9000001', 'Muster, Erika'], ['9000002', 'Beispiel, Max']]) {
        const row = make('gridrow', { parent: tasks });
        row.el.dom.classList.add('x-listitem');
        for (const [dataIndex, text] of [['Antragsnummer', number], ['Bezeichnung', name], ['Initiator', name]]) {
            const cell = make('gridcell', { parent: row, inner: text, dataIndex });
            cell.el.dom.classList.add('x-gridcell', `cell-${dataIndex}`);
        }
    }
};

const atData = async (selector) => {
    await page.setContent('<main></main>');
    await page.evaluate(FAKE_EXT_DATA);
    return recordLocator(page.mainFrame(), page.locator(selector).first(), { framework: 'extjs' });
};

test('extjs: list entries and grid rows by their text, tools, icons, fields beside a heading, everything in a dialog scoped by it', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const cases = [
        ['.x-boundlist .x-simplelistitem:first-child span', "locator('extjs=boundlist simplelistitem').filter({ hasText: /^Sonstiges$/ }).locator('span')", 'a list entry by its whole text, not by "Sonstiges Weiteres"'],
        ['.x-grid .x-gridrow:nth-child(3)', "locator('extjs=grid gridrow').filter({ hasText: '9000001' })", 'a row by the shortest cell no other row has'],
        ['.x-aufgabengrid .x-gridrow:first-child .cell-Bezeichnung', "locator('extjs=aufgabengrid gridrow').filter({ hasText: '9000001' }).locator('extjs=gridcell[dataIndex=\"Bezeichnung\"]')", 'a cell by its column: its name is also in another column of the row'],
        ['.x-grid .x-gridrow:nth-child(2)', "locator('extjs=grid gridrow').filter({ hasText: '1000001' }).filter({ hasText: 'D' })", 'no single cell is unique: two, in cell order'],
        ['.x-grid .x-gridrow:nth-child(3) .x-gridcell:nth-child(2)', "locator('extjs=grid gridrow').filter({ hasText: '9000001' }).locator('extjs=gridcell').filter({ hasText: /^Muster, Erika$/ })", 'a cell: its row, then its text'],
        ['.x-dialog .x-tool', "locator('extjs=dialog[title=\"Termin anlegen\"]').locator('extjs=tool[type=\"close\"]')", 'a tool by its type, in its dialog'],
        ['body > .x-auswahl:nth-child(5) .x-listitem button', "locator('extjs=list listitem').filter({ hasText: /^Zahnärzte$/ }).locator('extjs=button[iconCls=\"x-fa fa-trash\"]').locator('button')", 'an icon button in a list entry'],
        ['body > .x-auswahl:nth-child(5) input', "locator('extjs=auswahl').filter({ has: getByText('Fachgebiete*', { exact: true }) }).locator('extjs=combobox').locator('input')", 'a field without a label, by the heading beside it'],
        ['.x-messagebox .x-button:first-child button', "locator('extjs=messagebox[title=\"Fenster Schließen\"]').locator('extjs=button[text=\"Ja\"]').locator('button')", 'the text before a generic itemId (yes), in its message box'],
        ['#radio-ja', "locator('extjs=dialog[title=\"Termin anlegen\"]').getByRole('radio', { name: 'Ja', exact: true })", 'a role locator inside a dialog gets the dialog too'],
    ];
    for (const [selector, expected, why] of cases) {
        const code = await atData(selector);
        assert.equal(code, expected, why);
        assert.equal(await buildLocator(page.mainFrame(), parseLocator(code)).evaluate((node, wanted) => node === document.querySelector(wanted), selector), true, `finds it again: ${code}`);
    }
    return undefined;
});

test('extjsMatches: the page itself checks a chain as the engine would, for the demonstration at the pointerdown', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent('<main></main>');
    await page.evaluate(FAKE_EXT_DATA);
    const pick = await page.evaluate(`(${extjsCandidates})`.length > 0 ? `(() => { const el = document.querySelector('.x-boundlist .x-simplelistitem:first-child span'); const found = (${extjsCandidates})(el); return found.chains.find((chain) => (${extjsMatches})(el, chain)) ?? null; })()` : 'null');
    assert.deepEqual(pick, [{ extjs: 'boundlist simplelistitem' }, { exact: 'Sonstiges' }, { css: 'span' }]);
    assert.equal(await page.evaluate(`(${extjsMatches})(document.querySelector('.x-boundlist span'), [{ extjs: 'boundlist simplelistitem' }, { css: 'span' }])`), false, 'two entries: not unique');
    return undefined;
});

test('extjs: without Ext or outside ExtJS nothing is derived from components', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent('<div id="ext-button-1"><button id="ext-element-5"></button></div>');
    assert.equal(await recordLocator(page.mainFrame(), page.locator('button'), { framework: 'extjs' }), null, 'no Ext: unstable');
    return undefined;
});
