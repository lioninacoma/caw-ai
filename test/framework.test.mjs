import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FRAMEWORK, FRAMEWORKS, frameworkOf, targetLabel, waitQuiet } from '../src/host/framework/index.mjs';
import { FRAMEWORK_NAMES, validateConfig } from '../src/shared/config.mjs';

const fakeClock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};

/** Seite, deren Probe der Reihe nach die Werte aus `samples` liefert, danach immer den letzten. `null` heisst: Auswertung scheitert. */
const probePage = (samples) => {
    let calls = 0;
    return { evaluate: async () => { const sample = samples[Math.min(calls, samples.length - 1)]; calls += 1; if (sample === null) throw new Error('navigiert'); return sample; } };
};
const calm = { pendingAjax: 0, loadingStores: 0, counts: null, appReady: true };

test('Framework: web ist der Standard, extjs auf Wunsch, Config kennt genau die Adapter', () => {
    assert.equal(DEFAULT_FRAMEWORK, 'web');
    assert.equal(frameworkOf().name, 'web');
    assert.equal(frameworkOf({}).name, 'web');
    assert.equal(frameworkOf({ framework: 'extjs' }).name, 'extjs');
    assert.deepEqual(Object.keys(FRAMEWORKS).sort(), [...FRAMEWORK_NAMES].sort());
    for (const adapter of Object.values(FRAMEWORKS)) {
        for (const key of ['targets', 'pageState', 'probe']) assert.equal(typeof adapter[key], 'function', `${adapter.name}.${key}`);
        assert.equal(typeof adapter.label, 'string');
    }
    assert.match(validateConfig({ framework: 'svelte' }).issues.join('\n'), /framework muss einer von web, extjs, react, vue, angular/);
    assert.doesNotMatch(validateConfig({ framework: 'react' }).issues.join('\n'), /framework/);
    assert.doesNotMatch(validateConfig({ framework: 'extjs' }).issues.join('\n'), /framework/);
});

test('Framework: Kurzform für Meldungen, ExtJS und neutral', () => {
    assert.equal(targetLabel({ xtype: 'app_actionButton', text: 'Weiter' }), 'app_actionButton "Weiter"');
    assert.equal(targetLabel({ role: 'button', name: 'Senden' }), 'button "Senden"');
    assert.equal(targetLabel({ testid: 'speichern' }), 'Element "#speichern"');
    assert.equal(targetLabel({ tag: 'div', own: 'Kachel' }), 'div "Kachel"');
});

test('Warten: ruhig erst nach quietMs am Stück, offene Requests zählen nur bei countNetwork', async () => {
    const busy = { ...calm, loadingStores: 1 };
    const result = await waitQuiet(FRAMEWORKS.extjs, probePage([busy, busy, calm]), { quietMs: 250, pollMs: 100, ...fakeClock() });
    assert.equal(result.settled, true);
    assert.equal(result.waitedMs, 500, 'unruhig bis 100 ms, ruhig ab 200 ms, im 100-ms-Takt erst bei 500 ms über 250 ms');

    const open = await waitQuiet(FRAMEWORKS.web, probePage([calm]), { timeout: 1000, pending: () => 1, ...fakeClock() });
    assert.equal(open.settled, false, 'web: offener Request hält auf');
    assert.equal(open.lastSample.pendingAjax, 1);
    const ignored = await waitQuiet(FRAMEWORKS.extjs, probePage([calm]), { timeout: 1000, pending: () => 1, ...fakeClock() });
    assert.equal(ignored.settled, true, 'extjs zählt selbst über Ext.Ajax');
});

test('Warten: gescheiterte Auswertung (Seitenwechsel) ist nicht ruhig, minCount wartet auf Treffer', async () => {
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

test('extjs: Gleiche Knöpfe bekommen ihren Bereich, auch wenn der Zwilling gerade verdeckt ist, und das Abspielen trifft nie den Zwilling', async () => {
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
    globalThis.window = { Ext: { getCmp: (id) => components[id] ?? null, ComponentQuery: { query: (xtype) => Object.values(components).filter((c) => c.xtype === xtype) } } };
    globalThis.document = { elementFromPoint: () => top };
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    try {
        // Aufnahme: Das Sheet liegt ueber dem Formular, nur sein Knopf ist erreichbar.
        const target = extjsTargets(sheetButton, { mode: 'describe' });
        assert.deepEqual(target, { xtype: 'button', text: 'Speichern', inside: { xtype: 'sheet', label: 'Preis' }, own: 'Speichern' });
        // Abspielen, bevor das Sheet offen ist: Der Knopf im Formular ist frei, wird aber nicht getroffen.
        sheetButton.visible = false;
        top = formButton;
        assert.equal(extjsTargets(null, { mode: 'find', target }), null);
        sheetButton.visible = true;
        top = sheetButton;
        assert.equal(extjsTargets(null, { mode: 'find', target }), sheetButton);
        // Ohne Zwilling bleibt die Beschreibung kurz wie bisher.
        delete components.bf;
        assert.deepEqual(extjsTargets(sheetButton, { mode: 'describe' }), { xtype: 'button', text: 'Speichern', own: 'Speichern' });
    } finally {
        Object.assign(globalThis, saved);
    }
});
