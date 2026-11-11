// `caw-ai overlay check`: does the overlay replace everything it should? Opens the app headless with the overlay like a run without
// steps, signs in, waits until it is ready and compares the page's script requests with what the framework adapter expects
// (ExtJS: app and packages from bootstrap.json). Token-free; never starts a watch the config does not name (devCommand).
// The result always lands in .caw/overlay-check.json, for doctor and the Claude session.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { allTargets, authOf, isLoopback, loadConfig, patternList, resolveTarget, writeConfig } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RUN_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { frameworkOf } from './framework/index.mjs';
import { processRunning } from './processes.mjs';
import { checkTest } from './test-file.mjs';

/** The result file under .caw. */
export const OVERLAY_CHECK_FILE = 'overlay-check.json';
const CHECK_ID = 'overlay-check';

const onlyKey = (map) => {
    const keys = Object.keys(map ?? {});
    return keys.length === 1 ? keys[0] : undefined;
};

/** The target without --target: the only one whose environment allows the overlay. */
export const overlayTarget = (config) => {
    const choices = allTargets(config).filter((name) => {
        try {
            return resolveTarget(config, name).overlay;
        } catch {
            return false;
        }
    });
    if (choices.length !== 1) throw new CawError('usage', t('cli.overlayCheck.target', { choices: (choices.length > 0 ? choices : allTargets(config)).join(', ') }));
    return choices[0];
};

/**
 * Can the overlay run at all, before any browser: environment with overlay, app folder, for ExtJS bootstrap.json and the watch.
 * Never starts anything; `command` is what the human (or devCommand) would run, in `appDir`.
 * @param running tests only: replaces the process check
 * @returns { state: ready | not-overlay | watch-missing | watch-stale | no-app, framework, appDir, command?, message? }
 */
export const overlayPreconditions = (root, config, { target, app, running = processRunning } = {}) => {
    const framework = config.framework ?? 'web';
    const name = app ?? onlyKey(config.apps);
    if (name === undefined || config.apps?.[name] === undefined) {
        return { state: 'no-app', framework, appDir: null, message: t('cli.overlayCheck.noApp', { app: String(name ?? ''), apps: Object.keys(config.apps ?? {}).join(', ') || '–' }) };
    }
    const appDir = String(config.apps[name].dir).replaceAll('\\', '/');
    const resolved = resolveTarget(config, target ?? overlayTarget(config));
    const { protocol, hostname } = new URL(resolved.url);
    if (!resolved.overlay || (protocol === 'http:' && isLoopback(hostname))) {
        return { state: 'not-overlay', framework, appDir, message: t('config.overlay.environment', { environment: resolved.environment }) };
    }
    const adapter = frameworkOf(config);
    if (adapter.watch === undefined || adapter.overlay === undefined) return { state: 'ready', framework, appDir };
    const dir = join(root, appDir);
    if (!existsSync(join(dir, 'app.json'))) return { state: 'no-app', framework, appDir, message: t('cli.overlayCheck.noAppJson', { dir: appDir, app: name }) };
    const devCommand = config.apps[name].overlay?.devCommand;
    const command = devCommand ?? adapter.watch.start;
    const watching = running(adapter.watch.command) !== false;
    // caw starts the watch only through devCommand; then a missing watch or stale bootstrap.json is its job, not a blocker.
    if (!watching && devCommand !== undefined) return { state: 'ready', framework, appDir, command };
    if (!watching) return { state: 'watch-missing', framework, appDir, command, message: t('cli.overlayCheck.watchMissing', { label: adapter.watch.label(), command, dir: appDir }) };
    try {
        adapter.overlay.checkAppFiles(dir, t('cli.overlayCheck.watchHint', { command, dir: appDir }));
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        return { state: error.code === 'watch-stale' ? 'watch-stale' : 'watch-missing', framework, appDir, command, message: error.message };
    }
    return { state: 'ready', framework, appDir, command };
};

