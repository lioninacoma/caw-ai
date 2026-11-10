import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose, paramChange } from '../src/host/diagnose.mjs';
import { createNetworkLog, neutralName, outcomeText, parameterNames, requestName, summarizeRequests } from '../src/host/network-log.mjs';
import { missingBaselines, withBaselines } from '../src/host/replay.mjs';
import { parseTest, renderTest, stepHash } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

const FEES = 'POST /o/proxy connector=HTTP-X-Preise';
const failed = (reason = 'S5: Prüfung nicht erfüllt.') => ({ id: 'S5', reason });

test('Einordnung: Abbruch nach 2 ms ohne Seitenwechsel, bei der Aufnahme 850 ms, ist ein klarer Fehler der Anwendung', () => {
    const result = diagnose({
        failed: failed(),
        requests: [{ name: FEES, outcome: 'aborted', navigated: false, ms: 2 }],
        baseline: [{ name: FEES, status: 200, ms: 850 }],
    });
    assert.deepEqual([result.side, result.strength], ['app', 'clear']);
    assert.equal(result.text, 'Einschätzung: Fehler der Anwendung (eindeutig).');
    assert.match(result.findings[0], /nach 2 ms abgebrochen, ohne Seitenwechsel, bei der Aufnahme 200 in 850 ms/);
});

test('Einordnung: Ein Abbruch durch Seitenwechsel ist kein Beleg', () => {
    const result = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'aborted', navigated: true, ms: 2 }] });
    assert.equal(result.side, 'unclear');
    assert.match(result.findings[0], /Ohne Vergleich aus der Aufnahme/);
});

test('Einordnung: 5xx und Skriptfehler sind klar, 4xx und Konsole wahrscheinlich', () => {
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 40 }] })).slice(0, 2), ['app', 'clear']);
    // Gateway oder langsamer 5xx: Der Dienst dahinter laeuft nicht oder startet noch.
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 504, ms: 60_000 }], baseline: [{ name: FEES, status: 200, ms: 300 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 503, ms: 40 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 9000 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 404, ms: 40 }] })).slice(0, 2), ['app', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), failures: [{ type: 'pageerror', text: 'x is undefined' }] })).slice(0, 2), ['app', 'clear']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), failures: [{ type: 'console', text: 'Fehler' }] })).slice(0, 2), ['app', 'likely']);
    // Ein HTTP-Fehler, den schon ein Request des Schritts zeigt, zaehlt nicht doppelt.
    const twice = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 40 }], failures: [{ type: 'http', text: 'HTTP 500', url: 'https://x/o/proxy' }] });
    assert.equal(twice.findings.length, 1);
});

test('Einordnung: Deutlich langsamer als bei der Aufnahme oder Netzfehler spricht für die Umgebung', () => {
    const slow = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'ok', status: 200, ms: 21_000 }], baseline: [{ name: FEES, status: 200, ms: 900 }] });
    assert.deepEqual([slow.side, slow.strength], ['environment', 'likely']);
    assert.match(slow.findings[0], /brauchte 21,0 s, bei der Aufnahme 200 in 900 ms/);
    const late = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'aborted', navigated: false, ms: 30_000 }], baseline: [{ name: FEES, status: 200, ms: 900 }] });
    assert.equal(late.side, 'environment');
    const net = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'failed', error: 'net::ERR_CONNECTION_RESET', ms: 5 }] });
    assert.deepEqual([net.side, net.findings[0]], ['environment', `${FEES} ist fehlgeschlagen (net::ERR_CONNECTION_RESET).`]);
    const login = diagnose({ failed: failed('S5: Die Anmeldung ist verloren gegangen.') });
    assert.deepEqual([login.side, login.strength], ['environment', 'clear']);
    // Normal schnell, wie bei der Aufnahme: kein Befund.
    assert.equal(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'ok', status: 200, ms: 1200 }], baseline: [{ name: FEES, status: 200, ms: 900 }] }).side, 'unclear');
});

