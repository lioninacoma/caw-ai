// Synthetic captured runs for the spike tests (e2e/spike): the shape capture.mjs writes, with seeded noise and every
// regression kind, so methods.mjs and simulate.mjs are tested without a browser. Not a test file itself.
import { seeded } from '../e2e/spike/app.mjs';

const TITLES = ['Call the plumber', 'Return library books', 'Plan the offsite', 'Buy oat milk', 'Fix the bike light', 'Sort the receipts'];

const request = (random, name, status, factor) => ({ name, status, ms: Math.round((120 + random() * 120 + (random() < 0.03 ? 2500 : 0)) * factor), params: [] });

/**
 * One run as capture.mjs writes it.
 * @param kind 'healthy' or a regression kind of app.mjs
 */
export const syntheticRow = (random, { env = 'a', kind = 'healthy', flickerP = 0.3 } = {}) => {
    const factor = (env === 'b' ? 2 : 1) * (kind === 'slow4x' ? 4 : 1);
    const titles = TITLES.filter(() => random() < 0.4);
    const flicker = random() < flickerP;
    const dialog = [
        '+ textbox "Title" empty', '+ combobox "Tag" filled',
        kind === 'control-disabled' ? '+ combobox "When" disabled,filled' : '+ combobox "When" filled',
        ...(kind === 'control-removed' ? [] : ['+ button "Cancel"']), '+ button "Add todo" disabled',
    ];
    const s1 = {
        id: 'S1', status: 'pass', seconds: 2,
        requests: [request(random, 'POST /api/todos', 201, factor), ...(kind === 'request-missing' ? [] : [request(random, 'POST /api/activity', 201, factor)])],
        effects: [
            { action: 1, controls: dialog, view: ['+ - dialog "New todo":', '+ - heading "New todo" [level=#]'] },
            { action: 4, controls: dialog.map((line) => `-${line.slice(1)}`), requests: ['POST /api/todos 201', ...(kind === 'request-missing' ? [] : ['POST /api/activity 201'])] },
        ],
    };
    const s2 = {
        id: 'S2', status: 'pass', seconds: 1,
        requests: [request(random, 'GET /api/todos', 200, factor)],
        // The list's rows drop out of the view when the search filters them: data-dependent lines (the D7 case).
        effects: [{ action: 1, ...(flicker ? { controls: ['+ button "Dismiss"'] } : {}), view: [...titles.map((title) => `- - button "Complete ${title}" [pressed=false]`), '- - text: Today'] }],
    };
    const s3 = {
        id: 'S3', status: 'pass', seconds: 1,
        requests: [request(random, 'PATCH /api/todos/#', 200, factor)],
        effects: [{ action: 1, view: ['+ - text: Nice.'], ...(kind === 'console-error' ? { console: ['Progress sync failed for todo #'] } : {}) }],
    };
    const failing = { app500: 500, gateway503: 503 }[kind];
    const save = kind === 'reset' ? { name: 'PATCH /api/todos/#', status: 'failed (net::ERR_EMPTY_RESPONSE)', ms: 130 }
        : request(random, 'PATCH /api/todos/#', failing ?? 200, factor);
    const s4 = {
        id: 'S4',
        status: failing !== undefined || kind === 'reset' ? 'fail' : 'pass',
        ...(failing !== undefined || kind === 'reset' ? { kind: 'check' } : {}),
        seconds: 2,
        requests: [request(random, 'GET /api/todos/#', 200, factor), save],
        effects: [
            {
                action: 1,
                view: ['+ - heading "#### Feed the raven" [level=#]', `+ - paragraph: "#home · ${kind === 'view-text' ? 'Pending' : 'Open'} · When:"`],
                responses: [kind === 'response-shape' ? 'GET /api/todos/# form 2b2b2b2b2b' : 'GET /api/todos/# form 1a1a1a1a1a'],
            },
            ...(failing === undefined && kind !== 'reset' ? [{ action: 4, view: ['+ - text: Moved to Tomorrow'] }] : []),
        ],
    };
    return {
        v: 1, env, kind, mode: 'raw', profile: { regression: kind === 'healthy' ? null : kind },
        exit: s4.status === 'fail' ? 1 : 0,
        steps: [s1, s2, s3, s4],
        results: [s1, s2, s3, s4].map(({ id, status }) => ({ id, status, ...(status === 'fail' ? { note: 'The check was not met.' } : {}) })),
        failures: [],
        rows: [...titles, 'Feed the raven CAW-x'],
    };
};

/** A capture: healthy runs on a and b, `regressions` runs per kind on a. */
export const syntheticRows = ({ seed = 1, healthy = 60, regressions = 10, kinds } = {}) => {
    const random = seeded(seed);
    const all = kinds ?? ['control-disabled', 'control-removed', 'console-error', 'request-missing', 'response-shape', 'view-text', 'slow4x', 'app500', 'gateway503', 'reset'];
    return [
        ...Array.from({ length: healthy }, () => syntheticRow(random, { env: 'a' })),
        ...Array.from({ length: healthy }, () => syntheticRow(random, { env: 'b' })),
        ...all.flatMap((kind) => Array.from({ length: regressions }, () => syntheticRow(random, { env: 'a', kind }))),
    ];
};
