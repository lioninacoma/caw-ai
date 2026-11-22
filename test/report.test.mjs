import assert from 'node:assert/strict';
import { test } from 'node:test';

import { t } from '../src/shared/i18n.mjs';
import { classifyFailure, evaluateFinish, isSkipped, renderReport } from '../src/shared/report.mjs';

const rb = { id: 'smoke', expectations: [{ id: 'E1', text: 'a' }, { id: 'E2', text: 'b' }] };
const ok = (id) => ({ id, status: 'pass', evidence: { type: 'eval', value: 'true' } });
const exists = () => true;
const finish = (results, failures = [], fileExists = exists) => evaluateFinish({ expectations: rb.expectations, results, failures, fileExists });

test('all expectations passed and a clean console give pass', () => {
    const r = finish({ expectations: [ok('E1'), ok('E2')] });
    assert.equal(r.status, 'pass');
});

test('a missing expectation is rejected', () => {
    assert.throws(() => finish({ expectations: [ok('E1')] }), /E2/);
});

test('an unknown expectation is rejected', () => {
    assert.throws(() => finish({ expectations: [ok('E1'), ok('E2'), ok('E9')] }), /E9/);
});

test('missing or empty evidence is rejected', () => {
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass' }, ok('E2')] }), /Nachweis/);
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass', evidence: { type: 'eval', value: ' ' } }, ok('E2')] }), /Nachweis/);
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass', evidence: { type: 'magie', value: 'x' } }, ok('E2')] }), /Nachweis/);
});

test('screenshot evidence must exist', () => {
    const shot = { id: 'E1', status: 'pass', evidence: { type: 'screenshot', value: 'a.png' } };
    assert.throws(() => finish({ expectations: [shot, ok('E2')] }, [], () => false), /a\.png/);
    assert.equal(finish({ expectations: [shot, ok('E2')] }).status, 'pass');
});

test('an invalid status is rejected', () => {
    assert.throws(() => finish({ expectations: [{ ...ok('E1'), status: 'ok' }, ok('E2')] }), /Status/);
});

test('one fail gives fail', () => {
    const r = finish({ expectations: [{ ...ok('E1'), status: 'fail' }, ok('E2')] });
    assert.equal(r.status, 'fail');
});

test('hard console errors give fail even if all expectations passed', () => {
    const r = finish({ expectations: [ok('E1'), ok('E2')] }, [{ type: 'pageerror', text: 'boom' }]);
    assert.equal(r.status, 'fail');
    assert.equal(r.failures.length, 1);
});

test('a reported environment error gives error and needs a reason', () => {
    assert.equal(finish({ status: 'error', reason: 'Portal weg' }).status, 'error');
    assert.throws(() => finish({ status: 'error' }), /Grund/);
});

test('the report names status, expectations, evidence and console errors', () => {
    const r = finish({ expectations: [ok('E1'), { ...ok('E2'), status: 'fail', note: 'leer' }] }, [{ type: 'pageerror', text: 'boom' }]);
    const md = renderReport({ ...r, testId: 'smoke', target: 'shop/dev', testedCode: 'local code', expectations: rb.expectations });
    for (const part of ['fail', 'smoke', 'shop/dev', 'E1', 'E2', 'leer', 'boom']) assert.ok(md.includes(part), part);
});

test('the report links screenshots in agent/ and marks steps never reached as skipped', () => {
    const shot = { type: 'screenshot', value: 'failure-step-4.png' };
    const results = [
        { id: 'S1', status: 'fail', evidence: shot, note: 'kaputt' },
        { id: 'S2', status: 'fail', evidence: shot, note: t('session.replay.notReachedBecause', { owner: 'S1' }) },
        { id: 'S3', status: 'skipped', evidence: shot, note: '' },
    ];
    const expectations = [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }, { id: 'S3', text: 'c' }];
    const md = renderReport({ status: 'fail', testId: 'x', target: 'local', results, expectations });
    assert.match(md, /\| S1 \| a \| fail \| screenshot: \[failure-step-4\.png\]\(agent\/failure-step-4\.png\) \| kaputt \|/);
    assert.match(md, /\| S2 \| b \| skipped \| - \| Nicht erreicht/);
    assert.match(md, /\| S3 \| c \| skipped \| - \|/);
    assert.equal(isSkipped(results[0], results), false, 'the failed step itself is no skip');
    assert.equal(isSkipped({ id: 'S2', status: 'fail', note: 'anderer Grund' }, results), false);
});

test('the tested version is the line the terminal prints', () => {
    const base = { status: 'pass', testId: 'x', target: 'local' };
    assert.match(renderReport({ ...base, testedCode: 'Dev-Server localhost:4174, dein aktueller Stand' }), /Getesteter Stand: Dev-Server localhost:4174, dein aktueller Stand/);
    assert.match(renderReport({ ...base, status: 'error', code: 'env-unreachable', testedCode: 'Dev-Server localhost:4174, dein aktueller Stand' }), /Getesteter Stand: Dev-Server localhost:4174/, 'the error code stays separate from the tested version');
});

