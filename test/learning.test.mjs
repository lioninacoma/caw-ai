import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runFlow } from '../src/host/flows.mjs';
import { learningPath, readLearning, withLearning } from '../src/host/learning.mjs';
import { droppedWhileLearning, effectsLearning, learnedEffects, withoutEffects } from '../src/host/replay.mjs';
import { learnedLooks } from '../src/host/visual.mjs';
import { loadTest, recordingPath, stepHash, writeTest } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';
import { EXIT } from '../src/shared/errors.mjs';

const TARGET = 'a/dev';
const CLICK = { action: 'click', target: "getByRole('button', { name: 'Next', exact: true })" };
const recorded = (id, at, extra = {}) => {
    const step = { id, name: `Step ${id}`, do: `Do ${id}`, expect: `${id} is there`, ...extra };
    return { ...step, recording: { hash: stepHash(step), recordedOn: TARGET, recordedAt: at, locale: 'de-DE', timezone: 'Europe/Berlin', actions: [CLICK], check: `check${id}()` } };
};
const project = (t, steps = [recorded('S1', '2026-11-01T09:00:00.000Z'), recorded('S2', '2026-11-01T09:01:00.000Z')]) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-learning-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeTest(root, composeTest({ id: 't', role: 'r', environments: [TARGET], writes: true, notes: '' }, { notes: '', steps }));
    return root;
};
/** The test as a run sees it: the file plus what this machine is still learning. */
const seen = (root) => withLearning(root, { ...loadTest(root, 't'), expectations: [{ id: 'S1' }, { id: 'S2' }] });
const effect = (lines) => new Map([[1, { requests: lines }]]);
const passed = new Map([['S1', { status: 'pass' }], ['S2', { status: 'pass' }]]);

/**
 * One local run that learns, as runFlow does it: the playback's learned effects (and looks), written through writeTest.
 * @returns the lines the run logged
 */
const learningRun = async (root, observed, { looks, fillBaselines = true } = {}) => {
    const spec = seen(root);
    const effects = learnedEffects({ spec, results: passed, effects: observed, deviations: new Map(), target: TARGET });
    const learned = looks === undefined ? new Map() : learnedLooks({ spec: { ...spec, steps: spec.steps.map((step) => ({ ...step, look: true })) }, results: passed, seen: looks, target: TARGET });
    const lines = [];
    const code = await runFlow({
        spec,
        handover: false,
        canFix: false,
        fillBaselines,
        openSandbox: async () => assert.fail('no agent'),
        execute: async () => ({ exitCode: EXIT.pass, verdict: { status: 'pass' }, ...(effects.size === 0 ? {} : { effects }), ...(learned.size === 0 ? {} : { looks: learned }) }),
        adopt: (draft, only, options) => writeTest(root, draft, only, options),
        log: (line) => lines.push(line),
    });
    assert.equal(code, EXIT.pass);
    return { lines, effects };
};

test('five learning runs: the recording is written once, by the fifth; the runs before only count in .caw/learning', async (t) => {
    const root = project(t);
    const file = recordingPath(root, 't');
    const original = readFileSync(file, 'utf8');
    const observed = new Map([['S1', effect(['POST /api/a 200'])], ['S2', effect(['GET /api/b 200'])]]);
    for (let run = 1; run <= 4; run += 1) {
        const { lines } = await learningRun(root, observed);
        assert.equal(readFileSync(file, 'utf8'), original, `run ${run} leaves the recording as it is`);
        assert.deepEqual(lines, [`Effekte lernen (in .caw/learning, bis sie eingefroren sind): S1 ${run}/5, S2 ${run}/5.`]);
        assert.equal(readLearning(root, 't').S1.effects.runs, run);
    }
    const { lines } = await learningRun(root, observed);
    assert.deepEqual(lines, ['Effekte eingefroren für S1, S2: caw/recordings/t.yaml. Bitte prüfen und committen.']);
    const frozen = loadTest(root, 't');
    assert.equal(frozen.steps[0].recording.effects.runs, 5);
    assert.deepEqual(frozen.steps[1].recording.effects.actions, [{ action: 1, requests: ['GET /api/b 200'] }]);
    assert.equal(existsSync(learningPath(root, 't')), false, 'nothing is left to learn');
    // Frozen, a sixth run learns nothing and writes nothing.
    const after = readFileSync(file, 'utf8');
    assert.deepEqual((await learningRun(root, observed)).lines, []);
    assert.equal(readFileSync(file, 'utf8'), after);
});

