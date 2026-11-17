import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FRAMEWORK, FRAMEWORKS, closestNames, explainText, frameworkOf, waitQuiet } from '../src/host/framework/index.mjs';
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

test('Framework: why a locator found nothing, as a sentence; a renamed name is suggested', () => {
    assert.deepEqual(closestNames('Speichern', ['Sichern', 'Abbrechen', 'Speichern']), ['Sichern']);
    assert.deepEqual(closestNames('Akte anlegen', ['Neue Akte anlegen', 'Hilfe']), ['Neue Akte anlegen']);
    assert.match(explainText({ frameMissing: 'iframe "Zahlung"' }), /iframe "Zahlung"/);
    assert.match(explainText({ missing: true, similar: [{ role: 'button', name: 'Sichern' }] }), /button "Sichern"/);
    assert.match(explainText({ covered: { role: 'dialog', name: 'Hinweis', messages: ['Sitzung abgelaufen.'] } }), /"Hinweis".*"Sitzung abgelaufen\."/);
    assert.equal(explainText(null), '');
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

test('Waiting: untilApp waits for the app to mount after quiet (dev server), and settles without it at the timeout', async () => {
    const empty = { ...calm, appReady: false };
    const early = await waitQuiet(FRAMEWORKS.vue, probePage([empty, empty, empty, empty, empty, empty, calm]), { quietMs: 250, ...fakeClock() });
    assert.equal(early.lastSample.appReady, false, 'without untilApp the empty page counts as quiet');
    const mounted = await waitQuiet(FRAMEWORKS.vue, probePage([empty, empty, empty, empty, empty, empty, calm]), { quietMs: 250, untilApp: true, ...fakeClock() });
    assert.equal(mounted.settled, true);
    assert.equal(mounted.lastSample.appReady, true);
    assert.equal(mounted.waitedMs, 600);
    const never = await waitQuiet(FRAMEWORKS.vue, probePage([empty]), { timeout: 1000, quietMs: 250, untilApp: true, ...fakeClock() });
    assert.equal(never.settled, true, 'quiet without the app: settled, the caller reports app-not-loaded');
    assert.equal(never.lastSample.appReady, false);
    assert.equal(never.waitedMs, 1000);
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

test('extjs: a button under a sheet is not reachable, the one on the sheet is; a hidden one is explained as hidden', async () => {
    const { extjsTargets } = await import('../src/ext/extjs/extjs.mjs');
    const node = (id, parent, text = '') => {
        const element = { id, parentElement: parent, tagName: 'DIV', classList: [], innerText: text, visible: true, children: [] };
        element.getBoundingClientRect = () => (element.visible ? { left: 0, top: 0, width: 10, height: 10 } : { left: 0, top: 0, width: 0, height: 0 });
        element.contains = (other) => other === element || element.children.some((child) => child.contains(other));
        element.querySelectorAll = () => [];
        element.closest = () => null;
        element.scrollIntoView = () => {};
        element.scrollTop = 0;
        element.scrollLeft = 0;
        parent?.children.push(element);
        return element;
    };
    const body = node('', null);
    const formEl = node('f', body);
    const sheetEl = node('s', body);
    const formButton = node('bf', formEl, 'Speichern');
    const sheetButton = node('bs', sheetEl, 'Speichern');
    const cmp = (xtype, dom, extra) => ({ xtype, el: { dom }, ...extra });
    const components = { f: cmp('formpanel', formEl), s: cmp('sheet', sheetEl), bf: cmp('button', formButton), bs: cmp('button', sheetButton) };
    const saved = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
    globalThis.window = { Ext: { getCmp: (id) => components[id] ?? null }, scrollX: 0, scrollY: 0, scrollTo: () => {} };
    globalThis.document = { elementFromPoint: () => sheetButton };
    globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    try {
        // The sheet covers the form: of the two "Speichern" only its own counts, so a locator matching both is not ambiguous.
        assert.equal(extjsTargets(sheetButton, { mode: 'reachable' }), true);
        assert.equal(extjsTargets(formButton, { mode: 'reachable' }), false);
        assert.deepEqual(extjsTargets(formButton, { mode: 'blocked' }), { covered: { tag: 'div' } });
        assert.equal(extjsTargets(sheetButton, { mode: 'blocked' }), null);
        sheetButton.visible = false;
        assert.deepEqual(extjsTargets(sheetButton, { mode: 'blocked' }), { hidden: true });
        assert.deepEqual(extjsTargets(null, { mode: 'names', target: { role: 'button' } }), []);
    } finally {
        Object.assign(globalThis, saved);
    }
});
