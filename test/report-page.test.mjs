import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportBody, reportPage } from '../src/host/report-page.mjs';

test('reportBody: Überschriften, Tabelle mit Status, Liste, Code und Escape', () => {
    const html = reportBody('# t auf x: pass\n\nText mit `a<b` und **fett**\n\n| Schritt | Status |\n|---|---|\n| S1 | pass |\n| S2 | fail |\n\n## Aufrufe\n\n- eins\n- zwei');
    assert.match(html, /<h1>t auf x: pass<\/h1>/);
    assert.match(html, /<code>a&lt;b<\/code> und <strong>fett<\/strong>/);
    assert.match(html, /<span class="st st-pass">pass<\/span>/);
    assert.match(html, /<span class="st st-fail">fail<\/span>/);
    assert.match(html, /<ul><li>eins<\/li><li>zwei<\/li><\/ul>/);
    assert.doesNotMatch(html, /<script/);
});

test('reportPage: Thema nur light oder dark, Pfad escaped', () => {
    assert.match(reportPage({ markdown: '# x', theme: 'dark', path: '<p>' }), /data-theme="dark"[\s\S]*&lt;p&gt;/);
    assert.doesNotMatch(reportPage({ markdown: '# x', theme: '"><script>' }), /<html lang="de" data-theme/);
});
