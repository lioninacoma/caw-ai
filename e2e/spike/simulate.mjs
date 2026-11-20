// Replays the captured runs (capture.mjs JSONL) through every method of methods.mjs as seeded bootstrap sequences and writes a
// Markdown report with one table per metric and the decision rule, which is fixed here before any data is seen.
//
//   node e2e/spike/simulate.mjs [--in e2e/spike/data/capture.jsonl] [--out e2e/spike/data/report.md]
//                               [--sequences 500] [--length 30] [--seed 1] [--creep-length 100] [--methods M0,M1,...]
//
// A sequence is `length` runs drawn with replacement from the healthy runs of the recording environment; at a random run r
// a regression of one kind starts and stays (later runs are drawn from that kind). Modes: dev (every run learns, as outside
// CI) and ci (a warm-up of dev runs learns, then the sequence never learns, as in CI without --learn).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderRecordings } from '../../src/host/test-file.mjs';
import { REGRESSIONS, REGRESSION_SIDE, REGRESSION_STEP, seeded } from './app.mjs';
import { METHODS, diagnoseRun, initState, judgeRun, learnRun, persisted } from './methods.mjs';
import { RECORDED_ON, spikeSpec } from './project.mjs';

/** Pre-registered decision rule (owner's proposal, plan P2): fixed before the data. */
export const RULE = {
    maxFalseFailuresPer100: 1,
    minDetection: 0.95,
    detectionKinds: ['control-disabled', 'control-removed', 'console-error'],
    maxWritesPerRun: 1 / 20,
    // Writes count in steady state: from this run of a dev sequence on, after every method's learning phase.
    steadyFrom: 10,
};
const ABSORB_AFTER = 5;
const WARM_RUNS = 10;
const CREEP_FACTOR = 1.05;
const CROSS_OPTIONS = ['today', 'a', 'b', 'c'];
const CROSS_LABEL = {
    today: 'today: learned on a, compared on b',
    a: '(a) compare only where learned',
    b: '(b) learn per environment',
    c: '(c) effects.fail [] on other environments',
};

/** The captured runs; lines that do not parse are skipped (a capture killed mid-write). */
export const loadRows = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    try {
        return [JSON.parse(line)];
    } catch {
        return [];
    }
});

/** Healthy runs and regression runs per environment and kind. */
export const poolsOf = (rows) => {
    const pools = { healthy: {}, regression: {} };
    for (const row of rows) {
        if (row.kind === 'healthy') (pools.healthy[row.env] ??= []).push(row);
        else ((pools.regression[row.env] ??= {})[row.kind] ??= []).push(row);
    }
    return pools;
};

const pick = (random, list) => list[Math.floor(random() * list.length)];

/** The same sequences for every method, so methods are compared on identical runs. */
export const makeSequences = (pools, { sequences, length, seed, env = RECORDED_ON, kinds }) => {
    const random = seeded(seed);
    const healthy = pools.healthy[env] ?? [];
    const available = kinds.filter((kind) => (pools.regression[env]?.[kind] ?? []).length > 0);
    if (healthy.length === 0) return [];
    return Array.from({ length: sequences }, (_, index) => {
        const kind = available.length === 0 ? null : available[index % available.length];
        // Late enough that every method has learned, early enough that absorption over five more runs is visible.
        const at = kind === null ? length : Math.min(length - ABSORB_AFTER - 1, 10 + Math.floor(random() * 15));
        const runs = Array.from({ length }, (__, run) => (run < at ? pick(random, healthy) : pick(random, pools.regression[env][kind])));
        const warm = Array.from({ length: WARM_RUNS }, () => pick(random, healthy));
        return { kind, at, runs, warm };
    });
};

/** A run with every request duration scaled: the creep variant. */
const slowedBy = (row, factor) => ({
    ...row,
    steps: row.steps.map((step) => ({ ...step, requests: step.requests?.map((request) => ({ ...request, ms: Math.round((request.ms ?? 0) * factor) })) })),
});

/** Changed lines between two renderings: lines only in one of them, counted with multiplicity. */
export const changedLines = (before, after) => {
    const counts = new Map();
    for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of after.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1);
    return [...counts.values()].reduce((sum, count) => sum + Math.abs(count), 0);
};

