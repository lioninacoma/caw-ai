// The guided bug fix: where a draft from caw reproduce stands on its way to a proven fix, and what comes next. reproduced (the
// draft is written, not yet recorded red), red (recorded red, the bug is still there), green (a run after the red one judged the
// red step and passed: the bug is fixed) and promoted (the test is in caw/tests, the run folder has fix-report.md). The workbench guides a person
// through these phases in one process; the session reads them from caw_status and caw_reproductions as `phase` and `next`.

import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { DRAFT_DIR } from '../shared/names.mjs';
import { REPRODUCE_RUN, runsWithResult } from './runs.mjs';
import { draftPath, loadDraft, testPath } from './test-file.mjs';
import { PHASE_DECISIONS } from './decisions.mjs';

export const FIX_PHASES = ['reproduced', 'red', 'green', 'promoted'];
export const FIX_REPORT = 'fix-report.md';

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
 * @returns { phase, next } or undefined when there is no draft and nothing was promoted. 
ext.decision names the window's card at
 *          that phase (decisions.mjs PHASE_DECISIONS): a run that waits on it is answered with caw_decide, not started anew
 */
export const fixPhase = ({ id, draft, runs = [], promoted = false, fixReport, cause }) => {
    if (draft === undefined) return promoted ? { phase: 'promoted', next: { done: true, ...(fixReport === undefined ? {} : { fixReport }) } } : undefined;
    const run = { tool: 'caw_start', command: 'run', test: id };
    if (draft.red === undefined) return { phase: 'reproduced', next: { tool: 'caw_start', command: 'record', test: id, decision: PHASE_DECISIONS.reproduced } };
    // Run ids start with their time: a later id is a later run. Only a run after the red proof shows the fix, and only if it
    // judged the red step and passed it: an open at the red step's entry passes without ever checking it.
    const newest = runs.find(({ runId }) => runId > draft.red.run);
    const judged = Array.isArray(newest?.results) && newest.results.some((item) => item?.id === draft.red.step && item.status === 'pass');
    if (newest?.status === 'pass' && judged) return { phase: 'green', next: { ...run, promote: true, decision: PHASE_DECISIONS.green } };
    return { phase: 'red', next: { do: 'fix-app', red: redOf(draft, cause), then: run, decision: PHASE_DECISIONS.red } };
};

/** The reproduction that wrote this draft: its cause, if the run folder is still there. */
export const reproductionOf = (root, id) => {
    const file = `${DRAFT_DIR}/${id}.yaml`;
    return runsWithResult(root, REPRODUCE_RUN).find(({ result }) => result.reproduce?.draft?.file === file)?.result.reproduce;
};

/** The newest fix report of the id, relative to the project with /, or undefined. */
const fixReportOf = (root, runs) => {
    const found = runs.find(({ dir }) => existsSync(join(dir, FIX_REPORT)));
    return found === undefined ? undefined : relative(root, join(found.dir, FIX_REPORT)).replaceAll('\\', '/');
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
    const fixReport = draft === undefined ? fixReportOf(root, runs) : undefined;
    const promoted = draft === undefined && existsSync(testPath(root, id)) && (fromDraft || fixReport !== undefined);
    const suspected = cause ?? (draft?.red === undefined ? undefined : reproductionOf(root, id)?.cause);
    return fixPhase({ id, draft, runs: runs.map(({ runId, result }) => ({ runId, status: result.status, results: result.results })), promoted, fixReport, cause: suspected });
};
