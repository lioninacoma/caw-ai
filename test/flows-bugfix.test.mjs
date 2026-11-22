// The guided bug fix in the workbench: after the red proof the card offers the fix, testing again and, once green, promoting;
// every phase in one process. Without a browser: outcomes come in order, the human picks in order from `answers`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { offerRecordRed, recordFlow, runFlow } from '../src/host/flows.mjs';
import { resultText } from '../src/host/chat.mjs';
import { stepHash } from '../src/host/test-file.mjs';
import { CawError, EXIT } from '../src/shared/errors.mjs';

const stepOf = (id, expect = `${id} da`) => {
    const step = { id, name: id === 'S2' ? 'Summe' : 'Warenkorb', do: '', expect };
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: 'z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [{ action: 'reload' }], check: id === 'S2' ? "sum==='Total: 5'" : 'c' } };
};
const draft = { id: 'bug-x', draft: true, steps: [stepOf('S1'), stepOf('S2', 'Die Summe zeigt Total: 5.')], expectations: [{ id: 'S1' }, { id: 'S2' }] };
const proven = { ...draft, red: { step: 'S2', run: 'r-red', head: 'abc1234' } };
const redRun = (concluded = {}) => ({
    exitCode: EXIT.fail,
    runId: 'r-red',
    verdict: { status: 'fail', reason: 'S2 nicht erfüllt.', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'fail' }] },
    failed: { id: 'S2', reason: 'Prüfung nicht erfüllt.', suspect: false, evaluated: true },
    concluded: { runId: 'r-red', ...concluded },
});
const greenRun = (extra = {}) => ({ exitCode: EXIT.pass, runId: 'r-green', verdict: { status: 'pass', results: [{ id: 'S1', status: 'pass' }, { id: 'S2', status: 'pass' }] }, ...extra });
const advice = (result) => ({ spec: draft, touched: [], stale: [], notes: false, files: [], outside: [], ...result });

const harness = ({ outcomes, answers = [] }) => {
    const questions = [];
    const adopted = [];
    const notices = [];
    const progress = [];
    const said = [];
    const calls = [];
    const queue = [...outcomes];
    const wishes = [...answers];
    const pick = (kind, text, options, card) => {
        const ids = options.map(({ id }) => id);
        questions.push({ text: card?.kind === 'result' ? resultText(card) : text, options: ids, labels: options.map(({ label }) => label), card });
        const wish = wishes.find((candidate) => ids.includes(candidate));
        if (wish !== undefined) wishes.splice(wishes.indexOf(wish), 1);
        return wish ?? ids.at(-1);
    };
    const chat = {
        choose: async (kind, text, options, card) => pick(kind, text, options, card),
        choosePicks: async (kind, text, options, card) => ({ choice: pick(kind, text, options, card), picked: [] }),
        discuss: async (text, options) => ({ choice: pick('discussing', text, options) }),
        notice: (text) => notices.push(text),
        progress: (text) => progress.push(text),
    };
    return {
        questions,
        adopted,
        notices,
        progress,
        said,
        calls,
        execute: async ({ conclude, ...call }) => {
            calls.push(call);
            const { concluded = {}, ...outcome } = queue.shift();
            said.push(await conclude?.({ ...outcome, ...concluded, chat }));
            return outcome;
        },
        adopt: (spec, only, options) => {
            adopted.push({ spec, only, options });
            return 'caw/drafts/bug-x.yaml';
        },
        log: () => {},
    };
};

test('Reproduced with a window: the card offers recording the draft red next, or later with the command', async () => {
    const chat = { choose: async (kind, text, options) => options[0].id };
    assert.deepEqual(await offerRecordRed(chat, { file: 'caw/drafts/bug-x.yaml', record: 'caw record bug-x' }), { next: 'record' });
    const asked = [];
    const later = { choose: async (kind, text, options, card) => { asked.push({ options: options.map(({ id }) => id), labels: options.map(({ label }) => label), card }); return 'later'; } };
    assert.deepEqual(await offerRecordRed(later, { file: 'caw/drafts/bug-x.yaml', record: 'caw record bug-x' }), { outcome: 'Später weiter mit caw record bug-x.' });
    assert.deepEqual(asked[0].options, ['record-red', 'later']);
    assert.deepEqual(asked[0].labels, ['Rot aufnehmen', 'Später']);
    assert.equal(asked[0].card.title, 'Nachgestellt: Entwurf caw/drafts/bug-x.yaml');
});

