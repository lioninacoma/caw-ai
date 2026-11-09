import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fillDates, markDates } from '../src/host/dates.mjs';

const recordedOn = new Date(2026, 10, 7, 15, 30);

test('markDates: Daten nahe an heute werden relativ, feste Daten und Teile von Zahlen bleiben', () => {
    const step = { action: 'fill', value: '07.11.2026', code: "text.includes('14.11.2026') && iso === '2026-11-06'" };
    assert.deepEqual(markDates(step, recordedOn), { action: 'fill', value: '{{today}}', code: "text.includes('{{today+7}}') && iso === '{{todayIso-1}}'" });
    assert.equal(markDates('Geboren am 01.02.1980', recordedOn), 'Geboren am 01.02.1980', 'weit weg: fest');
    assert.equal(markDates('Version 107.11.2026', recordedOn), 'Version 107.11.2026', 'kein eigenes Token');
    assert.equal(markDates('31.02.2026', recordedOn), '31.02.2026', 'kein gültiges Datum');
    assert.equal(markDates('Nr. 2026-11-0712', recordedOn), 'Nr. 2026-11-0712');
});

test('fillDates: Platzhalter werden zum Datum des Abspieltags, auch über Monatsgrenzen', () => {
    const later = new Date(2027, 0, 30);
    assert.deepEqual(fillDates({ value: '{{today}}', code: "x === '{{today+7}}' || y === '{{todayIso-1}}'" }, later), { value: '30.01.2027', code: "x === '06.02.2027' || y === '2027-01-29'" });
    assert.equal(fillDates(markDates('am 07.11.2026', recordedOn), recordedOn), 'am 07.11.2026', 'hin und zurück am selben Tag');
});
