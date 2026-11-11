import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readPrefs } from '../src/shared/prefs.mjs';
import { loadTheme, readThemePackage } from '../src/shared/theme-package.mjs';
import { CHAT_KEYS, themeAction, themeList, workbenchHtml } from '../src/host/workbench.mjs';

test('workbench: without an own choice the step list collapses in narrow windows, a choice always wins', () => {
    const free = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(free, /let autoSteps=true;/);
    assert.match(free, /innerWidth<1500/);
    assert.match(free, /@media \(max-width:999px\)/, 'stacked only below 1000px');
    for (const steps of ['open', 'closed']) assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps } }), /let autoSteps=false;/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps: 'closed' } }), /<body class="[^"]*fold-steps/);
});

test('workbench: the theme is embedded without css and cannot end a <script>', () => {
    const theme = { ...loadTheme('nacht'), css: 'body{x:1}', label: '</script><b>' };
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't', theme, themes: [] });
    assert.match(html, /<style data-caw-theme-css>body\{x:1\}<\/style>/, 'theme.css from disk, as its own block');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.doesNotMatch(script.slice(0, script.indexOf('</script>')), /<\/script><b>/);
    assert.ok(!CHAT_KEYS.includes('F5') && !CHAT_KEYS.includes('Escape'), 'the chat triggers neither reload nor abort in the workbench');
});

test('workbench: the theme dialog picks, saves custom themes, renames and deletes', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { CAW_AI_HOME: dir };
    assert.equal(themeAction('use', 'bernstein', env).name, 'bernstein');
    assert.equal(readPrefs(env).theme, 'bernstein');
    assert.throws(() => themeAction('use', 'gibt-es-nicht', env));
    assert.throws(() => themeAction('save', { themeApi: 1, name: 'nacht', base: 'nacht' }, env), /built in/);
    assert.throws(() => themeAction('save', { themeApi: 1, name: 'x', base: 'nacht', css: 'a.css' }, env), /Invalid theme/);
    const saved = themeAction('save', { themeApi: 1, name: 'mein-bernstein', base: 'bernstein', colors: { accent: '#123456' } }, env);
    assert.deepEqual([saved.name, saved.colors.accent, readPrefs(env).theme], ['mein-bernstein', '#123456', 'mein-bernstein']);
    assert.ok(themeList(env).some(({ name, colors }) => name === 'mein-bernstein' && colors.accent === '#123456'), 'with colours for the swatch');
    assert.equal(themeAction('rename', { from: 'mein-bernstein', to: 'hafen' }, env).name, 'hafen');
    assert.equal(readPrefs(env).theme, 'hafen');
    assert.equal(themeAction('delete', 'hafen', env).name, 'bernstein', 'back to the base');
    assert.equal(readThemePackage('hafen', env), undefined);
    assert.throws(() => themeAction('delete', 'nacht', env));
    assert.throws(() => themeAction('drop', 'x', env));
});
