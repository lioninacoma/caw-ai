import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diagnose, paramChange } from '../src/host/diagnose.mjs';
import { createNetworkLog, neutralName, outcomeText, parameterNames, requestName, summarizeRequests } from '../src/host/network-log.mjs';
import { missingBaselines, withBaselines } from '../src/host/replay.mjs';
import { parseTest, renderTest, stepHash } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

const FEES = 'POST /o/proxy connector=HTTP-X-Preise';
const failed = (reason = 'S5: Prüfung nicht erfüllt.') => ({ id: 'S5', reason });

test('diagnosis: an abort after 2 ms without navigation, 850 ms at recording time, is a clear app failure', () => {
    const result = diagnose({
        failed: failed(),
        requests: [{ name: FEES, outcome: 'aborted', navigated: false, ms: 2 }],
        baseline: [{ name: FEES, status: 200, ms: 850 }],
    });
    assert.deepEqual([result.side, result.strength], ['app', 'clear']);
    assert.equal(result.text, 'Einschätzung: Fehler der Anwendung (eindeutig).');
    assert.match(result.findings[0], /nach 2 ms abgebrochen, ohne Seitenwechsel, bei der Aufnahme 200 in 850 ms/);
});

test('diagnosis: an abort caused by navigation is no evidence', () => {
    const result = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'aborted', navigated: true, ms: 2 }] });
    assert.equal(result.side, 'unclear');
    assert.match(result.findings[0], /Ohne Vergleich aus der Aufnahme/);
});

test('diagnosis: 5xx and script errors are clear, 4xx and console likely', () => {
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 40 }] })).slice(0, 2), ['app', 'clear']);
    // Gateway or slow 5xx: the service behind it is down or still starting.
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 504, ms: 60_000 }], baseline: [{ name: FEES, status: 200, ms: 300 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 503, ms: 40 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 9000 }] })).slice(0, 2), ['environment', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 404, ms: 40 }] })).slice(0, 2), ['app', 'likely']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), failures: [{ type: 'pageerror', text: 'x is undefined' }] })).slice(0, 2), ['app', 'clear']);
    assert.deepEqual(Object.values(diagnose({ failed: failed(), failures: [{ type: 'console', text: 'Error' }] })).slice(0, 2), ['app', 'likely']);
    // An HTTP failure already shown by one of the step's requests does not count twice.
    const twice = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 40 }], failures: [{ type: 'http', text: 'HTTP 500', url: 'https://x/o/proxy' }] });
    assert.equal(twice.findings.length, 1);
});

test('diagnosis: much slower than at recording time, or a network error, points to the environment', () => {
    const slow = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'ok', status: 200, ms: 21_000 }], baseline: [{ name: FEES, status: 200, ms: 900 }] });
    assert.deepEqual([slow.side, slow.strength], ['environment', 'likely']);
    assert.match(slow.findings[0], /brauchte 21,0 s, bei der Aufnahme 200 in 900 ms/);
    const late = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'aborted', navigated: false, ms: 30_000 }], baseline: [{ name: FEES, status: 200, ms: 900 }] });
    assert.equal(late.side, 'environment');
    const net = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'failed', error: 'net::ERR_CONNECTION_RESET', ms: 5 }] });
    assert.deepEqual([net.side, net.findings[0]], ['environment', `${FEES} ist fehlgeschlagen (net::ERR_CONNECTION_RESET).`]);
    const login = diagnose({ failed: failed('S5: Die Anmeldung ist verloren gegangen.') });
    assert.deepEqual([login.side, login.strength], ['environment', 'clear']);
    // Normal speed, as at recording time: no finding.
    assert.equal(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'ok', status: 200, ms: 1200 }], baseline: [{ name: FEES, status: 200, ms: 900 }] }).side, 'unclear');
});

