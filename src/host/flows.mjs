// The flows around a step. What Claude achieved must also run without Claude, and only then does the human decide in the
// chat whether it replaces the test plan. If a step fails, the human clarifies it in the chat and can have it fixed.

import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { cawCommand } from '../shared/invocation.mjs';
import { CONFIG_FILE, CONTEXT_FILE } from '../shared/names.mjs';
import { cutReplay, positionalActions, replayOf, replayToEntry, replayUpToStale, withBaselines, withEffects, withoutEffects, withProposal } from './replay.mjs';
import { LEARN_RUNS, isEffectCause } from './effects.mjs';
import { locatorLabel, locatorText } from './locator.mjs';
import { redStep, staleSteps } from './test-file.mjs';
import { redOf } from './bugfix.mjs';
import { LOOK_LEARN_RUNS, withAdoptedLooks, withLooks } from './visual.mjs';
import { decide as decideOn } from './decisions.mjs';
import { samePlanStep } from './test-plan.mjs';

// Labels as getters: the language is not settled at import time. Copies via spread are only made at runtime.
const button = (id, key, extra = {}) => ({ id, get label() { return t(key); }, ...extra });
const ADOPT = { id: 'adopt', primary: true };
/** The button states how many steps the test plan will then have. */
const adoptButton = (count, extra = {}) => ({ ...ADOPT, label: t('run.button.adopt', { count }), ...extra });
// Discarding cannot be undone: it needs a second click, like Cancel in the chat header.
const DISCARD = { id: 'discard', get label() { return t('run.button.discardDraft'); }, get confirm() { return t('run.button.discardSure'); } };
const FIX = button('fix', 'run.button.fix', { primary: true });
const RERECORD = button('rerecord', 'run.button.rerecord', { primary: true });
const RERUN = button('rerun', 'run.button.rerun', { primary: true });
// Ends regularly with the result of the run. Cancel in the chat header ends immediately, as an error without a result.
const CLOSE = button('close', 'run.button.close');
const ASK = button('ask', 'run.button.ask', { primary: true });
// A target design not met: asking means having the screen built, the app's code changes, not the test.
const BUILD_DESIGN = button('ask', 'run.button.buildDesign', { primary: true });
// Or look at it first: the window opens at that step with the design beside the app (open <test>@S<n> --design), in this process.
const OPEN_DESIGN = button('open-design', 'run.button.openDesign');
// The learned look changed: if the new one is right, adopting it is the human's decision, without Claude and tokens.
const ADOPT_LOOK = button('adopt-look', 'run.button.adoptLook', { primary: true });
// Only the effects deviate, the check is met: forget the learned effects, without Claude and without tokens.
const FORGET_EFFECT = button('forget-effect', 'run.button.forgetEffect');
// Only script errors, e.g. from third-party code: add them to consoleIgnore and re-check right away, without Claude and tokens.
const IGNORE_ERRORS = button('ignore-errors', 'run.button.ignoreErrors', { primary: true });
const ONLY_CLOSE = button('close', 'run.button.onlyClose', { primary: true });
// After the handover, while developing in the prepared state.
const RESTORE = button('restore', 'run.button.restore', { primary: true });
const END_DEVELOP = button('end', 'run.button.endDevelop');
const RESTORE_PICKED = button('restore-picked', 'run.button.restorePicked', { primary: true });
/** The confirm button names the step it opens, so it reads as the answer to the question: "S2 öffnen". */
const openPicked = (step) => (step === undefined ? RESTORE_PICKED : { ...RESTORE_PICKED, label: t('run.button.openStep', { step }) });
const CANCEL_RESTORE = button('cancel-restore', 'run.button.cancelRestore');
// The guided bug fix (bugfix.mjs): reproduced, red, fixed, green, promoted, each in a new window of the same process. Later
// ends the run at any card; the terminal hints stay as they are.
const RECORD_RED = button('record-red', 'run.button.recordRed', { primary: true });
const LATER = button('later', 'run.button.later');
const FIX_BY_AGENT = button('fix-by-agent', 'run.button.fixByAgent', { primary: true });
const FIX_AGAIN = button('fix-by-agent', 'run.button.fixAgain', { primary: true });
const FIX_MYSELF = button('fix-myself', 'run.button.fixMyself');
const FIX_THERE = button('fix-there', 'run.button.fixThere', { primary: true });
const RETEST = button('retest', 'run.button.rerun', { primary: true });
const PROMOTE = button('promote', 'run.button.promote', { primary: true });

const withoutDot = (text) => text.replace(/\.$/, '');
/** The text as a closed sentence: a dot only when it does not end with . ! or ? already. */
const closed = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** Added baselines in one sentence for the chat. */
/**
 * A result card for the chat: what happened (title), details (text) and the consequence (muted); tone fail, warn, next, info, ask.
 * The fix card adds rows and the guided bug fix a phase (chat.mjs).
 */
const resultCard = (tone, title, text, muted) => ({ kind: 'result', tone, title, ...(text ? { text } : {}), ...(muted ? { muted } : {}) });
/** Waits for a button under a result card: decision `id` with its language-neutral `context` (decisions.mjs). */
const decide = (chat, id, context, card, options) => decideOn(chat, { id, context, card, options });

/** The test file as it was when the run started: does the current plan still say the same (steps and writing)? */
const samePlan = (previous, current) => previous !== undefined && previous.writes === current.writes
    && previous.steps.length === current.steps.length && current.steps.every((step, index) => samePlanStep(step, previous.steps[index]));

/** Which decision a failed step is: its kind and what the card offers first decide. */
const failureId = ({ design, look, useTarget, effectOnly }) => {
    if (design) return 'design.unmet';
    if (look) return 'look.adopt';
    if (useTarget !== null) return 'target.use';
    return effectOnly ? 'effect.accept' : 'step.failed';
};

/** The red step of a draft for a decision's context: step, expected result, check and suspected cause, as the card lists them. */
const redContext = (red) => ({ step: red.step, ...(red.expect === undefined ? {} : { expect: red.expect }), ...(red.check === undefined ? {} : { check: red.check }), ...(red.cause === undefined ? {} : { cause: red.cause }) });

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

/** The changed files of the app, without the caw config and project context. */
const appFilesOf = (files) => files.filter((file) => file !== CONFIG_FILE && file !== CONTEXT_FILE);

/**
 * What a fix produced, as the check run and the decision need it. Re-recorded from a step on, `ids` lists the steps from there
 * and `removed` those no longer in the plan; `expectChange` lists the steps whose expected result changed.
 */
