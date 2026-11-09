import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixFlow, recordFlow, runFlow } from '../src/host/flows.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { planView, samePlanStep } from '../src/host/test-plan.mjs';
import { CawError, EXIT } from '../src/shared/errors.mjs';

const stepOf = (id) => {
    const step = { id, name: id, do: '', expect: `${id} da` };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: 'z', actions: [{ action: 'reload' }], check: 'c' } };
};
const spec = { id: 't', steps: [stepOf('S1'), stepOf('S2')], expectations: [{ id: 'S1' }, { id: 'S2' }] };
const pass = { exitCode: EXIT.pass, verdict: { status: 'pass' } };
const failing = (id = 'S2', extra = {}) => ({ exitCode: EXIT.fail, verdict: { status: 'fail', reason: 'kaputt.' }, failed: { id, reason: 'weg.', suspect: false, ...extra } });
const nothing = { exitCode: EXIT.fail, verdict: { status: 'fail', reason: 'kaputt.' } };
const repaired = (extra = {}) => ({ ...pass, candidate: { ...spec, repaired: true }, fresh: [], ...extra });

/** Spielt die Ablaeufe ohne Browser durch: Jede Antwort kommt der Reihe nach, der Mensch waehlt der Reihe nach aus `answers`. */
const harness = ({ outcomes, answers = ['adopt'] }) => {
    const calls = [];
    const adopted = [];
    const questions = [];
    const progress = [];
    const queue = [...outcomes];
    const wishes = [...answers];
    const notices = [];
    const pick = (kind, text, options) => {
        const ids = options.map(({ id }) => id);
        questions.push({ kind, text, options: ids });
        // Eine Nachricht steht als { message } in den Antworten und geht nur an discuss.
        const wish = wishes.find((candidate) => (typeof candidate === 'object' ? kind === 'discussing' : ids.includes(candidate)));
        if (wish !== undefined) wishes.splice(wishes.indexOf(wish), 1);
        return wish ?? ids.at(-1);
    };
    const chat = {
        choose: async (kind, text, options) => pick(kind, text, options),
        discuss: async (text, options) => {
            const wish = pick('discussing', text, options);
            return typeof wish === 'object' ? wish : { choice: wish };
        },
        notice: (text) => notices.push(text),
        progress: (text) => progress.push(text),
    };
    return {
        calls,
        adopted,
        questions,
        progress,
        notices,
        // `concluded` in einem Ergebnis geht nur an conclude, etwa talk oder repairHere.
        execute: async ({ conclude, ...call }) => {
            calls.push(call);
            const { concluded = {}, ...outcome } = queue.shift();
            await conclude?.({ ...outcome, ...concluded, chat });
            return outcome;
        },
        adopt: (draft, only) => {
            adopted.push({ draft, only });
            return 'caw/tests/t.yaml';
        },
        log: () => {},
    };
};

test('Aufnahme: Bestanden und übernommen schreibt den ganzen Plan', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.equal(h.calls[0].sandbox, 's');
    assert.equal(h.calls[1].spec, spec);
    assert.ok(h.calls[1].replay.steps.length > 0);
    assert.deepEqual(h.adopted, [{ draft: spec, only: undefined }]);
    assert.deepEqual(h.questions.map(({ kind, options }) => [kind, options]), [['deciding', ['adopt', 'discard']]]);
});

test('Aufnahme: Verwerfen lässt alles, wie es ist', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass], answers: ['discard'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.adopted, []);
});

test('Aufnahme: Fenster zu bei der Entscheidung heisst nicht übernehmen', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, pass] });
    const execute = async ({ conclude, ...call }) => {
        const next = await h.execute(call);
        await conclude?.({ ...next, chat: { choose: async () => null } });
        return next;
    };
    assert.equal(await recordFlow({ sandbox: 's', ...h, execute }), EXIT.pass);
    assert.deepEqual(h.adopted, []);
});

