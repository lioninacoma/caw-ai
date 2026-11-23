// The run folders in .caw/runs: every run and every open leaves one (report, trace, chat log). caw keeps the newest ones
// (keepRuns, default 30) and deletes older ones when a run starts; a run whose process still lives is never deleted, nor a
// reproduction whose draft is still in caw/drafts: it holds the suspected cause the guided fix shows (bugfix.mjs).

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { RUN_DIR } from '../shared/names.mjs';
import { isAlive } from '../shared/session-agent.mjs';

export const DEFAULT_KEEP_RUNS = 30;
const ALIVE_FILE = '.alive';

/** Marks a run folder as belonging to this process, so no other run deletes it while it is open. */
export const markRunAlive = (runDir, pid = process.pid) => writeFileSync(join(runDir, ALIVE_FILE), JSON.stringify({ pid }));

const openNow = (dir) => {
    try {
        return isAlive(JSON.parse(readFileSync(join(dir, ALIVE_FILE), 'utf8')).pid);
    } catch {
        return false;
    }
};

/** A reproduction whose draft is still in caw/drafts: the draft names this run, and its verdict holds the cause. */
const draftStillThere = (root, dir, name) => {
    if (RUN_ID.exec(name)?.[6] !== REPRODUCE_RUN) return false;
    const file = readResult(dir)?.reproduce?.draft?.file;
    return typeof file === 'string' && existsSync(join(root, file));
};

/**
 * Deletes the oldest run folders beyond `keep`. Run ids start with their time, so the name order is the age order.
 * @param keep   how many to keep; 0 keeps all
 * @param except the run that is starting now
 * @returns the names deleted
 */
export const pruneRuns = (root, keep = DEFAULT_KEEP_RUNS, { except } = {}) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (keep === 0 || !existsSync(runs)) return [];
    const names = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
    const deleted = [];
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
        if (name === except || openNow(join(runs, name)) || draftStillThere(root, join(runs, name), name)) continue;
        try {
            rmSync(join(runs, name), { recursive: true, force: true, maxRetries: 2 });
            deleted.push(name);
        } catch {
            // A file still in use (a report open in an editor): it goes with the next start.
        }
    }
    return deleted;
};

/** The run folder name of every reproduction, with or without a starting test: `<time>-reproduce`. */
export const REPRODUCE_RUN = 'reproduce';
// A run id is its start time with - for : and ., then the test id (run.mjs).
const RUN_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/;

/** When a run started, from its id, as an ISO date; undefined for a folder that is no run. */
export const runDate = (runId) => {
    const match = RUN_ID.exec(runId);
    return match === null ? undefined : `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
};

const readResult = (dir) => {
    try {
        return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    } catch {
        return undefined;
    }
};

/** The run folders of one name with their result, newest first; a folder without a readable result.json has none to give. */
export const runsWithResult = (root, name) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (!existsSync(runs)) return [];
    return readdirSync(runs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && RUN_ID.exec(entry.name)?.[6] === name)
        .map(({ name: runId }) => ({ runId, dir: join(runs, runId), result: readResult(join(runs, runId)) }))
        .filter(({ result }) => typeof result?.status === 'string')
        .sort((a, b) => b.runId.localeCompare(a.runId));
};

// Answers that change a test, a recording, the config or the app's code, as a person clicks them in the window.
const CHANGING = new Set(['adopt', 'accept', 'apply', 'use-target', 'adopt-look', 'forget-effect', 'ignore-errors', 'promote']);
const OUTSIDE_WINDOW = new Set(['auto', 'session', 'elicitation', 'terminal']);

/**
 * The decisions taken outside the window that changed something: by caw itself (a run without a window), by the session
 * (caw_decide), by the person in the session (elicitation) or at the terminal of a run without a window (terminal). Newest first; for caw audit.
 * @param since a date: only runs started at or after it
 * @returns [{ run, test, decision, option, by, known? }]: known, the messages adopted as the baseline of steps recorded for the first time
 */
export const decisionsOutsideWindow = (root, { since } = {}) => {
    const runs = join(root, RUN_DIR, 'runs');
    if (!existsSync(runs)) return [];
    const from = since === undefined ? undefined : Date.parse(since);
    return readdirSync(runs).filter((runId) => RUN_ID.test(runId) && (from === undefined || Date.parse(runDate(runId)) >= from))
        .flatMap((runId) => (readResult(join(runs, runId))?.decisions ?? [])
            .filter(({ by, option }) => OUTSIDE_WINDOW.has(by) && CHANGING.has(option))
            .map(({ id, option, by, known }) => ({ run: runId, test: RUN_ID.exec(runId)[6], decision: id, option, by, ...(Array.isArray(known) && known.length > 0 ? { known } : {}) })))
        .sort((a, b) => b.run.localeCompare(a.run));
};

/** A test's newest run with a result (run, record or open): { status, runId, date }, or undefined if none is left. */
export const newestRunOf = (root, testId) => {
    const [newest] = runsWithResult(root, testId);
    return newest === undefined ? undefined : { status: newest.result.status, runId: newest.runId, date: runDate(newest.runId) };
};

/**
 * The reproductions in .caw/runs as rows for the session, newest first. `refs` keeps only runs with one of these ids and
 * names those without any run as missing (never run, or pruned by keepRuns); `since` keeps runs started at or after it.
 * @returns { reproductions: [{ runId, date, ref?, status, reproduced, observed?, expected?, cause?, covered?, draft?, report }], missing: [ref] }
 */
export const listReproductions = (root, { refs, since } = {}) => {
    const from = since === undefined ? undefined : Date.parse(since);
    const rows = runsWithResult(root, REPRODUCE_RUN)
        .filter(({ runId }) => from === undefined || Date.parse(runDate(runId)) >= from)
        .filter(({ result }) => refs === undefined || refs.includes(result.reproduce?.ref))
        .map(({ runId, dir, result }) => {
            const { ref, reproduced, observed, expected, cause, covered, draft } = result.reproduce ?? {};
            return {
                runId,
                date: runDate(runId),
                ...(ref === undefined ? {} : { ref }),
                status: result.status,
                // null: the run ended before a verdict (state not reached, browser closed, no finish).
                reproduced: reproduced ?? null,
                ...(observed === undefined ? {} : { observed }),
                ...(expected === undefined ? {} : { expected }),
                ...(cause === undefined ? {} : { cause }),
                ...(covered === undefined ? {} : { covered }),
                ...(draft === undefined ? {} : { draft: draft.file }),
                report: relative(root, join(dir, 'report.md')).replaceAll('\\', '/'),
            };
        });
    const missing = refs === undefined ? [] : refs.filter((ref) => !rows.some((row) => row.ref === ref));
    return { reproductions: rows, missing };
};