test('Einordnung: Ein Request der Aufnahme fehlt nur dann, wenn die Aktionen gelaufen sind', () => {
    const baseline = [{ name: FEES, status: 200, ms: 900 }];
    assert.equal(diagnose({ failed: failed(), broken: null, baseline }).side, 'app');
    // Abbruch mitten im Schritt: Die spaeteren Aktionen liefen nie, ihr Fehlen sagt nichts.
    assert.equal(diagnose({ failed: failed(), broken: { kind: 'state' }, baseline }).side, 'unclear');
    const target = diagnose({ failed: failed(), broken: { kind: 'target' }, baseline });
    assert.deepEqual([target.side, target.strength], ['test', 'likely']);
    assert.match(target.findings[0], /wie bei der Aufnahme/);
});

test('Einordnung: überholte Suche, Anmeldung, 401 und hängende Requests', () => {
    const typing = [{ name: FEES, outcome: 'aborted', ms: 20 }, { name: FEES, outcome: 'aborted', ms: 25 }, { name: FEES, outcome: 'ok', status: 200, ms: 300 }];
    assert.notEqual(diagnose({ failed: failed(), requests: typing }).side, 'app', 'Abbrüche beim Tippen, danach eine Antwort: normal');
    const lost = diagnose({ failed: failed('Die Anmeldung ist verloren.'), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 50 }] });
    assert.deepEqual([lost.side, lost.strength], ['environment', 'clear'], 'Die Anmeldung erklärt den 500');
    assert.equal(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 401, ms: 50 }] }).side, 'environment');
    const hanging = diagnose({ failed: failed(), broken: { kind: 'target' }, requests: [{ name: FEES, outcome: 'open', ms: 30_000, params: ['query'] }], baseline: [{ name: FEES, status: 200, ms: 900, params: [] }] });
    assert.equal(hanging.side, 'environment', 'offen ist kein geänderter Aufruf');
});

test('Einordnung: Fehlt das Ziel bei gesunder Seite, ist der Test vermutlich veraltet; der stärkste Befund gewinnt', () => {
    const stale = diagnose({ failed: failed(), broken: { kind: 'target' } });
    assert.equal(stale.text, 'Einschätzung: Test oder Testdaten (wahrscheinlich).');
    const mixed = diagnose({
        failed: failed(),
        broken: { kind: 'target' },
        requests: [{ name: 'GET /a', outcome: 'ok', status: 200, ms: 20_000 }, { name: FEES, outcome: 'http', status: 500, ms: 10 }],
        baseline: [{ name: 'GET /a', status: 200, ms: 500 }, { name: FEES, status: 200, ms: 10 }],
    });
    assert.deepEqual([mixed.side, mixed.strength], ['app', 'clear']);
    assert.match(mixed.findings[0], /HTTP 500/);
    assert.match(mixed.findings[1], /20,0 s/);
});

test('Requests: Der Name enthält Methode, Pfad und nur die Werte der genannten Parameter', () => {
    const url = 'https://portal.example/o/proxy?connector=HTTP-X-Speichern&antragId=4711&token=geheim';
    assert.equal(requestName({ method: 'post', url }, ['Connector']), 'POST /o/proxy connector=HTTP-X-Speichern');
    assert.equal(requestName({ method: 'GET', url }), 'GET /o/proxy');
    assert.equal(requestName({ method: 'GET', url: 'kaputt' }), 'GET ?');
    // Kurze Zufallskennungen (nanoid) mit Ziffern, grossen und kleinen Buchstaben; Namen von Schnittstellen bleiben.
    assert.equal(requestName({ method: 'GET', url: 'http://localhost:5173/api/me/groups/7/drafts/j46FjCJIrJQ4V0gp' }), 'GET /api/me/groups/:id/drafts/:id');
    assert.equal(requestName({ method: 'GET', url: 'http://localhost/api/oauth2Login/review-queue/v2' }), 'GET /api/oauth2Login/review-queue/v2');
});

