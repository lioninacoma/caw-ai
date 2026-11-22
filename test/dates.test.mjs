import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fillDates, markDates } from '../src/host/dates.mjs';

const recordedOn = new Date(2026, 10, 7, 15, 30);

test('markDates: dates near today become relative, fixed dates and parts of numbers stay', () => {
    const step = { action: 'fill', value: '07.11.2026', code: "text.includes('14.11.2026') && iso === '2026-11-06'" };
    assert.deepEqual(markDates(step, recordedOn, 'de-DE'), { action: 'fill', value: '{{date}}', code: "text.includes('{{date+7}}') && iso === '{{isoDate-1}}'" });
    assert.equal(markDates('Geboren am 01.02.1980', recordedOn, 'de-DE'), 'Geboren am 01.02.1980', 'far away: fixed');
    assert.equal(markDates('Version 107.11.2026', recordedOn, 'de-DE'), 'Version 107.11.2026', 'not a token of its own');
    assert.equal(markDates('31.02.2026', recordedOn, 'de-DE'), '31.02.2026', 'not a valid date');
    assert.equal(markDates('Nr. 2026-11-0712', recordedOn, 'de-DE'), 'Nr. 2026-11-0712');
});

test('markDates: the locale\'s own numeric date (OPEN-5); another locale\'s order is no date there', () => {
    assert.equal(markDates('Due 11/14/2026', recordedOn, 'en-US'), 'Due {{date+7}}');
    assert.equal(markDates('Due 14/11/2026', recordedOn, 'en-GB'), 'Due {{date+7}}');
    assert.equal(markDates('Due 11/14/2026', recordedOn, 'de-DE'), 'Due 11/14/2026', 'a US date in a German app stays');
    assert.equal(markDates('Due 14.11.2026', recordedOn, 'en-US'), 'Due 14.11.2026');
    assert.equal(markDates('2026-11-14', recordedOn, 'sv-SE'), '{{isoDate+7}}', 'an ISO locale: only isoDate');
});

test('fillDates: placeholders become the replay date, also across month boundaries', () => {
    const later = new Date(2027, 0, 30);
    assert.deepEqual(fillDates({ value: '{{date}}', code: "x === '{{date+7}}' || y === '{{isoDate-1}}'" }, later, 'de-DE'), { value: '30.01.2027', code: "x === '06.02.2027' || y === '2027-01-29'" });
    assert.equal(fillDates('{{date+7}}', later, 'en-US'), '02/06/2027');
    assert.equal(fillDates('{{date}}', later, 'ko-KR'), '2027-01-30', 'no plain numeric date in the locale: ISO');
    assert.equal(fillDates(markDates('am 07.11.2026', recordedOn, 'de-DE'), recordedOn, 'de-DE'), 'am 07.11.2026', 'round trip on the same day');
});
