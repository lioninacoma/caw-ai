// The look suggestion after a recording: values from the server's JSON, visible texts, the decision per step.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { MIN_VALUE, lookCandidates, normalText, responseValues, showsServed, textProbe } from '../src/host/look-hints.mjs';
import { maskProbe } from '../src/host/visual.mjs';
import { launchChrome } from './chrome.mjs';

test('values from JSON: strings and numbers, normalized, at least three characters, keys left out', () => {
    const values = responseValues({ items: [{ name: '  Ada   Example ', city: 'Sampletown', id: 4711, active: true, note: null, code: 'ok' }], total: 12, ratio: 0.25, extra: ['de'] });
    assert.deepEqual([...values].sort(), ['0.25', '4711', 'ada example', 'sampletown']);
    assert.equal(MIN_VALUE, 3);
    assert.equal(values.has('name'), false, 'keys are the API\'s names, not data');
});

test('values from JSON: a plain string or number body, a bound on how many are kept, long strings left out', () => {
    assert.deepEqual([...responseValues('Hello there')], ['hello there']);
    assert.deepEqual([...responseValues(123)], ['123']);
    assert.equal(responseValues(Array.from({ length: 50 }, (_, index) => `value ${index}`), new Set(), { max: 10 }).size, 10);
    assert.equal(responseValues(['x'.repeat(600)]).size, 0);
    const into = new Set(['kept']);
    responseValues(['added'], into);
    assert.deepEqual([...into], ['kept', 'added'], 'one set for the whole run');
});

test('matching: a visible text that contains a value shows server data; case and whitespace do not matter', () => {
    const values = responseValues([{ name: 'Ada Example' }, { amount: 1250 }]);
    assert.equal(showsServed(['Contacts', 'ADA   example · Sampletown'], values), true);
    assert.equal(showsServed(['Total: 1250 €'], values), true, 'a number rendered as text');
    assert.equal(showsServed(['Contacts', 'New contact', 'Name', 'City'], values), false, 'only the app\'s own texts');
    assert.equal(showsServed(['Ada'], values), false, 'part of a value is not the value');
    assert.equal(showsServed(['anything'], new Set()), false, 'no reads, nothing from the server');
    assert.equal(normalText('  A\n\tB  '), 'a b');
});

test('candidates: passed, without look, measured, neither server text nor masks', () => {
    const spec = { steps: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }, { id: 'S4', look: true }, { id: 'S5' }, { id: 'S6' }] };
    const results = new Map(['S1', 'S2', 'S3', 'S4', 'S5'].map((id) => [id, { status: 'pass' }]).concat([['S6', { status: 'fail' }]]));
    const hints = new Map([
        ['S1', { served: true, masks: 0 }],
        ['S2', { served: false, masks: 0 }],
        ['S3', { served: false, masks: 2 }],
        ['S4', { served: false, masks: 0 }],
        ['S5', null],
        ['S6', { served: false, masks: 0 }],
    ]);
    assert.deepEqual(lookCandidates({ spec, results, hints }), ['S2']);
    assert.deepEqual(lookCandidates({ spec, results, hints: new Map() }), [], 'nothing measured, nothing offered');
});

let browser = null;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

test('in the page: visible texts and field values, hidden ones and passwords left out; masks of a list', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const page = await browser.newPage();
    try {
        await page.setContent(`<h1>Contacts</h1><section hidden><p>Ada Example</p></section><p style="visibility:hidden">Secret Row</p>
<label>Name <input value="Bea Sample"></label><input type="password" value="hunter22"><input type="hidden" value="token-1">
<ul><li>Entry one</li></ul>`);
        const texts = await page.evaluate(textProbe, { max: 100 });
        assert.ok(texts.some((text) => text === 'Contacts'));
        assert.ok(texts.includes('Bea Sample'), 'a field filled from the server shows data too');
        assert.equal(texts.some((text) => /Ada Example|Secret Row|hunter22|token-1/.test(text)), false, JSON.stringify(texts));
        assert.equal(showsServed(texts, responseValues([{ name: 'Ada Example' }])), false, 'a hidden view shows nothing');
        assert.equal(showsServed(texts, responseValues([{ name: 'Bea Sample' }])), true);
        assert.equal((await page.evaluate(maskProbe, { texts: [], ignore: [], max: 1 })).length, 1, 'the list entry is masked');
        await page.setContent('<h1>New contact</h1><label>Name <input></label><button>Cancel</button>');
        assert.equal((await page.evaluate(maskProbe, { texts: [], ignore: [], max: 1 })).length, 0, 'a static form has no masks');
    } finally {
        await page.close();
    }
});
