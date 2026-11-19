// caw reproduce: Claude tries to reproduce a bug report on its own, signed in as a test role, optionally from a test's step.
// No plan to approve and no human decisions; Claude reads and operates the page and ends with a verdict. The run writes a
// report and a draft test plan in its run folder, never into caw/tests: adopting the draft stays the human's decision.
// Hard rules (enforced in commands.mjs and run.mjs): only on environments with claude, never production; the agent network
// lock applies; without writable every write request is blocked; no code changes and no advice.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { isAttachValue } from '../shared/attach.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { TEST_DIR } from '../shared/names.mjs';
import { AGENT_CHOICES, splitStep } from './linux.mjs';
import { parseTest, renderTest } from './test-file.mjs';
import { CONTROL, EMAIL, composeTest } from './test-plan.mjs';

const OPTIONS = ['--env', '--role', '--from', '--headless', '--agent', '--attach', '--file'];
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
 * @returns { bug, target?, role?, from?: { test, step? }, headless, agent? }
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

/** The draft's test id from the bug report's first words, e.g. "bug-search-finds-nothing"; free in caw/tests. */
export const draftId = (root, bug) => {
    const words = bug.split('\n')[0].normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
        .filter((word) => word !== '').slice(0, 6);
    const base = `bug-${words.join('-') || 'report'}`.slice(0, 60).replace(/-+$/, '');
    let id = base;
    for (let n = 2; existsSync(join(root, TEST_DIR, `${id}.yaml`)); n += 1) id = `${base}-${n}`;
    return id;
};

const plainText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !CONTROL.test(value);
const rejected = (message) => new CawError('finish-rejected', message);

/**
 * Claude's verdict of a reproduction. Messages go to Claude, so they are in English like the other agent messages.
 * @param fileExists (name) => whether a screenshot exists in the agent folder
 * @returns { reproduced, observed, expected, steps: [{ name, do, expect }], writes, cause?, screenshots }
 */
export const readReproduction = (results, { fileExists = () => false } = {}) => {
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
    return {
        reproduced: results.reproduced,
        observed: results.observed.trim(),
        expected: results.expected.trim(),
        steps: steps.map((step) => ({ name: (step.name ?? shortName(step.do)).trim(), do: step.do.trim(), expect: step.expect.trim() })),
        writes: results.writes,
        ...(results.cause === undefined ? {} : { cause: results.cause.trim() }),
        screenshots,
    };
};

/** A step title from its action: the first words, at most 60 characters, on a word boundary. */
const shortName = (text) => {
    const line = text.split('\n')[0].trim();
    if (line.length <= 60) return line.replace(/[.:;,]$/, '');
    const cut = line.slice(0, 60);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trim()} …`;
};

/**
 * The draft test plan in caw's format, from the steps Claude took: validated like any test file. It never lands in caw/tests
 * by itself; the human copies it there and records it.
 * @returns { id, text }
 */
export const draftTestPlan = ({ id, role, environment, writes, steps, runId }) => {
    const spec = composeTest({ id, ...(role === undefined ? {} : { role }), writes, environments: [environment] }, {
        notes: t('run.reproduce.draftNotes', { run: runId }),
        steps: steps.map((step, index) => ({ id: `S${index + 1}`, name: step.name, do: step.do, expect: step.expect })),
    });
    const text = renderTest(spec);
    // Same rules as a hand-written file: a draft that would not load is no draft.
    parseTest(text);
    return { id, text };
};

/** The command that adopts the draft: copy it into caw/tests, then record it. */
export const adoptHint = (draft, root, runDir) => {
    const from = relative(root, join(runDir, 'draft-test.yaml')).replaceAll('\\', '/');
    return { from, to: `${TEST_DIR}/${draft.id}.yaml`, record: `caw record ${draft.id}` };
};
