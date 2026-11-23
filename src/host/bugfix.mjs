// The guided bug fix: where a draft from caw reproduce stands on its way to a proven fix, and what comes next. reproduced (the
// draft is written, not yet recorded red), red (recorded red, the bug is still there), green (a run after the red one judged the
// red step and passed: the bug is fixed) and promoted (the test is in caw/tests, the run folder has fix-report.md). The workbench guides a person
// through these phases in one process; the session reads them from caw_status, caw_reproductions and caw_list as `phase` and `next`.
//
// The same way for a design draft (`origin: design`, guided target-image TDD): draft (written, its design not yet shown unmet),
// red (a run judged the red step's design not met: at its entry while the step is pending, or after its passed check), green
// (a later run judged it met) and adopted (the test is in caw/tests, the run folder has design-report.md).

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DRAFT_DIR } from '../shared/names.mjs';
import { REPRODUCE_RUN, runsWithResult } from './runs.mjs';
import { draftPath, isDesignDraft, loadDraft, pendingSteps, redStep, staleSteps, testPath } from './test-file.mjs';
import { PHASE_DECISIONS } from './decisions.mjs';

export const FIX_PHASES = ['reproduced', 'red', 'green', 'promoted'];
export const DESIGN_PHASES = ['draft', 'red', 'green', 'adopted'];
export const FIX_REPORT = 'fix-report.md';
export const DESIGN_REPORT = 'design-report.md';

/**
 * The judged target design of a step in a run's result (result.json): after its passed check (`steps`), or at its entry while
 * it is pending (`pendingDesign`). Undefined when that run did not judge it.
 */
export const designOf = (result, step) => {
    const judged = (Array.isArray(result?.steps) ? result.steps : []).find((item) => item?.id === step)?.design;
    if (judged !== undefined) return judged;
    return result?.pendingDesign?.step === step ? result.pendingDesign : undefined;
};

/** What keeps a judged design from being met, in the order the comparison page lists it: [{ kind, text }]. */
export const deviationsOf = (judged) => [
    ...(judged?.missing ?? []).map((text) => ({ kind: 'missing', text })),
    ...(judged?.textDiffs ?? []).map((text) => ({ kind: 'text', text })),
    ...(judged?.styleDiffs ?? []).map((text) => ({ kind: 'style', text })),
    ...(judged?.layoutDiffs ?? []).map((text) => ({ kind: 'layout', text })),
].filter(({ text }) => typeof text === 'string');

/**
 * Was a design draft's red step judged with this verdict in a run, every step before it passed, the step itself passed (or
 * failed only on its design, or still pending)? The run's result as result.json has it: results, steps, pendingDesign.
 */
const judgedAs = (spec, result, verdict) => {
    const step = redStep(spec);
    if (step === undefined || result === undefined || result === null) return false;
    const before = spec.steps.slice(0, spec.steps.findIndex(({ id }) => id === step)).map(({ id }) => id);
    const results = Array.isArray(result.results) ? result.results : [];
    if (!before.every((id) => results.some((item) => item?.id === id && item.status === 'pass'))) return false;
    const own = (Array.isArray(result.steps) ? result.steps : []).find((item) => item?.id === step);
    if (own !== undefined && !['pass', 'pending'].includes(own.status) && !(own.status === 'fail' && own.kind === 'design')) return false;
    return designOf(result, step)?.verdict === verdict;
};

/** A design draft shown red by a run: its red step's design judged not met, everything before it passed. */
export const designRed = (spec, result) => isDesignDraft(spec) && judgedAs(spec, result, 'not-met');

/** A design draft shown green by a run: its red step's design judged met, everything before it passed. */
export const designMet = (spec, result) => isDesignDraft(spec) && judgedAs(spec, result, 'met');

/**
 * The red step of a design draft for the card and the agent: the step, its expected result, its design and what still deviates
 * in the given run's result (the newest that judged it); undefined while the draft has no step with a design.
 */
export const designRedOf = (draft, result) => {
    const step = redStep(draft);
    if (step === undefined) return undefined;
    const found = draft.steps.find(({ id }) => id === step);
    return {
        step,
        ...(found?.name === undefined ? {} : { name: found.name }),
        ...(found?.expect === undefined ? {} : { expect: found.expect }),
        ...(found?.design === undefined ? {} : { design: found.design }),
        deviations: deviationsOf(designOf(result, step)).map(({ kind, text }) => `${kind}: ${text}`),
    };
};

/**
 * The red step of a draft as the person (card) and the agent (next.red, the fix advice's task) need it: the step, its expected
 * result, the check its recording keeps, and the cause the reproduction suspected.
 * @returns { step, name, expect, check?, cause? } or undefined before the draft is recorded red
 */
export const redOf = (draft, cause) => {
    if (draft?.red === undefined) return undefined;
    const step = draft.steps.find(({ id }) => id === draft.red.step);
    return {
        step: draft.red.step,
        ...(step?.name === undefined ? {} : { name: step.name }),
        ...(step?.expect === undefined ? {} : { expect: step.expect }),
        ...(step?.recording?.check === undefined ? {} : { check: step.recording.check }),
        ...(cause === undefined ? {} : { cause }),
    };
};

/**
 * The phase of a draft and the next step, without touching the disk.
 * @param id        the draft's id
 * @param draft     the draft as loadDraft reads it; undefined when caw/drafts has none (promoted or discarded)
 * @param runs      the id's runs with a result, newest first: [{ runId, status, results }], results the judged steps
 *                  as result.json has them ([{ id, status }])
 * @param promoted  caw/tests has the test and it came from this draft (a fix report or a reproduction names it)
 * @param fixReport the fix report of the promotion, relative to the project
 * @param cause     the cause the reproduction suspected
 * @param designReport the design report of an adopted design draft, relative to the project
 * @returns { phase, next } or undefined when there is no draft and nothing was promoted. next.decision names the window's card at
 *          that phase (decisions.mjs PHASE_DECISIONS): a run that waits on it is answered with caw_decide, not started anew
 */
