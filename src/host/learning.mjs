// What a test is still learning lives on this machine, not in the repository: effects (LEARN_RUNS healthy runs) and looks
// (LOOK_LEARN_RUNS) in .caw/learning/<test>.json until they freeze. Only the run that freezes them writes them into the
// recording, once, ready to review and commit. The learning state never fails a step and audit never sees it, so it is no
// yardstick and does not belong in the repository.
//
// The file: { test, steps: { <step>: { recordedAt, effects?, visual? } } }. `recordedAt` ties an entry to the recording it was
// learned on: once the step is recorded again, the entry no longer applies and learning starts anew.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEARNING_DIR, RUN_DIR } from '../shared/names.mjs';
import { LEARN_RUNS } from './effects.mjs';
import { LOOK_LEARN_RUNS } from './visual.mjs';

/** The learned parts of a recording and the healthy runs after which each one freezes. */
const KINDS = { effects: LEARN_RUNS, visual: LOOK_LEARN_RUNS };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Is this learned part (recording.effects or recording.visual) frozen: as many runs as it learns over? */
export const isFrozen = (kind, value) => isObject(value) && (value.runs ?? 0) >= KINDS[kind];

/** The learning file of a test. */
export const learningPath = (root, id) => join(root, RUN_DIR, LEARNING_DIR, `${id}.json`);

/** The learning state of a test: step -> { recordedAt, effects?, visual? }; {} when there is none or it is unreadable. */
export const readLearning = (root, id) => {
    try {
        const read = JSON.parse(readFileSync(learningPath(root, id), 'utf8'));
        if (isObject(read) && isObject(read.steps)) return Object.fromEntries(Object.entries(read.steps).filter(([, entry]) => isObject(entry)));
    } catch {
        // none yet, or unreadable: learning starts anew
    }
    return {};
};

const writeLearning = (root, id, steps) => {
    const path = learningPath(root, id);
    try {
        if (Object.keys(steps).length === 0) {
            rmSync(path, { force: true });
            return;
        }
        mkdirSync(join(root, RUN_DIR, LEARNING_DIR), { recursive: true });
        writeFileSync(`${path}.tmp`, `${JSON.stringify({ test: id, steps }, null, 2)}\n`);
        renameSync(`${path}.tmp`, path);
    } catch {
        // not writable: the next run learns from what is there
    }
};

/**
 * The test as a run sees it: each step's effects and look that are still being learned come from .caw/learning, as long as the
 * entry belongs to the step's recording. A frozen part in the recording wins over a learning one of the same basis (someone
 * froze it meanwhile and committed it). An older recording that still carries effects or a look that are not frozen keeps them:
 * they are where learning starts, and the next run that learns moves them to .caw/learning.
 */
export const withLearning = (root, spec) => {
    const learning = readLearning(root, spec.id);
    if (Object.keys(learning).length === 0) return spec;
    return {
        ...spec,
        steps: spec.steps.map((step) => {
            const entry = learning[step.id];
            const { recording } = step;
            if (entry === undefined || recording === undefined || entry.recordedAt !== recording.recordedAt) return step;
            let seen = recording;
            for (const kind of Object.keys(KINDS)) {
                const learned = entry[kind];
                if (!isObject(learned)) continue;
                if (isFrozen(kind, recording[kind]) && recording[kind].basis === learned.basis) continue;
                seen = { ...seen, [kind]: learned };
            }
            return seen === recording ? step : { ...step, recording: seen };
        }),
    };
};

/**
 * Splits what is about to be written: frozen effects and looks go into the recording, the ones still learning into
 * .caw/learning. A frozen part that learns anew (an earlier step was recorded again, so its basis changed) leaves the recording
 * with the first learning run: no run compares against it any more, and audit must not count it as in force. A step written
 * without effects or look (forgotten, recorded again) clears its learning state.
 * @param written (id) => whether the step's recording is written from `spec`
 * @param whole   the whole test is written: entries of steps no longer in it go
 * @returns the test with recordings as the file gets them
 */
export const splitLearning = (root, spec, written, { whole = false } = {}) => {
    const learning = readLearning(root, spec.id);
    const was = JSON.stringify(learning);
    if (whole) for (const id of Object.keys(learning)) if (!spec.steps.some((step) => step.id === id)) delete learning[id];
    const steps = spec.steps.map((step) => {
        if (!written(step.id)) return step;
        const { recording } = step;
        if (recording === undefined) {
            delete learning[step.id];
            return step;
        }
        const entry = { recordedAt: recording.recordedAt };
        const file = { ...recording };
        for (const kind of Object.keys(KINDS)) {
            const value = recording[kind];
            delete file[kind];
            if (isFrozen(kind, value)) file[kind] = value;
            else if (value !== undefined) entry[kind] = value;
        }
        if (entry.effects === undefined && entry.visual === undefined) delete learning[step.id];
        else learning[step.id] = entry;
        return { ...step, recording: file };
    });
    if (JSON.stringify(learning) !== was) writeLearning(root, spec.id, learning);
    return { ...spec, steps };
};
