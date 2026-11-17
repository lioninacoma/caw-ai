// The plan Claude presents in the chat is the future test file without recordings: same fields, no second format.
// The agent cannot change the project. The tool writes the metadata; role, environments and write access stay with the human.

import { t } from '../shared/i18n.mjs';
import { parsePlan, withExpectations } from './test-file.mjs';

export const PLAN_FILE = 'plan.yaml';

const MAX_LENGTH = 100_000;
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// The text comes indirectly from the application and ends up in chat and terminal.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Is the plan valid? Runs before the human sees it, so the agent can still correct it.
 * @returns { problems, plan }
 */
export const readPlan = (text) => {
    const problems = [];
    if (text.length > MAX_LENGTH) problems.push(t('config.plan.tooLong', { max: MAX_LENGTH }));
    if (CONTROL.test(text)) problems.push(t('config.plan.control'));
    if (EMAIL.test(text)) problems.push(t('config.plan.email'));
    const parsed = parsePlan(text);
    problems.push(...parsed.problems);
    return problems.length > 0 ? { problems } : { problems, plan: parsed.plan };
};

/** Metadata from the tool, content from the agent. Recordings only exist after the run. */
export const composeTest = (meta, { notes, steps }) => withExpectations({
    id: meta.id,
    role: meta.role,
    writes: meta.writes,
    ...(meta.environments === undefined ? {} : { environments: meta.environments }),
    ...(meta.start === undefined ? {} : { start: meta.start }),
    notes,
    steps,
});

/** Replaces exactly one step; all other steps stay the same objects. */
export const replaceStep = (spec, step) => withExpectations({ ...spec, steps: spec.steps.map((current) => (current.id === step.id ? step : current)) });

/** Same plan for a step: name, action, expectation, note and retry. The recording does not count. */
export const samePlanStep = (a, b) => ['id', 'name', 'do', 'expect', 'note'].every((key) => (a[key] ?? '') === (b[key] ?? ''))
    && JSON.stringify(a.retry ?? null) === JSON.stringify(b.retry ?? null);

/**
 * Does the developer's own Claude Code session follow a read-only test plan it wrote, unchanged? Then the plan needs no approval
 * up front; adopting the proven test still does.
 */
export const sessionFollowsOwnPlan = ({ agent, previous, proposed }) => agent === 'session' && previous !== undefined
    && previous.writes === false && proposed.writes === false && proposed.steps.length === previous.steps.length
    && proposed.steps.every((step, index) => samePlanStep(step, previous.steps[index]));

/**
 * What the plan card in the chat shows: plan fields only.
 * @param previous Map step id -> step as it was: a changed expectation shows the old one struck through
 * @param from     re-recording from this step on: the title names it
 */
/** The human's notes of a demonstration or description, numbered H1, H2 … in order: Claude names them in `heard`. */
export const withNoteIds = (items) => {
    let count = 0;
    return items.map((item) => (item.action === 'note' ? { id: `H${(count += 1)}`, ...item } : item));
};

/**
 * Every human note must be accounted for exactly once, and a note or retry must really be on its step.
 * @returns problems for Claude, in English like the other plan-invalid messages
 */
export const heardProblems = ({ heard = [], steps }, notes) => {
    const problems = [];
    const ids = notes.map(({ id }) => id);
    const named = heard.map(({ note }) => note);
    const unknown = named.filter((id) => !ids.includes(id));
    const twice = named.filter((id, index) => named.indexOf(id) !== index);
    const missing = ids.filter((id) => !named.includes(id));
    if (unknown.length > 0) problems.push(`heard names notes that do not exist: ${unknown.join(', ')}.`);
    if (twice.length > 0) problems.push(`heard names a note more than once: ${[...new Set(twice)].join(', ')}.`);
    if (missing.length > 0) problems.push(`heard must say for every note of the human what became of it (note, retry, notes or run); missing: ${missing.join(', ')}.`);
    for (const { note, as, step } of heard) {
        const target = steps.find(({ id }) => id === step);
        if (as === 'note' && target?.note === undefined) problems.push(`${note} is heard as note of ${step}, but ${step} has no note.`);
        if (as === 'retry' && target?.retry === undefined) problems.push(`${note} is heard as retry of ${step}, but ${step} has no retry.`);
    }
    return problems;
};

/** The human's notes with what became of them, for the card. */
const heardOf = (heard = [], notes = []) => heard.map(({ note, as, step }) => ({ text: notes.find(({ id }) => id === note)?.text ?? note, as, step }))
    .filter(({ text }) => text !== undefined);

export const planView = ({ notes, steps, heard }, { repairing = false, rerecord = false, from, previous, humanNotes = [] } = {}) => ({
    repairing,
    title: (() => {
        if (!repairing) return t('config.plan.title');
        if (from !== undefined) return t('config.plan.rerecordFrom', { id: String(from) });
        return t(rerecord ? 'config.plan.rerecord' : 'config.plan.fix', { id: String(steps[0]?.id) });
    })(),
    notes: repairing ? '' : notes,
    heard: heardOf(heard, humanNotes).filter(({ step }) => step === undefined).map(({ text, as }) => ({ text, as })),
    steps: steps.map(({ id, name, do: action, expect, note, retry }) => ({
        id,
        name,
        do: action,
        expect,
        ...(note === undefined ? {} : { note }),
        ...(retry === undefined ? {} : { retry }),
        ...(heardOf(heard, humanNotes).some(({ step }) => step === id) ? { heard: heardOf(heard, humanNotes).filter(({ step }) => step === id).map(({ text, as }) => ({ text, as })) } : {}),
        ...(previous?.has(id) && previous.get(id).expect !== expect ? { previousExpect: previous.get(id).expect } : {}),
    })),
});
