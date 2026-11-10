import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateFinish, renderReport } from '../src/shared/report.mjs';

const rb = { id: 'smoke', expectations: [{ id: 'E1', text: 'a' }, { id: 'E2', text: 'b' }] };
const ok = (id) => ({ id, status: 'pass', evidence: { type: 'eval', value: 'true' } });
const exists = () => true;
const finish = (results, failures = [], fileExists = exists) => evaluateFinish({ expectations: rb.expectations, results, failures, fileExists });

test('alle Punkte bestanden und Konsole sauber ergibt pass', () => {
    const r = finish({ expectations: [ok('E1'), ok('E2')] });
    assert.equal(r.status, 'pass');
});

test('fehlender Punkt wird abgelehnt', () => {
    assert.throws(() => finish({ expectations: [ok('E1')] }), /E2/);
});

test('unbekannter Punkt wird abgelehnt', () => {
    assert.throws(() => finish({ expectations: [ok('E1'), ok('E2'), ok('E9')] }), /E9/);
});

test('fehlender oder leerer Nachweis wird abgelehnt', () => {
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass' }, ok('E2')] }), /Nachweis/);
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass', evidence: { type: 'eval', value: ' ' } }, ok('E2')] }), /Nachweis/);
    assert.throws(() => finish({ expectations: [{ id: 'E1', status: 'pass', evidence: { type: 'magie', value: 'x' } }, ok('E2')] }), /Nachweis/);
});

test('Screenshot-Nachweis muss existieren', () => {
    const shot = { id: 'E1', status: 'pass', evidence: { type: 'screenshot', value: 'a.png' } };
    assert.throws(() => finish({ expectations: [shot, ok('E2')] }, [], () => false), /a\.png/);
    assert.equal(finish({ expectations: [shot, ok('E2')] }).status, 'pass');
});

test('ungültiger Status wird abgelehnt', () => {
    assert.throws(() => finish({ expectations: [{ ...ok('E1'), status: 'ok' }, ok('E2')] }), /Status/);
});

test('ein fail ergibt fail', () => {
    const r = finish({ expectations: [{ ...ok('E1'), status: 'fail' }, ok('E2')] });
    assert.equal(r.status, 'fail');
});

test('harte Konsolenfehler ergeben fail, auch wenn alle Punkte bestanden sind', () => {
    const r = finish({ expectations: [ok('E1'), ok('E2')] }, [{ type: 'pageerror', text: 'boom' }]);
    assert.equal(r.status, 'fail');
    assert.equal(r.failures.length, 1);
});

test('gemeldeter Umgebungsfehler ergibt error und braucht einen Grund', () => {
    assert.equal(finish({ status: 'error', reason: 'Portal weg' }).status, 'error');
    assert.throws(() => finish({ status: 'error' }), /Grund/);
});

test('Report nennt Status, Punkte, Nachweise und Konsolenfehler', () => {
    const r = finish({ expectations: [ok('E1'), { ...ok('E2'), status: 'fail', note: 'leer' }] }, [{ type: 'pageerror', text: 'boom' }]);
    const md = renderReport({ ...r, testId: 'smoke', target: 'shop/dev', source: 'overlay', expectations: rb.expectations });
    for (const part of ['fail', 'smoke', 'shop/dev', 'E1', 'E2', 'leer', 'boom']) assert.ok(md.includes(part), part);
});
