// The flows around a step. What Claude achieved must also run without Claude, and only then does the human decide in the
// chat whether it replaces the test plan. If a step fails, the human clarifies it in the chat and can have it fixed.

import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE } from '../shared/names.mjs';
import { cutReplay, positionalActions, replayOf, replayUpToStale, withBaselines, withEffects, withoutEffects } from './replay.mjs';
import { LEARN_RUNS, isEffectCause } from './effects.mjs';
import { staleSteps } from './test-file.mjs';

// Labels as getters: the language is not settled at import time. Copies via spread are only made at runtime.
const button = (id, key, extra = {}) => ({ id, get label() { return t(key); }, ...extra });
const ADOPT = { id: 'adopt', primary: true };
/** The button states how many steps the test plan will then have. */
const adoptButton = (count, extra = {}) => ({ ...ADOPT, label: t('run.button.adopt', { count }), ...extra });
// Discarding cannot be undone: it needs a second click, like Cancel in the chat header.
const DISCARD = { id: 'discard', get label() { return t('run.button.discardDraft'); }, get confirm() { return t('run.button.discardSure'); } };
const FIX = button('fix', 'run.button.fix', { primary: true });
const RERECORD = button('fix', 'run.button.rerecord', { primary: true });
const RERUN = button('rerun', 'run.button.rerun', { primary: true });
// Ends regularly with the result of the run. Cancel in the chat header ends immediately, as an error without a result.
const CLOSE = button('close', 'run.button.close');
const ASK = button('ask', 'run.button.ask', { primary: true });
// Only the effects deviate, the check is met: forget the learned effects, without Claude and without tokens.
const FORGET_EFFECT = button('forget-effect', 'run.button.forgetEffect');
// Only script errors, e.g. from third-party code: add them to consoleIgnore and re-check right away, without Claude and tokens.
const IGNORE_ERRORS = button('ignore-errors', 'run.button.ignoreErrors', { primary: true });
const ONLY_CLOSE = button('close', 'run.button.onlyClose', { primary: true });
// After the handover, while developing in the prepared state.
const RESTORE = button('restore', 'run.button.restore', { primary: true });
const END_DEVELOP = button('end', 'run.button.endDevelop');

const withoutDot = (text) => text.replace(/\.$/, '');

/** Added baselines in one sentence for the chat. */
const baselineText = (baselines) => t('run.flow.baselines', { ids: [...baselines.keys()].join(', ') });

/** Why a run did not pass, in one sentence for the chat. */
const failureText = (verdict) => {
    const failed = (verdict?.results ?? []).find(({ status }) => status === 'fail');
    return withoutDot(verdict?.reason ?? failed?.note ?? verdict?.failures?.[0]?.text ?? (failed === undefined ? t('run.flow.seeReport') : t('run.flow.notMet', { id: failed.id })));
};

const hardFailures = (verdict) => (verdict?.failures ?? []).map(({ type, text, at }) => `${type}: ${withoutDot(text)}${at === undefined ? '' : t('run.flow.at', { at })}`);
const LISTED = 3;
const listed = (texts) => (texts.length <= LISTED ? texts.join('; ') : t('run.flow.andMore', { shown: texts.slice(0, LISTED).join('; '), count: texts.length - LISTED }));

/** Hard failures and warnings in one sentence: without Claude this is all the human sees of them in the chat. */
const findingsText = (verdict) => [
    ...(hardFailures(verdict).length === 0 ? [] : [t('run.flow.hardFailures', { list: listed(hardFailures(verdict)) })]),
    ...((verdict?.warnings ?? []).length === 0 ? [] : [t('run.flow.warnings', { list: listed(verdict.warnings.map(({ text, origin }) => `${withoutDot(text)}${origin === undefined ? '' : ` (${origin})`}`)) })]),
].join('');

/** The chat also names changed files: app code is checked by lint and a new run; nothing is ever committed. */
const noticeFiles = (files, chat) => {
    if (files.length === 0) return;
    const code = appFilesOf(files).length > 0 ? t('run.flow.checkChange') : '';
    chat.notice?.(t('run.flow.changedFiles', { files: files.join(', '), code }));
};

/** The changed files of the app, without the caw-ai config and project context. */
const appFilesOf = (files) => files.filter((file) => file !== CONFIG_FILE && file !== CONTEXT_FILE);

/** What a fix produced, as the check run and the decision need it. */
const changeOf = ({ id, reason, rerecord, fresh, expectChange }) => ({ id, reason, fresh: fresh ?? [], ...(rerecord ? { rerecord } : {}), ...(expectChange === undefined ? {} : { expectChange }) });