test('Aufnahme: Claude liefert nichts, Grund steht im Chat, kein Prüfdurchlauf', async () => {
    const h = harness({ outcomes: [nothing] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.equal(h.calls.length, 1);
    assert.match(h.questions[0].text, /kaputt/);
    assert.doesNotMatch(h.questions[0].text, /\.\./);
    assert.deepEqual(h.questions[0].options, ['close']);
});

test('Aufnahme: Scheitert der Prüfdurchlauf, wird genau der Schritt angeboten, auch auf dem Entwurf', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.pass);
    assert.match(h.questions[0].text, /^S2 ist gescheitert: weg\. Beheben beginnt in einem frischen Browser mit den Schritten davor\.$/);
    assert.deepEqual(h.questions[0].options, ['fix', 'close']);
    assert.equal(h.questions[0].kind, 'discussing');
    assert.deepEqual(h.calls[2].repair, { id: 'S2', reason: 'weg.' });
    assert.equal(h.calls[2].spec, spec, 'Repariert wird der Entwurf');
    assert.equal(h.adopted[0].only, undefined, 'Ein Entwurf wird als Ganzes übernommen');
    assert.equal(h.adopted[0].draft.repaired, true);
});

test('Aufnahme: Derselbe Fehler nach dem Beheben wird benannt, Beenden ist dann der Hauptweg', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2'), repaired(), failing('S2')], answers: ['fix', 'close'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.doesNotMatch(h.questions[0].text, /derselbe Fehler/);
    assert.match(h.questions[1].text, /derselbe Fehler wie nach dem letzten Beheben.*caw\.config\.json/);
    assert.deepEqual(h.questions[1].options, ['close', 'fix']);
    assert.deepEqual(h.adopted, []);
});

test('Aufnahme: Schliessen beim Angebot lässt den Testplan unverändert', async () => {
    const h = harness({ outcomes: [{ ...pass, candidate: spec }, failing('S2')], answers: ['close'] });
    assert.equal(await recordFlow({ sandbox: 's', ...h }), EXIT.fail);
    assert.deepEqual(h.adopted, []);
});

test('Beheben: Nur dieser Schritt wird geschrieben, im Prüfdurchlauf gescheitert wird der andere angeboten', async () => {
    const h = harness({ outcomes: [repaired(), failing('S1'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    assert.deepEqual(h.calls.filter(({ repair }) => repair).map(({ repair }) => repair.id), ['S2', 'S1']);
    assert.deepEqual([...h.adopted[0].only], ['S2', 'S1']);
    assert.match(h.calls[1].note, /S2 wurde behoben, Anlass: Grund/);
});

test('Beheben: Scheitert ein Schritt davor, wird der angeboten', async () => {
    const h = harness({ outcomes: [failing('S1'), repaired(), pass], answers: ['fix', 'adopt'] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    assert.equal(h.calls[1].repair.id, 'S1');
    assert.deepEqual([...h.adopted[0].only], ['S1']);
});

test('Beheben: Claude schafft es nicht, der Testplan bleibt', async () => {
    const h = harness({ outcomes: [nothing] });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.fail);
    assert.match(h.questions[0].text, /Für S2 ist keine neue Aufzeichnung entstanden/);
    assert.deepEqual(h.adopted, []);
});

test('Beheben: Entscheidung nennt geändertes Ergebnis, neue Meldungen und was noch veraltet ist', async () => {
    const stale = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], do: 'von Hand' }] };
    const h = harness({
        outcomes: [{ ...pass, candidate: stale, fresh: ['Sicher?'], expectChange: { id: 'S1', before: 'alt', after: 'neu' } }, pass],
    });
    assert.equal(await fixFlow({ draft: spec, target: { id: 'S1', reason: 'Grund' }, sandbox: 's', ...h }), EXIT.pass);
    const { text } = h.questions[0];
    assert.match(text, /Neu als bekannte Meldung, das Abspielen meldet sie nicht mehr: Sicher\?/);
    assert.match(text, /Geändertes Ergebnis in S1: „neu“ statt „alt“/);
    assert.match(text, /Noch veraltet und nicht geprüft: S2/);
    assert.equal(h.calls[1].replay.until, 'S1');
    assert.match(h.calls[1].note, /Erwartet vorher: alt/);
});

test('Testlauf: Bestanden meldet der offene Chat nur, ohne Docker, ohne Warten, und das Fenster geht wie gewünscht', async () => {
    const h = harness({ outcomes: [{ ...pass, verdict: { status: 'pass', warnings: [{ text: 't.getKey.', origin: 'x.js' }] } }] });
    const openSandbox = async () => assert.fail('Claude wird nicht gebraucht');
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox, ...h }), EXIT.pass);
    assert.deepEqual(h.questions, []);
    assert.deepEqual(h.notices, ['Der Lauf hat bestanden. Warnungen: t.getKey (x.js).']);
    assert.equal(h.calls[0].testing, true);
    assert.equal(h.calls[0].handover(), true);
    assert.equal(h.calls[0].replay.until, undefined);
});

