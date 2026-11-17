// The human's notes in a plan: numbered H1, H2 …, accounted for in `heard`, shown on the approval card.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePlan } from '../src/host/test-file.mjs';
import { heardProblems, planView, withNoteIds } from '../src/host/test-plan.mjs';

const items = [
    { action: 'note', text: 'Open the ticket list first.', path: '/' },
    { action: 'click', target: "getByRole('button', { name: 'Next' })" },
    { action: 'note', text: 'The database is cold here, wait longer.', path: '/tickets' },
];
const PLAN = `steps:
  - id: S1
    name: Open tickets
    do: Click Next.
    expect: The list shows.
    note: The first load can take long.
heard:
  - {note: H1, as: notes}
  - {note: H2, as: note, step: S1}
`;

test('withNoteIds: only notes get H1, H2 … in order; the other items stay as they are', () => {
    const numbered = withNoteIds(items);
    assert.deepEqual(numbered.map(({ id }) => id), ['H1', undefined, 'H2']);
    assert.equal(numbered[1], items[1]);
});

test('parsePlan: heard is read and is not part of notes or steps; a wrong entry names the shape', () => {
    const { problems, plan } = parsePlan(PLAN);
    assert.deepEqual(problems, []);
    assert.deepEqual(plan.heard, [{ note: 'H1', as: 'notes' }, { note: 'H2', as: 'note', step: 'S1' }]);
    assert.equal(plan.steps.length, 1);
    assert.equal(parsePlan(PLAN.replace('{note: H1, as: notes}', '{note: H1, as: later}')).problems.length, 1);
    assert.equal(parsePlan(PLAN.replace('{note: H1, as: notes}', '{note: H1, as: notes, step: S1}')).problems.length, 1, 'step only for note and retry');
    assert.equal(parsePlan(PLAN.replace('{note: H2, as: note, step: S1}', '{note: H2, as: note}')).problems.length, 1, 'note needs its step');
    assert.equal(parsePlan(PLAN.split('heard:')[0]).plan.heard, undefined);
});

test('heardProblems: every note exactly once, no unknown ones, a note or retry must be on its step', () => {
    const notes = withNoteIds(items).filter(({ action }) => action === 'note');
    const { plan } = parsePlan(PLAN);
    assert.deepEqual(heardProblems(plan, notes), []);
    assert.deepEqual(heardProblems(plan, []), ['heard names notes that do not exist: H1, H2.']);
    assert.match(heardProblems({ ...plan, heard: [plan.heard[0]] }, notes).join(' '), /missing: H2/);
    assert.match(heardProblems({ ...plan, heard: [...plan.heard, plan.heard[0]] }, notes).join(' '), /more than once: H1/);
    assert.match(heardProblems({ ...plan, heard: [plan.heard[0], { note: 'H2', as: 'retry', step: 'S1' }] }, notes).join(' '), /S1 has no retry/);
    assert.deepEqual(heardProblems({ steps: plan.steps }, []), [], 'without notes nothing is asked');
});

test('planView: the human words appear at their step or above the steps, with what became of them', () => {
    const notes = withNoteIds(items).filter(({ action }) => action === 'note');
    const view = planView(parsePlan(PLAN).plan, { humanNotes: notes });
    assert.deepEqual(view.heard, [{ text: 'Open the ticket list first.', as: 'notes' }]);
    assert.deepEqual(view.steps[0].heard, [{ text: 'The database is cold here, wait longer.', as: 'note' }]);
    assert.equal(planView(parsePlan(PLAN.split('heard:')[0]).plan).steps[0].heard, undefined);
});
