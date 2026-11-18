import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportBody, reportPage } from '../src/host/report-page.mjs';

test('reportBody: headings, table with the status marks, list, code and escaping', () => {
    const html = reportBody('# t auf x: pass\n\nText mit `a<b` und **fett**\n\n| Schritt | Status |\n|---|---|\n| S1 | pass |\n| S2 | fail |\n\n## Aufrufe\n\n- eins\n- zwei');
    assert.match(html, /<h1>t auf x: pass<\/h1>/);
    assert.match(html, /<code>a&lt;b<\/code> und <strong>fett<\/strong>/);
    assert.match(html, /<span class="st st-pass"><span class="tag tag-ok">✓<\/span> pass<\/span>/);
    assert.match(html, /<span class="st st-fail"><span class="tag tag-fail">✕<\/span> fail<\/span>/);
    assert.match(html, /<ul><li>eins<\/li><li>zwei<\/li><\/ul>/);
    assert.doesNotMatch(html, /<script/);
});

test('reportPage: the mode, the escaped path, fonts inline and no foreign host', () => {
    const html = reportPage({ markdown: '# x', path: '<p>', mode: 'dark' });
    assert.match(html, /<html lang="\w+" data-pref="dark" data-mode="dark">/);
    assert.match(html, /&lt;p&gt;/);
    assert.match(html, /<span>(Bericht|Report)<\/span>/);
    assert.match(html, /font-family:"Geist";src:url\(data:font\/woff2;base64,/);
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    assert.match(reportPage({ markdown: '', mode: 'nonsense' }), /data-pref="system"/);
});