test('Requests: Parameternamen ohne Werte aus Query und Formular, ohne die Namensgeber', () => {
    const url = 'https://portal.example/o/proxy?connector=HTTP-X&antragUUID=4711&zeit=1';
    assert.deepEqual(parameterNames({ url }, ['Connector']), ['antragUUID', 'zeit']);
    assert.deepEqual(parameterNames({ url, postData: 'b=geheim&a=1&zeit=2', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' }, ['connector']), ['a', 'antragUUID', 'b', 'zeit']);
    assert.deepEqual(parameterNames({ url: 'https://p/x', postData: '{"a":1}', contentType: 'application/json' }), ['json.a']);
    assert.deepEqual(parameterNames({ url: 'https://p/x', postData: '[{"b":1,"a":2}]', contentType: 'application/json; charset=utf-8' }), ['json.a', 'json.b']);
    // Aeltere Aufnahmen ohne JSON-Schluessel: neue Schluessel sind keine Aenderung.
    assert.equal(paramChange(['json.name', 'q'], ['q']), null);
    assert.match(paramChange(['json.title', 'q'], ['json.name', 'q']), /fehlt jetzt json.name, neu json.title/);
    assert.deepEqual(parameterNames({ url: 'kaputt', postData: 'a=1', contentType: 'application/x-www-form-urlencoded' }), ['a']);
    const log = createNetworkLog({ now: () => 0 });
    log.started('k', { name: 'GET /k', page: 1, params: ['a'] });
    log.started('l', { name: 'GET /l', page: 1, params: [] });
    log.finished('k', 200);
    log.finished('l', 200);
    assert.deepEqual(summarizeRequests(log.since()), [{ name: 'GET /k', status: 200, ms: 0, params: ['a'] }, { name: 'GET /l', status: 200, ms: 0, params: [] }]);
});

test('Einschätzung: Andere Parameternamen als bei der Aufnahme belegen einen geänderten Aufruf', () => {
    const name = 'GET /o/proxy connector=HTTP-X-AntragLaden';
    const failed = { id: 'S5', reason: 'Prüfung nicht erfüllt' };
    const baseline = [{ name, status: 200, ms: 900, params: ['allgemeinerAntragUUID'] }];
    const result = diagnose({ failed, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['antragUUID'] }], baseline });
    assert.deepEqual([result.side, result.strength], ['app', 'clear']);
    assert.match(result.findings[0], /fehlt jetzt allgemeinerAntragUUID, neu antragUUID/);
    const same = diagnose({ failed, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['allgemeinerAntragUUID'] }], baseline });
    assert.ok(same.findings.every((text) => !/andere Parameter/.test(text)));
    const older = diagnose({ failed, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['x'] }], baseline: [{ name, status: 200, ms: 900 }] });
    assert.ok(older.findings.every((text) => !/andere Parameter/.test(text)));
    // Ein beantworteter Request mit anderen Parametern ist kein Befund: Manche Schnittstellen wechseln sie.
    const answered = diagnose({ failed, requests: [{ name, outcome: 'ok', status: 200, ms: 300, params: ['x'] }], baseline });
    assert.ok(answered.findings.every((text) => !/andere Parameter/.test(text)));
    assert.deepEqual(summarizeRequests([{ name, outcome: 'ok', status: 200, ms: 1, params: ['b'] }, { name, outcome: 'ok', status: 200, ms: 1, params: ['a'] }])[0].params, ['a', 'b']);
    assert.equal(paramChange(['a'], ['a']), null);
    assert.equal(paramChange(['a', 'c'], ['a', 'b']), 'fehlt jetzt b, neu c');
});

