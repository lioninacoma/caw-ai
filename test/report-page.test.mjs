// The report page: report.md in the Graphite look. Structure from the Markdown (title badge, meta line, tiles, steps, lists),
// screenshots inlined from the run folder only. Both modes in Chrome: report-page-browser.test.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inLanguage } from '../src/shared/i18n.mjs';
import { renderReport, renderReproduceReport } from '../src/shared/report.mjs';
import { imagesIn, reportBody, reportPage } from '../src/host/report-page.mjs';

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

test('reportBody: headings, tables with status badges, lists, code and escaping', () => {
    const html = reportBody('# t auf x: pass\n\nText mit `a<b` und **fett**\n\n## Abschnitt\n\n| Host | Status |\n|---|---|\n| a | fail |\n\n- eins\n- zwei\n\n```text\n<x>\n```');
    assert.match(html, /<h1>t auf x: pass<\/h1><span class="bdg pass" data-status="pass">/);
    assert.match(html, /<code>a&lt;b<\/code> und <strong>fett<\/strong>/);
    assert.match(html, /<th>Host<\/th>/);
    assert.match(html, /<td><span class="bdg fail" data-status="fail">/);
    assert.match(html, /<ul><li>eins<\/li><li>zwei<\/li><\/ul>/);
    assert.match(html, /<pre>&lt;x&gt;<\/pre>/);
    assert.doesNotMatch(html, /<script/);
});

test('reportBody: a failed run in English as title badge, meta line, tiles, steps, hard errors, warnings and write requests', () => {
    const markdown = inLanguage('en', () => renderReport(FAILED));
    const html = reportBody(markdown, { image: (href) => (href === 'agent/s1.png' ? 'data:image/png;base64,AA' : null) });
    assert.match(html, /<h1>first-errand on local: fail<\/h1><span class="bdg fail" data-status="fail">.*failed<\/span>/);
    assert.match(html, /<div class="rp-meta"><span>Tested version <b>dev server localhost:4174<\/b><\/span><\/div>/);
    // Tiles from the results table and the write requests' counts: 2 passed, 1 failed, 1 not reached, 3 writes.
    for (const [kind, count, label] of [['pass', 2, 'passed'], ['fail', 1, 'failed'], ['skip', 1, 'not reached'], ['writes', 3, 'write requests']]) {
        assert.match(html, new RegExp(`<div class="rp-n ${kind}" data-tile="${kind}"><b>${count}</b><span>${label}</span></div>`));
    }
    assert.match(html, /<h2>Steps<\/h2><div class="rp-steps">/);
    assert.match(html, /<div class="rp-step" data-status="pass"><span class="sid">S1<\/span>.*<button type="button" class="shot" data-full="data:image\/png;base64,AA"/);
    // An escaped pipe stays in its cell; evidence is escaped.
    assert.match(html, /<b>Exactly one \| todo\.<\/b>.*<p class="ev">eval: a &lt;b&gt; =&gt; true<\/p>/);
    assert.match(html, /data-status="fail"><span class="sid">S3<\/span>.*<p class="nt bad">the ring still shows 0\/1<\/p>/);
    assert.match(html, /data-status="skipped"><span class="sid">S4<\/span>.*not reached<\/span>/);
    assert.match(html, /<h2>Hard errors<\/h2>\n<ul class="rp-list"><li class="e"><svg[^>]*>.*<\/svg><span>http: PATCH \/api\/todos\/1 500<\/span><\/li><\/ul>/);
    assert.match(html, /<h2>Warnings<\/h2>\n<p class="intro">[^<]+<\/p>\n<ul class="rp-list"><li class="w">/);
    assert.match(html, /<h2>Write requests<\/h2>\n<p class="intro">[^<]+<\/p>\n<ul class="rp-list mono"><li>POST \/api\/todos \(2x\)<\/li>/);
});

test('reportBody: a German report gets German words, a reproduction its verdict, read-only banner, result and screenshots', () => {
    const german = reportBody(inLanguage('de', () => renderReport(FAILED)));
    assert.match(german, /data-tile="skip"><b>1<\/b><span>nicht erreicht<\/span>/);
    assert.match(german, /<h2>Schritte<\/h2>/);
    assert.match(german, /<h2>Harte Fehler<\/h2>\n<ul class="rp-list">/);
    const markdown = inLanguage('en', () => renderReproduceReport({ status: 'pass', target: 'local', testedCode: 'deployed',
        reproduce: { bug: 'Search finds nothing.', reproduced: 'yes', observed: 'Empty list.', expected: 'Two todos.', screenshots: ['e1.png', 'e2.png'], writable: false } }));
    const html = reportBody(markdown, { image: (href) => (href.startsWith('agent/') ? `data:image/png;base64,${href.length}` : null) });
    assert.match(html, /<span class="bdg warn" data-verdict="yes"><svg[^>]*>.*<\/svg>reproduced<\/span>/);
    assert.match(html, /<div class="banner ro"><svg[^>]*>.*<\/svg><span><p>Read-only: caw aborted every write request\.<\/p><\/span><\/div>/);
    assert.match(html, /<blockquote>Search finds nothing\.<\/blockquote>/);
    assert.match(html, /<dl class="kv"><dt>Observed<\/dt><dd>Empty list\.<\/dd><dt>Expected<\/dt><dd>Two todos\.<\/dd><\/dl>/);
    assert.match(html, /<div class="shots"><button type="button" class="shot"[^>]*><img src="data:image\/png;base64,12" alt="e1\.png">/);
    // Without the image the link stays a name.
    assert.match(reportBody(markdown), /<li><code>e1\.png<\/code><\/li>/);
});

test('imagesIn: only image files inside the run folder, as data URLs', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-report-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'agent'));
    writeFileSync(join(dir, 'agent', 's 1.png'), PNG);
    writeFileSync(join(dir, 'agent', 'notes.txt'), 'x');
    const image = imagesIn(dir);
    assert.equal(image('agent/s%201.png'), `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(image('agent/notes.txt'), null);
    assert.equal(image('agent/missing.png'), null);
    assert.equal(image('../x.png'), null);
    assert.equal(image('https://example.com/a.png'), null);
    assert.equal(imagesIn(undefined)('agent/s%201.png'), null);
});

test('reportPage: the mode, the escaped path, fonts inline and no foreign host', () => {
    const html = reportPage({ markdown: '# x', path: '<p>', mode: 'dark' });
    assert.match(html, /<html lang="\w+" data-pref="dark" data-mode="dark">/);
    assert.match(html, /<span class="path">&lt;p&gt;<\/span>/);
    assert.match(html, /<span class="what">(Bericht|Report)<\/span>/);
    assert.match(html, /font-family:"Geist";src:url\(data:font\/woff2;base64,/);
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    assert.match(reportPage({ markdown: '', mode: 'nonsense' }), /data-pref="system"/);
});
