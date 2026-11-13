// Selector engine extjs=: ComponentQuery over a tiny fake Ext, through Playwright (chaining, hidden, destroyed, nth, filter,
// strict mode). Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { EXTJS_ENGINE, registerEngines } from '../src/host/framework/extjs-engine.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    await registerEngines();
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

// A fake Ext: components with xtype, text/title, a container, hidden and destroyed flags, and el.dom. ComponentQuery knows
// `xtype`, `xtype[attr="value"]` and `#itemId`, nothing else, and throws like the real one on anything else.
const FAKE_EXT = () => {
    const all = [];
    const make = (xtype, { text, title, itemId, hidden = false, destroyed = false, parent = null } = {}) => {
        const dom = document.createElement('div');
        dom.className = `x-${xtype}`;
        dom.textContent = text ?? '';
        (parent?.el.dom ?? document.body).append(dom);
        const component = {
            xtype, text, title, itemId, hidden, destroyed, ownerCt: parent, el: { dom },
            isVisible(deep) {
                if (this.hidden) return false;
                return !deep || this.ownerCt === null || this.ownerCt.isVisible(true);
            },
        };
        all.push(component);
        return component;
    };
    const parse = (selector) => {
        let match = /^#([\w-]+)$/.exec(selector);
        if (match) return (component) => component.itemId === match[1];
        match = /^([\w-]+)(?:\[(\w+)="([^"]*)"\])?$/.exec(selector);
        if (!match) throw new Error(`Invalid ComponentQuery selector: "${selector}"`);
        return (component) => component.xtype === match[1] && (match[2] === undefined || component[match[2]] === match[3]);
    };
    window.Ext = { ComponentQuery: { query: (selector) => all.filter(parse(selector)) } };

    const first = make('window', { title: 'First' });
    make('button', { text: 'Save', parent: first });
    make('button', { text: 'Cancel', parent: first, itemId: 'cancelFirst' });
    const second = make('window', { title: 'Second' });
    make('button', { text: 'Save', parent: second });
    make('button', { text: 'Delete', parent: second, hidden: true });
    const closed = make('window', { title: 'Closed', hidden: true });
    make('button', { text: 'Ghost', parent: closed });
    const gone = make('button', { text: 'Gone' });
    gone.destroyed = true;
    // Component whose element is not in the page (not rendered).
    all.push({ xtype: 'button', text: 'Unrendered', destroyed: false, isVisible: () => true, el: { dom: document.createElement('div') } });
};

const loaded = async () => {
    await page.setContent('<main></main>');
    await page.evaluate(FAKE_EXT);
};

const texts = async (locator) => locator.evaluateAll((elements) => elements.map((element) => element.textContent));

test('extjs engine: visible, not destroyed, rendered components only, in document order', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await loaded();
    assert.deepEqual(await texts(page.locator('extjs=button')), ['Save', 'Cancel', 'Save']);
    assert.equal(await page.locator('extjs=window').count(), 2, 'the hidden window is out');
    assert.deepEqual(await texts(page.locator('extjs=#cancelFirst')), ['Cancel']);
    assert.equal(await page.locator('extjs=button[text="Ghost"]').count(), 0, 'inside a hidden container');
    assert.equal(await page.locator('extjs=button[text="Gone"]').count(), 0, 'destroyed');
    assert.equal(await page.locator('extjs=button[text="Delete"]').count(), 0, 'hidden itself');
    return undefined;
});

test('extjs engine: chaining scopes to the root, nth and filter work', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await loaded();
    const second = page.locator('extjs=window[title="Second"]');
    assert.deepEqual(await texts(second.locator('extjs=button')), ['Save']);
    assert.deepEqual(await texts(page.locator('extjs=window[title="First"]').locator('extjs=button')), ['Save', 'Cancel']);
    assert.equal(await second.locator('extjs=window').count(), 0, 'the root itself is not inside the root');
    assert.equal(await page.locator('extjs=button[text="Save"]').nth(1).evaluate((element) => element.parentElement === document.querySelectorAll('.x-window')[1]), true, 'nth(1) is the one in the second window');
    assert.deepEqual(await texts(page.locator('extjs=button').filter({ hasText: 'Cancel' })), ['Cancel']);
    assert.equal(await page.locator('extjs=window').filter({ has: page.locator('extjs=button[text="Cancel"]') }).count(), 1);
    assert.equal(await page.locator('extjs=button[text="Save"]').and(page.locator('.x-button')).count(), 2);
    return undefined;
});

test('extjs engine: strict mode fails for two matches, an action on one match works', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await loaded();
    await assert.rejects(page.locator('extjs=button[text="Save"]').click({ timeout: 1000 }), /strict mode violation/);
    await page.locator('extjs=window[title="Second"]').locator('extjs=button[text="Save"]').click({ timeout: 1000 });
    return undefined;
});

test('extjs engine: without Ext nothing matches, a bad query reports the ComponentQuery error', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent('<button>Save</button>');
    assert.equal(await page.locator('extjs=button').count(), 0);
    await loaded();
    await assert.rejects(page.locator('extjs=button[').count(), /Invalid ComponentQuery selector/);
    // A comma in a quoted value: refused before ComponentQuery sees it, so the application's console stays clean.
    const logged = [];
    const listen = (message) => logged.push(message.text());
    page.on('console', listen);
    try {
        await page.evaluate(() => {
            const query = window.Ext.ComponentQuery.query;
            window.Ext.ComponentQuery.query = (selector) => { console.error(`queried: ${selector}`); return query(selector); };
        });
        await assert.rejects(page.locator('extjs=messagebox button[text="Ja, Antrag abschließen"]').count(), /cannot match a value with a comma/);
        await assert.rejects(page.locator("extjs=button[text='a, b']").count(), /cannot match a value with a comma/);
        // A comma between two queries is ComponentQuery's own list: not refused here (this fake does not know lists).
        await assert.rejects(page.locator('extjs=button[text="Save"], button[text="Cancel"]').count(), (error) => !/a value with a comma/.test(error.message));
        assert.deepEqual(logged.filter((text) => text.includes(',') && text.includes('Ja')), [], 'never reached ComponentQuery');
    } finally {
        page.off('console', listen);
    }
    return undefined;
});

test('extjs engine: works in a frame with its own Ext', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent('<iframe title="App" srcdoc="<main></main>"></iframe>');
    const frame = page.frameLocator('iframe');
    await frame.locator('main').waitFor({ state: 'attached' });
    await page.frames()[1].evaluate(FAKE_EXT);
    assert.equal(await page.locator('extjs=button').count(), 0, 'no Ext in the main frame');
    assert.equal(await page.locator('iframe').contentFrame().locator('extjs=button[text="Cancel"]').count(), 1);
    return undefined;
});

test('registerEngines: once per selectors object, "already registered" is no error, other errors are', async () => {
    const calls = [];
    const fake = { register: async (name, script) => { calls.push([name, script.content]); } };
    await registerEngines(fake);
    await registerEngines(fake);
    assert.deepEqual(calls, [['extjs', EXTJS_ENGINE]]);
    await registerEngines({ register: async () => { throw new Error('selectors.register: "extjs" selector engine has been already registered'); } });
    await assert.rejects(registerEngines({ register: async () => { throw new Error('boom'); } }), /boom/);
    await registerEngines();
});
