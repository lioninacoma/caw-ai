// caw reproduce: Claude tries to reproduce a bug report on its own, signed in as a test role, optionally from a test's step.
// No plan to approve and no human decisions; Claude reads and operates the page and ends with a verdict. The run writes a
// report and, when reproduced, a draft in caw/drafts, never into caw/tests: recorded red, fixed and green, only
// `caw run <draft> --promote` moves it there.
// Hard rules (enforced in commands.mjs and run.mjs): only on environments with claude, never production; the agent network
// lock applies; without writable every write request is blocked; no code changes and no advice.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { isAttachValue } from '../shared/attach.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { DRAFT_DIR, REF_PATTERN, TEST_DIR } from '../shared/names.mjs';
import { AGENT_CHOICES, splitStep } from './linux.mjs';
import { newestRunOf } from './runs.mjs';
import { loadTest, parseTest, renderTest, staleSteps, testExists, testPath } from './test-file.mjs';
import { CONTROL, EMAIL, composeTest } from './test-plan.mjs';

const OPTIONS = ['--env', '--role', '--from', '--headless', '--agent', '--attach', '--file', '--ref'];
// A bug report is a paragraph or a page, not a document.
const MAX_BUG = 8000;
const MAX_STEPS = 20;
const VERDICTS = ['yes', 'no', 'unclear'];

const usage = (key, vars) => new CawError('usage', t(key, vars));
const valueOf = (flag, value) => {
    if (value === undefined || value === '' || value.startsWith('--')) throw usage('session.args.valueMissing', { flag, example: flag === '--from' ? 'checkout@S3' : flag === '--file' ? 'bug.md' : 'local' });
    return value;
};

/**
 * The command line of caw reproduce. The bug report comes as the one argument, from --file, or from stdin with "-".
 * @param readStdin () => the text on stdin (only called for "-")
 * @returns { bug, target?, role?, from?: { test, step? }, headless, agent?, ref? }
 */
export const parseReproduceArgs = (args, { root, readStdin = () => readFileSync(0, 'utf8') } = {}) => {
    const options = { headless: false };
    let text;
    let file;
    const rest = [...args];
    while (rest.length > 0) {
        const arg = rest.shift();
        if (arg !== '-' && !arg.startsWith('--')) {
            if (text !== undefined) throw usage('session.args.unexpected', { arg });
            text = arg;
            continue;
        }
        if (arg === '-') {
            if (text !== undefined) throw usage('session.args.unexpected', { arg });
            text = readStdin();
            continue;
        }
        const [flag, inline] = arg.split(/=(.*)/s);
        if (!OPTIONS.includes(flag)) throw usage('session.args.unknownOption', { command: 'reproduce', flag, allowed: OPTIONS.join(', ') });
        if (flag === '--headless') {
            options.headless = true;
            continue;
        }
        // --attach: the person's own session reproduces; it may name the session (its key) or stand alone.
        if (flag === '--attach') {
            options.attach = inline ?? (isAttachValue(rest[0]) ? rest.shift() : true);
            continue;
        }
        const value = valueOf(flag, inline ?? rest.shift());
        if (flag === '--env') options.target = value;
        else if (flag === '--role') options.role = value;
        else if (flag === '--file') file = value;
        else if (flag === '--ref') {
            if (!REF_PATTERN.test(value)) throw usage('cli.reproduceRef', { ref: value.slice(0, 80) });
            options.ref = value;
        }
        else if (flag === '--agent') {
            if (!AGENT_CHOICES.includes(value)) throw usage('session.args.agentChoice', { choices: AGENT_CHOICES.join(', ') });
            options.agent = value;
        } else options.from = splitStep(value);
    }
    if (file !== undefined && text !== undefined) throw usage('cli.reproduceOneSource');
    if (file !== undefined) text = readBugFile(root, file);
    const bug = typeof text === 'string' ? text.replaceAll('\r\n', '\n').trim() : '';
    if (bug === '') throw usage('cli.reproduceBugMissing');
    if (bug.length > MAX_BUG) throw usage('cli.reproduceBugLong', { max: MAX_BUG });
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(bug)) throw usage('cli.reproduceBugControl');
    if (options.attach !== undefined && options.agent !== undefined) throw usage('session.args.clash', { without: '--attach', other: '--agent' });
    if (options.from !== undefined && options.role !== undefined) throw usage('session.args.openWithTest', { flag: '--role' });
    return { ...options, bug };
};

