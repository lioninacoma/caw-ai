import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prefsDir, readPrefs, writePref } from '../src/shared/prefs.mjs';
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

test('prefs: Ort je Plattform, CAW_AI_HOME gewinnt', () => {
    assert.equal(prefsDir({ CAW_AI_HOME: '/x' }), '/x');
    assert.equal(prefsDir({ APPDATA: 'C:\\A' }, 'win32'), join('C:\\A', 'caw-ai'));
    assert.equal(prefsDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), join('/cfg', 'caw-ai'));
});

test('prefs: Animationen bleiben aus, fremde Werte werden abgelehnt', (t) => {
    const { dir, env } = home(t);
    assert.deepEqual(readPrefs(env), {});
    writePref('animations', 'off', env);
    writePref('chat', 'closed', env);
    writePref('theme', 'bernstein', env);
    assert.deepEqual(readPrefs(env), { animations: 'off', chat: 'closed', theme: 'bernstein' });
    writePref('chat', null, env);
    assert.deepEqual(readPrefs(env), { animations: 'off', theme: 'bernstein' });
    assert.throws(() => writePref('theme', 'Nacht!', env), /Unbekannte/);
    assert.throws(() => writePref('animations', '<script>', env), /Unbekannte/);
    assert.throws(() => writePref('token', 'x', env), /Unbekannte/);
    assert.throws(() => writePref('fed', '7', env), /Unbekannte/, 'den Raben fuettert niemand mehr');
    writeFileSync(join(dir, 'prefs.json'), '{"animations":"wild","raven":"caged","x":1}');
    assert.deepEqual(readPrefs(env), {});
    writeFileSync(join(dir, 'prefs.json'), 'kaputt');
    assert.deepEqual(readPrefs(env), {});
});

test('Theme: die eingebauten Pakete bestehen das Schema, ohne Hinweise', () => {
    for (const { name, builtin } of listThemes({ CAW_AI_HOME: '/gibt-es-nicht' })) {
        assert.ok(builtin);
        assert.deepEqual(validateTheme(readThemePackage(name)), [], name);
        assert.deepEqual(themeWarnings(loadTheme(name)), [], name);
    }
});

test('Theme: nacht, dann Team-Standard, dann eigene Wahl; eigene Themes erben von base', (t) => {
    const { dir, env } = home(t);
    assert.equal(activeTheme(env).name, 'nacht');
    assert.equal(activeTheme(env).marks.fail, '[FEHLER]', 'Texte in der aktuellen Sprache');
    setProjectTheme({ base: 'phosphor', colors: { accent: '#00ff00' } });
    assert.deepEqual([activeTheme(env).base, activeTheme(env).colors.accent, activeTheme(env).mono], ['phosphor', '#00ff00', true]);
    writePref('theme', 'nacht', env);
    assert.equal(activeTheme(env).colors.accent, loadTheme('nacht').colors.accent, 'die eigene Wahl gewinnt');
    saveTheme({ themeApi: 1, name: 'hafen', base: 'bernstein', colors: { heart: '#ff00ff' }, marks: { ok: '[ PASS ]' } }, env);
    writePref('theme', 'hafen', env);
    const own = activeTheme(env);
    assert.deepEqual([own.name, own.base, own.colors.heart, own.colors.screen, own.marks.ok, own.marks.warn], ['hafen', 'bernstein', '#ff00ff', loadTheme('bernstein').colors.screen, '[ PASS ]', '[ WARN ]']);
    renameTheme('hafen', 'kai', env);
    assert.equal(readThemePackage('kai', env).name, 'kai');
    assert.deepEqual(listThemes(env).map(({ name }) => name), ['nacht', 'bernstein', 'phosphor', 'kai']);
    deleteTheme('kai', env);
    assert.equal(readThemePackage('kai', env), undefined);
    // Kaputte oder fremde Pakete zaehlen nicht: Es gilt der Team-Standard.
    mkdirSync(join(dir, 'themes', 'kaputt'), { recursive: true });
    writeFileSync(join(dir, 'themes', 'kaputt', 'theme.json'), '{"themeApi":1,"name":"kaputt","base":"nacht","colors":{"text":"url(x)"}}');
    writePref('theme', 'kaputt', env);
    assert.equal(activeTheme(env).base, 'phosphor');
});

test('Theme aus der Seite: Schema, kein css, keine Schriftdateien, keine eingebauten Namen', (t) => {
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
    ]) assert.throws(() => saveTheme(bad, env), /ungueltig|eingebaut/, JSON.stringify(bad));
    saveTheme(ok, env);
    assert.equal(readThemePackage('meins', env).base, 'nacht');
});

test('Theme: Team-Standard und Hinweise', () => {
    assert.deepEqual(projectThemeProblems({ base: 'nacht', colors: { accent: '#123456' } }), []);
    assert.deepEqual(projectThemeProblems({ base: 'tag', colors: { glow: '#123456', text: 'weiss' }, extra: 1 }).map(({ key }) => key), ['base', 'colors.glow', 'colors.text', 'extra']);
    assert.ok(contrast('#e8e9f7', '#0f1026') > 4.5);
    const dim = { ...loadTheme('nacht'), colors: { ...loadTheme('nacht').colors, text: '#333333' }, marks: { ...loadTheme('nacht').marks, ok: '[OK]' } };
    assert.deepEqual(themeWarnings(dim).map(({ kind }) => kind), ['width', 'contrast', 'contrast']);
});