test('Testlauf: Ein grüner Lauf trägt fehlende Vergleichswerte ein, ohne Claude; ohne Chat bleibt die Datei', async () => {
    const network = [{ name: 'GET /a', status: 200, ms: 40 }];
    const baselines = new Map([['S1', network]]);
    const h = harness({ outcomes: [{ ...pass, baselines }] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, fillBaselines: true, openSandbox: async () => assert.fail('kein Claude'), ...h }), EXIT.pass);
    assert.match(h.notices[0], /^Der Lauf hat bestanden\. Vergleichswerte für S1 aufgezeichnet/);
    assert.equal(h.adopted.length, 1);
    assert.deepEqual([...h.adopted[0].only], ['S1']);
    assert.deepEqual(h.adopted[0].draft.steps[0].recording.network, network);
    assert.equal(h.adopted[0].draft.steps[0].recording.hash, spec.steps[0].recording.hash);
    assert.equal(h.adopted[0].draft.steps[1].recording.network, undefined);

    const quiet = harness({ outcomes: [{ ...pass, baselines }] });
    await runFlow({ spec, handover: false, canFix: false, openSandbox: async () => 's', ...quiet });
    assert.deepEqual(quiet.adopted, []);
});

test('Neu aufnehmen: Ein nicht gescheiterter Schritt heisst so auf der Karte, im Auftrag und im Prüfdurchlauf', async () => {
    const h = harness({ outcomes: [repaired(), pass] });
    await fixFlow({ draft: spec, target: { id: 'S2', reason: 'Wunsch', rerecord: true }, sandbox: 's', ...h });
    assert.equal(h.calls[0].repair.rerecord, true);
    assert.match(h.calls[1].note, /^S2 wurde neu aufgenommen, Anlass: Wunsch\./);
    const step = { id: 'S2', name: 'N', do: 'D', expect: 'E', retry: { times: 3, waitMs: 1000 } };
    assert.equal(planView({ steps: [step] }, { repairing: true, rerecord: true }).title, 'S2 neu aufnehmen');
    assert.equal(planView({ steps: [step] }, { repairing: true }).title, 'S2 beheben');
    assert.equal(planView({ steps: [step] }).title, 'Ablaufplan');
    assert.equal(samePlanStep(step, { ...step, recording: { check: 'x' } }), true);
    assert.equal(samePlanStep(step, { ...step, expect: 'F' }), false);
    assert.equal(samePlanStep(step, { ...step, retry: { times: 2, waitMs: 1000 } }), false);
    assert.equal(samePlanStep({ ...step, note: '' }, step), true);
});

