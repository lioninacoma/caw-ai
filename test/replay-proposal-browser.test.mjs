// A renamed target ("Speichern" to "Sichern") in real Chrome (headless): caw proposes the one similar element without AI and
// proves it by the learned effect, no write and the unchanged check. Each gate on its own fails the proposal. Skipped without Chrome.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { LEARN_RUNS } from '../src/host/effects.mjs';
import { failedStep, playReplay, stepRecords } from '../src/host/replay.mjs';
import { launchChrome } from './chrome.mjs';

let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage({ viewport: { width: 1000, height: 700 } });
});
after(async () => { await browser?.close(); });
const needsChrome = () => browser === null;

const SPEICHERN = "getByRole('button', { name: 'Speichern', exact: true })";
const SICHERN = "getByRole('button', { name: 'Sichern', exact: true })";
// The app after the rename: the button says "Sichern", clicking it shows the status and the undo button the recording learned.
const RENAMED = `<button onclick="document.getElementById('s').textContent='Gespeichert';document.getElementById('u').hidden=false">Sichern</button><p role="status" id="s"></p><button id="u" hidden>Rückgängig</button>`;
const SAVED = "document.getElementById('s').textContent === 'Gespeichert'";
// What the healthy runs learned for the click.
const LEARNED = { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ button "Rückgängig"'] }] };

/**
 * Plays S1 (click, check) and S2 (check true) against the page.
 * @param blocked what the session aborted while writes were held
 * @param requests what the network log answers for any mark: lines a measured effect sees
 */
const play = async ({ html = RENAMED, steps = [{ action: 'click', target: SPEICHERN }], check = SAVED, effects = { S1: LEARNED }, blocked = [], requests = [], hold = true, reads } = {}) => {
    await page.setContent(html);
    const holds = [];
    const session = {
        page: () => page,
        waitReady: async () => ({ settled: true }),
        trail: { mark: () => 0, since: () => [] },
        network: { mark: () => 0, since: () => requests },
        ...(hold ? {
            holdWrites: async () => { holds.push('hold'); },
            releaseWrites: () => {
                holds.push('release');
                return blocked;
            },
        } : {}),
    };
    const played = await playReplay({
        replay: { steps: [...steps, { action: 'check', id: 'S1', code: check }, { action: 'check', id: 'S2', code: 'true' }], effects },
        handler: async (command) => {
            if (command.action !== 'check') return 'ok';
            const value = await page.mainFrame().evaluate(command.code);
            return { pass: value === true, value };
        },
        session,
        base: 'https://caw.test',
        stepTimeoutMs: 800,
        ...(reads === undefined ? {} : { reads }),
    });
    return { ...played, holds };
};
const noProposal = (played, why) => {
    assert.equal(played.broken?.kind, 'target', `${why}: the missing target stands`);
    assert.equal(played.broken.step, 'S1');
    assert.match(played.broken.message, /button "\/?Speichern\/?" war nach 1 s nicht klickbar/);
    assert.equal(played.results.get('S1'), undefined, why);
    assert.equal(played.results.get('S2'), undefined, `${why}: the replay stopped`);
};

test('proposal: the one similar button causes the learned effect without writing and the unchanged check passes', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const played = await play();
    assert.equal(played.broken, null, played.broken?.message);
    const s1 = played.results.get('S1');
    assert.equal(s1.status, 'fail');
    assert.equal(s1.kind, 'target');
    assert.deepEqual({ ...s1.proposal, evidence: undefined }, { step: 'S1', action: 1, from: SPEICHERN, to: SICHERN, evidence: undefined });
    assert.deepEqual(s1.proposal.evidence.effect, { controls: LEARNED.actions[0].controls });
    assert.match(s1.proposal.evidence.check, /=> true$/);
    assert.match(s1.note, /button "Speichern" war nach 1 s nicht klickbar.*caw schlägt für Aktion 1 stattdessen button "Sichern" vor: Es bewirkte dieselbe gelernte Wirkung, schrieb nichts, und die unveränderte Prüfung des Schritts bestand\./);
    assert.equal(played.results.get('S2').status, 'pass', 'the replay went on: the check holds');
    assert.deepEqual(played.holds, ['hold', 'release'], 'writes were held only for the try');
    assert.equal(await page.evaluate(() => document.getElementById('s').textContent), 'Gespeichert');

    // result.json and the chat get it along.
    const expectations = [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }];
    const [record] = stepRecords({ ids: ['S1'], ...played });
    assert.equal(record.kind, 'target');
    assert.equal(record.proposal.to, SICHERN);
    const [shielded] = stepRecords({ ids: ['S1'], ...played, withEffects: false });
    assert.deepEqual(Object.keys(shielded.proposal.evidence), ['check'], 'on production without the effect lines');
    const failed = failedStep({ ...played, expectations });
    assert.equal(failed.id, 'S1');
    assert.equal(failed.proposal.to, SICHERN);
    return undefined;
});

test('proposal gates: two similar names, another action, no learned effect, a writing effect: no try at all', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const twins = `${RENAMED}<button>Speichern unter</button>`;
    const two = await play({ html: twins });
    noProposal(two, 'two similar elements');
    assert.match(two.broken.message, /Ähnlich: button "Sichern", button "Speichern unter"/);
    const hover = await play({ steps: [{ action: 'hover', target: SPEICHERN }] });
    noProposal(hover, 'hover is no repairable action');
    assert.deepEqual(hover.holds, []);
    for (const [why, effects] of [
        ['no learned effects', {}],
        ['still learning', { S1: { ...LEARNED, runs: 1 } }],
        ['no effect for this action', { S1: { runs: LEARN_RUNS, actions: [{ action: 2, controls: ['+ x'] }] } }],
        ['the learned effect writes', { S1: { runs: LEARN_RUNS, actions: [{ action: 1, ...LEARNED.actions[0], requests: ['POST /speichern 200'] }] } }],
    ]) {
        const played = await play({ effects });
        noProposal(played, why);
        assert.deepEqual(played.holds, [], `${why}: nothing was tried`);
    }
    // A request `reads` names is no write.
    const read = await play({ effects: { S1: { runs: LEARN_RUNS, actions: [{ action: 1, ...LEARNED.actions[0], requests: ['POST /suche 200'] }] } }, requests: [{ name: 'POST /suche', status: 200, outcome: 'ok' }], reads: ['POST /suche'] });
    assert.equal(read.results.get('S1').proposal?.to, SICHERN);
    noProposal(await play({ hold: false }), 'a session that cannot hold writes');
    noProposal(await play({ steps: [{ action: 'click', target: "getByRole('button', { name: /Speichern/ })" }] }), 'a regex name');
    return undefined;
});

test('proposal proof: another effect, a held or an observed write, or a failing check leave the missing target', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const other = await play({ effects: { S1: { runs: LEARN_RUNS, actions: [{ action: 1, controls: ['+ button "Rückgängig machen"'] }] } } });
    noProposal(other, 'the candidate causes another effect');
    assert.deepEqual(other.holds, ['hold', 'release']);
    noProposal(await play({ blocked: ['POST /speichern'] }), 'the candidate tried to write');
    noProposal(await play({ requests: [{ name: 'POST /speichern', status: 200, outcome: 'ok' }] }), 'a write among the observed requests');
    noProposal(await play({ check: "document.getElementById('s').textContent === 'Gesichert'" }), 'the unchanged check fails with the candidate');
    return undefined;
});