export const fixPhase = ({ id, draft, runs = [], promoted = false, fixReport, designReport, cause }) => {
    if (draft === undefined && designReport !== undefined) return promoted ? { origin: 'design', phase: 'adopted', next: { done: true, designReport } } : undefined;
    if (draft === undefined) return promoted ? { phase: 'promoted', next: { done: true, ...(fixReport === undefined ? {} : { fixReport }) } } : undefined;
    if (isDesignDraft(draft)) return designPhase({ id, draft, runs });
    const run = { tool: 'caw_start', command: 'run', test: id };
    if (draft.red === undefined) return { phase: 'reproduced', next: { tool: 'caw_start', command: 'record', test: id, decision: PHASE_DECISIONS.reproduced } };
    // Run ids start with their time: a later id is a later run. Only a run after the red proof shows the fix, and only if it
    // judged the red step and passed it: an open at the red step's entry passes without ever checking it.
    const newest = runs.find(({ runId }) => runId > draft.red.run);
    const judged = Array.isArray(newest?.results) && newest.results.some((item) => item?.id === draft.red.step && item.status === 'pass');
    if (newest?.status === 'pass' && judged) return { phase: 'green', next: { ...run, promote: true, decision: PHASE_DECISIONS.green } };
    return { phase: 'red', next: { do: 'fix-app', red: redOf(draft, cause), then: run, decision: PHASE_DECISIONS.red } };
};

/**
 * The phase of a design draft. Red needs a run that judged its design not met; the draft phase leads there: record the steps
 * not recorded yet, have the person link the design to its step, or run it. Green with its step still pending is recorded
 * next (headless, the recording adopted under the usual rules); promoting needs every step recorded.
 * @param runs the id's runs, newest first: [{ runId, status, results, steps, pendingDesign }] as result.json has them
 */
const designPhase = ({ id, draft, runs }) => {
    const step = redStep(draft);
    const record = { tool: 'caw_start', command: 'record', test: id, headless: true };
    const run = { tool: 'caw_start', command: 'run', test: id, headless: true };
    const unrecorded = staleSteps(draft).map((item) => item.id).filter((item) => item !== step);
    if (draft.red === undefined) {
        // Nothing to be red at yet: the steps up to the screen first, then the step the design is for (pending), linked on request.
        if (step === undefined) {
            const pending = new Set(pendingSteps(draft));
            return { origin: 'design', phase: 'draft', next: unrecorded.some((item) => !pending.has(item)) ? record : { do: 'link-design', test: id } };
        }
        return { origin: 'design', phase: 'draft', next: unrecorded.length > 0 ? record : run };
    }
    // Only a run after the red proof counts, and only one that judged the design: the newest of those.
    const judged = runs.find(({ runId, steps, pendingDesign }) => runId > draft.red.run && designOf({ steps, pendingDesign }, step) !== undefined);
    if (judged !== undefined && designMet(draft, judged)) {
        const pending = draft.steps.find((item) => item.id === step)?.recording === undefined;
        return { origin: 'design', phase: 'green', next: pending || unrecorded.length > 0 ? record : { tool: 'caw_start', command: 'run', test: id, promote: true, decision: PHASE_DECISIONS.green } };
    }
    const shown = judged ?? runs.find(({ runId }) => runId === draft.red.run);
    return { origin: 'design', phase: 'red', next: { do: 'build-design', red: designRedOf(draft, shown), then: run, decision: PHASE_DECISIONS.red } };
};

/** The reproduction that wrote this draft: its cause, if the run folder is still there. */
export const reproductionOf = (root, id) => {
    const file = `${DRAFT_DIR}/${id}.yaml`;
    return runsWithResult(root, REPRODUCE_RUN).find(({ result }) => result.reproduce?.draft?.file === file)?.result.reproduce;
};

/** The newest report of that name (fix or design report) of the id, relative to the project with /, or undefined. */
const reportOf = (root, runs, name) => {
    const found = runs.find(({ dir }) => existsSync(join(dir, name)));
    return found === undefined ? undefined : relative(root, join(found.dir, name)).replaceAll('\\', '/');
};

/**
 * The phase of a draft on disk.
 * @param fromDraft the id is known to have been a draft (a reproduction wrote it): caw/tests then means promoted, also when
 *                  the fix report was pruned with its run folder. Otherwise only a fix report says the test was a draft.
 * @returns { phase, next } or undefined (no draft, a test that never was one, or a draft that does not load)
 */
export const fixState = (root, id, { fromDraft = false, cause } = {}) => {
    const runs = runsWithResult(root, id);
    let draft;
    if (existsSync(draftPath(root, id))) {
        try {
            draft = loadDraft(root, id);
        } catch {
            return undefined;
        }
    }
    const fixReport = draft === undefined ? reportOf(root, runs, FIX_REPORT) : undefined;
    const designReport = draft === undefined ? reportOf(root, runs, DESIGN_REPORT) : undefined;
    const promoted = draft === undefined && existsSync(testPath(root, id)) && (fromDraft || fixReport !== undefined || designReport !== undefined);
    const suspected = cause ?? (draft?.red === undefined || isDesignDraft(draft) ? undefined : reproductionOf(root, id)?.cause);
    const results = runs.map(({ runId, result }) => ({ runId, status: result.status, results: result.results, steps: result.steps, pendingDesign: result.pendingDesign }));
    return fixPhase({ id, draft, runs: results, promoted, fixReport, designReport, cause: suspected });
};
