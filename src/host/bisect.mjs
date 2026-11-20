// `caw bisect <test> --env <e> [--tests-from <ref>]`: one step of `git bisect run`. git bisect checks out caw/ too, so the old
// commit's test would be another one or missing: the test, its recording and caw.config.json come from <ref> (default
// refs/bisect/bad, the commit known to fail). The run is `run --headless` without chat and without learning (learning would write
// caw/recordings and dirty the tree), with no effect failing a step (effects were learned on another version of the app), and it
// always starts the environment through its lifecycle, so every commit is built fresh.
// Exit codes for git bisect run: 0 good, 1 bad (only a failed step caw puts on the app), 125 skip (anything else), 128 stops the
// bisect (a call, test or config that cannot work on any commit, or an environment caw would not start itself). Every error is
// caught here: bin/caw.mjs would exit 2, which git bisect reads as bad.

import { validateConfig, withUrlOverrides } from '../shared/config.mjs';
import { effectiveEnvironment } from '../shared/environments.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { synopsisOf } from '../shared/help.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { readAtCommit, resolveCommit, shortHead } from './git.mjs';
import { environmentLifecycle, probeReady } from './lifecycle.mjs';
import { parseRunArgs } from './linux.mjs';
import { requireTestUser } from './test-users.mjs';
import { checkTest, mergeRecordings, parseRecordings, parseTest, withDefaults } from './test-file.mjs';

export const DEFAULT_TESTS_FROM = 'refs/bisect/bad';
/** What git bisect run understands: good, bad, skip this commit, stop the bisect. */
export const BISECT_EXIT = { good: 0, bad: 1, skip: 125, abort: 128 };

/** The ref's config as loadConfig would return it, for the ref's text. */
const configFrom = (text) => {
    if (text === undefined) throw new CawError('config-missing', t('cli.bisect.missingAtRef', { path: CONFIG_FILE }));
    let config;
    try {
        config = JSON.parse(text);
    } catch (error) {
        throw new CawError('config-invalid', t('config.load.invalidJson', { file: CONFIG_FILE, error: error.message }));
    }
    const { issues } = validateConfig(config);
    if (issues.length > 0) throw new CawError('config-invalid', `${CONFIG_FILE}:\n- ${issues.join('\n- ')}`);
    return withUrlOverrides(config);
};

/** The test at the ref as loadTest reads it from disk: description, recordings merged, ids that match the file name. */
const testFrom = (files, id, framework) => {
    const path = `${TEST_DIR}/${id}.yaml`;
    const recordings = `${RECORDING_DIR}/${id}.yaml`;
    if (!files.has(path)) throw new CawError('test-missing', t('cli.bisect.missingAtRef', { path }));
    const parsed = parseTest(files.get(path), path, { description: true, framework });
    if (parsed.id !== undefined && parsed.id !== id) throw new CawError('test-invalid', t('config.test.idMismatch', { path, id: String(parsed.id) }));
    const spec = { ...parsed, id };
    if (!files.has(recordings)) return spec;
    const recorded = parseRecordings(files.get(recordings), recordings, { framework });
    if (recorded.test !== id) throw new CawError('test-invalid', t('config.test.recordings.otherTest', { label: recordings, test: String(recorded.test), id }));
    return mergeRecordings(spec, recorded);
};

/**
 * Everything that is the same on every commit: the call, the test data at the ref, the environment. A problem here would make
 * every commit fail alike, so it stops the bisect.
 * @returns { options, ref, config, spec, target, checked, env }
 */
export const prepareBisect = async (root, args, { git = { resolveCommit, readAtCommit } } = {}) => {
    const options = parseRunArgs('bisect', args);
    if (options.target === undefined) throw new CawError('usage', t('cli.bisect.envMissing'));
    const ref = options.testsFrom ?? DEFAULT_TESTS_FROM;
    let commit;
    try {
        commit = git.resolveCommit(root, ref);
    } catch (error) {
        // Without --tests-from the ref only exists while git bisect runs.
        if (error?.code === 'git-ref' && options.testsFrom === undefined) throw new CawError('git-ref', t('cli.bisect.noBisect', { ref }));
        throw error;
    }
    const id = options.test;
    const files = git.readAtCommit(root, commit, [CONFIG_FILE, `${TEST_DIR}/${id}.yaml`, `${RECORDING_DIR}/${id}.yaml`]);
    const read = configFrom(files.get(CONFIG_FILE));
    // Effects were learned on another version of the app: on an older commit they would fail steps the app does right.
    const config = { ...read, effects: { ...read.effects, fail: [] } };
    const target = options.target;
    const spec = withDefaults(testFrom(files, id, config.framework ?? 'web'), config);
    const env = effectiveEnvironment(config, target);
    if (env.start === undefined) throw new CawError('usage', t('cli.bisect.noStart', { env: target }));
    const checked = checkTest(spec, target, config, { start: true });
    const { assertPlayable } = await import('./replay.mjs');
    // A pending tail is allowed, as in run: the recorded steps decide.
    assertPlayable(spec, target, undefined, { pending: true });
    // A missing test user would stop every commit alike.
    requireTestUser(root, config, spec.role, target);
    return { options, ref, config, spec, target, checked, env };
};

