// `caw audit <ref>`: no test gets weaker unnoticed. caw itself keeps a check while its expected result stays (keptCheck in
// run.mjs), but people can still weaken tests: a chat button, an adopted advice, a hand edit. audit compares the project's test
// data at the merge base of <ref> and HEAD with the working tree and names every weakening in plain words, for PR review and CI.
// The one deliberate way to change a check is to change the step's expected result: that is listed, not a weakening.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MESSAGE_SELECTORS, guardedChanges } from '../shared/config.mjs';
import { testEnvironments } from '../shared/environments.mjs';
import { CawError, EXIT } from '../shared/errors.mjs';
import { inLanguage, t, teamLanguage } from '../shared/i18n.mjs';
import { CONFIG_FILE, PROJECT_DIR, RECORDING_DIR, TEST_DIR } from '../shared/names.mjs';
import { DEFAULT_DESIGN_FAIL, designPath, isDesignName } from './design.mjs';
import { DEFAULT_EFFECT_FAIL, EFFECT_LISTS, LEARN_RUNS } from './effects.mjs';
import { frameworkOf } from './framework/index.mjs';
import { auditFiles, isAuditFile, mergeBase, readAtCommit } from './git.mjs';
import { mergeRecordings, parseRecordings, parseTest } from './test-file.mjs';
import { LOOK_LEARN_RUNS } from './visual.mjs';

// What a step or action waits without its own timeoutMs (browser-session.mjs STEP_TIMEOUT_MS; --step-timeout can change it per
// run, which a file comparison cannot see).
const DEFAULT_TIMEOUT_MS = 30_000;
// Lines per finding: enough to recognize the change, the rest is in the diff.
const MAX_LINES = 5;

