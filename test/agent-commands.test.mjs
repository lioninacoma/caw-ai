import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAgentHandler, isAllowedUrl } from '../src/host/agent-commands.mjs';

const setup = (t, overrides = {}) => {
    const agentDir = mkdtempSync(join(tmpdir(), 'caw-agent-'));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
    const calls = [];
    const page = {
        locator: (selector) => ({
            click: async () => { calls.push(['click', selector]); },
            fill: async (value) => { calls.push(['fill', selector, value]); },
        }),
        goto: async (url) => { calls.push(['goto', url]); },
        url: () => 'https://portal.example/',
        evaluate: async (code) => { calls.push(['eval', code]); return 42; },
        screenshot: async () => Buffer.from('png'),
    };
    const verdicts = [];
    const failures = [];
    const handler = createAgentHandler({
        session: { page: () => page, failures: () => failures, ...overrides.session },
        run: { expectations: [{ id: 'E1', text: 'x' }] },
        hosts: ['portal.example'],
        agentDir,
        onVerdict: (outcome) => verdicts.push(outcome),
        ...overrides.handler,
    });
    return { handler, calls, verdicts, failures, agentDir };
};

const pass = (value) => ({ expectations: [{ id: 'E1', status: 'pass', evidence: value }] });

test('fill: Leer ist erlaubt und leert das Feld, ein fehlender Wert nicht', async () => {
    const calls = [];
    const handler = createAgentHandler({
        session: { page: () => ({ locator: () => ({ fill: async (value) => { calls.push(value); } }) }) },
        run: {},
        hosts: [],
        agentDir: '.',
        onVerdict: () => {},
    });
    assert.equal(await handler({ action: 'fill', target: '#a', value: '' }), 'ok');
    assert.deepEqual(calls, ['']);
    await assert.rejects(handler({ action: 'fill', target: '#a' }), { code: 'usage' });
});

test('isAllowedUrl: nur http(s) zu erlaubten Hosts', () => {
    const hosts = ['portal.example'];
    assert.equal(isAllowedUrl('https://portal.example/x', hosts), true);
    assert.equal(isAllowedUrl('https://PORTAL.example:8443/', hosts), true);
    for (const bad of ['https://evil.example/', 'file:///C:/Windows/win.ini', 'chrome://settings', 'javascript:alert(1)', 'https://portal.example.evil.example/', 'https://portal.example@evil.example/', 'kein url']) {
        assert.equal(isAllowedUrl(bad, hosts), false, bad);
    }
});

test('Unbekannte Befehle und geerbte Eigenschaften werden abgewiesen', async (t) => {
    const { handler } = setup(t);
    for (const action of ['cdp', 'constructor', '__proto__', 'toString', undefined]) {
        await assert.rejects(handler({ action }), { code: 'unknown-command' }, String(action));
    }
    await assert.rejects(handler(null), { code: 'unknown-command' });
});

test('goto prüft das Ziel, bevor der Browser es sieht', async (t) => {
    const { handler, calls } = setup(t);
    await assert.rejects(handler({ action: 'goto', url: 'file:///C:/x' }), { code: 'target-denied' });
    assert.deepEqual(calls, []);
    await handler({ action: 'goto', url: 'https://portal.example/a' });
    assert.deepEqual(calls, [['goto', 'https://portal.example/a']]);
});

test('Referenzen aus dem Snapshot werden zu aria-ref, Selektoren bleiben', async (t) => {
    const { handler, calls } = setup(t);
    await handler({ action: 'click', target: 'e12' });
    await handler({ action: 'click', target: 'f1e2' });
    await handler({ action: 'click', target: '#knopf' });
    assert.deepEqual(calls, [['click', 'aria-ref=e12'], ['click', 'aria-ref=f1e2'], ['click', '#knopf']]);
});

