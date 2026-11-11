// A complete run: open the browser on the host, start the container, execute its commands, write the report.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

import { colorEnabled } from '../shared/color.mjs';
import { createUi } from '../shared/ui.mjs';
import { TODO, authOf, browserHosts, buildDevlinkConfig, isLoopback, sessionPath } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { language, t } from '../shared/i18n.mjs';
import { pollChannel } from '../shared/channel.mjs';
import { renderReport } from '../shared/report.mjs';
import { openChat, parseClaudeLog, tailLines } from './chat.mjs';
import { describeCode } from './code-source.mjs';
import { prepareOverlay } from './overlay.mjs';
import { CONTEXT_FILE, ENV_FILE, PROJECT_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { renderPlan, renderTest, retryProblems, writeTest } from './test-file.mjs';
import { PLAN_FILE, composeTest, planView, readPlan, replaceStep, samePlanStep } from './test-plan.mjs';
import { codeText, createAgentHandler } from './agent-commands.mjs';
import { adviceView, applyEdits, applyToFiles, applyToSpec, adviceReader, changesFiles, configValue } from './advice.mjs';
import { diagnose } from './diagnose.mjs';
import { frameworkOf } from './framework/index.mjs';
import { demonstrate, feedLabel, itemLabel, recordableSteps } from './demonstrate.mjs';
import { CLAUDE_TIMEOUT_MIN, claudeFailureReason, parseEnvFile } from './linux.mjs';
import { fillDates, zonedNow } from './dates.mjs';
import { buildReplay, createRecorder, cutReplay, dropNumbers, failedStep, fillRun, groupSteps, learnedEffects, missingBaselines, missingRemembered, newRunTag, playReplay, recordedBrowser, replayBefore, replayVerdict, stepGroups, stepLabel, tidyNumbers, trailingNumbers } from './replay.mjs';
import { canRestore, loadStateTest, stateCatalog } from './states.mjs';
import { IDLE_AGENT, createTokenGate } from './token-gate.mjs';
import { sandboxRunArgs } from './sandbox-config.mjs';
import { startLocalAgent } from './local-agent.mjs';
import { announceSessionAgent } from '../shared/session-agent.mjs';
import { SELECTION_FILE } from '../shared/names.mjs';
import { withStepBudget } from './step-budget.mjs';
import { redactDeep } from './secrets.mjs';

const DEFAULT_READY_TIMEOUT_MS = 60_000;
const POLL_MS = 50;
const AGENT_DIR = 'agent';
const CHANNEL_DIR = '.channel';
const CLAUDE_LOG = 'claude.log';
// How long the window stays open after the last decision, with a countdown, unless the human closes it.
const LINGER_MS = 15000;
const ADVICE_LOG = 'claude-advice.log';
const DRAFT_FILE = 'test-draft.yaml';
// Changes the page state or proves a step: only allowed once the plan is approved.
// eval too: it runs any script in the page and can change it just like a click. Reading stays allowed via snapshot.
export const NEEDS_PLAN = new Set(['click', 'fill', 'type', 'press', 'goto', 'reload', 'check', 'remember', 'eval']);
// While advising Claude only reads: the page should stay as the run left it.
const ADVISE_READS = new Set(['task', 'snapshot', 'url', 'eval', 'console', 'network', 'screenshot', 'say', 'advise']);
// A conversation only adds waiting for the human.
const TALK_READS = new Set([...ADVISE_READS, 'chat']);
// While developing the window belongs to the human, who can ask Claude to operate it: click, fill, reproduce a bug.
// Only on request (see skill); no test results from it, so there is no `check` or `remember` here.
const DEVELOP_ACTS = new Set([...TALK_READS, 'click', 'fill', 'type', 'press', 'goto', 'reload', 'wait-ready']);
/**
 * The chip at the top right of the workbench while something runs: record while Claude records or fixes (no replay), play while
 * replaying (run, check run, --until; restoring a state sets play itself). Nothing for open: it replays nothing and hands over at
 * once. The page shows pause while a running run is paused (F9); once the run is over the chip goes away.
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
 * What signing in as a role needs: for `form` and `basic` login and password, from the process environment first
 * (CI secrets), otherwise from caw/.env; for `storageState` the saved session of the target; without sign-in nothing.
 */
export const readCredentials = (root, config, roleName, target, env = process.env) => {
    const auth = authOf(config);
    if (auth.type === 'none') return null;
    if (auth.type === 'storageState') {
        const storageState = join(root, sessionPath(target, roleName));
        if (!existsSync(storageState)) throw new CawError('auth-missing', t('run.error.authMissing', { role: roleName, target }));
        return { storageState };
    }
    const role = config.roles[roleName];
    const file = join(root, ENV_FILE);
    const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
    const value = (name) => env[name] || fromFile[name];
    const missing = [role.loginEnv, role.passwordEnv, role.totpEnv].filter((name) => name !== undefined && !value(name));
    if (missing.length > 0) throw new CawError('credentials-missing', t('run.error.credentialsMissing', { names: missing.join(', '), file: ENV_FILE }));
    return { login: value(role.loginEnv), password: value(role.passwordEnv), ...(role.totpEnv === undefined ? {} : { totpSecret: value(role.totpEnv) }) };
};

/** The log file belongs to the container: only read a regular file, never a link. */
const readAgentLog = (file) => {
    try {
        return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : '';
    } catch {
        return '';
    }
};

/** Claude's work outside the steps: one group per run, named after what it is doing. */
const CLAUDE_GROUP = 'claude';
const CLAUDE_GROUPS = ['advise', 'talk', 'develop'];
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
 * Opens Chrome signed in and with local code. Environment errors are thrown as CawError.
 * @param interactive with a chat, i.e. with a human in front of it
 */
export const openRunSession = async ({ root, config, spec, checked, runDir, headless = false, interactive = false, recorded = recordedBrowser(spec.steps ?? []), strict = true, info = (text) => ui.info(text) }) => {
    // What explore did not find and nobody filled in yet: sign-in would fail, so stop before Chrome and Claude.
    const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
    if (todo.length > 0) throw new CawError('config-invalid', t('run.error.todo', { keys: todo.join(', ') }));
    const credentials = readCredentials(root, config, spec.role, checked.target);
    if (!await reachable(checked.url)) throw new CawError('unreachable', t('run.error.unreachable', { url: checked.url }));
    const app = config.apps[spec.app];
    // The overlay source must be ready before Chrome starts, otherwise the run would silently test something else. Whatever
    // caw starts for it (dev server, watch) ends with the session.
    const overlay = checked.source === 'overlay' ? await prepareOverlay({ root, config, checked, info }) : null;
    // Imported only here so that validate works without the browser code.
    const { openBrowserSession } = await import('./browser-session.mjs');
    info(t('run.openingChrome'));
    let session;
    try {
        session = await openBrowserSession({
            config,
            resolved: checked,
            credentials,
            hosts: browserHosts(config, checked),
            startUrl: app.startUrl,
            devlinkConfig: buildDevlinkConfig(config, checked, spec.app),
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
            title: `caw-ai · ${spec.id}`,
            role: spec.role,
            overlay,
            // strict false: a mixed or unused overlay is reported via diagnose instead of ending the session (overlay check).
            overlayStrict: strict,
        });
    } catch (error) {
        overlay?.stop();
        const { isLoginFailure, offerAuthRepair } = await import('./login-repair.mjs');
        if (isLoginFailure(error)) {
            // Spend tokens only where Claude runs anyway: with a chat and on a target with claude. Otherwise just point the way.
            if (interactive && checked.agent) await offerAuthRepair({ root, config, error }).catch(() => false);
            else error.message = `${error.message} ${t('repair.hint')}`;
        }
        throw error;
    }
    if (overlay === null) return session;
    // The overlay's full diagnosis after loading, for caw-ai overlay check.
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
 * the recording is a sequence. Otherwise a reworded step would keep the check of its old expectation.
 * @returns the ids that need to be checked again
 */
export const invalidatedChecks = (before, after, recorder) => {
    const previous = new Map(before.steps.map((step) => [step.id, step]));
    const order = after.steps.map(({ id }) => id);
    const checked = new Set(recorder.steps.filter(({ action }) => action === 'check').map(({ id }) => id));
    const changedAt = after.steps.findIndex((step) => !previous.has(step.id) || !samePlanStep(step, previous.get(step.id)));
    const removed = before.steps.map(({ id }) => id).filter((id) => !order.includes(id));
    const later = changedAt === -1 ? [] : order.slice(changedAt);
    return [...removed, ...later].filter((id) => checked.has(id));
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

/**
 * @param sandbox  result of prepareSandbox
 * @param options  spec, target, checked, timeoutMin, containerCommand, note;
 *                 `handover` decides from the result whether the window is handed to the human;
 *                 with `replay` and `stepTimeoutMs` the recording plays instead of the container, otherwise Claude works;
 *                 `repair` { id, reason } has Claude fix only that step, the steps before it are replayed first without him;
 *                 when recording, `previous` gives Claude the old test plan, `demonstration` the demonstration; `maxSteps` caps its actions;
 *                 `conversation` { transcript, onChatOpen, lazy, alsoOnWarnings } opens the chat; with `lazy` only once a step
 *                 failed, with `alsoOnWarnings` also for failures and warnings of an otherwise passed run;
 *                 `conclude` runs while the chat is still open and gets `advise`, which lets Claude give advice;
 *                 `adviseCommand` replaces Claude for that, like `containerCommand` when recording
 * @returns { exitCode, verdict, failed, candidate, fresh, expectChange }
 */
export const executeRun = async (root, config, sandbox, { spec: givenSpec, checked, target, handover, timeoutMin, containerCommand, adviseCommand, talkCommand, repair, replay, stepTimeoutMs, note, maxSteps, demonstration, previous, conversation, conclude, develop, headless = false }) => {
    // Mutable: repairing in the same browser turns the test run into a run that fixes exactly this step.
    let repairing = repair === undefined ? undefined : givenSpec.steps.find(({ id }) => id === repair.id);
    // With --until only the steps on the way there count, when repairing only that one, and a plan being created has none yet.
    const reached = replay?.until === undefined ? null : new Set(replay.steps.filter(({ action }) => action === 'check').map(({ id }) => id));
    let spec = givenSpec;
    if (reached !== null) spec = { ...givenSpec, expectations: givenSpec.expectations.filter(({ id }) => reached.has(id)) };
    if (repairing !== undefined) spec = { ...givenSpec, steps: [repairing], expectations: givenSpec.expectations.filter(({ id }) => id === repair.id) };
    const runTag = newRunTag();
    const creating = replay === undefined && repair === undefined;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${spec.id}`;
    const relativeRun = posix.join(RUN_DIR, 'runs', runId);
    const runDir = join(root, relativeRun);
    const agentDir = join(runDir, AGENT_DIR);
    const channel = join(agentDir, CHANNEL_DIR);
    mkdirSync(channel, { recursive: true });
    const runCommand = repair !== undefined ? 'fix' : creating ? 'record' : replay.steps.length === 0 && replay.until === undefined ? 'open' : 'run';
    writeLastRun(root, { runId, runDir: relativeRun, command: runCommand, test: spec.id, target });

    const startedAt = Date.now();
    let modeLabel = t('run.mode.record');
    if (replay !== undefined && conversation !== undefined && conversation.lazy !== true && conversation.testing !== true) modeLabel = t('run.mode.verify');
    else if (replay?.until !== undefined) modeLabel = t('run.mode.until', { until: replay.until });
    else if (replay !== undefined && replay.steps.length === 0) modeLabel = t('run.mode.open');
    else if (replay !== undefined) modeLabel = t('run.mode.replay');
    else if (repair !== undefined) modeLabel = t(repair.rerecord ? 'run.mode.rerecord' : 'run.mode.repair', { id: repair.id });
    // Which code runs, always on one line, also in CI: otherwise a silently deployed version would only show in the result.
    const codeLine = describeCode(config, spec, checked, { root });
    ui.header({ mode: modeLabel, test: spec.id, target, source: checked.source, code: codeLine, ...(replay === undefined ? { maxSteps } : {}) });

    // `code`: the same words as the CLI line, e.g. "dev server localhost:5173, your current version" instead of just "deployed".
    const reportBase = { testId: spec.id, target, source: checked.source, testedCode: codeLine, expectations: spec.expectations, ...(note === undefined ? {} : { note }) };
    let verdict = null;
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
        verdict = redactDeep({ ...outcome, ...reportBase, writes: session?.writes() ?? [], warnings: session?.warnings?.() ?? [], ...(session?.overlay?.() ? { overlay: session.overlay() } : {}), ...adviceOf() }, session?.secrets?.() ?? []);
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        writeFileSync(join(runDir, 'report.md'), renderReport(verdict));
        // The run is over: nothing runs any more, so the chip goes away.
        session?.workbench?.transport?.(null)?.catch?.(() => {});
    };
    const finishRun = () => {
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), reportUrl: pathToFileURL(join(runDir, 'report.md')).href, elapsed: (Date.now() - startedAt) / 1000 });
        // Missing saved sign-in or a TODO left in the config means nothing ran: an invalid invocation (3), not the environment (2).
        if (verdict.status === 'error' && NOTHING_RAN.has(verdict.code)) return EXIT.rejected;
        return EXIT[verdict.status];
    };

    const factsOf = (phase) => [
        [t('run.fact.phase'), phase],
        [t('run.fact.test'), spec.id],
        [t('run.fact.target'), target],
        ...(spec.role ? [[t('run.fact.role'), spec.role]] : []),
        [t('run.fact.code'), checked.source === 'overlay' ? t('run.fact.local') : codeLine],
    ];
    // Every recorded action is a point of its step. Without an action, the replay reports a new attempt.
    const showAction = ({ owner, position, step, label }) => {
        const bench = session?.workbench;
        if (bench === undefined || bench === null) return;
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
        session = await openRunSession({ root, config, spec, checked, runDir, headless, interactive: conversation !== undefined, recorded: recordedBrowser(givenSpec.steps) });
        // Distinct fact names: otherwise "target" could mean a step's element and "version" the recording.
        await session.workbench?.facts(factsOf(modeLabel));
        await session.workbench?.transport?.(transportOf(replay));
        await session.workbench?.steps([...stepGroups(spec.steps, replay), ...(replay === undefined ? [] : [endGroup()])]);
    } catch (error) {
        stopSignals();
        if (!(error instanceof CawError)) throw error;
        writeResult({ status: 'error', code: error.code, reason: error.message });
        return { exitCode: finishRun(), verdict };
    }

    // On abort the workbench raven flies into the logo.
    aborted.then(() => session?.workbench?.mood?.('aborted')).catch(() => {});

    // The chat always sits next to the application window. With `lazy` it opens only when something goes wrong.
    let chat = null;
    const tokensOk = createTokenGate({ chat: () => chat });
    const openConversation = () => openChat({ session, logPath: join(runDir, 'chat.log'), onAbort: abortSignal, onOpen: conversation.onChatOpen, onWaiting: ui.note, transcript: conversation.transcript });
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
    const run = {
        runId,
        // Project language: Claude talks to the human and writes steps and expectations in it.
        language: language(),
        target,
        source: checked.source,
        framework: frameworkOf(config).name,
        mutates: spec.mutates,
        expectations: spec.expectations,
        notes: spec.notes,
        steps: spec.steps.map(planStep),
        runTag,
        maxSteps,
        ...(others.length === 0 ? {} : { knownTests: others }),
        ...(context === undefined ? {} : { context }),
        ...(creating ? { create: { app: spec.app, role: spec.role } } : {}),
        ...(!creating || previous === undefined ? {} : {
            previous: {
                plan: renderPlan(previous),
                steps: previous.steps.map(({ id, recording }) => ({ id, actions: recording?.actions.map(stepLabel) ?? [], check: recording?.check })),
                remembered: rememberedIn(previous.steps),
            },
        }),
        ...(demonstration === undefined ? {} : { demonstration: demonstration.items }),
    };
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
            hosts: browserHosts(config, checked),
            agentDir,
            expand: fillSecrets,
            onVerdict: (outcome) => { writeResult(outcome); verdictSignal(); },
        });
    };
    let agentHandler = newAgentHandler();
    // What the replay read; Claude needs these values when repairing in the same browser.
    let played = null;

    /** Processes the commands from the container until the returned stop function halts it. */
    const startPump = (handler) => {
        let pumping = true;
        const ignored = new Set();
        const loop = (async () => {
            while (pumping) {
                // The folder belongs to the container. A failure here must not crash the run, or browser and container
                // would be left behind; at worst the run ends without a verdict.
                await pollChannel(channel, handler, ignored).catch((error) => ui.warn(t('run.channelError', { message: error.message }), console.error));
                await sleep(POLL_MS);
            }
        })();
        // If the channel is waiting for the human, only closing the browser releases it. Do not wait for that.
        return () => { pumping = false; return Promise.race([loop, sleep(1000)]); };
    };
    /** Starts the agent for this run, locally or in the container. Its log is echoed in the chat as plain text; the file belongs to the agent. */
    const startAgent = (box, agentCommand, logName, mode = 'run') => {
        const log = () => readAgentLog(join(agentDir, logName));
        // What Claude does also shows in the step list: when recording under the running step, otherwise in its own group.
        const bench = session?.workbench ?? null;
        const own = claudeGroup(mode);
        if (bench !== null && own !== undefined) bench.group({ id: CLAUDE_GROUP, name: own, kind: 'phase' });
        let lastPoint = null;
        let count = 0;
        const notePoint = (line) => {
            const entry = parseClaudeLog(line);
            if (bench === null || entry === null || entry.kind !== 'activity') return;
            const group = own === undefined ? bench.running() : CLAUDE_GROUP;
            if (group === null) return;
            count += 1;
            lastPoint = [group, `c${count}`];
            bench.point(group, lastPoint[1], 'running', { kind: 'Claude', label: shortActivity(entry.text) });
        };
        const closePoint = () => {
            if (lastPoint !== null) bench?.point(lastPoint[0], lastPoint[1], 'pass');
            lastPoint = null;
        };
        const onLine = (line) => {
            chat.logLine(line);
            notePoint(line);
        };
        if (box.kind === 'session') {
            const hints = {
                run: `Run ${runId} is open. Carry it out and submit the result with finish.`,
                advise: `Run ${runId} had failures or warnings. Read the task with task and submit your advice with advise.`,
                talk: `In run ${runId} a step failed, and the human is asking you in the chat. Read the task with task, answer with say and wait for the human with chat.`,
                develop: `In run ${runId} the human is developing in the restored state. Read the task with task; you can read the page (snapshot, eval, console, network) and operate it on request (click, fill, type, press, goto, reload). Fetch questions from the workbench chat with chat and answer there with say.`,
            };
            const agent = announceSessionAgent({ root, runId, agentDir, mode, hint: hints[mode] });
            chat?.progress?.(t('run.waitingForSession'));
            return { ended: agent.ended, log: () => '', stopTail: () => {}, stop: agent.stop };
        }
        if (box.kind === 'local') {
            const agent = startLocalAgent({ command: agentCommand, agentDir, root, color });
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
        verdict = { ...verdict, ...adviceOf() };
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        writeFileSync(join(runDir, 'report.md'), renderReport(verdict));
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
                    if (!result.files.includes(file)) result.files.push(file);
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
            ...(talking ? { question } : {}),
            // The element the human picked for the question: target, label, component or source. Its text is never an instruction.
            ...(element === undefined ? {} : { element }),
            ...(mode === 'develop' ? { develop: { test: chosen.spec.id, until: chosen.replay?.until ?? null, url: session.page().url(), source: checked.source } } : {}),
            runId,
            language: language(),
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
            ...(context === undefined ? {} : { context }),
            ...(config.lintCommand === undefined ? {} : { lintCommand: config.lintCommand }),
        };
        const reader = createAgentHandler({ session, run: task, hosts: browserHosts(config, checked), agentDir, onVerdict: () => {} });
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
            ? talkCommand ?? ['caw-ai', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin ?? CLAUDE_TIMEOUT_MIN), mode === 'develop' ? '--develop' : '--talk']
            : adviseCommand ?? ['caw-ai', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin ?? CLAUDE_TIMEOUT_MIN), '--advise'];
        let agent = IDLE_AGENT;
        const finished = (async () => {
            // Token notice first; if the human declines, continue without Claude.
            if (!await tokensOk({ decline: t('run.tokens.withoutClaude') })) {
                // Over at once: a message right after declining needs a new session, asking again.
                over = true;
                chat.progress(t('run.tokens.declined'));
                if (!talking) chat.advising(false);
                await stopPump();
                return result;
            }
            agent = startAgent(box, command, talking ? TALK_LOG : ADVICE_LOG, mode);
            let adviceNote;
            try {
                const ended = await Promise.race([done.then(() => 'done'), agent.ended, session.closed.then(() => 'browser-closed'), aborted.then(() => 'aborted')]);
                // In a conversation Claude has only just learned of the end: give it a moment to fetch the last answer and stop cleanly.
                if (ended === 'done' && talking) await Promise.race([agent.ended, new Promise((ok) => { setTimeout(ok, 3000).unref?.(); })]);
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
     * Another state, picked with F1 in the workbench: a test of the same role, app and target up to a step.
     * The step list then shows that test.
     */
    const choose = (other, until) => {
        const end = other.steps.findIndex(({ id }) => id === until);
        const cut = { ...other, steps: other.steps.slice(0, end + 1), expectations: other.expectations.slice(0, end + 1) };
        chosen = { spec: cut, replay: cutReplay(other, until) };
    };
    const restoreOther = async (other, until) => {
        choose(other, until);
        await session.workbench?.steps(stepGroups(chosen.spec.steps, chosen.replay));
        return restoreWith(chosen);
    };
    // Why the last restore failed, with evidence as in a run; null if it worked. Passed to Claude when developing.
    let restoreFailed = null;
    const restoreWith = async ({ spec: shownSpec, replay: plan }) => {
        if (plan === undefined) return t('run.restore.noRecording');
        restoreFailed = null;
        // Like a fresh run: all steps open, the raven hops forward from S1 instead of across old results.
        await session.workbench?.mood?.('wait');
        // The steps run again as in the first run: no longer greyed out, already while they run.
        await session.workbench?.left?.(false);
        for (const { id } of shownSpec.expectations) await session.workbench?.step(id, 'waiting');
        // Signed in fresh like a new run, otherwise the test would start in the session the previous state left behind.
        // With the account of the test's role and on its app's start page, even if the run began with another one.
        chat?.progress(t('run.restore.signingIn', { role: shownSpec.role ?? '' }));
        if (session.signInAgain === undefined) await session.restart();
        else {
            await session.signInAgain({
                // Always explicit: after a test of another role, that role's account is still signed in.
                as: readCredentials(root, config, shownSpec.role, checked.target),
                start: config.apps[shownSpec.app].startUrl,
            });
        }
        agentHandler = newAgentHandler({ ...run, expectations: shownSpec.expectations });
        const tag = newRunTag();
        // Restoring replays the test: play while it runs, nothing afterwards.
        await session.workbench?.transport?.('play')?.catch?.(() => {});
        let again;
        try {
            again = await playReplay({
                replay: plan,
                handler: agentHandler,
                session,
                base: checked.url,
                authMarker: authOf(config).signedInSelector,
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
        // Then it is the human's turn again: the raven flies to the chat, on failure it stays on the step.
        await session.workbench?.mood?.(failed === null ? 'ask' : 'fail');
        const until = plan.until === undefined ? t('run.restore.atEnd') : shownSpec === spec ? plan.until : `${shownSpec.id} ${plan.until}`;
        return failed === null
            ? t('run.restore.done', { until, tag })
            : t('run.restore.failed', { id: failed.id, reason: failed.reason.replace(/\.$/, '') });
    };
    /** The picked element with page and recent requests, for the human's own Claude Code session (tool caw_selection). */
    const handToCode = (element) => {
        const recent = session.network === undefined ? [] : session.network.since(Math.max(0, session.network.mark() - 20));
        const selection = { at: new Date().toISOString(), runId, test: chosen.spec.id, target, until: chosen.replay?.until ?? null, url: session.page().url(), source: checked.source, element, requests: recent };
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
            const text = results.length > 0 ? t('run.finished.steps', { passed, total: results.length }) : t(verdict.status === 'pass' ? 'run.finished.passed' : 'run.finished.failed');
            await chat.finished?.({ report: join(runDir, 'report.md'), shown: posix.join(relativeRun, 'report.md'), text, command: `caw-ai run ${spec.id}` });
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
            // The header says what applies now: the replay is over, it is the human's turn.
            let phase = t('run.phase.handedOver');
            if (developing) phase = replay?.until !== undefined && verdict.status === 'pass' ? t('run.phase.developIn', { until: replay.until }) : t('run.phase.develop');
            await session.workbench?.facts(factsOf(phase)).catch(() => {});
            await session.workbench?.transport?.(null).catch(() => {});
            if (replay?.until !== undefined && verdict.status === 'pass') {
                ui.success(t('run.handover.state', { until: replay.until, local: checked.source === 'overlay' ? t('run.handover.local') : '' }));
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
                    // After the handover (open, --until) the workbench shows only the application full-screen; F8 brings the workbench back.
                    await bench?.solo?.(true);
                    // F1: states from all tests of this target, each in its role's account. Without a step the test runs to the last
                    // restorable one. With basic auth the account is tied to the browser: only the own role.
                    const scope = authOf(config).type === 'basic' ? { role: spec.role, target } : { target };
                    let catalog = stateCatalog(root, config, scope);
                    await bench?.states?.(catalog);
                    afterSave = async (testId) => {
                        catalog = stateCatalog(root, config, scope);
                        await bench?.states?.(catalog);
                        const until = chosen.replay?.until;
                        const fresh = chosen.spec.id === testId && until !== undefined ? loadStateTest(root, config, testId) : undefined;
                        if (fresh !== undefined && canRestore(catalog, testId, until)) choose(fresh, until);
                    };
                    const restoreTo = async (testId, stepId) => {
                        const entry = catalog.find(({ id }) => id === testId);
                        const until = stepId ?? entry?.steps.filter(({ ok }) => ok).at(-1)?.id;
                        if (entry === undefined || until === undefined || !canRestore(catalog, testId, until)) throw new CawError('step-unknown', t('run.develop.cannotRestore', { test: testId, step: stepId ?? '' }));
                        return restoreOther(loadStateTest(root, config, testId), until);
                    };
                    const restore = () => (chosen.replay === undefined ? reloadApp() : restoreState());
                    await Promise.race([develop({ chat, talk: ask, until: replay?.until, refresh, restore, restoreTo, onPickState: (handler) => bench?.onState?.(handler), onRefresh: (handler) => bench?.onRefresh?.(handler), onReload, toCode: handToCode }), session.closed, aborted]);
                } catch (error) {
                    ui.warn(t('run.develop.error', { message: String(error?.message ?? error).split(/\r?\n/)[0] }));
                } finally {
                    chat.human.closed();
                }
            } else {
                await Promise.race([session.closed, aborted]);
            }
        }
        stopSignals();
        await session.close();
        return { exitCode, verdict, ...found };
    };
    const writeInterrupted = (ended) => {
        if (ended === 'browser-closed') writeResult({ status: 'error', code: 'browser-closed', reason: t('run.interrupted.browserClosed') });
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
        const fillIn = (value) => fillDates(openRemembered().reduce((current, [placeholder, real]) => current.split(placeholder).join(codeText(real)), fillRun(value, runTag)), zonedNow(session.browser?.timezone));
        if (repairing !== undefined) {
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
        const budget = withStepBudget(agentHandler, maxSteps ?? Number.POSITIVE_INFINITY);
        let recorder = null;
        let plan = null;
        /** The plan becomes the test file. Only the human's approval makes it the yardstick of the run. */
        const proposePlan = async ({ text }) => {
            if (typeof text !== 'string' || text.trim() === '') throw new CawError('plan-invalid', 'The plan is empty.');
            const { problems, plan: parsed } = readPlan(text);
            if (problems.length > 0) throw new CawError('plan-invalid', problems.join(' '));
            if (repairing !== undefined && (parsed.steps.length !== 1 || parsed.steps[0].id !== repair.id)) {
                throw new CawError('plan-invalid', `When repairing, the plan contains exactly step ${repair.id}.`);
            }
            // A manually set retry survives the repair even if Claude does not repeat it.
            const steps = repairing?.retry === undefined ? parsed.steps : parsed.steps.map((step) => ({ retry: repairing.retry, ...step }));
            const retryIssues = retryProblems(repairing === undefined ? steps : replaceStep(givenSpec, steps[0]).steps);
            if (retryIssues.length > 0) throw new CawError('plan-invalid', retryIssues.join(' '));
            const composed = repairing === undefined ? composeTest(givenSpec, parsed) : { ...spec, steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })) };
            // Same plan as in the test file: the human already adopted it, nothing to approve. The human can still write.
            const unchanged = repairing !== undefined && samePlanStep(steps[0], repairing);
            if (unchanged) chat.notice(t(repair.rerecord ? 'run.plan.unchangedRerecord' : 'run.plan.unchangedRepair', { id: repair.id }));
            const answer = unchanged ? { approved: true } : await chat.plan(planView(composed, { repairing: repairing !== undefined, rerecord: repair?.rerecord === true, previous: repairing }));
            if (!answer.approved) return answer;
            const redo = plan === null ? [] : invalidatedChecks(plan, composed, recorder);
            plan = composed;
            writeFileSync(join(runDir, PLAN_FILE), text.replaceAll('\r\n', '\n'));
            spec = composed;
            run.expectations = composed.expectations;
            run.notes = composed.notes;
            run.steps = composed.steps.map(planStep);
            reportBase.expectations = composed.expectations;
            if (redo.length === 0) return { approved: true };
            recorder.forgetChecks(new Set(redo));
            return {
                approved: true,
                invalidated: redo,
                note: `The checks of ${redo.join(', ')} no longer apply because the plan changed from there on. Walk the path so that you check these steps again, and drop outdated actions with omit.`,
            };
        };
        /** The verdict refers to the approved plan, and every passed step must be in it. */
        const checkAgainstPlan = (results) => {
            // If the application is at fault, Claude only reports fail when repairing: that changes nothing in the test and needs no plan.
            const onlyFail = Array.isArray(results.expectations) && results.expectations.length > 0 && results.expectations.every(({ status }) => status === 'fail');
            if (plan === null && repairing !== undefined && onlyFail) return;
            if (plan === null) throw new CawError('plan-required', `There is no approved plan yet. Submit it with caw-ai plan --file <${PLAN_FILE}>.`);
            const known = new Set(spec.expectations.map(({ id }) => id));
            const { groups } = groupSteps(recorder.steps);
            const failed = new Set((results.expectations ?? []).filter(({ status }) => status === 'fail').map(({ id }) => id));
            // A step submitted as fail cannot have a passed check: that is a result too.
            const missing = [...known].filter((id) => !groups.has(id) && !failed.has(id));
            if (missing.length > 0) throw new CawError('finish-rejected', `Without a passed check: ${missing.join(', ')}.`);
            if (repairing === undefined || failed.size > 0) return;
            const same = plan.steps[0].expect === repairing.expect;
            if (same && repairing.recording !== undefined && groups.get(repair.id).check !== repairing.recording.check) {
                throw new CawError('finish-rejected', `The expected result of ${repair.id} is unchanged, so the check must stay the same too: ${fillIn(repairing.recording.check)}. To change it, submit a plan with a changed expect.`);
            }
            const lost = missingRemembered(replaceStep(givenSpec, { ...plan.steps[0], recording: { actions: groups.get(repair.id).actions, check: groups.get(repair.id).check } }));
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
        recorder = createRecorder({ handler, session, base: checked.url, authMarker: authOf(config).signedInSelector, runTag, remembered, now: () => zonedNow(session.browser?.timezone) });
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
                const items = await demonstrate({ session, operator: chat.operator, ui, dir: agentDir, onItem: (item) => { const line = feedLabel(item); if (line !== null) chat.progress(t('run.recorded', { line })); }, onFailure: (item) => chat.notice(t('run.recordedFailure', { item: itemLabel(item) })) });
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
            if (plan === null && NEEDS_PLAN.has(command?.action)) throw new CawError('plan-required', `Submit the plan first: caw-ai plan --file <${PLAN_FILE}>. Reading works without it, e.g. snapshot.`);
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
        const willing = await tokensOk({ decline: t('run.tokens.cancelRun') });
        if (!willing) abortSignal();
        const agent = willing ? startAgent(box, containerCommand ?? ['caw-ai', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin)], CLAUDE_LOG) : IDLE_AGENT;
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

        if (budget.used() > 0) ui.info(t('run.budget', { used: budget.used(), max: maxSteps ?? t('run.budget.unlimited') }));

        const built = buildReplay({ recorder, outcome: verdict, spec, target, browser: session.browser ?? {}, ...(repairing === undefined ? {} : { draft: givenSpec }), ...(creating && previous !== undefined ? { previous } : {}) });
        let { candidate } = built;
        // Created as read-only but it wrote: then the test mutates, otherwise it would run on targets without writable.
        const written = verdict?.writes ?? [];
        if (candidate !== undefined && !candidate.mutates && written.length > 0) {
            candidate = { ...candidate, mutates: true };
            ui.warn(t('run.mutates', { id: spec.id, labels: written.map(({ label }) => label).join(', ') }));
        }
        if (candidate === undefined) {
            ui.warn(t('run.noRecording', { problems: built.problems.join(' ') }));
            // A run that yields no recording missed its goal, even if all checks passed.
            if (verdict?.status === 'pass') writeResult({ ...verdict, status: 'fail', reason: built.problems.join(' ') });
        } else {
            writeFileSync(join(runDir, DRAFT_FILE), renderTest(candidate));
        }
        const changed = repairing !== undefined && candidate !== undefined && plan.steps[0].expect !== repairing.expect;
        return {
            ended,
            found: {
                candidate,
                fresh: built.fresh,
                ...(repairReviewer === null ? {} : { repairAdvice: repairReviewer.result }),
                ...(changed ? { expectChange: { id: repair.id, before: repairing.expect, after: plan.steps[0].expect } } : {}),
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
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), reportUrl: pathToFileURL(join(runDir, 'report.md')).href, elapsed: (Date.now() - startedAt) / 1000 });
        verdict = before;
        return repaired;
    };

    if (replay !== undefined) {
        if (replay.steps.length > 0) ui.info(t('run.replaying', { count: replay.steps.length, on: replay.recordedOn }));
        const started = Date.now();
        const play = playReplay({
            replay,
            handler: agentHandler,
            session,
            ...(config.effects?.fail === undefined ? {} : { effectFail: config.effects.fail }),
            base: checked.url,
            authMarker: authOf(config).signedInSelector,
            stepTimeoutMs,
            filesDir: join(root, PROJECT_DIR),
            runTag,
            // The terminal adds the total itself, the chat gets the finished label.
            log: (entry) => {
                const { position, number, owner, label } = entry;
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
            writeFileSync(join(runDir, 'report.md'), renderReport(verdict));
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
        if (baselines.size + effects.size > 0) await session.workbench?.point(END, 'learn', 'pass', { kind: t('run.learn.kind'), label: t('run.learn.label') });
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
                        hosts: browserHosts(config, checked),
                        agentDir,
                        onVerdict: (outcome) => { reportBase.expectations = expectations; writeResult(outcome); },
                    }),
                    session,
                    base: checked.url,
                    authMarker: authOf(config).signedInSelector,
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
    const { ended, found } = await claudeWork(sandbox);
    return closeRun(ended, found);
};
