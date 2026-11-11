import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportBody, reportPage } from '../src/host/report-page.mjs';

test('reportBody: headings, table with the theme status marks, list, code and escaping', () => {
    const marks = { ok: '[  OK  ]', fail: '[FEHLER]', warn: '[ WARN ]', open: '[      ]' };
    const html = reportBody('# t auf x: pass\n\nText mit `a<b` und **fett**\n\n| Schritt | Status |\n|---|---|\n| S1 | pass |\n| S2 | fail |\n\n## Aufrufe\n\n- eins\n- zwei', { marks });
    assert.match(html, /<h1>t auf x: pass<\/h1>/);
    assert.match(html, /<code>a&lt;b<\/code> und <strong>fett<\/strong>/);
    assert.match(html, /<span class="st st-pass"><span class="tag tag-ok">\[ {2}OK {2}\]<\/span> pass<\/span>/);
    assert.match(html, /<span class="st st-fail"><span class="tag tag-fail inverted">\[FEHLER\]<\/span> fail<\/span>/);
    assert.match(html, /<ul><li>eins<\/li><li>zwei<\/li><\/ul>/);
    assert.doesNotMatch(html, /<script/);
    // Theme marks are text, not HTML.
    assert.match(reportBody('| a |\n|---|\n| pass |', { marks: { ok: '<b>' } }), /&lt;b&gt;/);
});

test('reportPage: active theme, escaped path, theme.css after the own rules', () => {
    const theme = { colors: { screen: '#000000' }, mono: true, marks: {}, legend: '[{title}]', css: '.x{color:red}</style><script>' };
    const html = reportPage({ markdown: '# x', path: '<p>', theme });
    assert.match(html, /data-mono="on"/);
    assert.match(html, /--screen:#000000/);
    assert.match(html, /&lt;p&gt;/);
    assert.match(html, /\[(BERICHT|REPORT)\]/);
    assert.ok(html.indexOf('.x{color:red}') > html.indexOf('.table{'), 'theme.css comes after the page rules');
    assert.doesNotMatch(html, /<\/style><script>/);
});