/** A bug report from a file: a regular text file, relative to the project or absolute, never a folder or something huge. */
const readBugFile = (root, file) => {
    const path = isAbsolute(file) ? file : resolve(root ?? process.cwd(), file);
    if (!existsSync(path) || !statSync(path).isFile()) throw usage('cli.reproduceFileMissing', { file });
    if (statSync(path).size > MAX_BUG * 4) throw usage('cli.reproduceBugLong', { max: MAX_BUG });
    return readFileSync(path, 'utf8');
};

/** The draft's test id from the bug report's first words, e.g. "bug-search-finds-nothing"; free in caw/tests and caw/drafts. */
export const draftId = (root, bug) => {
    const words = bug.split('\n')[0].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
        .filter((word) => word !== '').slice(0, 6);
    const base = `bug-${words.join('-') || 'report'}`.slice(0, 60).replace(/-+$/, '');
    let id = base;
    for (let n = 2; testExists(root, id); n += 1) id = `${base}-${n}`;
    return id;
};

const plainText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL.test(value);
const rejected = (message) => new CawError('finish-rejected', message);

/**
 * Claude's verdict of a reproduction. Messages go to Claude, so they are in English like the other agent messages.
 * @param fileExists (name) => whether a screenshot exists in the agent folder
 * @param coverage   ({ test, step? }) => the covering test's newest run or undefined; throws when it is no recorded test
 * @returns { reproduced, observed, expected, steps: [{ name, do, expect }], writes, cause?, covered?, screenshots }
 */
export const readReproduction = (results, { fileExists = () => false, coverage = () => undefined } = {}) => {
    if (results === null || typeof results !== 'object') throw rejected('finish needs { reproduced, observed, expected, steps, writes }.');
    if (!VERDICTS.includes(results.reproduced)) throw rejected('reproduced is yes (the bug shows as reported), no (it does not) or unclear.');
    for (const key of ['observed', 'expected']) {
        if (!plainText(results[key], 2000)) throw rejected(`${key} is a short text: what the page did, and what the bug report expects instead.`);
    }
    const { steps } = results;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) throw rejected(`steps lists 1 to ${MAX_STEPS} steps you took, each { do, expect } in plain language.`);
    steps.forEach((step, index) => {
        if (!plainText(step?.do, 600) || !plainText(step?.expect, 600)) throw rejected(`steps[${index}] needs do and expect as plain text.`);
        if (step.name !== undefined && (!plainText(step.name, 80) || step.name.includes('\n'))) throw rejected(`steps[${index}].name is a short single-line title.`);
        if ([step.do, step.expect, step.name ?? ''].some((text) => EMAIL.test(text))) throw rejected(`steps[${index}] contains an email address; describe the account by its role instead.`);
    });
    // Whether the steps create, change or delete data: the draft's writes, so recording it needs no question.
    if (typeof results.writes !== 'boolean') throw rejected('writes is true when your steps create, change or delete data in the app (like adding a todo), otherwise false.');
    if (results.cause !== undefined && !plainText(results.cause, 2000)) throw rejected('cause is a short text (with file:line if you read the source), or leave it out.');
    const screenshots = results.screenshots ?? [];
    if (!Array.isArray(screenshots) || screenshots.length > 10 || !screenshots.every((name) => typeof name === 'string' && /^[\w.-]+\.png$/.test(name))) {
        throw rejected('screenshots lists up to 10 file names you took with screenshot.');
    }
    const missing = screenshots.filter((name) => !fileExists(name));
    if (missing.length > 0) throw rejected(`No such screenshot: ${missing.join(', ')}.`);
    const covered = readCovered(results.covered, results.reproduced, coverage);
    return {
        reproduced: results.reproduced,
        observed: results.observed.trim(),
        expected: results.expected.trim(),
        steps: steps.map((step) => ({ name: (step.name ?? shortName(step.do)).trim(), do: step.do.trim(), expect: step.expect.trim() })),
        writes: results.writes,
        ...(results.cause === undefined ? {} : { cause: results.cause.trim() }),
        ...(covered === undefined ? {} : { covered }),
        screenshots,
    };
};

/**
 * `covered`: Claude names an existing test that already checks the reported behaviour, with that test's newest run. Its last
 * run passed while the bug may be there (reproduced or unclear): its check may miss the bug, which is worth a hint.
 */
