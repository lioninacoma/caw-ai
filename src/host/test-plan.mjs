// The plan Claude presents in the chat is the future test file without recordings: same fields, no second format.
// The agent cannot change the project. The tool writes the metadata; role, targets and write access stay with the human.

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
    app: meta.app,
    role: meta.role,
    targets: meta.targets,
    mutates: meta.mutates,
    also: meta.also ?? [],
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
    && previous.mutates === false && proposed.mutates === false && proposed.steps.length === previous.steps.length
    && proposed.steps.every((step, index) => samePlanStep(step, previous.steps[index]));

/** What the plan card in the chat shows: plan fields only. */
export const planView = ({ notes, steps }, { repairing = false, rerecord = false, previous } = {}) => ({
    repairing,
    title: repairing ? t(rerecord ? 'config.plan.rerecord' : 'config.plan.fix', { id: String(steps[0]?.id) }) : t('config.plan.title'),
    notes: repairing ? '' : notes,
    steps: steps.map(({ id, name, do: action, expect, note, retry }) => ({
        id,
        name,
        do: action,
        expect,
        ...(note === undefined ? {} : { note }),
        ...(retry === undefined ? {} : { retry }),
        ...(previous !== undefined && previous.expect !== expect ? { previousExpect: previous.expect } : {}),
    })),
});