const changeOf = ({ id, reason, rerecord, fresh, expectChange, ids, removed }) => ({
    id,
    reason,
    fresh: fresh ?? [],
    ...(rerecord ? { rerecord } : {}),
    ...((expectChange ?? []).length === 0 ? {} : { expectChange }),
    ...(ids === undefined ? {} : { ids, removed: removed ?? [] }),
});
/** The steps a change wrote: one, or all from where re-recording started. */
const changedIds = (changes) => changes.flatMap(({ id, ids }) => ids ?? [id]);
/** Each changed expected result in one sentence. */
const expectTexts = (changes) => changes.flatMap(({ expectChange }) => (expectChange ?? []).map(({ id, before, after }) => t('run.flow.decisionExpect', { id, after, before })));

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
            // The agent itself starts later, after the token notice. Only a preparation that takes a while (Docker) shows.
            const slow = setTimeout(() => (chat.starting === undefined ? chat.progress : chat.starting)(t('run.flow.preparingBox')), 1000);
            try {
                box = await openSandbox();
            } finally {
                clearTimeout(slow);
            }
            return box;
        } catch (error) {
            if (!(error instanceof CawError)) throw error;
            await say(withoutDot(error.message));
            return null;
        }
    };
    const cannotFix = (chat) => (message) => decide(chat, 'agent.unavailable', {}, resultCard('warn', t('run.flow.cannotFix'), `${withoutDot(message)}.`), [ONLY_CLOSE]);
    return {
        sandbox: () => box,
        open,
        /** A step whose plan changed through advice needs a new recording. @returns the step or null */
        offerChanged: async ({ id, title }, chat) => {
            const choice = await decide(chat, 'plan.changed', { step: id }, resultCard('next', t('run.flow.offerChanged', { id }), t('run.flow.offerChangedWhy', { id, title: withoutDot(title) })), [RERECORD, CLOSE]);
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
         * @param canAsk the "ask Claude for the cause" button: Claude advises as with --explain, only on click
         * @param proposals the button that adopts a proposed target (failed.proposal from playReplay); only a test run offers it
         * @param openDesign a design not met offers to open the window at that step with the design (only a test run can)
         * @returns { advice, target, repaired, ask, forget, adoptTarget, openDesign }: `advice` from the conversation or null; `forget`: forget the learned effects of this step; `target` is fixed with a warm-up; `repaired`
         *          is already fixed in the same browser; `ask`: Claude should find the cause and advise; `adoptTarget`: the proposal to write into the recording;
         *          `openDesign`: the step to open with its design
         */
        settle: async ({ failed, chat, verdict, talk, repairHere, ignore, cleared }, spec, { canAsk = false, repeated = false, proposals = false, openDesign = false } = {}) => {
            const { diagnosis } = failed;
            const app = diagnosis?.side === 'app';
            let hint = failed.suspect ? t('run.flow.suspect') : '';
            if (diagnosis !== undefined) {
                const warn = app ? ` ${t('run.flow.hideWarn')}` : '';
                hint = ` ${diagnosis.text} ${diagnosis.findings.join(' ')}${warn}`;
            }
            // A design not met: the step works, its screen is not built yet. Fixing the step or forgetting its effects would hide
            // that, so only asking (the app's code changes, not the test) and closing remain.
            const design = failed.kind === 'design';
            // A changed look: the step works, it only looks different than learned. Adopt the new look, ask, or close.
            const look = failed.kind === 'visual';
            if (design || look) hint = '';
            const where = design || look ? ` ${t(look ? 'run.flow.lookNext' : 'run.flow.designNext', { ids: [...(failed.looks?.keys() ?? [])].join(', ') || failed.id })}` : t(repairHere === undefined ? 'run.flow.whereFresh' : 'run.flow.whereHere');
            // The status line below says that Claude can be asked.
            // Same failure after a fix: fixing the same step again changes nothing, the cause lies elsewhere.
            const again = repeated ? t('run.flow.again', { config: CONFIG_FILE }) : '';
            let question = `${t('run.flow.failed', { id: failed.id, reason: closed(failed.reason) })}${hint}${findingsText(verdict)}${again}${where}`;
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
            // A renamed target with a proven replacement: adopting it comes first, it changes only that target in the recording.
            const proposal = proposals ? failed.proposal : undefined;
            const useTarget = proposal === undefined ? null : { id: 'use-target', primary: true, label: t('run.button.useTarget', { name: locatorText(proposal.to) ?? locatorLabel(proposal.to) }) };
            if (useTarget !== null) options = [useTarget, ...options.map(secondary)];
            if (design) {
                if (canAsk) options = [BUILD_DESIGN, ...(openDesign ? [OPEN_DESIGN] : []), CLOSE];
                else options = openDesign ? [{ ...OPEN_DESIGN, primary: true }, CLOSE] : [ONLY_CLOSE];
            }
            const adoptable = (failed.looks?.size ?? 0) > 0;
            if (look) options = [...(adoptable ? [ADOPT_LOOK] : []), ...(canAsk ? [adoptable ? secondary(ASK) : ASK] : []), !adoptable && !canAsk ? ONLY_CLOSE : CLOSE];
            // The same failure as data: the session reads it from caw_status and answers with caw_decide.
            const decision = {
                id: failureId({ design, look, useTarget, effectOnly }),
                context: {
                    test: spec.id,
                    step: failed.id,
                    reason: withoutDot(failed.reason),
                    kind: failed.kind ?? 'check',
                    ...(diagnosis === undefined ? {} : { diagnosis: { side: diagnosis.side, strength: diagnosis.strength } }),
                    ...(proposal === undefined ? {} : { proposal: { action: proposal.action, from: proposal.from, to: proposal.to } }),
                    ...(adoptable ? { looks: [...failed.looks.keys()] } : {}),
                    ...(repeated ? { repeated: true } : {}),
                    failures: hardFailures(verdict).length,
                },
            };
            /** The config now allows all hard failures: a check run without Claude is enough, no fix. */
            const recheck = async (advice) => {
                chat.notice(t('run.flow.ignoredRecheck'));
                return { advice, target: null, recheck: true };
            };
            let talker = null;
            for (;;) {
                // If the human adopts a config change in the conversation that allows all failures, it continues without another click.
                const changed = talker === null || talker.over() || talker.configChanged === undefined ? null : talker.configChanged().then(() => ({ configChanged: true }));
                const answer = await Promise.race([decideOn(chat, { ...decision, via: 'discuss', question, options, card: question === undefined ? undefined : card }), ...(changed === null ? [] : [changed])]);
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
                if (answer?.choice === ADOPT_LOOK.id) return { advice, target: null, adoptLooks: failed.looks };
                if (useTarget !== null && answer?.choice === useTarget.id) return { advice, target: null, adoptTarget: proposal };
                if (answer?.choice === ASK.id) return { advice, target: null, ask: true };
                if (answer?.choice === OPEN_DESIGN.id) return { advice, target: null, openDesign: failed.id };
                if (answer?.choice !== FIX.id) return { advice, target: null };
                if (await open(chat, cannotFix(chat)) === null) return { advice, target: null };
                // Fixing starts a new Claude: it gets the conversation and the hard failures, so that agreements hold.
                const agreed = talker?.log?.() ?? [];
                const failures = verdict?.failures ?? [];
                const context = { ...(agreed.length === 0 ? {} : { agreed }), ...(failures.length === 0 ? {} : { failures }) };
                if (repairHere === undefined) return { advice, target: { ...failed, ...context } };
                const repaired = await repairHere({ sandbox: box, reason: failed.reason, ...context });
                if (repaired.candidate === undefined) {
                    await decide(chat, 'recording.none', { test: spec.id, step: failed.id }, resultCard('fail', t('run.flow.noNewRecording', { id: failed.id }), `${failureText(repaired.verdict)}.`, t('run.flow.planUnchanged')), [ONLY_CLOSE]);
                }
                return { advice: advice ?? repaired.repairAdvice ?? null, target: null, repaired: { ...repaired, id: failed.id, reason: failed.reason } };
            }
        },
    };
};