test('Testlauf: Nach einer Änderung an der Anwendung gibt es Erneut testen statt Schritt beheben', async () => {
    const advice = { spec, touched: [], stale: [], files: ['src/app.js'], notes: false };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => advice } }, pass], answers: ['rerun'] });
    const code = await runFlow({ spec, handover: true, canFix: true, advise: true, openSandbox: async () => 's', ...h });
    assert.equal(code, EXIT.pass);
    assert.equal(h.calls.length, 2, 'Ein zweiter Lauf mit der geänderten Anwendung');
    assert.equal(h.calls[0].handover(), false, 'Das Fenster geht erst nach dem neuen Lauf an den Menschen');
    assert.deepEqual(h.questions.map(({ options }) => options), [['rerun', 'close']], 'Kein Schritt beheben');
    assert.match(h.questions[0].text, /die Änderung an der Anwendung \(src\/app\.js\) ist übernommen/);

    // Nur die Config übernommen, die Änderung am Code abgelehnt: Dann sagt der Chat genau das.
    const onlyConfig = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => ({ ...advice, files: ['caw.config.json'] }) } }], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...onlyConfig });
    assert.match(onlyConfig.questions[0].text, /die Änderung an caw\.config\.json ist übernommen, die Anwendung ist unverändert/);
    assert.deepEqual(onlyConfig.notices, ['Geändert: caw.config.json. Committet wird nichts.']);

    const closed = harness({ outcomes: [{ ...failing('S2'), concluded: { flawed: true, advise: async () => advice } }], answers: ['close'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...closed }), EXIT.fail);
    assert.equal(closed.calls.length, 1);
});

test('Testlauf: Ohne --advise sucht Claude die Ursache auf Klick, bei einem Fehler der Anwendung als Hauptknopf', async () => {
    const advice = { spec, touched: [], stale: [], files: ['src/app.js'], notes: false };
    let advised = 0;
    const app = { side: 'app', text: 'Einschätzung: Fehler der Anwendung (eindeutig).', findings: ['HTTP 500.'] };
    const concluded = { flawed: true, advise: async () => { advised += 1; return advice; } };
    const h = harness({ outcomes: [{ ...failing('S2', { diagnosis: app }), concluded }, pass], answers: ['ask', 'rerun'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.pass);
    assert.equal(advised, 1, 'Claude erst nach dem Klick');
    assert.deepEqual(h.questions.map(({ options }) => options), [['ask', 'fix', 'close'], ['rerun', 'close']]);
    assert.equal(h.calls.length, 2);

    // Ohne Einschaetzung "Anwendung" bleibt Beheben vorn, Fragen geht trotzdem.
    const other = harness({ outcomes: [failing('S2')], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...other });
    assert.deepEqual(other.questions[0].options, ['fix', 'ask', 'close']);

    // Mit --advise hat Claude schon empfohlen: kein zweites Mal fragen.
    const fixed = harness({ outcomes: [{ ...failing('S2', { diagnosis: app }), concluded: { flawed: true, advise: async () => null } }], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, advise: true, openSandbox: async () => 's', ...fixed });
    assert.deepEqual(fixed.questions[0].options, ['fix', 'close']);
});

test('Testlauf: Bis zu einem Schritt', async () => {
    const h = harness({ outcomes: [pass] });
    await runFlow({ spec, until: 'S1', handover: true, canFix: true, openSandbox: async () => 's', ...h });
    assert.equal(h.calls[0].replay.until, 'S1');
    assert.deepEqual(h.calls[0].replay.steps.map(({ action }) => action), ['reload', 'check']);
});

test('Testlauf: Schritt gescheitert, ohne Klick startet nichts', async () => {
    const h = harness({ outcomes: [failing('S2')], answers: ['close'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.fail);
    assert.equal(opened, 0);
    assert.equal(h.calls.length, 1);
});

test('Testlauf: Klick auf Beheben öffnet erst dann die Sandbox und übergibt das Fenster nicht', async () => {
    const h = harness({ outcomes: [failing('S2'), repaired(), pass], answers: ['fix', 'adopt'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.pass);
    assert.equal(opened, 1);
    assert.equal(h.calls[1].sandbox, 's');
    assert.deepEqual(h.progress, ['Bereite die Sandbox vor']);
    assert.equal(h.calls[0].handover(), false);
});

test('Testlauf: Beheben und dann Verwerfen endet mit dem ursprünglichen Fehlschlag', async () => {
    const h = harness({ outcomes: [failing('S2'), repaired(), pass], answers: ['fix', 'discard'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.fail);
    assert.deepEqual(h.adopted, []);
});

test('Testlauf: Harter Fehler bekommt das Angebot mit Hinweis auf die Anwendung', async () => {
    const h = harness({ outcomes: [failing('S2', { suspect: true })], answers: ['close'] });
    await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h });
    assert.match(h.questions[0].text, /Fehler der Anwendung/);
    assert.deepEqual(h.questions[0].options, ['fix', 'ask', 'close']);
});

test('Testlauf: Ohne Docker oder Token bleibt der Fehlschlag, der Grund steht im Chat', async () => {
    const h = harness({ outcomes: [failing('S2')], answers: ['fix'] });
    const openSandbox = async () => { throw new CawError('token-missing', 'kein Token'); };
    assert.equal(await runFlow({ spec, handover: true, canFix: true, openSandbox, ...h }), EXIT.fail);
    assert.match(h.questions[1].text, /Beheben geht gerade nicht: kein Token/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].handover(), true, 'Ohne Beheben bekommt der Mensch sein Fenster');
});

test('Testlauf ohne Terminal oder auf höherer Stufe: Kein Angebot, kein Chat, nur der Hinweis', async () => {
    const h = harness({ outcomes: [failing('S2')] });
    const hints = [];
    assert.equal(await runFlow({ spec, handover: false, canFix: false, openSandbox: async () => assert.fail('nie'), hint: (failed) => hints.push(failed.id), ...h }), EXIT.fail);
    assert.equal(h.calls[0].testing, undefined);
    assert.deepEqual(h.questions, []);
    assert.deepEqual(hints, ['S2']);
});

test('Testlauf: Erst die Nachricht startet Claude, weitere gehen ins selbe Gespräch, Schliessen beendet es', async () => {
    const talked = [];
    const talk = ({ sandbox }, message) => {
        talked.push(['start', sandbox, message]);
        return { over: () => false, send: (text) => talked.push(['send', text]), end: async () => { talked.push(['end']); return null; } };
    };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { talk } }], answers: [{ message: 'Warum?' }, { message: 'Und jetzt?' }, 'close'] });
    let opened = 0;
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => { opened += 1; return 's'; }, ...h }), EXIT.fail);
    assert.deepEqual(talked, [['start', 's', 'Warum?'], ['send', 'Und jetzt?'], ['end']]);
    assert.equal(opened, 1);
    // Den Weg zu Claude zeigt der Knopf, Schreiben geht weiterhin.
    assert.doesNotMatch(h.questions[0].text, /Du kannst Claude auch erst fragen/);
    assert.deepEqual(h.questions[0].options, ['fix', 'ask', 'close']);
    assert.deepEqual(h.questions.map(({ kind }) => kind), ['discussing', 'discussing', 'discussing']);
    assert.equal(h.calls.length, 1);
});

