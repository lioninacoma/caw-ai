// Ein kompletter Lauf: Browser auf dem Host oeffnen, Container starten, dessen Befehle ausfuehren, Bericht schreiben.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { colorEnabled } from '../shared/color.mjs';
import { createUi } from '../shared/ui.mjs';
import { TODO, authOf, browserHosts, buildDevlinkConfig, isLoopback, sessionPath } from '../shared/config.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { language, t } from '../shared/i18n.mjs';
import { pollChannel } from '../shared/channel.mjs';
import { renderReport } from '../shared/report.mjs';
import { checkAppFiles, checkConstants, checkLocalBuild, checkStatics } from './app-files.mjs';
import { openChat, parseClaudeLog, tailLines } from './chat.mjs';
import { CONTEXT_FILE, ENV_FILE, PROJECT_DIR, RUN_DIR, TEST_DIR } from '../shared/names.mjs';
import { renderPlan, renderTest, retryProblems } from './test-file.mjs';
import { PLAN_FILE, composeTest, planView, readPlan, replaceStep, samePlanStep } from './test-plan.mjs';
import { createAgentHandler } from './agent-commands.mjs';
import { adviceView, applyEdits, applyToFiles, applyToSpec, changesFiles, configValue, readAdvice } from './advice.mjs';
import { diagnose } from './diagnose.mjs';
import { frameworkOf } from './framework/index.mjs';
import { demonstrate, feedLabel, itemLabel, recordableSteps } from './demonstrate.mjs';
import { CLAUDE_TIMEOUT_MIN, claudeFailureReason, parseEnvFile } from './linux.mjs';
import { fillDates } from './dates.mjs';
import { buildReplay, createRecorder, dropNumbers, failedStep, fillRun, groupSteps, learnedEffects, missingBaselines, missingRemembered, newRunTag, playReplay, replayBefore, replayVerdict, stepGroups, stepLabel, swapText, tidyNumbers, trailingNumbers } from './replay.mjs';
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
const ADVICE_LOG = 'claude-empfehlung.log';
const DRAFT_FILE = 'test-entwurf.yaml';
// Aendert den Zustand der Seite oder belegt einen Punkt: Das geht erst nach der Freigabe des Plans.
const NEEDS_PLAN = new Set(['click', 'fill', 'type', 'press', 'goto', 'reload', 'check', 'remember']);
// Beim Empfehlen liest Claude nur: Die Seite soll bleiben, wie der Lauf sie hinterlassen hat.
const ADVISE_READS = new Set(['task', 'snapshot', 'url', 'eval', 'console', 'network', 'screenshot', 'say', 'advise']);
// Im Gespraech kommt nur das Warten auf den Menschen dazu.
const TALK_READS = new Set([...ADVISE_READS, 'chat']);
const TALK_LOG = 'claude-gespraech.log';
// Beschriftungen als Getter: Die Sprache steht beim Import noch nicht fest.
const ACCEPT = { id: 'accept', get label() { return t('run.button.accept'); }, primary: true };
const REJECT = { id: 'discard', get label() { return t('run.button.discard'); } };
const NEXT = { id: 'next', get label() { return t('run.button.next'); }, primary: true };
// Nur auf Klick: schreibt die vorgeschlagene Aenderung in den Code der Anwendung, committet wird nie.
const APPLY = { id: 'apply', get label() { return t('run.button.apply'); }, primary: true };

const color = colorEnabled();
const ui = createUi();
const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
/** Fehler vor dem Lauf, die an Aufruf oder Config liegen: Exit 3 wie in der Doku, nicht 2. */
const NOTHING_RAN = new Set(['auth-missing', 'config-invalid']);

