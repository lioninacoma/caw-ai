// `caw-ai overlay status` and `caw-ai overlay check`.
// status: is the local code server ready, without a browser? Asks the server at overlay.url (ExtJS: is it the watch of this app,
// with a current bootstrap.json; if not, is it running on another port). Starts nothing.
// check: does the overlay replace everything it should? Opens the app headless with the overlay like a run without steps, signs
// in, waits until it is ready and compares the page's script requests with what the framework adapter expects (ExtJS: app and
// packages from bootstrap.json). Token-free; starts the local code server only with --start (overlay.start). The result always
// lands in .caw/overlay-check.json, for doctor and the Claude session.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { allTargets, authOf, isLoopback, loadConfig, overlaySettings, patternList, resolveTarget, writeConfig } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { RUN_DIR } from '../shared/names.mjs';
import { createUi } from '../shared/ui.mjs';
import { frameworkOf } from './framework/index.mjs';
import { serverState } from './overlay.mjs';
import { staticFile } from './static-files.mjs';
import { checkTest, overlayChoice } from './test-file.mjs';

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
 * Is the local code ready for --overlay, before any browser? Environment with overlay, app, source; for a server (dev server,
 * Sencha watch) whether it answers at overlay.url, for ExtJS whether it is the watch of this app with a current bootstrap.json,
 * and if not whether it runs on another port. Never starts anything; `start` is the project's command (overlay.start) for the
 * human or Claude to run in `appDir`.
 * @param config the loaded config; otherwise loaded from root
 * @param deps   tests only: { fetchImpl, discover({ url, appDir, adapter, fetchImpl }) -> url | null }
 * @returns { state, framework, app, appDir, url, foundUrl?, start, message? }
 *   state: ready | moved (runs at foundUrl) | down | wrong-app | stale | not-overlay | no-app; url and start null if unknown
 */
export const overlayStatus = async (root, { target, app, config: given, deps = {} } = {}) => {
    const config = given ?? loadConfig(root);
    const framework = config.framework ?? 'web';
    const name = app ?? onlyKey(config.apps);
    if (name === undefined || config.apps?.[name] === undefined) {
        const message = t('cli.overlayCheck.noApp', { app: String(name ?? ''), apps: Object.keys(config.apps ?? {}).join(', ') || '–' });
        return { state: 'no-app', framework, app: name ?? null, appDir: null, url: null, start: null, message };
    }
    const appDir = String(config.apps[name].dir).replaceAll('\\', '/');
    const settings = overlaySettings(config.apps[name].overlay);
    const base = { framework, app: name, appDir, url: settings.url ?? null, start: settings.start ?? null };
    const resolved = resolveTarget(config, target ?? overlayTarget(config));
    const { protocol, hostname } = new URL(resolved.url);
    if (!resolved.overlay || (protocol === 'http:' && isLoopback(hostname))) {
        return { state: 'not-overlay', ...base, message: t('config.overlay.environment', { environment: resolved.environment }) };
    }
    let choice;
    try {
        choice = overlayChoice(config, name, true);
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        return { state: 'not-overlay', ...base, message: error.message };
    }
    const statics = (choice.statics ?? []).map(({ name: staticName, path }) => {
        const found = staticFile(root, join(root, appDir), path);
        return { name: staticName, path, state: found.state, ...(found.state === 'outside' ? { boundary: found.boundary } : {}) };
    });
    const broken = statics.find(({ state }) => state !== 'ok');
    if (broken !== undefined) {
        const message = broken.state === 'missing' ? t('session.overlay.staticMissing', { file: broken.path })
            : t(broken.state === 'secret' ? 'session.overlay.staticSecret' : 'session.overlay.staticOutside', broken);
        return { state: broken.state === 'missing' ? 'static-missing' : 'static-invalid', ...base, url: choice.url ?? null, statics, message };
    }
    const withStatics = statics.length === 0 ? {} : { statics };
    // A build folder or fixed files need no server: the run checks them itself.
    if (choice.url === undefined) return { state: 'ready', ...base, url: null, ...withStatics };
    const status = { ...base, url: choice.url, ...withStatics };
    const adapter = frameworkOf(config);
    const dir = join(root, appDir);
    if (adapter.overlay?.identify !== undefined && !existsSync(join(dir, 'app.json'))) {
        return { state: 'no-app', ...status, message: t('cli.overlayCheck.noAppJson', { dir: appDir, app: name }) };
    }
    const next = choice.start === undefined ? t('session.overlay.startUnknown', { app: name }) : t('session.overlay.startKnown', { start: choice.start, dir: appDir });
    const hint = t('session.overlay.watchHint', { start: choice.start ?? adapter.watch?.start ?? '' });
    const found = await serverState({ url: choice.url, appDir: dir, adapter, hint, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }), ...(deps.discover === undefined ? {} : { discover: deps.discover }) });
    if (found.state === 'ready') return { state: 'ready', ...status };
    if (found.state === 'moved') return { state: 'moved', ...status, foundUrl: found.url, message: t('cli.overlayStatus.moved', { app: name, url: choice.url, found: found.url }) };
    if (found.state === 'down') return { state: 'down', ...status, message: t('session.overlay.serverDown', { url: choice.url, next }) };
    return { state: found.state, ...status, message: found.message };
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
// The run's error codes that describe the local code server, as status states.
const SERVER_STATES = { 'overlay-not-ready': 'down', 'overlay-stale': 'stale' };