test('Testlauf: Ein sauberer Schritt wird im selben Browser behoben, danach nur noch der Prüfdurchlauf', async () => {
    const asked = [];
    const repairHere = async (given) => { asked.push(given); return repaired(); };
    const h = harness({ outcomes: [{ ...failing('S2'), concluded: { repairHere } }, pass], answers: ['fix', 'adopt'] });
    assert.equal(await runFlow({ spec, handover: false, canFix: true, openSandbox: async () => 's', ...h }), EXIT.pass);
    assert.match(h.questions[0].text, /im selben Browser, ohne die Schritte davor/);
    assert.deepEqual(asked, [{ sandbox: 's', reason: 'weg.' }]);
    assert.equal(h.calls.length, 2, 'Kein zweiter Lauf mit Vorlauf');
    assert.equal(h.calls[1].repair, undefined);
    assert.match(h.calls[1].note, /S2 wurde behoben, Anlass: weg/);
    assert.deepEqual([...h.adopted[0].only], ['S2']);
});

test('Entwickeln im Zustand mit der Claude-Code-Session als Agent: Sie ist sofort da, nicht erst nach der ersten Frage', async () => {
    const h = harness({ outcomes: [pass] });
    let opened = 0;
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, sessionAgent: true, openSandbox: async () => { opened += 1; return 'box'; }, ...h });
    const { develop } = h.calls[0];
    const sent = [];
    const answers = [{ message: 'Was siehst du?' }, { choice: 'end' }];
    const intro = [];
    const chat = {
        develop: async (question) => {
            intro.push(question);
            sent.push(`opened=${opened}`);
            return answers.shift();
        },
        notice: () => {},
        progress: () => {},
        onPicked: () => {},
    };
    const talk = (options, question) => {
        sent.push({ question, sandbox: options.sandbox });
        return { over: () => false, send: (text) => sent.push({ text }), end: async () => {} };
    };
    await develop({ chat, talk, until: 'S2', refresh: async () => '', restore: async () => '', onRefresh: () => {}, onReload: () => () => {}, toCode: () => {} });
    assert.deepEqual(sent, [{ question: undefined, sandbox: 'box' }, 'opened=1', { text: 'Was siehst du?' }, 'opened=1']);
    assert.match(intro[0], /Claude-Code-Session ist schon angemeldet/);
    assert.doesNotMatch(intro[0], /kosten Token/);
});

