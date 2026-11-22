// Every decision caw waits for has a stable id, a language-neutral context and options with stable ids. Each option has a
// gate: `free` when answering it changes no standard (close, later, discard, test again, record red, ask the agent), `human`
// when it does (approve a changed or writing plan, adopt a recording that changes what the test checks, accept an effect or a
// look, use a target, ignore errors, promote, apply app code, fix a step the app is blamed for). The window shows every
// decision as a card as before; the run folder holds the waiting one (decision-desk.mjs), caw_status shows it, caw_decide
// answers it, and a run without a window takes only what is provably harmless (`autoOption`).

/** Gates: the agent may answer `free` options; `human` ones need a person (the window, or their consent in the session). */
export const FREE = 'free';
export const HUMAN = 'human';

/**
 * A whole recording is harmless to adopt when it records the plan already in the file and changes nothing it checks: same steps
 * (name, action, expected result, note, retry) and writing, no changed expected result, no message newly known, no step removed,
 * fixed, still stale or failing hard on the way. The first recording of a test (`firstRecording`: none before) sets the
 * baseline: the messages it knows are that baseline, not a change, and the decision log names them (`notedOf`). Recorded again,
 * a message newly known stays the person's decision.
 */
export const harmlessAdopt = (context) => context.samePlan === true
    && ['expectChange', ...(context.firstRecording === true ? [] : ['known']), 'removed', 'fixed', 'stale', 'seen'].every((key) => (context[key] ?? []).length === 0);

/**
 * What the decision log keeps next to an answer besides who took it: the messages a first recording adopted as known
 * (report.md and caw audit name them).
 */
export const notedOf = (decision, option) => {
    const { context = {} } = decision;
    if (decision.id !== 'recording.adopt' || option !== 'adopt' || context.firstRecording !== true) return {};
    const known = (context.known ?? []).filter((text) => typeof text === 'string');
    return known.length === 0 ? {} : { known };
};

// A failed step: one table for its variants (design, look, target, effect); only what the card offers counts.
const STEP = {
    fix: (context) => (context.diagnosis?.side === 'app' ? HUMAN : FREE),
    ask: FREE,
    close: FREE,
    'forget-effect': HUMAN,
    'ignore-errors': HUMAN,
    'use-target': HUMAN,
    'adopt-look': HUMAN,
};

/**
 * Per decision id the gate of each option, a function of the context where it depends on it. An option missing here is
 * `human`: whatever is not known to be harmless needs a person.
 */
export const DECISIONS = {
    // Recording: the plan before the agent acts, adopting the recording after its check run.
    'plan.approve': { approve: (context) => (context.changed === true || context.writes === true ? HUMAN : FREE), revise: FREE },
    'record.start': { reuse: FREE, show: FREE, follow: FREE, describe: FREE },
    'app.dialog': { ok: HUMAN, cancel: HUMAN },
    tokens: { go: HUMAN, always: HUMAN, stop: FREE },
    'recording.adopt': { adopt: (context) => (harmlessAdopt(context) ? FREE : HUMAN), 'rerecord-next': FREE, discard: FREE },
    'recording.none': { close: FREE },
    'agent.unavailable': { close: FREE },
    'plan.changed': { rerecord: FREE, close: FREE },
    'check.failed': { 'ignore-errors': HUMAN, close: FREE },
    // A failed step and its variants.
    'step.failed': STEP,
    'effect.accept': STEP,
    'target.use': STEP,
    'look.adopt': STEP,
    'design.unmet': STEP,
    // Advice, one card per item, and the run after advice changed files.
    'advice.item': { accept: HUMAN, apply: HUMAN, discard: FREE, next: FREE },
    'advice.rerun': { rerun: FREE, close: FREE },
    'run.result': { close: FREE },
    // The guided bug fix (bugfix.mjs): reproduced, red, fix, green.
    'reproduced.record': { 'record-red': FREE, later: FREE },
    'red.proof': { adopt: FREE, discard: FREE },
    'red.still': { close: FREE },
    'fix.guide': { 'fix-by-agent': FREE, 'fix-myself': FREE, 'fix-there': FREE, retest: FREE, later: FREE, close: FREE },
    'fix.green': { promote: HUMAN, later: FREE },
    'fix.refused': { close: FREE },
    // Developing: a state picked with F1 may come from the app or the agent; only the person confirms it.
    'state.restore': { 'restore-picked': HUMAN, 'cancel-restore': FREE },
};