test('Recording a draft guided: after the red proof the card shows step, expectation, check and cause; fixing myself, then testing again runs the draft', async () => {
    const h = harness({ outcomes: [{ ...redRun(), candidate: draft }, redRun()], answers: ['adopt', 'fix-myself', 'retest'] });
    const reruns = [];
    const code = await recordFlow({ sandbox: 's', ...h, head: () => 'abc1234', guide: { cause: 'server.mjs:12 rechnet ohne Preise.', rerun: async () => { reruns.push(true); return EXIT.pass; } } });
    assert.equal(code, EXIT.pass, 'the code of the run after the fix');
    assert.equal(reruns.length, 1);
    assert.deepEqual(h.adopted[0].spec.red, { step: 'S2', run: 'r-red', head: 'abc1234' }, 'the red proof is saved before the fix');
    const fix = h.questions[1];
    assert.equal(fix.card.title, 'Jetzt den Fehler beheben');
    assert.deepEqual(fix.card.facts, ['Roter Schritt: S2 Summe', 'Erwartet: Die Summe zeigt Total: 5', "Prüfung: sum==='Total: 5'", 'Vermutete Ursache: server.mjs:12 rechnet ohne Preise']);
    assert.deepEqual(fix.options, ['fix-by-agent', 'fix-myself', 'later']);
    assert.deepEqual(fix.labels, ['Von Claude Code beheben lassen', 'Ich behebe selbst', 'Später']);
    const waiting = h.questions[2];
    assert.equal(waiting.card.title, 'Behebe den Fehler, dann teste erneut');
    assert.deepEqual(waiting.options, ['retest', 'later']);
    assert.deepEqual(h.said.at(-1), { next: 'run' }, 'testing again opens a new window');
});

test('Recording a draft guided: later at the fix card ends the run with the red proof saved, nothing runs again', async () => {
    const h = harness({ outcomes: [{ ...redRun(), candidate: draft }, redRun()], answers: ['adopt', 'later'] });
    const code = await recordFlow({ sandbox: 's', ...h, guide: { rerun: async () => assert.fail('no run') } });
    assert.equal(code, EXIT.pass);
    assert.deepEqual(h.questions[1].card.facts.at(-1), 'Noch keine Ursache vermutet.');
    assert.deepEqual(h.said.at(-1), { outcome: 'Später weiter mit caw run bug-x.' });
});

test('Fixing by the agent: the advice gets the red step as its task; an applied change offers testing again', async () => {
    const asked = [];
    const advise = async (options) => {
        asked.push(options);
        return advice({ files: ['src/total.js'] });
    };
    const h = harness({ outcomes: [{ ...redRun(), candidate: draft }, redRun({ advise })], answers: ['adopt', 'fix-by-agent', 'retest'] });
    const code = await recordFlow({ sandbox: 'box', ...h, guide: { cause: 'Preise fehlen.', rerun: async () => EXIT.pass } });
    assert.equal(code, EXIT.pass);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].sandbox, 'box', 'every agent kind: the run\'s sandbox, local, docker or the attached session');
    assert.deepEqual(asked[0].fix, { step: 'S2', name: 'Summe', expect: 'Die Summe zeigt Total: 5.', check: "sum==='Total: 5'", cause: 'Preise fehlen.' });
    const applied = h.questions[2];
    assert.equal(applied.card.title, 'Änderung übernommen');
    assert.match(applied.text, /Geändert: src\/total\.js\. Erneut testen zeigt, ob S2 jetzt besteht\./);
    assert.deepEqual(applied.options, ['retest', 'later']);
});

test('Fixing by the agent: a cause outside the project is pointed out, nothing to apply; fixing it there leads to testing again', async () => {
    const advise = async () => advice({ outside: [{ where: 'Repository billing-api', title: 'Der Preisdienst liefert 0' }] });
    const h = harness({ outcomes: [{ ...redRun(), candidate: draft }, redRun({ advise })], answers: ['adopt', 'fix-by-agent', 'fix-there', 'retest'] });
    const reruns = [];
    await recordFlow({ sandbox: 'box', ...h, guide: { rerun: async () => { reruns.push(true); return EXIT.pass; } } });
    const outside = h.questions[2];
    assert.equal(outside.card.title, 'Die Ursache liegt außerhalb dieses Projekts');
    assert.equal(outside.card.tone, 'warn');
    assert.match(outside.text, /Repository billing-api: Der Preisdienst liefert 0\./);
    assert.match(outside.text, /Hier gibt es nichts zu übernehmen/);
    assert.deepEqual(outside.options, ['fix-there', 'later']);
    assert.deepEqual(outside.labels[0], 'Ich behebe es dort');
    assert.deepEqual(h.questions[3].options, ['retest', 'later']);
    assert.equal(reruns.length, 1);
});

test('Fixing by the agent: nothing applied offers fixing myself first; no agent available says so', async () => {
    const nothing = harness({ outcomes: [{ ...redRun(), candidate: draft }, redRun({ advise: async () => advice({}) })], answers: ['adopt', 'fix-by-agent', 'later'] });
    await recordFlow({ sandbox: 'box', ...nothing, guide: { rerun: async () => assert.fail('no run') } });
    assert.equal(nothing.questions[2].card.title, 'Keine Änderung übernommen');
    assert.deepEqual(nothing.questions[2].options, ['fix-myself', 'retest', 'later']);

    const none = harness({ outcomes: [redRun({ advise: async () => assert.fail('no agent') })], answers: ['fix-by-agent', 'later'] });
    await runFlow({ spec: proven, handover: false, canFix: true, openSandbox: async () => { throw new CawError('token-missing', 'Kein Token.'); }, ...none, guide: {} });
    assert.equal(none.questions[1].card.title, 'Kein Agent konnte starten');
    assert.deepEqual(none.questions[1].options, ['fix-myself', 'later']);
    assert.match(none.progress.join(' '), /Kein Token/);
});