const save = (root, result) => {
    const dir = join(root, RUN_DIR);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, OVERLAY_CHECK_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(temp, file);
    return result;
};

const EMPTY = () => ({ parts: [], missed: [], notLoaded: [], suggestions: [], unresolved: [] });

/**
 * Runs the check and writes .caw/overlay-check.json.
 * @param apply add the suggested patterns to assetUrlPattern (validated writer), then check once more
 * @param deps  tests only: { openSession, running, info, now, role }
 * @returns { at, target, app, state, parts: [{ label, kind, names, status }], missed: [{ url, name, part }], notLoaded, suggestions:
 *   [{ source, pattern, urls }], unresolved: [{ source, urls }], applied?, message?, command?, code?, runDir? }
 *   state: complete | incomplete | no-expected | error, or a precondition state (not-overlay, watch-missing, watch-stale, no-app)
 */
export const overlayCheck = async (root, { target, app, role, apply = false, deps = {} } = {}) => {
    const config = loadConfig(root);
    const now = deps.now ?? (() => new Date());
    const chosenTarget = target ?? overlayTarget(config);
    const chosenApp = app ?? onlyKey(config.apps);
    const base = { at: now().toISOString(), target: chosenTarget, app: chosenApp ?? null };
    const pre = overlayPreconditions(root, config, { target: chosenTarget, app: chosenApp, ...(deps.running === undefined ? {} : { running: deps.running }) });
    if (pre.state !== 'ready') {
        return save(root, { ...base, state: pre.state, ...EMPTY(), message: pre.message, appDir: pre.appDir, ...(pre.command === undefined ? {} : { command: pre.command }) });
    }
    if (frameworkOf(config).overlay?.expected === undefined) {
        return save(root, { ...base, state: 'no-expected', ...EMPTY(), message: t('cli.overlayCheck.noExpected', { framework: pre.framework }) });
    }
    const chosenRole = role ?? deps.role ?? (authOf(config).type === 'none' ? undefined : Object.keys(config.roles ?? {})[0]);
    const spec = { id: CHECK_ID, app: chosenApp, ...(chosenRole === undefined ? {} : { role: chosenRole }), targets: [chosenTarget], mutates: false, also: [], notes: '', steps: [], expectations: [] };
    const checked = checkTest(spec, chosenTarget, config, { overlay: true });
    const runId = `${now().toISOString().replace(/[:.]/g, '-')}-${CHECK_ID}`;
    const relativeRun = posix.join(RUN_DIR, 'runs', runId);
    mkdirSync(join(root, relativeRun), { recursive: true });
    const { openRunSession, writeLastRun } = await import('./run.mjs');
    writeLastRun(root, { runId, runDir: relativeRun, command: CHECK_ID, test: null, target: chosenTarget });
    const open = deps.openSession ?? openRunSession;
    let session;
    try {
        session = await open({ root, config, spec, checked, runDir: join(root, relativeRun), headless: true, strict: false, info: deps.info ?? (() => {}) });
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        const state = ['watch-missing', 'watch-stale'].includes(error.code) ? error.code : 'error';
        return save(root, { ...base, state, ...EMPTY(), code: error.code, message: error.message, runDir: relativeRun });
    }
    let seen;
    let loadProblem;
    try {
        seen = session.diagnose?.() ?? null;
        loadProblem = session.overlay?.()?.loadProblem;
    } finally {
        await session.close();
    }
    if (seen === null) return save(root, { ...base, state: 'error', ...EMPTY(), message: t('cli.overlayCheck.noDiagnosis'), runDir: relativeRun });
    const { parts, missed, notLoaded, suggestions, unresolved } = seen;
    const result = { ...base, state: missed.length > 0 ? 'incomplete' : 'complete', parts, missed, notLoaded, suggestions, unresolved, runDir: relativeRun, ...(loadProblem === undefined ? {} : { message: loadProblem }) };
    if (!apply || suggestions.length === 0) return save(root, result);
    // Only the missing patterns, appended: a single string becomes a list, what is there stays first.
    const current = patternList(config.assetUrlPattern);
    const added = suggestions.map(({ pattern }) => pattern).filter((pattern) => !current.includes(pattern));
    if (added.length === 0) return save(root, { ...result, applied: [] });
    const written = writeConfig(root, { assetUrlPattern: [...current, ...added] });
    if (!written.ok) return save(root, { ...result, applied: [], message: written.issues.join('\n') });
    const again = await overlayCheck(root, { target: chosenTarget, app: chosenApp, role: chosenRole, apply: false, deps });
    return save(root, { ...again, applied: added });
};

