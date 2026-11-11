import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PAGE_PREFS, prefsDir, readPrefs, writePagePref, writePref } from '../src/shared/prefs.mjs';
import {
    activeTheme, contrast, deleteTheme, listThemes, loadTheme, projectThemeProblems, readThemePackage, renameTheme, saveTheme, setProjectTheme,
    themeWarnings, validateTheme,
} from '../src/shared/theme-package.mjs';

const home = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-prefs-'));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
        setProjectTheme(undefined);
    });
    return { dir, env: { CAW_AI_HOME: dir } };
};

test('prefs: location per platform, CAW_AI_HOME wins', () => {
    assert.equal(prefsDir({ CAW_AI_HOME: '/x' }), '/x');
    assert.equal(prefsDir({ APPDATA: 'C:\\A' }, 'win32'), join('C:\\A', 'caw-ai'));
    assert.equal(prefsDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), join('/cfg', 'caw-ai'));
});

test('prefs: animations stay off, foreign values are rejected', (t) => {
    const { dir, env } = home(t);
    assert.deepEqual(readPrefs(env), {});
    writePref('animations', 'off', env);
    writePref('chat', 'closed', env);
    writePref('theme', 'bernstein', env);
    assert.deepEqual(readPrefs(env), { animations: 'off', chat: 'closed', theme: 'bernstein' });
    writePref('chat', null, env);
    assert.deepEqual(readPrefs(env), { animations: 'off', theme: 'bernstein' });
    assert.throws(() => writePref('theme', 'Nacht!', env), /Unknown setting/);
    assert.throws(() => writePref('animations', '<script>', env), /Unknown setting/);
    assert.throws(() => writePref('token', 'x', env), /Unknown setting/);
    assert.throws(() => writePref('fed', '7', env), /Unknown setting/, 'nobody feeds the raven any more');
    writeFileSync(join(dir, 'prefs.json'), '{"animations":"wild","raven":"caged","x":1}');
    assert.deepEqual(readPrefs(env), {});
    writeFileSync(join(dir, 'prefs.json'), 'kaputt');
    assert.deepEqual(readPrefs(env), {});
});

test('theme: the built-in packages pass the schema without warnings', () => {
    for (const { name, builtin } of listThemes({ CAW_AI_HOME: '/gibt-es-nicht' })) {
        assert.ok(builtin);
        assert.deepEqual(validateTheme(readThemePackage(name)), [], name);
        assert.deepEqual(themeWarnings(loadTheme(name)), [], name);
    }
});

test('theme: nacht, then team default, then own choice; custom themes inherit from base', (t) => {
    const { dir, env } = home(t);
    assert.equal(activeTheme(env).name, 'nacht');
    assert.equal(activeTheme(env).marks.fail, '[FEHLER]', 'texts in the current language');
    setProjectTheme({ base: 'phosphor', colors: { accent: '#00ff00' } });
    assert.deepEqual([activeTheme(env).base, activeTheme(env).colors.accent, activeTheme(env).mono], ['phosphor', '#00ff00', true]);
    writePref('theme', 'nacht', env);
    assert.equal(activeTheme(env).colors.accent, loadTheme('nacht').colors.accent, 'the own choice wins');
    saveTheme({ themeApi: 1, name: 'hafen', base: 'bernstein', colors: { heart: '#ff00ff' }, marks: { ok: '[ PASS ]' } }, env);
    writePref('theme', 'hafen', env);
    const own = activeTheme(env);
    assert.deepEqual([own.name, own.base, own.colors.heart, own.colors.screen, own.marks.ok, own.marks.warn], ['hafen', 'bernstein', '#ff00ff', loadTheme('bernstein').colors.screen, '[ PASS ]', '[ WARN ]']);
    renameTheme('hafen', 'kai', env);
    assert.equal(readThemePackage('kai', env).name, 'kai');
    assert.deepEqual(listThemes(env).map(({ name }) => name), ['nacht', 'bernstein', 'phosphor', 'kai']);
    deleteTheme('kai', env);
    assert.equal(readThemePackage('kai', env), undefined);
    // Broken or foreign packages do not count: the team default applies.
    mkdirSync(join(dir, 'themes', 'kaputt'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'kaputt', 'theme.json'), '{"themeApi":1,"name":"kaputt","base":"nacht","colors":{"text":"url(x)"}}');
    writePref('theme', 'kaputt', env);
    assert.equal(activeTheme(env).base, 'phosphor');
});

test('theme from the page: schema, no css, no font files, no built-in names', (t) => {
    const { env } = home(t);
    const ok = { themeApi: 1, name: 'meins', base: 'nacht' };
    for (const bad of [
        { ...ok, css: 'x.css' },
        { ...ok, fonts: { display: { family: 'X', file: 'fonts/x.woff2' } } },
        { ...ok, colors: { accent: '#ff0000;}body{x' } },
        { ...ok, colors: { glow: '#ff0000' } },
        { ...ok, marks: { ok: 'x'.repeat(40) } },
        { ...ok, raven: { parts: { body: 'url(x)' } } },
        { ...ok, name: 'nacht' },
        { ...ok, base: undefined },
        { ...ok, evil: 1 },
    ]) assert.throws(() => saveTheme(bad, env), /Invalid theme|built in/, JSON.stringify(bad));
    saveTheme(ok, env);
    assert.equal(readThemePackage('meins', env).base, 'nacht');
});

test('theme: team default and warnings', () => {
    assert.deepEqual(projectThemeProblems({ base: 'nacht', colors: { accent: '#123456' } }), []);
    assert.deepEqual(projectThemeProblems({ base: 'tag', colors: { glow: '#123456', text: 'weiss' }, extra: 1 }).map(({ key }) => key), ['base', 'colors.glow', 'colors.text', 'extra']);
    assert.ok(contrast('#e8e9f7', '#0f1026') > 4.5);
    const dim = { ...loadTheme('nacht'), colors: { ...loadTheme('nacht').colors, text: '#333333' }, marks: { ...loadTheme('nacht').marks, ok: '[OK]' } };
    assert.deepEqual(themeWarnings(dim).map(({ kind }) => kind), ['width', 'contrast', 'contrast']);
});

test('prefs: the workbench page sets only cosmetic keys, never tokenNotice', (t) => {
    const { env } = home(t);
    assert.deepEqual(PAGE_PREFS, ['animations', 'steps', 'chat', 'theme']);
    writePagePref('animations', 'off', env);
    writePagePref('steps', 'closed', env);
    assert.throws(() => writePagePref('tokenNotice', 'off', env), /cannot be changed from the page/);
    assert.throws(() => writePagePref('tokenNotice', null, env), /cannot be changed from the page/);
    assert.throws(() => writePagePref('chat', 'gone', env), /Unknown setting/);
    assert.deepEqual(readPrefs(env), { animations: 'off', steps: 'closed' });
    // The host itself (token-gate) still may.
    writePref('tokenNotice', 'off', env);
    assert.equal(readPrefs(env).tokenNotice, 'off');
});