/**
 * A step fixed in the same browser is built from the test as it was at the start of the run. What the human has adopted
 * from advice since then still applies to the other steps.
 */
const carry = (candidate, current, repairedId) => {
    const steps = candidate.steps.map((step) => (step.id === repairedId ? step : current.steps.find(({ id }) => id === step.id) ?? step));
    return { ...candidate, notes: current.notes, steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })) };
};

/** The human decides whether Claude starts: until then neither Docker nor tokens run, and the offer stays in the open chat. */
const createFixer = ({ sandbox, openSandbox }) => {
    let box = sandbox;
        /** @returns the sandbox or null if it is unavailable right now; `say` reports that */
    const open = async (chat, say) => {
        if (box !== undefined && box !== null) return box;
        try {
            chat.progress(t('run.flow.preparingSandbox'));
            box = await openSandbox();
            return box;
        } catch (error) {
            if (!(error instanceof CawError)) throw error;
            await say(withoutDot(error.message));
            return null;
        }
    };
    const cannotFix = (chat) => (message) => chat.choose('deciding', t('run.flow.cannotFix', { message }), [ONLY_CLOSE]);
    return {
        sandbox: () => box,
        open,
        /** A step whose plan changed through advice needs a new recording. @returns the step or null */
        offerChanged: async ({ id, title }, chat) => {
            const choice = await chat.choose('deciding', t('run.flow.offerChanged', { id, title: withoutDot(title) }), [RERECORD, CLOSE]);
            if (choice !== RERECORD.id) return null;
            return await open(chat, cannotFix(chat)) === null ? null : { id, reason: t('run.flow.planChanged', { title: withoutDot(title) }), rerecord: true };
        },
        /**
         * Claude advises on its own if the run had failures or warnings.
         * @returns the result of advise or null
         */
        advise: async ({ flawed, advise, chat }, spec) => {
            if (!flawed) return null;
            const ready = await open(chat, (message) => { chat.progress(t('run.flow.cannotAdvise', { message })); });
            return ready === null ? null : advise({ sandbox: ready, spec });
        },
        /**
         * A step failed: the human can ask Claude, in the failure state, and have it fixed. Only their message or
         * click starts Claude.
         * @param spec the test that advice in the conversation refers to
         * @param canAsk the "ask Claude for the cause" button: Claude advises as with --advise, only on click
         * @returns { advice, target, repaired, ask, forget }: `advice` from the conversation or null; `forget`: forget the learned effects of this step; `target` is fixed with a warm-up; `repaired`
         *          is already fixed in the same browser; `ask`: Claude should find the cause and advise
         */
        settle: async ({ failed, chat, verdict, talk, repairHere, ignore, cleared }, spec, { canAsk = false, repeated = false } = {}) => {
            const { diagnosis } = failed;
            const app = diagnosis?.side === 'app';
            let hint = failed.suspect ? t('run.flow.suspect') : '';
            if (diagnosis !== undefined) {
                const warn = app ? ` ${t('run.flow.hideWarn')}` : '';
                hint = ` ${diagnosis.text} ${diagnosis.findings.join(' ')}${warn}`;
            }
            const where = t(repairHere === undefined ? 'run.flow.whereFresh' : 'run.flow.whereHere');
            // The status line below says that Claude can be asked.
            // Same failure after a fix: fixing the same step again changes nothing, the cause lies elsewhere.
            const again = repeated ? t('run.flow.again', { config: CONFIG_FILE }) : '';
            let question = `${t('run.flow.failed', { id: failed.id, reason: withoutDot(failed.reason) })}${hint}${findingsText(verdict)}${again}${where}`;
            // The same as a card: step, reason and assessment on top, findings collapsible, the next step at the bottom.
            const card = {
                id: failed.id,
                reason: withoutDot(failed.reason),
                ...(diagnosis === undefined ? {} : { diagnosis: { side: diagnosis.side, strength: diagnosis.strength, text: diagnosis.text, findings: diagnosis.findings } }),
                ...(diagnosis === undefined && failed.suspect ? { suspect: true } : {}),
                ...(app ? { warn: t('run.flow.hideWarn') } : {}),
                failures: hardFailures(verdict),
                warnings: (verdict?.warnings ?? []).map(({ text, origin }) => `${withoutDot(text)}${origin === undefined ? '' : ` (${origin})`}`),
                ...(repeated ? { warn: again.trim() } : {}),
                next: where.trim(),
            };
            // If everything points to the app, the cause in the code is the obvious path; fixing stays possible, the human decides.
            const secondary = (option) => ({ ...option, primary: false });
            let options = canAsk
                ? (app ? [ASK, secondary(FIX), CLOSE] : [FIX, secondary(ASK), CLOSE])
                : (app ? [secondary(FIX), CLOSE] : [FIX, CLOSE]);
            if (repeated) options = canAsk ? [ASK, secondary(FIX), CLOSE] : [{ ...CLOSE, primary: true }, secondary(FIX)];
            const effectOnly = isEffectCause(failed.reason);
            if (effectOnly) options = [secondary(FORGET_EFFECT), ...options];
            // Only script errors: Ignore comes first, fixing via Claude stays possible.
            if (ignore !== undefined) options = [IGNORE_ERRORS, ...options.map(secondary)];
            /** The config now allows all hard failures: a check run without Claude is enough, no fix. */
            const recheck = async (advice) => {
                chat.notice(t('run.flow.ignoredRecheck'));
                return { advice, target: null, recheck: true };
            };
            let talker = null;
            for (;;) {
                // If the human adopts a config change in the conversation that allows all failures, it continues without another click.
                const changed = talker === null || talker.over() || talker.configChanged === undefined ? null : talker.configChanged().then(() => ({ configChanged: true }));
                const answer = await Promise.race([chat.discuss(question, options, question === undefined ? undefined : card), ...(changed === null ? [] : [changed])]);
                question = undefined;
                if (answer?.configChanged === true) {
                    if (cleared?.() === true) return recheck(await talker.end());
                    continue;
                }
                if (answer?.message !== undefined) {
                    if (talk === undefined) continue;
                    if (talker !== null && !talker.over()) {
                        talker.send(answer.message, answer.element);
                        continue;
                    }
                    const ready = await open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                    if (ready !== null) talker = talk({ sandbox: ready, spec }, answer.message, answer.element);
                    continue;
                }
                const advice = talker === null ? null : await talker.end();
                if (answer?.choice === IGNORE_ERRORS.id) {
                    const added = ignore();
                    if (added.length > 0) chat.notice(t('run.flow.ignoredErrors', { patterns: added.join(', '), config: CONFIG_FILE }));
                    return recheck(advice);
                }
                if (answer?.choice === FORGET_EFFECT.id) return { advice, target: null, forget: failed.id };
                if (answer?.choice === ASK.id) return { advice, target: null, ask: true };
                if (answer?.choice !== FIX.id) return { advice, target: null };
                if (await open(chat, cannotFix(chat)) === null) return { advice, target: null };
                // Fixing starts a new Claude: it gets the conversation and the hard failures, so that agreements hold.
                const agreed = talker?.log?.() ?? [];
                const failures = verdict?.failures ?? [];
                const context = { ...(agreed.length === 0 ? {} : { agreed }), ...(failures.length === 0 ? {} : { failures }) };
                if (repairHere === undefined) return { advice, target: { ...failed, ...context } };
                const repaired = await repairHere({ sandbox: box, reason: failed.reason, ...context });
                if (repaired.candidate === undefined) {
                    await chat.choose('deciding', t('run.flow.noNewRecording', { id: failed.id, reason: failureText(repaired.verdict) }), [ONLY_CLOSE]);
                }
                return { advice: advice ?? repaired.repairAdvice ?? null, target: null, repaired: { ...repaired, id: failed.id, reason: failed.reason } };
            }
        },
    };
};

