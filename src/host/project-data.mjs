// Project data for the Claude Code session (caw-ai mcp): what validate, list and init do, as plain data. Nothing here prints
// or reads stdin, because in the MCP process stdout and stdin are the protocol channel.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AUTH_DIR, authOf, loadConfig, loadConfigWithNotes, resolveTarget, todoFields } from '../shared/config.mjs';
import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE, ENV_FILE, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { describeCode } from './code-source.mjs';
import { answersFromExplore, detectApp, mcpEntry, starterConfig } from './commands.mjs';
import { EXPLORE_FILE } from './explore.mjs';
import { templatePath } from './sandbox-config.mjs';
import { brokenChain, checkTest, loadTest, recordingHints, staleSteps, withDefaults } from './test-file.mjs';

const SKILL_FILE = '.claude/skills/caw-ai/SKILL.md';

const testIds = (root) => {
    const dir = join(root, TEST_DIR);
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.yaml')).map((name) => name.slice(0, -'.yaml'.length)).sort() : [];
};

const namesIn = (map) => Object.keys(map ?? {}).join(', ') || '–';

/** What makes a test unrunnable on every target: app, its startUrl, also and role. Same texts as `testBasics` in commands.mjs. */
const testBasics = (spec, config) => {
    const problems = [];
    const id = String(spec.id);
    if (spec.app === undefined) problems.push(t('config.test.check.appMissing', { id, apps: namesIn(config.apps), config: CONFIG_FILE }));
    else if (config.apps[spec.app] === undefined) problems.push(t('config.test.check.app', { app: String(spec.app), apps: namesIn(config.apps), config: CONFIG_FILE }));
    else if (config.apps[spec.app].startUrl === undefined) problems.push(t('config.test.check.startUrl', { app: String(spec.app) }));
    for (const name of spec.also ?? []) {
        if (config.apps[name] === undefined) problems.push(t('config.test.check.also', { app: String(name), apps: namesIn(config.apps), config: CONFIG_FILE }));
    }
    if (spec.role === undefined && authOf(config).type !== 'none') problems.push(t('config.test.check.role', { id, type: authOf(config).type, roles: namesIn(config.roles), config: CONFIG_FILE }));
    if (spec.role !== undefined && config.roles?.[spec.role] === undefined) problems.push(t('config.test.check.unknownRole', { role: String(spec.role), roles: namesIn(config.roles), config: CONFIG_FILE }));
    return problems;
};

/** Which code runs per target: deployed, and what an overlay would bring (null: no overlay possible; several: a choice is needed). */
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
    return { target, code, overlay: plain ?? (choices.length === 0 ? null : Object.fromEntries(choices.map(({ flag, code: text }) => [flag, text]))) };
};

/** One test for validate: problems (unrunnable), hints (stale or unrecorded steps) and the code per target. */
const validateTest = (root, id, config) => {
    const file = `${id}.yaml`;
    const entry = { id, problems: [], hints: [], code: [] };
    try {
        const spec = withDefaults(loadTest(root, id), config);
        const badTargets = spec.targets.flatMap((target) => {
            try {
                resolveTarget(config, target);
                return [];
            } catch (error) {
                return [`${target}: ${error.message}`];
            }
        });
        entry.problems.push(...testBasics(spec, config), ...badTargets);
        if (entry.problems.length > 0) return entry;
        for (const target of spec.targets) {
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
 * `caw-ai validate` as data. `ok` is false when the config is invalid or has TODO values, or a test has a problem.
 * @returns { ok, config: { issues, todo, notes }, tests: [{ id, problems, hints, code: [{ target, code, overlay }] }], recordings: { problems, hints } }
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
 * `caw-ai list` as data: per test app, role, targets, whether it writes and the recording state per step. Without a readable
 * config the tests are listed as written (no defaults for app, role and targets).
 * @returns { config: 'ok'|'missing'|'invalid', tests: [{ id, app, role, targets, mutates, recording, steps: [{ id, name, recording }] } | { id, error }] }
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
                app: spec.app ?? null,
                role: spec.role ?? null,
                targets: spec.targets ?? [],
                mutates: spec.mutates !== false,
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

/** The caw-ai entry in .mcp.json. @returns 'created' | 'present' | 'invalid' */
const ensureMcpEntry = (root) => {
    const file = join(root, '.mcp.json');
    let mcp = { mcpServers: {} };
    try {
        if (existsSync(file)) mcp = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return 'invalid';
    }
    if (mcp === null || typeof mcp !== 'object') return 'invalid';
    if (mcp.mcpServers?.['caw-ai'] !== undefined) return 'present';
    mcp.mcpServers = { ...(mcp.mcpServers ?? {}), 'caw-ai': mcpEntry(root) };
    writeFileSync(file, `${JSON.stringify(mcp, null, 2)}\n`);
    return 'created';
};

/**
 * `caw-ai init` without questions and without explore: from caw/.explore.json (fromExplore: true or a path), otherwise offline
 * (template, TODO in the login). Existing files stay untouched.
 * @returns { state: 'done', created, skipped, todo, explored } or { state: 'explore-first' } when a URL is given but nothing was explored yet
 */
export const initProject = (root, { url, offline = false, fromExplore, roles, noMcp = false } = {}) => {
    const exploreFile = typeof fromExplore === 'string' ? fromExplore : EXPLORE_FILE;
    const useExplore = fromExplore !== undefined && fromExplore !== false ? true : !offline && url === undefined && existsSync(join(root, EXPLORE_FILE));
    if (!useExplore && !offline && url !== undefined) return { state: 'explore-first', url };
    let answers = { offline: true, ...(url === undefined ? {} : { url }) };
    if (useExplore) {
        let suggestion;
        try {
            suggestion = JSON.parse(readFileSync(resolve(root, exploreFile), 'utf8'));
        } catch (error) {
            throw new CawError('usage', t('cli.fromUnreadable', { from: exploreFile, message: error.message }));
        }
        answers = answersFromExplore(suggestion);
    }
    if (roles !== undefined) answers.roles = roles;

    const created = [];
    const skipped = [];
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
    const config = starterConfig({ framework: detected.framework, appDir: detected.dir, ...answers });
    write(CONFIG_FILE, `${JSON.stringify(config, null, 4)}\n`);
    if (config.auth?.type === 'form' || config.auth?.type === 'basic') {
        const names = Object.values(config.roles ?? {}).flatMap(({ loginEnv, passwordEnv }) => [loginEnv, passwordEnv]).filter(Boolean);
        write(`${ENV_FILE}.example`, `${t('cli.envExampleHead')}\n${names.map((name) => `${name}=`).join('\n')}\n`);
    }
    write(SKILL_FILE, readFileSync(templatePath('skill.md'), 'utf8'));
    if (!existsSync(join(root, TEST_DIR))) write(`${TEST_DIR}/.gitkeep`, '');
    write(CONTEXT_FILE, t('cli.contextTemplate'));
    if (!noMcp) {
        const mcp = ensureMcpEntry(root);
        if (mcp === 'created') created.push('.mcp.json');
        else skipped.push(mcp === 'invalid' ? '.mcp.json (invalid JSON)' : '.mcp.json');
    }
    const ignore = join(root, '.gitignore');
    const existing = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    const lines = [`${RUN_DIR}/`, ENV_FILE, `${AUTH_DIR}/`].filter((line) => !existing.split(/\r?\n/).includes(line));
    if (lines.length > 0) {
        appendFileSync(ignore, `\n# caw-ai\n${lines.join('\n')}\n`);
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
    return { state: 'done', created, skipped, todo, explored: useExplore };
};
