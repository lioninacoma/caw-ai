// Blockzeichen zeichnet die Seite selbst, ohne Ersatzschrift: Der Spinner bleibt so breit wie [  OK  ]. Ohne Chrome uebersprungen.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright-core';

import { BLOCK_GLYPHS, CONSOLE_CSS, GLYPH_SCRIPT, themeCss } from '../src/host/theme.mjs';
import { loadTheme } from '../src/shared/theme-package.mjs';

let browser = null;

before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => null);
});
after(async () => {
    await browser?.close();
});

test('cawGlyph: Blockzeichen als Element mit Muster, alles andere als Text', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(`<script>${GLYPH_SCRIPT}</script>`);
    const result = await page.evaluate(() => ['▖', '▘', '█', 'x', '|'].map((char) => {
        const node = cawGlyph(char);
        return node.nodeType === Node.ELEMENT_NODE ? `${node.className}:${node.dataset.q}` : `text:${node.textContent}`;
    }));
    assert.deepEqual(result, ['qb:0010', 'qb:1000', 'qb:1111', 'text:x', 'text:|']);
    assert.equal(Object.keys(BLOCK_GLYPHS).length, 15);
});

test('Spinner in der Marke: so breit wie [  OK  ], das Viertel in currentColor an der richtigen Stelle', async (t) => {
    if (browser === null) return t.skip('kein Chrome');
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setContent(`<style>${themeCss(loadTheme('nacht'))}${CONSOLE_CSS}</style><script>${GLYPH_SCRIPT}</script>
<span class="tag tag-ok" id="ok">[  OK  ]</span><br><span class="tag tag-run" id="run">[  <span class="spinf" id="cell"></span>   ]</span>`);
    await page.evaluate(async () => {
        document.getElementById('cell').replaceChildren(cawGlyph('▖'));
        await document.fonts.ready;
    });
    const [ok, run, quarter] = await page.evaluate(() => [
        document.getElementById('ok').getBoundingClientRect().width,
        document.getElementById('run').getBoundingClientRect().width,
        getComputedStyle(document.querySelector('.qb')).backgroundPosition,
    ]);
    assert.ok(Math.abs(ok - run) < 0.5, `OK ${ok}px, Spinner ${run}px`);
    assert.equal(quarter, '0px 100%', 'unten links');
});
