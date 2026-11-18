import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PAGE_PREFS, prefsDir, readPrefs, writePagePref, writePref } from '../src/shared/prefs.mjs';
import {
    activeTheme, contrast, listThemes, loadTheme, projectThemeProblems, readThemePackage, resolvePackage, setProjectTheme, themesFolder, themeWarnings,
    validateTheme,
} from '../src/shared/theme-package.mjs';

const home = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-prefs-'));
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
        setProjectTheme(undefined);
    });
    return { dir, env: { CAW_AI_HOME: dir } };
};
// A custom theme as a person adds one: a folder with a theme.json.
const own = (env, pkg) => {
    mkdirSync(join(themesFolder(env), pkg.name), { recursive: true });
    writeFileSync(join(themesFolder(env), pkg.name, 'theme.json'), JSON.stringify(pkg));
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
    assert.equal(themesFolder(env), join(dir, 'themes'));
    own(env, { themeApi: 1, name: 'hafen', base: 'glas', colors: { heart: '#ff00ff' }, marks: { ok: '[ PASS ]' } });
    writePref('theme', 'hafen', env);
    const mine = activeTheme(env);
    assert.deepEqual([mine.name, mine.base, mine.colors.heart, mine.colors.screen, mine.marks.ok, mine.marks.warn], ['hafen', 'glas', '#ff00ff', loadTheme('glas').colors.screen, '[ PASS ]', '!']);
    // Listed after the built-in ones; the description only from the package itself, never the base's.
    const listed = listThemes(env);
    assert.deepEqual(listed.map(({ name }) => name), ['studio', 'terminal', 'raster', 'glas', 'hafen']);
    assert.deepEqual([listed.at(-1).description, listed[0].description !== ''], ['', true]);
    // A folder whose name does not match the package's does not count.
    own(env, { themeApi: 1, name: 'anders', base: 'glas' });
    fs.renameSync(join(themesFolder(env), 'anders'), join(themesFolder(env), 'falsch'));
    assert.equal(readThemePackage('falsch', env), undefined);
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
    // A custom theme's light block lies over the base's light colours.
    own(env, { themeApi: 1, name: 'hell', base: 'studio', light: { colors: { accent: '#123456' } } });
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
