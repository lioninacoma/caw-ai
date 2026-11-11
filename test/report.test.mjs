import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateFinish, renderReport } from '../src/shared/report.mjs';

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
    const md = renderReport({ ...r, testId: 'smoke', target: 'shop/dev', source: 'overlay', expectations: rb.expectations });
    for (const part of ['fail', 'smoke', 'shop/dev', 'E1', 'E2', 'leer', 'boom']) assert.ok(md.includes(part), part);
});