export const SEVERITIES = ['weakening', 'listed', 'info'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shown = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
const listed = (lines) => [...lines.slice(0, MAX_LINES).map(shown), ...(lines.length > MAX_LINES ? ['…'] : [])].join('; ');
const added = (before, after) => (after ?? []).filter((entry) => !(before ?? []).some((old) => same(old, entry)));
const seconds = (ms) => `${Math.round(ms / 100) / 10} s`;

/**
 * Reads one side of the comparison: config, tests (description merged with recordings) and what could not be read.
 * @param files Map path -> text, paths relative to the project folder as isAuditFile takes them
 * @returns { config, tests: Map id -> spec, unreadable: [path] }
 */
export const readProjectData = (files) => {
    const unreadable = [];
    let config = null;
    if (files.has(CONFIG_FILE)) {
        try {
            const parsed = JSON.parse(files.get(CONFIG_FILE));
            if (isObject(parsed)) config = parsed;
            else unreadable.push(CONFIG_FILE);
        } catch {
            unreadable.push(CONFIG_FILE);
        }
    }
    const framework = typeof config?.framework === 'string' ? config.framework : 'web';
    const tests = new Map();
    for (const path of [...files.keys()].filter((name) => name.startsWith(`${TEST_DIR}/`)).sort()) {
        const id = path.slice(TEST_DIR.length + 1, -'.yaml'.length);
        const recordings = `${RECORDING_DIR}/${id}.yaml`;
        try {
            const spec = { ...parseTest(files.get(path), path, { description: true, framework }), id };
            tests.set(id, files.has(recordings) ? mergeRecordings(spec, parseRecordings(files.get(recordings), recordings, { framework })) : spec);
        } catch (error) {
            // validate says what is wrong; audit only says that the test cannot be compared.
            if (!(error instanceof CawError)) throw error;
            unreadable.push(path);
        }
    }
    return { config, tests, unreadable };
};

/** The working tree's test data. */
export const workingTreeFiles = (root) => {
    const files = new Map();
    const add = (path) => {
        try {
            files.set(path, readFileSync(join(root, path), 'utf8'));
        } catch {
            // Gone between listing and reading, or a folder named *.yaml: nothing to compare.
        }
    };
    if (existsSync(join(root, CONFIG_FILE))) add(CONFIG_FILE);
    for (const dir of [TEST_DIR, RECORDING_DIR]) {
        if (!existsSync(join(root, dir))) continue;
        for (const name of readdirSync(join(root, dir))) if (isAuditFile(`${dir}/${name}`)) add(`${dir}/${name}`);
    }
    return files;
};

/** Where a test runs: as written, else the config's default. Without a readable config only what the test lists. */
const runsOn = (config, spec) => {
    try {
        return testEnvironments(config ?? {}, spec);
    } catch {
        return spec.environments ?? [];
    }
};

/** An action without what does not change what it does: wait time, optional, the diagnosis hints. */
const bare = ({ timeoutMs: _timeoutMs, optional: _optional, component: _component, source: _source, ...rest }) => rest;
// The same action, only possibly on another element.
const bareTarget = (action) => {
    const rest = bare(action);
    delete rest.target;
    return rest;
};
const actionLabel = (action) => [action.action, action.target ?? action.url ?? action.key ?? action.name].filter((part) => part !== undefined).join(' ');
// A wait-ready only waits: it neither acts nor has effects, but it takes an action number (effects are numbered by position).
const WAIT = 'wait-ready';
const acting = (actions) => actions.map((action, index) => ({ action, number: index + 1 })).filter(({ action }) => action.action !== WAIT);
/**
 * The same actions apart from waits added or taken out: per action number of `before` the number of the same action in `after`.
 * @returns Map old number -> new number, or null when the actions differ
 */
const sameActions = (before, after) => {
    const was = acting(before);
    const now = acting(after);
    if (was.length !== now.length || !was.every(({ action }, index) => same(bare(action), bare(now[index].action)))) return null;
    return new Map(was.map(({ number }, index) => [number, now[index].number]));
};
/**
 * Actions taken out of a step by hand: the remaining ones are the old ones in their order, only fewer. Waits do not count. A
 * re-recording with other actions is no removal.
 * @returns the removed actions with their old number, or [] when it is not a pure removal
 */
const removedActions = (before, after) => {
    const was = acting(before);
    const now = acting(after);
    if (now.length >= was.length) return [];
    const kept = new Set();
    let from = 0;
    for (const { action } of now) {
        const position = was.findIndex((old, index) => index >= from && same(bare(old.action), bare(action)));
        if (position === -1) return [];
        kept.add(position);
        from = position + 1;
    }
    return was.filter((_, index) => !kept.has(index));
};

/**
 * Pairs the steps of both sides. Like keptCheck, by the expected result first, so a step that only moved or was renumbered
 * pairs with itself; then by id, which is an expected result that changed.
 * @returns { pairs: [{ before, after, sameExpect }], added: [step], removed: [step] }
 */
const pairSteps = (beforeSteps, afterSteps) => {
    const used = new Set();
    const partner = new Map();
    const take = (match) => {
        for (const step of afterSteps.filter((candidate) => !partner.has(candidate))) {
            const old = beforeSteps.find((candidate) => !used.has(candidate) && match(candidate, step));
            if (old === undefined) continue;
            used.add(old);
            partner.set(step, old);
        }
    };
    take((old, step) => old.expect === step.expect && old.id === step.id);
    take((old, step) => old.expect === step.expect);
    take((old, step) => old.id === step.id);
    const expects = new Set(afterSteps.map(({ expect }) => expect));
    return {
        pairs: afterSteps.filter((step) => partner.has(step)).map((step) => ({ before: partner.get(step), after: step, sameExpect: partner.get(step).expect === step.expect })),
        added: afterSteps.filter((step) => !partner.has(step)),
        // A step whose expected result another step still has is a duplicate that went, not a check that is gone.
        removed: beforeSteps.filter((step) => !used.has(step) && !expects.has(step.expect)),
    };
};

/** The findings of one pair of steps besides check and expected result. */
const stepChanges = (finding, { before, after, sameExpect }, failLists, designs) => {
    const out = [];
    const at = { step: after.id, expect: after.expect };
    // The target design (a person's, never caw's): taken off, swapped or its file changed, the step is judged against less or
    // something else. A design newly linked only adds a judgement. The file is compared only when both sides were read.
    if (before.design !== undefined) {
        if (after.design === undefined) out.push(finding('design-removed', 'weakening', { ...at, before: before.design, vars: { file: before.design } }));
        else if (after.design !== before.design) out.push(finding('design-changed', 'weakening', { ...at, before: before.design, after: after.design, vars: { was: before.design, now: after.design } }));
        else if (designs.before?.has(before.design) && designs.after !== undefined && designs.before.get(before.design) !== designs.after.get(before.design)) {
            out.push(finding('design-file-changed', 'weakening', { ...at, vars: { file: before.design } }));
        }
    }
    const triesBefore = before.retry?.times ?? 0;
    const triesAfter = after.retry?.times ?? 0;
    if (triesAfter > triesBefore) {
        out.push(finding(triesBefore === 0 ? 'retry-added' : 'retry-raised', 'weakening', {
            ...at, before: before.retry, after: after.retry, vars: { times: triesAfter, was: triesBefore },
        }));
    }
    // `look: true` off a step whose look was learned: a step that looks different passes from now on. On: only listed.
    if (before.look === true && after.look !== true && (before.recording?.visual?.runs ?? 0) >= LOOK_LEARN_RUNS) {
        out.push(finding('look-off', 'weakening', { ...at, before: true, after: after.look ?? null }));
    }
    if (before.look !== true && after.look === true) out.push(finding('look-on', 'listed', { ...at, before: before.look ?? null, after: true }));
    const was = before.recording;
    const now = after.recording;
    if (was === undefined || now === undefined) return out;
    // A learned look gone from the recording while the step still asks for it: like forgotten effects, nothing is compared until
    // it is learned again. Only while the actions are the same: a step recorded anew learns its look anew.
    if (before.look === true && after.look === true && (was.visual?.runs ?? 0) >= LOOK_LEARN_RUNS && !((now.visual?.runs ?? 0) >= LOOK_LEARN_RUNS)
        && sameActions(was.actions, now.actions) !== null) {
        out.push(finding('look-forgotten', 'weakening', { ...at, before: was.visual, after: now.visual }));
    }
    for (const { action, number } of removedActions(was.actions, now.actions)) {
        out.push(finding('action-removed', 'weakening', { ...at, before: action, number, vars: { number, action: actionLabel(action) } }));
    }
    if (now.timeoutMs !== undefined && now.timeoutMs > (was.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
        out.push(finding('timeout-raised', 'weakening', { ...at, before: was.timeoutMs, after: now.timeoutMs, vars: { was: seconds(was.timeoutMs ?? DEFAULT_TIMEOUT_MS), now: seconds(now.timeoutMs) } }));
    }
    // Targets swapped while everything else stayed, the learned effects too: an adopted proposal (a renamed element whose
    // replacement caused the learned effect and passed the unchanged check). A re-recording learns its effects anew instead.
    // Listed, not a weakening: the check is the same, the reviewer sees the new element.
    const sameWork = was.actions.length === now.actions.length && was.actions.every((old, index) => same(bareTarget(old), bareTarget(now.actions[index])));
    if (sameWork && was.effects !== undefined && same(was.effects, now.effects)) {
        now.actions.forEach((action, index) => {
            const old = was.actions[index];
            if (old.target === action.target) return;
            out.push(finding('locator-changed', 'listed', { ...at, before: old.target, after: action.target, number: index + 1, vars: { number: index + 1, was: old.target, now: action.target } }));
        });
    }
    // Per action of the new recording the same action of the old one, in order: a re-recording keeps most actions.
    const olds = [...was.actions];
    now.actions.forEach((action, index) => {
        const position = olds.findIndex((old) => old !== null && same(bare(old), bare(action)));
        if (position === -1) return;
        const old = olds[position];
        olds[position] = null;
        const vars = { number: index + 1, action: actionLabel(action) };
        if (action.optional === true && old.optional !== true) out.push(finding('action-optional', 'weakening', { ...at, before: old, after: action, number: index + 1, vars }));
        if (action.timeoutMs !== undefined && action.timeoutMs > (old.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
            out.push(finding('action-timeout-raised', 'weakening', {
                ...at, before: old.timeoutMs, after: action.timeoutMs, number: index + 1, vars: { ...vars, was: seconds(old.timeoutMs ?? DEFAULT_TIMEOUT_MS), now: seconds(action.timeoutMs) },
            }));
        }
    });
    if (was.network !== undefined && !same(was.network, now.network)) out.push(finding('baselines-changed', 'info', { ...at, before: was.network, after: now.network }));
    // A look a person adopted ("Adopt new look"): the step is compared against the adopted styles from now on, its image is
    // learned anew. Listed, so the reviewer looks at the styles in the diff; a look learned over runs is not listed, it only
    // confirms what was there.
    if (now.visual?.adopted !== undefined && now.visual.adopted !== was.visual?.adopted) {
        out.push(finding('look-adopted', 'listed', { ...at, before: was.visual?.styles, after: now.visual.styles, vars: { day: now.visual.adopted } }));
    }
    out.push(...effectChanges(finding, at, was, now, failLists, sameExpect));
    return out;
};

/**
 * Learned effects are learned over LEARN_RUNS healthy runs and then frozen: no run removes a line from them. So a learned line
 * that is gone while the expected result stayed (changing it is the deliberate way, listed) was removed by hand, and that
 * change no longer shows: a weakening in every list. "Accept new effect" in the chat forgets the effects and the next runs learn
 * them anew; in the files that looks like a hand edit, but a relearned list has new lines in place of the old ones. Such a
 * replacement (lines gone and others new in the same list of the same action) is listed with both; only a pure removal weakens.
 * Compared only while the actions are the same: a step recorded anew learns its effects anew, numbered by its new actions. A
 * wait added or taken out changes the numbers, not the actions: each learned line is compared at its action's new number.
 */
const effectChanges = (finding, at, was, now, failLists, sameExpect) => {
    const numbers = sameActions(was.actions, now.actions);
    if (!((was.effects?.runs ?? 0) >= LEARN_RUNS) || numbers === null) return [];
    if (!((now.effects?.runs ?? 0) >= LEARN_RUNS)) return [finding('effects-forgotten', 'weakening', { ...at, before: was.effects, after: now.effects })];
    const removed = [];
    const replaced = { was: [], now: [] };
    const accepted = [];
    for (const entry of was.effects.actions) {
        const fresh = now.effects.actions.find(({ action }) => action === (numbers.get(entry.action) ?? entry.action)) ?? {};
        for (const list of EFFECT_LISTS) {
            // In the console new lines fail a step, elsewhere missing ones: so there taking lines in weakens, elsewhere removing.
            if (list === 'console') {
                if (failLists.includes(list)) accepted.push(...added(entry.console, fresh.console).map((line) => `${entry.action}: ${line}`));
                continue;
            }
            if (!sameExpect) continue;
            const gone = (entry[list] ?? []).filter((line) => !(fresh[list] ?? []).includes(line));
            const fresher = added(entry[list], fresh[list]);
            const lines = (from) => from.map((line) => `${entry.action} ${list}: ${line}`);
            if (gone.length > 0 && fresher.length > 0) {
                replaced.was.push(...lines(gone));
                replaced.now.push(...lines(fresher));
            } else removed.push(...lines(gone));
        }
    }
    return [
        ...(removed.length === 0 ? [] : [finding('effects-removed', 'weakening', { ...at, before: removed, vars: { lines: listed(removed) } })]),
        ...(accepted.length === 0 ? [] : [finding('effects-accepted', 'weakening', { ...at, after: accepted, vars: { lines: listed(accepted) } })]),
        ...(replaced.was.length === 0 ? [] : [finding('effects-replaced', 'listed', { ...at, before: replaced.was, after: replaced.now, vars: { was: listed(replaced.was), now: listed(replaced.now) } })]),
    ];
};

/** The page messages a run watches: the config's, else the framework's, else the default. */
const messageSelectors = (config) => config?.messageSelectors ?? frameworkOf(config ?? {}).messageSelectors ?? DEFAULT_MESSAGE_SELECTORS;
const effectFail = (config) => config?.effects?.fail ?? DEFAULT_EFFECT_FAIL;
const designFail = (config) => config?.design?.fail ?? DEFAULT_DESIGN_FAIL;

const configChanges = (finding, before, after) => {
    if (before === null || after === null) return [];
    const out = [];
    const at = { test: null };
    // visualIgnore leaves areas out of every look (styles and image), readyIgnore lets a step go on while they still load.
    const lists = [['consoleIgnore', 'config-console-ignore'], ['foreignCode', 'config-foreign-code'], ['reads', 'config-reads'], ['visualIgnore', 'config-visual-ignore'], ['readyIgnore', 'config-ready-ignore']];
    for (const [key, kind] of lists) {
        const more = added(before[key], after[key]);
        if (more.length > 0) out.push(finding(kind, 'weakening', { ...at, before: before[key], after: after[key], vars: { list: listed(more) } }));
    }
    const watched = messageSelectors(after);
    const unwatched = messageSelectors(before).filter((selector) => !watched.includes(selector));
    if (unwatched.length > 0) out.push(finding('config-message-selectors', 'weakening', { ...at, before: messageSelectors(before), after: watched, vars: { list: listed(unwatched) } }));
    const failing = effectFail(after);
    const notFailing = effectFail(before).filter((list) => !failing.includes(list));
    if (notFailing.length > 0) out.push(finding('config-effects-fail', 'weakening', { ...at, before: effectFail(before), after: failing, vars: { list: listed(notFailing) } }));
    const designFailing = designFail(after);
    const designWarning = designFail(before).filter((kind) => !designFailing.includes(kind));
    if (designWarning.length > 0) out.push(finding('config-design-fail', 'weakening', { ...at, before: designFail(before), after: designFailing, vars: { list: listed(designWarning) } }));
    const guarded = guardedChanges(before, after);
    if (guarded.length > 0) out.push(finding('config-guarded', 'weakening', { ...at, after: guarded, vars: { list: listed(guarded) } }));
    return out;
};

/**
 * What changed between two states of the test data that a reviewer has to see. Pure: both sides as readProjectData returns them.
 * Texts in the current language (the caller picks the team language).
 * @returns findings [{ id, kind, severity: 'weakening'|'listed'|'info', test, step?, before?, after?, text }], weakenings first
 */
export const auditChanges = (before, after) => {
    const findings = [];
    const finding = (kind, severity, { test, step, expect, number, before: was, after: now, vars = {} }) => {
        const id = [kind, test ?? CONFIG_FILE, step, number].filter((part) => part !== undefined).join(':');
        const text = t(`cli.audit.kind.${kind}`, { test, step, expect, ...vars });
        return { id, kind, severity, test, ...(step === undefined ? {} : { step }), ...(was === undefined ? {} : { before: was }), ...(now === undefined ? {} : { after: now }), text };
    };
    const unreadable = new Set(after.unreadable ?? []);
    for (const path of unreadable) findings.push(finding('unreadable', 'weakening', { test: path === CONFIG_FILE ? null : path.slice(TEST_DIR.length + 1, -'.yaml'.length), vars: { path } }));
    const failLists = effectFail(before.config);
    for (const [test, old] of before.tests) {
        const spec = after.tests.get(test);
        if (spec === undefined) {
            if (!unreadable.has(`${TEST_DIR}/${test}.yaml`)) findings.push(finding('test-removed', 'weakening', { test }));
            continue;
        }
        const lost = runsOn(before.config, old).filter((name) => !runsOn(after.config, spec).includes(name));
        if (lost.length > 0) findings.push(finding('environments-narrowed', 'weakening', { test, before: runsOn(before.config, old), after: runsOn(after.config, spec), vars: { list: lost.join(', ') } }));
        const known = added(old.knownMessages, spec.knownMessages);
        if (known.length > 0) findings.push(finding('known-messages-added', 'weakening', { test, before: old.knownMessages, after: spec.knownMessages, vars: { list: listed(known) } }));
        const steps = pairSteps(old.steps, spec.steps);
        const step = (s, more = {}) => ({ test, step: s.id, expect: s.expect, ...more });
        for (const removed of steps.removed) findings.push(finding('step-removed', 'weakening', step(removed, { before: removed })));
        for (const fresh of steps.added) findings.push(finding('step-added', 'listed', step(fresh, { after: fresh })));
        for (const pair of steps.pairs) {
            const checkBefore = pair.before.recording?.check;
            const checkAfter = pair.after.recording?.check;
            if (pair.sameExpect) {
                // keptCheck: an unchanged expected result keeps its check; any old step with that expected result may own it.
                const owners = old.steps.filter((candidate) => candidate.recording !== undefined && candidate.expect === pair.after.expect);
                if (checkAfter !== undefined && owners.length > 0 && !owners.some((owner) => owner.recording.check === checkAfter)) {
                    findings.push(finding('check-changed', 'weakening', step(pair.after, { before: checkBefore ?? owners[0].recording.check, after: checkAfter })));
                }
            } else {
                const withCheck = checkBefore !== undefined && checkAfter !== undefined && checkBefore !== checkAfter;
                findings.push(finding(withCheck ? 'expect-changed-check' : 'expect-changed', 'listed', step(pair.after, {
                    before: withCheck ? { expect: pair.before.expect, check: checkBefore } : pair.before.expect,
                    after: withCheck ? { expect: pair.after.expect, check: checkAfter } : pair.after.expect,
                    vars: { was: pair.before.expect },
                })));
            }
            findings.push(...stepChanges((kind, severity, fields) => finding(kind, severity, { test, ...fields }), pair, failLists, { before: before.designs, after: after.designs }));
        }
    }
    for (const test of after.tests.keys()) if (!before.tests.has(test)) findings.push(finding('test-added', 'listed', { test }));
    findings.push(...configChanges(finding, before.config, after.config));
    return findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
};

/** The design files the steps of these tests link, as the steps name them (relative to the caw folder). */
const linkedDesigns = (tests) => [...tests.values()].flatMap(({ steps }) => steps.map(({ design }) => design)).filter(isDesignName);
const hashOf = (data) => createHash('sha256').update(data).digest('hex');

/**
 * Reads both sides and compares them. Besides the test data, the design files a step links on either side, as hashes
 * (`designs`: Map name -> hash, a missing file left out): a replaced design changes what its step is judged against.
 * @returns { base, before, after }
 */
export const auditProject = (root, ref) => {
    const base = mergeBase(root, ref);
    const before = readProjectData(readAtCommit(root, base, auditFiles(root, base)));
    const after = readProjectData(workingTreeFiles(root));
    const names = [...new Set([...linkedDesigns(before.tests), ...linkedDesigns(after.tests)])];
    const atBase = readAtCommit(root, base, names.map((name) => `${PROJECT_DIR}/${name}`), { raw: true });
    before.designs = new Map(names.filter((name) => atBase.has(`${PROJECT_DIR}/${name}`)).map((name) => [name, hashOf(atBase.get(`${PROJECT_DIR}/${name}`))]));
    after.designs = new Map(names.flatMap((name) => {
        const path = designPath(join(root, PROJECT_DIR), name);
        return path === null ? [] : [[name, hashOf(readFileSync(path))]];
    }));
    return { base, before, after };
};

/** Markdown that fits a backtick span: one more backtick than the longest run inside. */
const code = (value) => {
    const text = shown(value).replace(/\s*\n\s*/g, ' ');
    const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
    return `${fence}${text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text}${fence}`;
};

/** The findings as Markdown for a PR comment, in the current language. */
export const renderAudit = ({ ref, base, findings }) => {
    const lines = [`## ${t('cli.audit.title', { ref, base: base.slice(0, 10) })}`, ''];
    if (findings.length === 0) return [...lines, t('cli.audit.unchanged'), ''].join('\n');
    const weakened = findings.filter(({ severity }) => severity === 'weakening').length;
    lines.push(weakened === 0 ? t('cli.audit.ok') : t('cli.audit.weakened', { count: weakened }), '');
    for (const severity of SEVERITIES) {
        const group = findings.filter((entry) => entry.severity === severity);
        if (group.length === 0) continue;
        lines.push(`### ${t(`cli.audit.section.${severity}`)} (${group.length})`, '');
        for (const entry of group) {
            lines.push(`- ${code(entry.test ?? CONFIG_FILE)}: ${entry.text}`);
            if (['check-changed', 'expect-changed-check'].includes(entry.kind)) {
                lines.push(`  - ${t('cli.audit.before')}: ${code(entry.before?.check ?? entry.before)}`, `  - ${t('cli.audit.after')}: ${code(entry.after?.check ?? entry.after)}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
};

/** `caw audit <ref> [--json]`: exit 0 nothing weakened, 1 weakenings, 3 bad ref or no git. */
export const auditCommand = (root, args, { print = (text) => process.stdout.write(`${text}\n`) } = {}) => {
    const unknown = args.find((arg) => arg.startsWith('-') && arg !== '--json');
    if (unknown !== undefined) throw new CawError('usage', t('cli.audit.unknownArg', { arg: unknown }));
    const refs = args.filter((arg) => !arg.startsWith('-'));
    if (refs.length !== 1) throw new CawError('usage', t('cli.audit.refMissing'));
    const [ref] = refs;
    const { base, before, after } = auditProject(root, ref);
    // The comment is for the team: its language, like report.md.
    const result = inLanguage(teamLanguage(after.config ?? before.config), () => {
        const findings = auditChanges(before, after);
        return { findings, markdown: renderAudit({ ref, base, findings }) };
    });
    const weakened = result.findings.filter(({ severity }) => severity === 'weakening').length;
    print(args.includes('--json') ? JSON.stringify({ ref, base, weakened, findings: result.findings }, null, 2) : result.markdown);
    return weakened > 0 ? EXIT.fail : EXIT.pass;
};