test('diagnosis: a recorded request only counts as missing if the actions ran', () => {
    const baseline = [{ name: FEES, status: 200, ms: 900 }];
    assert.equal(diagnose({ failed: failed(), broken: null, baseline }).side, 'app');
    // Break mid-step: the later actions never ran, so their absence says nothing.
    assert.equal(diagnose({ failed: failed(), broken: { kind: 'state' }, baseline }).side, 'unclear');
    const target = diagnose({ failed: failed(), broken: { kind: 'target' }, baseline });
    assert.deepEqual([target.side, target.strength], ['test', 'likely']);
    assert.match(target.findings[0], /wie bei der Aufnahme/);
});

test('diagnosis: superseded search, sign-in, 401 and hanging requests', () => {
    const typing = [{ name: FEES, outcome: 'aborted', ms: 20 }, { name: FEES, outcome: 'aborted', ms: 25 }, { name: FEES, outcome: 'ok', status: 200, ms: 300 }];
    assert.notEqual(diagnose({ failed: failed(), requests: typing }).side, 'app', 'aborts while typing, then an answer: normal');
    const lost = diagnose({ failed: failed('Die Anmeldung ist verloren.'), requests: [{ name: FEES, outcome: 'http', status: 500, ms: 50 }] });
    assert.deepEqual([lost.side, lost.strength], ['environment', 'clear'], 'the sign-in explains the 500');
    assert.equal(diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 401, ms: 50 }] }).side, 'environment');
    const hanging = diagnose({ failed: failed(), broken: { kind: 'target' }, requests: [{ name: FEES, outcome: 'open', ms: 30_000, params: ['query'] }], baseline: [{ name: FEES, status: 200, ms: 900, params: [] }] });
    assert.equal(hanging.side, 'environment', 'open is not a changed call');
});