/** Renders what the method keeps as caw/recordings/<test>.yaml, so churn is measured on the real file format. */
const renderer = () => {
    const spec = spikeSpec();
    // Rendering YAML is the expensive part: the same kept state renders once.
    let lastKey = null;
    let lastText = null;
    return (method, state) => {
        const kept = persisted(method, state);
        const key = JSON.stringify(kept);
        if (key === lastKey) return lastText;
        lastKey = key;
        lastText = renderRecordings({
            ...spec,
            steps: spec.steps.map((step) => ({ ...step, recording: { ...step.recording, ...(kept[step.id] ?? {}) } })),
        });
        return lastText;
    };
};

/**
 * Is the injected fault flagged where it is, i.e. does its step fail, warn or flag a slow request? A warning elsewhere is
 * noise, not a detection; a false failure before the step hides the fault. slow4x hits every step.
 * @returns { fail, flag }
 */
export const flaggedFor = (judgment, kind) => {
    const at = REGRESSION_STEP[kind];
    if (at === null || at === undefined) return { fail: judgment.failed !== null, flag: judgment.failed !== null || judgment.slowFlags > 0 };
    const verdict = judgment.steps.find(({ id }) => id === at);
    const fail = verdict?.status === 'fail';
    return { fail, flag: fail || verdict?.warn === true || (verdict?.slow?.length ?? 0) > 0 };
};

const emptyTally = () => ({
    healthy: 0, effectFails: 0, productFails: 0, warnings: 0, slowFlags: 0,
    kinds: {}, writes: 0, steadyWrites: 0, steadyRuns: 0, runs: 0, lines: 0,
});

/** Runs one method over the sequences in one mode and tallies every metric of the report. */
export const runMode = (method, sequenceList, { mode, render }) => {
    const tally = emptyTally();
    const diagnosis = [];
    for (const sequence of sequenceList) {
        let state = initState();
        if (mode === 'ci') for (const row of sequence.warm) state = learnRun(method, state, row, judgeRun(method, state, row));
        let shown = render(method, state);
        const flags = [];
        sequence.runs.forEach((row, index) => {
            const judgment = judgeRun(method, state, row);
            const healthy = index < sequence.at;
            const found = sequence.kind === null ? { fail: false, flag: false } : flaggedFor(judgment, sequence.kind);
            flags.push(found.flag);
            if (healthy) {
                tally.healthy += 1;
                if (judgment.failedBy === 'effect') tally.effectFails += 1;
                if (judgment.failedBy === 'product') tally.productFails += 1;
                tally.warnings += judgment.warnings;
                tally.slowFlags += judgment.slowFlags;
            } else if (index === sequence.at) {
                const kind = (tally.kinds[sequence.kind] ??= { n: 0, fail: 0, failOrWarn: 0, absorbedOf: 0, absorbed: 0 });
                kind.n += 1;
                if (found.fail) kind.fail += 1;
                if (found.flag) kind.failOrWarn += 1;
                diagnosis.push({ kind: sequence.kind, side: diagnoseRun(method, state, row, judgment)?.side ?? 'passed' });
            }
            if (mode === 'dev') {
                state = learnRun(method, state, row, judgment);
                const now = render(method, state);
                tally.runs += 1;
                if (index >= RULE.steadyFrom) tally.steadyRuns += 1;
                if (now !== shown) {
                    tally.writes += 1;
                    tally.lines += changedLines(shown, now);
                    if (index >= RULE.steadyFrom) tally.steadyWrites += 1;
                    shown = now;
                }
            }
        });
        // Absorbed: flagged when the regression arrived, silent five runs later although it is still there.
        if (sequence.kind !== null && flags[sequence.at]) {
            const kind = tally.kinds[sequence.kind];
            kind.absorbedOf += 1;
            if (!flags[sequence.at + ABSORB_AFTER]) kind.absorbed += 1;
        }
    }
    return { tally, diagnosis };
};

/** Creep: from run 10 every request gets 5% slower per run. Returns the run (counted from the start of creep) it was first flagged, or null. */
export const runCreep = (method, pools, { sequences, length, seed, mode }) => {
    const random = seeded(seed + 7);
    const healthy = pools.healthy[RECORDED_ON] ?? [];
    const found = [];
    for (let index = 0; index < sequences && healthy.length > 0; index += 1) {
        let state = initState();
        if (mode === 'ci') for (let warm = 0; warm < WARM_RUNS; warm += 1) {
            const row = pick(random, healthy);
            state = learnRun(method, state, row, judgeRun(method, state, row));
        }
        let detected = null;
        for (let run = 0; run < length && detected === null; run += 1) {
            const creep = Math.max(0, run - WARM_RUNS + 1);
            const row = slowedBy(pick(random, healthy), CREEP_FACTOR ** creep);
            const judgment = judgeRun(method, state, row);
            if (creep > 0 && judgment.slowFlags > 0) detected = creep;
            if (mode === 'dev') state = learnRun(method, state, row, judgment);
        }
        found.push(detected);
    }
    return found;
};