/** What happens after forgetting the learned effects, in one sentence. */
const forgottenText = (id) => t('run.flow.forgotten', { id, runs: LEARN_RUNS });

/** What adopting writes into the test file, in one sentence. */
const adoptedText = (current, changes, whole) => {
    if (whole) return t('run.flow.adoptWhole', { count: current.steps.length });
    if (changes.length === 0) return '';
    return t('run.flow.adoptChanges', { list: changes.map(({ id, reason, rerecord }) => t(rerecord ? 'run.flow.adoptRerecorded' : 'run.flow.adoptFixed', { id, reason: withoutDot(reason) })).join('; ') });
};

const decisionText = (current, changes, seen, warnings = [], { fresh = [], whole = false } = {}) => [
    t('run.flow.checkPassed'),
    ...(adoptedText(current, changes, whole) === '' ? [] : [adoptedText(current, changes, whole)]),
    ...(warnings.length === 0 ? [] : [t('run.flow.decisionWarnings', { list: warnings.map(({ text }) => withoutDot(text)).join('; ') })]),
    ...(seen.length === 0 ? [] : [t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') })]),
    ...(() => {
        const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
        return known.length === 0 ? [] : [t('run.flow.decisionKnown', { list: known.join('; ') })];
    })(),
    ...(() => {
        const positional = positionalActions(current, whole ? undefined : new Set(changes.map(({ id }) => id)));
        return positional.length === 0 ? [] : [t('run.flow.decisionPositional', { list: positional.join(', ') })];
    })(),
    ...changes.flatMap(({ expectChange }) => (expectChange === undefined ? [] : [t('run.flow.decisionExpect', { id: expectChange.id, after: expectChange.after, before: expectChange.before })])),
    ...(staleSteps(current).length === 0 ? [] : [t('run.flow.decisionStale', { ids: staleSteps(current).map(({ id }) => id).join(', ') })]),
    t('run.flow.decisionQuestion'),
].join(' ');

/**
 * The same decision as a card: on top what would be adopted and what the human needs to know first, one point each;
 * warnings, known messages and actions chosen by position collapsible.
 */
const decisionCard = (current, changes, seen, warnings = [], { fresh = [], whole = false } = {}) => {
    const adopted = adoptedText(current, changes, whole);
    const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
    const stale = staleSteps(current);
    return {
        title: t('run.flow.decisionTitle'),
        facts: [
            ...(adopted === '' ? [] : [adopted]),
            ...changes.flatMap(({ expectChange }) => (expectChange === undefined ? [] : [t('run.flow.decisionExpect', { id: expectChange.id, after: expectChange.after, before: expectChange.before })])),
            ...(stale.length === 0 ? [] : [t('run.flow.decisionStale', { ids: stale.map(({ id }) => id).join(', ') })]),
        ],
        ...(seen.length === 0 ? {} : { warn: t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') }) }),
        details: [
            { title: t('run.flow.decisionWarningsTitle'), items: warnings.map(({ text }) => withoutDot(text)) },
            { title: t('run.flow.decisionKnownTitle'), items: known },
            { title: t('run.flow.decisionPositionalTitle'), items: positionalActions(current, whole ? undefined : new Set(changes.map(({ id }) => id))) },
        ].filter(({ items }) => items.length > 0),
        question: t('run.flow.decisionQuestion'),
    };
};

const changeNote = (changes) => {
    if (changes.length === 0) return undefined;
    return changes.map(({ id, reason, rerecord, expectChange }) => `${t(rerecord ? 'run.flow.noteRerecorded' : 'run.flow.noteFixed', { id, reason: withoutDot(reason) })}${expectChange === undefined ? '' : t('run.flow.noteBefore', { before: expectChange.before })}`).join(' ');
};

/**
 * Fixes a step and checks the whole test without Claude until it passes or the human stops. If another step fails on the
 * way, the human clarifies it in the chat. Only what was really fixed changes in the file.
 * @param draft        the test, in memory: the file or a recording not adopted yet
 * @param target       { id, reason }; null checks first
 * @param changes      steps already fixed, e.g. in the same browser after a test run
 * @param whole        the whole plan is new and is adopted as a whole
 * @param discardCode  exit code on discard, otherwise that of the check run
 * @param fresh        for a whole recording: messages that newly count as known
 * @param seenFailures hard failures from the previous recording, the human sees them before deciding
 * @param execute      a single run
 * @param adopt        (test, changed steps or undefined for all, { withNotes }) writes the file and returns its name
 * @param advising     Claude advises on its own on failures and warnings; after a recording only once a step gets fixed
 * @param log          message in the terminal
 */
export const fixFlow = async ({ draft, target = null, changes: done = [], whole = false, fresh = [], discardCode, seenFailures = [], sandbox, openSandbox, execute, adopt, log, advising: advisingFirst = true }) => {
    const fixer = createFixer({ sandbox, openSandbox });
    const changes = [...done];
    const seen = [...seenFailures];
    // What the human adopts from advice only takes effect with the test plan: until then it lives only in the draft.
    const advised = new Set();
    let advisedNotes = false;
    let advising = advisingFirst || changes.length > 0;
    let current = draft;
    let next = target;
    /** Advice into the draft. @returns the step that advice made stale, if the human wants to fix it */
    const absorb = async (result, chat, { offer = true } = {}) => {
        if (result === null) return null;
        current = result.spec;
        result.touched.forEach((id) => advised.add(id));
        advisedNotes ||= result.notes;
        for (const file of result.files) log(t('run.flow.adviceAdopted', { file }));
        noticeFiles(result.files, chat);
        return offer && result.stale.length > 0 ? fixer.offerChanged(result.stale[0], chat) : null;
    };
    const takeAdvice = async (concluded) => (advising ? absorb(await fixer.advise(concluded, current), concluded.chat) : null);
    // Which step was already fixed with exactly this reason: if the same failure comes back, the chat says so.
    const fixedBefore = new Set();
    /** If a step fails, the human clarifies it. @returns { next, repaired } */
    const settle = async (concluded) => {
        const key = `${concluded.failed.id} ${concluded.failed.reason}`;
        const settled = await fixer.settle(concluded, current, { repeated: fixedBefore.has(key) });
        if (settled.forget !== undefined) {
            current = withoutEffects(current, settled.forget);
            advised.add(settled.forget);
            concluded.chat.notice(forgottenText(settled.forget));
        }
        if (settled.target !== null || settled.repaired !== undefined) fixedBefore.add(key);
        const changed = await absorb(settled.advice, concluded.chat, { offer: settled.target === null && settled.repaired === undefined && settled.recheck !== true });
        // The failures are allowed now: no fix, just a new check run.
        if (settled.recheck === true) return { next: null, repaired: null, recheck: true };
        return { next: settled.target ?? changed, repaired: settled.repaired?.candidate === undefined ? null : settled.repaired };
    };
    const lostAdvice = () => {
        if (advised.size > 0 || advisedNotes) log(t('run.flow.adviceLost'));
    };
    for (;;) {
        if (next !== null) {
            const { id, reason, rerecord, diagnosis, evidence, agreed, failures } = next;
            advising = true;
            let offered = null;
            let rechecking = false;
            const repaired = await execute({
                sandbox: fixer.sandbox(),
                spec: current,
                repair: { id, reason, ...(rerecord ? { rerecord } : {}), ...(diagnosis === undefined ? {} : { diagnosis, evidence }), ...(agreed === undefined ? {} : { agreed }), ...(failures === undefined ? {} : { failures }) },
                conclude: async (concluded) => {
                    const { verdict, candidate, failed, chat, repairAdvice } = concluded;
                    // Next, a run without Claude checks, in a new window.
                    if (candidate !== undefined) return { next: 'check' };
                    // If Claude already advised while fixing, e.g. a change to the app, it does not start again for that.
                    offered = repairAdvice === undefined ? await takeAdvice(concluded) : await absorb(repairAdvice, chat);
                    if (offered !== null) return { next: 'claude' };
                    if (failed) ({ next: offered, recheck: rechecking = false } = await settle(concluded));
                    else await chat.choose('deciding', t('run.flow.noNewRecording', { id, reason: failureText(verdict) }), [ONLY_CLOSE]);
                    if (rechecking) return { next: 'check' };
                    return offered === null ? undefined : { next: 'claude' };
                },
            });
            next = offered;
            if (next !== null) continue;
            if (repaired.candidate !== undefined) {
                current = repaired.candidate;
                seen.push(...hardFailures(repaired.verdict));
                changes.push(changeOf({ id, reason, rerecord, ...repaired }));
            } else if (!rechecking) {
                lostAdvice();
                return repaired.exitCode;
            }
            // Otherwise the fix only failed on errors that are allowed now: the check run shows whether the test passes like this.
        }

        let choice = null;
        let offered = null;
        let repairedHere = null;
        let rechecking = false;
        // The written test file: it is adopted right after the choice so the chat can still name it.
        let saved = null;
        const played = await execute({
            spec: current,
            replay: replayUpToStale(current),
            note: changeNote(changes),
            conclude: async (concluded) => {
                const { verdict, failed, chat } = concluded;
                offered = await takeAdvice(concluded);
                if (offered !== null) return { next: 'claude' };
                if (verdict.status === 'pass') {
                    // If a step is still stale after the check run, e.g. the second of two adjusted ones, it comes next.
                    const [stale] = staleSteps(current);
                    const again = stale === undefined ? null : { id: 'rerecord-next', label: t('run.button.rerecordStep', { id: stale.id }), primary: true };
                    const count = current.steps.length;
                    const options = again === null ? [adoptButton(count), DISCARD] : [again, adoptButton(count, { primary: false }), DISCARD];
                    choice = await chat.choose('deciding', decisionText(current, changes, seen, verdict.warnings, { fresh, whole }), options, decisionCard(current, changes, seen, verdict.warnings, { fresh, whole }));
                    if (choice === 'rerecord-next' && await fixer.open(chat, (message) => chat.choose('deciding', t('run.flow.cannotFix', { message }), [ONLY_CLOSE])) !== null) {
                        offered = { id: stale.id, reason: t('run.flow.stillStale'), rerecord: true };
                        return { next: 'claude' };
                    }
                    if (choice === ADOPT.id) {
                        const only = whole ? undefined : new Set([...changes.map(({ id }) => id), ...advised]);
                        saved = adopt(current, only, { withNotes: advisedNotes });
                        return { outcome: t('run.flow.saved', { file: saved }) };
                    }
                    return { outcome: t('run.flow.discarded') };
                }
                if (failed) {
                    ({ next: offered, repaired: repairedHere, recheck: rechecking = false } = await settle(concluded));
                    if (rechecking) return { next: 'check' };
                    if (offered !== null) return { next: 'claude' };
                    return repairedHere === null ? undefined : { next: 'check' };
                }
                // All steps passed, but hard failures: if they are only script errors, they can be ignored and the run repeated.
                const ignorable = concluded.ignore !== undefined;
                const answer = await chat.choose('deciding', t('run.flow.checkFailed', { reason: failureText(verdict), findings: findingsText(verdict) }),
                    ignorable ? [IGNORE_ERRORS, { ...ONLY_CLOSE, primary: false }] : [ONLY_CLOSE]);
                if (ignorable && answer === IGNORE_ERRORS.id) {
                    const added = concluded.ignore();
                    if (added.length > 0) chat.notice(t('run.flow.ignoredErrors', { patterns: added.join(', '), config: CONFIG_FILE }));
                    chat.notice(t('run.flow.ignoredRecheck'));
                    rechecking = true;
                    return { next: 'check' };
                }
                return undefined;
            },
        });
        next = offered;
        if (next !== null) continue;
        // The failures are allowed now: the same state again, without Claude.
        if (rechecking) continue;
        if (repairedHere !== null) {
            // Fixed in the same browser: the next check run shows whether it also works without Claude.
            current = carry(repairedHere.candidate, current, repairedHere.id);
            seen.push(...hardFailures(repairedHere.verdict));
            changes.push(changeOf(repairedHere));
            continue;
        }
        if (played.verdict.status !== 'pass') {
            log(t('run.flow.notRepeatable'));
            lostAdvice();
            return played.exitCode;
        }
        if (choice === ADOPT.id && saved !== null) {
            log(t('run.flow.planReplaced', { file: saved }));
            return played.exitCode;
        }
        log(t('run.flow.discarded'));
        return discardCode ?? played.exitCode;
    }
};

/**
 * Record anew: Claude works with the human at the chat, then it continues as with fixing.
 * @param sandbox  Docker, token and image
 * @param execute  a single run, returns { exitCode, verdict, candidate, failed }
 */
export const recordFlow = async ({ sandbox, execute, adopt, log }) => {
    const recorded = await execute({
        sandbox,
        conclude: async ({ verdict, candidate, chat }) => {
            // The recording is done: the check run comes in a new window.
            if (candidate !== undefined) return { next: 'check' };
            await chat.choose('deciding', t('run.flow.noRecording', { reason: failureText(verdict) }), [ONLY_CLOSE]);
            return undefined;
        },
    });
    if (recorded.candidate === undefined) return recorded.exitCode;
    // The check run of a recording costs no further tokens unless asked: advice only comes once a step gets fixed.
    return fixFlow({ draft: recorded.candidate, whole: true, fresh: recorded.fresh ?? [], seenFailures: hardFailures(recorded.verdict), sandbox, execute, adopt, log, advising: false });
};

/**
 * Test run by plan, without Claude. On dev with a terminal the chat is there from the start and shows the steps; if one
 * fails, the human clarifies it there right away. Docker and tokens only start on their message or click.
 * @param canFix    on dev, with terminal and chat
 * @param advise    --advise: on failures or warnings Claude advises on its own, even in a passed run. Costs tokens
 * @param handover  the human wants the window afterwards
 * @param fillBaselines passed steps without a request baseline get it from this run, without Claude and tokens
 * @param onPlayed  gets the playback result before things continue
 * @param hint      (failed, { canFix }) after a failed step, if the run ends with it
 */
export const runFlow = async (options) => {
    const { spec, until, handover, canFix, advise = false, fillBaselines = false, sessionAgent = false, openSandbox, execute, adopt, log, hint } = options;
    const fixer = createFixer({ openSandbox });
    let target = null;
    let repaired = null;
    let rerun = false;
    let current = spec;
    /** In a test run the file is the yardstick: what the human adopts goes into it immediately. @returns a stale step to fix */
    const keep = async (result, chat, { offer = true } = {}) => {
        if (result === null) return null;
        current = result.spec;
        if (result.touched.length > 0 || result.notes) log(t('run.flow.adviceAdopted', { file: adopt(current, new Set(result.touched), { withNotes: result.notes }) }));
        for (const file of result.files) log(t('run.flow.adviceAdopted', { file }));
        noticeFiles(result.files, chat);
        return offer && result.stale.length > 0 ? fixer.offerChanged(result.stale[0], chat) : null;
    };
    /** Whether a new window comes next: for Claude (fix), the check run or a new test run. */
    const windowAfter = () => {
        if (rerun) return { next: 'run' };
        if (repaired !== null) return { next: 'check' };
        return target === null ? undefined : { next: 'claude' };
    };
    const played = await execute({
        spec,
        replay: until === undefined ? replayOf(spec) : cutReplay(spec, until),
        handover: () => handover && target === null && repaired === null && !rerun,
        ...(canFix ? {
            testing: true,
            /**
             * The human develops in the prepared state. The test is over: reloading no longer changes any result, the workbench
             * only shows afterwards that the page left the state. Restore plays the steps back from the start.
             * @param refresh    reloads the current page without cache (refresh, F5, logo)
             * @param restore    reloads and plays the steps up to the state; returns the message
             * @param onRefresh  tells the workbench who refreshes (null: locked)
             * @param onReload   after reloading the whole workbench; returns the unsubscribe function
             */
            develop: async ({ chat, talk, until: state, refresh, restore, onRefresh, onReload, toCode, restoreTo, onPickState }) => {
                let talker = null;
                const at = state === undefined ? t('run.develop.atEnd') : t('run.develop.atState', { state });
                // open: no steps, so nothing to restore; only refresh and questions.
                const opened = spec.steps.length === 0;
                let question = opened ? t('run.develop.opened', { agent: t(sessionAgent ? 'run.develop.sessionAgent' : 'run.develop.costsTokens') }) : t('run.develop.intro', {
                    start: state === undefined ? t('run.develop.runDone') : t('run.develop.stateReady', { state }),
                    at,
                    restore: RESTORE.label,
                    agent: t(sessionAgent ? 'run.develop.sessionAgent' : 'run.develop.costsTokens'),
                });
                const buttons = opened ? [END_DEVELOP] : [RESTORE, END_DEVELOP];
                // If the dev server is reloading right now, the reload fails: that is a message in the chat, not the end of the run.
                const attempt = async (what, work) => {
                    try {
                        const text = await work();
                        if (text) chat.notice(text);
                    } catch (error) {
                        chat.notice(t('run.develop.attemptFailed', { what, message: String(error?.message ?? error).split(/\r?\n/)[0] }));
                    }
                };
                // Restore one after another: whoever picks a state with F1 while a restore runs waits until it is done.
                let queue = Promise.resolve();
                const serial = (work) => {
                    queue = queue.then(work, work);
                    return queue;
                };
                onRefresh?.(() => attempt(t('run.develop.refresh'), refresh));
                // Reloading is part of developing (F5, hard reload with empty cache): no warning, the state is your working state.
                const offReload = onReload?.(() => {});
                // F1 in the workbench: pick a test (and optionally the step), caw-ai restores the state here.
                onPickState?.((test, step) => serial(async () => {
                    chat.progress(t('run.develop.restoringOther', { test, step: step ?? t('run.develop.allSteps') }));
                    await attempt(RESTORE.label, () => restoreTo(test, step));
                }));
                chat.onPicked?.((picked) => {
                    toCode(picked);
                    chat.notice(t('run.develop.picked', { label: picked.label }));
                });
                try {
                // With the own Claude Code session as agent it does not wait for the first question in the chat: whoever works in
                // Claude Code wants to look at the page in that state right away. It gets questions from the chat as usual afterwards.
                if (sessionAgent) {
                    const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                    if (ready !== null) talker = talk({ sandbox: ready, spec: current });
                }
                for (;;) {
                    const answer = await chat.develop(question, buttons);
                    question = undefined;
                    if (answer === null || answer.choice === END_DEVELOP.id) return;
                    if (answer.choice === RESTORE.id) {
                        await serial(async () => {
                            chat.progress(t('run.develop.restoring'));
                            await attempt(RESTORE.label, restore);
                        });
                    } else if (answer.message !== undefined) {
                        if (talker !== null && !talker.over()) {
                            talker.send(answer.message, answer.element);
                            continue;
                        }
                        const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                        if (ready !== null) talker = talk({ sandbox: ready, spec: current }, answer.message, answer.element);
                    }
                }
                } finally {
                    onRefresh?.(null);
                    onPickState?.(null);
                    offReload?.();
                    chat.onPicked?.(null);
                    // Also when the window closes or on error: Claude does not keep running and uses no tokens.
                    if (talker !== null) await Promise.resolve(talker.end()).catch(() => {});
                }
            },
            conclude: async (concluded) => {
                const { failed, chat, verdict } = concluded;
                /** After Claude's advice. @returns true if that settles everything */
                const afterAdvice = async (advised) => {
                    target = await keep(advised, chat);
                    if (target !== null) return true;
                    // The app code changed: adjusting the test now would hide the failure. A new run shows whether it is enough.
                    if (failed && (advised?.files ?? []).length > 0) {
                        // Only what really changed: whoever rejected the code change and only adopted the config reads it that way.
                        const app = appFilesOf(advised.files);
                        const what = app.length > 0 ? t('run.flow.appChanged', { files: app.join(', ') }) : t('run.flow.filesChanged', { files: advised.files.join(', ') });
                        rerun = await chat.choose('deciding', t('run.flow.rerunOffer', { id: failed.id, what }), [RERUN, CLOSE]) === RERUN.id;
                        return true;
                    }
                    return false;
                };
                const advised = advise ? await fixer.advise(concluded, current) : null;
                if (await afterAdvice(advised)) return windowAfter();
                if (!failed) {
                    const filled = fillBaselines && concluded.baselines !== undefined ? ` ${baselineText(concluded.baselines)}` : '';
                    const summary = `${t(verdict.status === 'pass' ? 'run.flow.runPassed' : 'run.flow.runFailed')}${filled}${findingsText(verdict)}${advised === null ? '' : t('run.flow.adviceInReport')}`;
                    // A passed run waits for nobody, not even with warnings. open passed nothing: only name findings.
                    if (spec.steps.length === 0 && advised === null && verdict.status === 'pass' && findingsText(verdict) === '') return;
                    if (advised === null && verdict.status === 'pass') chat.notice(summary);
                    else await chat.choose('deciding', summary, [ONLY_CLOSE]);
                    return;
                }
                // With --advise Claude already advised; otherwise Claude looks for the cause only on click, same as --advise, just on demand.
                let settled = await fixer.settle(concluded, current, { canAsk: !advise });
                if (settled.ask) {
                    await keep(settled.advice, chat, { offer: false });
                    if (await afterAdvice(await fixer.advise(concluded, current))) return windowAfter();
                    settled = await fixer.settle(concluded, current);
                }
                if (settled.forget !== undefined) {
                    current = withoutEffects(current, settled.forget);
                    log(t('run.flow.effectForgotten', { id: settled.forget, file: adopt(current, new Set([settled.forget])) }));
                    chat.notice(forgottenText(settled.forget));
                }
                const changed = await keep(settled.advice, chat, { offer: settled.target === null && settled.repaired === undefined });
                if (settled.repaired?.candidate !== undefined) repaired = settled.repaired;
                else target = settled.target ?? changed;
                return windowAfter();
            },
        } : {}),
    });
    options.onPlayed?.(played);
    if (fillBaselines && played.baselines !== undefined) {
        current = withBaselines(current, played.baselines);
        log(t('run.flow.baselinesAdded', { ids: [...played.baselines.keys()].join(', '), file: adopt(current, new Set(played.baselines.keys()), { learned: 'baselines' }) }));
    }
    if (fillBaselines && played.effects !== undefined) {
        current = withEffects(current, played.effects);
        log(t('run.flow.effectsLearned', { ids: [...played.effects.keys()].join(', '), file: adopt(current, new Set(played.effects.keys()), { learned: 'effects' }) }));
    }
    if (rerun) {
        log(t('run.flow.rerunning'));
        return runFlow({ ...options, spec: current, openSandbox: fixer.sandbox() === undefined ? openSandbox : async () => fixer.sandbox() });
    }
    const shared = { discardCode: EXIT.fail, sandbox: fixer.sandbox(), openSandbox, execute, adopt, log };
    if (repaired !== null) {
        return fixFlow({ ...shared, draft: carry(repaired.candidate, current, repaired.id), changes: [changeOf(repaired)], seenFailures: hardFailures(repaired.verdict) });
    }
    if (target !== null) return fixFlow({ ...shared, draft: current, target });
    // After every failure the next commands; without a chat also where the cause can be clarified.
    if (played.failed) hint?.(played.failed, { canFix });
    return played.exitCode;
};
