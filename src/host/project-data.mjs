// Project data for the Claude Code session (caw mcp): what validate, list and init do, as plain data. Nothing here prints
// or reads stdin, because in the MCP process stdout and stdin are the protocol channel.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTH_DIR, loadConfig, loadConfigWithNotes, todoFields } from '../shared/config.mjs';
import { startPath } from '../shared/environments.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, ENV_FILE, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { describeCode } from './code-source.mjs';
import { answersFromExplore, detectApp, envExample, starterConfig } from './commands.mjs';
import { ensureMcpEntry } from './mcp-entry.mjs';
import { SKILL_PATH, skillState, writeSkill } from './skill.mjs';
import { projectPath } from './project-path.mjs';
import { EXPLORE_FILE } from './explore.mjs';
import { brokenChain, checkTest, environmentProblems, loadTest, recordingHints, staleSteps, withDefaults } from './test-file.mjs';


const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

const namesIn = (map) => Object.keys(map ?? {}).join(', ') || '–';

/** What makes a test unrunnable on every environment: its role. Same texts as `testBasics` in commands.mjs. */
const testBasics = (spec, config) => {
    const problems = [];
    const id = String(spec.id);
    if (spec.role === undefined && config.roles !== undefined) problems.push(t('config.test.check.role', { id, roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.role !== undefined && config.roles?.[spec.role] === undefined) problems.push(t('config.test.check.unknownRole', { role: String(spec.role), roles: namesIn(config.roles), config: CONFIG_FILE }));
    return problems;
};

/** Which code runs per environment: deployed, and what an overlay would bring (null: no overlay possible; several: a choice is needed). */
const codeOn = (spec, target, config) => {
    const code = describeCode(config, spec, checkTest(spec, target, config));
    const overlayWith = (flag) => {
        try {
            return describeCode(config, spec, checkTest(spec, target, config, { overlay: flag }));
        } catch {
            return null;
        }
    };
    const plain = overlayWith(true);
    const choices = ['build', 'dev'].map((flag) => ({ flag, code: overlayWith(flag) })).filter(({ code: text }) => text !== null);
    return { env: target, code, overlay: plain ?? (choices.length === 0 ? null : Object.fromEntries(choices.map(({ flag, code: text }) => [flag, text]))) };
};

/** One test for validate: problems (unrunnable), hints (stale or unrecorded steps) and the code per environment. */
const validateTest = (root, id, config) => {
    const file = `${id}.yaml`;
    const entry = { id, problems: [], hints: [], code: [] };
    try {
        const spec = withDefaults(loadTest(root, id), config);
        entry.problems.push(...testBasics(spec, config), ...environmentProblems(spec, config));
        if (spec.runsOn.length === 0) entry.problems.push(t('cli.validateNowhere', { id: spec.id }));
        if (entry.problems.length > 0) return entry;
        for (const target of spec.runsOn) {
            try {
                entry.code.push(codeOn(spec, target, config));
            } catch (error) {
                entry.problems.push(`${target}: ${error.message}`);
            }
        }
        const chain = brokenChain(spec);
        if (chain !== null) entry.hints.push(t('cli.validateChain', { file, chain }));
        const stale = staleSteps(spec);
        if (stale.length === spec.steps.length && spec.steps.every(({ recording }) => recording === undefined)) entry.hints.push(t('cli.validateNotRecorded', { file }));
        else for (const { id: step, why } of stale) entry.hints.push(`${step} ${why}.`);
    } catch (error) {
        entry.problems.push(error.message);
    }
    return entry;
};

/**
 * `caw validate` as data. `ok` is false when the config is invalid or has TODO values, or a test has a problem.
 * @returns { ok, config: { issues, todo, notes }, tests: [{ id, problems, hints, code: [{ env, code, overlay }] }], recordings: { problems, hints } }
 */
export const validateProject = (root) => {
    const recordings = { problems: [], hints: [] };
    let loaded;
    try {
        loaded = loadConfigWithNotes(root);
    } catch (error) {
        const issues = Array.isArray(error?.issues) ? error.issues : [String(error?.message ?? error)];
        return { ok: false, code: error?.code ?? 'config-invalid', config: { issues, todo: [], notes: [] }, tests: [], recordings };
    }
    const { config, notes, todo } = loaded;
    const tests = testIds(root).map((id) => validateTest(root, id, config));
    try {
        recordings.hints.push(...recordingHints(root));
    } catch (error) {
        recordings.problems.push(error.message);
    }
    const ok = todo.length === 0 && recordings.problems.length === 0 && tests.every(({ problems }) => problems.length === 0);
    return { ok, config: { issues: [], todo, notes }, tests, recordings };
};

/** How far a test is recorded: recorded, stale (with the steps) or none. Same as `recordingState` in commands.mjs. */
const recordingState = (spec) => {
    if (spec.steps.every(({ recording }) => recording === undefined)) return { state: 'none', stale: [] };
    const stale = staleSteps(spec).map(({ id }) => id);
    const chain = brokenChain(spec);
    if (stale.length === 0 && chain === null) return { state: 'recorded', stale: [] };
    return { state: 'stale', stale, ...(chain === null ? {} : { chain }) };
};

/**
 * `caw list` as data: per test start path, role, environments, whether it writes and the recording state per step. Without a
 * readable config the tests are listed as written (no defaults for role and environments).
 * @returns { config: 'ok'|'missing'|'invalid', tests: [{ id, start, role, environments, writes, recording, steps: [{ id, name, recording }] } | { id, error }] }
 */
export const listProject = (root) => {
    let config = null;
    let state = 'ok';
    try {
        config = loadConfig(root);
    } catch (error) {
        state = error?.code === 'config-missing' ? 'missing' : 'invalid';
    }
    const tests = testIds(root).map((id) => {
        try {
            const raw = loadTest(root, id);
            const spec = config === null ? raw : withDefaults(raw, config);
            const recording = recordingState(spec);
            const stale = new Set(recording.stale);
            return {
                id,
                start: config === null ? (spec.start ?? null) : startPath(config, spec),
                role: spec.role ?? null,
                environments: spec.runsOn ?? spec.environments ?? [],
                writes: spec.writes !== false,
                recording,
                steps: spec.steps.map((step) => ({
                    id: step.id,
                    name: step.name ?? '',
                    recording: step.recording === undefined ? 'none' : stale.has(step.id) ? 'stale' : 'recorded',
                })),
            };
        } catch (error) {
            return { id, error: String(error.message).split('\n')[0] };
        }
    });
    return { config: state, tests };
};

/**
 * `caw init` without questions and without explore: from caw/.explore.json (fromExplore: true or a path), otherwise offline
 * (template, TODO in the login). Existing files stay untouched.
 * @returns { state: 'done', created, skipped, todo, explored } or { state: 'explore-first' } when a URL is given but nothing was explored yet
 */
export const initProject = (root, { url, offline = false, fromExplore, roles, noMcp = false, env, language, insecureTls = false, allowHttp = false } = {}) => {
    const exploreFile = typeof fromExplore === 'string' ? fromExplore : EXPLORE_FILE;
    const useExplore = fromExplore !== undefined && fromExplore !== false ? true : !offline && url === undefined && existsSync(join(root, EXPLORE_FILE));
    if (!useExplore && !offline && url !== undefined) return { state: 'explore-first', url };
    let answers = { offline: true, ...(url === undefined ? {} : { url }) };
    if (useExplore) {
        // The path comes from the session: inside the project only, and a parse error is not echoed (it can quote the file).
        const file = projectPath(root, exploreFile);
        if (file === null) throw new CawError('usage', t('cli.fromOutside', { from: exploreFile }));
        let suggestion;
        try {
            suggestion = JSON.parse(readFileSync(file, 'utf8'));
        } catch (error) {
            throw new CawError('usage', t('cli.fromUnreadable', { from: exploreFile, message: error?.code === 'ENOENT' ? t('cli.fromMissing') : t('cli.fromNotJson') }));
        }
        answers = answersFromExplore(suggestion);
    }
    if (roles !== undefined) answers.roles = roles;
    // What the session decided: the environment's name, the team language and the address switches, persisted on the environment.
    Object.assign(answers, env === undefined ? {} : { env }, language === undefined ? {} : { language }, insecureTls ? { insecureTls: true } : {}, allowHttp ? { allowHttp: true } : {});

    const created = [];
    const skipped = [];
    const updated = [];
    const write = (target, content) => {
        const path = join(root, target);
        if (existsSync(path)) {
            skipped.push(target);
            return;
        }
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
        created.push(target);
    };
    const detected = detectApp(root);
    const config = starterConfig({ framework: detected.framework, ...answers });
    write(CONFIG_FILE, `${JSON.stringify(config, null, 4)}\n`);
    const example = envExample(config);
    if (example !== null) write(`${ENV_FILE}.example`, example);
    if (!existsSync(join(root, TEST_DIR))) write(`${TEST_DIR}/.gitkeep`, '');
    write(CONTEXT_FILE, t('cli.contextTemplate'));
    if (!noMcp) {
        const mcp = ensureMcpEntry(root);
        if (mcp === 'created') created.push('.mcp.json');
        else if (mcp === 'updated') updated.push('.mcp.json');
        else skipped.push(mcp === 'invalid' ? '.mcp.json (invalid JSON)' : '.mcp.json');
        // The skill caw-attach comes with the entry, as with caw init; a file somebody wrote stays as it is.
        const skill = skillState(root);
        if (skill === 'foreign' || skill === 'current') skipped.push(SKILL_PATH);
        else {
            writeSkill(root);
            (skill === 'missing' ? created : updated).push(SKILL_PATH);
        }
    }
    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    const lines = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`].filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length > 0) {
        appendFileSync(ignore, `\n# caw\n${lines.join('\n')}\n`);
        created.push('.gitignore');
    }
    // The TODO fields of the config on disk: a kept older config counts, not the one that was not written.
    let todo = todoFields(config);
    if (!created.includes(CONFIG_FILE)) {
        try {
            todo = todoFields(JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')));
        } catch {
            todo = [];
        }
    }
    return { state: 'done', created, skipped, ...(updated.length === 0 ? {} : { updated, restart: true }), todo, explored: useExplore };
};
