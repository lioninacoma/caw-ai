// Abspielen der von Hand geschriebenen Aktionen: upload, download, geheimes remember, Muster in knownMessages.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildReplay, playReplay, stepLabel } from '../src/host/replay.mjs';
import { targetLabel } from '../src/host/framework/index.mjs';

const BUTTON = { role: 'button', name: 'Dateien wählen' };
const healthy = { appLoaded: true, signedIn: true, loading: false, path: '/app', messages: [] };
const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms) => { time += ms; } };
};

/** Seite mit einem Element; `fileInput` sagt, ob es selbst das Dateifeld ist. Ereignisse liefert `events`. */
const sessionWith = ({ fileInput = false, events = {}, state = healthy, hidden } = {}) => {
    const calls = [];
    const element = {
        evaluate: async () => fileInput,
        setInputFiles: async (files) => { calls.push(['setInputFiles', files]); },
        click: async () => { calls.push(['click']); },
    };
    const page = {
        evaluateHandle: async () => ({ asElement: () => element, dispose: async () => {} }),
        evaluate: async () => state,
        waitForLoadState: async () => {},
        waitForEvent: async (name) => {
            calls.push(['waitForEvent', name]);
            if (events[name] === undefined) throw new Error('Timeout');
            return events[name](calls);
        },
    };
    return { calls, session: { page: () => page, waitReady: async () => ({ settled: true }), ...(hidden === undefined ? {} : { hide: (value) => hidden.push(value) }) } };
};
const play = (steps, session, { handler = async () => 'ok', filesDir, log, knownMessages } = {}) => {
    const { now, sleep } = clock();
    return playReplay({ replay: { steps, ...(knownMessages === undefined ? {} : { knownMessages }) }, handler, session, base: 'https://p.example', stepTimeoutMs: 1000, sleep, now, filesDir, log });
};
const cawDir = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-upload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(join(dir, 'fixtures', 'brief.pdf'), '%PDF');
    return dir;
};

test('upload: Ein Dateifeld bekommt die Dateien direkt, Pfade relativ zum caw-Ordner', async (t) => {
    const dir = cawDir(t);
    const { calls, session } = sessionWith({ fileInput: true });
    const { broken } = await play([{ action: 'upload', target: { role: 'textbox', name: 'Datei' }, files: ['fixtures/brief.pdf'] }], session, { filesDir: dir });
    assert.equal(broken, null);
    assert.deepEqual(calls, [['setInputFiles', [join(dir, 'fixtures', 'brief.pdf')]]]);
});

test('upload: Hinter einem Knopf öffnet der Klick die Dateiauswahl, sie bekommt die Dateien', async (t) => {
    const dir = cawDir(t);
    const chosen = [];
    const { calls, session } = sessionWith({ events: { filechooser: () => ({ setFiles: async (files) => { chosen.push(files); } }) } });
    const { broken } = await play([{ action: 'upload', target: BUTTON, files: ['fixtures/brief.pdf'] }], session, { filesDir: dir });
    assert.equal(broken, null);
    assert.deepEqual(calls.map(([name]) => name), ['waitForEvent', 'click']);
    assert.deepEqual(chosen, [[join(dir, 'fixtures', 'brief.pdf')]]);
    assert.equal(stepLabel({ action: 'upload', target: BUTTON, files: ['fixtures/brief.pdf'] }), 'upload button "Dateien wählen" fixtures/brief.pdf');
});

test('upload: Eine fehlende Datei oder eine ausserhalb des caw-Ordners bricht ab, ohne zu klicken', async (t) => {
    const dir = cawDir(t);
    for (const file of ['fixtures/fehlt.pdf', '../ausserhalb.pdf']) {
        const { calls, session } = sessionWith({ events: { filechooser: () => ({ setFiles: async () => {} }) } });
        const { broken } = await play([{ action: 'upload', target: BUTTON, files: [file] }], session, { filesDir: dir });
        assert.match(broken.message, new RegExp(file.replace(/[.]/g, '\\.')), file);
        assert.ok(!calls.some(([name]) => name === 'click'), file);
    }
});