/** Exit code: 0 complete (or nothing to compare), 3 config (no overlay, no app), 2 everything else (mixed, watch, error). */
export const overlayCheckExit = ({ state }) => {
    if (state === 'complete' || state === 'no-expected') return EXIT.pass;
    if (state === 'not-overlay' || state === 'no-app') return EXIT.rejected;
    return EXIT.error;
};

const STATUS = { local: 'success', deployed: 'warn', 'not-loaded': 'note' };

/** The result for the terminal. */
export const printOverlayCheck = (result, ui) => {
    ui.info(t('cli.overlayCheck.head', { target: result.target, app: result.app ?? '–' }));
    for (const { label, kind, status } of result.parts) ui[STATUS[status]](t(`cli.overlayCheck.part.${status}`, { label, kind }));
    for (const { source, pattern, urls } of result.suggestions) ui.info(t('cli.overlayCheck.suggestion', { source, pattern: JSON.stringify(pattern), count: urls.length }));
    for (const { source, urls } of result.unresolved) ui.note(t('cli.overlayCheck.unresolved', { source, urls: urls.slice(0, 3).join(', ') }));
    if (result.applied !== undefined && result.applied.length > 0) ui.success(t('cli.overlayCheck.applied', { count: result.applied.length }));
    if (result.message !== undefined && result.state !== 'complete' && result.state !== 'incomplete') ui.warn(result.message);
    else if (result.message !== undefined) ui.note(result.message);
    if (result.command !== undefined && (result.state === 'watch-missing' || result.state === 'watch-stale')) ui.info(t('cli.overlayCheck.command', { command: result.command, dir: result.appDir ?? '.' }));
    if (result.state === 'complete') ui.success(t('cli.overlayCheck.complete'));
    else if (result.state === 'incomplete') ui.warn(t(result.suggestions.length > 0 && result.applied === undefined ? 'cli.overlayCheck.incompleteApply' : 'cli.overlayCheck.incomplete', { count: result.missed.length }));
};

const VALUE_OPTIONS = ['--target', '--app', '--role'];
const FLAGS = ['--apply', '--json'];

/** `caw-ai overlay check [--target <env>] [--app <app>] [--role <role>] [--apply] [--json]`. */
export const overlayCommand = async (root, args, { out = (text) => console.log(text), deps = {} } = {}) => {
    const [sub, ...rest] = args;
    if (sub !== 'check') throw new CawError('usage', t('cli.overlayCheck.usage', { sub: String(sub ?? '') }));
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (FLAGS.includes(arg)) options[arg.slice(2)] = true;
        else if (VALUE_OPTIONS.includes(arg)) {
            const value = rest[index + 1];
            if (value === undefined || value.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag: arg, example: { '--target': 'dev', '--app': 'web', '--role': 'tester' }[arg] }));
            options[arg.slice(2)] = value;
            index += 1;
        } else throw new CawError('usage', t('cli.overlayCheck.unknownArg', { arg }));
    }
    // With --json the result is the only line on stdout; progress goes to stderr.
    const ui = createUi(options.json ? { out: (text) => console.error(text) } : {});
    const result = await overlayCheck(root, { target: options.target, app: options.app, role: options.role, apply: options.apply === true, deps: { info: (text) => ui.info(text), ...deps } });
    if (options.json) out(JSON.stringify(result));
    else printOverlayCheck(result, ui);
    return overlayCheckExit(result);
};
