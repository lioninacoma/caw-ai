import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FRAMEWORK, FRAMEWORKS, frameworkOf, targetLabel, waitQuiet } from '../src/host/framework/index.mjs';
import { FRAMEWORK_NAMES, validateConfig } from '../src/shared/config.mjs';

const fakeClock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};

/** A page whose probe returns the values from `samples` in order, then always the last one. `null` means evaluation fails. */
const probePage = (samples) => {
    let calls = 0;
    return { evaluate: async () => { const sample = samples[Math.min(calls, samples.length - 1)]; calls += 1; if (sample === null) throw new Error('navigated'); return sample; } };
};
const calm = { pendingAjax: 0, loadingStores: 0, counts: null, appReady: true };

test('Framework: web is the default, extjs on request, the config knows exactly the adapters', () => {
    assert.equal(DEFAULT_FRAMEWORK, 'web');
    assert.equal(frameworkOf().name, 'web');
    assert.equal(frameworkOf({}).name, 'web');
    assert.equal(frameworkOf({ framework: 'extjs' }).name, 'extjs');
    assert.deepEqual(Object.keys(FRAMEWORKS).sort(), [...FRAMEWORK_NAMES].sort());
    for (const adapter of Object.values(FRAMEWORKS)) {
        for (const key of ['targets', 'pageState', 'probe']) assert.equal(typeof adapter[key], 'function', `${adapter.name}.${key}`);
        assert.equal(typeof adapter.label(), 'string', `${adapter.name}.label() is localized text`);
    }
    assert.match(validateConfig({ framework: 'svelte' }).issues.join('\n'), /framework muss einer von web, extjs, react, vue, angular/);
    assert.doesNotMatch(validateConfig({ framework: 'react' }).issues.join('\n'), /framework/);
    assert.doesNotMatch(validateConfig({ framework: 'extjs' }).issues.join('\n'), /framework/);
});

test('Framework: short form for messages, ExtJS and neutral', () => {
    assert.equal(targetLabel({ xtype: 'app_actionButton', text: 'Weiter' }), 'app_actionButton "Weiter"');
    assert.equal(targetLabel({ role: 'button', name: 'Senden' }), 'button "Senden"');
    assert.equal(targetLabel({ testid: 'speichern' }), 'Element "#speichern"');
    assert.equal(targetLabel({ tag: 'div', own: 'Kachel' }), 'div "Kachel"');
});

test('Waiting: quiet only after quietMs in a row, open requests only count with countNetwork', async () => {
    const busy = { ...calm, loadingStores: 1 };
    const result = await waitQuiet(FRAMEWORKS.extjs, probePage([busy, busy, calm]), { quietMs: 250, pollMs: 100, ...fakeClock() });
    assert.equal(result.settled, true);
    assert.equal(result.waitedMs, 500, 'busy until 100 ms, quiet from 200 ms, polling every 100 ms exceeds 250 ms only at 500 ms');

    const open = await waitQuiet(FRAMEWORKS.web, probePage([calm]), { timeout: 1000, pending: () => 1, ...fakeClock() });
    assert.equal(open.settled, false, 'web: an open request holds up');
    assert.equal(open.lastSample.pendingAjax, 1);
    const ignored = await waitQuiet(FRAMEWORKS.extjs, probePage([calm]), { timeout: 1000, pending: () => 1, ...fakeClock() });
    assert.equal(ignored.settled, true, 'extjs counts itself via Ext.Ajax');
});

test('Waiting: failed evaluation (navigation) is not quiet, minCount waits for hits', async () => {
    const navigating = await waitQuiet(FRAMEWORKS.web, probePage([null, null, calm]), { quietMs: 0, ...fakeClock() });
    assert.equal(navigating.settled, true);
    assert.equal(navigating.samples, 3);
    const few = { ...calm, counts: 1 };
    const enough = { ...calm, counts: 3 };
    const counted = await waitQuiet(FRAMEWORKS.web, probePage([few, few, enough]), { store: 'li', minCount: 3, quietMs: 0, ...fakeClock() });
    assert.equal(counted.lastSample.counts, 3);
    const never = await waitQuiet(FRAMEWORKS.web, probePage([few]), { store: 'li', minCount: 3, timeout: 500, ...fakeClock() });
    assert.equal(never.settled, false);
    assert.match(never.reason, /500ms/);
});

test('extjs: identical buttons get their enclosing component, even if the twin is covered, and replay never hits the twin', async () => {
    const { extjsTargets } = await import('../src/host/framework/extjs.mjs');
    const node = (id, parent, text = '') => {
        const element = { id, parentElement: parent, tagName: 'DIV', classList: [], innerText: text, visible: true, children: [] };
        element.getBoundingClientRect = () => (element.visible ? { left: 0, top: 0, width: 10, height: 10 } : { left: 0, top: 0, width: 0, height: 0 });
        element.contains = (other) => other === element || element.children.some((child) => child.contains(other));
        element.querySelectorAll = () => [];
        parent?.children.push(element);
        return element;
    };
    const body = node('', null);
    const formEl = node('f', body);
    const sheetEl = node('s', body);
    const formButton = node('bf', formEl, 'Speichern');
    const sheetButton = node('bs', sheetEl, 'Speichern');
    const cmp = (xtype, dom, extra) => ({ xtype, el: { dom }, ...extra });
    const components = {
        f: cmp('formpanel', formEl, { getLabel: () => 'Antrag' }),
        s: cmp('sheet', sheetEl, { getLabel: () => 'Preis' }),
        bf: cmp('button', formButton, { getText: () => 'Speichern' }),
        bs: cmp('button', sheetButton, { getText: () => 'Speichern' }),
    };
    let top = sheetButton;
    const saved = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
    globalThis.window = { Ext: { getCmp: (id) => components[id] ?? null, ComponentQuery: { query: (xtype) => Object.values(components).filter((component) => component.xtype === xtype) } } };
    globalThis.document = { elementFromPoint: () => top };
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    try {
        // Recording: the sheet covers the form, only its button is reachable.
        const target = extjsTargets(sheetButton, { mode: 'describe' });
        assert.deepEqual(target, { xtype: 'button', text: 'Speichern', inside: { xtype: 'sheet', label: 'Preis' }, own: 'Speichern' });
        // Replay before the sheet is open: the form button is free but is not hit.
        sheetButton.visible = false;
        top = formButton;
        assert.equal(extjsTargets(null, { mode: 'find', target }), null);
        sheetButton.visible = true;
        top = sheetButton;
        assert.equal(extjsTargets(null, { mode: 'find', target }), sheetButton);
        // Without a twin the description stays short as before.
        delete components.bf;
        assert.deepEqual(extjsTargets(sheetButton, { mode: 'describe' }), { xtype: 'button', text: 'Speichern', own: 'Speichern' });
    } finally {
        Object.assign(globalThis, saved);
    }
});
