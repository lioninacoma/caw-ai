// The human demonstrates, in real Chrome (headless): the page marks what the pointer or a key went to, the host turns the mark
// into the locator a recording stores. Also the crosshair pick. Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { demonstrate, pickElement, recordableSteps } from '../src/host/demonstrate.mjs';
import { playReplay } from '../src/host/replay.mjs';
import { MARK_ATTRIBUTE } from '../src/host/record-locator.mjs';
import { launchChrome } from './chrome.mjs';

const ORIGIN = 'https://caw.test';
// "Speichern" closes its dialog after the click: the mark is set on pointerdown, the host resolves it meanwhile. That takes
// 200-600 ms under load (measured in the full suite); an element gone before that is recorded with the generator's locator,
// without the exact name, or reported as unstable.
const FORM = `<!doctype html><title>Form</title><label>Titel <input></label>
<label>Tag <select><option value="work">#work</option><option value="home">#home</option></select></label>
<div id="d" role="dialog" aria-label="Neue Aufgabe"><button onclick="setTimeout(() => document.getElementById('d').remove(), 1000)">Speichern</button></div>
<iframe title="Zahlung" src="/pay"></iframe>`;
// A button in front of a hidden file field, as most applications have it.
const UPLOAD = `<!doctype html><title>Upload</title><button onclick="document.getElementById('f').click()">Dokument hochladen</button><input type="file" id="f" hidden><button>Weiter</button>`;
// A combobox chosen by keyboard, as ExtJS does it: the arrows move the highlight, Enter sets the value from script (no input event).
const COMBO = `<!doctype html><meta charset="utf-8"><title>Notiz</title><label>Priorität <input id="prio" onkeydown="const list = ['hoch', 'mittel', 'niedrig']; const i = Number(this.dataset.at ?? -1);if (event.key === 'ArrowDown') this.dataset.at = Math.min(i + 1, 2); else if (event.key === 'ArrowUp') this.dataset.at = Math.max(i - 1, 0);else if (event.key === 'Enter') this.value = list[i] ?? '';"></label><button>Speichern</button>`;
// A row that opens only on double-click, as grids do; a single click only selects it.
const GRID = `<!doctype html><title>Liste</title><div role="grid"><div role="row" ondblclick="document.title = 'offen'" onclick="this.ariaSelected = 'true'"><span role="gridcell">1000001</span><span role="gridcell">Muster, Erika</span></div>
<div role="row"><span role="gridcell">9000001</span><span role="gridcell">Beispiel, Max</span></div></div>`;

let browser = null;
let context = null;
let page = null;
let dir = null;
before(async () => {
    browser = await launchChrome();
    context = await browser?.newContext();
    page = await context?.newPage();
    await page?.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/pay') ? '<button>Bezahlen</button>' : route.request().url().endsWith('/grid') ? GRID : route.request().url().endsWith('/upload') ? UPLOAD : route.request().url().endsWith('/combo') ? COMBO : FORM }));
    dir = mkdtempSync(join(tmpdir(), 'caw-demo-'));
});
after(async () => {
    await browser?.close();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
});
const needsChrome = () => browser === null;

const session = () => ({ context, ownsPage: (candidate) => candidate === page, page: () => page, closed: new Promise(() => {}) });
const marks = async () => {
    const counts = await Promise.all(page.frames().map((frame) => frame.locator(`[${MARK_ATTRIBUTE}]`).count()));
    return counts.reduce((sum, count) => sum + count, 0);
};
const open = async () => {
    await page.goto(`${ORIGIN}/`);
    await page.frameLocator('iframe[title="Zahlung"]').getByRole('button').waitFor();
};

test('demonstration: clicks, a typed field, a <select> and Enter become locators, also in a frame; no mark is left', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await open();
    const items = await demonstrate({
        session: session(),
        ui: { step: () => {} },
        dir,
        operator: {
            nextLine: async () => {
                await page.getByRole('textbox', { name: 'Titel' }).click();
                await page.keyboard.type('Milch');
                await page.keyboard.press('Enter');
                await page.getByRole('combobox', { name: 'Tag' }).focus();
                await page.keyboard.press('ArrowDown');
                // A human holds the button for a moment; the dialog is gone right after the click.
                await page.getByRole('button', { name: 'Speichern' }).click({ delay: 100 });
                await page.frameLocator('iframe[title="Zahlung"]').getByRole('button', { name: 'Bezahlen' }).click();
                return '';
            },
        },
    });
    const { steps, problems } = recordableSteps(items);
    assert.deepEqual(problems, []);
    assert.deepEqual(steps.map(({ action, target, value, key }) => [action, target ?? key, value]), [
        ['click', "getByRole('textbox', { name: 'Titel', exact: true })", undefined],
        ['fill', "getByRole('textbox', { name: 'Titel', exact: true })", 'Milch'],
        ['press', 'Enter', undefined],
        ['fill', "getByRole('combobox', { name: 'Tag', exact: true })", 'home'],
        // In a dialog: always scoped by it.
        ['click', "getByRole('dialog', { name: 'Neue Aufgabe', exact: true }).getByRole('button', { name: 'Speichern', exact: true })", undefined],
        ['click', "locator('iframe[title=\"Zahlung\"]').contentFrame().getByRole('button', { name: 'Bezahlen', exact: true })", undefined],
    ]);
    assert.ok(!JSON.stringify(items).includes(MARK_ATTRIBUTE));
    assert.ok(items.every(({ mark }) => mark === undefined), 'the mark is the page\'s business');
    assert.equal(await marks(), 0, 'every mark was removed again');
    return undefined;
});

