// A complete run: open the browser on the host, start the container, execute its commands, write the report.

import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

import { colorEnabled } from '../shared/color.mjs';
import { createUi } from '../shared/ui.mjs';
import { resolveCredentials } from '../shared/credentials.mjs';
import { agentHosts, effectiveEnvironment, startPath, usesTotp } from '../shared/environments.mjs';
import { buildDevlinkConfig, todoFields, claudeLimits, isLoopback, navigationHosts, sessionPath } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { foldAction } from './activity.mjs';
import { DEFAULT_KEEP_RUNS, markRunAlive, pruneRuns } from './runs.mjs';
import { AGENT_NAME, inLanguage, language, languageSource, t, teamLanguage } from '../shared/i18n.mjs';
import { pollChannel } from '../shared/channel.mjs';
import { personalContextPath, readPersonalContext, shownPath } from '../shared/personal-context.mjs';
import { prefsDir, readPrefs } from '../shared/prefs.mjs';
import { renderReport, renderReproduceReport } from '../shared/report.mjs';
import { readReproduction, draftTestPlan, adoptHint } from './reproduce.mjs';
import { openChat, parseClaudeLog, tailLines } from './chat.mjs';
import { describeCode } from './code-source.mjs';
import { CONFIG_FILE, CONTEXT_FILE, ENV_FILE, PROJECT_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { renderPlan, renderTest, retryProblems, writeTest } from './test-file.mjs';
import { PLAN_FILE, composeTest, heardProblems, planView, readPlan, replaceStep, samePlanStep, sessionFollowsOwnPlan, withNoteIds } from './test-plan.mjs';
import { codeText, createAgentHandler, hiddenAnswer, hiddenError, locatorFor } from './agent-commands.mjs';
import { locatorLabel } from './locator.mjs';
import { recordLocator } from './record-locator.mjs';
import { adviceView, applyEdits, applyToFiles, applyToSpec, adviceReader, changesFiles, configValue } from './advice.mjs';
import { diagnose } from './diagnose.mjs';
import { frameworkOf } from './framework/index.mjs';
import { demonstrate, feedLabel, itemLabel, recordableSteps } from './demonstrate.mjs';
import { CLAUDE_TIMEOUT_MIN, claudeFailureReason, parseEnvFile } from './linux.mjs';
import { fillDates, zonedNow } from './dates.mjs';
import { buildReplay, createRecorder, cutReplay, dropNumbers, failedStep, fillRun, groupSteps, learnedEffects, missingBaselines, missingRemembered, newRunTag, playReplay, recordedBrowser, replayBefore, replayToEntry, replayVerdict, stepGroups, stepLabel, tidyNumbers, trailingNumbers } from './replay.mjs';
import { canRestore, loadStateTest, stateCatalog } from './states.mjs';
import { IDLE_AGENT, createTokenGate } from './token-gate.mjs';
import { sandboxRunArgs } from './sandbox-config.mjs';
import { startLocalAgent } from './local-agent.mjs';
import { announceSessionAgent } from '../shared/session-agent.mjs';
import { createSessionLink } from './session-link.mjs';
import { GUIDE_FILE } from '../sandbox/commands.mjs';
import { agentGuide, runTopics } from './guide.mjs';
import { SELECTION_FILE } from '../shared/names.mjs';
import { withStepBudget } from './step-budget.mjs';
import { redactDeep } from './secrets.mjs';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
const AGENT_DIR = 'agent';
// The run folder and report name of every reproduction, with or without a starting test.
const REPRODUCE_RUN = 'reproduce';
const CHANNEL_DIR = '.channel';
const CLAUDE_LOG = 'claude.log';
// How long the window stays open after the last decision, with a countdown, unless the human closes it.
const LINGER_MS = 15000;
const ADVICE_LOG = 'claude-advice.log';
const DRAFT_FILE = 'test-draft.yaml';
// Changes the page state or proves a step: only allowed once the plan is approved.
// eval too: it runs any script in the page and can change it just like a click. Reading stays allowed via snapshot.
export const NEEDS_PLAN = new Set(['click', 'dblclick', 'hover', 'dragTo', 'dialog', 'upload', 'fill', 'type', 'press', 'goto', 'reload', 'check', 'remember', 'eval']);
// While advising Claude only reads: the page should stay as the run left it.
const ADVISE_READS = new Set(['task', 'snapshot', 'url', 'eval', 'console', 'network', 'screenshot', 'say', 'advise']);
// A conversation only adds waiting for the human.
const TALK_READS = new Set([...ADVISE_READS, 'chat']);
// While developing the window belongs to the human, who can ask Claude to operate it: click, fill, reproduce a bug.
// Only on request (see skill); no test results from it, so there is no `check` or `remember` here.
const DEVELOP_ACTS = new Set([...TALK_READS, 'click', 'dblclick', 'hover', 'dragTo', 'dialog', 'fill', 'type', 'press', 'goto', 'reload', 'wait-ready']);
/**
 * The chip at the top right of the workbench while something runs: record while Claude records or fixes (no replay), play while
 * replaying (run, check run, open with a test; restoring a state sets play itself). Nothing for open without a test: it replays
 * nothing and hands over at once. The page shows pause while a running run is paused (F9); once the run is over the chip goes away.
 */
export const transportOf = (replay) => (replay === undefined ? 'record' : replay.steps.length === 0 ? null : 'play');
/** What Claude may do in the browser while advising, talking after a failure, or developing. */
export const consultAllowed = (mode) => (mode === 'develop' ? DEVELOP_ACTS : mode === 'talk' ? TALK_READS : ADVISE_READS);
const TALK_LOG = 'claude-talk.log';
// Labels as getters: the language is not known yet at import time.
const ACCEPT = { id: 'accept', get label() { return t('run.button.accept'); }, primary: true };
const REJECT = { id: 'discard', get label() { return t('run.button.discard'); } };
const NEXT = { id: 'next', get label() { return t('run.button.next'); }, primary: true };
// Only on click: writes the proposed change into the application code; never commits.
const APPLY = { id: 'apply', get label() { return t('run.button.apply'); }, primary: true };

const color = colorEnabled();
const ui = createUi();
const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/** The signals that end a run like Ctrl+C. SIGBREAK only exists on Windows (Ctrl+Break). */
export const ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];

/**
 * Calls `abort` on the first of the signals, each handled once: a second Ctrl+C ends the process as usual.
 * @returns stop(): removes the listeners again
 */
export const onAbortSignals = (abort, { signals = ABORT_SIGNALS, target = process } = {}) => {
    for (const signal of signals) target.once(signal, abort);
    return () => { for (const signal of signals) target.removeListener(signal, abort); };
};

/** Errors before the run caused by the invocation or config: exit 3 as documented, not 2. */
const NOTHING_RAN = new Set(['auth-missing', 'config-invalid']);

/** Whether the target is reachable: any HTTP response counts. Certificates are not checked here. */
export const reachable = (url) => new Promise((ok) => {
    // localhost and *.localhost resolve to 127.0.0.1, as for Chrome: Node on Windows does not know .localhost and often
    // resolves localhost to ::1 first, where the dev server is not listening.
    const loopback = isLoopback(new URL(url).hostname) ? { lookup: (_host, options, done) => (options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)) } : {};
    // http only exists on the local machine, e.g. for a local dev server; the config allows it nowhere else.
    const request = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest;
    const req = request(url, { method: 'HEAD', rejectUnauthorized: false, timeout: 15_000, ...loopback }, (res) => {
        res.resume();
        ok(true);
    });
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
    req.end();
});

/**
 * What signing in as a role on an environment needs, by its sign-in: for `form` and `basic` the role's test user (and the code
 * secret if the sign-in uses one), for `session` the saved session file, for `none` nothing. A gate in front of the environment
 * adds its own account. Names follow CAW_<ROLE>_USER etc.; the process environment (CI secrets) wins over caw/.env.
 * @returns null without anything to sign in with, else { login, password, totpSecret? } | { storageState }, plus { gate }
 */
export const readCredentials = (root, config, roleName, target, env = process.env) => {
    const resolved = effectiveEnvironment(config, target);
    const { signIn } = resolved;
    const file = join(root, ENV_FILE);
    const sources = { processEnv: env, fileEnv: existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {} };
    const gateAccount = resolved.gate === undefined ? undefined : resolveCredentials({ who: 'gate', env: target, sources });
    const gate = gateAccount === undefined ? {} : { gate: { username: gateAccount.user, password: gateAccount.password } };
    if (signIn.type === 'none') return gateAccount === undefined ? null : gate;
    if (signIn.type === 'session') {
        const storageState = join(root, sessionPath(target, roleName));
        if (!existsSync(storageState)) throw new CawError('auth-missing', t('run.error.authMissing', { role: roleName, target }));
        return { storageState, ...gate };
    }
    const account = resolveCredentials({ who: roleName, env: target, totp: usesTotp(signIn), sources });
    return { login: account.user, password: account.password, ...(account.totp === undefined ? {} : { totpSecret: account.totp }), ...gate };
};

/**
 * The log file belongs to the container: only read a regular file, never a link. Opened without following a link (where the
 * system can), then checked on the open file: a link swapped in between lstat and open is not read.
 */