test('diagnosis: a missing target on a healthy page means the test is probably stale; the strongest finding wins', () => {
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

test('requests: the name holds method, path and only the values of the named parameters', () => {
    const url = 'https://portal.example/o/proxy?connector=HTTP-X-Save&orderId=4711&token=secret';
    assert.equal(requestName({ method: 'post', url }, ['Connector']), 'POST /o/proxy connector=HTTP-X-Save');
    assert.equal(requestName({ method: 'GET', url }), 'GET /o/proxy');
    assert.equal(requestName({ method: 'GET', url: 'broken' }), 'GET ?');
    // Short random ids (nanoid) with digits, upper and lower case letters; API names stay.
    assert.equal(requestName({ method: 'GET', url: 'http://localhost:5173/api/me/groups/7/drafts/j46FjCJIrJQ4V0gp' }), 'GET /api/me/groups/:id/drafts/:id');
    assert.equal(requestName({ method: 'GET', url: 'http://localhost/api/oauth2Login/review-queue/v2' }), 'GET /api/oauth2Login/review-queue/v2');
});

test('requests: parameter names without values from query and form, excluding the naming ones', () => {
    const url = 'https://portal.example/o/proxy?connector=HTTP-X&orderUUID=4711&time=1';
    assert.deepEqual(parameterNames({ url }, ['Connector']), ['orderUUID', 'time']);
    assert.deepEqual(parameterNames({ url, postData: 'b=secret&a=1&time=2', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' }, ['connector']), ['a', 'b', 'orderUUID', 'time']);
    assert.deepEqual(parameterNames({ url: 'https://p/x', postData: '{"a":1}', contentType: 'application/json' }), ['json.a']);
    assert.deepEqual(parameterNames({ url: 'https://p/x', postData: '[{"b":1,"a":2}]', contentType: 'application/json; charset=utf-8' }), ['json.a', 'json.b']);
    // Older recordings without JSON keys: new keys are not a change.
    assert.equal(paramChange(['json.name', 'q'], ['q']), null);
    assert.match(paramChange(['json.title', 'q'], ['json.name', 'q']), /fehlt jetzt json.name, neu json.title/);
    assert.deepEqual(parameterNames({ url: 'broken', postData: 'a=1', contentType: 'application/x-www-form-urlencoded' }), ['a']);
    const log = createNetworkLog({ now: () => 0 });
    log.started('k', { name: 'GET /k', page: 1, params: ['a'] });
    log.started('l', { name: 'GET /l', page: 1, params: [] });
    log.finished('k', 200);
    log.finished('l', 200);
    assert.deepEqual(summarizeRequests(log.since()), [{ name: 'GET /k', status: 200, ms: 0, params: ['a'] }, { name: 'GET /l', status: 200, ms: 0, params: [] }]);
});

test('diagnosis: parameter names differing from the recording prove a changed call', () => {
    const name = 'GET /o/proxy connector=HTTP-X-LoadOrder';
    const failedStep = { id: 'S5', reason: 'Prüfung nicht erfüllt' };
    const baseline = [{ name, status: 200, ms: 900, params: ['generalOrderUUID'] }];
    const result = diagnose({ failed: failedStep, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['orderUUID'] }], baseline });
    assert.deepEqual([result.side, result.strength], ['app', 'clear']);
    assert.match(result.findings[0], /fehlt jetzt generalOrderUUID, neu orderUUID/);
    const same = diagnose({ failed: failedStep, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['generalOrderUUID'] }], baseline });
    assert.ok(same.findings.every((text) => !/andere Parameter/.test(text)));
    const older = diagnose({ failed: failedStep, requests: [{ name, outcome: 'http', status: 500, ms: 300, params: ['x'] }], baseline: [{ name, status: 200, ms: 900 }] });
    assert.ok(older.findings.every((text) => !/andere Parameter/.test(text)));
    // An answered request with different parameters is no finding: some APIs vary them.
    const answered = diagnose({ failed: failedStep, requests: [{ name, outcome: 'ok', status: 200, ms: 300, params: ['x'] }], baseline });
    assert.ok(answered.findings.every((text) => !/andere Parameter/.test(text)));
    assert.deepEqual(summarizeRequests([{ name, outcome: 'ok', status: 200, ms: 1, params: ['b'] }, { name, outcome: 'ok', status: 200, ms: 1, params: ['a'] }])[0].params, ['a', 'b']);
    assert.equal(paramChange(['a'], ['a']), null);
    assert.equal(paramChange(['a', 'c'], ['a', 'b']), 'fehlt jetzt b, neu c');
});

test('requests: log with outcome and duration, aborts by navigation are marked', () => {
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
    log.failed('missing', 'whatever');
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

test('requests: the new document ends what the old one left open; what it starts itself stays', () => {
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.replaced(1);
    log.started('old', { name: 'GET /old', page: 1 });
    log.started('other', { name: 'GET /other', page: 2 });
    clock = 10;
    log.navigating(1);
    clock = 20;
    log.started('new', { name: 'GET /new', page: 1 });
    clock = 30;
    log.replaced(1);
    // A late browser event for an already finished request changes nothing.
    log.failed('old', 'net::ERR_ABORTED');
    assert.deepEqual(log.since(), [
        { name: 'GET /old', outcome: 'aborted', navigated: true, ms: 30 },
        { name: 'GET /other', outcome: 'open', ms: 30 },
        { name: 'GET /new', outcome: 'open', ms: 10 },
    ]);
});

test('requests: the summary merges, takes the longest duration and drops navigation aborts', () => {
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

test('baselines: only passed steps without a baseline, recorded on the same target', () => {
    const stepWith = (id, recording) => ({ id, name: id, do: '', expect: 'x', ...(recording === undefined ? {} : { recording: { hash: 'h', recordedOn: 'a/dev', actions: [], check: 'c', ...recording } }) });
    const spec = { steps: [
        stepWith('S1', {}), stepWith('S2', { network: [{ name: FEES, status: 200, ms: 850, params: [] }] }), stepWith('S3', { recordedOn: 'a/test' }), stepWith('S4', {}), stepWith('S5'), stepWith('S6', {}),
        // Baselines from before parameter names existed are replaced.
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

test('test file: recording.network is read and written, the hash stays', () => {
    const step = { id: 'S1', name: 'Load', do: 'Load it', expect: 'There' };
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

test('requests: a route change in the same document explains an abort, even if the router sets the URL shortly after', () => {
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.started('before', { name: 'GET /list', page: 1 });
    log.started('late', { name: 'GET /details', page: 1 });
    log.started('without', { name: 'GET /prices', page: 2 });
    clock = 10;
    log.failed('before', 'net::ERR_ABORTED');
    log.failed('without', 'net::ERR_ABORTED');
    clock = 300;
    log.routed(1);
    clock = 2000;
    log.failed('late', 'net::ERR_ABORTED');
    const seen = log.since();
    assert.deepEqual(seen[0], { name: 'GET /list', outcome: 'aborted', navigated: true, routed: true, ms: 10 });
    assert.deepEqual(seen[1], { name: 'GET /details', outcome: 'aborted', navigated: false, ms: 2000 }, 'abort long after the route change: its own');
    assert.deepEqual(seen[2], { name: 'GET /prices', outcome: 'aborted', navigated: false, ms: 10 }, 'other page without a route change');
    assert.deepEqual(summarizeRequests(seen).map(({ name }) => name), ['GET /details', 'GET /prices']);
});

test('diagnosis: target under a dialog reporting a rejection, after a 409 in the previous step: test data, not the app', () => {
    const broken = { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Akte anlegen', messages: ['Diesen Namen trägt schon eine Akte.'] } } };
    const earlier = { id: 'S2', requests: [{ name: 'POST /api/groups', outcome: 'http', status: 409, ms: 30 }] };
    const result = diagnose({ failed: { id: 'S3', reason: 'link "Einstellungen" war nach 8 s nicht klickbar.' }, broken, earlier });
    assert.equal(result.side, 'test');
    assert.match(result.findings[0], /verdeckt von dialog „Akte anlegen“\. Er meldet: „Diesen Namen trägt schon eine Akte\.“ Im Schritt davor \(S2\) lehnte der Dienst POST \/api\/groups mit HTTP 409 ab\./);
    assert.doesNotMatch(result.findings.join(' '), /fehlt auf der Seite/);
    // A 400 without a message about data: rather a wrong call by the app. Another message: unclear.
    const badCall = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Fehler' } } }, requests: [{ name: 'POST /api/groups', outcome: 'http', status: 400, ms: 30 }] });
    assert.equal(badCall.side, 'app');
    const npe = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target', blocker: { covered: { role: 'dialog', name: 'Fehler', messages: ['NullPointerException'] } } } });
    assert.equal(npe.side, 'unclear');
    // The same 409 in the step itself: test data, not counted again as the app.
    const here = diagnose({ failed: { id: 'S3', reason: 'x' }, broken, requests: [{ name: 'POST /api/groups', outcome: 'http', status: 409, ms: 30 }] });
    assert.equal(here.side, 'test');
    const plain = diagnose({ failed: { id: 'S3', reason: 'x' }, broken: { kind: 'target' }, earlier });
    assert.equal(plain.side, 'app', 'without a dialog, a 4xx before stays a hint at the app');
});

test('diagnosis: superseded aborts, ids in the path, persistent connections, intended 4xx', () => {
    const SEARCH = 'GET /api/search';
    // A search while typing: the earlier call is aborted, the new one is still open. Normal.
    const typed = diagnose({ failed: failed(), requests: [{ name: SEARCH, outcome: 'aborted', navigated: false, ms: 20 }, { name: SEARCH, outcome: 'open', ms: 100 }], baseline: [{ name: SEARCH, status: 200, ms: 300 }] });
    assert.equal(typed.side, 'unclear');
    // Without a baseline an abort is only a note, e.g. when a view closes.
    const unmount = diagnose({ failed: failed(), requests: [{ name: 'GET /api/preview', outcome: 'aborted', navigated: false, ms: 120 }] });
    assert.equal(unmount.side, 'unclear');
    assert.match(unmount.findings.join(), /abgebrochen, ohne Seitenwechsel/);

    // Ids in the path: /1001 at recording time and /1002 now are the same request.
    assert.equal(requestName({ method: 'get', url: 'https://x.example/api/case/1002/parts/3f2b8c1e-1a2b-4c3d-9e8f-001122334455?x=1' }), 'GET /api/case/:id/parts/:id');
    assert.equal(requestName({ method: 'get', url: 'https://x.example/api/order/CAW-20261107120000' }), 'GET /api/order/:id');
    assert.equal(neutralName('GET /api/case/1001 connector=x'), 'GET /api/case/:id connector=x');
    const ids = diagnose({ failed: failed(), requests: [{ name: 'GET /api/case/:id', outcome: 'ok', status: 200, ms: 50 }], baseline: [{ name: 'GET /api/case/1001', status: 200, ms: 40 }] });
    assert.doesNotMatch(ids.findings.join(), /kam bei der Aufnahme/);
    // A missing read is only a note, a missing write a finding.
    const cached = diagnose({ failed: failed(), requests: [], baseline: [{ name: 'GET /api/token', status: 200, ms: 40 }] });
    assert.equal(cached.side, 'unclear');
    const unsent = diagnose({ failed: failed(), requests: [], baseline: [{ name: 'POST /api/order', status: 201, ms: 40 }] });
    assert.deepEqual([unsent.side, unsent.strength], ['app', 'likely']);

    // Long polling: also open for long at recording time, so no finding.
    const poll = diagnose({ failed: failed(), requests: [{ name: 'GET /api/events', outcome: 'open', ms: 25_000 }], baseline: [{ name: 'GET /api/events', status: 200, ms: 29_000 }] });
    assert.equal(poll.side, 'unclear');
    // Without a recording the service hangs: environment.
    const hang = diagnose({ failed: failed(), requests: [{ name: 'GET /api/list', outcome: 'open', ms: 30_000 }] });
    assert.equal(hang.side, 'environment');
    // Very slow without a baseline: environment, not the test.
    const cold = diagnose({ failed: failed(), broken: { kind: 'target' }, requests: [{ name: 'GET /api/list', outcome: 'ok', status: 200, ms: 28_000 }] });
    assert.equal(cold.side, 'environment');

    // A 404 as at recording time is intended; a 403 where the recording had 200 is rather a changed permission check.
    const optional = diagnose({ failed: failed(), requests: [{ name: 'GET /api/setting', outcome: 'http', status: 404, ms: 20 }], baseline: [{ name: 'GET /api/setting', status: 404, ms: 20 }] });
    assert.equal(optional.side, 'unclear');
    const denied = diagnose({ failed: failed(), requests: [{ name: FEES, outcome: 'http', status: 403, ms: 20 }], baseline: [{ name: FEES, status: 200, ms: 20 }] });
    assert.deepEqual([denied.side, denied.strength], ['app', 'likely']);

    // A hard 5xx from another URL with the same status still counts.
    const other = diagnose({ failed: failed(), requests: [{ name: 'GET /api/a', outcome: 'http', status: 500, ms: 40 }], failures: [{ type: 'http', text: 'HTTP 500', url: 'https://x.example/api/b' }] });
    assert.equal(other.findings.length, 2);

    // Only the controls differ, everything else as usual: unclear, not clearly the app.
    const relabel = diagnose({ failed: failed(), deviation: { step: 'S5', number: 1, label: 'click', lists: ['controls'], missing: ['button "Speichern"'], extra: [], instead: ['button "Sichern"'], learned: true, fails: true } });
    assert.equal(relabel.side, 'unclear');
    assert.match(relabel.findings[0], /absichtlich geändert/);
});

test('waiting for idle: a stream (SSE, NDJSON) does not hold it up, a normal open request does', async () => {
    const { STREAM_TYPE } = await import('../src/host/browser-session.mjs');
    let clock = 0;
    const log = createNetworkLog({ now: () => clock });
    log.started('a', { name: 'GET /api/files', page: 'p' });
    log.started('s', { name: 'GET /api/progress', page: 'p' });
    assert.equal(log.pending('p'), 2);
    log.answered('s', 200, true);
    assert.equal(log.pending('p'), 1, 'the stream no longer counts');
    log.finished('a', 200);
    assert.equal(log.pending('p'), 0);
    // Headers arrived, end never reported (Vite proxy on 401): open for a short while, then no longer, with known status.
    log.started('u', { name: 'GET /api/me', page: 'p' });
    log.answered('u', 401);
    clock = 1_000;
    assert.equal(log.pending('p'), 1, 'the body still has time');
    clock = 1_600;
    assert.equal(log.pending('p'), 0, 'after that it no longer holds up waiting');
    assert.equal(outcomeText({ outcome: 'open', status: 401 }), 'HTTP 401');
    log.answered('unknown', 200);
    for (const type of ['text/event-stream; charset=utf-8', 'application/x-ndjson', 'application/stream+json', 'application/jsonl']) assert.ok(STREAM_TYPE.test(type), type);
    for (const type of ['application/json', 'text/html', 'text/plain']) assert.ok(!STREAM_TYPE.test(type), type);
});

test('diagnosis: a step failing only on its effect is likely the app, and the data state is mentioned', () => {
    const reason = 'Die Prüfung ist erfüllt, aber die Anwendung reagiert anders als in gesunden Läufen. Aktion 1 click: neu ist heading "Assistent".';
    const deviation = { step: 'S2', number: 1, label: 'click', lists: ['controls', 'requests'], missing: [], extra: ['heading "Assistent"'], instead: [], learned: true, fails: true };
    const effectOnly = diagnose({ failed: { id: 'S2', reason }, deviation });
    assert.deepEqual([effectOnly.side, effectOnly.strength], ['app', 'likely']);
    assert.match(effectOnly.findings[0], /anderer Datenstand als beim Lernen/);

    // If the check itself fails, it stays clear and without the hint.
    const broken = diagnose({ failed: { id: 'S2', reason: 'Text fehlt.' }, deviation });
    assert.deepEqual([broken.side, broken.strength], ['app', 'clear']);
    assert.doesNotMatch(broken.findings.join(' '), /Datenstand/);
});

test('missing target: similarly named elements of the same role are named, dissimilar ones are not', async () => {
    const { closestNames, explainText } = await import('../src/host/framework/index.mjs');
    assert.deepEqual(closestNames('Speichern', ['Sichern', 'Abbrechen', 'Hilfe']), ['Sichern']);
    assert.deepEqual(closestNames('Akte anlegen', ['Leere Akte anlegen', 'Akte verbinden', 'Start']), ['Leere Akte anlegen', 'Akte verbinden']);
    assert.deepEqual(closestNames('Prüfung abschließen', ['Ablehnen', 'Hilfe']), []);
    assert.deepEqual(closestNames('Weiter', ['Weiter']), [], 'the same name is no hint');
    assert.deepEqual(closestNames(undefined, ['Weiter']), []);
    assert.equal(explainText({ missing: true, similar: [{ role: 'button', name: 'Sichern' }] }), ' Es fehlt auf der Seite. Ähnlich: button „Sichern“. Wurde es umbenannt?');
    assert.equal(explainText({ missing: true }), ' Es fehlt auf der Seite.');
});

test('diagnosis: a console error with a resolved source (Angular ErrorHandler) is a clear app failure', () => {
    const found = diagnose({ failed: failed(), failures: [{ type: 'console', text: 'ERROR Error: On purpose\n    at explode (https://a.example/main.js:1:2)', at: 'src/app/explode.ts:2:9' }] });
    assert.deepEqual(Object.values(found).slice(0, 2), ['app', 'clear']);
    assert.match(JSON.stringify(found), /explode\.ts:2:9/);
    assert.doesNotMatch(JSON.stringify(found), /main\.js:1:2/, 'only the first line of the message');
});
