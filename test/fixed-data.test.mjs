// Fixed data for a look (fixed-data.mjs): caw's own anonymizer, obfuscation, the shape comparison, the storage format, which
// answers are frozen and how they are served, and the anonymizing command. Invented data only.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
    FIXED_MODES, answerBook, answerChanges, answersBySteps, answersUpTo, changeText, createAnonymizer, createAnswerLog, deobfuscate, fixedDataFile, fixedDataText,
    fixedSteps, isJsonType, obfuscate, parseFixedData, prepareAnswers, previewLines, readFixedData, requestKey, runAnonymizer, shapeChanges, shapeOf, withFixedData, writeFixedData,
} from '../src/host/fixed-data.mjs';
import { auditChanges } from '../src/host/audit.mjs';
import { renderRecordings, parseRecordings, stepHash } from '../src/host/test-file.mjs';
import { guardedChanges, validateConfig } from '../src/shared/config.mjs';
import { renderReport } from '../src/shared/report.mjs';
import { createLook, lookBasis, visualSettings } from '../src/host/visual.mjs';

const CONTACTS = [
    { id: 17, contactId: 'C-4711', name: 'Erika Beispielfrau', email: 'erika.beispiel@example.com', phone: '+49 30 1234567', street: 'Erfundene Gasse 3', city: 'Nirgendwo',
        zip: '12345', birthDate: '1980-02-29', iban: 'DE02120300000000202051', note: 'Ruft lieber vormittags an.', active: true, score: 4.5, status: 'OPEN', tags: ['VIP'], manager: null },
    { id: 18, contactId: 'C-4712', name: 'Max Ausgedacht', email: 'max@example.net', phone: '030 7654321', street: 'Fantasieweg 12', city: 'Irgendwo',
        zip: '01234', birthDate: '01.03.1975', iban: 'DE89 3704 0044 0532 0130 00', note: 'Neu', active: false, score: 3, status: 'CLOSED', tags: [], manager: { name: 'Erika Beispielfrau' } },
];

