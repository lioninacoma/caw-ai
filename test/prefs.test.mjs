import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prefsDir, readPrefs, writePref } from '../src/shared/prefs.mjs';

test('prefs: Ort je Plattform, CAW_AI_HOME gewinnt', () => {
    assert.equal(prefsDir({ CAW_AI_HOME: '/x' }), '/x');
    assert.equal(prefsDir({ APPDATA: 'C:\\A' }, 'win32'), join('C:\\A', 'caw-ai'));
    assert.equal(prefsDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), join('/cfg', 'caw-ai'));
});

test('prefs: Animationen bleiben aus, fremde Werte werden abgelehnt', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-prefs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = { CAW_AI_HOME: dir };
    assert.deepEqual(readPrefs(env), {});
    writePref('animations', 'off', env);
    writePref('chat', 'closed', env);
    writePref('theme', 'dark', env);
    assert.deepEqual(readPrefs(env), { animations: 'off', chat: 'closed', theme: 'dark' });
    assert.throws(() => writePref('theme', 'system', env), /Unbekannte/, 'System heisst: keine Wahl');
    assert.throws(() => writePref('animations', '<script>', env), /Unbekannte/);
    assert.throws(() => writePref('token', 'x', env), /Unbekannte/);
    // Der Fuetter-Zaehler des Raben: nur Ziffern.
    writePref('fed', '7', env);
    assert.equal(readPrefs(env).fed, '7');
    assert.throws(() => writePref('fed', '1;alert(1)', env), /Unbekannte/);
    assert.throws(() => writePref('fed', '-1', env), /Unbekannte/);
    writeFileSync(join(dir, 'prefs.json'), '{"animations":"wild","raven":"caged","x":1}');
    assert.deepEqual(readPrefs(env), {});
    writeFileSync(join(dir, 'prefs.json'), 'kaputt');
    assert.deepEqual(readPrefs(env), {});
});
