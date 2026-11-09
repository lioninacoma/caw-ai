import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pollChannel, sendCommand } from '../src/shared/channel.mjs';

const channel = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-channel-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const serveUntil = async (dir, handler, promise) => {
    let running = true;
    const loop = (async () => {
        while (running) {
            await pollChannel(dir, handler);
            await new Promise((ok) => { setTimeout(ok, 5); });
        }
    })();
    try {
        return await promise;
    } finally {
        running = false;
        await loop;
    }
};

test('Befehl und Antwort laufen durch den Kanal und hinterlassen nichts', async (t) => {
    const dir = channel(t);
    const value = await serveUntil(dir, (command) => `echo ${command.action}`, sendCommand(dir, { action: 'x' }));
    assert.equal(value, 'echo x');
    assert.deepEqual(readdirSync(dir), []);
});

test('Fehler des Hosts kommen mit Code beim Client an', async (t) => {
    const dir = channel(t);
    const failing = () => { throw Object.assign(new Error('nein'), { code: 'target-denied' }); };
    await serveUntil(dir, failing, assert.rejects(sendCommand(dir, { action: 'x' }), { code: 'target-denied', message: 'nein' }));
});

test('Kaputtes JSON: Antwort zitiert den Dateiinhalt nicht', async (t) => {
    const dir = channel(t);
    writeFileSync(join(dir, 'cmd-a.json'), 'GEHEIMER INHALT');
    await pollChannel(dir, () => assert.fail('darf nicht ausgeführt werden'));
    const answer = readFileSync(join(dir, 'res-a.json'), 'utf8');
    assert.match(answer, /command-invalid/);
    assert.doesNotMatch(answer, /GEHEIM/);
});

test('Verknüpfung als Befehl wird nicht gelesen', { skip: process.platform === 'win32' && 'braucht Symlink-Rechte unter Windows' }, async (t) => {
    const dir = channel(t);
    const secret = join(dir, '..', `secret-${Date.now()}.json`);
    writeFileSync(secret, '{"action":"x"}');
    t.after(() => rmSync(secret, { force: true }));
    symlinkSync(secret, join(dir, 'cmd-a.json'));
    await pollChannel(dir, () => assert.fail('darf nicht ausgeführt werden'));
    assert.match(readFileSync(join(dir, 'res-a.json'), 'utf8'), /command-invalid/);
});

test('Eintrag, der sich nicht löschen lässt, bringt den Host nicht zu Fall und wird nur einmal bearbeitet', async (t) => {
    const dir = channel(t);
    mkdirSync(join(dir, 'cmd-a.json'));
    const ignored = new Set();
    await pollChannel(dir, () => assert.fail('darf nicht ausgeführt werden'), ignored);
    assert.ok(ignored.has('cmd-a.json'));
    await pollChannel(dir, () => assert.fail('darf nicht ausgeführt werden'), ignored);
    const value = await serveUntil(dir, () => 'weiter', sendCommand(dir, { action: 'x' }));
    assert.equal(value, 'weiter');
});

test('Unpassende Dateinamen werden ignoriert, kein Pfad aus dem Ordner heraus', async (t) => {
    const dir = channel(t);
    writeFileSync(join(dir, 'cmd-..%2Fx.json'), '{}');
    writeFileSync(join(dir, 'beliebig.json'), '{}');
    await pollChannel(dir, () => assert.fail('darf nicht ausgeführt werden'));
    assert.ok(existsSync(join(dir, 'beliebig.json')));
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('res-')).length, 0);
});
