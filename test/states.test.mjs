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
    return { ...plain, recording: { hash: stepHash(plain), recordedOn: 'dev', recordedAt: '2026-11-11T09:00:00.000Z', actions: [{ action: 'click', target: { role: 'button', name: 'Weiter' } }], check: 'true' } };
};
const save = (root, id, role, app) => writeTest(root, composeTest({ id, app, role, targets: ['dev'], source: 'deployed', mutates: false, also: [] }, { notes: '', steps: [step('S1')] }));
const CONFIG = {
    auth: { type: 'form' },
    apps: { antrag: { startUrl: '/antrag' }, pruefen: { startUrl: '/pruefen' } },
    roles: { arzt: { loginEnv: 'L_A', passwordEnv: 'P_A' }, sachbearbeiter: { loginEnv: 'L_S', passwordEnv: 'P_S' } },
};

test('F1 catalog: tests of all roles and apps of the target, with role; not without an account for the role or the app', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-states-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    save(root, 'a-arzt', 'arzt', 'antrag');
    save(root, 'b-sb', 'sachbearbeiter', 'pruefen');
    save(root, 'c-gast', 'gast', 'antrag');
    save(root, 'd-fremd', 'arzt', 'unbekannt');
    const all = stateCatalog(root, CONFIG, { target: 'dev' });
    assert.deepEqual(all.map(({ id, role, app }) => [id, role, app]), [['a-arzt', 'arzt', 'antrag'], ['b-sb', 'sachbearbeiter', 'pruefen']]);
    assert.deepEqual(stateCatalog(root, CONFIG, { target: 'dev', role: 'sachbearbeiter' }).map(({ id }) => id), ['b-sb']);
    assert.deepEqual(stateCatalog(root, CONFIG, { target: 'prod' }), []);
});
