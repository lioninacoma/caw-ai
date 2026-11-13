import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stateCatalog } from '../src/host/states.mjs';
import { stepHash, writeTest } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

const step = (id) => {
    const plain = { id, name: `Step ${id}`, do: `Do ${id}`, expect: `${id} is there` };
    return { ...plain, recording: { hash: stepHash(plain), recordedOn: 'dev', recordedAt: '2026-11-11T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'click', target: "getByRole('button', { name: 'Weiter', exact: true })" }], check: 'true' } };
};
const save = (root, id, role, start) => writeTest(root, composeTest({ id, role, environments: ['dev'], source: 'deployed', writes: false, ...(start === undefined ? {} : { start }) }, { notes: '', steps: [step('S1')] }));
const CONFIG = {
    auth: { type: 'form' },
    start: '/antrag',
    roles: { arzt: { loginEnv: 'L_A', passwordEnv: 'P_A' }, sachbearbeiter: { loginEnv: 'L_S', passwordEnv: 'P_S' } },
};

test('F1 catalog: tests of all roles of the target, with role and start path; not without an account for the role', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-states-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    save(root, 'a-arzt', 'arzt');
    save(root, 'b-sb', 'sachbearbeiter', '/pruefen');
    save(root, 'c-gast', 'gast');
    const all = stateCatalog(root, CONFIG, { target: 'dev' });
    assert.deepEqual(all.map(({ id, role, start }) => [id, role, start]), [['a-arzt', 'arzt', '/antrag'], ['b-sb', 'sachbearbeiter', '/pruefen']]);
    assert.deepEqual(stateCatalog(root, CONFIG, { target: 'dev', role: 'sachbearbeiter' }).map(({ id }) => id), ['b-sb']);
    assert.deepEqual(stateCatalog(root, CONFIG, { target: 'prod' }), []);
});