/** Cross-environment: learned on a, judged on b under each option. */
export const runCross = (method, pools, { sequences, length, seed, kinds }) => {
    const onB = makeSequences(pools, { sequences, length, seed: seed + 13, env: 'b', kinds });
    const healthyA = pools.healthy[RECORDED_ON] ?? [];
    const result = {};
    for (const option of CROSS_OPTIONS) {
        const tally = { healthy: 0, effectFails: 0, warnings: 0, slowFlags: 0, kinds: {} };
        const random = seeded(seed + 17);
        for (const sequence of onB) {
            let learnedOnA = initState();
            for (let warm = 0; warm < WARM_RUNS && healthyA.length > 0; warm += 1) {
                const row = pick(random, healthyA);
                learnedOnA = learnRun(method, learnedOnA, row, judgeRun(method, learnedOnA, row));
            }
            let own = initState();
            sequence.runs.forEach((row, index) => {
                const ctx = option === 'a' ? { compare: false } : option === 'c' ? { fail: [] } : {};
                const state = option === 'b' ? own : learnedOnA;
                const judgment = judgeRun(method, state, row, ctx);
                if (option === 'b') own = learnRun(method, own, row, judgment);
                if (index < sequence.at) {
                    tally.healthy += 1;
                    if (judgment.failedBy === 'effect') tally.effectFails += 1;
                    tally.warnings += judgment.warnings;
                    tally.slowFlags += judgment.slowFlags;
                } else if (index === sequence.at) {
                    const kind = (tally.kinds[sequence.kind] ??= { n: 0, fail: 0, failOrWarn: 0 });
                    const found = flaggedFor(judgment, sequence.kind);
                    kind.n += 1;
                    if (found.fail) kind.fail += 1;
                    if (found.flag) kind.failOrWarn += 1;
                }
            });
        }
        result[option] = tally;
    }
    return result;
};

/**
 * The whole simulation.
 * @returns { methods: { id: { dev, ci, creepDev, creepCi, cross } }, meta }
 */
export const simulate = (rows, { sequences = 500, length = 30, seed = 1, creepLength = 100, methods = Object.keys(METHODS), kinds = REGRESSIONS } = {}) => {
    const pools = poolsOf(rows);
    const sequenceList = makeSequences(pools, { sequences, length, seed, kinds });
    const render = renderer();
    const out = {};
    for (const id of methods) {
        const method = METHODS[id];
        out[id] = {
            dev: runMode(method, sequenceList, { mode: 'dev', render }),
            ci: runMode(method, sequenceList, { mode: 'ci', render }),
            creepDev: runCreep(method, pools, { sequences, length: creepLength, seed, mode: 'dev' }),
            creepCi: runCreep(method, pools, { sequences, length: creepLength, seed, mode: 'ci' }),
            cross: (pools.healthy.b ?? []).length === 0 ? null : runCross(method, pools, { sequences, length, seed, kinds }),
        };
    }
    const counts = Object.fromEntries(Object.entries(pools.healthy).map(([env, list]) => [env, list.length]));
    const regressionCounts = Object.fromEntries(Object.entries(pools.regression).map(([env, byKind]) => [env, Object.fromEntries(Object.entries(byKind).map(([kind, list]) => [kind, list.length]))]));
    return { methods: out, meta: { sequences, length, seed, creepLength, rows: rows.length, healthy: counts, regressions: regressionCounts } };
};

// ---- Report

const pct = (part, whole) => (whole === 0 ? 'n/a' : `${(100 * part / whole).toFixed(1)}%`);
const per100 = (part, whole) => (whole === 0 ? 'n/a' : (100 * part / whole).toFixed(2));
const perRun = (part, whole) => (whole === 0 ? 'n/a' : (part / whole).toFixed(3));
const table = (head, lines) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...lines.map((line) => `| ${line.join(' | ')} |`)].join('\n');

/** Detection share over the rule's kinds; null if none of them was captured. */
const detectionOf = (tally) => {
    const kinds = RULE.detectionKinds.map((kind) => tally.kinds[kind]).filter((kind) => kind !== undefined);
    const n = kinds.reduce((sum, kind) => sum + kind.n, 0);
    return n === 0 ? null : kinds.reduce((sum, kind) => sum + kind.failOrWarn, 0) / n;
};

