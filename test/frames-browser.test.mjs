// Targets in application iframes: describe with `frame`, find again, explain when the frame is missing. Skipped without Chrome.
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

const INNER = '<form aria-label="Card"><label>Card number <input id="k"></label><button>Pay</button></form>';
const OUTER = `<h2>Payment</h2><iframe title="Card" style="width:300px;height:120px" srcdoc='${INNER}'></iframe>`;
const PAGE = `<main><button>Pay</button><iframe title="Payment" style="width:400px;height:240px" srcdoc="${OUTER.replaceAll('"', '&quot;')}"></iframe></main>`;

const loaded = async () => {
    await page.setContent(PAGE);
    for (let i = 0; i < 50 && page.frames().length < 3; i += 1) await new Promise((ok) => { setTimeout(ok, 50); });
    await Promise.all(page.frames().map((frame) => frame.waitForLoadState('load')));
};

test('iframes: describe a target in a nested frame, find it again with frame', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await loaded();
    const web = frameworkOf();
    const inner = page.frames().find((frame) => frame.parentFrame() !== null && frame.parentFrame() !== page.mainFrame());
    const button = await inner.locator('button').elementHandle();
    const described = await describeElement(web, page, button);
    assert.deepEqual(described, {
        role: 'button', name: 'Pay', inside: { role: 'form', name: 'Card' },
        frame: { tag: 'iframe', name: 'Card', frame: { tag: 'iframe', name: 'Payment' } },
    });
    const main = await page.locator('main > button').elementHandle();
    assert.deepEqual(await describeElement(web, page, main), { role: 'button', name: 'Pay' }, 'no frame in the main frame');

    assert.equal(await frameOf(page, described.frame), inner);
    const found = await waitForTarget(web, page, described, { timeoutMs: 2000 });
    assert.ok(found !== null);
    assert.equal(await found.evaluate((node) => node.ownerDocument.defaultView.frameElement?.title), 'Card');
    const field = await waitForTarget(web, page, { role: 'textbox', name: 'Card number', frame: described.frame }, { timeoutMs: 2000 });
    await field.fill('4111');
    assert.equal(await inner.locator('#k').inputValue(), '4111');
    return undefined;
});

test('iframes: an iframe inside a region with a role is itself in the target, not the region', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await page.setContent(`<div role="dialog" aria-label="Checkout"><iframe title="Payment" style="width:300px;height:120px" srcdoc="<button>Pay</button>"></iframe></div>`);
    for (let i = 0; i < 50 && page.frames().length < 2; i += 1) await new Promise((ok) => { setTimeout(ok, 50); });
    await Promise.all(page.frames().map((frame) => frame.waitForLoadState('load')));
    const web = frameworkOf();
    const button = await page.frames()[1].locator('button').elementHandle();
    const described = await describeElement(web, page, button);
    assert.deepEqual(described.frame, { tag: 'iframe', name: 'Payment', inside: { role: 'dialog', name: 'Checkout' } });
    assert.ok(await waitForTarget(web, page, described, { timeoutMs: 2000 }) !== null);
    return undefined;
});

test('iframes: if the frame is missing, the explanation says which one', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    await loaded();
    const web = frameworkOf();
    const target = { role: 'button', name: 'Pay', frame: { tag: 'iframe', name: 'Checkout' } };
    assert.equal(await waitForTarget(web, page, target, { timeoutMs: 300 }), null);
    const why = await explainTarget(web, page, target);
    assert.deepEqual(why, { frameMissing: 'iframe "Checkout"' });
    assert.match(explainText(why), /Frame iframe "Checkout" fehlt/);
    const inFrame = await explainTarget(web, page, { role: 'button', name: 'Cancel', frame: { tag: 'iframe', name: 'Payment' } });
    assert.equal(inFrame.missing, true, 'inside the found frame as usual');
    return undefined;
});