test('a look learns over two runs: the first only in .caw/learning, the second writes it into the recording', async (t) => {
    const root = project(t);
    const file = recordingPath(root, 't');
    const original = readFileSync(file, 'utf8');
    const looks = new Map([['S2', { styles: ['button ×1: color #ffffff'], changed: false }]]);
    assert.deepEqual((await learningRun(root, new Map(), { looks })).lines, ['Aussehen lernen (in .caw/learning, bis es eingefroren ist): S2 1/2.']);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.deepEqual((await learningRun(root, new Map(), { looks })).lines, ['Aussehen eingefroren für S2: caw/recordings/t.yaml. Bitte prüfen und committen.']);
    assert.deepEqual(loadTest(root, 't').steps[1].recording.visual, { runs: 2, styles: ['button ×1: color #ffffff'] });
});

test('a line every earlier run saw and this one did not is still named: the comparison reads .caw/learning', async (t) => {
    const root = project(t);
    await learningRun(root, new Map([['S2', effect(['GET /api/b 200', 'GET /api/c 200'])]]));
    await learningRun(root, new Map([['S2', effect(['GET /api/b 200', 'GET /api/c 200'])]]));
    const spec = seen(root);
    const observed = new Map([['S2', effect(['GET /api/b 200'])]]);
    const effects = learnedEffects({ spec, results: passed, effects: observed, deviations: new Map(), target: TARGET });
    assert.deepEqual(droppedWhileLearning(spec, effects, { observed }), [{ step: 'S2', lines: ['1 requests: GET /api/c 200'] }]);
});

test('recorded again, a step learns anew: its learning state goes, the other steps keep theirs', async (t) => {
    const root = project(t);
    const observed = new Map([['S1', effect(['POST /api/a 200'])], ['S2', effect(['GET /api/b 200'])]]);
    await learningRun(root, observed);
    await learningRun(root, observed);
    const spec = seen(root);
    const again = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], recording: { ...spec.steps[1].recording, recordedAt: '2026-11-02T10:00:00.000Z', actions: [CLICK] } }] };
    delete again.steps[1].recording.effects;
    writeTest(root, again, new Set(['S2']));
    assert.deepEqual(Object.keys(readLearning(root, 't')), ['S1']);
    assert.equal(readLearning(root, 't').S1.effects.runs, 2);
    const { lines } = await learningRun(root, observed);
    assert.deepEqual(lines, ['Effekte lernen (in .caw/learning, bis sie eingefroren sind): S1 3/5, S2 1/5.']);
    // An entry of an older recording of the step does not count, even if it was left behind.
    const learning = JSON.parse(readFileSync(learningPath(root, 't'), 'utf8'));
    learning.steps.S2.recordedAt = 'earlier';
    writeFileSync(learningPath(root, 't'), JSON.stringify(learning));
    assert.equal(seen(root).steps[1].recording.effects, undefined);
});