/**
 * Did a draft fail exactly as it should while the bug is there: at its red step, at that step's check, which evaluated (it
 * did not throw), with every step before it passed?
 */
const redAsExpected = (spec, failed, verdict) => {
    const red = redStep(spec);
    if (red === undefined || failed?.id !== red || failed.evaluated !== true) return false;
    const before = spec.steps.slice(0, spec.steps.findIndex(({ id }) => id === red)).map(({ id }) => id);
    return before.every((id) => (verdict?.results ?? []).some((result) => result.id === id && result.status === 'pass'));
};

/** The draft with its red proof: the step, the run that showed it and the commit checked out then (if git knows one). */
const withRed = (spec, run, head) => {
    const commit = head();
    return { ...spec, red: { step: redStep(spec), run, ...(commit === undefined ? {} : { head: commit }) } };
};

/** The red step of a draft for the fix, also before its red proof is written: the step it must fail at. */
const redBundle = (spec, cause) => redOf({ ...spec, red: spec.red ?? { step: redStep(spec) } }, cause);

/** The red step as the fix card lists it: step, expected result, check (as code) and the suspected cause when there is one. */
const redRows = (red) => [
    { label: t('run.guide.fixStep'), text: `${red.step} ${red.name ?? ''}`.trim() },
    ...(red.expect === undefined ? [] : [{ label: t('run.guide.fixExpect'), text: red.expect }]),
    ...(red.check === undefined ? [] : [{ label: t('run.guide.fixCheck'), text: red.check, code: true }]),
    ...(red.cause === undefined ? [] : [{ label: t('run.guide.fixCause'), text: red.cause }]),
];
/** A card of the guided bug fix: the chat shows its phase (reproduced, red, fix, green, promoted) over it. */
const inPhase = (phase, card) => ({ ...card, phase });

/**
 * A reproduction with a window found the bug and wrote a draft: the next step is recording it red, in a new window.
 * @param draft { file, record } from the verdict
 * @returns { next: 'record' } or the outcome for the chat
 */
export const offerRecordRed = async (chat, draft) => {
    const choice = await decide(chat, 'reproduced.record', { draft: draft.file }, inPhase('reproduced', resultCard('next', t('run.guide.reproducedTitle', { file: draft.file }), t('run.guide.reproducedText'), t('run.guide.laterHint', { command: draft.record }))), [RECORD_RED, LATER]);
    return choice === RECORD_RED.id ? { next: 'record' } : { outcome: t('run.guide.later', { command: draft.record }) };
};

/** The command that goes on with a draft later, on the run's environment (guide.env) like every other hint. */
const laterCommand = (guide, test, extra = '') => `${cawCommand()} run ${test}${extra}${guide?.env === undefined ? '' : ` --env ${guide.env}`}`;

/**
 * A draft red at its step, the bug still there: the person has the agent advise the fix (code changes come back as cards,
 * applied one by one), fixes it themselves, or stops. A cause outside the project is fixed there.
 * @param red       redBundle: the red step for the card and the agent's task
 * @param later     the command that tests again later (laterCommand)
 * @param again     still red after a fix: fix again, test again or end
 * @param title     the card's head; by default "Now fix the bug"
 * @param adviseFix () => the advice result ({ spec, touched, notes, files, outside }) or null if no agent could start
 * @param store     (advice result) adopts what changed in the test (rare: the fix is the app's)
 * @returns true to test again in a new window, false to end the run
 */
const guideFix = async (chat, { red, test, later, again = false, title, adviseFix, store }) => {
    const ask = { ...resultCard('next', title ?? t('run.guide.fixTitle'), undefined, t(again ? 'run.guide.againMuted' : 'run.guide.fixMuted')), rows: redRows(red) };
    let card = ask;
    let options = again ? [FIX_AGAIN, { ...RETEST, primary: false }, CLOSE] : [FIX_BY_AGENT, FIX_MYSELF, LATER];
    const waiting = () => {
        card = resultCard('next', t('run.guide.waitTitle'), t('run.guide.waitText', { id: red.step }), t('run.guide.laterHint', { command: later }));
        options = [RETEST, LATER];
    };
    for (;;) {
        const choice = await decideOn(chat, { id: 'fix.guide', context: { test, red: redContext(red), ...(again ? { again: true } : {}) }, options, card: inPhase('fix', card) });
        if (choice === FIX_BY_AGENT.id) {
            const advised = await adviseFix();
            if (advised === null) {
                card = resultCard('warn', t('run.guide.noAgent'), t('run.guide.noAgentText'));
                options = [{ ...FIX_MYSELF, primary: true }, LATER];
                continue;
            }
            store(advised);
            const app = appFilesOf(advised.files);
            const outside = advised.outside ?? [];
            if (app.length > 0) {
                card = resultCard('next', t('run.guide.appliedTitle'), t('run.guide.appliedText', { files: app.join(', '), id: red.step }));
                options = [RETEST, LATER];
            } else if (outside.length > 0) {
                // Nothing to apply here: where it lies, and the person fixes it there; testing again shows the fix all the same.
                card = resultCard('warn', t('run.guide.outsideTitle'), outside.map(({ where, title: what }) => `${where}: ${withoutDot(what)}.`).join(' '), t('run.guide.outsideMuted'));
                options = [FIX_THERE, LATER];
            } else {
                card = resultCard('info', t('run.guide.nothingTitle'), t('run.guide.nothingText'));
                options = [{ ...FIX_MYSELF, primary: true }, { ...RETEST, primary: false }, LATER];
            }
            continue;
        }
        if (choice === FIX_MYSELF.id || choice === FIX_THERE.id) {
            waiting();
            continue;
        }
        return choice === RETEST.id;
    }
};

/** What happens after forgetting the learned effects, in one sentence. */
const forgottenText = (id) => t('run.flow.forgotten', { id, runs: LEARN_RUNS });

