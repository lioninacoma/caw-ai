import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fillDates, markDates } from '../src/host/dates.mjs';

const recordedOn = new Date(2026, 10, 7, 15, 30);

test('markDates: dates near today become relative, fixed dates and parts of numbers stay', () => {
    const step = { action: 'fill', value: '07.11.2026', code: "text.includes('14.11.2026') && iso === '2026-11-06'" };
    assert.deepEqual(markDates(step, recordedOn), { action: 'fill', value: '{{today}}', code: "text.includes('{{today+7}}') && iso === '{{todayIso-1}}'" });
    assert.equal(markDates('Geboren am 01.02.1980', recordedOn), 'Geboren am 01.02.1980', 'far away: fixed');
    assert.equal(markDates('Version 107.11.2026', recordedOn), 'Version 107.11.2026', 'not a token of its own');
    assert.equal(markDates('31.02.2026', recordedOn), '31.02.2026', 'not a valid date');
    assert.equal(markDates('Nr. 2026-11-0712', recordedOn), 'Nr. 2026-11-0712');
});

test('fillDates: placeholders become the replay date, also across month boundaries', () => {
    const later = new Date(2027, 0, 30);
    assert.deepEqual(fillDates({ value: '{{today}}', code: "x === '{{today+7}}' || y === '{{todayIso-1}}'" }, later), { value: '30.01.2027', code: "x === '06.02.2027' || y === '2027-01-29'" });
    assert.equal(fillDates(markDates('am 07.11.2026', recordedOn), recordedOn), 'am 07.11.2026', 'round trip on the same day');
});
