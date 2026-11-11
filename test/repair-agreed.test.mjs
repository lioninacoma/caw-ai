// Beheben nach einem Gespraech: Ein Fehler, den der Mensch erlaubt hat, traegt die alte Einordnung nicht mehr.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowedNow } from '../src/host/run.mjs';

const failure = {
    type: 'pageerror',
    text: 'TypeError: t.getKey is not a function',
    stack: ['at onEnter (https://portal.example/o/FormProxyServlet?url=inubitrepository:///Root/public/PackagesExtJS6/modernPersonensuche.js:138:9)'],
};

test('Beheben: erlaubte harte Fehler zählen nach der Entscheidung nicht mehr', () => {
    assert.deepEqual(allowedNow([failure], {}), [], 'ohne Regeln bleibt alles hart');
    assert.deepEqual(allowedNow([failure], { foreignCode: ['PackagesExtJS6/modernPersonensuche\\.js'] }), [failure]);
    assert.deepEqual(allowedNow([failure], { consoleIgnore: ['t\\.getKey is not a function'] }), [failure]);
    assert.deepEqual(allowedNow([{ type: 'http', text: '500 /api', url: 'https://portal.example/PackagesExtJS6/x' }], { foreignCode: ['PackagesExtJS6'] }), [], 'HTTP-Fehler bleiben hart');
});