test('anonymizer: every text replaced by its kind, ids, numbers, booleans, null and keys stay; the same value the same way', () => {
    const anonymize = createAnonymizer({ salt: 'fixed', shift: 10 });
    const [one, two] = anonymize(CONTACTS);
    assert.deepEqual(Object.keys(one), Object.keys(CONTACTS[0]), 'keys stay');
    assert.equal(one.id, 17);
    assert.equal(one.contactId, 'C-4711', 'an id key keeps its value');
    assert.equal(one.active, true);
    assert.equal(one.score, 4.5);
    assert.equal(one.manager, null);
    assert.notEqual(one.name, CONTACTS[0].name);
    assert.match(one.name, /^\S+ \S+$/, 'a name of two words becomes an invented first and last name');
    assert.equal(two.manager.name, one.name, 'the same name in another answer gets the same replacement');
    assert.match(one.email, /^[a-z]+\.[0-9a-f]{6}@example\.org$/);
    assert.match(one.phone, /^\+\d\d \d\d \d{7}$/, 'a phone keeps its format');
    assert.match(two.phone, /^0\d\d \d{7}$/, 'a leading zero stays');
    assert.notEqual(one.phone, CONTACTS[0].phone);
    assert.match(one.street, /^\S+ \d+$/);
    assert.notEqual(one.city, CONTACTS[0].city);
    assert.match(one.zip, /^\d{5}$/);
    assert.notEqual(one.zip, CONTACTS[0].zip);
    assert.match(two.zip, /^0\d{4}$/);
    assert.equal(one.birthDate, '1980-02-19', 'an ISO date shifted by the days');
    assert.equal(two.birthDate, '19.02.1975', 'a German date shifted alike');
    assert.match(one.iban, /^DE[0-9A-Z]{20}$/);
    assert.notEqual(one.iban, CONTACTS[0].iban);
    assert.equal(one.note.length, CONTACTS[0].note.length, 'free text: neutral text of the same length');
    assert.match(one.note, /^[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+\.$/, 'spaces, case and punctuation in place');
    assert.notEqual(one.status, 'OPEN', 'when in doubt replaced');
    assert.match(one.status, /^[A-Z]{4}$/);
    assert.deepEqual(createAnonymizer({ salt: 'fixed', shift: 10 })(CONTACTS), [one, two], 'deterministic for one salt');
});

test('anonymizer: values in keep stay, UUIDs stay, empty text stays', () => {
    const anonymize = createAnonymizer({ keep: ['OPEN', 'EUR'], salt: 's', shift: 1 });
    const out = anonymize({ status: 'OPEN', currency: 'EUR', ref: '9b2f6a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b', label: '', other: 'CLOSED' });
    assert.deepEqual(out, { status: 'OPEN', currency: 'EUR', ref: '9b2f6a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b', label: '', other: out.other });
    assert.notEqual(out.other, 'CLOSED');
});

test('obfuscation: round trip, not readable in the file', () => {
    const text = obfuscate(CONTACTS);
    assert.match(text, /^caw-obfuscated-1:[A-Za-z0-9+/=]+$/);
    assert.ok(!text.includes('Beispielfrau'));
    assert.deepEqual(deobfuscate(text), CONTACTS);
    assert.throws(() => deobfuscate('plain'));
});

test('shape: same shape with other values fits; fields gone or new, other kinds and status do not; null, empty lists and optional fields fit', () => {
    const other = [{ ...CONTACTS[1], id: 99, name: 'Neu Erfunden', manager: { name: 'X' } }];
    assert.deepEqual(shapeChanges(shapeOf(CONTACTS), shapeOf(other)), []);
    assert.deepEqual(shapeChanges(shapeOf(CONTACTS), shapeOf([])), [], 'an empty list fits');
    const renamed = CONTACTS.map(({ city, ...rest }) => ({ ...rest, town: city }));
    assert.deepEqual(shapeChanges(shapeOf(CONTACTS), shapeOf(renamed)).map(({ change, path }) => `${change} ${path}`), ['missing [].city', 'added [].town']);
    const kinds = CONTACTS.map((contact) => ({ ...contact, score: String(contact.score) }));
    assert.deepEqual(shapeChanges(shapeOf(CONTACTS), shapeOf(kinds)), [{ change: 'kind', path: '[].score', was: 'number', now: 'string' }]);
    // A key only some items have is optional: an answer without it fits.
    const optional = [{ a: 1, b: 'x' }, { a: 2 }];
    assert.deepEqual(shapeChanges(shapeOf(optional), shapeOf([{ a: 3 }])), []);
    assert.deepEqual(answerChanges({ status: 200, body: CONTACTS }, { status: 200, json: other }), []);
    assert.deepEqual(answerChanges({ status: 200, body: CONTACTS }, { status: 500, json: undefined }), [{ change: 'status', was: 200, now: 500 }]);
    assert.deepEqual(answerChanges({ status: 200, body: CONTACTS }, { status: 200, json: undefined }), [{ change: 'notJson' }]);
    assert.deepEqual(answerChanges({ status: 200, body: CONTACTS }, { status: 0 }), [{ change: 'unreachable' }]);
    assert.equal(changeText({ change: 'kind', path: '[].score', was: 'number', now: 'string' }), '[].score ist Text statt eine Zahl');
    assert.equal(changeText({ change: 'missing', path: '[].city' }), 'Feld [].city fehlt');
    assert.equal(changeText({ change: 'status', was: 200, now: 500 }), 'Status 500 statt 200');
});

test('JSON answers by content type; the request key hides the address', () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'application/vnd.api+json', 'application/graphql-response+json']) assert.ok(isJsonType(type), type);
    for (const type of ['text/html', 'text/plain', 'application/x-ndjson', 'application/javascript', '']) assert.ok(!isJsonType(type), type);
    const key = requestKey({ method: 'get', url: 'https://app.example.test/api/contacts?email=erika@example.com' });
    assert.match(key, /^[0-9a-f]{16}$/);
    assert.equal(key, requestKey({ method: 'GET', url: 'https://other.example.test/api/contacts?email=erika@example.com' }), 'host does not count');
    assert.notEqual(key, requestKey({ method: 'GET', url: 'https://app.example.test/api/contacts?email=max@example.net' }));
    assert.notEqual(requestKey({ method: 'POST', url: 'https://a.test/graphql', postData: '{"query":"{a}"}' }), requestKey({ method: 'POST', url: 'https://a.test/graphql', postData: '{"query":"{b}"}' }));
});