test('third-party hosts: their errors and failed requests are warnings, the app host stays hard; the report lists them', () => {
    const thirdParty = (url) => !url.startsWith('https://app.example/');
    const rules = { thirdParty };
    assert.equal(classifyFailure({ type: 'requestfailed', text: 'net::ERR_FAILED' }, { url: 'https://cdn.example/lib.js' }, rules), 'warn');
    assert.equal(classifyFailure({ type: 'http', text: 'HTTP 500' }, { url: 'https://stats.example/collect' }, rules), 'warn');
    assert.equal(classifyFailure({ type: 'pageerror', text: 'boom' }, { stack: 'Error: boom\n    at x (https://cdn.example/widget.js:1:2)' }, rules), 'warn');
    assert.equal(classifyFailure({ type: 'http', text: 'HTTP 500' }, { url: 'https://app.example/api' }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'pageerror', text: 'boom' }, { stack: 'Error: boom\n    at x (https://app.example/main.js:1:2)' }, rules), 'fail');
    assert.equal(classifyFailure({ type: 'requestfailed', text: 'net::ERR_FAILED' }, { url: 'https://app.example/api' }, rules), 'fail');
    const md = renderReport({ status: 'pass', testId: 'x', target: 'local', thirdParty: [{ host: 'cdn.example', requests: 3, types: ['script', 'stylesheet'], failed: 1 }] });
    assert.match(md, /## Fremde Hosts/);
    assert.match(md, /\| cdn\.example \| 3 \| script, stylesheet \| 1 \|/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'x', target: 'local' }), /Fremde Hosts/);
});

test('what the window saw after the handover is a section of its own and leaves the result alone', () => {
    const md = renderReport({ status: 'pass', testId: 'open', target: 'local', afterHandover: [{ type: 'host-blocked', text: 'Request to example.com blocked', count: 2 }] });
    assert.match(md, /^# open auf local: pass/m);
    assert.match(md, /## Nach der Übergabe\n\nGesehen, während das Fenster dir gehörte, .*\n\n- host-blocked: Request to example.com blocked \(2x\)/);
    assert.doesNotMatch(md, /## Warnungen/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'open', target: 'local' }), /Übergabe/);
});

test('report: pending steps are named below the results, outside the verdict', () => {
    const text = renderReport({ status: 'pass', testId: 'smoke', target: 'local', testedCode: 'deployed', expectations: rb.expectations, results: [ok('E1'), ok('E2')], pending: ['E3', 'E4'] });
    assert.match(text, /\| E2 \| b \| pass \|.*\n\nOffen, noch nicht aufgenommen: E3, E4\. Diese Schritte liefen nicht\.\n/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'smoke', target: 'local', testedCode: 'deployed', expectations: rb.expectations, results: [ok('E1'), ok('E2')] }), /Offen/);
});

test('report: a proposed target has its own section with both locators', () => {
    const proposal = { step: 'S2', action: 1, from: "getByRole('button', { name: 'Speichern' })", to: "getByRole('button', { name: 'Sichern' })", evidence: { check: 'c => true' } };
    const text = renderReport({ status: 'fail', testId: 'smoke', target: 'local', testedCode: 'deployed', steps: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail', kind: 'target', proposal }] });
    assert.match(text, /## Vorgeschlagene Ziele\n\nEin aufgenommenes Element fehlt, ein ähnliches trat an seine Stelle: .*\n\n- S2, Aktion 1: `getByRole\('button', \{ name: 'Speichern' \}\)` → `getByRole\('button', \{ name: 'Sichern' \}\)`\n/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'smoke', target: 'local', testedCode: 'deployed', steps: [{ id: 'S1', status: 'pass' }] }), /Vorgeschlagene Ziele/);
});

test('pending steps: one step is named in the singular, several in the plural', () => {
    assert.equal(t('config.report.pending', { ids: 'S5', count: 1 }), 'Offen, noch nicht aufgenommen: S5. Dieser Schritt lief nicht.');
    assert.equal(t('cli.pendingSteps', { ids: 'S5', count: 1, test: 'a', step: 'S5', target: 'local' }), 'Offen, noch nicht aufgenommen: S5. Er lief nicht. Nimm ihn auf: caw record a@S5 --env local');
    assert.match(t('cli.pendingSteps', { ids: 'S4, S5', count: 2, test: 'a', step: 'S4', target: 'local' }), /Sie liefen nicht\. Nimm sie auf: caw record a@S4/);
});

test('renderReport: effect lines a learning run dropped have their own section; the result stays', () => {
    const md = renderReport({ status: 'pass', testId: 'x', target: 'local', results: [ok('E1')], expectations: [{ id: 'E1', text: 'a' }], effectsDropped: [{ step: 'S2', lines: ['1 requests: POST /api/orders 201', '1 controls: + a | b'] }] });
    assert.match(md, /## Beim Lernen der Effekte verworfen\n\nAlle früheren Läufe sahen diese Zeilen/);
    assert.match(md, /- S2: 1 requests: POST \/api\/orders 201; 1 controls: \+ a \\\| b/);
    assert.doesNotMatch(renderReport({ status: 'pass', testId: 'x', target: 'local', results: [ok('E1')], expectations: [{ id: 'E1', text: 'a' }] }), /verworfen/);
});