/**
 * Runs the check and writes .caw/overlay-check.json.
 * @param apply add the suggested patterns to assetUrlPattern (validated writer), then check once more
 * @param start run overlay.start if the server does not answer (like run --start), stopped at the end
 * @param deps  tests only: { openSession, fetchImpl, discover, info, now, role }
 * @returns { at, target, app, state, parts: [{ label, kind, names, status }], missed: [{ url, name, part }], notLoaded, suggestions:
 *   [{ source, pattern, urls }], unresolved: [{ source, urls }], applied?, message?, code?, runDir?, appDir?, url, start }
 *   state: complete | incomplete | no-expected | error, or a status state (not-overlay, no-app, down, wrong-app, stale)
 */
export const overlayCheck = async (root, { target, app, role, apply = false, start = false, deps = {} } = {}) => {
    const config = loadConfig(root);
    const now = deps.now ?? (() => new Date());
    const chosenTarget = target ?? overlayTarget(config);
    const chosenApp = app ?? onlyKey(config.apps);
    const base = { at: now().toISOString(), target: chosenTarget, app: chosenApp ?? null };
    const status = await overlayStatus(root, { target: chosenTarget, app: chosenApp, config, deps });
    const server = { url: status.url, start: status.start };
    const usable = status.state === 'ready' || status.state === 'moved' || (start && status.state === 'down');
    if (!usable) return save(root, { ...base, state: status.state, ...EMPTY(), message: status.message, appDir: status.appDir, ...server });
    if (frameworkOf(config).overlay?.expected === undefined) {
        return save(root, { ...base, state: 'no-expected', ...EMPTY(), message: t('cli.overlayCheck.noExpected', { framework: status.framework }), ...server });
    }
    const chosenRole = role ?? deps.role ?? (authOf(config).type === 'none' ? undefined : Object.keys(config.roles ?? {})[0]);
    const spec = { id: CHECK_ID, app: chosenApp, ...(chosenRole === undefined ? {} : { role: chosenRole }), targets: [chosenTarget], mutates: false, also: [], notes: '', steps: [], expectations: [] };
    // A watch found on another port: the check uses it directly.
    const checked = checkTest(spec, chosenTarget, config, { overlay: status.foundUrl ?? true, start });
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
        return save(root, { ...base, state: SERVER_STATES[error.code] ?? 'error', ...EMPTY(), code: error.code, message: error.message, runDir: relativeRun, appDir: status.appDir, ...server });
    }
    let seen;
    let loadProblem;
    try {
        seen = session.diagnose?.() ?? null;
        loadProblem = session.overlay?.()?.loadProblem;
    } finally {
        await session.close();
    }
    if (seen === null) return save(root, { ...base, state: 'error', ...EMPTY(), message: t('cli.overlayCheck.noDiagnosis'), runDir: relativeRun, ...server });
    const { parts, missed, notLoaded, suggestions, unresolved } = seen;
    const statics = seen.statics ?? [];
    // A static that came from the server is a mixed state like a missed part.
    const state = missed.length > 0 || statics.some(({ status: served }) => served === 'deployed') ? 'incomplete' : 'complete';
    const result = { ...base, state, parts, missed, notLoaded, suggestions, unresolved, ...(statics.length === 0 ? {} : { statics }), runDir: relativeRun, ...server, ...(loadProblem === undefined ? {} : { message: loadProblem }) };
    if (!apply || suggestions.length === 0) return save(root, result);
    // Only the missing patterns, appended: a single string becomes a list, what is there stays first.
    const current = patternList(config.assetUrlPattern);
    const added = suggestions.map(({ pattern }) => pattern).filter((pattern) => !current.includes(pattern));
    if (added.length === 0) return save(root, { ...result, applied: [] });
    const written = writeConfig(root, { assetUrlPattern: [...current, ...added] });
    if (!written.ok) return save(root, { ...result, applied: [], message: written.issues.join('\n') });
    const again = await overlayCheck(root, { target: chosenTarget, app: chosenApp, role: chosenRole, apply: false, start, deps });
    return save(root, { ...again, applied: added });
};

/** Exit code of status: 0 ready (also on another port), 3 config (no overlay, no app), 2 the server (down, wrong app, stale). */
export const overlayStatusExit = ({ state }) => {
    if (state === 'ready' || state === 'moved') return EXIT.pass;
    if (state === 'not-overlay' || state === 'no-app' || state === 'static-invalid') return EXIT.rejected;
    return EXIT.error;
};