test('Entwickeln im Zustand: Aktualisieren ohne Zustand, Zustand neu herstellen, Fadenkreuz an Claude Code, Fragen an Claude', async () => {
    const h = harness({ outcomes: [pass] });
    let opened = 0;
    await runFlow({ spec, until: 'S2', handover: true, canFix: true, openSandbox: async () => { opened += 1; return 'box'; }, ...h });
    const { develop } = h.calls[0];
    assert.equal(typeof develop, 'function');
    const element = { label: 'button "Senden"', target: { role: 'button' } };
    let refresher = 'nie gesetzt';
    let reloaded = null;
    let picked = null;
    let refreshed = 0;
    const answers = [
        { choice: 'restore' },
        { message: 'Warum ist der deaktiviert?', element },
        { message: 'Und jetzt?' },
        { choice: 'end' },
    ];
    const notices = [];
    const shown = [];
    const sent = [];
    let ended = 0;
    const chat = {
        develop: async (question, options) => {
            shown.push({ question, options: options.map(({ id }) => id) });
            if (shown.length === 1) {
                // Der Mensch drueckt F5, waehlt ein Element mit dem Fadenkreuz, laedt dann die ganze Werkbank neu.
                await refresher();
                picked(element);
                await reloaded();
            }
            return answers.shift();
        },
        notice: (text) => notices.push(text),
        progress: () => {},
        onPicked: (handler) => { picked = handler; },
    };
    const handed = [];
    const talk = (options, question, about) => {
        sent.push({ question, about, sandbox: options.sandbox });
        return { over: () => false, send: (text, about2) => sent.push({ text, about: about2 }), end: async () => { ended += 1; } };
    };
    await develop({
        chat,
        talk,
        until: 'S2',
        refresh: async () => { refreshed += 1; return ''; },
        restore: async () => 'Zustand S2 ist neu hergestellt',
        onRefresh: (handler) => { refresher = handler; },
        onReload: (listener) => { reloaded = listener; return () => { reloaded = 'abgemeldet'; }; },
        toCode: (value) => handed.push(value),
    });
    assert.match(shown[0].question, /^Zustand S2 steht\. .*Aktualisieren.*Zustand neu herstellen.*Fadenkreuz.*kosten Token/);
    assert.deepEqual(shown[0].options, ['restore', 'end']);
    assert.equal(shown[1].question, undefined, 'die Einleitung kommt nur einmal');
    assert.equal(refreshed, 1, 'Aktualisieren lädt nur die Seite neu, ohne Meldung');
    assert.deepEqual(handed, [element], 'das Fadenkreuz gibt das Element sofort an Claude Code');
    assert.match(notices[0], /„button "Senden"“ liegt für deine Claude-Code-Sitzung bereit/);
    assert.match(notices[1], /Werkbank neu geladen: Zustand S2 nicht mehr gesichert/);
    assert.equal(notices[2], 'Zustand S2 ist neu hergestellt');
    assert.deepEqual(sent[0], { question: 'Warum ist der deaktiviert?', about: element, sandbox: 'box' });
    assert.deepEqual(sent[1], { text: 'Und jetzt?', about: undefined });
    assert.equal(opened, 1, 'Claude erst bei der ersten Frage');
    assert.equal(ended, 1, 'Beenden beendet auch das Gespräch');
    assert.equal(refresher, null, 'nach dem Entwickeln ist Aktualisieren wieder gesperrt');
    assert.equal(reloaded, 'abgemeldet');
    assert.equal(picked, null);

    // Dev-Server startet gerade neu: Zustand neu herstellen scheitert, der Chat meldet es, Entwickeln geht weiter; Fenster zu beendet Claude.
    const later = [{ choice: 'restore' }, { message: 'Hallo' }, null];
    const said = [];
    let stopped = 0;
    await develop({
        chat: { ...chat, develop: async () => later.shift(), notice: (text) => said.push(text) },
        talk: () => ({ over: () => false, send: () => {}, end: async () => { stopped += 1; } }),
        until: 'S2',
        refresh: async () => '',
        restore: async () => { throw new Error('net::ERR_CONNECTION_REFUSED at http://app.localhost:5173/\nCall log: ...'); },
        toCode: () => {},
    });
    assert.match(said[0], /^Zustand neu herstellen ging nicht: net::ERR_CONNECTION_REFUSED at http:\/\/app\.localhost:5173\/\. Läuft der Dev-Server/);
    assert.equal(stopped, 1, 'Fenster zu beendet ein laufendes Gespräch');
});