/**
 * The decision that leads a draft on from each phase of the guided bug fix (bugfix.mjs fixPhase): the `next` a session reads in
 * caw_status names it as `decision`, so window and session follow one model.
 */
export const PHASE_DECISIONS = { reproduced: 'reproduced.record', red: 'fix.guide', green: 'fix.green' };

const gateOf = (id, option, context) => {
    const gate = DECISIONS[id]?.[option];
    if (typeof gate === 'function') return gate(context);
    return gate ?? HUMAN;
};

/**
 * A decision as data: id, context, options with their gate, and the decision's gate (`human` once any option is).
 * @param options the buttons as the chat shows them ({ id, label })
 */
export const decisionOf = (id, options, context = {}) => {
    const offered = options.map((option) => ({ id: option.id, label: option.label, gate: gateOf(id, option.id, context) }));
    return { id, context, options: offered, gate: offered.some(({ gate }) => gate === HUMAN) ? HUMAN : FREE };
};

// What ends a decision without changing anything, in this order: the answer a run without a person gives when it stops.
const ENDS = ['close', 'discard', 'later', 'stop', 'cancel-restore', 'next'];

/** The option that ends the decision without changing anything; undefined when it has none (the plan). */
export const endOption = (decision) => ENDS.find((id) => decision.options.some((option) => option.id === id && option.gate === FREE));

/**
 * What a run without a window answers on its own: only the provably harmless. A plan the agent follows unchanged is approved
 * (writing is the environment's to allow: `writable`), a recording is adopted when harmlessAdopt says so, a draft's red proof
 * is saved, and a card that only says what happened is closed.
 * @returns the option id, or undefined when a person has to decide
 */
export const autoOption = (decision) => {
    const offers = (id) => decision.options.some((option) => option.id === id);
    if (decision.id === 'plan.approve') return decision.context.changed === true ? undefined : 'approve';
    if (decision.id === 'recording.adopt') return offers('adopt') && !offers('rerecord-next') && harmlessAdopt(decision.context) ? 'adopt' : undefined;
    if (decision.id === 'red.proof') return 'adopt';
    // Only a close button: the card said what happened, nothing to decide.
    if (decision.options.length === 1 && decision.options[0].id === 'close') return 'close';
    return undefined;
};

/**
 * Shows a decision in the chat and waits for its answer, from the window, the session (caw_decide) or a run without a window.
 * The chat gets the decision as its last argument; a chat that does not know it (a test's fake) shows the card as before.
 * @param via    how the chat shows it: choose (default), picks (a card with checkboxes), discuss (a failure the person can
 *               talk about), advice (one advice item) or plan
 * @param card   the card (choose, picks, discuss), the advice view or the plan view
 * @returns what the chat method returns
 */
export const decide = (chat, { id, context = {}, options, card, question, kind = 'deciding', via = 'choose' }) => {
    const decision = decisionOf(id, options, context);
    if (via === 'picks') return chat.choosePicks(kind, question ?? card.title, options, card, decision);
    if (via === 'discuss') return chat.discuss(question, options, card, decision);
    if (via === 'advice') return chat.advice(card, options, decision);
    if (via === 'plan') return chat.plan(card, decision);
    return chat.choose(kind, question ?? card?.title, options, card, decision);
};

/**
 * An answer as the decision log keeps it: the option id, 'message' for a written answer, null for none (the window closed).
 * @param answer what the chat resolved with: an id, { choice, picked }, { message }, { approved, feedback } or null
 */
export const answerOption = (answer) => {
    if (typeof answer === 'string') return answer;
    if (answer === null || answer === undefined) return null;
    if (typeof answer.choice === 'string') return answer.choice;
    if (answer.approved === true) return 'approve';
    if (typeof answer.feedback === 'string') return 'revise';
    if (typeof answer.message === 'string') return 'message';
    return null;
};
