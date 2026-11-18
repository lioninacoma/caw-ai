import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readPrefs } from '../src/shared/prefs.mjs';
import { loadTheme, readThemePackage } from '../src/shared/theme-package.mjs';
import { CHAT_KEYS, themeAction, themeList, workbenchHtml } from '../src/host/workbench.mjs';
import { benchFacts, titleOf } from '../src/host/run.mjs';

test('workbench: without an own choice the step list collapses in narrow windows, a choice always wins', () => {
    const free = workbenchHtml({ appUrl: 'about:blank', title: 't' });
    assert.match(free, /let autoSteps=true;/);
    assert.match(free, /innerWidth<1500/);
    assert.match(free, /@media \(max-width:999px\)/, 'stacked only below 1000px');
    for (const steps of ['open', 'closed']) assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps } }), /let autoSteps=false;/);
    assert.match(workbenchHtml({ appUrl: 'about:blank', title: 't', prefs: { steps: 'closed' } }), /<body class="[^"]*fold-steps/);
});

test('workbench: the chip at the top right (REC, PLAY, PAUSE) is there but off without a run; recording pulses only without F10', () => {
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't', themes: [] });
    assert.match(html, /<span id="transport" class="px-pill glow" role="img"><i><\/i><span><\/span><\/span><\/div><\/header>/, 'right of the pill');
    assert.match(html, /#transport\{display:none;/, 'no chip without a run');
    for (const [kind, color] of [['record', 'fail'], ['play', 'ok'], ['pause', 'warn']]) assert.ok(html.includes(`#transport[data-kind=${kind}]{--tc:var(--${color})}`), `${kind} in the theme colour`);
    assert.match(html, /\.still \*,\.still \*::before,\.still \*::after\{animation:none!important/, 'F10 also stops the recording pulse');
});

test('workbench: the theme is embedded without css and cannot end a <script>', () => {
    const theme = { ...loadTheme('terminal'), css: 'body{x:1}', label: '</script><b>' };
    const html = workbenchHtml({ appUrl: 'about:blank', title: 't', theme, themes: [] });
    assert.match(html, /<style data-caw-theme-css>body\{x:1\}<\/style>/, 'theme.css from disk, as its own block');
    const script = html.slice(html.lastIndexOf('<script>'));
    assert.doesNotMatch(script.slice(0, script.indexOf('</script>')), /<\/script><b>/);
    assert.ok(!CHAT_KEYS.includes('F5') && !CHAT_KEYS.includes('Escape'), 'the chat triggers neither reload nor abort in the workbench');
});

test('workbench: the theme dialog only picks a theme and the mode; own themes come from their folder', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-bench-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { CAW_AI_HOME: dir };
    assert.equal(themeAction('use', 'raster', env).name, 'raster');
    assert.equal(readPrefs(env).theme, 'raster');
    // The mode switch: stored, and the theme comes back in that mode.
    assert.deepEqual([themeAction('mode', 'light', env).scheme, readPrefs(env).mode], ['light', 'light']);
    assert.throws(() => themeAction('mode', 'grau', env), /Unknown setting/);
    assert.equal(themeAction('mode', 'dark', env).scheme, 'dark');
    assert.throws(() => themeAction('use', 'gibt-es-nicht', env));
    // Nothing is written from the page.
    for (const action of ['save', 'rename', 'delete']) assert.throws(() => themeAction(action, { themeApi: 1, name: 'x', base: 'raster' }, env), /\?/, action);
    assert.equal(readThemePackage('x', env), undefined);
    // A folder added meanwhile: list shows it, with colours for the preview and its modes.
    mkdirSync(join(dir, 'themes', 'hafen'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'hafen', 'theme.json'), JSON.stringify({ themeApi: 1, name: 'hafen', base: 'raster', colors: { accent: '#123456' } }));
    assert.equal(themeAction('list', undefined, env).name, 'raster');
    const hafen = themeList(env).find(({ name }) => name === 'hafen');
    assert.deepEqual([hafen.colors.accent, hafen.modes, hafen.baseLabel, hafen.builtin], ['#123456', ['dark', 'light'], 'Raster', false]);
    assert.equal(themeAction('use', 'hafen', env).name, 'hafen');

});

test('workbench header: the title is a sentence with the test; chips only where the project offers a choice', () => {
    const spec = { id: 'morning-errand', role: 'user' };
    const one = { environments: { local: {} }, roles: { user: {} } };
    const local = { name: 'local', production: false, source: 'deployed' };
    assert.equal(titleOf(spec, 'record'), 'Claude nimmt morning-errand auf');
    assert.equal(titleOf(spec, 'repair', { id: 'S2' }), 'Claude behebt S2 von morning-errand');
    // One environment, one role, no overlay: the title alone.
    assert.deepEqual(benchFacts(one, spec, local, 'T'), [['', 'T']]);
    // Several environments and roles: both chips.
    const many = { environments: { local: {}, staging: {} }, roles: { user: {}, admin: {} } };
    assert.deepEqual(benchFacts(many, spec, { ...local, name: 'staging' }, 'T'), [['', 'T'], ['Umgebung', 'staging'], ['Rolle', 'user']]);
    // Production is always named, even as the only environment; the code only under an overlay.
    assert.deepEqual(benchFacts(one, spec, { name: 'prod', production: true, source: 'overlay' }, 'T'), [['', 'T'], ['Umgebung', 'prod'], ['Code', 'lokaler Build']]);
});