/** The decision rule per method: each criterion and the overall verdict. */
export const decide = (result) => Object.fromEntries(Object.entries(result.methods).map(([id, { dev, ci }]) => {
    const ff = Math.max(...[dev, ci].map(({ tally }) => (tally.healthy === 0 ? 0 : 100 * tally.effectFails / tally.healthy)));
    const detection = [dev, ci].map(({ tally }) => detectionOf(tally));
    const minDetection = detection.includes(null) ? null : Math.min(...detection);
    const writes = dev.tally.steadyRuns === 0 ? 0 : dev.tally.steadyWrites / dev.tally.steadyRuns;
    const checks = {
        falseFailures: ff <= RULE.maxFalseFailuresPer100,
        detection: minDetection !== null && minDetection >= RULE.minDetection,
        writes: writes <= RULE.maxWritesPerRun,
    };
    return [id, { ff, minDetection, writes, checks, passes: Object.values(checks).every(Boolean) }];
}));

export const renderReport = (result) => {
    const ids = Object.keys(result.methods);
    const kinds = [...new Set(ids.flatMap((id) => Object.keys(result.methods[id].dev.tally.kinds)))];
    const verdicts = decide(result);
    const { meta } = result;
    const lines = [
        '# Baseline-learning spike: report',
        '',
        `${meta.rows} captured runs; healthy per environment: ${Object.entries(meta.healthy).map(([env, n]) => `${env} ${n}`).join(', ') || 'none'}; `
        + `regression runs: ${Object.entries(meta.regressions).map(([env, byKind]) => `${env} ${Object.values(byKind).reduce((a, b) => a + b, 0)}`).join(', ') || 'none'}. `
        + `${meta.sequences} sequences of ${meta.length} runs per mode, seed ${meta.seed}; creep sequences of ${meta.creepLength} runs.`,
        '',
        'Methods: ' + ids.map((id) => `${id} (${METHODS[id].label})`).join(', ') + '.',
        '',
        '## Decision rule (pre-registered)',
        '',
        `A method passes if, in dev and in CI mode, it has at most ${RULE.maxFalseFailuresPer100} false failure per 100 healthy runs (effect failures; `
        + `check failures are the product's and the same for every method), detects at least ${RULE.minDetection * 100}% of ${RULE.detectionKinds.join(', ')} `
        + `within one run (fail or warn), and writes the recording at most once per ${1 / RULE.maxWritesPerRun} runs in dev mode from run ${RULE.steadyFrom} on.`,
        '',
        table(['method', 'false failures /100 (worst mode)', 'detection (worst mode)', 'writes per run (steady)', 'passes'], ids.map((id) => {
            const verdict = verdicts[id];
            return [id, `${verdict.ff.toFixed(2)} ${verdict.checks.falseFailures ? 'ok' : 'FAIL'}`, `${verdict.minDetection === null ? 'n/a' : `${(verdict.minDetection * 100).toFixed(1)}%`} ${verdict.checks.detection ? 'ok' : 'FAIL'}`,
                `${verdict.writes.toFixed(3)} ${verdict.checks.writes ? 'ok' : 'FAIL'}`, verdict.passes ? '**yes**' : 'no'];
        })),
        '',
        '## False failures and noise in healthy runs',
        '',
        table(['method', 'mode', 'healthy runs', 'effect false failures /100', 'check failures /100 (product)', 'warnings per run', 'slow flags per run'],
            ids.flatMap((id) => ['dev', 'ci'].map((mode) => {
                const { tally } = result.methods[id][mode];
                return [id, mode, String(tally.healthy), per100(tally.effectFails, tally.healthy), per100(tally.productFails, tally.healthy), perRun(tally.warnings, tally.healthy), perRun(tally.slowFlags, tally.healthy)];
            }))),
        '',
        '## Detection within one run (fail / fail or warn)',
        '',
        'Counted at the step the fault is injected in (app.mjs REGRESSION_STEP); slow4x at any step.',
        '',
        table(['method', 'mode', ...kinds], ids.flatMap((id) => ['dev', 'ci'].map((mode) => {
            const { tally } = result.methods[id][mode];
            return [id, mode, ...kinds.map((kind) => (tally.kinds[kind] === undefined ? 'n/a' : `${pct(tally.kinds[kind].fail, tally.kinds[kind].n)} / ${pct(tally.kinds[kind].failOrWarn, tally.kinds[kind].n)}`))];
        }))),
        '',
        `## Regressions absorbed within ${ABSORB_AFTER} runs (dev mode)`,
        '',
        `Of the regressions flagged when they arrived: the share no longer flagged ${ABSORB_AFTER} runs later, although still present.`,
        '',
        table(['method', ...kinds], ids.map((id) => {
            const { tally } = result.methods[id].dev;
            return [id, ...kinds.map((kind) => (tally.kinds[kind] === undefined ? 'n/a' : pct(tally.kinds[kind].absorbed, tally.kinds[kind].absorbedOf)))];
        })),
        '',
        `## Creep (+${Math.round((CREEP_FACTOR - 1) * 100)}% per run from run ${WARM_RUNS})`,
        '',
        table(['method', 'mode', 'detected within the sequence', 'median runs until detected'], ids.flatMap((id) => [['dev', 'creepDev'], ['ci', 'creepCi']].map(([mode, key]) => {
            const found = result.methods[id][key];
            const hits = found.filter((value) => value !== null).sort((a, b) => a - b);
            return [id, mode, pct(hits.length, found.length), hits.length === 0 ? 'never' : String(hits[Math.floor(hits.length / 2)])];
        }))),
        '',
        '## Churn of caw/recordings (dev mode)',
        '',
        table(['method', 'writes per run (all)', `writes per run (from run ${RULE.steadyFrom})`, 'changed lines per run'], ids.map((id) => {
            const { tally } = result.methods[id].dev;
            return [id, perRun(tally.writes, tally.runs), perRun(tally.steadyWrites, tally.steadyRuns), perRun(tally.lines, tally.runs)];
        })),
        '',
        '## Cross-environment (learned on a, compared on b)',
        '',
    ];
    const crossIds = ids.filter((id) => result.methods[id].cross !== null);
    if (crossIds.length === 0) lines.push('No healthy runs of b captured.', '');
    else {
        lines.push(
            table(['method', ...CROSS_OPTIONS.map((option) => `${CROSS_LABEL[option]}: FF /100 · warn/run · slow/run`)], crossIds.map((id) => [id, ...CROSS_OPTIONS.map((option) => {
                const tally = result.methods[id].cross[option];
                return `${per100(tally.effectFails, tally.healthy)} · ${perRun(tally.warnings, tally.healthy)} · ${perRun(tally.slowFlags, tally.healthy)}`;
            })])),
            '',
            'Detection on b (fail or warn), over all captured regression kinds of b:',
            '',
            table(['method', ...CROSS_OPTIONS.map((option) => CROSS_LABEL[option])], crossIds.map((id) => [id, ...CROSS_OPTIONS.map((option) => {
                const all = Object.values(result.methods[id].cross[option].kinds);
                const n = all.reduce((sum, kind) => sum + kind.n, 0);
                return n === 0 ? 'n/a' : pct(all.reduce((sum, kind) => sum + kind.failOrWarn, 0), n);
            })])),
            '',
        );
    }
    lines.push('## Diagnosis of injected faults (dev mode, run the fault arrived)', '');
    const sides = ['app', 'environment', 'test', 'unclear', 'passed'];
    for (const id of ids) {
        const { diagnosis } = result.methods[id].dev;
        const matrix = (truth) => sides.map((side) => String(diagnosis.filter((entry) => REGRESSION_SIDE[entry.kind] === truth && entry.side === side).length));
        const right = diagnosis.filter((entry) => entry.side === REGRESSION_SIDE[entry.kind]).length;
        const diagnosed = diagnosis.filter((entry) => entry.side !== 'passed').length;
        lines.push(`### ${id}: ${pct(right, diagnosed)} of failed runs on the right side`, '', table(['injected \\ diagnosed', ...sides], [['app fault', ...matrix('app')], ['environment fault', ...matrix('environment')]]), '');
        if (id === ids[0]) {
            lines.push(table(['kind', ...sides], kinds.map((kind) => [kind, ...sides.map((side) => String(diagnosis.filter((entry) => entry.kind === kind && entry.side === side).length))])), '');
        }
    }
    return `${lines.join('\n')}\n`;
};

const flagValue = (args, name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = process.argv.slice(2);
    const input = flagValue(args, 'in', 'e2e/spike/data/capture.jsonl');
    const output = flagValue(args, 'out', 'e2e/spike/data/report.md');
    const result = simulate(loadRows(input), {
        sequences: Number(flagValue(args, 'sequences', 500)),
        length: Number(flagValue(args, 'length', 30)),
        seed: Number(flagValue(args, 'seed', 1)),
        creepLength: Number(flagValue(args, 'creep-length', 100)),
        methods: flagValue(args, 'methods', Object.keys(METHODS).join(',')).split(','),
    });
    const report = renderReport(result);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, report);
    console.log(report);
}