test('Requests: Protokoll mit Ausgang und Dauer, Abbruch durch Seitenwechsel wird markiert', () => {
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.started('a', { name: 'GET /a', page: 1 });
    log.started('b', { name: 'GET /b', page: 1 });
    log.started('c', { name: 'GET /c', page: 2 });
    const mark = log.mark();
    log.started('d', { name: 'GET /d', page: 2 });
    clock = 5;
    log.finished('a', 200);
    log.failed('b', 'net::ERR_ABORTED');
    log.navigating(2);
    log.failed('c', 'net::ERR_ABORTED');
    log.failed('missing', 'egal');
    clock = 9;
    assert.deepEqual(log.since(), [
        { name: 'GET /a', outcome: 'ok', status: 200, ms: 5 },
        { name: 'GET /b', outcome: 'aborted', navigated: false, ms: 5 },
        { name: 'GET /c', outcome: 'aborted', navigated: true, ms: 5 },
        { name: 'GET /d', outcome: 'open', ms: 9 },
    ]);
    assert.deepEqual(log.since(mark).map(({ name }) => name), ['GET /d']);
    assert.deepEqual(log.since(0, 1).map(({ name }) => name), ['GET /a']);
    log.finished('d', 502);
    assert.deepEqual(log.since(mark), [{ name: 'GET /d', outcome: 'http', status: 502, ms: 9 }]);
});

test('Requests: Das neue Dokument beendet, was das alte offen ließ; was es selbst beginnt, bleibt', () => {
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.replaced(1);
    log.started('alt', { name: 'GET /alt', page: 1 });
    log.started('anders', { name: 'GET /anders', page: 2 });
    clock = 10;
    log.navigating(1);
    clock = 20;
    log.started('neu', { name: 'GET /neu', page: 1 });
    clock = 30;
    log.replaced(1);
    // Spaete Meldung des Browsers zum schon beendeten Request: aendert nichts mehr.
    log.failed('alt', 'net::ERR_ABORTED');
    assert.deepEqual(log.since(), [
        { name: 'GET /alt', outcome: 'aborted', navigated: true, ms: 30 },
        { name: 'GET /anders', outcome: 'open', ms: 30 },
        { name: 'GET /neu', outcome: 'open', ms: 10 },
    ]);
});

test('Requests: Kurzfassung fasst zusammen, nimmt die höchste Dauer und lässt Seitenwechsel weg', () => {
    const requests = [
        { name: 'GET /a', outcome: 'ok', status: 200, ms: 100 },
        { name: 'GET /a', outcome: 'ok', status: 200, ms: 300 },
        { name: 'GET /b', outcome: 'aborted', navigated: true, ms: 1 },
        { name: 'GET /c', outcome: 'aborted', navigated: false, ms: 2 },
        { name: 'GET /d', outcome: 'http', status: 404, ms: 7 },
    ];
    assert.deepEqual(summarizeRequests(requests), [
        { name: 'GET /a', status: 200, ms: 300, count: 2 },
        { name: 'GET /c', status: 'abgebrochen', ms: 2 },
        { name: 'GET /d', status: 404, ms: 7 },
    ]);
    assert.deepEqual(summarizeRequests(requests, { answeredOnly: true }).map(({ name }) => name), ['GET /a', 'GET /d']);
    assert.equal(summarizeRequests(Array.from({ length: 30 }, (_, index) => ({ name: `GET /${index}`, outcome: 'ok', status: 200, ms: 1 }))).length, 20);
});

