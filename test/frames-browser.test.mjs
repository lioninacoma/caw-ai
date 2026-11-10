// Ziele in iframes der Anwendung: beschreiben mit `frame`, wiederfinden, erklaeren, wenn der Frame fehlt. Ohne Chrome uebersprungen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { describeElement, explainTarget, explainText, frameOf, frameworkOf, waitForTarget } from '../src/host/framework/index.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

const INNER = '<form aria-label="Karte"><label>Kartennummer <input id="k"></label><button>Bezahlen</button></form>';
const OUTER = `<h2>Zahlung</h2><iframe title="Karte" style="width:300px;height:120px" srcdoc='${INNER}'></iframe>`;
const PAGE = `<main><button>Bezahlen</button><iframe title="Zahlung" style="width:400px;height:240px" srcdoc="${OUTER.replaceAll('"', '&quot;')}"></iframe></main>`;

const loaded = async () => {
    await page.setContent(PAGE);
    for (let i = 0; i < 50 && page.frames().length < 3; i += 1) await new Promise((ok) => { setTimeout(ok, 50); });
    await Promise.all(page.frames().map((frame) => frame.waitForLoadState('load')));
};

test('iframes: Ziel im verschachtelten Frame beschreiben, mit frame wiederfinden', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await loaded();
    const web = frameworkOf();
    const inner = page.frames().find((frame) => frame.parentFrame() !== null && frame.parentFrame() !== page.mainFrame());
    const button = await inner.locator('button').elementHandle();
    const described = await describeElement(web, page, button);
    assert.deepEqual(described, {
        role: 'button', name: 'Bezahlen', inside: { role: 'form', name: 'Karte' },
        frame: { tag: 'iframe', name: 'Karte', frame: { tag: 'iframe', name: 'Zahlung' } },
    });
    const main = await page.locator('main > button').elementHandle();
    assert.deepEqual(await describeElement(web, page, main), { role: 'button', name: 'Bezahlen' }, 'im Hauptframe kein frame');

    assert.equal(await frameOf(page, described.frame), inner);
    const found = await waitForTarget(web, page, described, { timeoutMs: 2000 });
    assert.ok(found !== null);
    assert.equal(await found.evaluate((node) => node.ownerDocument.defaultView.frameElement?.title), 'Karte');
    const field = await waitForTarget(web, page, { role: 'textbox', name: 'Kartennummer', frame: described.frame }, { timeoutMs: 2000 });
    await field.fill('4111');
    assert.equal(await inner.locator('#k').inputValue(), '4111');
    return undefined;
});

test('iframes: Ein iframe in einem Bereich mit Rolle steht selbst im Ziel, nicht der Bereich', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await page.setContent(`<div role="dialog" aria-label="Kasse"><iframe title="Zahlung" style="width:300px;height:120px" srcdoc="<button>Bezahlen</button>"></iframe></div>`);
    for (let i = 0; i < 50 && page.frames().length < 2; i += 1) await new Promise((ok) => { setTimeout(ok, 50); });
    await Promise.all(page.frames().map((frame) => frame.waitForLoadState('load')));
    const web = frameworkOf();
    const button = await page.frames()[1].locator('button').elementHandle();
    const described = await describeElement(web, page, button);
    assert.deepEqual(described.frame, { tag: 'iframe', name: 'Zahlung', inside: { role: 'dialog', name: 'Kasse' } });
    assert.ok(await waitForTarget(web, page, described, { timeoutMs: 2000 }) !== null);
    return undefined;
});

test('iframes: Fehlt der Frame, sagt die Erklärung welcher', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    await loaded();
    const web = frameworkOf();
    const target = { role: 'button', name: 'Bezahlen', frame: { tag: 'iframe', name: 'Kasse' } };
    assert.equal(await waitForTarget(web, page, target, { timeoutMs: 300 }), null);
    const why = await explainTarget(web, page, target);
    assert.deepEqual(why, { frameMissing: 'iframe "Kasse"' });
    assert.match(explainText(why), /Frame iframe "Kasse" fehlt/);
    const inFrame = await explainTarget(web, page, { role: 'button', name: 'Abbrechen', frame: { tag: 'iframe', name: 'Zahlung' } });
    assert.equal(inFrame.missing, true, 'im gefundenen Frame wie sonst');
    return undefined;
});
