import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dockerCandidates, nativeDocker, selectDocker, wslDocker, wslEnv } from '../src/host/docker.mjs';

const fake = (label, result) => ({ label, startHint: `start ${label}`, run: async () => result });

test('wslEnv reicht das Token durch und behält vorhandene Einträge', () => {
    assert.equal(wslEnv({}).WSLENV, 'CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(wslEnv({ WSLENV: 'A/p' }).WSLENV, 'A/p:CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(wslEnv({ X: '1' }).X, '1');
});

test('dockerCandidates: Windows versucht beide, CAW_DOCKER legt fest, Linux direkt', () => {
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: {} }), [nativeDocker, wslDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'windows' } }), [nativeDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'wsl' } }), [wslDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'linux', env: { CAW_DOCKER: 'wsl' } }), [nativeDocker]);
    assert.throws(() => dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'podman' } }), { code: 'usage' });
});

test('hostPath: direkt bleibt der Windows-Pfad, über WSL wird umgerechnet', () => {
    assert.equal(nativeDocker.hostPath('C:\\p\\x'), 'C:\\p\\x');
    assert.equal(wslDocker.hostPath('C:\\p\\x'), '/mnt/c/p/x');
});

test('selectDocker nimmt den ersten Weg mit laufendem Linux-Dienst', async () => {
    const ready = fake('b', { code: 0, stdout: 'linux\n' });
    assert.equal(await selectDocker([fake('a', { code: 127, stdout: '' }), ready]), ready);
    assert.equal(await selectDocker([fake('a', { code: 1, stdout: '' }), ready]), ready);
    assert.equal(await selectDocker([ready, fake('a', { code: 0, stdout: 'linux' })]), ready);
});

test('selectDocker versteht die UTF-16-Ausgabe von wsl.exe', async () => {
    const ready = fake('a', { code: 0, stdout: 'l\0i\0n\0u\0x\0\n\0' });
    assert.equal(await selectDocker([ready]), ready);
});

test('selectDocker: Dienst aus wird klar gemeldet und nennt den Start', async () => {
    await assert.rejects(selectDocker([fake('a', { code: 127, stdout: '' }), fake('b', { code: 1, stdout: '' })]), (error) => {
        assert.equal(error.code, 'docker-not-running');
        assert.match(error.message, /start b/);
        assert.doesNotMatch(error.message, /start a/);
        return true;
    });
});

test('selectDocker: WSL ohne Distribution zählt als fehlend, nicht als gestoppt', async () => {
    const broken = { ...fake('a', { code: 1, stdout: '' }), reachable: async () => false };
    await assert.rejects(selectDocker([broken]), { code: 'docker-missing' });
    const stopped = { ...fake('a', { code: 1, stdout: '' }), reachable: async () => true };
    await assert.rejects(selectDocker([stopped]), { code: 'docker-not-running' });
});

test('selectDocker: Windows-Container und fehlendes Docker haben eigene Meldungen', async () => {
    await assert.rejects(selectDocker([fake('a', { code: 0, stdout: 'windows' })]), { code: 'docker-wrong-mode' });
    await assert.rejects(selectDocker([fake('a', { code: 127, stdout: '' })]), { code: 'docker-missing' });
    await assert.rejects(selectDocker([fake('a', { code: 0, stdout: 'windows' }), fake('b', { code: 1, stdout: '' })]), { code: 'docker-wrong-mode' });
});