export const readAgentLog = (file) => {
    let fd;
    try {
        const before = lstatSync(file);
        if (!before.isFile()) return '';
        fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd);
        // The same file as checked (Windows reports no dev for lstat, so only the file id counts).
        if (!opened.isFile() || opened.ino !== before.ino) return '';
        return readFileSync(fd, 'utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
};

/** Claude's work outside the steps: one group per run, named after what it is doing. */
const CLAUDE_GROUP = 'claude';
const CLAUDE_GROUPS = ['advise', 'talk', 'develop', 'reproduce'];
const claudeGroup = (mode) => (CLAUDE_GROUPS.includes(mode) ? t(`run.group.${mode}`) : undefined);
/** Keep a point to one line where possible; the chat shows the full command. */
const shortActivity = (text) => (text.length > 70 ? `${text.slice(0, 69)}…` : text);

/** The group after the last step of a test run: compare effects, learn baselines (only if needed), report. */
const END = 'end';
const endGroup = () => ({
    id: END,
    name: t('run.end.name'),
    kind: 'phase',
    points: [{ id: 'effects', kind: t('run.end.effects'), label: t('run.end.compare') }, { id: 'report', kind: t('run.end.report'), label: 'report.md' }],
});

/**
 * Hard failures of a run that the current config would allow or mark as foreign: text, URL, location or stack matches a
 * consoleIgnore or foreignCode pattern. This way a human decision also applies to a classification made before it.
 */
export const allowedNow = (failures, config) => {
    const patterns = [...(config.consoleIgnore ?? []), ...(config.foreignCode ?? [])].map((pattern) => new RegExp(pattern));
    if (patterns.length === 0) return [];
    const textOf = ({ text, url, at, stack }) => [text, url, at, ...(Array.isArray(stack) ? stack : [stack])].filter(Boolean).join('\n');
    return failures.filter((failure) => failure.type !== 'http' && patterns.some((pattern) => pattern.test(textOf(failure))));
};

/**
 * The consoleIgnore pattern for a script error: its first line without the leading error type, as a literal regex.
 * "TypeError: t.getKey is not a function" becomes "t\.getKey is not a function".
 */
export const ignorePattern = (failure) => String(failure.text ?? '').split('\n')[0].replace(/^\s*[A-Za-z]*Error:\s*/, '').trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Are the hard failures all script errors (no HTTP errors) that can be ignored by a pattern? */
export const ignorableFailures = (failures) => failures.length > 0 && failures.every((failure) => failure.type !== 'http' && ignorePattern(failure) !== '');

/**
 * With a chat the application always runs in the workbench (one window with steps, chat and requests), without one in its
 * own window. The workbench lives on the application's own origin, so this works under any URL.
 */
export const embedsApp = (interactive) => interactive === true;

/**
 * A certificate Chrome does not trust (self-signed, an internal authority) while opening the environment or signing in: an
 * environment error that names the switch, instead of Chrome's net::ERR_CERT_… line. null for anything else.
 */
export const certificateError = (error, checked) => {
    const match = /net::(ERR_CERT_[A-Z_]+) at (\S+)/.exec(String(error?.message ?? ''));
    if (match === null || error instanceof CawError) return null;
    let host = match[2];
    try {
        host = new URL(match[2]).host;
    } catch {
        // keep the text
    }
    return new CawError('env-certificate', t(checked.insecureTls ? 'run.error.certificateAnyway' : 'run.error.certificate', { host, env: checked.name, reason: match[1] }));
};

/**
 * Opens Chrome signed in and with local code. Environment errors are thrown as CawError.
 * @param interactive with a chat, i.e. with a human in front of it
 */
export const openRunSession = async ({ root, config, spec, checked, runDir, headless = false, interactive = false, agent = false, recorded = recordedBrowser(spec.steps ?? []), strict = true, info = (text) => ui.info(text) }) => {
    // What explore did not find and nobody filled in yet: sign-in would fail, so stop before Chrome and Claude.
    const todo = todoFields(config);
    if (todo.length > 0) throw new CawError('config-invalid', t('run.error.todo', { keys: todo.join(', ') }));
    const credentials = readCredentials(root, config, spec.role, checked.name);
    // Plain http beyond this machine, allowed by allowHttp: said on every run, the traffic (and any sign-in) is readable on the way.
    const address = new URL(checked.url);
    if (address.protocol === 'http:' && !isLoopback(address.hostname)) ui.warn(t('run.allowHttp', { target: checked.name, host: address.host }));
    if (!await reachable(checked.url)) {
        const { start } = effectiveEnvironment(config, checked.name);
        throw new CawError('env-unreachable', start === undefined ? t('run.error.unreachable', { url: checked.url }) : t('run.error.unreachableStart', { url: checked.url, command: start }));
    }
    const start = startPath(config, spec);
    // The overlay source must be ready before Chrome starts, otherwise the run would silently test something else. Whatever
    // caw starts for it (dev server, watch) ends with the session.
    // The overlay is an extension: loaded only when this run lays local code over the environment.
    const overlay = checked.source === 'overlay' ? await (await import('../ext/overlay/overlay.mjs')).prepareOverlay({ root, config, checked, info }) : null;
    // Imported only here so that validate works without the browser code.
    const { openBrowserSession } = await import('./browser-session.mjs');
    info(t('run.openingChrome'));
    let session;
    try {
        session = await openBrowserSession({
            config,
            resolved: checked,
            credentials,
            hosts: navigationHosts(config, checked.name),
            // With a chat Claude is (or may become) attached, and caw reproduce always has Claude: the browser then reaches only the
            // project's hosts (host-lock.mjs).
            ...((interactive || agent) && checked.agent === true ? { reach: agentHosts(config, checked.name) } : {}),
            startUrl: start,
            devlinkConfig: buildDevlinkConfig(config, checked, start),
            devlinkConfigPath: join(runDir, 'devlink-config.json'),
            tracePath: join(runDir, 'trace.zip'),
            floatsLogPath: join(runDir, 'floats.log'),
            consoleIgnore: config.consoleIgnore ?? [],
            foreignCode: config.foreignCode ?? [],
            readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
            // Language and time zone of the recording, unless the config pins them.
            recordedBrowser: recorded,
            headless,
            embed: !headless && embedsApp(interactive),
            title: `caw · ${spec.id}`,
            role: spec.role,
            overlay,
            // strict false: a mixed or unused overlay is reported via diagnose instead of ending the session (overlay check).
            overlayStrict: strict,
        });
    } catch (error) {
        overlay?.stop();
        const certificate = certificateError(error, checked);
        if (certificate !== null) throw certificate;
        const { isLoginFailure, offerAuthRepair } = await import('./login-repair.mjs');
        if (isLoginFailure(error)) {
            // Spend tokens only where Claude runs anyway: with a chat and on a target with claude. Otherwise just point the way.
            if (interactive && checked.agent) await offerAuthRepair({ root, config, target: checked.name, error }).catch(() => false);
            else error.message = `${error.message} ${t('repair.hint')}`;
        }
        throw error;
    }
    if (overlay === null) return session;
    // The overlay's full diagnosis after loading, for caw overlay check.
    session.diagnose = () => overlay.diagnose();
    const close = session.close;
    session.close = async (...args) => {
        try {
            return await close(...args);
        } finally {
            overlay.stop();
        }
    };
    return session;
};

/** Where the last run lives, for the Claude session (caw_status): `.caw/last-run.json`, written at run start. */
export const LAST_RUN_FILE = 'last-run.json';

/**
 * Notes the run that just started: { runId, runDir, pid, command, test, target, startedAt }, runDir relative to the project with
 * forward slashes. Never fails the run.
 */
export const writeLastRun = (root, { runId, runDir, command, test, target, pid = process.pid, startedAt = new Date().toISOString() }) => {
    try {
        mkdirSync(join(root, RUN_DIR), { recursive: true });
        const file = join(root, RUN_DIR, LAST_RUN_FILE);
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify({ runId, runDir: runDir.replaceAll('\\', '/'), pid, command, test, target, startedAt }, null, 2)}\n`);
        renameSync(temp, file);
    } catch {
        // Only a pointer for the session; the run itself does not depend on it.
    }
};

/** The other tests the project already has. */
const knownTests = (root, ownId) => {
    const dir = join(root, TEST_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.yaml') && name !== `${ownId}.yaml`).map((name) => posix.join(TEST_DIR, name));
};

/**
 * A new plan version invalidates checks: those of removed steps and, from the first changed step on, all later ones, since
 * the recording is a sequence. A step counts as changed if it is new or its expected result changed, or if the steps kept from
 * before are in another order. Rewording only its name, action or note keeps the check: the recorded actions are what happened,
 * the check proved the expected result.
 * @returns the ids that need to be checked again
 */
export const invalidatedChecks = (before, after, recorder) => {
    const previous = new Map(before.steps.map((step) => [step.id, step]));
    const order = after.steps.map(({ id }) => id);
    const checked = new Set(recorder.steps.filter(({ action }) => action === 'check').map(({ id }) => id));
    const keptBefore = before.steps.map(({ id }) => id).filter((id) => order.includes(id));
    const keptAfter = order.filter((id) => previous.has(id));
    const movedAt = keptAfter.findIndex((id, index) => id !== keptBefore[index]);
    const changedAt = after.steps.findIndex((step) => !previous.has(step.id) || (step.expect ?? '') !== (previous.get(step.id).expect ?? '')
        || (movedAt !== -1 && step.id === keptAfter[movedAt]));
    const removed = before.steps.map(({ id }) => id).filter((id) => !order.includes(id));
    const later = changedAt === -1 ? [] : order.slice(changedAt);
    return [...removed, ...later].filter((id) => checked.has(id));
};

/** What a step's check proved, together with everything before it: ids and expected results up to the step, in order. */
export const checkBasis = (plan, id) => {
    const at = plan.steps.findIndex((step) => step.id === id);
    return at === -1 ? null : JSON.stringify(plan.steps.slice(0, at + 1).map((step) => [step.id, step.expect ?? '']));
};

/** The fields of a step the agent gets to see. */
const planStep = ({ id, name, do: action, expect, note, retry }) => ({ id, name, do: action, expect, ...(note === undefined ? {} : { note }), ...(retry === undefined ? {} : { retry }) });
const rememberedIn = (steps) => steps.flatMap(({ recording }) => recording?.actions ?? []).filter(({ action }) => action === 'remember').map(({ name, code }) => ({ name, code }));

/**
 * Project context from caw/caw.md, like CLAUDE.md for the tests: application quirks, relevant info. Not part of the step
 * hash, so editing it does not invalidate recordings.
 */
export const readContext = (root) => {
    const file = join(root, CONTEXT_FILE);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? undefined : text;
};

/** The workbench title: a sentence with the test's name, e.g. "Claude records morning-errand". */
export const titleOf = (spec, key, vars = {}) => t(`run.title.${key}`, { ...vars, test: spec.id });

/** The header badge: only the mode, the breadcrumb already names the test, e.g. "Claude records". */
export const badgeOf = (key, vars = {}) => t(`run.badge.${key}`, vars);

/**
 * The workbench header: first the title, then chips only where the project offers a choice: the environment when there are
 * several (production always), the role when there are several, the code only under an overlay (your local build).
 * @param checked  checkTest's result: the environment (name, production) and the code source
 * @param badge    the mode for the header badge (badgeOf); the title is then its tooltip
 */
export const benchFacts = (config, spec, checked, title, badge) => {
    const several = (map) => Object.keys(map ?? {}).length > 1;
    return [
        badge === undefined ? ['', title] : ['', title, badge],
        ...(several(config.environments) || checked.production ? [[t('run.fact.target'), checked.name]] : []),
        ...(spec.role && several(config.roles) ? [[t('run.fact.role'), spec.role]] : []),
        ...(checked.source === 'overlay' ? [[t('run.fact.code'), t('run.fact.local')]] : []),
    ];
};

let cawVersion = null;
const versionOf = () => {
    try {
        cawVersion ??= String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
    } catch {
        cawVersion = '';
    }
    return cawVersion;
};

/**
 * What the workbench's settings page shows read-only. The page shares its origin with the application under test, so only what
 * the application may read anyway: names, flags, the home folder as ~ and line counts, never a note's content.
 * @param agent  the label of the sandbox Claude runs in, if known
 */
export const benchSettings = ({ root, config, spec, checked, agent, mode, run, env = process.env }) => {
    const personal = readPersonalContext(env);
    let project;
    try {
        project = readContext(root);
    } catch {
        // unreadable: shown as missing, the run does not depend on it here
    }
    return {
        project: basename(root),
        // For caw.info in the console: which test, how and in which run folder.
        test: spec.id,
        ...(mode === undefined ? {} : { mode }),
        ...(run === undefined ? {} : { run }),
        framework: config.framework ?? 'web',
        config: CONFIG_FILE,
        env: { name: checked.name, url: checked.url, agent: checked.agent === true, writable: checked.writable === true, production: checked.production === true },
        ...(spec.role === undefined ? {} : { role: spec.role }),
        code: checked.source === 'overlay' ? t('run.fact.local') : t('run.fact.deployed'),
        version: `caw ${versionOf()} · Node ${process.versions.node.split('.')[0]}`,
        ...(typeof agent === 'string' && agent !== '' ? { agent } : {}),
        language: { value: language(), source: languageSource({ env, team: config.language }) },
        tokenNotice: readPrefs(env).tokenNotice === 'off' ? 'off' : 'on',
        prefsFile: shownPath(join(prefsDir(env), 'prefs.json')),
        personal: { path: personal?.shown ?? shownPath(personalContextPath(env)), lines: personal?.lines ?? null },
        projectNotes: { path: CONTEXT_FILE, lines: project === undefined ? null : project.split('\n').length },
    };
};

/**
 * @param sandbox  result of prepareSandbox
 * @param options  spec, target, checked, timeoutMin, containerCommand, note;
 *                 `handover` decides from the result whether the window is handed to the human;
 *                 with `replay` and `stepTimeoutMs` the recording plays instead of the container, otherwise Claude works;
 *                 `repair` { id, reason } has Claude fix only that step, the steps before it are replayed first without him;
 *                 with `from` Claude re-records from that step to the end of the test;
 *                 `command` names the run in .caw/last-run.json (open), otherwise it follows from replay and repair;
 *                 when recording, `previous` gives Claude the old test plan, `demonstration` the demonstration; `maxActions` caps its actions;
 *                 `conversation` { transcript, onChatOpen, lazy, alsoOnWarnings } opens the chat; with `lazy` only once a step
 *                 failed, with `alsoOnWarnings` also for failures and warnings of an otherwise passed run;
 *                 `conclude` runs while the chat is still open and gets `advise`, which lets Claude give advice;
 *                 `adviseCommand` replaces Claude for that, like `containerCommand` when recording
 * @returns { exitCode, verdict, failed, candidate, fresh, expectChange, ids, removed }
 */
export const executeRun = async (root, config, sandbox, { spec: givenSpec, checked, target, handover, timeoutMin, containerCommand, adviseCommand, talkCommand, repair, replay, stepTimeoutMs, note, maxActions, demonstration, previous, conversation, conclude, develop, command: runAs, headless = false, learns = true, offerLearning = false, reproduce }) => {
    // Mutable: repairing in the same browser turns the test run into a run that fixes exactly this step.
    let repairing = repair === undefined ? undefined : givenSpec.steps.find(({ id }) => id === repair.id);
    // Re-recording from a step on: that step and all after it, as they are in the test file.
    const range = repair?.from === true ? givenSpec.steps.slice(givenSpec.steps.indexOf(repairing)) : undefined;
    // Up to a state only the steps on the way there count (at the entry of a step not that step), when repairing only the steps
    // being repaired, and a plan being created has none yet.
    const reached = replay?.until === undefined && replay?.entry === undefined ? null : new Set(replay.steps.filter(({ action }) => action === 'check').map(({ id }) => id));
    let spec = givenSpec;
    if (reached !== null) spec = { ...givenSpec, expectations: givenSpec.expectations.filter(({ id }) => reached.has(id)) };
    if (repairing !== undefined) {
        const repaired = new Set((range ?? [repairing]).map(({ id }) => id));
        spec = { ...givenSpec, steps: range ?? [repairing], expectations: givenSpec.expectations.filter(({ id }) => repaired.has(id)) };
    }
    const runTag = newRunTag();
    const creating = replay === undefined && repair === undefined;
    // A reproduction is named as such, also when it starts from a test's step (--from).
    const runName = reproduce === undefined ? spec.id : REPRODUCE_RUN;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${runName}`;
    const relativeRun = posix.join(RUN_DIR, 'runs', runId);
    const runDir = join(root, relativeRun);
    const agentDir = join(runDir, AGENT_DIR);
    const channel = join(agentDir, CHANNEL_DIR);
    mkdirSync(channel, { recursive: true });
    // Old runs go (the newest keepRuns stay, open ones always); this one is open now.
    markRunAlive(runDir);
    pruneRuns(root, config.keepRuns ?? DEFAULT_KEEP_RUNS, { except: runId });
    let runCommand = 'run';
    if (reproduce !== undefined) runCommand = 'reproduce';
    else if (repair !== undefined) runCommand = range === undefined ? 'repair' : 'record';
    else if (creating) runCommand = 'record';
    else if (runAs !== undefined) runCommand = runAs;
    else if (replay.entry !== undefined || (replay.steps.length === 0 && replay.until === undefined)) runCommand = 'open';
    writeLastRun(root, { runId, runDir: relativeRun, command: runCommand, test: spec.id, target });

    const startedAt = Date.now();
    // The mode: a short label for the terminal, a sentence with the test's name for the workbench title.
    let headerMode = ['record'];
    if (reproduce !== undefined) headerMode = ['reproduce'];
    else if (replay !== undefined && conversation !== undefined && conversation.lazy !== true && conversation.testing !== true) headerMode = ['verify'];
    else if (replay?.entry !== undefined) headerMode = ['entry', { id: replay.entry.id }];
    else if (replay !== undefined && replay.steps.length === 0) headerMode = ['open'];
    else if (replay !== undefined && runAs === 'open') headerMode = ['openTest'];
    else if (replay !== undefined) headerMode = ['replay'];
    else if (range !== undefined) headerMode = ['recordFrom', { id: repair.id }];
    else if (repair !== undefined) headerMode = [repair.rerecord ? 'rerecord' : 'repair', { id: repair.id }];
    const modeLabel = t(`run.mode.${headerMode[0]}`, headerMode[1]);
    // Which code runs, always on one line, also in CI: otherwise a silently deployed version would only show in the result.
    const codeLine = describeCode(config, spec, checked, { root });
    ui.header({ mode: modeLabel, test: spec.id, target, role: spec.role, source: checked.source, code: codeLine, language: teamLanguage(config), ...(replay === undefined ? { maxActions } : {}) });
    // For the terminal's result: each step's name, and how long a replayed step took (from its first action to the next step's).
    const stepNames = () => Object.fromEntries((givenSpec.steps ?? []).filter(({ name }) => typeof name === 'string' && name !== '').map(({ id, name }) => [id, name]));
    const stepTimes = new Map();
    const durations = () => Object.fromEntries([...stepTimes].filter(([, { end }]) => end !== undefined).map(([id, { start, end }]) => [id, (end - start) / 1000]));

    // `code`: the same words as the CLI line, e.g. "dev server localhost:5173, your current version" instead of just "deployed".
    const reportBase = { testId: runName, target, source: checked.source, testedCode: codeLine, expectations: spec.expectations, ...(note === undefined ? {} : { note }) };
    // A reproduction's report shows the bug report and the run's rules also when it ends early; finish adds Claude's verdict.
    if (reproduce !== undefined) reportBase.reproduce = { bug: reproduce.bug, writable: reproduce.writes, ...(reproduce.from === undefined ? {} : { from: reproduce.from }) };
    let verdict = null;
    // --attach: the link to the person's session, its line in the header, and the tasks it has not heard of yet.
    let link = null;
    let linkSession = () => {};
    let linkFact = null;
    let shownFacts = [];
    const announcedAgents = new Set();
    const pendingTells = [];
    let chat = null;
    const withLink = (entries) => (linkFact === null ? entries : [...entries, [t('run.fact.agent'), linkFact]]);
    let session;
    // All advice of this run, also across several sessions: the report lists them together.
    const decided = [];
    // One budget per run for advice with code edits: after five rejected submissions, edits are refused.
    const checkAdvice = adviceReader();
    const adviceNotes = [];
    const adviceOf = () => (decided.length === 0 && adviceNotes.length === 0 ? {} : { advice: { items: decided, ...(adviceNotes.length === 0 ? {} : { note: adviceNotes.join(' ') }) } });
    // If Claude gives advice while repairing and then submits a verdict, the advice stays in the report.
    const writeResult = (outcome) => {
        // Redacted as for Claude: the role password and secret remembered values never end up in result.json or report.md.
        verdict = redactDeep({ ...outcome, ...reportBase, writes: session?.writes() ?? [], thirdParty: session?.thirdParty?.() ?? [], warnings: session?.warnings?.() ?? [], ...(session?.overlay?.() ? { overlay: session.overlay() } : {}), ...adviceOf() }, session?.secrets?.() ?? []);
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        // report.md is shared: in the team language if caw has it, whatever the reader's terminal speaks.
        writeFileSync(join(runDir, 'report.md'), inLanguage(teamLanguage(config), () => (reproduce === undefined ? renderReport : renderReproduceReport)(verdict)));
        // The run is over: nothing runs any more, so the chip goes away.
        session?.workbench?.transport?.(null)?.catch?.(() => {});
    };
    /**
     * After the handover the result stands, but the window was still watched: hosts it blocked and errors it saw go into the report
     * as a section of their own, written again when the window closes. The result itself does not change.
     */
    const noteAfterHandover = (handedAt) => {
        const warned = (session.warnings?.() ?? []).flatMap(({ type, text, origin, url, count }) => {
            const before = handedAt.warnings.get(`${type}
${text}`) ?? 0;
            return count > before ? [{ type, text, ...(origin === undefined ? {} : { origin }), ...(url === undefined ? {} : { url }), count: count - before }] : [];
        });
        const failed = (session.failures?.() ?? []).slice(handedAt.failures).map(({ type, text, url }) => ({ type, text, ...(url === undefined ? {} : { url }), count: 1 }));
        const seen = [...failed, ...warned];
        // The agent started after the handover (develop): the report names the personal notes it got, as for any run.
        const late = reportBase.personalContext !== undefined && verdict?.personalContext === undefined;
        if (verdict === null || (seen.length === 0 && !late)) return;
        verdict = redactDeep({ ...verdict, ...(late ? { personalContext: reportBase.personalContext } : {}), ...(seen.length === 0 ? {} : { afterHandover: seen }) }, session.secrets?.() ?? []);
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        writeFileSync(join(runDir, 'report.md'), inLanguage(teamLanguage(config), () => (reproduce === undefined ? renderReport : renderReproduceReport)(verdict)));
    };
    const finishRun = () => {
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), reportUrl: pathToFileURL(join(runDir, 'report.md')).href, elapsed: (Date.now() - startedAt) / 1000, names: stepNames(), durations: durations() });
        // Missing saved sign-in or a TODO left in the config means nothing ran: an invalid invocation (3), not the environment (2).
        if (verdict.status === 'error' && NOTHING_RAN.has(verdict.code)) return EXIT.rejected;
        return EXIT[verdict.status];
    };

    /** After a replay up to the entry of a step: its entry points passed, or the last one failed if the entry broke. */
    const markEntry = async (plan, failed) => {
        if (plan?.entry === undefined) return;
        const broke = failed?.id === plan.entry.id;
        for (const position of entryPoints) await session.workbench?.point(plan.entry.id, `a${position}`, broke && position === entryPoints.at(-1) ? 'fail' : 'pass');
        if (broke) await session.workbench?.step(plan.entry.id, 'fail');
        entryPoints = [];
    };
    // The entry actions of the current replay (replayToEntry) that ran: the step itself is not judged, its points are.
    let entryPoints = [];
    // Every recorded action is a point of its step. Without an action, the replay reports a new attempt.
    const showAction = ({ owner, position, step, label }) => {
        const bench = session?.workbench;
        if (bench === undefined || bench === null) return;
        if (step?.entry !== undefined) {
            entryPoints.push(position);
            bench.point(owner, `a${position}`, 'running');
            return;
        }
        bench.step(owner, 'running');
        if (step === undefined) bench.point(owner, `v${position}-${Date.now()}`, 'pass', { kind: t('run.point.attempt'), label: label.replace(/^\S+: /, '').replace(/^(neuer Versuch|attempt) /, '') });
        else bench.point(owner, `a${position}`, 'running');
    };
    // Ctrl+C, a CI cancel (SIGTERM), a closed terminal (SIGHUP, on Windows also Ctrl+Break) end the run alike: verdict, Chrome
    // profile and dev server cleaned up. Listening from before Chrome starts: a signal while it starts ends the run right after.
    let abortSignal;
    const aborted = new Promise((ok) => { abortSignal = ok; });
    const stopSignals = onAbortSignals(abortSignal);
    try {
        session = await openRunSession({ root, config, spec, checked, runDir, headless, interactive: conversation !== undefined, agent: reproduce !== undefined, recorded: recordedBrowser(givenSpec.steps) });
        // Distinct fact names: otherwise "target" could mean a step's element and "version" the recording.
        // --attach: the person's own session answers. The header says whether it is there, the chat when that changes. Linked
        // when the session box is first used: at the start, or only after the handover (open, develop).
        linkSession = (box) => {
            if (link !== null || box?.kind !== 'session') return;
            link = createSessionLink({
                root,
                want: box.attach ?? true,
                onState: (state, { key, candidates = [] }) => {
                    linkFact = state === 'connected' || state === 'back' ? t('run.attach.factConnected', { key }) : state === 'lost' ? t('run.attach.factLost') : t('run.attach.factWaiting');
                    session.workbench?.facts(withLink(shownFacts)).catch(() => {});
                    const line = state === 'waiting' ? t(candidates.length > 1 ? 'run.attach.several' : 'run.attach.waiting', { keys: candidates.join(', ') })
                        : t(`run.attach.${state}`, { key });
                    if (state !== 'waiting' || candidates.length > 1 || chat !== null) chat?.notice(line);
                    if (state === 'lost') chat?.working?.(false);
                    ui.info(line);
                    for (const announced of announcedAgents) if (key !== undefined && key !== null) announced.rebind(key);
                    if (state === 'connected' || state === 'back') for (const [mode, hint] of pendingTells.splice(0)) link.tell(t('run.attach.event', { runId, mode, hint }));
                },
            });
        };
        linkSession(sandbox);
        shownFacts = benchFacts(config, spec, checked, titleOf(spec, ...headerMode), badgeOf(...headerMode));
        await session.workbench?.facts(withLink(shownFacts));
        await session.workbench?.settings?.(benchSettings({ root, config, spec, checked, agent: sandbox?.label ?? sandbox?.docker?.label, mode: runCommand, run: runId }));
        await session.workbench?.transport?.(transportOf(replay));
        await session.workbench?.steps([...stepGroups(spec.steps, replay), ...(replay === undefined ? [] : [endGroup()])]);
    } catch (error) {
        stopSignals();
        if (!(error instanceof CawError)) throw error;
        writeResult({ status: 'error', code: error.code, reason: error.message });
        return { exitCode: finishRun(), verdict };
    }

    // On abort the workbench shows the run as cancelled.
    aborted.then(() => session?.workbench?.mood?.('aborted')).catch(() => {});

    // The chat always sits next to the application window (declared with the link above). With `lazy` it opens only when
    // something goes wrong.
    const tokensOk = createTokenGate({ chat: () => chat });
    // The developer's own Claude Code session is already running and paid for: no token notice for it.
    const claudeMayStart = (box, options) => (box?.kind === 'session' ? true : tokensOk(options));
    // The page under test touched the chat frame: the run ends like an abort, with that error as its reason.
    let tampered = null;
    const onTampered = (error) => {
        tampered = error;
        ui.note(error.message);
        abortSignal();
    };
    const openConversation = () => openChat({ session, logPath: join(runDir, 'chat.log'), onAbort: abortSignal, onOpen: conversation.onChatOpen, onWaiting: ui.note, onTampered, transcript: conversation.transcript });
    if (conversation !== undefined && conversation.lazy !== true) {
        try {
            chat = await openConversation();
            if (replay !== undefined && conversation.testing === true) chat.testing();
            else if (replay !== undefined) chat.verifying();
        } catch (error) {
            stopSignals();
            await session.close();
            if (!(error instanceof CawError)) throw error;
            writeResult({ status: 'error', code: error.code, reason: error.message });
            return { exitCode: finishRun(), verdict };
        }
    }

    for (const { screenshot } of demonstration?.items ?? []) {
        if (screenshot !== undefined) copyFileSync(join(demonstration.dir, screenshot), join(agentDir, screenshot));
    }
    const others = knownTests(root, spec.id);
    const context = readContext(root);
    // The human's own notes across projects (caw.md in the settings folder): read before the project's, which wins.
    const personal = readPersonalContext();
    const run = {
        runId,
        // Team language: Claude talks to the human and writes steps and expectations in it.
        language: teamLanguage(config),
        target,
        source: checked.source,
        framework: frameworkOf(config).name,
        writes: spec.writes,
        expectations: spec.expectations,
        notes: spec.notes,
        steps: spec.steps.map(planStep),
        runTag,
        maxActions,
        ...(others.length === 0 ? {} : { knownTests: others }),
        ...(personal === undefined ? {} : { personalContext: personal.text }),
        ...(context === undefined ? {} : { context }),
        ...(creating ? { create: { role: spec.role ?? null } } : {}),
        ...(!creating || previous === undefined ? {} : {
            previous: {
                plan: renderPlan(previous),
                steps: previous.steps.map(({ id, recording }) => ({ id, actions: recording?.actions.map(stepLabel) ?? [], check: recording?.check })),
                remembered: rememberedIn(previous.steps),
            },
        }),
        ...(demonstration === undefined ? {} : { demonstration: withNoteIds(demonstration.items) }),
    };
    // The human's notes, H1, H2 …: the plan says in `heard` what became of each, and the card shows it.
    const humanNotes = demonstration === undefined ? [] : withNoteIds(demonstration.items).filter(({ action }) => action === 'note');
    // Remembered values of the run, placeholder -> value. Claude sees secret ones only as placeholders; the handler fills them in.
    let remembered = new Map();
    const isSecret = (value) => (session.secrets?.() ?? []).includes(value);
    const openRemembered = () => [...remembered].filter(([, value]) => !isSecret(value));
    const fillSecrets = (text) => [...remembered].filter(([, value]) => isSecret(value)).reduce((current, [placeholder, real]) => current.split(placeholder).join(real), text);
    let verdictGiven;
    /**
     * One handler per verdict: after `finish` it accepts nothing more; repairing in the same browser brings a second verdict.
     * @param task another task, e.g. when restoring a test picked with F1: its checks belong to its own steps
     */
    const newAgentHandler = (task = run) => {
        let verdictSignal;
        verdictGiven = new Promise((ok) => { verdictSignal = ok; });
        return createAgentHandler({
            session,
            run: task,
            hosts: navigationHosts(config, checked.name),
            agentDir,
            filesDir: join(root, PROJECT_DIR),
            expand: fillSecrets,
            onVerdict: (outcome) => { writeResult(outcome); verdictSignal(); },
        });
    };
    let agentHandler = newAgentHandler();
    // What the replay read; Claude needs these values when repairing in the same browser.
    let played = null;

    // True while caw signs in again (restoring a state): the page holds the password and the one-time code then.
    let signingIn = false;
    /**
     * What Claude gets through the channel, whichever handler answers: refused while caw signs in (except talking), every
     * answer and error with the secrets masked (a dialog text, a URL, a thrown value), errors without Playwright's call log.
     */
    // The agent's latest activity in the step list; it is done once the agent speaks or waits for the person.
    let closeActivity = () => {};
    const forClaude = (handler) => async (command) => {
        // Commands with which the agent waits for the person: a chat answer or a question to show in the browser.
        const waits = ['chat', 'ask-operator'].includes(command?.action);
        if (command?.action === 'say' || waits) closeActivity();
        // The chat shows "working" until the agent waits for the person again.
        if (typeof command?.action === 'string') chat?.working?.(!waits);
        if (signingIn && !['task', 'say', 'chat'].includes(command?.action)) throw new CawError('signing-in', t('run.agent.signingIn'));
        let value;
        try {
            value = await handler(command);
        } catch (error) {
            throw await hiddenError(session, error);
        }
        return hiddenAnswer(session, value);
    };
    /** Processes the commands from the container until the returned stop function halts it. */
    const startPump = (handler) => {
        let pumping = true;
        const ignored = new Set();
        const answer = forClaude(handler);
        const loop = (async () => {
            while (pumping) {
                // The folder belongs to the container. A failure here must not crash the run, or browser and container
                // would be left behind; at worst the run ends without a verdict.
                await pollChannel(channel, answer, ignored).catch((error) => ui.warn(t('run.channelError', { message: error.message }), console.error));
                await sleep(POLL_MS);
            }
        })();
        // If the channel is waiting for the human, only closing the browser releases it. Do not wait for that.
        return () => { pumping = false; return Promise.race([loop, sleep(1000)]); };
    };
    /** Starts the agent for this run, locally or in the container. Its log is echoed in the chat as plain text; the file belongs to the agent. */
    const startAgent = (box, agentCommand, logName, mode = 'run') => {
        // Claude works: the report says the personal notes were part of the task (where they are, not what they say).
        if (personal !== undefined) reportBase.personalContext = { path: personal.shown, lines: personal.lines, ...(personal.truncated ? { truncated: true } : {}) };
        const log = () => readAgentLog(join(agentDir, logName));
        // What Claude does also shows in the step list: when recording under the running step, otherwise in its own group.
        const bench = session?.workbench ?? null;
        const own = claudeGroup(mode);
        if (bench !== null && own !== undefined) bench.group({ id: CLAUDE_GROUP, name: own, kind: 'phase' });
        let lastPoint = null;
        let count = 0;
        closeActivity = () => closePoint();
        // Actions of one kind in a row share one item ("Read 2 files", unfolds to the files); the call is its tooltip.
        let fold = null;
        const notePoint = (line) => {
            const entry = parseClaudeLog(line);
            if (bench === null || entry === null || entry.kind !== 'activity') return;
            const group = own === undefined ? bench.running() : CLAUDE_GROUP;
            if (group === null) return;
            fold = lastPoint !== null && lastPoint[0] === group ? foldAction(fold, entry) : foldAction(null, entry);
            if (!fold.merged) {
                count += 1;
                lastPoint = [group, `c${count}`];
            }
            const items = fold.items.filter((item) => item !== '');
            bench.point(group, lastPoint[1], 'running', { kind: AGENT_NAME, label: shortActivity(fold.text), raw: fold.raws.join('\n'), ...(items.length > 1 || (fold.group === 'shell' && items.length > 0) ? { details: items } : {}) });
        };
        const closePoint = () => {
            if (lastPoint !== null) bench?.point(lastPoint[0], lastPoint[1], 'pass');
            lastPoint = null;
            fold = null;
        };
        const onLine = (line) => {
            chat?.logLine(line);
            notePoint(line);
        };
        if (box.kind === 'session') {
            linkSession(box);
            const hints = {
                run: `Run ${runId} is open. Carry it out and submit the result with finish.`,
                advise: `Run ${runId} had failures or warnings. Read the task with task and submit your advice with advise.`,
                talk: `In run ${runId} a step failed, and the human is asking you in the chat. Read the task with task, answer with say and wait for the human with chat.`,
                reproduce: `Run ${runId} reproduces a bug report on its own, without a human. Read the bug report with task, try to reproduce it in the browser and submit your verdict with finish.`,
                develop: `In run ${runId} the human is developing in the restored state. Read the task with task; you can read the page (snapshot, eval, console, network) and operate it on request (click, fill, type, press, goto, reload). Fetch questions from the workbench chat with chat and answer there with say.`,
            };
            // The session reads these topics with caw_guide; caw_status names them. Its Monitor hears of the task at once.
            const agent = announceSessionAgent({ root, runId, agentDir, mode, hint: hints[mode], guide: [...runTopics(mode, { creating, config }), 'attach'], attach: link?.key() ?? null });
            announcedAgents.add(agent);
            if (link?.key() === null || link?.state() === 'lost') pendingTells.push([mode, hints[mode]]);
            else link?.tell(t('run.attach.event', { runId, mode, hint: hints[mode] }));
            // Without a link (it could not start) the chat at least says whom it waits for; with one, its waiting line says so.
            if (link === null) chat?.progress?.(t('run.waitingForSession'));
            return {
                ended: agent.ended,
                log: () => '',
                stopTail: () => {},
                stop: async () => {
                    announcedAgents.delete(agent);
                    await agent.stop();
                },
            };
        }
        // A local or container agent gets the run topics of the guide as its system prompt addition, from the agent folder. The
        // folder is the container's: whatever lies there (a planted link) goes first, then the file is created, never followed.
        rmSync(join(agentDir, GUIDE_FILE), { force: true });
        writeFileSync(join(agentDir, GUIDE_FILE), agentGuide(config), { flag: 'wx' });
        if (box.kind === 'local') {
            const agent = startLocalAgent({ command: agentCommand, agentDir, root, color, limits: claudeLimits(config) });
            const stopTail = (() => { const stop = tailLines(log, onLine); return () => { stop(); closePoint(); }; })();
            return {
                ended: agent.ended,
                log,
                stopTail,
                stop: async () => {
                    stopTail();
                    await agent.stop();
                },
            };
        }
        const containerName = `caw-${randomBytes(4).toString('hex')}`;
        const { docker } = box;
        const container = docker.run(sandboxRunArgs({
            ...box,
            name: containerName,
            hostAgentDir: docker.hostPath(agentDir),
            containerAgentDir: posix.join(box.containerRoot, relativeRun, AGENT_DIR),
            command: agentCommand,
            color,
            limits: claudeLimits(config),
        }));
        const stopTail = (() => { const stop = tailLines(log, onLine); return () => { stop(); closePoint(); }; })();
        return {
            ended: container.then(({ code }) => ({ code })),
            log,
            stopTail,
            stop: async () => {
                stopTail();
                await docker.run(['rm', '-f', containerName], { capture: true });
                await container;
            },
        };
    };

    /** Adds the advice to report and result. The verdict itself stays as it was. */
    const writeAdvice = () => {
        if (decided.length === 0 && adviceNotes.length === 0) return;
        if (verdict !== null) verdict = { ...verdict, ...adviceOf() };
        // Before a verdict the run is still open; its result replaces this when the run ends.
        const shown = verdict ?? redactDeep({ ...reportBase, status: 'open', ...adviceOf() }, session?.secrets?.() ?? []);
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(shown, null, 2));
        writeFileSync(join(runDir, 'report.md'), inLanguage(teamLanguage(config), () => renderReport(shown)));
    };
    /**
     * Presents advice as cards and applies each decision: knowledge, config and code at once, the test only in the result.
     * @returns { result, review(items) }; `result` collects { spec, touched, stale, notes, files }
     */
    const createReviewer = (draft) => {
        const result = { spec: draft, touched: [], stale: [], notes: false, files: [] };
        const review = async (items, log) => {
            const start = decided.length;
            for (const item of items) {
                const view = adviceView(item, result.spec, session?.failures?.() ?? [], config);
                const answer = await chat.advice(view, item.side === 'app' ? (item.edits === undefined ? [NEXT] : [APPLY, { ...NEXT, primary: false }]) : [ACCEPT, REJECT]);
                let decision = 'shown';
                if (answer === null) decision = 'open';
                else if (item.side === 'test') decision = answer === ACCEPT.id ? 'adopted' : 'discarded';
                else if (answer === APPLY.id) decision = 'applied';
                if (decision === 'applied') {
                    for (const file of applyEdits(root, item.edits)) if (!result.files.includes(file)) result.files.push(file);
                } else if (decision === 'adopted' && changesFiles(item)) {
                    const file = applyToFiles(root, item.change);
                    // The personal notes are no file of the project: the project's list of changed files leaves them out.
                    if (item.change.file !== 'personal' && !result.files.includes(file)) result.files.push(file);
                    // Applies at once, also to the next verification run of this command: it does not reread the config.
                    if (item.change.kind === 'config') config[item.change.key] = configValue(config, item.change);
                } else if (decision === 'adopted') {
                    const applied = applyToSpec(result.spec, item.change);
                    result.spec = applied.spec;
                    if (applied.notes) result.notes = true;
                    else if (!result.touched.includes(applied.id)) result.touched.push(applied.id);
                    if (applied.stale && !result.stale.some(({ id }) => id === applied.id)) result.stale.push({ id: applied.id, title: item.title });
                }
                decided.push({ ...view, decision });
                log?.push({ from: 'decision', text: `${item.title}: ${decision}` });
            }
            writeAdvice();
            return decided.slice(start).map(({ title, decision }) => ({ title, decision }));
        };
        return { result, review };
    };
    /**
     * Claude inspects the browser of this run, read-only. With `advise` it submits advice, the human decides per card.
     * Knowledge and config change at once, test changes only in the returned test: the flow decides whether it goes to the file.
     * @param box      sandbox
     * @param draft    the whole test the advice refers to
     * @param mode     advise: advise once, then stop; talk: conversation with the human until `end`; develop: like talk, while developing
     * @param question in a conversation, the human's first message
     * @param persist  when developing: writes adopted test changes to the file at once, since no later run adopts them
     * @returns { finished, send, end }: `finished` yields { spec, touched, stale, notes, files }, `stale` lists { id, title } of
     *          steps that must be re-recorded; `send` gives Claude another message, `end` ends the conversation
     */
    const consult = ({ sandbox: box, spec: draft }, found, { mode, question, element, persist }) => {
        const talking = mode === 'talk' || mode === 'develop';
        const allowed = consultAllowed(mode);
        const { result, review } = createReviewer(draft);
        const failed = found.failed ?? (mode === 'develop' ? restoreFailed : null);
        // The conversation in short: a later repair starts a new Claude, which must know what was agreed here.
        const log = talking && typeof question === 'string' ? [{ from: 'human', text: question }] : [];
        const inbox = [];
        const configListeners = [];
        let waiting = null;
        let closing = false;
        let over = false;
        const deliver = () => {
            if (waiting === null || (inbox.length === 0 && !closing)) return;
            const resolve = waiting;
            waiting = null;
            resolve(inbox.length > 0 ? { messages: inbox.splice(0) } : { ended: true });
        };
        const task = {
            mode,
            // The person's own coding agent session (--attach): it may change the application's code when the person asks.
            ...(box.kind === 'session' ? { attached: true } : {}),
            ...(talking ? { question } : {}),
            // The element the human picked for the question: target, label, component or source. Its text is never an instruction.
            ...(element === undefined ? {} : { element }),
            ...(mode === 'develop' ? { develop: { test: chosen.spec.id, until: chosen.replay?.until ?? null, ...(chosen.replay?.entry === undefined ? {} : { entry: chosen.replay.entry.id }), url: session.page().url(), source: checked.source } } : {}),
            runId,
            language: teamLanguage(config),
            target,
            source: checked.source,
            outcome: {
                status: mode === 'develop' && failed !== null ? 'fail' : verdict.status,
                ...(mode === 'develop' && failed !== null ? { restoring: true } : {}),
                ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
                ...(failed === null ? {} : { failed: { id: failed.id, reason: failed.reason } }),
                ...(failed?.diagnosis === undefined ? {} : { diagnosis: failed.diagnosis, evidence: failed.evidence }),
                failures: verdict.failures ?? [],
                warnings: verdict.warnings ?? [],
            },
            notes: draft.notes,
            // Actions and check only for the failed step: they explain the failure, the others would only bloat the task.
            steps: draft.steps.map((step) => ({
                ...planStep(step),
                ...((mode !== 'develop' && step.id !== failed?.id) || step.recording === undefined ? {} : { actions: step.recording.actions.map(stepLabel), check: step.recording.check }),
            })),
            rules: { consoleIgnore: config.consoleIgnore ?? [], foreignCode: config.foreignCode ?? [], messageSelectors: session?.messageSelectors ?? config.messageSelectors ?? [] },
            ...(session?.framework?.hints === undefined ? {} : { framework: { name: session.framework.name, hints: session.framework.hints } }),
            ...(personal === undefined ? {} : { personalContext: personal.text }),
            ...(context === undefined ? {} : { context }),
            ...(config.lintCommand === undefined ? {} : { lintCommand: config.lintCommand }),
        };
        const reader = createAgentHandler({ session, run: task, hosts: navigationHosts(config, checked.name), agentDir, onVerdict: () => {} });
        let doneSignal;
        const done = new Promise((ok) => { doneSignal = ok; });
        let submitted = false;
        const handler = async (command) => {
            if (!allowed.has(command?.action)) {
                throw new CawError('advise-only', `Read-only here, ${String(command?.action)} is not allowed. Allowed: ${[...allowed].join(', ')}.`);
            }
            if (command.action === 'say') {
                if (talking) log.push({ from: 'claude', text: String(command.text ?? '') });
                return chat.say(command.text);
            }
            // Waits for the human: new messages, or the end as soon as a button is pressed.
            if (command.action === 'chat') return closing && inbox.length === 0 ? { ended: true } : new Promise((resolve) => { waiting = resolve; deliver(); });
            if (command.action !== 'advise') return reader(command);
            if (submitted && !talking) throw new CawError('advise-only', 'The advice has already been submitted.');
            const items = checkAdvice(command.advice, result.spec, config, { root, diagnosis: failed?.diagnosis });
            submitted = true;
            try {
                const decisions = await review(items, talking ? log : undefined);
                // An adopted config change (e.g. an ignored error): listeners check whether everything is allowed now.
                if (items.some((item, index) => item.change?.kind === 'config' && decisions[index]?.decision === 'adopted')) {
                    for (const notify of configListeners.splice(0)) notify();
                }
                if (items.some((item, index) => item.side === 'test' && !changesFiles(item) && decisions[index]?.decision === 'adopted')) await persist?.(result);
                return decisions;
            } finally {
                if (!talking) doneSignal();
            }
        };

        if (!talking) chat.advising();
        ui.info(t(mode === 'develop' ? 'run.consult.develop' : talking ? 'run.consult.talk' : 'run.consult.advise'));
        const stopPump = startPump(handler);
        const command = talking
            ? talkCommand ?? ['caw', 'agent', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin ?? CLAUDE_TIMEOUT_MIN), mode === 'develop' ? '--develop' : '--talk']
            : adviseCommand ?? ['caw', 'agent', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin ?? CLAUDE_TIMEOUT_MIN), '--advise'];
        let agent = IDLE_AGENT;
        const finished = (async () => {
            // Token notice first; if the human declines, continue without Claude.
            if (!await claudeMayStart(box, { decline: t('run.tokens.withoutClaude') })) {
                // Over at once: a message right after declining needs a new session, asking again.
                over = true;
                chat.progress(t('run.tokens.declined'));
                if (!talking) chat.advising(false);
                await stopPump();
                return result;
            }
            // Until its first action or answer the chat shows that the agent starts (with the time): that takes a while.
            if (talking && box?.kind !== 'session') chat.starting?.(t('run.flow.preparingSandbox'));
            agent = startAgent(box, command, talking ? TALK_LOG : ADVICE_LOG, mode);
            let adviceNote;
            try {
                const ended = await Promise.race([done.then(() => 'done'), agent.ended, session.closed.then(() => 'browser-closed'), aborted.then(() => 'aborted')]);
                // In a conversation Claude has only just learned of the end: give it a moment to fetch the last answer and stop cleanly.
                // Not while developing: the person ended it, nothing is left to fetch, and the window should close at once.
                if (ended === 'done' && talking && mode !== 'develop') await Promise.race([agent.ended, new Promise((ok) => { setTimeout(ok, 3000).unref?.(); })]);
                agent.stopTail();
                if (ended !== 'done') {
                    const broke = talking ? 'run.consult.talkBroke' : 'run.consult.adviceBroke';
                    if (ended === 'browser-closed' || ended === 'aborted') adviceNote = talking ? undefined : t('run.consult.endedEarly');
                    else if (ended.code !== 0 && agent.log() !== '') adviceNote = t(broke, { reason: claudeFailureReason(ended.code, agent.log()) });
                    else if (ended.code !== 0) adviceNote = t(broke, { reason: t('run.sandboxExit', { code: ended.code }) });
                    else if (!talking) adviceNote = t('run.consult.noAdvice');
                }
            } finally {
                await agent.stop();
                await stopPump();
                chat.working?.(false);
            }
            if (!talking) chat.advising(false);
            if (adviceNote !== undefined) {
                adviceNotes.push(adviceNote);
                chat.progress(adviceNote.replace(/\.$/, ''));
            }
            writeAdvice();
            over = true;
            return result;
        })();
        return {
            finished,
            /** Claude is done, on its own or because the run ended: a new message needs a new session. */
            over: () => over,
            /** The conversation so far: { from: human | claude | decision, text } */
            log: () => [...log],
            /** Resolves as soon as the human adopts a config change. */
            configChanged: () => new Promise((resolve) => { configListeners.push(resolve); }),
            send: (message, picked) => {
                log.push({ from: 'human', text: String(message) });
                // "Working" at once, but only if an agent hears it: an attached session that is not there does not work.
                if (box.kind !== 'session' || ['connected', 'back'].includes(link?.state())) chat.working?.(true);
                // The person's own session hears of it through its Monitor; the text itself it fetches with chat.
                if (box.kind === 'session') link?.tell(t(picked === undefined ? 'run.attach.message' : 'run.attach.messageElement', { runId, text: String(message).slice(0, 300) }));
                inbox.push(picked === undefined ? message : { text: message, element: picked });
                deliver();
            },
            end: () => {
                closing = true;
                deliver();
                doneSignal();
                return finished;
            },
        };
    };
    const adviseRun = (options, found) => consult(options, found, { mode: 'advise' }).finished;

    /** Reloads the app with the current code; the page state is usually lost. */
    const reloadApp = async () => {
        const ready = await session.restart();
        return ready.settled ? t('run.reloaded') : t('run.reloadedUnsettled', { reason: ready.reason });
    };
    // The current state: the run's, or after picking with F1 the picked one. "Restore state" restores it.
    let chosen = { spec, replay };
    /**
     * Replays the steps up to the state again, in the same window with the current code and a new runTag: what the run
     * created before stays, a new record is added.
     */
    const restoreState = async () => restoreWith(chosen);
    /**
     * Another state, picked with F1 in the workbench: a test of the same role, app and target, at the entry of a step (`entry`)
     * or up to its last restorable step. The step list then shows that test.
     */
    const choose = (other, stepId, { entry = false } = {}) => {
        const end = other.steps.findIndex(({ id }) => id === stepId);
        // At the entry of a step that step is shown, but not judged.
        const cut = { ...other, steps: other.steps.slice(0, end + 1), expectations: other.expectations.slice(0, entry ? end : end + 1) };
        chosen = { spec: cut, replay: entry ? replayToEntry(other, stepId, { reads: config.reads ?? [] }) : cutReplay(other, stepId) };
    };
    const restoreOther = async (other, stepId, options) => {
        choose(other, stepId, options);
        await session.workbench?.steps(stepGroups(chosen.spec.steps, chosen.replay));
        return restoreWith(chosen);
    };
    // Why the last restore failed, with evidence as in a run; null if it worked. Passed to Claude when developing.
    let restoreFailed = null;
    const restoreWith = async ({ spec: shownSpec, replay: plan }) => {
        if (plan === undefined) return t('run.restore.noRecording');
        restoreFailed = null;
        // Like a fresh run: all steps open again, instead of old results.
        await session.workbench?.mood?.('wait');
        // The steps run again as in the first run: no longer greyed out, already while they run.
        await session.workbench?.left?.(false);
        for (const { id } of shownSpec.expectations) await session.workbench?.step(id, 'waiting');
        // Signed in fresh like a new run, otherwise the test would start in the session the previous state left behind.
        // With the account of the test's role and on its app's start page, even if the run began with another one.
        chat?.progress(t('run.restore.signingIn', { role: shownSpec.role ?? '' }));
        // Claude's commands wait outside meanwhile (forClaude): the page holds the password while caw signs in.
        signingIn = true;
        try {
            if (session.signInAgain === undefined) await session.restart();
            else {
                await session.signInAgain({
                    // Always explicit: after a test of another role, that role's account is still signed in.
                    as: readCredentials(root, config, shownSpec.role, checked.name),
                    start: startPath(config, shownSpec),
                });
            }
        } finally {
            signingIn = false;
        }
        agentHandler = newAgentHandler({ ...run, expectations: shownSpec.expectations });
        const tag = newRunTag();
        // Restoring replays the test: play while it runs, nothing afterwards. The app frame has the test's recorded size while it
        // replays, as in a run, and the whole pane again once the window is the human's.
        await session.workbench?.transport?.('play')?.catch?.(() => {});
        const { browserRegion } = await import('./browser-session.mjs');
        await session.workbench?.viewport?.(browserRegion(config, recordedBrowser(shownSpec.steps)).viewport ?? null);
        entryPoints = [];
        let again;
        try {
            again = await playReplay({
                replay: plan,
                handler: agentHandler,
                session,
                base: checked.url,
                authMarker: checked.signIn?.signedInSelector,
                stepTimeoutMs,
                filesDir: join(root, PROJECT_DIR),
                runTag: tag,
                log: (entry) => {
                    chat?.progress(`${entry.owner} · ${entry.number} ${entry.label}`);
                    showAction(entry);
                },
            });
        } finally {
            await session.workbench?.transport?.(null)?.catch?.(() => {});
            await session.workbench?.viewport?.(null);
        }
        const failed = failedStep({ ...again, expectations: shownSpec.expectations, failures: [] });
        if (failed !== null) {
            const requests = again.requests?.get(failed.id) ?? [];
            const broken = again.broken?.step === failed.id ? again.broken : null;
            const previousId = shownSpec.steps[shownSpec.steps.findIndex(({ id }) => id === failed.id) - 1]?.id;
            const earlier = previousId === undefined ? null : { id: previousId, requests: again.requests?.get(previousId) ?? [] };
            const baseline = shownSpec.steps.find(({ id }) => id === failed.id)?.recording?.network;
            const hide = (value) => redactDeep(value, session.secrets?.() ?? []);
            restoreFailed = {
                id: failed.id,
                reason: hide(failed.reason),
                test: shownSpec.id,
                diagnosis: hide(diagnose({ failed, broken, failures: session.failures(), requests, baseline, deviation: null, earlier })),
                evidence: hide({ requests, ...(baseline === undefined ? {} : { recorded: baseline }) }),
            };
        }
        for (const { id } of shownSpec.expectations) {
            const status = again.results?.get(id)?.status;
            await session.workbench?.step(id, id === failed?.id ? 'fail' : status === 'pass' ? 'pass' : 'skipped');
        }
        await markEntry(plan, failed);
        // Then it is the human's turn again: the chat asks, or on failure the step list shows the step.
        await session.workbench?.mood?.(failed === null ? 'ask' : 'fail');
        if (failed !== null) return t('run.restore.failed', { id: failed.id, reason: failed.reason.replace(/\.$/, '') });
        const named = (id) => (shownSpec === spec ? id : `${shownSpec.id} ${id}`);
        if (plan.entry !== undefined) return t('run.restore.doneEntry', { id: named(plan.entry.id), tag });
        return t('run.restore.done', { until: plan.until === undefined ? t('run.restore.atEnd') : named(plan.until), tag });
    };
    /** The picked element with page and recent requests, for the human's own Claude Code session (tool caw_selection). */
    const handToCode = (element) => {
        const recent = session.network === undefined ? [] : session.network.since(Math.max(0, session.network.mark() - 20));
        const selection = { at: new Date().toISOString(), runId, test: chosen.spec.id, target, until: chosen.replay?.until ?? null, ...(chosen.replay?.entry === undefined ? {} : { entry: chosen.replay.entry.id }), url: session.page().url(), source: checked.source, element, requests: recent };
        writeFileSync(join(root, RUN_DIR, SELECTION_FILE), JSON.stringify(selection, null, 2));
        return selection;
    };

    /** Common end: save the trace, print the verdict, hand over the window if needed. */
    const closeRun = async (ended, found = {}) => {
        await session.stopTrace();
        // The report already exists: writeResult writes it together with the verdict.
        await session.workbench?.point(END, 'report', ended === 'verdict' ? 'pass' : 'waiting');
        const exitCode = finishRun();
        const alive = ended !== 'browser-closed' && ended !== 'aborted';
        const flawed = verdict.status === 'fail' || (verdict.warnings ?? []).length > 0;
        if (chat === null && conversation?.lazy === true && (found.failed || (conversation.alsoOnWarnings === true && flawed)) && alive) {
            try {
                chat = await openConversation();
            } catch (error) {
                if (!(error instanceof CawError)) throw error;
                ui.warn(error.message);
            }
        }
        const advise = (options) => adviseRun(options, found);
        const talk = (options, question, element) => consult(options, found, { mode: 'talk', question, ...(element === undefined ? {} : { element }) });
        // Only after a test run whose failed step has not executed anything yet: the page is then right before it.
        const repairHere = replay !== undefined && played !== null && found.failed?.clean === true ? (options) => repairInPlace(options, found.failed) : undefined;
        // Hard failures that are only script errors: the human can ignore them with one click, without Claude. After that, or
        // after adopted advice, `cleared` tells whether the config now allows all of them; then a new verification run suffices.
        const hard = verdict.failures ?? [];
        const ignore = ignorableFailures(hard) ? () => {
            const added = [];
            for (const failure of hard) {
                if (allowedNow([failure], config).length > 0) continue;
                const change = { kind: 'config', key: 'consoleIgnore', pattern: ignorePattern(failure) };
                applyToFiles(root, change);
                config.consoleIgnore = configValue(config, change);
                added.push(change.pattern);
            }
            return added;
        } : undefined;
        const cleared = () => hard.length > 0 && allowedNow(hard, config).length === hard.length;
        // conclude says what comes next: { next: 'claude' | 'check' | 'run' } opens a new window right away, { outcome } is the result.
        let after = {};
        if (chat !== null && alive) {
            const said = await Promise.race([conclude?.({ verdict, chat, ...found, flawed, advise, talk, repairHere, ignore, cleared }), session.closed, aborted]);
            if (said !== null && typeof said === 'object') after = said;
        }
        const handing = handover?.({ verdict, ...found }) && alive;
        // When developing the chat stays open: questions to Claude, element to Claude Code, restore state.
        const developing = handing && develop !== undefined && chat !== null && chat.available();
        if (!developing && chat !== null && alive) {
            // The card in the chat: short result, the report, the command for a new run.
            const results = verdict.results ?? [];
            const passed = results.filter((result) => result.status === 'pass').length;
            let text = results.length > 0 ? t('run.finished.steps', { passed, total: results.length }) : t(verdict.status === 'pass' ? 'run.finished.passed' : 'run.finished.failed');
            // A reproduction: its verdict, and the command that records the draft once the human has copied it into caw/tests.
            if (reproduce !== undefined) text = t(`run.reproduce.card.${verdict.reproduce?.reproduced ?? 'none'}`);
            const draft = verdict.reproduce?.draft;
            let command = `caw run ${spec.id}`;
            if (reproduce !== undefined) command = draft === undefined ? 'caw reproduce' : draft.record;
            // Without --learn a passed run that could learn offers it here; only a click writes (Q7).
            const learnable = offerLearning && !found.failed && (found.baselines !== undefined || found.effects !== undefined);
            if (learnable) {
                // Steps without any baselines yet, and steps whose effects a second healthy run confirms (effects learn over two runs).
                const ids = [...new Set([...(found.baselines?.keys() ?? []), ...(found.effects?.keys() ?? [])])];
                const has = (id) => spec.steps.find((step) => step.id === id)?.recording?.effects !== undefined && !found.baselines?.has(id);
                const missing = ids.filter((id) => !has(id));
                const confirming = ids.filter(has);
                if (missing.length > 0) chat.notice(t('run.flow.learnOffer', { ids: missing.join(', ') }));
                if (confirming.length > 0) chat.notice(t('run.flow.learnConfirm', { ids: confirming.join(', ') }));
            }
            // The card's kind (passed, failed, reproduced) and for a reproduction what Claude found, as plain text.
            const kind = reproduce !== undefined ? 'reproduce' : verdict.status === 'pass' ? 'pass' : 'fail';
            const repro = verdict.reproduce;
            const reproduced = reproduce === undefined ? {} : { reproduce: { bug: repro?.bug, observed: repro?.observed, expected: repro?.expected, cause: repro?.cause, readOnly: repro?.writable === false } };
            await chat.finished?.({ report: join(runDir, 'report.md'), shown: posix.join(relativeRun, 'report.md'), text, command, adopt: reproduce !== undefined && draft !== undefined, learn: learnable, kind, ...reproduced });
            // The window changes: chat and terminal say so before it closes.
            if (after.next !== undefined) {
                const line = t('run.newWindow', { what: t(`run.newWindow.${after.next}`) });
                chat.notice(line);
                ui.note(line);
            } else if (typeof after.outcome === 'string') chat.notice(after.outcome);
        }
        // The run is over: no chip at the top right.
        await session.workbench?.transport?.(null).catch(() => {});
        if (!developing) chat?.human.closed();
        // After the last decision the window does not just vanish: it stays open briefly, the human can close it.
        // Without a chat (CI, --no-chat, headless) nothing waits here.
        if (!developing && !handing && after.next === undefined && chat !== null && alive && !headless && chat.linger !== undefined) {
            await Promise.race([chat.linger(LINGER_MS), session.closed, aborted]);
        }
        if (handing) {
            // What the session had noted when the window became the human's: whatever comes later goes into the report on closing.
            const handedAt = { warnings: new Map((session.warnings?.() ?? []).map(({ type, text, count }) => [`${type}
${text}`, count])), failures: (session.failures?.() ?? []).length };
            // The header says what applies now: the replay is over, it is the human's turn.
            let phase = ['handedOver'];
            const state = replay?.entry?.id ?? replay?.until;
            if (developing) phase = state !== undefined && verdict.status === 'pass' ? ['developIn', { until: state }] : ['develop'];
            shownFacts = benchFacts(config, spec, checked, titleOf(spec, ...phase), badgeOf(...phase));
            await session.workbench?.facts(withLink(shownFacts)).catch(() => {});
            await session.workbench?.transport?.(null).catch(() => {});
            const local = checked.source === 'overlay' ? t('run.handover.local') : '';
            if (replay?.entry !== undefined && verdict.status === 'pass') {
                // Names the step about to start; if a guard kept its entry back, also why.
                const { id, name, skipped } = replay.entry;
                const step = `${id} ${name}`.trim();
                ui.success(skipped === undefined ? t('run.handover.state', { step, local }) : t('run.handover.stateSkipped', { step, why: t(`run.handover.why.${skipped}`, { id }), local }));
            } else {
                ui.note(t('run.handover.window'));
            }
            if (developing) {
                // After writing a test: F1 and "restore state" see it as it now is in the file.
                let afterSave = async () => {};
                const persist = async (result) => {
                    const file = writeTest(root, result.spec, new Set(result.touched), { withNotes: result.notes });
                    chat.notice(t('run.flow.adviceAdopted', { file }));
                    if (result.stale.length > 0) chat.notice(t('run.develop.staleAdopted', { ids: result.stale.map(({ id }) => id).join(', ') }));
                    result.touched.splice(0);
                    result.notes = false;
                    await afterSave(result.spec.id);
                };
                // Claude gets the whole test of the state as it is in the file (after F1 the picked one), not just the steps up to here,
                // so it can change a step while developing, e.g. make a click optional that no longer restores the state.
                const ask = (options, question, element) => {
                    const full = chosen.spec.steps.length === 0 ? undefined : loadStateTest(root, config, chosen.spec.id);
                    return consult({ ...options, spec: full ?? options.spec }, {}, { mode: 'develop', question, persist, ...(element === undefined ? {} : { element }) });
                };
                try {
                    const bench = session.workbench;
                    // Refresh reloads the current page without cache, like F5 while developing. After the handover reloading is work,
                    // not an incident: the steps stay as they are, without "left" and without a warning.
                    const refresh = async () => {
                        await session.reloadPage();
                        return '';
                    };
                    const onReload = (listener) => bench?.onReload?.(async ({ human = true } = {}) => {
                        if (!human) return;
                        await listener();
                    });
                    // After the handover (open) the workbench shows only the application full-screen; F8 brings the workbench back.
                    // The recorded size held while replaying; the window is the human's now, the app gets the whole pane.
                    await bench?.viewport?.(null);
                    await bench?.solo?.(true);
                    // F1: states from all tests of this target, each in its role's account. Without a step the test runs to the last
                    // restorable one. With basic auth the account is tied to the browser: only the own role.
                    const scope = checked.signIn?.type === 'basic' ? { role: spec.role, target } : { target };
                    let catalog = stateCatalog(root, config, scope);
                    await bench?.states?.(catalog);
                    afterSave = async (testId) => {
                        catalog = stateCatalog(root, config, scope);
                        await bench?.states?.(catalog);
                        const atEntry = chosen.replay?.entry !== undefined;
                        const stepId = chosen.replay?.entry?.id ?? chosen.replay?.until;
                        const fresh = chosen.spec.id === testId && stepId !== undefined ? loadStateTest(root, config, testId) : undefined;
                        if (fresh !== undefined && canRestore(catalog, testId, stepId)) choose(fresh, stepId, { entry: atEntry });
                    };
                    // A picked step: at its entry, like open <test>@<step>. Without a step: up to the last restorable step.
                    const restoreTo = async (testId, stepId) => {
                        const entry = catalog.find(({ id }) => id === testId);
                        const until = stepId ?? entry?.steps.filter(({ ok }) => ok).at(-1)?.id;
                        if (entry === undefined || until === undefined || !canRestore(catalog, testId, until)) throw new CawError('step-unknown', t('run.develop.cannotRestore', { test: testId, step: stepId ?? '' }));
                        return restoreOther(loadStateTest(root, config, testId), until, { entry: stepId !== undefined });
                    };
                    const restore = () => (chosen.replay === undefined ? reloadApp() : restoreState());
                    await Promise.race([develop({ chat, talk: ask, signedIn: session.signedIn, until: replay?.entry?.id ?? replay?.until, entry: replay?.entry !== undefined, refresh, restore, restoreTo, onPickState: (handler) => bench?.onState?.(handler), onRefresh: (handler) => bench?.onRefresh?.(handler), onReload, toCode: handToCode }), session.closed, aborted]);
                } catch (error) {
                    ui.warn(t('run.develop.error', { message: String(error?.message ?? error).split(/\r?\n/)[0] }));
                } finally {
                    chat.human.closed();
                }
            } else {
                await Promise.race([session.closed, aborted]);
            }
            noteAfterHandover(handedAt);
        }
        link?.tell(t('run.attach.ended', { runId }));
        link?.stop();
        stopSignals();
        await session.close();
        return { exitCode, verdict, ...found, ...(chat?.learnWanted?.() === true ? { learn: true } : {}) };
    };
    const writeInterrupted = (ended) => {
        if (ended === 'browser-closed') writeResult({ status: 'error', code: 'browser-closed', reason: t('run.interrupted.browserClosed') });
        else if (tampered !== null) writeResult({ status: 'error', code: tampered.code, reason: tampered.message });
        else writeResult({ status: 'error', code: 'aborted', reason: t('run.interrupted.aborted') });
    };

    /**
     * Claude works in the container: record, or repair a step. When repairing in the same browser this runs after a test run,
     * with the browser already right before the step.
     * @returns { ended, found } for closeRun
     */
    const claudeWork = async (box) => {
        verdict = null;
        // For Claude: secret values stay placeholders that the handler fills in on execution (fillSecrets).
        // Only for check code: values are escaped for a string literal.
        const fillIn = (value) => fillDates(openRemembered().reduce((current, [placeholder, real]) => current.split(placeholder).join(codeText(real)), fillRun(value, runTag)), zonedNow(session.browser?.timezone), session.browser?.locale);
        if (range !== undefined) {
            // From a step to the end: the old recording of each step as orientation; the steps before have run without Claude.
            run.repair = {
                reason: repair.reason,
                rerecord: true,
                from: true,
                steps: range.map(({ id, recording }) => ({ id, actions: recording?.actions.map(stepLabel) ?? [], ...(recording === undefined ? {} : { check: fillIn(recording.check) }) })),
                remembered: [...remembered].map(([placeholder, value]) => ({ name: placeholder.slice(2, -2), ...(isSecret(value) ? { secret: true, value: placeholder } : { value }) })),
                before: givenSpec.steps.slice(0, givenSpec.steps.indexOf(repairing)).map(({ id, name }) => ({ id, name })),
            };
        } else if (repairing !== undefined) {
            const position = givenSpec.steps.indexOf(repairing);
            run.repair = {
                reason: repair.reason,
                // The step did not fail: there is no error to look for, it only needs re-recording.
                ...(repair.rerecord ? { rerecord: true } : {}),
                actions: repairing.recording?.actions.map(stepLabel) ?? [],
                ...(repairing.recording === undefined ? {} : { check: fillIn(repairing.recording.check) }),
                remembered: [...remembered].map(([placeholder, value]) => ({ name: placeholder.slice(2, -2), ...(isSecret(value) ? { secret: true, value: placeholder } : { value }) })),
                before: givenSpec.steps.slice(0, position).map(({ id, name }) => ({ id, name })),
                after: givenSpec.steps.slice(position + 1).map(({ id, name, expect }) => ({ id, name, expect })),
                // The test run's classification: Claude checks it first, before adapting the step. If the human has since allowed
                // the hard failures (consoleIgnore, foreignCode), it no longer holds: then `resolved` replaces it.
                ...(() => {
                    const allowed = allowedNow(repair.failures ?? [], config);
                    if (allowed.length > 0 && allowed.length === (repair.failures ?? []).length) {
                        return { resolved: `The human decided to allow the hard failures of the test run; they only count as warnings now: ${allowed.map(({ text }) => String(text).split('\n')[0]).join('; ')}. They are no reason for fail. Check the step against its expect.` };
                    }
                    return repair.diagnosis === undefined ? {} : { diagnosis: repair.diagnosis, evidence: repair.evidence };
                })(),
                // What the human said and decided in the chat before the repair: it applies, and a new Claude would not know it otherwise.
                ...((repair.agreed ?? []).length === 0 ? {} : { agreed: repair.agreed }),
                ...(repairing.recording?.network === undefined ? {} : { recordedNetwork: repairing.recording.network }),
            };
        }

        let repairReviewer = null;
        const budget = withStepBudget(agentHandler, maxActions ?? Number.POSITIVE_INFINITY);
        let recorder = null;
        let plan = null;
        // Checks a plan change took back, with what they proved: a later version that proves the same brings them back.
        let forgotten = { entries: [], checks: 0 };
        /** The plan becomes the test file. Only the human's approval makes it the yardstick of the run. */
        const proposePlan = async ({ text }) => {
            if (typeof text !== 'string' || text.trim() === '') throw new CawError('plan-invalid', 'The plan is empty.');
            const { problems, plan: parsed } = readPlan(text);
            if (problems.length > 0) throw new CawError('plan-invalid', problems.join(' '));
            const fixed = range === undefined ? [] : givenSpec.steps.slice(0, givenSpec.steps.indexOf(repairing));
            if (range !== undefined) {
                // From a step on: the steps before it stay; the plan holds the steps from there to the end, at least one.
                const taken = parsed.steps.filter(({ id }) => fixed.some((step) => step.id === id)).map(({ id }) => id);
                if (parsed.steps.length === 0 || taken.length > 0) {
                    throw new CawError('plan-invalid', `When re-recording from ${repair.id}, the plan contains the steps from there to the end, at least one, and none of the steps before it${taken.length > 0 ? ` (not ${taken.join(', ')})` : ''}.`);
                }
            } else if (repairing !== undefined && (parsed.steps.length !== 1 || parsed.steps[0].id !== repair.id)) {
                throw new CawError('plan-invalid', `When repairing, the plan contains exactly step ${repair.id}.`);
            }
            // A manually set retry survives the repair even if Claude does not repeat it, per step.
            const retryOf = (id) => (range ?? (repairing === undefined ? [] : [repairing])).find((step) => step.id === id)?.retry;
            const steps = parsed.steps.map((step) => (retryOf(step.id) === undefined ? step : { retry: retryOf(step.id), ...step }));
            let whole = steps;
            if (range !== undefined) whole = [...fixed, ...steps];
            else if (repairing !== undefined) whole = replaceStep(givenSpec, steps[0]).steps;
            const retryIssues = retryProblems(whole);
            if (retryIssues.length > 0) throw new CawError('plan-invalid', retryIssues.join(' '));
            const heardIssues = repairing === undefined ? heardProblems(parsed, humanNotes) : [];
            if (heardIssues.length > 0) throw new CawError('plan-invalid', heardIssues.join(' '));
            const composed = repairing === undefined ? composeTest(givenSpec, parsed) : { ...spec, steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })) };
            // Same plan as in the test file: the human already adopted it, nothing to approve. The human can still write.
            const unchanged = range === undefined
                ? repairing !== undefined && samePlanStep(steps[0], repairing)
                : steps.length === range.length && steps.every((step, index) => samePlanStep(step, range[index]));
            if (unchanged && range !== undefined) chat.notice(t('run.plan.unchangedFrom', { id: repair.id }));
            else if (unchanged) chat.notice(t(repair.rerecord ? 'run.plan.unchangedRerecord' : 'run.plan.unchangedRepair', { id: repair.id }));
            // A read-only test the developer's own session wrote and now follows unchanged: no approval up front. The human still
            // decides at the end whether the proven test is adopted; a changed or writing plan gets the card as always.
            const ownReadOnly = repairing === undefined && plan === null && sessionFollowsOwnPlan({ agent: box?.kind, previous, proposed: composed });
            if (ownReadOnly) chat.notice(t('run.plan.sessionReadOnly'));
            const previousSteps = new Map((range ?? (repairing === undefined ? [] : [repairing])).map((step) => [step.id, step]));
            const answer = unchanged || ownReadOnly ? { approved: true } : await chat.plan(planView({ ...composed, heard: parsed.heard }, { repairing: repairing !== undefined, rerecord: repair?.rerecord === true, ...(range === undefined ? {} : { from: repair.id }), previous: previousSteps, humanNotes }));
            if (!answer.approved) return answer;
            const redo = plan === null ? [] : invalidatedChecks(plan, composed, recorder);
            const checksNow = () => recorder.steps.filter(({ action }) => action === 'check').length;
            // A check made since then replaces what was taken back: nothing comes back after it.
            if (forgotten.checks !== checksNow()) forgotten = { entries: [], checks: checksNow() };
            if (redo.length > 0) {
                const entries = recorder.forgetChecks(new Set(redo)).map((entry) => ({ ...entry, basis: checkBasis(plan, entry.step.id), order: plan.steps.findIndex((step) => step.id === entry.step.id) }));
                forgotten = { entries: [...forgotten.entries, ...entries].sort((a, b) => a.order - b.order), checks: checksNow() };
            }
            // Back to what the taken-back checks proved (e.g. the earlier expected result): they apply again, in their order, as
            // long as each one fits.
            const fitting = [];
            for (const entry of forgotten.entries) {
                if (redo.includes(entry.step.id) || checkBasis(composed, entry.step.id) !== entry.basis) break;
                fitting.push(entry);
            }
            const restored = fitting.length === 0 ? [] : recorder.restoreChecks(fitting);
            forgotten = { entries: forgotten.entries.filter((entry) => !restored.includes(entry.step.id)), checks: checksNow() };
            plan = composed;
            writeFileSync(join(runDir, PLAN_FILE), text.replaceAll('\r\n', '\n'));
            spec = composed;
            run.expectations = composed.expectations;
            run.notes = composed.notes;
            run.steps = composed.steps.map(planStep);
            reportBase.expectations = composed.expectations;
            const notes = [
                ...(restored.length === 0 ? [] : [`The checks of ${restored.join(', ')} apply again: the plan proves the same as when they passed.`]),
                ...(redo.length === 0 ? [] : [`The checks of ${redo.join(', ')} no longer apply because the expected results or the order changed from there on. Walk the path so that you check these steps again, and drop outdated actions with omit. Rewording a step's name, action or note alone keeps its check.`]),
            ];
            if (notes.length === 0) return { approved: true };
            return { approved: true, ...(redo.length === 0 ? {} : { invalidated: redo }), ...(restored.length === 0 ? {} : { restored }), note: notes.join(' ') };
        };
        /** The verdict refers to the approved plan, and every passed step must be in it. */
        const checkAgainstPlan = (results) => {
            // If the application is at fault, Claude only reports fail when repairing: that changes nothing in the test and needs no plan.
            const onlyFail = Array.isArray(results.expectations) && results.expectations.length > 0 && results.expectations.every(({ status }) => status === 'fail');
            if (plan === null && repairing !== undefined && onlyFail) return;
            if (plan === null) throw new CawError('plan-required', `There is no approved plan yet. Submit it with caw agent plan --file <${PLAN_FILE}>.`);
            const known = new Set(spec.expectations.map(({ id }) => id));
            const { groups } = groupSteps(recorder.steps);
            const failed = new Set((results.expectations ?? []).filter(({ status }) => status === 'fail').map(({ id }) => id));
            // A step submitted as fail cannot have a passed check: that is a result too.
            const missing = [...known].filter((id) => !groups.has(id) && !failed.has(id));
            if (missing.length > 0) throw new CawError('finish-rejected', `Without a passed check: ${missing.join(', ')}.`);
            if (repairing === undefined || failed.size > 0) return;
            // Per step: an unchanged expected result keeps its check.
            for (const step of plan.steps) {
                const old = (range ?? [repairing]).find(({ id }) => id === step.id);
                if (old?.recording !== undefined && step.expect === old.expect && groups.get(step.id).check !== old.recording.check) {
                    throw new CawError('finish-rejected', `The expected result of ${step.id} is unchanged, so the check must stay the same too: ${fillIn(old.recording.check)}. To change it, submit a plan with a changed expect.`);
                }
            }
            const withRecording = (step) => ({ ...step, recording: { actions: groups.get(step.id).actions, check: groups.get(step.id).check } });
            const lost = missingRemembered(range === undefined
                ? replaceStep(givenSpec, withRecording(plan.steps[0]))
                : { ...givenSpec, steps: [...givenSpec.steps.slice(0, givenSpec.steps.indexOf(repairing)), ...plan.steps.map(withRecording)] });
            if (lost.length > 0) throw new CawError('finish-rejected', lost.join(' '));
        };
        /** Actions since the last check belong to the next step, so the order must be right. */
        const checkOrder = ({ id }) => {
            const ids = spec.expectations.map((expectation) => expectation.id);
            if (!ids.includes(id)) throw new CawError('step-unknown', `${id} is not in the plan. Submit a new version if the step belongs in it.`);
            const passed = recorder.steps.filter(({ action }) => action === 'check').map((step) => step.id);
            const open = ids.find((candidate) => !passed.includes(candidate));
            if (id !== open && id !== passed.at(-1)) throw new CawError('step-order', `Next up is ${open}, not ${id}. All actions since the last check belong to the next step.`);
        };
        const handler = async (command) => {
            if (command?.action === 'finish' && command.results?.status !== 'error') checkAgainstPlan(command.results ?? {});
            return budget.handler(command);
        };
        // Dates near today become placeholders relative to the browser's today, in its pinned time zone.
        recorder = createRecorder({ handler, session, base: checked.url, authMarker: checked.signIn?.signedInSelector, runTag, remembered, now: () => zonedNow(session.browser?.timezone) });
        /** The human shows in the same browser what Claude cannot find. The budget only counts Claude's own steps. */
        const askOperator = async ({ question }) => {
            ui.heading(t('run.ask.heading', { question: String(question ?? '').slice(0, 500) }));
            ui.note(t('run.ask.show'));
            chat.ask(question);
            return captureHuman('asking');
        };
        /** What the human now does in the browser goes into the test, and Claude gets it as the answer. */
        const captureHuman = async (kind) => {
            chat.enter(kind);
            try {
                const items = await demonstrate({ session, operator: chat.operator, ui, dir: agentDir, filesDir: join(root, PROJECT_DIR), onItem: (item) => { const line = feedLabel(item); if (line !== null) chat.progress(t('run.recorded', { line })); }, onFailure: (item) => chat.notice(t('run.recordedFailure', { item: itemLabel(item) })) });
                const { steps, problems } = recordableSteps(items);
                recorder.addSteps(steps);
                recorder.problems.push(...problems);
                return { items: items.map((item) => ({ ...item, label: itemLabel(item) })), problems };
            } finally {
                chat.leave();
            }
        };
        /** Only now is Claude really waiting: before, its own clicks would have been recorded. */
        const readChat = async () => {
            const messages = chat.takeUnread();
            return chat.paused() ? { messages, ...await captureHuman('paused') } : { messages };
        };
        /** Detours are dropped only once the verdict is accepted: Claude may retry a rejected finish. */
        const finishAndDrop = async (command) => {
            // Without this requirement misclicks would stay in the test: only a passed run becomes a recording.
            const items = command.results?.expectations;
            const allPassed = Array.isArray(items) && items.every(({ status }) => status === 'pass');
            if (allPassed && command.results.omit === undefined) {
                throw new CawError('finish-rejected', `Check the actions for misclicks and detours and list them with "omit", even if there are none ("omit": []):\n${recorder.list().join('\n')}`);
            }
            const omitted = dropNumbers(recorder.steps, command.results?.omit);
            const dropped = [...omitted, ...tidyNumbers(recorder.steps, omitted)];
            if (allPassed) {
                const trailing = trailingNumbers(recorder.steps, dropped);
                const stray = trailing.filter((number) => recorder.steps[number - 1].action !== 'wait-ready');
                if (stray.length > 0) throw new CawError('finish-rejected', `There are still actions after the last check (${stray.join(', ')}). Drop them with "omit" or check the step again afterwards.`);
                dropped.push(...trailing);
            }
            const numbers = [...new Set(dropped)].sort((a, b) => a - b);
            reportBase.dropped = numbers.map((number) => `${number} ${stepLabel(recorder.steps[number - 1])}`);
            try {
                const value = await recorder.handler(command);
                recorder.drop(numbers);
                return value;
            } catch (error) {
                reportBase.dropped = [];
                throw error;
            }
        };
        const channelHandler = (command) => {
            if (command?.action === 'say') return chat.say(command.text);
            if (command?.action === 'chat') return readChat();
            if (command?.action !== 'task') chat.gate();
            if (command?.action === 'plan') return proposePlan(command);
            if (plan === null && NEEDS_PLAN.has(command?.action)) throw new CawError('plan-required', `Submit the plan first: caw agent plan --file <${PLAN_FILE}>. Reading works without it, e.g. snapshot.`);
            if (command?.action === 'check') checkOrder(command);
            if (command?.action === 'ask-operator') return askOperator(command);
            if (command?.action === 'recording') return recorder.list();
            if (command?.action === 'finish') return finishAndDrop(command);
            // When repairing, Claude may submit a cause in the application as advice instead of adapting the test.
            if (command?.action === 'advise' && repairing !== undefined) {
                repairReviewer ??= createReviewer(givenSpec);
                // The classification as Claude got it: without the one a human decision has lifted.
                return repairReviewer.review(checkAdvice(command.advice, repairReviewer.result.spec, config, { root, diagnosis: run.repair?.diagnosis }));
            }
            // When recording only config and project context: if the human declares an error harmless, that already applies to the
            // verification run afterwards. The recording itself changes the test plan.
            if (command?.action === 'advise') {
                repairReviewer ??= createReviewer(givenSpec ?? { id: spec?.id ?? 'neu', steps: [] });
                const items = checkAdvice(command.advice, repairReviewer.result.spec, config, { root });
                if (!items.every(changesFiles)) throw new CawError('advice-invalid', 'When recording, only advice with change.kind config or context is allowed. You change the test plan through the recording itself.');
                return repairReviewer.review(items);
            }
            return recorder.handler(command);
        };
        const stopPump = startPump(channelHandler);
        // If the human declines the token notice, the run is aborted before Claude starts.
        const willing = await claudeMayStart(box, { decline: t('run.tokens.cancelRun') });
        if (!willing) abortSignal();
        const agent = willing ? startAgent(box, containerCommand ?? ['caw', 'agent', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin)], CLAUDE_LOG) : IDLE_AGENT;
        // How the run ended; declared outside the try because the return below needs it.
        let ended;
        // Also on an unexpected error: otherwise Claude and its container keep running until their time limit.
        try {
            if (willing) ui.info(t('run.agentWorking'));
            ended = await Promise.race([
                verdictGiven.then(() => 'verdict'),
                agent.ended,
                session.closed.then(() => 'browser-closed'),
                aborted.then(() => 'aborted'),
            ]);
            agent.stopTail();
            // The run is done with the verdict. Nobody waits for Claude's closing summary.
            if (verdict === null) {
                if (ended === 'browser-closed' || ended === 'aborted') {
                    writeInterrupted(ended);
                } else {
                    const log = agent.log();
                    let reason = t('run.noVerdict');
                    if (ended.code !== 0) {
                        reason = log === ''
                            ? t('run.sandboxNoAgent', { code: ended.code })
                            : claudeFailureReason(ended.code, log);
                    }
                    writeResult({ status: 'error', code: 'no-verdict', reason });
                }
            }
        } finally {
            await agent.stop();
            await stopPump();
        }

        if (budget.used() > 0) ui.info(t('run.budget', { used: budget.used(), max: maxActions ?? t('run.budget.unlimited') }));

        const viewport = await session.viewportSize?.();
        const built = buildReplay({ recorder, outcome: verdict, spec, target, browser: { ...(session.browser ?? {}), ...(viewport ? { viewport } : {}) }, ...(repairing === undefined ? {} : { draft: givenSpec }), ...(range === undefined ? {} : { from: repair.id }), ...(creating && previous !== undefined ? { previous } : {}) });
        let { candidate } = built;
        // Created as read-only but it wrote: then the test writes, otherwise it would run on environments without writable.
        const written = verdict?.writes ?? [];
        if (candidate !== undefined && !candidate.writes && written.length > 0) {
            candidate = { ...candidate, writes: true };
            ui.warn(t('run.writes', { id: spec.id, labels: written.map(({ label }) => label).join(', ') }));
        }
        if (candidate === undefined) {
            ui.warn(t('run.noRecording', { problems: built.problems.join(' ') }));
            // A run that yields no recording missed its goal, even if all checks passed.
            if (verdict?.status === 'pass') writeResult({ ...verdict, status: 'fail', reason: built.problems.join(' ') });
        } else {
            writeFileSync(join(runDir, DRAFT_FILE), renderTest(candidate));
        }
        // The steps whose expected result changed: the human sees the old one before deciding.
        const expectChange = repairing === undefined || candidate === undefined ? [] : plan.steps.flatMap((step) => {
            const old = (range ?? [repairing]).find(({ id }) => id === step.id);
            return old === undefined || old.expect === step.expect ? [] : [{ id: step.id, before: old.expect, after: step.expect }];
        });
        return {
            ended,
            found: {
                candidate,
                fresh: built.fresh,
                ...(repairReviewer === null ? {} : { repairAdvice: repairReviewer.result }),
                ...(expectChange.length === 0 ? {} : { expectChange }),
                ...(range === undefined || candidate === undefined ? {} : {
                    ids: plan.steps.map(({ id }) => id),
                    removed: range.map(({ id }) => id).filter((id) => !plan.steps.some((step) => step.id === id)),
                }),
            },
        };
    };
    /**
     * Repairs the failed step where the test run stopped: without replaying the steps before, with the values the replay
     * read. The test run's report is kept as `report-test-run.md`.
     * @returns { verdict, exitCode, candidate, fresh, expectChange } of the repair
     */
    const repairInPlace = async ({ sandbox: box, reason, agreed, failures }, failed) => {
        const before = verdict;
        if (existsSync(join(runDir, 'report.md'))) copyFileSync(join(runDir, 'report.md'), join(runDir, 'report-test-run.md'));
        repair = { id: failed.id, reason, agreed, failures, ...(failed.diagnosis === undefined ? {} : { diagnosis: failed.diagnosis, evidence: failed.evidence }) };
        repairing = givenSpec.steps.find(({ id }) => id === failed.id);
        spec = { ...givenSpec, steps: [repairing], expectations: givenSpec.expectations.filter(({ id }) => id === failed.id) };
        reportBase.expectations = spec.expectations;
        run.expectations = spec.expectations;
        run.steps = spec.steps.map(planStep);
        remembered = played.remembered;
        agentHandler = newAgentHandler();
        ui.heading(t('run.repairInPlace', { id: failed.id }));
        const { ended, found } = await claudeWork(box);
        const repaired = { verdict, exitCode: EXIT[verdict.status], ...found, ended };
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), reportUrl: pathToFileURL(join(runDir, 'report.md')).href, elapsed: (Date.now() - startedAt) / 1000, names: stepNames() });
        verdict = before;
        return repaired;
    };

    if (replay !== undefined) {
        if (replay.steps.length > 0) ui.info(t('run.replaying', { count: replay.steps.length, on: replay.recordedOn }));
        const started = Date.now();
        // A step runs from its first action until the next step's first action, the last one until the replay ends.
        let timedOwner;
        const timeStep = (owner) => {
            const now = Date.now();
            if (owner === timedOwner) return;
            if (timedOwner !== undefined) stepTimes.get(timedOwner).end = now;
            const seen = stepTimes.get(owner);
            if (seen === undefined) stepTimes.set(owner, { start: now });
            else seen.end = undefined;
            timedOwner = owner;
        };
        const play = playReplay({
            replay,
            handler: agentHandler,
            session,
            ...(config.effects?.fail === undefined ? {} : { effectFail: config.effects.fail }),
            base: checked.url,
            authMarker: checked.signIn?.signedInSelector,
            stepTimeoutMs,
            filesDir: join(root, PROJECT_DIR),
            runTag,
            // The terminal adds the total itself, the chat gets the finished label.
            log: (entry) => {
                const { position, number, owner, label } = entry;
                if (owner !== undefined) timeStep(owner);
                ui.step({ number: position, total: replay.steps.length, label, elapsed: (Date.now() - started) / 1000 });
                chat?.progress(`${owner} · ${number} ${label}`);
                showAction(entry);
            },
        });
        const ended = await Promise.race([
            play,
            session.closed.then(() => 'browser-closed'),
            aborted.then(() => 'aborted'),
        ]);
        if (timedOwner !== undefined) stepTimes.get(timedOwner).end ??= Date.now();
        if (typeof ended === 'string') {
            writeInterrupted(ended);
            return closeRun(ended);
        }
        await session.workbench?.point(END, 'effects', 'running');
        await agentHandler({ action: 'finish', results: replayVerdict({ ...ended, expectations: spec.expectations }) });
        played = ended;
        const failed = failedStep({ ...ended, expectations: spec.expectations, failures: session.failures() });
        for (const { id } of spec.expectations) {
            const status = ended.results?.get(id)?.status;
            await session.workbench?.step(id, id === failed?.id || (status !== undefined && status !== 'pass') ? 'fail' : status === 'pass' ? 'pass' : 'skipped');
        }
        await markEntry(replay, failed);
        if (failed !== null) {
            // Test, application or environment: evidence from the browser and the comparison with the step's recording.
            const requests = ended.requests?.get(failed.id) ?? [];
            const baseline = givenSpec.steps.find(({ id }) => id === failed.id)?.recording?.network;
            // A break later in the run says nothing about this step: its check failed, its actions ran.
            const broken = ended.broken?.step === failed.id ? ended.broken : null;
            // The first deviating effect, in the step itself or before: that is where the application first behaved differently.
            const upTo = givenSpec.steps.slice(0, givenSpec.steps.findIndex(({ id }) => id === failed.id) + 1).map(({ id }) => id);
            const deviation = ended.deviations?.get(failed.id) ?? upTo.map((id) => ended.deviations?.get(id)).find((found) => found !== undefined) ?? null;
            // The step before: its check may have passed although something was already rejected there.
            const previousId = upTo.at(-2);
            const earlier = previousId === undefined ? null : { id: previousId, requests: ended.requests?.get(previousId) ?? [] };
            // Redacted like the verdict: page messages and evidence may contain secret remembered values, and both go into the
            // report and, when repairing, to Claude.
            const hide = (value) => redactDeep(value, session.secrets?.() ?? []);
            failed.diagnosis = hide(diagnose({ failed, broken, failures: session.failures(), requests, baseline, deviation, earlier }));
            const effect = deviation === null ? {} : { effect: hide(deviation) };
            failed.evidence = hide({ requests, ...(baseline === undefined ? {} : { recorded: baseline }), ...effect });
            failed.suspect ||= failed.diagnosis.side === 'app';
            verdict = { ...verdict, diagnosis: { step: failed.id, ...failed.diagnosis, ...failed.evidence } };
            writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
            writeFileSync(join(runDir, 'report.md'), inLanguage(teamLanguage(config), () => renderReport(verdict)));
        }
        const baselines = missingBaselines({ spec: givenSpec, results: ended.results, requests: ended.requests, target });
        // Prune only from a fully healthy run: if something fails later, an earlier deviation may be the first clue.
        const effects = learnedEffects({
            spec: givenSpec,
            results: ended.results,
            effects: ended.effects,
            deviations: ended.deviations,
            target,
            prune: failed === null && (ended.retried?.size ?? 0) === 0,
            ...(config.effects?.fail === undefined ? {} : { fail: config.effects.fail }),
        });
        const deviating = ended.deviations?.size ?? 0;
        await session.workbench?.point(END, 'effects', 'pass', { label: deviating === 0 ? t('run.effects.asRecorded') : t('run.effects.deviations', { count: deviating }) });
        // Only a run that writes them (--learn) shows learning: other runs compute them but keep the file as it is.
        if (learns && baselines.size + effects.size > 0) await session.workbench?.point(END, 'learn', 'pass', { kind: t('run.learn.kind'), label: t('run.learn.label') });
        return closeRun('verdict', { failed, ...(baselines.size === 0 ? {} : { baselines }), ...(effects.size === 0 ? {} : { effects }) });
    }

    // Repair starts before the step: a half-executed step would yield an incomplete recording.
    if (repair !== undefined) {
        const before = replayBefore(givenSpec, repair.id);
        if (before.steps.length > 0) {
            chat.preparing();
            const expectations = givenSpec.expectations.filter(({ id }) => before.steps.some((step) => step.action === 'check' && step.id === id));
            const started = Date.now();
            const ended = await Promise.race([
                playReplay({
                    replay: before,
                    // Separate handler: its checks are the steps before, not the one Claude repairs.
                    handler: createAgentHandler({
                        session,
                        run: { expectations },
                        hosts: navigationHosts(config, checked.name),
                        agentDir,
                        onVerdict: (outcome) => { reportBase.expectations = expectations; writeResult(outcome); },
                    }),
                    session,
                    base: checked.url,
                    authMarker: checked.signIn?.signedInSelector,
                    stepTimeoutMs,
                    filesDir: join(root, PROJECT_DIR),
                    runTag,
                    log: ({ position, number, owner, label }) => {
                        ui.step({ number: position, total: before.steps.length, label, elapsed: (Date.now() - started) / 1000 });
                        chat.progress(`${owner} · ${number} ${label}`);
                    },
                }),
                session.closed.then(() => 'browser-closed'),
                aborted.then(() => 'aborted'),
            ]);
            if (typeof ended === 'string') {
                writeInterrupted(ended);
                return closeRun(ended);
            }
            const failed = failedStep({ ...ended, expectations, failures: session.failures() });
            if (failed !== null) {
                reportBase.expectations = expectations;
                writeResult({ status: 'fail', reason: t('run.failedBefore', { id: failed.id, target: repair.id, reason: failed.reason }), results: replayVerdict({ ...ended, expectations }).expectations, failures: session.failures() });
                return closeRun('verdict', { failed });
            }
            remembered = ended.remembered;
            chat.preparing(false);
        }
    }
    /**
     * caw reproduce: optionally the steps of a test up to a state without Claude, then Claude alone in the browser, without a
     * plan or a human decision, until its verdict. No advice, no code change, no test written: the verdict, the report and a
     * draft test plan in the run folder.
     * @returns { ended, found } for closeRun
     */
    const reproduceWork = async (box) => {
        verdict = null;
        const { prefix } = reproduce;
        if (prefix !== undefined && prefix.steps.length > 0) {
            chat?.preparing();
            const expectations = givenSpec.expectations.filter(({ id }) => prefix.steps.some((step) => step.action === 'check' && step.id === id));
            const started = Date.now();
            const ended = await Promise.race([
                playReplay({
                    replay: prefix,
                    // Its own handler: the checks of the steps on the way, not Claude's.
                    handler: createAgentHandler({ session, run: { expectations }, hosts: navigationHosts(config, checked.name), agentDir, onVerdict: () => {} }),
                    session,
                    base: checked.url,
                    authMarker: checked.signIn?.signedInSelector,
                    stepTimeoutMs,
                    filesDir: join(root, PROJECT_DIR),
                    runTag,
                    log: ({ position, number, owner, label }) => {
                        ui.step({ number: position, total: prefix.steps.length, label, elapsed: (Date.now() - started) / 1000 });
                        chat?.progress(`${owner} · ${number} ${label}`);
                    },
                }),
                session.closed.then(() => 'browser-closed'),
                aborted.then(() => 'aborted'),
            ]);
            if (typeof ended === 'string') {
                writeInterrupted(ended);
                return { ended };
            }
            const failed = failedStep({ ...ended, expectations, failures: session.failures() });
            await markEntry(prefix, failed);
            if (failed !== null) {
                // The state was not reached: nothing to reproduce from, the environment or the test is at fault.
                writeResult({ status: 'error', code: 'reproduce-state', reason: t('run.reproduce.stateFailed', { id: failed.id, reason: failed.reason }) });
                return { ended: 'verdict', found: { failed } };
            }
            remembered = ended.remembered;
            chat?.preparing(false);
        }
        // What Claude gets: the bug report and the rules of this run, the project's and the person's notes, no plan and no steps
        // to follow; the steps on the way to the state only as orientation.
        const onTheWay = prefix === undefined ? [] : givenSpec.steps.filter(({ id }) => prefix.steps.some((step) => step.id === id)).map(({ id, name }) => ({ id, name }));
        const task = {
            runId,
            language: run.language,
            target,
            source: checked.source,
            framework: run.framework,
            mode: 'reproduce',
            writes: reproduce.writes,
            runTag,
            maxActions,
            reproduce: {
                bug: reproduce.bug,
                writes: reproduce.writes,
                ...(reproduce.from === undefined ? {} : { from: { ...reproduce.from, reached: onTheWay } }),
            },
            ...(run.knownTests === undefined ? {} : { knownTests: run.knownTests }),
            ...(run.personalContext === undefined ? {} : { personalContext: run.personalContext }),
            ...(run.context === undefined ? {} : { context: run.context }),
        };
        const handler = createAgentHandler({ session, run: task, hosts: navigationHosts(config, checked.name), agentDir, filesDir: join(root, PROJECT_DIR), expand: fillSecrets, onVerdict: () => {} });
        const budget = withStepBudget(handler, maxActions ?? Number.POSITIVE_INFINITY);
        // What Claude did in the browser, for the report: the command and its target, never a typed value.
        const actions = [];
        const ACTS = new Set(['click', 'dblclick', 'hover', 'dragTo', 'dialog', 'upload', 'fill', 'type', 'press', 'goto', 'reload']);
        let doneSignal;
        const done = new Promise((ok) => { doneSignal = ok; });
        /** An action for the report as record names it (`fill searchbox "Search todos"`), never a snapshot reference. */
        const readableAction = async (command) => {
            const { action } = command;
            if (typeof command.target !== 'string') return [action, command.url ?? command.key ?? ''].filter((part) => part !== '').join(' ');
            try {
                const code = await recordLocator(session.page().mainFrame(), locatorFor(session.page(), command.target), { framework: (session.framework ?? frameworkOf()).name, timeout: 2000 });
                if (code !== null) return `${action} ${locatorLabel(code)}`;
            } catch {
                // An element that cannot be named stays unnamed.
            }
            return action;
        };
        const finishReproduction = (command) => {
            const result = readReproduction(command.results, { fileExists: (name) => existsSync(join(agentDir, name)) });
            // The steps write when the agent says so or when the run wrote; never on an environment that may not write.
            const writes = reproduce.writes === true && (result.writes || (session.writes?.() ?? []).length > 0);
            const draft = draftTestPlan({ id: reproduce.draftId, role: spec.role, environment: target, writes, steps: result.steps, runId });
            writeFileSync(join(runDir, 'draft-test.yaml'), draft.text);
            reportBase.reproduce = { ...reportBase.reproduce, ...result, actions, draft: adoptHint(draft, root, runDir) };
            // Exit code and terminal follow the verdict: reproduced is a pass, not reproduced or unclear a fail.
            writeResult({ status: result.reproduced === 'yes' ? 'pass' : 'fail', failures: session.failures?.() ?? [] });
            doneSignal();
            return { status: `reproduced ${result.reproduced}`, reproduced: result.reproduced };
        };
        const channelHandler = async (command) => {
            const action = command?.action;
            if (action === 'say') {
                if (chat !== null) return chat.say(command.text);
                ui.note(String(command.text ?? ''));
                return { ok: true };
            }
            if (action === 'finish') return finishReproduction(command);
            // Nobody to ask and nothing to approve or adopt; no change to the test or the code.
            if (['plan', 'check', 'ask-operator', 'chat', 'advise', 'recording'].includes(action)) {
                throw new CawError('reproduce-refused', `A reproduction has no plan, no steps to check and no human to ask, and changes no test or code: ${action} is not available. Read the page with snapshot, eval, console and network, operate it, and end with finish.`);
            }
            if (ACTS.has(action)) actions.push(await readableAction(command));
            return budget.handler(command);
        };
        chat?.advising(true);
        const stopPump = startPump(channelHandler);
        const willing = await claudeMayStart(box, { decline: t('run.tokens.cancelRun') });
        if (!willing) abortSignal();
        const agent = willing ? startAgent(box, containerCommand ?? ['caw', 'agent', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin), '--reproduce'], CLAUDE_LOG, 'reproduce') : IDLE_AGENT;
        let ended;
        try {
            if (willing) ui.info(t('run.reproduce.working'));
            ended = await Promise.race([
                done.then(() => 'verdict'),
                agent.ended,
                session.closed.then(() => 'browser-closed'),
                aborted.then(() => 'aborted'),
            ]);
            agent.stopTail();
            if (verdict === null) {
                if (ended === 'browser-closed' || ended === 'aborted') writeInterrupted(ended);
                else {
                    const log = agent.log();
                    let reason = t('run.noVerdict');
                    if (ended.code !== 0) reason = log === '' ? t('run.sandboxNoAgent', { code: ended.code }) : claudeFailureReason(ended.code, log);
                    writeResult({ status: 'error', code: 'no-verdict', reason });
                }
            }
        } finally {
            await agent.stop();
            await stopPump();
            chat?.advising(false);
        }
        if (budget.used() > 0) ui.info(t('run.budget', { used: budget.used(), max: maxActions ?? t('run.budget.unlimited') }));
        return { ended: typeof ended === 'string' ? ended : 'verdict', found: {} };
    };

    const { ended, found } = reproduce === undefined ? await claudeWork(sandbox) : await reproduceWork(sandbox);
    return closeRun(ended, found);
};