test('Vergleichswerte: nur bestandene Schritte ohne Vergleich, aufgenommen auf demselben Ziel', () => {
    const stepWith = (id, recording) => ({ id, name: id, do: '', expect: 'x', ...(recording === undefined ? {} : { recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', ...recording } }) });
    const spec = { steps: [
        stepWith('S1', {}), stepWith('S2', { network: [{ name: FEES, status: 200, ms: 850, params: [] }] }), stepWith('S3', { recordedOn: 'a/test' }), stepWith('S4', {}), stepWith('S5'), stepWith('S6', {}),
        // Vergleichswerte aus der Zeit vor den Parameternamen werden ersetzt.
        stepWith('S7', { network: [{ name: FEES, status: 200, ms: 850 }] }),
    ] };
    const results = new Map(['S1', 'S2', 'S3', 'S5', 'S6', 'S7'].map((id) => [id, { status: 'pass' }]).concat([['S4', { status: 'fail' }]]));
    const ok = { name: FEES, outcome: 'ok', status: 200, ms: 850 };
    const requests = new Map(['S1', 'S2', 'S3', 'S4', 'S5', 'S7'].map((id) => [id, [ok, { name: 'GET /x', outcome: 'aborted', navigated: false, ms: 1 }]]));
    const found = missingBaselines({ spec, results, requests, target: 'a/dev' });
    assert.deepEqual([...found.keys()], ['S1', 'S7']);
    assert.deepEqual(found.get('S1'), [{ name: FEES, status: 200, ms: 850 }]);
    const filled = withBaselines(spec, found);
    assert.deepEqual(filled.steps[0].recording.network, found.get('S1'));
    assert.equal(filled.steps[0].recording.hash, 'h');
    assert.equal(filled.steps[1], spec.steps[1]);
});

test('Testdatei: recording.network wird gelesen und geschrieben, der Hash bleibt', () => {
    const step = { id: 'S1', name: 'Laden', do: 'Lade', expect: 'Da' };
    const network = [{ name: FEES, status: 200, ms: 850, params: ['orderUUID'] }, { name: 'GET /a', status: 200, ms: 30, count: 3, params: [] }];
    const recording = { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions: [], check: 'true', network };
    const spec = composeTest({ id: 't', app: 'a', role: 'r', targets: ['a/dev'], source: 'overlay', mutates: false, also: [] }, { steps: [{ ...step, recording }] });
    const text = renderTest(spec);
    assert.match(text, /network:\n\s+- \{name: POST \/o\/proxy connector=HTTP-X-Preise, status: 200, ms: 850, params: \[orderUUID\]\}/);
    const back = parseTest(text);
    assert.deepEqual(back.steps[0].recording.network, network);
    assert.equal(back.steps[0].recording.hash, stepHash(step));
    assert.equal(stepHash(back.steps[0]), stepHash(step));
    assert.throws(() => parseTest(text.replace('orderUUID', '""')), /recording\.network/);
    const broken = text.replace('ms: 850', 'ms: -1');
    assert.throws(() => parseTest(broken), /recording\.network/);
});

test('Requests: Ein Routenwechsel im selben Dokument erklärt einen Abbruch, auch wenn der Router die Adresse erst kurz danach setzt', () => {
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.started('vorher', { name: 'GET /liste', page: 1 });
    log.started('spaet', { name: 'GET /details', page: 1 });
    log.started('ohne', { name: 'GET /preise', page: 2 });
    clock = 10;
    log.failed('vorher', 'net::ERR_ABORTED');
    log.failed('ohne', 'net::ERR_ABORTED');
    clock = 300;
    log.routed(1);
    clock = 2000;
    log.failed('spaet', 'net::ERR_ABORTED');
    const seen = log.since();
    assert.deepEqual(seen[0], { name: 'GET /liste', outcome: 'aborted', navigated: true, routed: true, ms: 10 });
    assert.deepEqual(seen[1], { name: 'GET /details', outcome: 'aborted', navigated: false, ms: 2000 }, 'Abbruch lange nach dem Routenwechsel: eigener');
    assert.deepEqual(seen[2], { name: 'GET /preise', outcome: 'aborted', navigated: false, ms: 10 }, 'andere Seite ohne Routenwechsel');
    assert.deepEqual(summarizeRequests(seen).map(({ name }) => name), ['GET /details', 'GET /preise']);
});

test('Einschätzung: Ziel unter einem Dialog, der eine Ablehnung meldet, nach einem 409 im Schritt davor: Testdaten, nicht die Anwendung', () => {
    const broken = { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Akte anlegen', messages: ['Diesen Namen trägt schon eine Akte.'] } } };
    const earlier = { id: 'S2', requests: [{ name: 'POST /api/groups', outcome: 'http', status: 409, ms: 30 }] };
    const result = diagnose({ failed: { id: 'S3', reason: 'link "Einstellungen" war nach 8 s nicht klickbar.' }, broken, earlier });
    assert.equal(result.side, 'test');
    assert.match(result.findings[0], /verdeckt von dialog „Akte anlegen“\. Er meldet: „Diesen Namen trägt schon eine Akte\.“ Im Schritt davor \(S2\) lehnte der Dienst POST \/api\/groups mit HTTP 409 ab\./);
    assert.doesNotMatch(result.findings.join(' '), /fehlt auf der Seite/);
    // Ein 400 ohne Meldung zu den Daten: eher ein falscher Aufruf der Anwendung. Eine andere Meldung: unklar.
    const badCall = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Fehler' } } }, requests: [{ name: 'POST /api/groups', outcome: 'http', status: 400, ms: 30 }] });
    assert.equal(badCall.side, 'app');
    const npe = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Fehler', messages: ['NullPointerException'] } } } });
    assert.equal(npe.side, 'unclear');
    // Derselbe 409 im Schritt selbst: Testdaten, nicht doppelt als Anwendung gezaehlt.
    const here = diagnose({ failed: { id: 'S3', reason: 'x' }, broken, requests: [{ name: 'POST /api/groups', outcome: 'http', status: 409, ms: 30 }] });
    assert.equal(here.side, 'test');
    const plain = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target' }, earlier });
    assert.equal(plain.side, 'app', 'ohne Dialog bleibt ein 4xx davor ein Hinweis auf die Anwendung');
});

test('Einordnung Stufe 9: überholte Abbrüche, Kennungen im Pfad, Dauerverbindungen, gewollte 4xx', () => {
    const SEARCH = 'GET /api/suche';
    // Eine Suche beim Tippen: der fruehere Aufruf wird abgebrochen, der neue ist noch offen. Normal.
    const typed = diagnose({ failed: failed(), requests: [{ name: SEARCH, outcome: 'aborted', navigated: false, ms: 20 }, { name: SEARCH, outcome: 'open', ms: 100 }], baseline: [{ name: SEARCH, status: 200, ms: 300 }] });
    assert.equal(typed.side, 'unclear');
    // Ohne Vergleich aus der Aufnahme ist ein Abbruch nur ein Hinweis, etwa beim Schliessen einer Ansicht.
    const unmount = diagnose({ failed: failed(), requests: [{ name: 'GET /api/vorschau', outcome: 'aborted', navigated: false, ms: 120 }] });
    assert.equal(unmount.side, 'unclear');
    assert.match(unmount.findings.join(), /abgebrochen, ohne Seitenwechsel/);

    // Kennungen im Pfad: /1001 bei der Aufnahme, /1002 jetzt sind derselbe Request.
    assert.equal(requestName({ method: 'get', url: 'https://x.example/api/vorgang/1002/teile/3f2b8c1e-1a2b-4c3d-9e8f-001122334455?x=1' }), 'GET /api/vorgang/:id/teile/:id');
    assert.equal(requestName({ method: 'get', url: 'https://x.example/api/bestellung/CAW-20261107120000' }), 'GET /api/bestellung/:id');
    assert.equal(neutralName('GET /api/vorgang/1001 connector=x'), 'GET /api/vorgang/:id connector=x');
    const ids = diagnose({ failed: failed(), requests: [{ name: 'GET /api/vorgang/:id', outcome: 'ok', status: 200, ms: 50 }], baseline: [{ name: 'GET /api/vorgang/1001', status: 200, ms: 40 }] });
    assert.doesNotMatch(ids.findings.join(), /kam bei der Aufnahme/);
    // Ein fehlendes Lesen ist nur ein Hinweis, ein fehlendes Schreiben ein Befund.
    const cached = diagnose({ failed: failed(), requests: [], baseline: [{ name: 'GET /api/token', status: 200, ms: 40 }] });
    assert.equal(cached.side, 'unclear');
    const unsent = diagnose({ failed: failed(), requests: [], baseline: [{ name: 'POST /api/bestellung', status: 201, ms: 40 }] });
    assert.deepEqual([unsent.side, unsent.strength], ['app', 'likely']);

    // Long-Polling: auch bei der Aufnahme lange offen, also kein Befund.
    const poll = diagnose({ failed: failed(), requests: [{ name: 'GET /api/events', outcome: 'open', ms: 25_000 }], baseline: [{ name: 'GET /api/events', status: 200, ms: 29_000 }] });
    assert.equal(poll.side, 'unclear');
    // Ohne Aufnahme haengt der Dienst: Umgebung.
    const hang = diagnose({ failed: failed(), requests: [{ name: 'GET /api/liste', outcome: 'open', ms: 30_000 }] });
    assert.equal(hang.side, 'environment');
    // Sehr langsam ohne Vergleich: Umgebung, nicht der Test.
    const cold = diagnose({ failed: failed(), broken: { kind: 'target' }, requests: [{ name: 'GET /api/liste', outcome: 'ok', status: 200, ms: 28_000 }] });
    assert.equal(cold.side, 'environment');

    // Ein 404 wie bei der Aufnahme ist gewollt; ein 403, wo die Aufnahme 200 hatte, eher eine geaenderte Rechtepruefung.
    const optional = diagnose({ failed: failed(), requests: [{ name: 'GET /api/einstellung', outcome: 'http', status: 404, ms: 20 }], baseline: [{ name: 'GET /api/einstellung', status: 404, ms: 20 }] });
    assert.equal(optional.side, 'unclear');
    const denied = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 403, ms: 20 }], baseline: [{ name: FEES, status: 200, ms: 20 }] });
    assert.deepEqual([denied.side, denied.strength], ['app', 'likely']);

    // Ein harter 5xx einer anderen Adresse mit gleichem Status zaehlt trotzdem.
    const other = diagnose({ failed: failed(), requests: [{ name: 'GET /api/a', outcome: 'http', status: 500, ms: 40 }], failures: [{ type: 'http', text: 'HTTP 500', url: 'https://x.example/api/b' }] });
    assert.equal(other.findings.length, 2);

    // Nur die Bedienelemente anders, sonst alles wie gewohnt: unklar, nicht eindeutig die Anwendung.
    const relabel = diagnose({ failed: failed(), deviation: { step: 'S5', number: 1, label: 'click', lists: ['controls'], missing: ['button "Speichern"'], extra: [], instead: ['button "Sichern"'], learned: true, fails: true } });
    assert.equal(relabel.side, 'unclear');
    assert.match(relabel.findings[0], /absichtlich geändert/);
});

test('Warten auf Ruhe: Ein Stream (SSE, NDJSON) hält nicht auf, ein normaler offener Request schon', async () => {
    const { STREAM_TYPE } = await import('../src/host/browser-session.mjs');
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.started('a', { name: 'GET /api/akten', page: 'p' });
    log.started('s', { name: 'GET /api/progress', page: 'p' });
    assert.equal(log.pending('p'), 2);
    log.answered('s', 200, true);
    assert.equal(log.pending('p'), 1, 'der Stream zählt nicht mehr');
    log.finished('a', 200);
    assert.equal(log.pending('p'), 0);
    // Kopfzeilen da, Ende nie gemeldet (Vite-Proxy bei 401): kurz noch offen, dann nicht mehr, mit bekanntem Status.
    log.started('u', { name: 'GET /api/me', page: 'p' });
    log.answered('u', 401);
    clock = 1_000;
    assert.equal(log.pending('p'), 1, 'der Inhalt hat noch Zeit');
    clock = 1_600;
    assert.equal(log.pending('p'), 0, 'danach haelt er das Warten nicht mehr auf');
    assert.equal(outcomeText({ outcome: 'open', status: 401 }), 'HTTP 401');
    log.answered('gibtsnicht', 200);
    for (const type of ['text/event-stream; charset=utf-8', 'application/x-ndjson', 'application/stream+json', 'application/jsonl']) assert.ok(STREAM_TYPE.test(type), type);
    for (const type of ['application/json', 'text/html', 'text/plain']) assert.ok(!STREAM_TYPE.test(type), type);
});

test('Einschätzung: Scheitert ein Schritt nur an der Wirkung, ist die Anwendung nur wahrscheinlich, der Datenstand wird genannt', () => {
    const reason = 'Die Prüfung ist erfüllt, aber die Anwendung reagiert anders als in gesunden Läufen. Aktion 1 click: neu ist heading "Assistent".';
    const deviation = { step: 'S2', number: 1, label: 'click', lists: ['controls', 'requests'], missing: [], extra: ['heading "Assistent"'], instead: [], learned: true, fails: true };
    const effectOnly = diagnose({ failed: { id: 'S2', reason }, deviation });
    assert.deepEqual([effectOnly.side, effectOnly.strength], ['app', 'likely']);
    assert.match(effectOnly.findings[0], /anderer Datenstand als beim Lernen/);

    // Scheitert die Pruefung selbst, bleibt es eindeutig und ohne den Hinweis.
    const broken = diagnose({ failed: { id: 'S2', reason: 'Text fehlt.' }, deviation });
    assert.deepEqual([broken.side, broken.strength], ['app', 'clear']);
    assert.doesNotMatch(broken.findings.join(' '), /Datenstand/);
});

test('Ziel fehlt: ähnlich benannte Elemente derselben Rolle werden genannt, unähnliche nicht', async () => {
    const { closestNames, explainText } = await import('../src/host/framework/index.mjs');
    assert.deepEqual(closestNames('Speichern', ['Sichern', 'Abbrechen', 'Hilfe']), ['Sichern']);
    assert.deepEqual(closestNames('Akte anlegen', ['Leere Akte anlegen', 'Akte verbinden', 'Start']), ['Leere Akte anlegen', 'Akte verbinden']);
    assert.deepEqual(closestNames('Prüfung abschließen', ['Ablehnen', 'Hilfe']), []);
    assert.deepEqual(closestNames('Weiter', ['Weiter']), [], 'derselbe Name ist kein Hinweis');
    assert.deepEqual(closestNames(undefined, ['Weiter']), []);
    assert.equal(explainText({ missing: true, similar: [{ role: 'button', name: 'Sichern' }] }), ' Es fehlt auf der Seite. Ähnlich: button „Sichern“. Wurde es umbenannt?');
    assert.equal(explainText({ missing: true }), ' Es fehlt auf der Seite.');
});

test('Einordnung: Konsolenfehler mit aufgeloester Quelle (Angulars ErrorHandler) ist ein klarer Fehler der Anwendung', () => {
    const found = diagnose({ failed: failed(), failures: [{ type: 'console', text: 'ERROR Error: Absichtlich\n    at explode (https://a.example/main.js:1:2)', at: 'src/app/explode.ts:2:9' }] });
    assert.deepEqual(Object.values(found).slice(0, 2), ['app', 'clear']);
    assert.match(JSON.stringify(found), /explode\.ts:2:9/);
    assert.doesNotMatch(JSON.stringify(found), /main\.js:1:2/, 'nur die erste Zeile der Meldung');
});