test('Screenshot: nur Dateinamen, nie Pfade, nie Überschreiben', async (t) => {
    const { handler, agentDir } = setup(t);
    for (const name of ['../x.png', '..\\x.png', 'C:\\x.png', '/tmp/x.png', '.png', 'a.exe', 'sub/a.png']) {
        await assert.rejects(handler({ action: 'screenshot', name }), { code: 'usage' }, name);
    }
    await handler({ action: 'screenshot', name: 'e1.png' });
    assert.equal(readFileSync(join(agentDir, 'e1.png'), 'utf8'), 'png');
    writeFileSync(join(agentDir, 'vom-agent.png'), 'alt');
    await assert.rejects(handler({ action: 'screenshot', name: 'vom-agent.png' }), { code: 'EEXIST' });
    assert.equal(readFileSync(join(agentDir, 'vom-agent.png'), 'utf8'), 'alt');
});

test('finish: Der Agent kann keine eigene Datei als Screenshot ausgeben', async (t) => {
    const { handler, agentDir, verdicts } = setup(t);
    writeFileSync(join(agentDir, 'selbst.png'), 'x');
    await assert.rejects(handler({ action: 'finish', results: pass({ type: 'screenshot', value: 'selbst.png' }) }), { code: 'finish-rejected' });
    assert.deepEqual(verdicts, []);
    await handler({ action: 'screenshot', name: 'echt.png' });
    assert.deepEqual(await handler({ action: 'finish', results: pass({ type: 'screenshot', value: 'echt.png' }) }), { status: 'pass' });
    assert.equal(verdicts.length, 1);
    assert.ok(existsSync(join(agentDir, 'echt.png')));
});

test('finish: Unvollständiges wird abgelehnt, danach nachbesserbar, nach Annahme ist Schluss', async (t) => {
    const { handler, verdicts, calls } = setup(t);
    await assert.rejects(handler({ action: 'finish', results: { expectations: [] } }), { code: 'finish-rejected' });
    await assert.rejects(handler({ action: 'finish' }), { code: 'finish-rejected' });
    await handler({ action: 'finish', results: pass({ type: 'eval', value: 'ok' }) });
    assert.equal(verdicts[0].status, 'pass');
    await assert.rejects(handler({ action: 'eval', code: '1' }), { code: 'run-finished' });
    await assert.rejects(handler({ action: 'finish', results: pass({ type: 'eval', value: 'ok' }) }), { code: 'run-finished' });
    assert.deepEqual(calls, []);
});

test('finish: Harte Konsolenfehler ergeben fail, egal was der Agent meint', async (t) => {
    const { handler, failures } = setup(t);
    failures.push({ type: 'pageerror', text: 'boom' });
    assert.deepEqual(await handler({ action: 'finish', results: pass({ type: 'eval', value: 'ok' }) }), { status: 'fail' });
});

test('check: nur genau true besteht, und der Punkt muss zum Runbook gehören', async (t) => {
    const results = { '1 === 1': true, '"ja"': 'ja', 1: 1 };
    const { handler } = setup(t, { session: { page: () => ({ evaluate: async (code) => results[code] }) } });
    assert.deepEqual(await handler({ action: 'check', id: 'E1', code: '1 === 1' }), { id: 'E1', pass: true, value: true });
    assert.equal((await handler({ action: 'check', id: 'E1', code: '"ja"' })).pass, false);
    assert.equal((await handler({ action: 'check', id: 'E1', code: '1' })).pass, false);
    await assert.rejects(handler({ action: 'check', id: 'E9', code: '1 === 1' }), { code: 'step-unknown' });
    await assert.rejects(handler({ action: 'check', id: 'E1' }), { code: 'usage' });
});

test('Hängender Befehl blockiert den Lauf nicht', async (t) => {
    const { handler } = setup(t, {
        handler: { commandTimeoutMs: 20 },
        session: { page: () => ({ evaluate: () => new Promise(() => {}) }) },
    });
    await assert.rejects(handler({ action: 'eval', code: 'x' }), { code: 'command-timeout' });
});
