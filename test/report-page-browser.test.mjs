// The report page in Chrome, light and dark: the mode's colours on tiles, uppercase table headers, mono cells, a screenshot from
// the run folder that opens large, no horizontal scroll. Skipped without Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { inLanguage } from '../src/shared/i18n.mjs';
import { renderReport } from '../src/shared/report.mjs';
import { reportPage } from '../src/host/report-page.mjs';
import { launchChrome } from './chrome.mjs';

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const FAILED = {
    status: 'fail', testId: 'first-errand', target: 'local', testedCode: 'dev server localhost:4174',
    expectations: [{ id: 'S1', text: 'A confirmation shows the number.' }, { id: 'S2', text: 'Exactly one | todo.' }, { id: 'S3', text: 'It is struck through.' }, { id: 'S4', text: 'Tomorrow.' }],
    results: [{ id: 'S1', status: 'pass', evidence: { type: 'screenshot', value: 's1.png' } }, { id: 'S2', status: 'pass', evidence: { type: 'eval', value: 'a <b> => true' } },
        { id: 'S3', status: 'fail', evidence: { type: 'eval', value: 'false' }, note: 'the ring still shows 0/1' }, { id: 'S4', status: 'fail', skipped: true, note: 'Not reached because S3 failed.' }],
    failures: [{ type: 'http', text: 'PATCH /api/todos/1 500' }], warnings: [{ type: 'console', text: 'ring.update is not a function', count: 2 }],
    writes: [{ label: 'POST /api/todos', count: 2 }, { label: 'PATCH /api/todos/:id', count: 1 }],
    thirdParty: [{ host: 'cdn.example.com', requests: 3, types: ['script'], failed: 0 }],
};

let browser = null;
before(async () => {
    browser = await launchChrome();
});
after(async () => {
    await browser?.close();
});

test('report page in Chrome: light and dark, tiles and badges in the mode\'s colours, the screenshot opens large', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const dir = mkdtempSync(join(tmpdir(), 'caw-report-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'agent'));
    writeFileSync(join(dir, 'agent', 's1.png'), PNG);
    const markdown = inLanguage('en', () => renderReport(FAILED));
    const colours = { light: { bg: 'rgb(247, 248, 248)', pass: 'rgb(24, 121, 78)', fail: 'rgb(205, 43, 49)' }, dark: { bg: 'rgb(10, 12, 13)', pass: 'rgb(61, 214, 140)', fail: 'rgb(255, 107, 112)' } };
    for (const mode of ['light', 'dark']) {
        const page = await browser.newPage({ colorScheme: mode });
        try {
            await page.setContent(reportPage({ markdown, path: '.caw/runs/r/report.md', mode: 'system', dir }));
            const seen = await page.evaluate(() => {
                const color = (selector, property = 'color') => getComputedStyle(document.querySelector(selector))[property];
                return {
                    mode: document.documentElement.dataset.mode, bg: color('body', 'backgroundColor'), pass: color('.rp-n.pass b'), fail: color('.rp-n.fail b'),
                    th: getComputedStyle(document.querySelector('th')).textTransform, thSize: getComputedStyle(document.querySelector('th')).fontSize,
                    code: getComputedStyle(document.querySelector('td')).fontFamily, steps: document.querySelectorAll('.rp-step').length,
                    thumb: document.querySelector('.rp-step[data-status=pass] .shot img')?.naturalWidth ?? 0,
                    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                };
            });
            assert.equal(seen.mode, mode);
            assert.equal(seen.bg, colours[mode].bg);
            assert.equal(seen.pass, colours[mode].pass, `${mode}: passed tile`);
            assert.equal(seen.fail, colours[mode].fail, `${mode}: failed tile`);
            assert.equal(seen.th, 'uppercase');
            assert.equal(seen.thSize, '11px');
            assert.match(seen.code, /Geist Mono/);
            assert.equal(seen.steps, 4);
            assert.equal(seen.thumb, 1, 'the screenshot from the run folder');
            assert.equal(seen.overflow, false);
            await page.click('.shot');
            assert.equal(await page.evaluate(() => document.getElementById('view').open), true);
        } finally {
            await page.close();
        }
    }
    return undefined;
});