const readCovered = (covered, reproduced, coverage) => {
    if (covered === undefined) return undefined;
    if (covered === null || typeof covered !== 'object' || Array.isArray(covered)) throw rejected('covered is { test, step?, why }: an existing test that already covers the reported behaviour, or leave it out.');
    if (typeof covered.test !== 'string' || !/^[\w.-]{1,80}$/.test(covered.test)) throw rejected('covered.test is the id of a test in knownTests (its file name without .yaml).');
    if (covered.step !== undefined && (typeof covered.step !== 'string' || !/^S[1-9]\d*$/.test(covered.step))) throw rejected('covered.step is a step id like S3, or leave it out.');
    if (!plainText(covered.why, 600)) throw rejected('covered.why is a short text: why this test covers the reported behaviour.');
    const lastRun = coverage({ test: covered.test, ...(covered.step === undefined ? {} : { step: covered.step }) });
    return {
        test: covered.test,
        ...(covered.step === undefined ? {} : { step: covered.step }),
        why: covered.why.trim(),
        ...(lastRun === undefined ? {} : { lastRun }),
        ...(lastRun?.status === 'pass' && reproduced !== 'no' ? { checkMayMiss: true } : {}),
    };
};

/**
 * Checks a covering test on disk: it exists in caw/tests and is recorded (with a step: that step), since a test without a
 * recording checks nothing yet. Returns its newest run in .caw/runs, undefined when none is left.
 */
export const coverageIn = (root) => ({ test, step }) => {
    if (!existsSync(testPath(root, test))) throw rejected(`covered.test: there is no test ${test} in ${TEST_DIR}. Name one of knownTests, or leave covered out.`);
    let spec;
    try {
        spec = loadTest(root, test);
    } catch (error) {
        throw rejected(`covered.test: ${test} does not load (${String(error.message).split('\n')[0]}). Leave covered out.`);
    }
    const stale = new Set(staleSteps(spec).map(({ id }) => id));
    if (step !== undefined) {
        if (!spec.steps.some(({ id }) => id === step)) throw rejected(`covered.step: ${test} has no step ${step}; its steps are ${spec.steps.map(({ id }) => id).join(', ')}.`);
        if (stale.has(step)) throw rejected(`covered.step: ${test}@${step} is not recorded (or changed since), so it checks nothing yet. Leave covered out.`);
    } else if (spec.steps.length === 0 || stale.size > 0) {
        throw rejected(`covered.test: ${test} is not fully recorded (${[...stale].join(', ') || 'no steps'}), so it does not check everything yet. Name the recorded step with covered.step, or leave covered out.`);
    }
    return newestRunOf(root, test);
};

/** A step title from its action: the first words, at most 60 characters, on a word boundary. */
const shortName = (text) => {
    const line = text.split('\n')[0].trim();
    if (line.length <= 60) return line.replace(/[.:;,]$/, '');
    const cut = line.slice(0, 60);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trim()} …`;
};

// The trail in the notes stays a hint, not a second recording.
const MAX_TRAIL = 40;

/**
 * The draft test plan in caw's format, from the steps Claude took: validated like a draft in caw/drafts. Its last step is the
 * one that must fail while the bug is there; recording it proves that (topic record).
 * @param trail what Claude did in the browser, with resolved locators (`click getByRole('button', …)`): in the notes as
 *              orientation for recording
 * @param cause the cause the agent suspected, with its evidence: in the notes, so whoever fixes the bug later still has it
 * @returns { id, text }
 */
export const draftTestPlan = ({ id, role, environment, writes, steps, runId, ref, cause, trail = [] }) => {
    // The ticket id stays with the test once promoted: where the bug came from.
    const intro = ref === undefined ? t('run.reproduce.draftNotes', { run: runId }) : t('run.reproduce.draftNotesRef', { run: runId, ref });
    const head = cause === undefined ? intro : [intro, t('run.reproduce.draftCause', { cause: cause.replace(/\s+/g, ' ') })].join('\n');
    const shown = trail.slice(0, MAX_TRAIL).map((line) => `- ${line.replace(/\s+/g, ' ')}`);
    const more = trail.length > MAX_TRAIL ? [t('run.reproduce.draftTrailMore', { count: trail.length - MAX_TRAIL })] : [];
    const spec = composeTest({ id, ...(role === undefined ? {} : { role }), writes, environments: [environment] }, {
        notes: shown.length === 0 ? head : [head, '', t('run.reproduce.draftTrail'), ...shown, ...more].join('\n'),
        steps: steps.map((step, index) => ({ id: `S${index + 1}`, name: step.name, do: step.do, expect: step.expect })),
    });
    const text = renderTest(spec);
    // Same rules as a hand-written file: a draft that would not load is no draft.
    parseTest(text, `${DRAFT_DIR}/${id}.yaml`, { draft: true });
    return { id, text };
};

/** Where the draft is and the command that records it. */
export const draftHint = (draft) => ({ file: `${DRAFT_DIR}/${draft.id}.yaml`, record: `caw record ${draft.id}` });