test('an earlier step recorded again: the next step\'s frozen effects learn anew and leave the recording with the first learning run', async (t) => {
    const root = project(t);
    const observed = new Map([['S2', effect(['GET /api/b 200'])]]);
    for (let run = 0; run < 5; run += 1) await learningRun(root, observed);
    assert.equal(loadTest(root, 't').steps[1].recording.effects.runs, 5);
    const spec = seen(root);
    writeTest(root, { ...spec, steps: [{ ...spec.steps[0], recording: { ...spec.steps[0].recording, recordedAt: '2026-11-02T10:00:00.000Z' } }, spec.steps[1]] }, new Set(['S1']));
    const { lines } = await learningRun(root, observed);
    assert.deepEqual(lines, ['Effekte lernen (in .caw/learning, bis sie eingefroren sind): S2 1/5.']);
    assert.equal(loadTest(root, 't').steps[1].recording.effects, undefined, 'no run compares against the old basis any more');
    assert.equal(readLearning(root, 't').S2.effects.basis, '2026-11-02T10:00:00.000Z');
});

test('forgetting the effects of a step clears what it was learning', async (t) => {
    const root = project(t);
    await learningRun(root, new Map([['S1', effect(['POST /api/a 200'])], ['S2', effect(['GET /api/b 200'])]]));
    writeTest(root, withoutEffects(seen(root), 'S2'), new Set(['S2']));
    assert.deepEqual(Object.keys(readLearning(root, 't')), ['S1']);
});

test('a run that does not learn (CI without --learn) writes neither the recording nor .caw/learning', async (t) => {
    const root = project(t);
    const original = readFileSync(recordingPath(root, 't'), 'utf8');
    const { lines } = await learningRun(root, new Map([['S1', effect(['POST /api/a 200'])]]), { fillBaselines: false });
    assert.deepEqual(lines, []);
    assert.equal(readFileSync(recordingPath(root, 't'), 'utf8'), original);
    assert.equal(existsSync(learningPath(root, 't')), false);
});

test('the CI reports count the runs from .caw/learning (n/5)', async (t) => {
    const root = project(t);
    const observed = new Map([['S1', effect(['POST /api/a 200'])]]);
    for (let run = 0; run < 3; run += 1) await learningRun(root, observed);
    assert.deepEqual(effectsLearning(loadTest(root, 't'), TARGET), [{ id: 'S1', runs: 0 }, { id: 'S2', runs: 0 }], 'the recording alone knows nothing');
    assert.deepEqual(effectsLearning(seen(root), TARGET), [{ id: 'S1', runs: 3 }, { id: 'S2', runs: 0 }]);
});

test('an older recording with effects not frozen yet: they are where learning starts, the next learning run moves them out', async (t) => {
    const root = project(t);
    const file = recordingPath(root, 't');
    const partial = readFileSync(file, 'utf8').replace(/(\n {4}check: checkS1\(\)\n)/, '$1    effects:\n      runs: 3\n      actions:\n        - action: 1\n          requests: [POST /api/a 200]\n');
    writeFileSync(file, partial);
    assert.equal(seen(root).steps[0].recording.effects.runs, 3);
    const { lines } = await learningRun(root, new Map([['S1', effect(['POST /api/a 200'])]]));
    assert.deepEqual(lines, ['Effekte lernen (in .caw/learning, bis sie eingefroren sind): S1 4/5.']);
    assert.equal(loadTest(root, 't').steps[0].recording.effects, undefined, 'one last change: the state moved to .caw/learning');
    assert.equal(readLearning(root, 't').S1.effects.runs, 4);
});

test('frozen meanwhile by someone else (same basis): the recording wins over what this machine was learning', (t) => {
    const root = project(t);
    const spec = loadTest(root, 't');
    const learning = { ...spec, steps: [{ ...spec.steps[0], recording: { ...spec.steps[0].recording, effects: { runs: 2, actions: [] } } }, spec.steps[1]] };
    writeTest(root, learning, new Set(['S1']));
    const frozen = { runs: 5, actions: [{ action: 1, requests: ['POST /api/a 200'] }] };
    const file = recordingPath(root, 't');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/(\n {4}check: checkS1\(\)\n)/, '$1    effects:\n      runs: 5\n      actions:\n        - action: 1\n          requests: [POST /api/a 200]\n'));
    assert.deepEqual(seen(root).steps[0].recording.effects, frozen);
});