/** good, bad or skip for a run's result. Only a failed step that caw puts on the app makes a commit bad. */
export const bisectExit = ({ code, failed }) => {
    if (code === EXIT.pass) return BISECT_EXIT.good;
    if (code === EXIT.fail && failed?.diagnosis?.side === 'app') return BISECT_EXIT.bad;
    return BISECT_EXIT.skip;
};

const MEANING = { [BISECT_EXIT.good]: 'good', [BISECT_EXIT.bad]: 'bad', [BISECT_EXIT.skip]: 'skip', [BISECT_EXIT.abort]: 'abort' };

/** The one line per bisect step: commit, result, caw's assessment, exit. */
export const bisectLine = ({ commit, result, side, exit }) => t('cli.bisect.line', {
    commit,
    result,
    side: side === undefined ? '–' : t(`config.diag.side.${side}`),
    exit,
    meaning: t(`cli.bisect.meaning.${MEANING[exit]}`),
});

/** The result in words: passed, failed at a step, an error code. */
const resultText = ({ code, failed, verdict }) => {
    if (code === EXIT.pass) return t('cli.bisect.result.pass');
    if (code === EXIT.fail) return failed?.id === undefined ? t('cli.bisect.result.failed') : t('cli.bisect.result.failedAt', { step: failed.id });
    return t('cli.bisect.result.error', { code: verdict?.code ?? `exit ${code}` });
};

/**
 * `caw bisect`. Never throws: every outcome is an exit code git bisect understands.
 * @param deps tests only: git, runOne, probe (readiness before start), lifecycle (factory like environmentLifecycle), print, ui
 */
export const bisectCommand = async (root, args, deps = {}) => {
    const ui = deps.ui ?? createUi();
    const print = deps.print ?? ((text) => process.stdout.write(`${text}\n`));
    const git = { resolveCommit, readAtCommit, shortHead, ...deps.git };
    let commit = '?';
    try {
        commit = git.shortHead(root);
    } catch {
        // Only for the line; prepareBisect says what is wrong with Git.
    }
    const stop = (error, exit) => {
        ui.fatal(error?.code ?? 'error', String(error?.message ?? error), { exit, synopsis: error?.code === 'usage' ? synopsisOf('bisect') : undefined });
        print(bisectLine({ commit, result: t(exit === BISECT_EXIT.abort ? 'cli.bisect.result.notRun' : 'cli.bisect.result.error', { code: error?.code ?? 'error' }), exit }));
        return exit;
    };
    let prepared;
    try {
        prepared = await prepareBisect(root, args, { git });
        // The lifecycle would use a server that already answers: it could be any commit's build.
        if (await (deps.probe ?? probeReady)(prepared.env)) throw new CawError('usage', t('cli.bisect.alreadyRunning', { env: prepared.target, url: prepared.env.url }));
    } catch (error) {
        // An unexpected error (a bug, git failing otherwise) is no verdict on the call: skip, as during the run.
        return stop(error, error instanceof CawError ? BISECT_EXIT.abort : BISECT_EXIT.skip);
    }
    const { options, config, spec, target, checked, env } = prepared;
    const lifecycle = (deps.lifecycle ?? environmentLifecycle)(root, env, { start: true, reset: 'auto', info: (text) => ui.info(text), warn: (text) => ui.warn(text) });
    let outcome;
    try {
        await lifecycle.begin();
        const runOne = deps.runOne ?? (await import('./commands.mjs')).runOne;
        const runOptions = { test: spec.id, target, stepTimeoutSec: options.stepTimeoutSec, headless: true, noChat: true, learn: false, strict: false, lifecycle, quiet: true };
        // interactive false: a run as in CI, which learns nothing and opens no chat.
        outcome = await runOne(root, runOptions, { interactive: false }, { config, spec, target, checked });
    } catch (error) {
        outcome = { error };
    }
    try {
        await lifecycle.end();
    } catch (error) {
        ui.warn(String(error?.message ?? error));
    }
    if (outcome.error !== undefined) return stop(outcome.error, BISECT_EXIT.skip);
    const exit = bisectExit(outcome);
    const side = outcome.code === EXIT.pass ? undefined : outcome.failed?.diagnosis?.side;
    print(bisectLine({ commit, result: resultText(outcome), side, exit }));
    return exit;
};
