import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readPrefs } from '../src/shared/prefs.mjs';
import { loadTheme, readThemePackage } from '../src/shared/theme-package.mjs';
import { CHAT_KEYS, themeAction, themeList, workbenchHtml } from '../src/host/workbench.mjs';

test('Werkbank: Ohne eigene Wahl klappt die Schrittliste in schmalen Fenstern ein, eine Wahl gilt immer', () => {
    const free = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(free, /let autoSteps=true;/);
    assert.match(free, /innerWidth<1500/);
    assert.match(free, /@media \(max-width:999px\)/, 'gestapelt erst unter 1000px');
    for (const steps of ['open', 'closed']) assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps } }), /let autoSteps=false;/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps: 'closed' } }), /<body class="[^"]*fold-steps/);
});

test('Werkbank: Das Theme kommt eingebettet, ohne css, und kann kein <script> beenden', () => {
    const theme = { ...loadTheme('nacht'), css: 'body{x:1}', label: '</script><b>' };
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't', theme, themes: [] });
    assert.match(html, /<style data-caw-theme-css>body\{x:1\}<\/style>/, 'theme.css von der Platte, als eigener Block');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.doesNotMatch(script.slice(0, script.indexOf('</script>')), /<\/script><b>/);
    assert.ok(!CHAT_KEYS.includes('F5') && !CHAT_KEYS.includes('Escape'), 'Der Chat loest weder Neuladen noch Abbruch in der Werkbank aus');
});

test('Werkbank: Der Theme-Dialog waehlt, speichert eigene, benennt um und loescht', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { CAW_AI_HOME: dir };
    assert.equal(themeAction('use', 'bernstein', env).name, 'bernstein');
    assert.equal(readPrefs(env).theme, 'bernstein');
    assert.throws(() => themeAction('use', 'gibt-es-nicht', env));
    assert.throws(() => themeAction('save', { themeApi: 1, name: 'nacht', base: 'nacht' }, env), /eingebaut/);
    assert.throws(() => themeAction('save', { themeApi: 1, name: 'x', base: 'nacht', css: 'a.css' }, env), /ungueltig/);
    const saved = themeAction('save', { themeApi: 1, name: 'mein-bernstein', base: 'bernstein', colors: { accent: '#123456' } }, env);
    assert.deepEqual([saved.name, saved.colors.accent, readPrefs(env).theme], ['mein-bernstein', '#123456', 'mein-bernstein']);
    assert.ok(themeList(env).some(({ name, colors }) => name === 'mein-bernstein' && colors.accent === '#123456'), 'mit Farben fuer das Muster');
    assert.equal(themeAction('rename', { from: 'mein-bernstein', to: 'hafen' }, env).name, 'hafen');
    assert.equal(readPrefs(env).theme, 'hafen');
    assert.equal(themeAction('delete', 'hafen', env).name, 'bernstein', 'zurueck auf die Basis');
    assert.equal(readThemePackage('hafen', env), undefined);
    assert.throws(() => themeAction('delete', 'nacht', env));
    assert.throws(() => themeAction('drop', 'x', env));
});