/** Erreichbarkeit der Umgebung: Jede HTTP-Antwort zaehlt. Zertifikate prueft hier niemand. */
export const reachable = (url) => new Promise((ok) => {
    // localhost und Namen unter .localhost auf 127.0.0.1, so wie fuer Chrome: Node unter Windows kennt .localhost nicht und loest
    // localhost oft zuerst nach ::1 auf, wo der Dev-Server nicht lauscht.
    const loopback = isLoopback(new URL(url).hostname) ? { lookup: (_host, options, done) => (options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)) } : {};
    // http gibt es nur auf dem eigenen Rechner, etwa fuer einen lokalen Dev-Server; die Config laesst es sonst nicht zu.
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
 * Was die Anmeldung einer Rolle braucht: bei `form` und `basic` Name und Passwort, zuerst aus der Umgebung des Prozesses
 * (CI-Secrets), sonst aus caw/.env; bei `storageState` die gespeicherte Sitzung des Ziels; ohne Anmeldung nichts.
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

/** Die Logdatei gehoert dem Container: nur eine echte Datei lesen, keine Verknuepfung. */
const readAgentLog = (file) => {
    try {
        return lstatSync(file).isFile() ? readFileSync(file, 'utf8') : '';
    } catch {
        return '';
    }
};

/** Claudes Arbeit ausserhalb der Schritte: eine Gruppe je Lauf, benannt nach dem, was er gerade tut. */
const CLAUDE_GROUP = 'claude';
const CLAUDE_GROUPS = ['advise', 'talk', 'develop'];
const claudeGroup = (mode) => (CLAUDE_GROUPS.includes(mode) ? t(`run.group.${mode}`) : undefined);
/** Ein Punkt bleibt eine Zeile, wenn es geht: Den ganzen Befehl zeigt der Chat. */
const shortActivity = (text) => (text.length > 70 ? `${text.slice(0, 69)}…` : text);

/** Die Gruppe nach dem letzten Schritt eines Testlaufs: Wirkung vergleichen, Vergleichswerte lernen (nur bei Bedarf), Bericht. */
const END = 'end';
const endGroup = () => ({
    id: END,
    name: t('run.end.name'),
    kind: 'phase',
    points: [{ id: 'effects', kind: t('run.end.effects'), label: t('run.end.compare') }, { id: 'report', kind: t('run.end.report'), label: 'report.md' }],
});

/** Chrome angemeldet und mit lokalem Code oeffnen. Fehler der Umgebung kommen als CawError. */
/**
 * Mit Chat laeuft die Anwendung immer in der Werkbank (ein Fenster mit Schritten, Chat und Requests), ohne Chat im eigenen Fenster.
 * Die Werkbank liegt auf der Adresse der Anwendung selbst, das geht unter jeder Adresse.
 */
export const embedsApp = (interactive) => interactive === true;

/** @param interactive mit Chat, also mit einem Menschen davor */
export const openRunSession = async ({ root, config, spec, checked, runDir, headless = false, interactive = false }) => {
    // Was explore nicht fand und noch niemand eintrug: Ohne das scheitert schon die Anmeldung, also vor Chrome und Claude abbrechen.
    const todo = Object.entries(config.auth ?? {}).filter(([, value]) => value === TODO).map(([key]) => `auth.${key}`);
    if (todo.length > 0) throw new CawError('config-invalid', t('run.error.todo', { keys: todo.join(', ') }));
    const credentials = readCredentials(root, config, spec.role, checked.target);
    if (!await reachable(checked.url)) throw new CawError('unreachable', t('run.error.unreachable', { url: checked.url }));
    const app = config.apps[spec.app];
    const appDir = join(root, app.dir);
    const also = checked.source === 'watch' ? spec.also ?? [] : [];
    // bootstrap.json braucht nur, wer Sencha-Pakete umleitet (`redirects`); einzelne Dateien (`statics`) kommen ohne aus.
    if (checked.source === 'watch') {
        for (const name of [spec.app, ...also]) {
            if ((config.apps[name].redirects ?? []).length > 0) checkAppFiles(join(root, config.apps[name].dir));
            checkStatics(root, config.apps[name].statics);
            checkConstants(join(root, config.apps[name].dir), config.apps[name].constants);
            checkLocalBuild(root, config.apps[name].localBuild);
        }
    }
    // Erst hier, denn validate soll auch ohne Browser-Code gehen.
    const { openBrowserSession } = await import('./browser-session.mjs');
    ui.info(t('run.openingChrome'));
    return openBrowserSession({
        config,
        resolved: checked,
        credentials,
        hosts: browserHosts(config, checked),
        startUrl: app.startUrl,
        appDir,
        extraApps: also.map((name) => ({ dir: join(root, config.apps[name].dir), devlinkConfig: buildDevlinkConfig(config, checked, name, 'watch', root) })),
        devlinkConfig: buildDevlinkConfig(config, checked, spec.app, checked.source, root),
        devlinkConfigPath: join(runDir, 'devlink-config.json'),
        tracePath: join(runDir, 'trace.zip'),
        floatsLogPath: join(runDir, 'floats.log'),
        consoleIgnore: config.consoleIgnore ?? [],
        foreignCode: config.foreignCode ?? [],
        readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        headless,
        embed: !headless && embedsApp(interactive),
        title: `caw-ai · ${spec.id}`,
        role: spec.role,
        localCode: checked.localCode === true,
    });
};

/** Was das Projekt schon an Wegen kennt. */
const knownTests = (root, ownId) => {
    const dir = join(root, TEST_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.yaml') && name !== `${ownId}.yaml`).map((name) => posix.join(TEST_DIR, name));
};

/**
 * Eine neue Planfassung macht Pruefungen ungueltig: die eines entfernten Schritts und, ab dem ersten geaenderten Schritt, alle
 * spaeteren, denn die Aufzeichnung ist eine Reihe. Sonst bekaeme ein umformulierter Schritt die Pruefung der alten Erwartung.
 * @returns die IDs, deren Pruefung neu noetig ist
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

/** Die Felder, die der Agent von einem Schritt sehen soll. */
const planStep = ({ id, name, do: action, expect, note, retry }) => ({ id, name, do: action, expect, ...(note === undefined ? {} : { note }), ...(retry === undefined ? {} : { retry }) });
const rememberedIn = (steps) => steps.flatMap(({ recording }) => recording?.actions ?? []).filter(({ action }) => action === 'remember').map(({ name, code }) => ({ name, code }));

/**
 * Projektkontext aus caw/caw.md, wie CLAUDE.md fuer die Tests: Eigenheiten der Anwendungen, relevante Infos. Zaehlt nicht zum
 * Schritt-Hash, Aenderungen entwerten also keine Aufzeichnung.
 */
export const readContext = (root) => {
    const file = join(root, CONTEXT_FILE);
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? undefined : text;
};

/**
 * @param sandbox  Ergebnis von prepareSandbox
 * @param options  spec, target, checked, timeoutMin, containerCommand, note;
 *                 `handover` entscheidet anhand des Ergebnisses, ob das Fenster an den Menschen geht;
 *                 mit `replay` und `stepTimeoutMs` laeuft statt des Containers die Aufzeichnung, sonst arbeitet Claude;
 *                 `repair` { id, reason } laesst ihn nur diesen Schritt beheben, die Schritte davor laufen vorab ohne ihn;
 *                 `previous` nennt ihm beim Aufnehmen den alten Testplan, `demonstration` die Vorfuehrung; `maxSteps` begrenzt seine Aktionen;
 *                 `conversation` { transcript, onChatOpen, lazy, alsoOnWarnings } oeffnet den Chat, mit `lazy` erst, wenn ein Schritt
 *                 gescheitert ist, mit `alsoOnWarnings` auch bei Fehlern und Warnungen eines sonst bestandenen Laufs;
 *                 `conclude` laeuft bei noch offenem Chat und bekommt `advise`, das Claude Empfehlungen geben laesst;
 *                 `adviseCommand` ersetzt dafuer Claude, wie `containerCommand` beim Aufnehmen
 * @returns { exitCode, verdict, failed, candidate, fresh, expectChange }
 */
export const executeRun = async (root, config, sandbox, { spec: givenSpec, checked, target, handover, timeoutMin, containerCommand, adviseCommand, talkCommand, repair, replay, stepTimeoutMs, note, maxSteps, demonstration, previous, conversation, conclude, develop, headless = false }) => {
    // Veraenderlich: Beim Beheben im selben Browser wird aus dem Testlauf ein Lauf, der genau diesen Schritt behebt.
    let repairing = repair === undefined ? undefined : givenSpec.steps.find(({ id }) => id === repair.id);
    // Mit --until zaehlen nur die Schritte auf dem Weg dorthin, beim Beheben nur dieser eine, und ein Plan im Entstehen hat noch keine.
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

    const startedAt = Date.now();
    let mode = t('run.mode.record');
    if (replay !== undefined && conversation !== undefined && conversation.lazy !== true && conversation.testing !== true) mode = t('run.mode.verify');
    else if (replay?.until !== undefined) mode = t('run.mode.until', { until: replay.until });
    else if (replay !== undefined) mode = t('run.mode.replay');
    else if (repair !== undefined) mode = t(repair.rerecord ? 'run.mode.rerecord' : 'run.mode.repair', { id: repair.id });
    ui.header({ mode, test: spec.id, target, source: checked.source, ...(replay === undefined ? { maxSteps } : {}) });

    const reportBase = { testId: spec.id, target, source: checked.source, expectations: spec.expectations, ...(note === undefined ? {} : { note }) };
    let verdict = null;
    let session;
    // Alle Empfehlungen dieses Laufs, auch aus mehreren Sitzungen: Der Bericht nennt sie zusammen.
    const decided = [];
    const adviceNotes = [];
    const adviceOf = () => (decided.length === 0 && adviceNotes.length === 0 ? {} : { advice: { items: decided, ...(adviceNotes.length === 0 ? {} : { note: adviceNotes.join(' ') }) } });
    // Empfiehlt Claude beim Beheben und reicht danach sein Urteil ein, bleiben die Empfehlungen im Bericht.
    const writeResult = (outcome) => {
        // Geschwaerzt wie fuer Claude: Passwort der Rolle und geheim gemerkte Werte stehen nie in result.json oder report.md.
        verdict = redactDeep({ ...outcome, ...reportBase, writes: session?.writes() ?? [], warnings: session?.warnings?.() ?? [], ...adviceOf() }, session?.secrets?.() ?? []);
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        writeFileSync(join(runDir, 'report.md'), renderReport(verdict));
    };
    const finishRun = () => {
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), elapsed: (Date.now() - startedAt) / 1000 });
        // Fehlt die gespeicherte Anmeldung oder steht noch TODO in der Config, lief nichts: ein ungueltiger Aufruf (3), keine Umgebung (2).
        if (verdict.status === 'error' && NOTHING_RAN.has(verdict.code)) return EXIT.rejected;
        return EXIT[verdict.status];
    };

    const factsOf = (phase) => [
        [t('run.fact.phase'), phase],
        [t('run.fact.test'), spec.id],
        [t('run.fact.target'), target],
        ...(spec.role ? [[t('run.fact.role'), spec.role]] : []),
        ...(checked.localCode ? [[t('run.fact.code'), t(checked.source === 'watch' ? 'run.fact.local' : 'run.fact.deployed')]] : []),
    ];
    // Jede Aktion der Aufzeichnung ist ein Punkt ihres Schritts. Ohne Aktion meldet das Abspielen einen neuen Versuch.
    const showAction = ({ owner, position, step, label }) => {
        const bench = session?.workbench;
        if (bench === undefined || bench === null) return;
        bench.step(owner, 'running');
        if (step === undefined) bench.point(owner, `v${position}-${Date.now()}`, 'pass', { kind: t('run.point.attempt'), label: label.replace(/^\S+: /, '').replace(/^(neuer Versuch|attempt) /, '') });
        else bench.point(owner, `a${position}`, 'running');
    };
    try {
        session = await openRunSession({ root, config, spec, checked, runDir, headless, interactive: conversation !== undefined });
        // Eindeutige Namen: „Ziel“ hiesse sonst auch das Element eines Schritts, „Stand“ auch die Aufzeichnung.
        await session.workbench?.facts(factsOf(mode));
        await session.workbench?.steps([...stepGroups(spec.steps, replay), ...(replay === undefined ? [] : [endGroup()])]);
    } catch (error) {
        if (!(error instanceof CawError)) throw error;
        writeResult({ status: 'error', code: error.code, reason: error.message });
        return { exitCode: finishRun(), verdict };
    }

    let abortSignal;
    const aborted = new Promise((ok) => { abortSignal = ok; });
    // Der Rabe der Werkbank fliegt bei Abbruch ins Logo.
    aborted.then(() => session.workbench?.mood?.('aborted')).catch(() => {});
    process.once('SIGINT', abortSignal);

    // Der Chat steht immer neben dem Anwendungsfenster. Mit `lazy` oeffnet er sich erst, wenn etwas schiefgeht.
    let chat = null;
    const tokensOk = createTokenGate({ chat: () => chat });
    const openConversation = () => openChat({ session, logPath: join(runDir, 'chat.log'), onAbort: abortSignal, onOpen: conversation.onChatOpen, transcript: conversation.transcript });
    if (conversation !== undefined && conversation.lazy !== true) {
        try {
            chat = await openConversation();
            if (replay !== undefined && conversation.testing === true) chat.testing();
            else if (replay !== undefined) chat.verifying();
        } catch (error) {
            process.removeListener('SIGINT', abortSignal);
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
        // Sprache des Projekts: In ihr spricht Claude mit dem Menschen und schreibt Schritte und Erwartungen.
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
    // Gemerkte Werte des Laufs, Platzhalter -> Wert. Geheime sieht Claude nur als Platzhalter; der Handler setzt sie ein.
    let remembered = new Map();
    const isSecret = (value) => (session.secrets?.() ?? []).includes(value);
    const openRemembered = () => [...remembered].filter(([, value]) => !isSecret(value));
    const fillSecrets = (text) => [...remembered].filter(([, value]) => isSecret(value)).reduce((current, [placeholder, real]) => current.split(placeholder).join(real), text);
    let verdictGiven;
    /** Je Urteil ein eigener Handler: Nach `finish` nimmt er nichts mehr an, beim Beheben im selben Browser kommt ein zweites Urteil. */
    const newAgentHandler = () => {
        let verdictSignal;
        verdictGiven = new Promise((ok) => { verdictSignal = ok; });
        return createAgentHandler({
            session,
            run,
            hosts: browserHosts(config, checked),
            agentDir,
            expand: fillSecrets,
            onVerdict: (outcome) => { writeResult(outcome); verdictSignal(); },
        });
    };
    let agentHandler = newAgentHandler();
    // Was das Abspielen gelesen hat; beim Beheben im selben Browser braucht Claude diese Werte.
    let played = null;

    /** Arbeitet die Befehle aus dem Container ab, bis die Rueckgabe sie anhaelt. */
    const startPump = (handler) => {
        let pumping = true;
        const ignored = new Set();
        const loop = (async () => {
            while (pumping) {
                // Der Ordner gehoert dem Container. Was hier scheitert, darf den Lauf nicht abstuerzen lassen,
                // sonst blieben Browser und Container zurueck; im schlimmsten Fall endet er ohne Urteil.
                await pollChannel(channel, handler, ignored).catch((error) => ui.warn(t('run.channelError', { message: error.message }), console.error));
                await sleep(POLL_MS);
            }
        })();
        // Wartet der Kanal gerade auf den Menschen, loest ihn erst das Schliessen des Browsers. Darauf nicht warten.
        return () => { pumping = false; return Promise.race([loop, sleep(1000)]); };
    };
    /** Startet den Agenten fuer diesen Lauf, lokal oder im Container. Sein Log laeuft im Chat mit, als reiner Text: Die Datei gehoert dem Agenten. */
    const startAgent = (box, agentCommand, logName, mode = 'run') => {
        const log = () => readAgentLog(join(agentDir, logName));
        // Was Claude tut, steht auch in der Schrittliste: beim Aufnehmen unter dem laufenden Schritt, sonst in einer eigenen Gruppe.
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
                run: `Der Lauf ${runId} ist offen. Fuehre ihn durch und reiche das Ergebnis mit finish ein.`,
                advise: `Im Lauf ${runId} sind Fehler oder Warnungen aufgetreten. Lies den Auftrag mit task und reiche deine Empfehlungen mit advise ein.`,
                talk: `Im Lauf ${runId} ist ein Schritt gescheitert, und der Mensch fragt dich im Chat. Lies den Auftrag mit task, antworte mit say und warte mit chat auf ihn.`,
                develop: `Im Lauf ${runId} entwickelt der Mensch im hergestellten Zustand. Lies den Auftrag mit task; die Seite kannst du lesen (snapshot, eval, console, network). Fragen aus dem Chat der Werkbank holst du mit chat, antworte dort mit say.`,
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

    /** Bericht und Ergebnis um die Empfehlungen ergaenzen. Der Urteilsspruch bleibt, wie er war. */
    const writeAdvice = () => {
        if (decided.length === 0 && adviceNotes.length === 0) return;
        verdict = { ...verdict, ...adviceOf() };
        writeFileSync(join(runDir, 'result.json'), JSON.stringify(verdict, null, 2));
        writeFileSync(join(runDir, 'report.md'), renderReport(verdict));
    };
    /**
     * Claude untersucht im Browser dieses Laufs, nur lesend. Mit `advise` reicht es Empfehlungen ein, der Mensch entscheidet je Karte.
     * Knowledge und Config aendern sich sofort, Aenderungen am Test nur im zurueckgegebenen Test: Ob er in die Datei geht, entscheidet der Ablauf.
     * @param box      Sandbox
     * @param draft    der ganze Test, auf den sich die Empfehlungen beziehen
     * @param mode     advise: einmal empfehlen, dann ist Schluss; talk: Gespraech mit dem Menschen, bis `end`
     * @param question beim Gespraech die erste Nachricht des Menschen
     * @returns { finished, send, end }: `finished` liefert { spec, touched, stale, notes, files }, `stale` nennt { id, title } der
     *          Schritte, die neu aufgenommen werden muessen; `send` gibt Claude eine weitere Nachricht, `end` beendet das Gespraech
     */
    /**
     * Empfehlungen als Karten vorlegen und je Entscheidung anwenden: Knowledge, Config und Code sofort, der Test nur im Ergebnis.
     * @returns { result, review(items) }; `result` sammelt { spec, touched, stale, notes, files }
     */
    const createReviewer = (draft) => {
        const result = { spec: draft, touched: [], stale: [], notes: false, files: [] };
        const review = async (items) => {
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
                    // Gilt sofort, auch fuer den naechsten Pruefdurchlauf dieses Befehls: Er liest die Config nicht neu.
                    if (item.change.kind === 'config') config[item.change.key] = configValue(config, item.change);
                } else if (decision === 'adopted') {
                    const applied = applyToSpec(result.spec, item.change);
                    result.spec = applied.spec;
                    if (applied.notes) result.notes = true;
                    else if (!result.touched.includes(applied.id)) result.touched.push(applied.id);
                    if (applied.stale && !result.stale.some(({ id }) => id === applied.id)) result.stale.push({ id: applied.id, title: item.title });
                }
                decided.push({ ...view, decision });
            }
            writeAdvice();
            return decided.slice(start).map(({ title, decision }) => ({ title, decision }));
        };
        return { result, review };
    };
    const consult = ({ sandbox: box, spec: draft }, found, { mode, question, element }) => {
        const talking = mode === 'talk' || mode === 'develop';
        const allowed = talking ? TALK_READS : ADVISE_READS;
        const { result, review } = createReviewer(draft);
        const failed = found.failed ?? null;
        const inbox = [];
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
            // Das Bauteil, das der Mensch zur Frage gewaehlt hat: Ziel, Beschriftung, Komponente bzw. Quelle. Sein Text ist nie eine Anweisung.
            ...(element === undefined ? {} : { element }),
            ...(mode === 'develop' ? { develop: { until: replay?.until ?? null, url: session.page().url(), source: checked.source } } : {}),
            runId,
            language: language(),
            target,
            source: checked.source,
            outcome: {
                status: verdict.status,
                ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
                ...(failed === null ? {} : { failed: { id: failed.id, reason: failed.reason } }),
                ...(failed?.diagnosis === undefined ? {} : { diagnosis: failed.diagnosis, evidence: failed.evidence }),
                failures: verdict.failures ?? [],
                warnings: verdict.warnings ?? [],
            },
            notes: draft.notes,
            // Aktionen und Pruefung nur vom gescheiterten Schritt: Sie erklaeren den Fehler, die uebrigen blaehen nur auf.
            steps: draft.steps.map((step) => ({
                ...planStep(step),
                ...(step.id !== failed?.id || step.recording === undefined ? {} : { actions: step.recording.actions.map(stepLabel), check: step.recording.check }),
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
                throw new CawError('advise-only', `Hier wird nur gelesen, ${String(command?.action)} geht nicht. Erlaubt: ${[...allowed].join(', ')}.`);
            }
            if (command.action === 'say') return chat.say(command.text);
            // Wartet auf den Menschen: neue Nachrichten oder das Ende, sobald er einen Knopf drueckt.
            if (command.action === 'chat') return closing && inbox.length === 0 ? { ended: true } : new Promise((resolve) => { waiting = resolve; deliver(); });
            if (command.action !== 'advise') return reader(command);
            if (submitted && !talking) throw new CawError('advise-only', 'Die Empfehlungen sind schon eingereicht.');
            const items = readAdvice(command.advice, result.spec, config, { root, diagnosis: failed?.diagnosis });
            submitted = true;
            try {
                return await review(items);
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
            // Erst der Hinweis auf Token; lehnt der Mensch ab, geht es ohne Claude weiter.
            if (!await tokensOk()) {
                // Sofort vorbei: Eine Nachricht gleich nach dem Abbrechen braucht eine neue Sitzung, mit neuer Frage.
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
                // Im Gespraech hat Claude das Ende eben erst erfahren: kurz Zeit lassen, die letzte Antwort abzuholen und sauber aufzuhoeren.
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
            /** Claude ist fertig, von sich aus oder weil der Lauf endete: Eine neue Nachricht braucht eine neue Sitzung. */
            over: () => over,
            send: (message, picked) => { inbox.push(picked === undefined ? message : { text: message, element: picked }); deliver(); },
            end: () => {
                closing = true;
                deliver();
                doneSignal();
                return finished;
            },
        };
    };
    const adviseRun = (options, found) => consult(options, found, { mode: 'advise' }).finished;

    /** Laedt die App mit dem aktuellen Code neu; der Zustand der Seite geht dabei meist verloren. */
    const reloadApp = async () => {
        const ready = await session.restart();
        return ready.settled ? t('run.reloaded') : t('run.reloadedUnsettled', { reason: ready.reason });
    };
    /**
     * Spielt die Schritte bis zum Zustand erneut ab, im selben Fenster mit dem aktuellen Code und einer neuen runTag: Was der Lauf
     * vorher angelegt hat, bleibt, ein neuer Datensatz kommt dazu.
     */
    const restoreState = async () => {
        if (replay === undefined) return t('run.restore.noRecording');
        // Wie ein frischer Lauf: alle Schritte offen, der Rabe huepft von S1 aus vorwaerts statt quer ueber alte Ergebnisse.
        await session.workbench?.mood?.('wait');
        // Die Schritte laufen neu, wie beim ersten Lauf: nicht mehr ausgegraut, schon waehrend sie laufen.
        await session.workbench?.left?.(false);
        for (const { id } of spec.expectations) await session.workbench?.step(id, 'waiting');
        await session.restart();
        agentHandler = newAgentHandler();
        const tag = newRunTag();
        const again = await playReplay({
            replay,
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
        const failed = failedStep({ ...again, expectations: spec.expectations, failures: [] });
        for (const { id } of spec.expectations) {
            const status = again.results?.get(id)?.status;
            await session.workbench?.step(id, id === failed?.id ? 'fail' : status === 'pass' ? 'pass' : 'skipped');
        }
        // Danach ist wieder der Mensch dran: Der Rabe fliegt zum Chat, beim Fehler bleibt er auf dem Schritt.
        await session.workbench?.mood?.(failed === null ? 'ask' : 'fail');
        return failed === null
            ? t('run.restore.done', { until: replay.until ?? t('run.restore.atEnd'), tag })
            : t('run.restore.failed', { id: failed.id, reason: failed.reason.replace(/\.$/, '') });
    };
    /** Das gewaehlte Element samt Seite und letzten Requests fuer die eigene Claude-Code-Session (Tool caw_selection). */
    const handToCode = (element) => {
        const recent = session.network === undefined ? [] : session.network.since(Math.max(0, session.network.mark() - 20));
        const selection = { at: new Date().toISOString(), runId, test: spec.id, target, until: replay?.until ?? null, url: session.page().url(), source: checked.source, element, requests: recent };
        writeFileSync(join(root, RUN_DIR, SELECTION_FILE), JSON.stringify(selection, null, 2));
        return selection;
    };

    /** Ende fuer alle Wege: Trace sichern, Urteil ausgeben, bei Bedarf das Fenster uebergeben. */
    const closeRun = async (ended, found = {}) => {
        await session.stopTrace();
        // Der Bericht steht schon: writeResult schreibt ihn mit dem Urteil.
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
        // Nur nach einem Testlauf, dessen gescheiterter Schritt noch nichts ausgefuehrt hat: Die Seite steht dann genau davor.
        const repairHere = replay !== undefined && played !== null && found.failed?.clean === true ? (options) => repairInPlace(options, found.failed) : undefined;
        if (chat !== null && alive) await Promise.race([conclude?.({ verdict, chat, ...found, flawed, advise, talk, repairHere }), session.closed, aborted]);
        const handing = handover?.({ verdict, ...found }) && alive;
        // Beim Entwickeln bleibt der Chat offen: Fragen an Claude, Element an Claude Code, Zustand neu herstellen.
        const developing = handing && develop !== undefined && chat !== null && chat.available();
        if (!developing && chat !== null && alive) {
            // Die Karte im Chat: kurz das Ergebnis, der Bericht, der Befehl fuer einen neuen Lauf.
            const results = verdict.results ?? [];
            const passed = results.filter((result) => result.status === 'pass').length;
            const text = results.length > 0 ? t('run.finished.steps', { passed, total: results.length }) : t(verdict.status === 'pass' ? 'run.finished.passed' : 'run.finished.failed');
            await chat.finished?.({ report: join(runDir, 'report.md'), shown: posix.join(relativeRun, 'report.md'), text, command: `caw-ai run ${spec.id}` });
        }
        if (!developing) chat?.human.closed();
        if (handing) {
            // Die Kopfzeile sagt, was jetzt gilt: Das Abspielen ist vorbei, der Mensch ist dran.
            let phase = t('run.phase.handedOver');
            if (developing) phase = replay?.until !== undefined && verdict.status === 'pass' ? t('run.phase.developIn', { until: replay.until }) : t('run.phase.develop');
            await session.workbench?.facts(factsOf(phase)).catch(() => {});
            if (replay?.until !== undefined && verdict.status === 'pass') {
                ui.success(t('run.handover.state', { until: replay.until, local: checked.source === 'watch' ? t('run.handover.local') : '' }));
            } else {
                ui.note(t('run.handover.window'));
            }
            if (developing) {
                const ask = (options, question, element) => consult(options, {}, { mode: 'develop', question, ...(element === undefined ? {} : { element }) });
                try {
                    const bench = session.workbench;
                    const left = t('run.develop.left', { until: replay?.until ?? t('run.develop.testEnd'), restore: t('run.button.restore') });
                    // Aktualisieren laedt die aktuelle Seite ohne Cache, wie F5 beim Entwickeln; die Schritte zeigen danach „verlassen“.
                    const refresh = async () => {
                        await session.reloadPage();
                        await bench?.left?.(true, left);
                        return '';
                    };
                    const onReload = (listener) => bench?.onReload?.(async ({ human = true } = {}) => {
                        if (!human) return;
                        await bench.left?.(true, left);
                        await listener();
                    });
                    await Promise.race([develop({ chat, talk: ask, until: replay?.until, refresh, restore: replay === undefined ? reloadApp : restoreState, onRefresh: (handler) => bench?.onRefresh?.(handler), onReload, toCode: handToCode }), session.closed, aborted]);
                } catch (error) {
                    ui.warn(t('run.develop.error', { message: String(error?.message ?? error).split(/\r?\n/)[0] }));
                } finally {
                    chat.human.closed();
                }
            } else {
                await Promise.race([session.closed, aborted]);
            }
        }
        process.removeListener('SIGINT', abortSignal);
        await session.close();
        return { exitCode, verdict, ...found };
    };
    const writeInterrupted = (ended) => {
        if (ended === 'browser-closed') writeResult({ status: 'error', code: 'browser-closed', reason: t('run.interrupted.browserClosed') });
        else writeResult({ status: 'error', code: 'aborted', reason: t('run.interrupted.aborted') });
    };

    /**
     * Claude arbeitet im Container: aufnehmen oder einen Schritt beheben. Beim Beheben im selben Browser laeuft das nach einem
     * Testlauf, der Browser steht dann schon vor dem Schritt.
     * @returns { ended, found } fuer closeRun
     */
    const claudeWork = async (box) => {
        verdict = null;
        // Fuer Claude: geheime Werte bleiben Platzhalter, die der Handler beim Ausfuehren fuellt (fillSecrets).
        const fillIn = (value) => fillDates(openRemembered().reduce((current, [placeholder, real]) => swapText(current, placeholder, real), fillRun(value, runTag)));
        if (repairing !== undefined) {
            const position = givenSpec.steps.indexOf(repairing);
            run.repair = {
                reason: repair.reason,
                // Der Schritt ist nicht gescheitert: Es gibt keinen Fehler zu suchen, nur neu aufzunehmen.
                ...(repair.rerecord ? { rerecord: true } : {}),
                actions: repairing.recording?.actions.map(stepLabel) ?? [],
                ...(repairing.recording === undefined ? {} : { check: fillIn(repairing.recording.check) }),
                remembered: [...remembered].map(([placeholder, value]) => ({ name: placeholder.slice(2, -2), ...(isSecret(value) ? { secret: true, value: placeholder } : { value }) })),
                before: givenSpec.steps.slice(0, position).map(({ id, name }) => ({ id, name })),
                after: givenSpec.steps.slice(position + 1).map(({ id, name, expect }) => ({ id, name, expect })),
                // Die Einordnung des Testlaufs: Claude prueft sie zuerst, bevor es den Schritt anpasst.
                ...(repair.diagnosis === undefined ? {} : { diagnosis: repair.diagnosis, evidence: repair.evidence }),
                ...(repairing.recording?.network === undefined ? {} : { recordedNetwork: repairing.recording.network }),
            };
        }

        let repairReviewer = null;
        const budget = withStepBudget(agentHandler, maxSteps ?? Number.POSITIVE_INFINITY);
        let recorder = null;
        let plan = null;
        /** Der Plan ist die spaetere Testdatei. Erst die Freigabe des Menschen macht ihn zum Massstab des Laufs. */
        const proposePlan = async ({ text }) => {
            if (typeof text !== 'string' || text.trim() === '') throw new CawError('plan-invalid', 'Der Plan ist leer.');
            const { problems, plan: parsed } = readPlan(text);
            if (problems.length > 0) throw new CawError('plan-invalid', problems.join(' '));
            if (repairing !== undefined && (parsed.steps.length !== 1 || parsed.steps[0].id !== repair.id)) {
                throw new CawError('plan-invalid', `Beim Beheben enthält der Plan genau den Schritt ${repair.id}.`);
            }
            // Ein von Hand gesetztes retry ueberlebt das Beheben, auch wenn Claude es nicht wiederholt.
            const steps = repairing?.retry === undefined ? parsed.steps : parsed.steps.map((step) => ({ retry: repairing.retry, ...step }));
            const retryIssues = retryProblems(repairing === undefined ? steps : replaceStep(givenSpec, steps[0]).steps);
            if (retryIssues.length > 0) throw new CawError('plan-invalid', retryIssues.join(' '));
            const composed = repairing === undefined ? composeTest(givenSpec, parsed) : { ...spec, steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })) };
            // Gleicher Plan wie in der Testdatei: Den hat der Mensch schon uebernommen, es gibt nichts freizugeben. Er kann trotzdem schreiben.
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
                note: `Die Prüfungen von ${redo.join(', ')} gelten nicht mehr, weil sich der Plan ab dort geändert hat. Führe den Weg so, dass du diese Schritte erneut prüfst, und streiche überholte Aktionen mit omit.`,
            };
        };
        /** Das Urteil gilt dem freigegebenen Plan, und jeder bestandene Schritt muss darin vorkommen. */
        const checkAgainstPlan = (results) => {
            // Liegt es an der Anwendung, meldet Claude beim Beheben nur fail: Das aendert nichts am Test und braucht keinen Plan.
            const onlyFail = Array.isArray(results.expectations) && results.expectations.length > 0 && results.expectations.every(({ status }) => status === 'fail');
            if (plan === null && repairing !== undefined && onlyFail) return;
            if (plan === null) throw new CawError('plan-required', `Es gibt noch keinen freigegebenen Plan. Lege ihn mit caw-ai plan --file <${PLAN_FILE}> vor.`);
            const known = new Set(spec.expectations.map(({ id }) => id));
            const { groups } = groupSteps(recorder.steps);
            const failed = new Set((results.expectations ?? []).filter(({ status }) => status === 'fail').map(({ id }) => id));
            // Ein Schritt, der als fail eingereicht wird, kann kein bestandenes check haben: Auch das ist ein Ergebnis.
            const missing = [...known].filter((id) => !groups.has(id) && !failed.has(id));
            if (missing.length > 0) throw new CawError('finish-rejected', `Ohne bestandenes check: ${missing.join(', ')}.`);
            if (repairing === undefined || failed.size > 0) return;
            const same = plan.steps[0].expect === repairing.expect;
            if (same && repairing.recording !== undefined && groups.get(repair.id).check !== repairing.recording.check) {
                throw new CawError('finish-rejected', `Das erwartete Ergebnis von ${repair.id} ist unverändert, also muss auch die Prüfung gleich bleiben: ${fillIn(repairing.recording.check)}. Soll sie sich ändern, lege einen Plan mit geändertem expect vor.`);
            }
            const lost = missingRemembered(replaceStep(givenSpec, { ...plan.steps[0], recording: { actions: groups.get(repair.id).actions, check: groups.get(repair.id).check } }));
            if (lost.length > 0) throw new CawError('finish-rejected', lost.join(' '));
        };
        /** Aktionen seit der letzten Pruefung gehoeren zum naechsten Schritt. Deshalb muss die Reihenfolge stimmen. */
        const checkOrder = ({ id }) => {
            const ids = spec.expectations.map((expectation) => expectation.id);
            if (!ids.includes(id)) throw new CawError('step-unknown', `${id} steht nicht im Plan. Lege eine neue Fassung vor, wenn der Schritt dazugehört.`);
            const passed = recorder.steps.filter(({ action }) => action === 'check').map((step) => step.id);
            const open = ids.find((candidate) => !passed.includes(candidate));
            if (id !== open && id !== passed.at(-1)) throw new CawError('step-order', `Als Nächstes ist ${open} an der Reihe, nicht ${id}. Alle Aktionen seit der letzten Prüfung gehören zum nächsten Schritt.`);
        };
        const handler = async (command) => {
            if (command?.action === 'finish' && command.results?.status !== 'error') checkAgainstPlan(command.results ?? {});
            return budget.handler(command);
        };
        recorder = createRecorder({ handler, session, base: checked.url, authMarker: authOf(config).signedInSelector, runTag, remembered });
        /** Der Mensch zeigt im selben Browser, was Claude nicht findet. Das Budget zaehlt nur Claudes eigene Schritte. */
        const askOperator = async ({ question }) => {
            ui.heading(t('run.ask.heading', { question: String(question ?? '').slice(0, 500) }));
            ui.note(t('run.ask.show'));
            chat.ask(question);
            return captureHuman('asking');
        };
        /** Was der Mensch jetzt im Browser tut, kommt in den Test, und Claude bekommt es als Antwort. */
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
        /** Erst jetzt wartet Claude wirklich: Vorher waeren seine eigenen Klicks mitgeschnitten worden. */
        const readChat = async () => {
            const messages = chat.takeUnread();
            return chat.paused() ? { messages, ...await captureHuman('paused') } : { messages };
        };
        /** Umwege fallen erst weg, wenn das Urteil angenommen ist: Ein abgelehntes finish darf Claude wiederholen. */
        const finishAndDrop = async (command) => {
            // Ohne diesen Zwang bleiben Fehlklicks im Test: Nur ein bestandener Lauf wird zur Aufzeichnung.
            const items = command.results?.expectations;
            const allPassed = Array.isArray(items) && items.every(({ status }) => status === 'pass');
            if (allPassed && command.results.omit === undefined) {
                throw new CawError('finish-rejected', `Prüfe die Aktionen auf Fehlklicks und Umwege und nenne sie mit "omit", auch wenn es keine gibt ("omit": []):\n${recorder.list().join('\n')}`);
            }
            const omitted = dropNumbers(recorder.steps, command.results?.omit);
            const dropped = [...omitted, ...tidyNumbers(recorder.steps, omitted)];
            if (allPassed) {
                const trailing = trailingNumbers(recorder.steps, dropped);
                const stray = trailing.filter((number) => recorder.steps[number - 1].action !== 'wait-ready');
                if (stray.length > 0) throw new CawError('finish-rejected', `Nach der letzten Prüfung stehen noch Aktionen (${stray.join(', ')}). Streiche sie mit "omit" oder prüfe den Schritt danach erneut.`);
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
            if (plan === null && NEEDS_PLAN.has(command?.action)) throw new CawError('plan-required', `Lege zuerst den Ablaufplan vor: caw-ai plan --file <${PLAN_FILE}>. Lesen geht auch ohne, zum Beispiel snapshot und eval.`);
            if (command?.action === 'check') checkOrder(command);
            if (command?.action === 'ask-operator') return askOperator(command);
            if (command?.action === 'recording') return recorder.list();
            if (command?.action === 'finish') return finishAndDrop(command);
            // Beim Beheben darf Claude eine Ursache in der Anwendung als Empfehlung vorlegen, statt den Test anzupassen.
            if (command?.action === 'advise' && repairing !== undefined) {
                repairReviewer ??= createReviewer(givenSpec);
                return repairReviewer.review(readAdvice(command.advice, repairReviewer.result.spec, config, { root, diagnosis: repair.diagnosis }));
            }
            return recorder.handler(command);
        };
        const stopPump = startPump(channelHandler);
        // Lehnt der Mensch den Hinweis auf Token ab, ist der Lauf abgebrochen, bevor Claude startet.
        const willing = await tokensOk();
        if (!willing) abortSignal();
        const agent = willing ? startAgent(box, containerCommand ?? ['caw-ai', 'sandbox-run', '--run-id', runId, '--timeout', String(timeoutMin)], CLAUDE_LOG) : IDLE_AGENT;
        // Auch bei einem unerwarteten Fehler: Claude und sein Container laufen sonst weiter, bis ihr Zeitlimit greift.
        try {
            if (willing) ui.info(t('run.agentWorking'));
            const ended = await Promise.race([
                verdictGiven.then(() => 'verdict'),
                agent.ended,
                session.closed.then(() => 'browser-closed'),
                aborted.then(() => 'aborted'),
            ]);
            agent.stopTail();
            // Mit dem Urteil ist der Lauf fertig. Auf Claudes Schlusszusammenfassung wartet niemand.
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

        const built = buildReplay({ recorder, outcome: verdict, spec, target, ...(repairing === undefined ? {} : { draft: givenSpec }), ...(creating && previous !== undefined ? { previous } : {}) });
        let { candidate } = built;
        // Als lesend angelegt, aber geschrieben: Dann ist der Test schreibend, sonst liefe er auf Umgebungen ohne writable.
        const written = verdict?.writes ?? [];
        if (candidate !== undefined && !candidate.mutates && written.length > 0) {
            candidate = { ...candidate, mutates: true };
            ui.warn(t('run.mutates', { id: spec.id, labels: written.map(({ label }) => label).join(', ') }));
        }
        if (candidate === undefined) {
            ui.warn(t('run.noRecording', { problems: built.problems.join(' ') }));
            // Ein Lauf, der keine Aufzeichnung ergibt, hat sein Ziel verfehlt, auch wenn alle Punkte stimmen.
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
     * Behebt den gescheiterten Schritt dort, wo der Testlauf stehen geblieben ist: ohne Vorlauf, mit den Werten, die das
     * Abspielen gelesen hat. Der Bericht des Testlaufs bleibt als `report-testlauf.md`.
     * @returns { verdict, exitCode, candidate, fresh, expectChange } des Behebens
     */
    const repairInPlace = async ({ sandbox: box, reason }, failed) => {
        const before = verdict;
        if (existsSync(join(runDir, 'report.md'))) copyFileSync(join(runDir, 'report.md'), join(runDir, 'report-testlauf.md'));
        repair = { id: failed.id, reason, ...(failed.diagnosis === undefined ? {} : { diagnosis: failed.diagnosis, evidence: failed.evidence }) };
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
        ui.verdict(verdict, { report: posix.join(relativeRun, 'report.md'), elapsed: (Date.now() - startedAt) / 1000 });
        verdict = before;
        return repaired;
    };

    if (replay !== undefined) {
        ui.info(t('run.replaying', { count: replay.steps.length, on: replay.recordedOn }));
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
            // Das Terminal setzt die Gesamtzahl selbst dazu, der Chat bekommt sie fertig.
            log: (entry) => {
                const { position, number, owner, label } = entry;
                ui.step({ number: position, total: replay.steps.length, label, elapsed: (Date.now() - started) / 1000 });
                chat?.progress(`${owner} · ${number} ${label}`);
                showAction(entry);
            },
        });
        const ended = await Promise.race([
            play.then((played) => played),
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
            // Test, Anwendung oder Umgebung: Belege aus dem Browser und der Vergleich mit der Aufnahme des Schritts.
            const requests = ended.requests?.get(failed.id) ?? [];
            const baseline = givenSpec.steps.find(({ id }) => id === failed.id)?.recording?.network;
            // Ein Abbruch spaeter im Lauf sagt nichts ueber diesen Schritt: Seine Pruefung ist gescheitert, seine Aktionen sind gelaufen.
            const broken = ended.broken?.step === failed.id ? ended.broken : null;
            // Die erste abweichende Wirkung, im Schritt selbst oder davor: Dort hat sich die Anwendung zuerst anders verhalten.
            const upTo = givenSpec.steps.slice(0, givenSpec.steps.findIndex(({ id }) => id === failed.id) + 1).map(({ id }) => id);
            const deviation = ended.deviations?.get(failed.id) ?? upTo.map((id) => ended.deviations?.get(id)).find((found) => found !== undefined) ?? null;
            // Der Schritt davor: Seine Pruefung kann bestanden haben, obwohl dort schon etwas abgelehnt wurde.
            const previous = upTo.at(-2);
            const earlier = previous === undefined ? null : { id: previous, requests: ended.requests?.get(previous) ?? [] };
            // Geschwaerzt wie das Urteil: Meldungen der Seite und Belege koennen geheim gemerkte Werte enthalten, und beides geht in den
            // Bericht und beim Beheben an Claude.
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
        // Bereinigt wird nur aus einem ganz gesunden Lauf: Scheitert spaeter etwas, kann die Abweichung davor der erste Hinweis sein.
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

    // Beheben beginnt vor dem Schritt: Ein halb ausgefuehrter Schritt ergaebe eine unvollstaendige Aufzeichnung.
    if (repair !== undefined) {
        const before = replayBefore(givenSpec, repair.id);
        if (before.steps.length > 0) {
            chat.preparing();
            const expectations = givenSpec.expectations.filter(({ id }) => before.steps.some((step) => step.action === 'check' && step.id === id));
            const started = Date.now();
            const ended = await Promise.race([
                playReplay({
                    replay: before,
                    // Eigener Handler: Dessen Punkte sind die Schritte davor, nicht der eine, den Claude behebt.
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
