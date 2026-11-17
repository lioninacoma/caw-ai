import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PAGE_PREFS, prefsDir, readPrefs, writePagePref, writePref } from '../src/shared/prefs.mjs';
import {
    activeTheme, contrast, deleteTheme, listThemes, loadTheme, projectThemeProblems, readThemePackage, renameTheme, resolvePackage, saveTheme, setProjectTheme,
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
    assert.throws(() => writePref('theme', 'Terminal!', env), /Unknown setting/);
    assert.throws(() => writePref('animations', '<script>', env), /Unknown setting/);
    assert.throws(() => writePref('token', 'x', env), /Unknown setting/);
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

test('theme: studio, then team default, then own choice; custom themes inherit from base', (t) => {
    const { dir, env } = home(t);
    assert.equal(activeTheme(env).name, 'studio');
    assert.equal(loadTheme('terminal', env).marks.fail, '[FEHLER]', 'texts in the current language');
    setProjectTheme({ base: 'raster', colors: { accent: '#00ff00' } });
    assert.deepEqual([activeTheme(env).base, activeTheme(env).colors.accent], ['raster', '#00ff00']);
    writePref('theme', 'terminal', env);
    assert.equal(activeTheme(env).colors.accent, loadTheme('terminal').colors.accent, 'the own choice wins');
    saveTheme({ themeApi: 1, name: 'hafen', base: 'glas', colors: { heart: '#ff00ff' }, marks: { ok: '[ PASS ]' } }, env);
    writePref('theme', 'hafen', env);
    const own = activeTheme(env);
    assert.deepEqual([own.name, own.base, own.colors.heart, own.colors.screen, own.marks.ok, own.marks.warn], ['hafen', 'glas', '#ff00ff', loadTheme('glas').colors.screen, '[ PASS ]', '!']);
    renameTheme('hafen', 'kai', env);
    assert.equal(readThemePackage('kai', env).name, 'kai');
    assert.deepEqual(listThemes(env).map(({ name }) => name), ['studio', 'terminal', 'raster', 'glas', 'kai']);
    deleteTheme('kai', env);
    assert.equal(readThemePackage('kai', env), undefined);
    // Broken or foreign packages do not count: the team default applies.
    mkdirSync(join(dir, 'themes', 'kaputt'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'kaputt', 'theme.json'), '{"themeApi":1,"name":"kaputt","base":"terminal","colors":{"text":"url(x)"}}');
    writePref('theme', 'kaputt', env);
    assert.equal(activeTheme(env).base, 'raster');
});

test('theme mode: dark by default; light takes the light colours and scheme; a theme without a light mode stays dark', (t) => {
    const { env } = home(t);
    const dark = activeTheme(env);
    assert.deepEqual([dark.scheme, dark.primary, dark.modes], ['dark', 'dark', ['dark', 'light']]);
    writePref('mode', 'light', env);
    const light = activeTheme(env);
    assert.equal(light.scheme, 'light');
    assert.equal(light.colors.screen, readThemePackage('studio').light.colors.screen);
    assert.notEqual(light.colors.screen, dark.colors.screen);
    assert.deepEqual(light.marks, dark.marks, 'the mode changes colours, not the glyphs');
    // Asked for explicitly, either mode, whatever prefs.json says.
    assert.equal(loadTheme('glas', env, 'dark').colors.screen, readThemePackage('glas').colors.screen);
    // Light edits of a custom theme sit in its light block, over the base's light colours.
    saveTheme({ themeApi: 1, name: 'hell', base: 'studio', light: { colors: { accent: '#123456' } } }, env);
    writePref('theme', 'hell', env);
    assert.deepEqual([activeTheme(env).colors.accent, activeTheme(env).colors.screen], ['#123456', light.colors.screen]);
    assert.equal(activeTheme(env, 'dark').colors.accent, dark.colors.accent);
    // A custom theme inherits the light mode of its base; a package with no light block at all stays dark.
    assert.equal(resolvePackage({ themeApi: 1, name: 'erbt', base: 'terminal' }, { env, mode: 'light' }).scheme, 'light');
    const onlyDark = { ...readThemePackage('terminal') };
    delete onlyDark.light;
    const dim = resolvePackage(onlyDark, { env, mode: 'light' });
    assert.deepEqual([dim.scheme, dim.modes, dim.colors.screen], ['dark', ['dark'], onlyDark.colors.screen]);
    // A light-only theme: scheme light, no dark block. Asked for dark it stays light; the terminal gets its light colours.
    const lightOnly = { ...onlyDark, scheme: 'light', colors: { ...onlyDark.colors, screen: '#fafafa', text: '#111111' } };
    const day = resolvePackage(lightOnly, { env, mode: 'dark' });
    assert.deepEqual([day.scheme, day.primary, day.modes, day.colors.screen], ['light', 'light', ['light'], '#fafafa']);
    // Both modes with the light one on top: the dark block is the other mode.
    const both = resolvePackage({ ...lightOnly, dark: { colors: { screen: '#050505' } } }, { env, mode: 'dark' });
    assert.deepEqual([both.scheme, both.modes, both.colors.screen, both.colors.text], ['dark', ['dark', 'light'], '#050505', '#111111']);
    assert.throws(() => writePref('mode', 'system', env), /Unknown setting/);
});

test('theme from the page: schema, no css, no font files, no built-in names', (t) => {
    const { env } = home(t);
    const ok = { themeApi: 1, name: 'meins', base: 'terminal' };
    for (const bad of [
        { ...ok, css: 'x.css' },
        { ...ok, fonts: { display: { family: 'X', file: 'fonts/x.woff2' } } },
        { ...ok, colors: { accent: '#ff0000;}body{x' } },
        { ...ok, colors: { glow: '#ff0000' } },
        { ...ok, marks: { ok: 'x'.repeat(40) } },
        { ...ok, raven: { parts: { body: 'url(x)' } } },
        { ...ok, name: 'terminal' },
        { ...ok, base: undefined },
        { ...ok, evil: 1 },
    ]) assert.throws(() => saveTheme(bad, env), /Invalid theme|built in/, JSON.stringify(bad));
    saveTheme(ok, env);
    assert.equal(readThemePackage('meins', env).base, 'terminal');
});

test('theme: team default and warnings', () => {
    assert.deepEqual(projectThemeProblems({ base: 'terminal', colors: { accent: '#123456' } }), []);
    assert.deepEqual(projectThemeProblems({ base: 'tag', colors: { glow: '#123456', text: 'weiss' }, extra: 1 }).map(({ key }) => key), ['base', 'colors.glow', 'colors.text', 'extra']);
    assert.ok(contrast('#e8e9f7', '#0f1026') > 4.5);
    const dim = { ...loadTheme('terminal'), colors: { ...loadTheme('terminal').colors, text: '#333333' }, marks: { ...loadTheme('terminal').marks, ok: '[OK]' } };
    assert.deepEqual(themeWarnings(dim).map(({ kind }) => kind), ['width', 'contrast', 'contrast']);
});

test('prefs: the workbench page sets only cosmetic keys, never tokenNotice', (t) => {
    const { env } = home(t);
    assert.deepEqual(PAGE_PREFS, ['animations', 'steps', 'chat', 'theme', 'mode']);
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