test('answer log: in arrival order, the body follows, bounded; the steps by marks, frozen up to the last look step', () => {
    const log = createAnswerLog({ maxAnswers: 3, maxChars: 40 });
    const first = log.add({ name: 'GET /api/a', key: 'k1', status: 200, type: 'application/json' });
    const second = log.add({ name: 'GET /api/b', key: 'k2', status: 200, type: 'application/json' });
    const third = log.add({ name: 'GET /api/c', key: 'k3', status: 200, type: 'application/json' });
    assert.equal(log.add({ name: 'GET /api/d', key: 'k4', status: 200, type: 'application/json' }), null, 'no more than maxAnswers');
    second.fill('{"b":1}');
    first.fill('{"a":1}');
    third.fill('x'.repeat(41));
    assert.deepEqual(log.since(0).map(({ name, body }) => [name, body]), [['GET /api/a', { a: 1 }], ['GET /api/b', { b: 1 }]], 'too long is left out');
    const marks = [{ owner: 'S1', at: 0 }, { owner: 'S2', at: 1 }, { owner: 'S3', at: 2 }];
    const stepped = answersBySteps(log.since(0), marks);
    assert.deepEqual(stepped.map(({ step }) => step), ['S1', 'S2']);
    assert.deepEqual(answersBySteps(log.since(0), [{ owner: 'S2', at: 1 }]).map(({ step }) => step), ['S2', 'S2'], 'what the start page loaded belongs to the first step');
    assert.deepEqual(answersBySteps(log.since(0), []), []);
    assert.deepEqual(answersUpTo(stepped, ['S1', 'S2', 'S3'], ['S1']).map(({ step }) => step), ['S1']);
    assert.deepEqual(answersUpTo(stepped, ['S1', 'S2', 'S3'], ['S3']).map(({ step }) => step), ['S1', 'S2']);
});

test('answer book: the same request in its order, else the same name, the last answer again when asked more often', () => {
    const answers = [
        { name: 'GET /api/list', key: 'p1', body: 1 },
        { name: 'GET /api/list', key: 'p2', body: 2 },
        { name: 'GET /api/list', key: 'p1', body: 3 },
    ];
    const book = answerBook(answers);
    assert.equal(book.take({ key: 'p1', name: 'GET /api/list' }).body, 1);
    assert.equal(book.take({ key: 'p1', name: 'GET /api/list' }).body, 3);
    assert.equal(book.take({ key: 'p1', name: 'GET /api/list' }).body, 3);
    assert.equal(book.take({ key: 'p9', name: 'GET /api/list' }).body, 1, 'a cache buster in the query: by name');
    assert.equal(book.take({ key: 'p9', name: 'GET /api/other' }), null);
});

const ANSWERS = [{ step: 'S1', name: 'GET /api/contacts', key: 'abc', status: 200, type: 'application/json', at: 0, body: CONTACTS }];