test('demonstration: a double-click becomes one dblclick instead of two clicks; a single click stays a click', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/grid`);
    const items = await demonstrate({
        session: session(),
        ui: { step: () => {} },
        dir,
        operator: {
            nextLine: async () => {
                await page.getByRole('row').filter({ hasText: '9000001' }).click();
                await page.getByRole('row').filter({ hasText: '1000001' }).dblclick({ delay: 100 });
                return '';
            },
        },
    });
    assert.equal(await page.title(), 'offen');
    const { steps, problems } = recordableSteps(items);
    assert.deepEqual(problems, []);
    assert.deepEqual(steps.map(({ action, target }) => [action, target]), [
        ['click', "getByRole('row').filter({ hasText: '9000001' })"],
        ['dblclick', "getByRole('row').filter({ hasText: '1000001' })"],
    ]);
    return undefined;
});

test('demonstration: a file chosen from caw/fixtures becomes an upload on the button that opened the chooser; a file from elsewhere is named, not recorded', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = join(dir, 'caw');
    mkdirSync(join(caw, 'fixtures'), { recursive: true });
    writeFileSync(join(caw, 'fixtures', 'brief.pdf'), '%PDF-1.4 brief');
    writeFileSync(join(dir, 'privat.pdf'), '%PDF-1.4 privat');
    await page.goto(`${ORIGIN}/upload`);
    const choose = async (path) => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Dokument hochladen' }).click();
        await (await chooser).setFiles(path);
    };
    const seen = [];
    const items = await demonstrate({
        session: session(),
        ui: { step: () => {} },
        dir,
        filesDir: caw,
        onItem: (item) => seen.push(item.action),
        operator: {
            nextLine: async () => {
                await choose(join(caw, 'fixtures', 'brief.pdf'));
                await page.getByRole('button', { name: 'Weiter' }).click();
                await choose(join(dir, 'privat.pdf'));
                return '';
            },
        },
    });
    const { steps, problems } = recordableSteps(items);
    assert.deepEqual(steps.map(({ action, target, files }) => [action, target, files]), [
        ['upload', "getByRole('button', { name: 'Dokument hochladen', exact: true })", ['fixtures/brief.pdf']],
        ['click', "getByRole('button', { name: 'Weiter', exact: true })", undefined],
        ['click', "getByRole('button', { name: 'Dokument hochladen', exact: true })", undefined],
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /privat\.pdf stammt nicht aus caw\/fixtures/);
    assert.ok(seen.includes('upload'), 'the chat sees the upload');
    assert.ok(!JSON.stringify(items).includes('privat pdf content'), 'never the content');
    return undefined;
});

test('demonstration: a choice made with the arrow keys is recorded as those keys and replays to the same value', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await page.goto(`${ORIGIN}/combo`);
    const items = await demonstrate({
        session: session(),
        ui: { step: () => {} },
        dir,
        operator: {
            nextLine: async () => {
                await page.getByRole('textbox', { name: 'Priorität' }).click();
                for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter']) await page.keyboard.press(key);
                return '';
            },
        },
    });
    assert.equal(await page.locator('#prio').inputValue(), 'mittel');
    const { steps } = recordableSteps(items);
    assert.deepEqual(steps.map(({ action, key }) => (action === 'press' ? key : action)), ['click', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Enter']);
    await page.goto(`${ORIGIN}/combo`);
    const { broken } = await playReplay({ replay: { steps }, handler: async (command) => { if (command.action === 'press') await page.keyboard.press(command.key); return 'ok'; }, session: { page: () => page, waitReady: async () => ({ settled: true }) }, base: ORIGIN, stepTimeoutMs: 10000 });
    assert.equal(broken, null);
    assert.equal(await page.locator('#prio').inputValue(), 'mittel', 'replayed to the same choice');
    return undefined;
});

test('crosshair: the picked element comes back as its locator, the page keeps no mark', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await open();
    const picking = pickElement(session());
    await page.waitForFunction(() => window.__cawPicking === true);
    await page.getByRole('button', { name: 'Speichern' }).click();
    const picked = await picking;
    assert.equal(picked.target, "getByRole('dialog', { name: 'Neue Aufgabe', exact: true }).getByRole('button', { name: 'Speichern', exact: true })");
    assert.equal(picked.label, 'button "Speichern" in dialog "Neue Aufgabe"');
    assert.equal(await page.locator('#d').count(), 1, 'the pick does not reach the application');
    assert.equal(await marks(), 0);
    return undefined;
});

test('crosshair: a disabled button can be picked (it gets no click, only pointer events); an enabled one is never clicked', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    await open();
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button disabled>Hinzufügen</button><button onclick="document.title = \'geklickt\'">Weiter</button>'));
    const picking = pickElement(session());
    await page.waitForFunction(() => window.__cawPicking === true);
    // A person clicks the greyed-out button to ask why it is disabled.
    await page.getByRole('button', { name: 'Hinzufügen' }).click({ force: true });
    assert.equal((await picking)?.target, "getByRole('button', { name: 'Hinzufügen', exact: true })");
    const again = pickElement(session());
    await page.waitForFunction(() => window.__cawPicking === true);
    await page.getByRole('button', { name: 'Weiter' }).click();
    assert.equal((await again)?.target, "getByRole('button', { name: 'Weiter', exact: true })");
    await page.waitForTimeout(200);
    assert.equal(await page.title(), 'Form', 'the click that picked it never reaches the application');
    assert.equal(await marks(), 0);
    return undefined;
});