test('Test run of a red draft guided: still red offers fixing again, testing again and ending; testing again runs once more in a new window', async () => {
    const h = harness({ outcomes: [redRun(), redRun()], answers: ['retest', 'close'] });
    const code = await runFlow({ spec: proven, handover: false, canFix: true, openSandbox: async () => 'box', ...h, guide: { cause: 'x' } });
    assert.equal(code, EXIT.fail);
    assert.equal(h.calls.length, 2, 'testing again is a second run');
    const still = h.questions[0];
    assert.equal(still.card.title, 'S2 noch rot: der Fehler ist noch da');
    assert.deepEqual(still.options, ['fix-by-agent', 'retest', 'close']);
    assert.deepEqual(still.labels, ['Erneut beheben lassen', 'Erneut testen', 'Lauf beenden']);
    assert.deepEqual(h.said[0], { next: 'run' });
    assert.deepEqual(h.said[1], { outcome: 'Später weiter mit caw run bug-x.' });
    assert.deepEqual(h.adopted, [], 'the first red proof stays');
});

test('Test run of a draft not yet proven red, guided: the proof is written before testing again', async () => {
    const h = harness({ outcomes: [redRun(), greenRun()], answers: ['fix-myself', 'retest', 'later'] });
    await runFlow({ spec: draft, handover: false, canFix: true, openSandbox: async () => 'box', head: () => 'def5678', ...h, guide: { promote: async () => assert.fail('later') } });
    assert.equal(h.questions[0].card.title, 'S2 rot wie erwartet: der Test fängt den Fehler');
    assert.deepEqual(h.questions[0].options, ['fix-by-agent', 'fix-myself', 'later']);
    assert.deepEqual(h.adopted[0].spec.red, { step: 'S2', run: 'r-red', head: 'def5678' });
    assert.equal(h.questions.at(-1).card.title, 'S2 grün: der Fehler ist behoben', 'the second run knows the red proof');
});

test('Test run of a red draft guided: green offers adopting; it learns first, then promotes, and the chat names the fix report', async () => {
    const baselines = new Map([['S1', [{ name: 'GET /a', status: 200, ms: 40 }]]]);
    const h = harness({ outcomes: [greenRun({ baselines })], answers: ['promote'] });
    const order = [];
    const adopt = h.adopt;
    h.adopt = (...args) => { order.push('learn'); return adopt(...args); };
    const promote = async ({ runId }) => {
        order.push(`promote ${runId}`);
        return { ok: true, test: 'bug-x', files: 'caw/tests/bug-x.yaml, caw/recordings/bug-x.yaml', report: '.caw/runs/r-green/fix-report.md', others: 1, target: 'test' };
    };
    assert.equal(await runFlow({ spec: proven, handover: false, canFix: true, fillBaselines: true, openSandbox: async () => assert.fail('no agent'), ...h, guide: { promote } }), EXIT.pass);
    assert.equal(h.questions[0].card.title, 'S2 grün: der Fehler ist behoben');
    assert.deepEqual(h.questions[0].options, ['promote', 'later']);
    assert.deepEqual(order, ['learn', 'promote r-green'], 'learned baselines go into the draft before it moves');
    assert.equal(h.adopted.length, 1, 'nothing is written after promoting');
    assert.deepEqual(h.said[0], { outcome: 'Übernommen: caw/tests/bug-x.yaml, caw/recordings/bug-x.yaml. 1 andere(r) Test(s) auf test grün. Fix-Bericht: .caw/runs/r-green/fix-report.md' });
});

test('Test run of a red draft guided: promoting refused says so on a card, the draft stays; later names the command', async () => {
    const refused = harness({ outcomes: [greenRun()], answers: ['promote'] });
    await runFlow({ spec: proven, handover: false, canFix: true, openSandbox: async () => assert.fail('no agent'), ...refused, guide: { promote: async () => ({ ok: false, reason: 'Andere Tests auf test sind nicht grün' }) } });
    const card = refused.questions[1];
    assert.equal(card.card.title, 'Nicht übernommen');
    assert.equal(card.card.tone, 'fail');
    assert.match(card.text, /Andere Tests auf test sind nicht grün\..*Der Entwurf bug-x bleibt in caw\/drafts\./s);
    assert.deepEqual(card.options, ['close']);

    const later = harness({ outcomes: [greenRun()], answers: ['later'] });
    await runFlow({ spec: proven, handover: false, canFix: true, openSandbox: async () => assert.fail('no agent'), ...later, guide: { promote: async () => assert.fail('later') } });
    assert.deepEqual(later.said[0], { outcome: 'Später weiter mit caw run bug-x --promote.' });
});
