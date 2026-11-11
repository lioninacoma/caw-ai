import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dockerCandidates, nativeDocker, selectDocker, wslDocker, wslEnv } from '../src/host/docker.mjs';

const fake = (label, result) => ({ label, startHint: `start ${label}`, run: async () => result });

test('wslEnv passes the token through and keeps existing entries', () => {
    assert.equal(wslEnv({}).WSLENV, 'CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(wslEnv({ WSLENV: 'A/p' }).WSLENV, 'A/p:CLAUDE_CODE_OAUTH_TOKEN');
    assert.equal(wslEnv({ X: '1' }).X, '1');
});

test('dockerCandidates: Windows tries both, CAW_DOCKER decides, Linux goes direct', () => {
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: {} }), [nativeDocker, wslDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'windows' } }), [nativeDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'wsl' } }), [wslDocker]);
    assert.deepEqual(dockerCandidates({ platform: 'linux', env: { CAW_DOCKER: 'wsl' } }), [nativeDocker]);
    assert.throws(() => dockerCandidates({ platform: 'win32', env: { CAW_DOCKER: 'podman' } }), { code: 'usage' });
});

test('hostPath: native keeps the Windows path, WSL converts it', () => {
    assert.equal(nativeDocker.hostPath('C:\\p\\x'), 'C:\\p\\x');
    assert.equal(wslDocker.hostPath('C:\\p\\x'), '/mnt/c/p/x');
});

test('selectDocker takes the first way with a running Linux daemon', async () => {
    const ready = fake('b', { code: 0, stdout: 'linux\n' });
    assert.equal(await selectDocker([fake('a', { code: 127, stdout: '' }), ready]), ready);
    assert.equal(await selectDocker([fake('a', { code: 1, stdout: '' }), ready]), ready);
    assert.equal(await selectDocker([ready, fake('a', { code: 0, stdout: 'linux' })]), ready);
});

test('selectDocker understands the UTF-16 output of wsl.exe', async () => {
    const ready = fake('a', { code: 0, stdout: 'l\0i\0n\0u\0x\0\n\0' });
    assert.equal(await selectDocker([ready]), ready);
});

test('selectDocker: a stopped daemon is reported clearly with how to start it', async () => {
    await assert.rejects(selectDocker([fake('a', { code: 127, stdout: '' }), fake('b', { code: 1, stdout: '' })]), (error) => {
        assert.equal(error.code, 'docker-not-running');
        assert.match(error.message, /start b/);
        assert.doesNotMatch(error.message, /start a/);
        return true;
    });
});

test('selectDocker: WSL without a distribution counts as missing, not stopped', async () => {
    const broken = { ...fake('a', { code: 1, stdout: '' }), reachable: async () => false };
    await assert.rejects(selectDocker([broken]), { code: 'docker-missing' });
    const stopped = { ...fake('a', { code: 1, stdout: '' }), reachable: async () => true };
    await assert.rejects(selectDocker([stopped]), { code: 'docker-not-running' });
});

test('selectDocker: Windows containers and missing Docker have their own messages', async () => {
    await assert.rejects(selectDocker([fake('a', { code: 0, stdout: 'windows' })]), { code: 'docker-wrong-mode' });
    await assert.rejects(selectDocker([fake('a', { code: 127, stdout: '' })]), { code: 'docker-missing' });
    await assert.rejects(selectDocker([fake('a', { code: 0, stdout: 'windows' }), fake('b', { code: 1, stdout: '' })]), { code: 'docker-wrong-mode' });
});