/** What adopting writes into the test file, in one sentence. */
const adoptedText = (current, changes, whole) => {
    if (whole) return t('run.flow.adoptWhole', { count: current.steps.length });
    if (changes.length === 0) return '';
    return t('run.flow.adoptChanges', {
        list: changes.map(({ id, ids, removed = [], reason, rerecord }) => {
            const what = t(rerecord ? 'run.flow.adoptRerecorded' : 'run.flow.adoptFixed', { id: (ids ?? [id]).join(', '), reason: withoutDot(reason) });
            return removed.length === 0 ? what : `${what}, ${t('run.flow.adoptRemoved', { ids: removed.join(', ') })}`;
        }).join('; '),
    });
};

const decisionText = (current, changes, seen, warnings = [], { fresh = [], whole = false, expectChange = [], looks = [] } = {}) => [
    t('run.flow.checkPassed'),
    ...(adoptedText(current, changes, whole) === '' ? [] : [adoptedText(current, changes, whole)]),
    ...(warnings.length === 0 ? [] : [t('run.flow.decisionWarnings', { list: warnings.map(({ text }) => withoutDot(text)).join('; ') })]),
    ...(seen.length === 0 ? [] : [t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') })]),
    ...(() => {
        const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
        return known.length === 0 ? [] : [t('run.flow.decisionKnown', { list: known.map((text) => `"${text}"`).join('; ') })];
    })(),
    ...(() => {
        const positional = positionalActions(current, whole ? undefined : new Set(changedIds(changes)));
        return positional.length === 0 ? [] : [t('run.flow.decisionPositional', { list: positional.join(', ') })];
    })(),
    ...expectTexts([...changes, { expectChange }]),
    ...(staleSteps(current).length === 0 ? [] : [t('run.flow.decisionStale', { ids: staleSteps(current).map(({ id }) => id).join(', ') })]),
    ...(looks.length === 0 ? [] : [t('run.flow.decisionLooks', { ids: looks.join(', ') })]),
    t('run.flow.decisionQuestion'),
].join(' ');

/**
 * The same decision as a card: on top what would be adopted and what the human needs to know first, one point each;
 * warnings, known messages and actions chosen by position collapsible.
 */
const decisionCard = (current, changes, seen, warnings = [], { fresh = [], whole = false, expectChange = [] } = {}) => {
    const adopted = adoptedText(current, changes, whole);
    const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
    const stale = staleSteps(current);
    return {
        title: t('run.flow.decisionTitle'),
        facts: [
            ...(adopted === '' ? [] : [adopted]),
            ...expectTexts([...changes, { expectChange }]),
            ...(stale.length === 0 ? [] : [t('run.flow.decisionStale', { ids: stale.map(({ id }) => id).join(', ') })]),
        ],
        ...(seen.length === 0 ? {} : { warn: t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') }) }),
        details: [
            { title: t('run.flow.decisionWarningsTitle'), items: warnings.map(({ text }) => withoutDot(text)) },
            { title: t('run.flow.decisionKnownTitle'), items: known },
            { title: t('run.flow.decisionPositionalTitle'), items: positionalActions(current, whole ? undefined : new Set(changedIds(changes))) },
        ].filter(({ items }) => items.length > 0),
        question: t('run.flow.decisionQuestion'),
    };
};

/**
 * The same decision as data for the session and a run without a window: what would be adopted and everything that makes it
 * more than recording the plan already in the file (decisions.mjs harmlessAdopt).
 */
const adoptContext = (current, changes, seen, warnings = [], { fresh = [], whole = false, expectChange = [], looks = [], previous } = {}) => ({
    test: current.id,
    whole,
    steps: current.steps.length,
    samePlan: samePlan(previous, current),
    // The test had no recording yet: what this one knows is the baseline (decisions.mjs harmlessAdopt).
    firstRecording: whole && !(previous?.steps ?? []).some((step) => step.recording !== undefined),
    writes: current.writes === true,
    expectChange: [...changes.flatMap((change) => change.expectChange ?? []), ...expectChange].map(({ id, before, after }) => ({ step: id, before, after })),
    known: [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])],
    removed: changes.flatMap(({ removed = [] }) => removed),
    fixed: changedIds(changes),
    stale: staleSteps(current).map(({ id }) => id),
    seen: [...new Set(seen)],
    warnings: warnings.length,
    looks,
});

/**
 * The steps a recording's check run offers for `look: true` (look-hints.mjs), as the card's checkboxes: none ticked, the human
 * ticks what really shows fixed data.
 */
const lookPicks = (current, ids) => ({
    title: t('run.flow.lookPicksTitle'),
    text: t('run.flow.lookPicksText'),
    items: ids.map((id) => ({ id, label: current.steps.find((step) => step.id === id)?.name ?? '' })),
});

const changeNote = (changes) => {
    if (changes.length === 0) return undefined;
    return changes.map(({ id, ids, reason, rerecord, expectChange = [] }) => `${t(rerecord ? 'run.flow.noteRerecorded' : 'run.flow.noteFixed', { id: (ids ?? [id]).join(', '), reason: withoutDot(reason) })}${expectChange.map(({ id: changed, before }) => t('run.flow.noteBefore', { id: changed, before })).join('')}`).join(' ');
};

/**
 * Fixes a step and checks the whole test without Claude until it passes or the human stops. If another step fails on the
 * way, the human clarifies it in the chat. Only what was really fixed changes in the file.
 * @param draft        the test, in memory: the file or a recording not adopted yet
 * @param target       { id, reason, rerecord, from }; with `from` re-recorded from that step to the end; null checks first
 * @param changes      steps already fixed, e.g. in the same browser after a test run
 * @param whole        the whole plan is new and is adopted as a whole
 * @param discardCode  exit code on discard, otherwise that of the check run
 * @param fresh        for a whole recording: messages that newly count as known
 * @param seenFailures hard failures from the previous recording, the human sees them before deciding
 * @param execute      a single run
 * @param adopt        (test, changed steps or undefined for all, { withNotes }) writes the file and returns its name
 * @param advising     Claude advises on its own on failures and warnings; after a recording only once a step gets fixed
 * @param log          message in the terminal
 * @param head         () => the checked-out commit's short hash or undefined: a draft's red proof records it
 * @param markLooks    (test, step ids) => the file: writes `look: true` on the steps the human ticked when adopting a whole
 *                     recording; without it nothing is suggested
 * @param guide        a draft with a window (the guided bug fix): { env, cause, rerun }; once its red proof is saved the card offers the
 *                     fix, and testing again is `rerun()`, a run of the draft in a new window of this process (its exit code)
 * @param previous     the test file as it was before: adopting a recording of the same plan that changes nothing it checks is
 *                     harmless (decisions.mjs harmlessAdopt), which a run without a window may do on its own
 */
export const fixFlow = async ({ draft, target = null, changes: done = [], whole = false, expectChange = [], fresh = [], discardCode, seenFailures = [], sandbox, openSandbox, execute, adopt, markLooks, log, head = () => undefined, advising: advisingFirst = true, guide, previous }) => {
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
            const { id, reason, rerecord, from, diagnosis, evidence, agreed, failures } = next;
            advising = true;
            let offered = null;
            let rechecking = false;
            const repaired = await execute({
                sandbox: fixer.sandbox(),
                spec: current,
                repair: { id, reason, ...(rerecord ? { rerecord } : {}), ...(from ? { from } : {}), ...(diagnosis === undefined ? {} : { diagnosis, evidence }), ...(agreed === undefined ? {} : { agreed }), ...(failures === undefined ? {} : { failures }) },
                conclude: async (concluded) => {
                    const { verdict, candidate, failed, chat, repairAdvice } = concluded;
                    // Next, a run without Claude checks, in a new window.
                    if (candidate !== undefined) return { next: 'check' };
                    // If Claude already advised while fixing, e.g. a change to the app, it does not start again for that.
                    offered = repairAdvice === undefined ? await takeAdvice(concluded) : await absorb(repairAdvice, chat);
                    if (offered !== null) return { next: 'claude' };
                    if (failed) ({ next: offered, recheck: rechecking = false } = await settle(concluded));
                    else await decide(chat, 'recording.none', { test: current.id, step: id }, resultCard('fail', t('run.flow.noNewRecording', { id }), `${failureText(verdict)}.`, t('run.flow.planUnchanged')), [ONLY_CLOSE]);
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
        // A draft that failed at its red step as it should: that is the proof, not a failure to fix.
        let red = false;
        // Guided: after the fix, the draft runs again in a new window.
        let retest = false;
        // A new recording: its check run measures which steps could get look: true, the card offers them.
        const suggesting = whole && markLooks !== undefined;
        const played = await execute({
            spec: current,
            replay: replayUpToStale(current),
            note: changeNote(changes),
            ...(suggesting ? { suggestLooks: true } : {}),
            conclude: async (concluded) => {
                const { verdict, failed, chat, runId } = concluded;
                // Advice on the bug the draft catches would only cost tokens: fixing the app is the person's next step.
                if (failed && redAsExpected(current, failed, verdict)) {
                    red = true;
                    const id = redStep(current);
                    const proof = resultCard('info', t('run.flow.redTitle', { id }), t('run.flow.redText', { id }), t('run.flow.redMuted', { test: current.id }));
                    choice = await decide(chat, 'red.proof', { test: current.id, step: id, run: runId }, guide === undefined ? proof : inPhase('red', proof), [adoptButton(current.steps.length), DISCARD]);
                    if (choice !== ADOPT.id) return { outcome: t('run.flow.discarded') };
                    current = withRed(current, runId, head);
                    saved = adopt(current, undefined, {});
                    if (guide !== undefined) {
                        chat.notice(t('run.flow.saved', { file: saved }));
                        const adviseFix = async () => {
                            const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.cannotAdvise', { message })); });
                            return ready === null ? null : concluded.advise({ sandbox: ready, spec: current, fix: redBundle(current, guide.cause) });
                        };
                        // Adopted test advice goes into the draft at once: the red proof is saved already.
                        const store = (result) => {
                            current = result.spec;
                            if (result.touched.length > 0 || result.notes) log(t('run.flow.adviceAdopted', { file: adopt(current, new Set(result.touched), { withNotes: result.notes }) }));
                        };
                        retest = await guideFix(chat, { red: redBundle(current, guide.cause), test: current.id, later: laterCommand(guide, current.id), adviseFix, store });
                        return retest ? { next: 'run' } : { outcome: t('run.guide.later', { command: laterCommand(guide, current.id) }) };
                    }
                    return { outcome: t('run.flow.saved', { file: saved }) };
                }
                offered = await takeAdvice(concluded);
                if (offered !== null) return { next: 'claude' };
                if (verdict.status === 'pass') {
                    // A draft whose red step passes does not catch the bug (yet): the person decides with that in mind.
                    if (redStep(current) !== undefined && current.red === undefined) chat.notice?.(t('run.flow.notRed', { id: redStep(current) }));
                    // If a step is still stale after the check run, e.g. the second of two adjusted ones, it comes next.
                    const [stale] = staleSteps(current);
                    const again = stale === undefined ? null : { id: 'rerecord-next', label: t('run.button.rerecordStep', { id: stale.id }), primary: true };
                    const count = current.steps.length;
                    const options = again === null ? [adoptButton(count), DISCARD] : [again, adoptButton(count, { primary: false }), DISCARD];
                    // Steps without data from the server or lists: the card offers them for look: true, none ticked.
                    const looks = suggesting ? (concluded.lookCandidates ?? []).filter((id) => current.steps.some((step) => step.id === id && step.look !== true)) : [];
                    const text = decisionText(current, changes, seen, verdict.warnings, { fresh, whole, expectChange, looks });
                    const card = decisionCard(current, changes, seen, verdict.warnings, { fresh, whole, expectChange });
                    const context = adoptContext(current, changes, seen, verdict.warnings, { fresh, whole, expectChange, looks, previous });
                    let picked = [];
                    if (looks.length === 0) choice = await decideOn(chat, { id: 'recording.adopt', context, question: text, options, card });
                    else ({ choice, picked } = await decideOn(chat, { id: 'recording.adopt', context, question: text, options, card: { ...card, picks: lookPicks(current, looks) }, via: 'picks' }));
                    if (choice === 'rerecord-next' && await fixer.open(chat, (message) => decide(chat, 'agent.unavailable', {}, resultCard('warn', t('run.flow.cannotFix'), `${withoutDot(message)}.`), [ONLY_CLOSE])) !== null) {
                        offered = { id: stale.id, reason: t('run.flow.stillStale'), rerecord: true };
                        return { next: 'claude' };
                    }
                    if (choice === ADOPT.id) {
                        const only = whole ? undefined : new Set([...changedIds(changes), ...advised]);
                        // Re-recorded from a step on: steps no longer in the plan go, the steps before stay as they are.
                        const prune = changes.some(({ ids }) => ids !== undefined);
                        saved = adopt(current, only, { withNotes: advisedNotes, ...(prune ? { prune } : {}) });
                        // The human's ticks: only steps the card offered.
                        const marked = picked.filter((id) => looks.includes(id));
                        if (marked.length > 0) {
                            const line = t('run.flow.looksMarked', { ids: marked.join(', '), file: markLooks(current, marked) });
                            log(line);
                            chat.notice(line);
                        }
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
                const answer = await decide(chat, 'check.failed', { test: current.id, failures: hardFailures(verdict).length }, resultCard('fail', t('run.flow.checkFailed'), `${failureText(verdict)}.${findingsText(verdict)}`, t('run.flow.planUnchanged')),
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
        if (red) {
            if (choice === ADOPT.id && saved !== null) {
                log(t('run.flow.redSaved', { file: saved, id: redStep(current), test: current.id }));
                return retest ? guide.rerun() : EXIT.pass;
            }
            log(t('run.flow.discarded'));
            return discardCode ?? played.exitCode;
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
 * @param guide    a draft: the guided bug fix after its red proof (fixFlow)
 * @param previous the test file being recorded again, if there is one (fixFlow)
 */
export const recordFlow = async ({ sandbox, execute, adopt, markLooks, log, head, guide, previous }) => {
    const recorded = await execute({
        sandbox,
        conclude: async ({ verdict, candidate, chat }) => {
            // The recording is done: the check run comes in a new window.
            if (candidate !== undefined) return { next: 'check' };
            await decide(chat, 'recording.none', { test: previous?.id }, resultCard('fail', t('run.flow.noRecording'), `${failureText(verdict)}.`, t('run.flow.oldPlanUnchanged')), [ONLY_CLOSE]);
            return undefined;
        },
    });
    if (recorded.candidate === undefined) return recorded.exitCode;
    // The check run of a recording costs no further tokens unless asked: advice only comes once a step gets fixed.
    return fixFlow({ draft: recorded.candidate, whole: true, expectChange: recorded.expectChange ?? [], fresh: recorded.fresh ?? [], seenFailures: hardFailures(recorded.verdict), sandbox, execute, adopt, markLooks, log, head, advising: false, guide, previous });
};

/**
 * Test run by plan, without Claude. On dev with a terminal the chat is there from the start and shows the steps; if one
 * fails, the human clarifies it there right away. Docker and tokens only start on their message or click.
 * @param canFix    on dev, with terminal and chat
 * @param advise    --explain: on failures or warnings Claude advises on its own, even in a passed run. Costs tokens
 * @param handover  the human wants the window afterwards (open)
 * @param entry     open at the entry of this step: the steps before it, then its leading navigation (replayToEntry)
 * @param through   open after this step, played completely (open --design: its screen is what the design is laid over)
 * @param fillBaselines passed steps without a request baseline get it from this run, without Claude and tokens (every run
 *                      outside CI, in CI with --learn)
 * @param onPlayed  gets the playback result before things continue
 * @param hint      (failed, { canFix }) after a failed step, if the run ends with it
 * @param guide     a draft with chat (the guided bug fix): { env, cause, promote }; red, the card offers the fix and testing again;
 *                  green, adopting it runs `promote({ runId })` -> { ok, test, report, others } or { ok: false, reason }
 * @param openDesign (step) => exit code: opens the window at that step with its design beside the app (open <test>@S<n>
 *                  --design) in this process; a design not met offers it. The run's own exit code stays.
 * @param server    the environment's lifecycle server ({ restartable(), restart() }, lifecycle.mjs): after an applied code change
 *                  that takes effect only once the app's server restarts, testing again restarts what caw started, or the card
 *                  names the restart the person does
 */
export const runFlow = async (options) => {
    const { spec, entry, through, handover, canFix, advise = false, fillBaselines = false, sessionAgent = false, reads = [], openSandbox, execute, adopt, log, hint, head = () => undefined, guide, openDesign, server } = options;
    const fixer = createFixer({ openSandbox });
    // What the run learned (baselines, effects, looks) is written once: before promoting, which moves the draft, or afterwards.
    let learned = false;
    const learnFrom = (played) => {
        if (learned || !fillBaselines) return;
        learned = true;
        if (played.baselines !== undefined) {
            current = withBaselines(current, played.baselines);
            log(t('run.flow.baselinesAdded', { ids: [...played.baselines.keys()].join(', '), file: adopt(current, new Set(played.baselines.keys()), { learned: 'baselines' }) }));
        }
        // Still learning: kept in .caw/learning, one line with the count. Frozen: written into the recording, once.
        if (played.effects !== undefined) {
            current = withEffects(current, played.effects);
            settleLearned(played.effects, (effects) => effects.runs, LEARN_RUNS, 'effects');
        }
        if (played.looks !== undefined) {
            current = withLooks(current, played.looks);
            settleLearned(played.looks, ({ visual }) => visual.runs, LOOK_LEARN_RUNS, 'looks');
        }
    };
    /** Writes what a run learned and says so: the steps still learning with their count, the frozen ones with the file. */
    const settleLearned = (learnedMap, runsOf, of, kind) => {
        const learning = [...learnedMap].filter(([, value]) => runsOf(value) < of);
        const frozen = [...learnedMap.keys()].filter((id) => !learning.some(([other]) => other === id));
        if (learning.length > 0) {
            // The recording only changes here when an older one still carried a state that is not frozen: it moves to .caw/learning.
            adopt(current, new Set(learning.map(([id]) => id)), { learned: kind });
            log(t(`run.flow.${kind}Learning`, { list: learning.map(([id, value]) => `${id} ${runsOf(value)}/${of}`).join(', ') }));
        }
        if (frozen.length > 0) log(t(`run.flow.${kind}Frozen`, { ids: frozen.join(', '), file: adopt(current, new Set(frozen), { learned: kind }) }));
    };
    let target = null;
    let repaired = null;
    let rerun = false;
    // Testing again after a code change to the app's server: caw restarts the server it started first.
    let restartFirst = false;
    // The step a design not met is opened at, with its design, once this run's window has closed.
    let opening = null;
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
    /** Whether a new window comes next: for Claude (fix), the check run, a new test run or the step opened with its design. */
    const windowAfter = () => {
        if (rerun) return { next: 'run' };
        if (opening !== null) return { next: 'open' };
        if (repaired !== null) return { next: 'check' };
        return target === null ? undefined : { next: 'claude' };
    };
    const played = await execute({
        spec,
        replay: entry !== undefined ? replayToEntry(spec, entry, { reads }) : through === undefined ? replayOf(spec) : cutReplay(spec, through),
        handover: () => handover && target === null && repaired === null && !rerun,
        ...(handover ? { command: 'open' } : {}),
        learns: fillBaselines,
        ...(canFix ? {
            testing: true,
            /**
             * The human develops in the prepared state. The test is over: reloading no longer changes any result, the workbench
             * only shows afterwards that the page left the state. Restore plays the steps back from the start.
             * @param refresh    reloads the current page without cache (refresh, F5, logo)
             * @param restore    reloads and plays the steps up to the state; returns the message
             * @param onRefresh  tells the workbench who refreshes (null: locked)
             * @param onReload   after reloading the whole workbench; returns the unsubscribe function
             * @param onDesignBuild (handler | null) for open --design: the comparison page's "have the agent build it" calls the
             *                  handler with { step, file, deviations }
             */
            develop: async ({ chat, talk, signedIn = false, until: state, entry: atEntry = false, refresh, restore, onRefresh, onReload, toCode, restoreTo, onPickState, onDesignBuild }) => {
                let talker = null;
                // A message for the agent: the running conversation gets it, else the agent starts with it.
                const toAgent = async (message, element) => {
                    if (talker !== null && !talker.over()) {
                        talker.send(message, element);
                        return;
                    }
                    const ready = await fixer.open(chat, (text) => { chat.progress(t('run.flow.claudeUnavailable', { message: text })); });
                    if (ready !== null) talker = talk({ sandbox: ready, spec: current }, message, element);
                };
                const at = state === undefined ? t('run.develop.atEnd') : t('run.develop.atState', { state });
                // open: no steps, so nothing to restore; only refresh and questions.
                const opened = spec.steps.length === 0;
                let question = opened ? t('run.develop.opened', { head: t(signedIn ? 'run.develop.openedSignedIn' : 'run.develop.openedPlain'), agent: t(sessionAgent ? 'run.develop.sessionAgent' : 'run.develop.costsTokens') }) : t('run.develop.intro', {
                    start: state === undefined ? t('run.develop.runDone') : t(atEntry ? 'run.develop.entryReady' : 'run.develop.stateReady', { state }),
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
                const reload = () => attempt(t('run.develop.refresh'), refresh);
                // Restore one after another: whoever picks a state with F1 while a restore runs waits until it is done. Meanwhile
                // the test is running again, so reloading is locked as in a run; it comes back unless developing has ended.
                let queue = Promise.resolve();
                let over = false;
                const restoring = async (work) => {
                    onRefresh?.(null);
                    try {
                        await work();
                    } finally {
                        if (!over) onRefresh?.(reload);
                    }
                };
                const serial = (work) => {
                    queue = queue.then(() => restoring(work), () => restoring(work));
                    return queue;
                };
                onRefresh?.(reload);
                // Reloading is part of developing (F5, hard reload with empty cache): no warning, the state is your working state.
                const offReload = onReload?.(() => {});
                // F1 in the workbench: pick a test (and optionally a step, then at its entry), caw-ai restores the state here once the
                // human confirms in the chat. The workbench shares its origin with the application, so the pick alone may come from the
                // application or from Claude's eval; the chat cannot be scripted by either. One question at a time, further picks
                // meanwhile drop.
                let confirming = false;
                onPickState?.(async (test, step, { role, until: last } = {}) => {
                    if (confirming) return;
                    confirming = true;
                    let answer;
                    try {
                        // A picked step: its entry, everything before it done. Without a step the whole test up to its last restorable step.
                        const about = { test, step: step ?? last ?? t('run.develop.allSteps'), role };
                        const key = step === undefined ? 'run.develop.confirmRestore' : 'run.develop.confirmEntry';
                        answer = await decideOn(chat, { id: 'state.restore', context: { test, step: step ?? last ?? null, ...(role === undefined ? {} : { role }) }, question: t(role ? key : `${key}NoRole`, about), options: [openPicked(step ?? last), CANCEL_RESTORE] });
                    } finally {
                        confirming = false;
                    }
                    if (answer !== RESTORE_PICKED.id) return;
                    await serial(async () => {
                        chat.progress(step === undefined ? t('run.develop.restoringOther', { test, step: t('run.develop.allSteps') }) : t('run.develop.restoringEntry', { test, step }));
                        await attempt(RESTORE.label, () => restoreTo(test, step));
                    });
                });
                chat.onPicked?.((picked) => {
                    toCode(picked);
                    chat.notice(t('run.develop.picked', { label: picked.label }));
                });
                // The comparison page's "have the agent build it": the design card's ask option (design.unmet), confirmed in the chat
                // like a state picked with F1, since the page shares its origin with the app. One question at a time.
                let building = false;
                onDesignBuild?.(async ({ step, file, deviations }) => {
                    if (building || deviations.length === 0) return;
                    building = true;
                    let answer;
                    try {
                        answer = await decideOn(chat, {
                            id: 'design.unmet',
                            context: { test: spec.id, step, reason: deviations.join('; '), kind: 'design', failures: 0 },
                            question: t('run.develop.buildDesignAsk', { id: step, file, count: deviations.length }),
                            options: [BUILD_DESIGN, CLOSE],
                        });
                    } finally {
                        building = false;
                    }
                    if (answer !== BUILD_DESIGN.id) return;
                    await toAgent(t('run.develop.buildDesignTask', { id: step, file, list: deviations.join('; ') }));
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
                        await toAgent(answer.message, answer.element);
                    }
                }
                } finally {
                    over = true;
                    onRefresh?.(null);
                    onPickState?.(null);
                    onDesignBuild?.(null);
                    offReload?.();
                    chat.onPicked?.(null);
                    // Also when the window closes or on error: Claude does not keep running and uses no tokens.
                    if (talker !== null) await Promise.resolve(talker.end()).catch(() => {});
                }
            },
            conclude: async (concluded) => {
                const { failed, chat, verdict, reloadable } = concluded;
                // A draft still red at its step: the bug is not fixed yet. Nothing in the test to fix or to ask about; the red
                // proof is written after the run (also without a chat).
                if (failed && redAsExpected(current, failed, verdict)) {
                    const id = redStep(current);
                    const known = current.red !== undefined;
                    if (guide !== undefined) {
                        const adviseFix = async () => {
                            const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.cannotAdvise', { message })); });
                            return ready === null ? null : concluded.advise({ sandbox: ready, spec: current, fix: redBundle(current, guide.cause) });
                        };
                        const title = t(known ? 'run.flow.stillRedTitle' : 'run.flow.redTitle', { id });
                        rerun = await guideFix(chat, { red: redBundle(current, guide.cause), test: current.id, later: laterCommand(guide, current.id), again: known, title, adviseFix, store: (advised) => keep(advised, chat, { offer: false }) });
                        return rerun ? windowAfter() : { outcome: t('run.guide.later', { command: laterCommand(guide, current.id) }) };
                    }
                    await decide(chat, 'red.still', { test: current.id, step: id }, resultCard('info', t(known ? 'run.flow.stillRedTitle' : 'run.flow.redTitle', { id }), t(known ? 'run.flow.stillRedText' : 'run.flow.redText', { id }), t('run.flow.stillRedMuted', { test: current.id })), [ONLY_CLOSE]);
                    return undefined;
                }
                /** After Claude's advice. @returns true if that settles everything */
                const afterAdvice = async (advised) => {
                    target = await keep(advised, chat);
                    if (target !== null) return true;
                    // The app code changed: adjusting the test now would hide the failure. A new run shows whether it is enough.
                    if (failed && (advised?.files ?? []).length > 0) {
                        // Only what really changed: whoever rejected the code change and only adopted the config reads it that way.
                        const app = appFilesOf(advised.files);
                        const what = app.length > 0 ? t('run.flow.appChanged', { files: app.join(', ') }) : t('run.flow.filesChanged', { files: advised.files.join(', ') });
                        // A change to the server's code takes effect only after a restart: caw restarts what it started, else the
                        // card names it. The app can be reloaded meanwhile to look at the change before testing again.
                        const restart = app.length > 0 && advised.restart === true ? server?.restartable?.() ?? 'none' : null;
                        const offer = [t('run.flow.rerunOffer', { id: failed.id, what }), ...(restart === null ? [] : [t(`run.flow.restart.${restart}`)]), ...(app.length > 0 ? [t('run.flow.reloadFirst')] : [])].join(' ');
                        await reloadable?.(app.length > 0);
                        try {
                            rerun = await decide(chat, 'advice.rerun', { test: current.id, step: failed.id, files: advised.files, ...(restart === null ? {} : { restart }) }, resultCard('next', t('run.flow.rerunTitle'), offer), [RERUN, CLOSE]) === RERUN.id;
                        } finally {
                            await reloadable?.(false);
                        }
                        restartFirst = rerun && restart === 'caw';
                        return true;
                    }
                    return false;
                };
                const advised = advise ? await fixer.advise(concluded, current) : null;
                if (await afterAdvice(advised)) return windowAfter();
                // A proven red draft passes: the bug is fixed. Adopting it promotes the draft, after every other test on the
                // environment passed too, while this window waits.
                if (!failed && guide !== undefined && verdict.status === 'pass' && current.red !== undefined) {
                    const id = current.red.step;
                    if (await decide(chat, 'fix.green', { test: current.id, step: id }, inPhase('green', resultCard('next', t('run.guide.greenTitle', { id }), t('run.guide.greenText', { test: current.id }))), [PROMOTE, LATER]) !== PROMOTE.id) {
                        return { outcome: t('run.guide.later', { command: laterCommand(guide, current.id, ' --promote') }) };
                    }
                    learnFrom(concluded);
                    chat.progress(t('run.guide.promoting'));
                    const promoted = await guide.promote({ runId: concluded.runId });
                    if (promoted.ok) return { outcome: t('run.guide.promoted', promoted) };
                    await decide(chat, 'fix.refused', { test: current.id }, inPhase('promoted', resultCard('fail', t('run.guide.refusedTitle'), closed(withoutDot(promoted.reason)), t('run.guide.refusedMuted', { test: current.id }))), [ONLY_CLOSE]);
                    return undefined;
                }
                if (!failed) {
                    const summary = `${t(verdict.status === 'pass' ? 'run.flow.runPassed' : 'run.flow.runFailed')}${findingsText(verdict)}${advised === null ? '' : t('run.flow.adviceInReport')}`;
                    // A passed run waits for nobody, not even with warnings. open passed nothing: only name findings.
                    if (spec.steps.length === 0 && advised === null && verdict.status === 'pass' && findingsText(verdict) === '') return;
                    if (advised === null && verdict.status === 'pass') chat.notice(summary);
                    else {
                        // A card that says what happened: failed, passed with findings, or passed with recommendations in the report.
                        const details = `${findingsText(verdict)}${advised === null ? '' : t('run.flow.adviceInReport')}`.trim();
                        let card = resultCard('info', t('run.flow.runPassedTitle'), details);
                        if (verdict.status !== 'pass') card = resultCard('fail', t('run.flow.runFailedTitle'), details);
                        else if (findingsText(verdict) !== '') card = resultCard('warn', t(hardFailures(verdict).length > 0 ? 'run.flow.runErrorsTitle' : 'run.flow.runWarnedTitle'), details);
                        await decide(chat, 'run.result', { test: current.id, status: verdict.status }, card, [ONLY_CLOSE]);
                    }
                    return;
                }
                // With --explain Claude already advised; otherwise Claude looks for the cause only on click, same as --explain, just on demand.
                const designable = openDesign !== undefined;
                let settled = await fixer.settle(concluded, current, { canAsk: !advise, proposals: true, openDesign: designable });
                if (settled.ask) {
                    await keep(settled.advice, chat, { offer: false });
                    if (await afterAdvice(await fixer.advise(concluded, current))) return windowAfter();
                    settled = await fixer.settle(concluded, current, { proposals: true, openDesign: designable });
                }
                if (settled.openDesign !== undefined) {
                    await keep(settled.advice, chat, { offer: false });
                    opening = settled.openDesign;
                    return windowAfter();
                }
                // The proven target goes into the recording, nothing else; a new run shows the step green with it.
                if (settled.adoptTarget !== undefined) {
                    const { step, action, to } = settled.adoptTarget;
                    current = withProposal(current, settled.adoptTarget);
                    const text = t('run.flow.targetAdopted', { id: step, number: action, target: locatorLabel(to), file: adopt(current, new Set([step])) });
                    log(text);
                    chat.notice(text);
                    rerun = true;
                }
                // The new look of every changed step becomes the learned one at once; audit lists it as adopted.
                if (settled.adoptLooks !== undefined) {
                    current = withAdoptedLooks(current, settled.adoptLooks);
                    const ids = [...settled.adoptLooks.keys()];
                    const text = t('run.flow.lookAdopted', { ids: ids.join(', '), file: adopt(current, new Set(ids), { learned: 'looks' }) });
                    log(text);
                    chat.notice(text);
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
    learnFrom(played);
    // A draft red at its step: its first red run is the proof and is written into the draft, also before testing again; the hint
    // to re-record the step would destroy it, so the next step is fixing the app.
    const redNow = !handover && Boolean(played.failed) && redAsExpected(current, played.failed, played.verdict);
    const knownRed = current.red !== undefined;
    if (redNow && !knownRed) {
        current = withRed(current, played.runId, head);
        log(t('run.flow.redSaved', { file: adopt(current, undefined, {}), id: redStep(current), test: current.id }));
    }
    if (rerun) {
        if (restartFirst) await server.restart();
        log(t('run.flow.rerunning'));
        return runFlow({ ...options, spec: current, openSandbox: fixer.sandbox() === undefined ? openSandbox : async () => fixer.sandbox() });
    }
    // Opening only shows the step: the run stays failed.
    if (opening !== null) {
        await openDesign(opening);
        return played.exitCode;
    }
    const shared = { discardCode: EXIT.fail, sandbox: fixer.sandbox(), openSandbox, execute, adopt, log, head, previous: spec };
    if (repaired !== null) {
        return fixFlow({ ...shared, draft: carry(repaired.candidate, current, repaired.id), changes: [changeOf(repaired)], seenFailures: hardFailures(repaired.verdict) });
    }
    if (target !== null) return fixFlow({ ...shared, draft: current, target });
    if (redNow) {
        if (knownRed) log(t('run.flow.stillRedLog', { id: redStep(current), test: current.id }));
        return played.exitCode;
    }
    // After every failure the next commands; without a chat also where the cause can be clarified.
    if (played.failed) hint?.(played.failed, { canFix });
    return played.exitCode;
};