/** Exit code of check: 0 complete (or nothing to compare), 3 config (no overlay, no app), 2 everything else (mixed, server, error). */
export const overlayCheckExit = ({ state }) => {
    if (state === 'complete' || state === 'no-expected') return EXIT.pass;
    if (state === 'not-overlay' || state === 'no-app' || state === 'static-invalid') return EXIT.rejected;
    return EXIT.error;
};

const SERVER_PROBLEMS = new Set(['down', 'wrong-app', 'stale']);

/** For a server problem: the project's start command and where to run it. */
const printStart = (result, ui) => {
    if (typeof result.start === 'string' && SERVER_PROBLEMS.has(result.state)) ui.info(t('cli.overlayCheck.command', { command: result.start, dir: result.appDir ?? '.' }));
};

/** The status for the terminal. */
export const printOverlayStatus = (result, ui) => {
    if (result.state === 'ready') ui.success(result.url === null ? t('cli.overlayStatus.readyNoServer', { app: result.app }) : t('cli.overlayStatus.ready', { app: result.app, url: result.url }));
    else ui.warn(result.message);
    for (const entry of result.statics ?? []) ui[entry.state === 'ok' ? 'info' : 'warn'](t(`cli.overlayStatus.static.${entry.state}`, entry));
    printStart(result, ui);
};

const STATUS = { local: 'success', deployed: 'warn', 'not-loaded': 'note' };

/** The result for the terminal. */
export const printOverlayCheck = (result, ui) => {
    ui.info(t('cli.overlayCheck.head', { target: result.target, app: result.app ?? '–' }));
    for (const { label, kind, status } of result.parts) ui[STATUS[status]](t(`cli.overlayCheck.part.${status}`, { label, kind }));
    for (const entry of result.statics ?? []) ui[STATUS[entry.status]](t(`cli.overlayCheck.static.${entry.status}`, entry));
    for (const { source, pattern, urls } of result.suggestions) ui.info(t('cli.overlayCheck.suggestion', { source, pattern: JSON.stringify(pattern), count: urls.length }));
    for (const { source, urls } of result.unresolved) ui.note(t('cli.overlayCheck.unresolved', { source, urls: urls.slice(0, 3).join(', ') }));
    if (result.applied !== undefined && result.applied.length > 0) ui.success(t('cli.overlayCheck.applied', { count: result.applied.length }));
    if (result.message !== undefined && result.state !== 'complete' && result.state !== 'incomplete') ui.warn(result.message);
    else if (result.message !== undefined) ui.note(result.message);
    printStart(result, ui);
    if (result.state === 'complete') ui.success(t('cli.overlayCheck.complete'));
    else if (result.state === 'incomplete') ui.warn(t(result.suggestions.length > 0 && result.applied === undefined ? 'cli.overlayCheck.incompleteApply' : 'cli.overlayCheck.incomplete', { count: result.missed.length }));
};

// The options per subcommand: with a value, then switches.
const OPTIONS = {
    status: { values: ['--target', '--app'], flags: ['--json'] },
    check: { values: ['--target', '--app', '--role'], flags: ['--apply', '--start', '--json'] },
};
const EXAMPLES = { '--target': 'dev', '--app': 'web', '--role': 'tester' };

/**
 * `caw-ai overlay status [--target <env>] [--app <app>] [--json]` and
 * `caw-ai overlay check [--target <env>] [--app <app>] [--role <role>] [--apply] [--start] [--json]`.
 */
export const overlayCommand = async (root, args, { out = (text) => console.log(text), deps = {} } = {}) => {
    const [sub, ...rest] = args;
    const known = OPTIONS[sub];
    if (known === undefined) throw new CawError('usage', t('cli.overlayCheck.usage', { sub: String(sub ?? '') }));
    const options = {};
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (known.flags.includes(arg)) options[arg.slice(2)] = true;
        else if (known.values.includes(arg)) {
            const value = rest[index + 1];
            if (value === undefined || value.startsWith('--')) throw new CawError('usage', t('session.args.valueMissing', { flag: arg, example: EXAMPLES[arg] }));
            options[arg.slice(2)] = value;
            index += 1;
        } else {
            const allowed = [...known.values.map((flag) => `${flag} <${EXAMPLES[flag]}>`), ...known.flags].join(', ');
            throw new CawError('usage', t('cli.overlayCheck.unknownArg', { sub, arg, allowed }));
        }
    }
    // With --json the result is the only line on stdout; progress goes to stderr.
    const ui = createUi(options.json ? { out: (text) => console.error(text) } : {});
    if (sub === 'status') {
        const status = await overlayStatus(root, { target: options.target, app: options.app, deps });
        if (options.json) out(JSON.stringify(status));
        else printOverlayStatus(status, ui);
        return overlayStatusExit(status);
    }
    const result = await overlayCheck(root, { target: options.target, app: options.app, role: options.role, apply: options.apply === true, start: options.start === true, deps: { info: (text) => ui.info(text), ...deps } });
    if (options.json) out(JSON.stringify(result));
    else printOverlayCheck(result, ui);
    return overlayCheckExit(result);
};