const downloadOf = (name, content) => (dir) => () => {
    const path = join(dir, 'download.bin');
    writeFileSync(path, content);
    return { suggestedFilename: () => name, path: async () => path, delete: async () => {} };
};

test('download: Der Klick startet einen Download mit passendem Namen und Inhalt', async (t) => {
    const dir = cawDir(t);
    const { calls, session } = sessionWith({ events: { download: downloadOf('akte-7.zip', 'PK')(dir) } });
    const { broken } = await play([{ action: 'download', target: { role: 'button', name: 'Exportieren' }, file: '^akte-\\d+\\.zip$' }], session);
    assert.equal(broken, null);
    assert.deepEqual(calls.map(([name]) => name), ['waitForEvent', 'click']);
});

test('download: Falscher Name, leere Datei oder kein Download lassen den Schritt scheitern, ohne zweiten Klick', async (t) => {
    const dir = cawDir(t);
    const step = { action: 'download', target: { role: 'button', name: 'Exportieren' }, file: '^akte-\\d+\\.zip$' };
    const cases = [
        [{ download: downloadOf('bericht.pdf', 'x')(dir) }, /bericht\.pdf/],
        [{ download: downloadOf('akte-7.zip', '')(dir) }, /leer/],
        [{}, /keinen Download/],
    ];
    for (const [events, reason] of cases) {
        const { calls, session } = sessionWith({ events });
        const { broken } = await play([step, { action: 'check', id: 'S1', code: 'x' }], session, { handler: async () => ({ pass: true, value: true }) });
        assert.equal(broken.kind, 'check');
        assert.match(broken.message, reason);
        assert.equal(calls.filter(([name]) => name === 'click').length, 1, 'ein Download startet nur einmal');
    }
});

test('remember mit secret: Der Wert steht weder im Protokoll noch im Ergebnis, die Sitzung schwärzt ihn auch', async () => {
    const hidden = [];
    const { session } = sessionWith({ hidden });
    const labels = [];
    const handler = async (command) => {
        if (command.action === 'remember') return { name: command.name, value: 'Geheim-1234' };
        if (command.action === 'check') return { pass: false, value: `gesehen: ${command.code}` };
        return 'ok';
    };
    const steps = [
        { action: 'remember', name: 'pw', code: 'x', secret: true },
        { action: 'goto', url: '/login?pw={{pw}}' },
        { action: 'check', id: 'S1', code: "input.value === '{{pw}}'" },
    ];
    const { results, broken, remembered } = await play(steps, session, { handler, log: (entry) => labels.push(entry.label) });
    assert.deepEqual(hidden, ['Geheim-1234']);
    assert.equal(remembered.get('{{pw}}'), 'Geheim-1234', 'der Wert selbst bleibt für den Lauf');
    const shown = JSON.stringify({ labels, result: results.get('S1'), broken });
    assert.doesNotMatch(shown, /Geheim-1234/);
    assert.match(shown, /••••/);
});

test('knownMessages: Ein Muster deckt einen Dialog mit wechselndem Inhalt; eine lange unbekannte Meldung wird nur für die Anzeige gekürzt', async () => {
    const steps = [{ action: 'reload' }, { action: 'check', id: 'S1', code: 'x' }];
    const handler = async ({ action }) => (action === 'check' ? { pass: true, value: true } : 'ok');
    const checksum = { ...healthy, messages: ['Prüfsumme a#f#c kopiert'] };
    const known = await play(steps, sessionWith({ state: checksum }).session, { handler, knownMessages: ['Gespeichert', { pattern: '^Prüfsumme \\S+ kopiert$' }] });
    assert.equal(known.broken, null);
    const long = `Unbekannt ${'sehr lang '.repeat(60)}Ende`;
    const unknown = await play(steps, sessionWith({ state: { ...healthy, messages: [long] } }).session, { handler, knownMessages: [{ pattern: '^Prüfsumme' }] });
    assert.equal(unknown.broken.kind, 'external');
    assert.ok(unknown.broken.message.length < long.length, 'gekürzt angezeigt');
    assert.match(unknown.broken.message, /…/);
});