test('Testlauf: Weicht nur die Wirkung ab, vergisst „Neue Wirkung übernehmen“ sie ohne Claude, sonst gibt es den Knopf nicht', async () => {
    const effects = { controls: ['button "Neu"'] };
    const learned = { ...spec, steps: spec.steps.map((step) => ({ ...step, recording: { ...step.recording, effects } })) };
    const reason = 'Die Prüfung ist erfüllt, aber die Anwendung reagiert anders als in gesunden Läufen. Aktion 1 click: fehlt button "Neu".';
    const h = harness({ outcomes: [failing('S2', { reason })], answers: ['forget-effect'] });
    assert.equal(await runFlow({ spec: learned, handover: false, canFix: true, openSandbox: async () => assert.fail('kein Claude'), ...h }), EXIT.fail);
    assert.equal(h.questions[0].options[0], 'forget-effect');
    assert.equal(h.adopted.length, 1);
    assert.deepEqual([...h.adopted[0].only], ['S2']);
    assert.equal(h.adopted[0].draft.steps[1].recording.effects, undefined);
    assert.deepEqual(h.adopted[0].draft.steps[0].recording.effects, effects);
    assert.equal(h.adopted[0].draft.steps[1].recording.hash, spec.steps[1].recording.hash);
    assert.match(h.notices.at(-1), /^Die gelernte Wirkung von S2 ist vergessen\. Die nächsten 2 gesunden Läufe/);

    const other = harness({ outcomes: [failing('S2')], answers: ['close'] });
    await runFlow({ spec: learned, handover: false, canFix: true, openSandbox: async () => 's', ...other });
    assert.equal(other.questions[0].options.includes('forget-effect'), false);
});

test('Bleibt nach dem Prüfdurchlauf ein Schritt veraltet, bietet die Entscheidung ihn zum Neu-Aufnehmen an', async () => {
    const stale = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], expect: 'S2 anders' }] };
    const h = harness({ outcomes: [pass, repaired(), pass], answers: ['rerecord-next', 'adopt'] });
    await fixFlow({ draft: stale, sandbox: 's', ...h });
    assert.deepEqual(h.questions[0].options, ['rerecord-next', 'adopt', 'discard']);
    assert.match(h.questions[0].text, /Noch veraltet und nicht geprüft: S2\./);
    assert.equal(h.calls[1].repair.id, 'S2');
    assert.equal(h.calls[1].repair.rerecord, true);
    assert.equal(h.adopted.length, 1);
});
