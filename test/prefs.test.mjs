import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PAGE_PREFS, prefsDir, readPrefs, writePagePref, writePref } from '../src/shared/prefs.mjs';

const home = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-prefs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
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
    writePref('mode', 'dark', env);
    assert.deepEqual(readPrefs(env), { animations: 'off', chat: 'closed', mode: 'dark' });
    writePref('chat', null, env);
    assert.deepEqual(readPrefs(env), { animations: 'off', mode: 'dark' });
    assert.throws(() => writePref('animations', '<script>', env), /Unknown setting/);
    assert.throws(() => writePref('token', 'x', env), /Unknown setting/);
    writeFileSync(join(dir, 'prefs.json'), '{"animations":"wild","raven":"caged","x":1}');
    assert.deepEqual(readPrefs(env), {});
    writeFileSync(join(dir, 'prefs.json'), 'kaputt');
    assert.deepEqual(readPrefs(env), {});
});

test('prefs: mode is system, light or dark; an old theme pref is ignored', (t) => {
    const { dir, env } = home(t);
    for (const mode of ['system', 'light', 'dark']) assert.equal(writePref('mode', mode, env).mode, mode);
    assert.throws(() => writePref('mode', 'dim', env), /Unknown setting/);
    assert.throws(() => writePref('theme', 'studio', env), /Unknown setting/);
    writeFileSync(join(dir, 'prefs.json'), '{"theme":"terminal","mode":"light"}');
    assert.deepEqual(readPrefs(env), { mode: 'light' });
});

test('prefs: the workbench page sets only cosmetic keys, never tokenNotice', (t) => {
    const { env } = home(t);
    assert.deepEqual(PAGE_PREFS, ['animations', 'steps', 'chat', 'mode']);
    writePagePref('animations', 'off', env);
    writePagePref('steps', 'closed', env);
    writePagePref('mode', 'system', env);
    assert.throws(() => writePagePref('tokenNotice', 'off', env), /cannot be changed from the page/);
    assert.throws(() => writePagePref('tokenNotice', null, env), /cannot be changed from the page/);
    assert.throws(() => writePagePref('theme', 'studio', env), /cannot be changed from the page/);
    assert.throws(() => writePagePref('chat', 'gone', env), /Unknown setting/);
    assert.deepEqual(readPrefs(env), { animations: 'off', steps: 'closed', mode: 'system' });
    // The host itself (token-gate) still may.
    writePref('tokenNotice', 'off', env);
    assert.equal(readPrefs(env).tokenNotice, 'off');
});