test('buildReplay: Muster bleiben in knownMessages, was ein Muster schon deckt, kommt nicht dazu', () => {
    const recorder = { problems: [], steps: [{ action: 'check', id: 'S1', code: 'true' }], messages: new Set(['Prüfsumme a#f kopiert', 'Neu']) };
    const spec = { id: 't', steps: [{ id: 'S1', name: 'a', do: 'b', expect: 'c' }] };
    const draft = { ...spec, knownMessages: ['Alt', { pattern: '^Prüfsumme' }] };
    const { candidate, fresh } = buildReplay({ recorder, outcome: { status: 'pass', results: [] }, spec, draft, target: 'local' });
    assert.deepEqual(fresh, ['Neu']);
    assert.deepEqual(candidate.knownMessages, ['Alt', 'Neu', { pattern: '^Prüfsumme' }]);
});

test('buildReplay: Ein von Hand als geheim markiertes remember bleibt geheim, wenn Claude den Schritt neu aufnimmt', () => {
    const recorder = { problems: [], steps: [{ action: 'remember', name: 'pw', code: 'neu' }, { action: 'check', id: 'S1', code: 'true' }], messages: new Set() };
    const spec = { id: 't', steps: [{ id: 'S1', name: 'a', do: 'b', expect: 'c' }] };
    const draft = { ...spec, steps: [{ ...spec.steps[0], recording: { actions: [{ action: 'remember', name: 'pw', code: 'alt', secret: true }] } }] };
    const { candidate } = buildReplay({ recorder, outcome: { status: 'pass', results: [] }, spec, draft, target: 'local' });
    assert.deepEqual(candidate.steps[0].recording.actions[0], { action: 'remember', name: 'pw', code: 'neu', secret: true });
});

test('targetLabel: Ein Muster erscheint als /Ausdruck/', () => {
    assert.equal(targetLabel({ role: 'button', name: { pattern: '^Prüfen' } }), 'button "/^Prüfen/"');
});

test('buildReplay: Neu aufgenommen behält ein bestehender Test seine Muster, geheime Werte und Zeitlimits, nicht seine alten festen Texte', () => {
    const recorder = { problems: [], steps: [{ action: 'remember', name: 'pw', code: 'neu' }, { action: 'check', id: 'S1', code: 'true' }, { action: 'check', id: 'S2', code: 'true' }], messages: new Set(['Prüfsumme 12 kopiert']) };
    const spec = { id: 't', steps: [{ id: 'S1', name: 'a', do: 'b', expect: 'c' }, { id: 'S2', name: 'd', do: 'e', expect: 'anders' }] };
    const previous = {
        ...spec,
        knownMessages: ['Veraltet', { pattern: '^Prüfsumme \\S+ kopiert$' }],
        steps: [
            { ...spec.steps[0], recording: { actions: [{ action: 'remember', name: 'pw', code: 'alt', secret: true }], check: 'true', timeoutMs: 20000 } },
            { ...spec.steps[1], expect: 'früher', recording: { actions: [], check: 'true', timeoutMs: 9000 } },
        ],
    };
    const { candidate } = buildReplay({ recorder, outcome: { status: 'pass', results: [] }, spec, previous, target: 'local' });
    assert.deepEqual(candidate.knownMessages, [{ pattern: '^Prüfsumme \\S+ kopiert$' }], 'das Muster deckt die neue Meldung, der alte feste Text fällt weg');
    assert.equal(candidate.steps[0].recording.actions[0].secret, true);
    assert.equal(candidate.steps[0].recording.timeoutMs, 20000);
    assert.equal(candidate.steps[1].recording.timeoutMs, undefined, 'ein geändertes Ergebnis prüft neu, ohne das alte Zeitlimit');
});