test('storage: every mode round trips; obfuscated is not readable in the file; the file and its hash are read back', () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-fixed-'));
    try {
        for (const mode of FIXED_MODES) {
            const data = { test: 'kontakte', mode, ...(mode === 'anonymized' ? { by: 'built-in' } : {}), frozen: '2026-11-21', steps: ['S1'], answers: ANSWERS };
            const text = fixedDataText(data);
            assert.equal(text.includes('Beispielfrau'), mode !== 'obfuscated', mode);
            assert.ok(!text.includes('"at"'), 'only what serving needs');
            const parsed = parseFixedData(text);
            assert.deepEqual(parsed.answers, ANSWERS.map(({ at: _at, ...rest }) => rest), mode);
            assert.equal(parsed.mode, mode);
            assert.equal(writeFixedData(root, data), 'caw/recordings/kontakte/fixed-data.json');
            const read = readFixedData(root, 'kontakte');
            assert.deepEqual(read.data.steps, ['S1']);
            assert.match(read.hash, /^[0-9a-f]{12}$/);
        }
        assert.equal(fixedDataFile('kontakte'), 'caw/recordings/kontakte/fixed-data.json');
        assert.equal(readFixedData(root, 'none'), null);
        writeFileSync(join(root, fixedDataFile('kontakte')), '{"version":1}');
        assert.deepEqual(readFixedData(root, 'kontakte'), { broken: 'caw/recordings/kontakte/fixed-data.json' });
        assert.throws(() => parseFixedData('{"version":2,"mode":"plain","steps":[],"answers":[]}'));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('prepare: anonymized by caw unless a command is configured; obfuscated and plain unchanged; a shape change is refused', async () => {
    const own = await prepareAnswers({ mode: 'anonymized', answers: ANSWERS });
    assert.equal(own.by, 'built-in');
    assert.notEqual(own.answers[0].body[0].name, CONTACTS[0].name);
    assert.deepEqual(shapeChanges(shapeOf(own.answers[0].body), shapeOf(CONTACTS)), []);
    const kept = await prepareAnswers({ mode: 'anonymized', answers: ANSWERS, anonymize: { keep: ['Nirgendwo'] } });
    assert.equal(kept.answers[0].body[0].city, 'Nirgendwo');
    for (const mode of ['obfuscated', 'plain']) assert.deepEqual(await prepareAnswers({ mode, answers: ANSWERS }), { answers: ANSWERS });
    const given = [];
    const byCommand = await prepareAnswers({ mode: 'anonymized', answers: ANSWERS, anonymize: { command: ['anon'] }, run: async (call) => { given.push(call); return [CONTACTS.map((contact) => ({ ...contact, name: 'Anon' }))]; } });
    assert.equal(byCommand.by, 'command');
    assert.equal(byCommand.answers[0].body[1].name, 'Anon');
    assert.deepEqual(given[0].command, ['anon']);
    await assert.rejects(prepareAnswers({ mode: 'anonymized', answers: ANSWERS, anonymize: { command: ['anon'] }, run: async () => [[{ id: 'x' }]] }), /Struktur der Antwort von GET \/api\/contacts/);
});

test('the anonymizing command: JSON on stdin and stdout, no shell; a failing or wrong command says why', async () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-anon-'));
    try {
        mkdirSync(join(root, 'tools'));
        writeFileSync(join(root, 'tools', 'anon.mjs'), `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    const { answers, keep } = JSON.parse(input);
    process.stdout.write(JSON.stringify({ answers: answers.map(({ body }) => ({ body: body.map((item) => ({ ...item, name: keep[0] })) })) }));
});
`);
        const bodies = await runAnonymizer({ command: [process.execPath, 'tools/anon.mjs'], root, keep: ['Ersetzt'], answers: ANSWERS });
        assert.deepEqual(bodies[0].map(({ name }) => name), ['Ersetzt', 'Ersetzt']);
        writeFileSync(join(root, 'tools', 'fail.mjs'), "process.stderr.write('kaputt\\n'); process.exit(3);");
        await assert.rejects(runAnonymizer({ command: [process.execPath, 'tools/fail.mjs'], root, answers: ANSWERS }), /Exit-Code 3 kaputt/);
        writeFileSync(join(root, 'tools', 'few.mjs'), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{\"answers\":[]}'));");
        await assert.rejects(runAnonymizer({ command: [process.execPath, 'tools/few.mjs'], root, answers: ANSWERS }), /mit 1 Einträgen/);
        await assert.rejects(runAnonymizer({ command: [join(root, 'missing-program')], root, answers: ANSWERS }), /ist gescheitert/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

const stepOf = (id, extra = {}) => {
    const plain = { id, name: id, do: '', expect: `${id} da` };
    return { ...plain, recording: { hash: stepHash(plain), recordedOn: 'local', recordedAt: '2026-11-06T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'reload' }], check: 'true', ...extra } };
};

test('marks in the recording: the frozen look steps get fixed, a step no longer frozen loses it; only look steps with it count', () => {
    const spec = { id: 't', steps: [{ ...stepOf('S1', { fixed: { mode: 'plain', frozen: '2026-01-01' } }), look: true }, { ...stepOf('S2'), look: true }, stepOf('S3')] };
    const marked = withFixedData(spec, ['S2'], { mode: 'anonymized', frozen: '2026-11-21' });
    assert.equal(marked.steps[0].recording.fixed, undefined);
    assert.deepEqual(marked.steps[1].recording.fixed, { mode: 'anonymized', frozen: '2026-11-21' });
    assert.equal(marked.steps[2].recording.fixed, undefined);
    assert.deepEqual(fixedSteps(marked), ['S2']);
    assert.deepEqual(fixedSteps({ steps: [stepOf('S1', { fixed: { mode: 'plain', frozen: '2026-01-01' } })] }), [], 'without look: true nothing');
    // The recording file carries it on one line and reads it back; anything else is refused.
    const text = renderRecordings({ id: 't', steps: marked.steps.map(({ id, recording }) => ({ id, recording })) });
    assert.match(text, /fixed: \{mode: anonymized, frozen: 2026-11-21\}/);
    assert.deepEqual(parseRecordings(text).byId.get('S2').fixed, { mode: 'anonymized', frozen: '2026-11-21' });
    assert.throws(() => parseRecordings(text.replace('mode: anonymized', 'mode: secret')), /recording\.fixed braucht mode/);
});

test('audit lists newly frozen data with how it is stored, and data no longer frozen', () => {
    const side = (steps) => ({ config: {}, tests: new Map([['t', { id: 't', steps }]]), unreadable: [] });
    const before = [{ ...stepOf('S1'), look: true }];
    const frozen = [{ ...stepOf('S1', { fixed: { mode: 'plain', frozen: '2026-11-21' } }), look: true }];
    const added = auditChanges(side(before), side(frozen));
    assert.deepEqual(added.map(({ kind, severity }) => `${severity}:${kind}`), ['listed:fixed-data-frozen']);
    assert.match(added[0].text, /Für das Aussehen von S1 wurden am 2026-11-21 Daten eingefroren, lesbar, nach der Bestätigung/);
    const removed = auditChanges(side(frozen), side(before));
    assert.deepEqual(removed.map(({ kind, severity }) => `${severity}:${kind}`), ['listed:fixed-data-removed']);
    assert.deepEqual(auditChanges(side(frozen), side(frozen)), []);
});

test('config: anonymize takes a command list and keep values; a changed anonymize is a guarded change', () => {
    assert.ok(validateConfig({ anonymize: { command: ['node', 'tools/anon.mjs'], keep: ['EUR'] } }).issues.every((issue) => !/anonymize/.test(issue)));
    for (const anonymize of [{ command: 'node tools/anon.mjs' }, { command: [] }, { keep: [1] }, { other: true }, 'x']) {
        assert.ok(validateConfig({ anonymize }).issues.some((issue) => /anonymize muss ein Objekt sein/.test(issue)), JSON.stringify(anonymize));
    }
    assert.ok(validateConfig({ design: { fail: ['fixedData'] } }).issues.every((issue) => !/design\.fail/.test(issue)));
    assert.deepEqual(guardedChanges({}, { anonymize: { keep: ['x'] } }), ['anonymize']);
});

test('report: the choice for fixed data, never the data; readable only with the confirmation', () => {
    const base = { status: 'pass', testId: 't', target: 'local', testedCode: 'deployed' };
    const stored = renderReport({ ...base, fixedData: { steps: ['S1'], answers: 2, stored: true, mode: 'plain', confirmed: true, file: 'caw/recordings/t/fixed-data.json' } });
    assert.match(stored, /## Feste Daten/);
    assert.match(stored, /Aussehens-Schritte S1: 2 JSON-Antworten/);
    assert.match(stored, /Lesbar gespeichert\./);
    assert.match(stored, /Datenschutz für diese Daten geprüft/);
    assert.match(renderReport({ ...base, fixedData: { steps: ['S1'], answers: 2, stored: true, mode: 'anonymized', by: 'command', confirmed: false, file: 'f' } }), /Anonymisiert gespeichert \(anonymize\.command\)\./);
    const declined = renderReport({ ...base, fixedData: { steps: ['S1'], answers: 2, stored: false } });
    assert.match(declined, /Nichts gespeichert/);
    assert.ok(!/Datei:/.test(declined));
});

test('preview: step, request name and the start of the body, a bounded list', () => {
    const lines = previewLines([...ANSWERS, ...ANSWERS], { max: 1, width: 20 });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^S1 · GET \/api\/contacts: \[\{"id":17,"contactId…$/);
    assert.equal(lines[1], 'und 1 weitere Antworten');
});

test('look on fixed data: the normal run leaves it out (look pass headless, not at all in a window); the look pass looks only at it; its basis names the data', async () => {
    const spec = { id: 't', steps: [{ ...stepOf('S1'), look: true }, { ...stepOf('S2'), look: true }] };
    const capture = () => assert.fail('nothing is captured for a left-out look');
    const make = (fixed, pixels) => createLook({ spec, cawDir: '.', root: '.', settings: visualSettings({}), compare: () => assert.fail(), save: () => undefined, readImage: () => null, pixels, fixed });
    const steps = new Set(['S1']);
    assert.deepEqual((await make({ steps, hash: 'h', pass: false }, false)('S1', { capture, page: {} })).record, { visual: { verdict: 'skipped', fixed: 'headless-only' } });
    assert.deepEqual((await make({ steps, hash: 'h', pass: false }, true)('S1', { capture, page: {} })).record, { visual: { verdict: 'skipped', fixed: 'look-pass' } });
    assert.deepEqual((await make({ steps, hash: 'h', pass: true }, true)('S2', { capture, page: {} })).record, {}, 'the look pass judges only the fixed steps');
    assert.equal(lookBasis(spec, spec.steps[1], undefined, 'abc'), '2026-11-06T09:00:00.000Z fixed:abc');
    assert.equal(lookBasis(spec, spec.steps[0], undefined, 'abc'), 'fixed:abc');
});
