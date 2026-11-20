// The spike's caw project around app.mjs: a config with the two environments and one hand-written test with its recording
// (recorded on a), written as `record` writes it. The recording carries no baselines and no effects: the capture's raw runs
// never learn, so every run is an unbiased observation the methods in methods.mjs learn from offline.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseTest, stepHash, writeTest } from '../../src/host/test-file.mjs';
import { SPIKE_PORT } from './app.mjs';

export const TEST_ID = 'spike-errand';
export const RECORDED_ON = 'a';

export const spikeConfig = (port = SPIKE_PORT) => ({
    language: 'en',
    framework: 'web',
    start: '/',
    environments: {
        a: { url: `http://a.localhost:${port}`, agent: true, writable: true },
        b: { url: `http://b.localhost:${port}`, writable: true },
    },
    signIn: { type: 'form', path: '/login', userSelector: '#user', passwordSelector: '#password', submitSelector: '[data-testid="login"]', signedInSelector: '[data-testid="user-menu"]' },
    roles: { user: {} },
});

// Fictitious account of app.mjs.
const ENV_FILE = ['CAW_USER_USER=demo', 'CAW_USER_PASSWORD=demo'].join('\n');

const role = (kind, name) => `getByRole('${kind}', { name: '${name}', exact: true })`;
/** The errand journey of examples/errand: add, find, tick off, plan. */
export const STEPS = [
    {
        id: 'S1', name: 'Add a todo', do: 'Add the todo "Feed the raven {{runTag}}" with the tag "#home".', expect: 'A confirmation shows the number of the new todo, and it is at the top of the list.',
        actions: [
            { click: role('button', 'New todo'), path: '/' },
            { fill: role('textbox', 'Title'), value: 'Feed the raven {{runTag}}', path: '/' },
            { fill: role('combobox', 'Tag'), value: 'home', path: '/' },
            { click: role('button', 'Add todo'), path: '/' },
            { 'wait-ready': {} },
            { remember: { name: 'nr', code: "(document.querySelector('[role=status]').textContent.match(/#([0-9]+)/)||[])[1]" } },
        ],
        check: "/^Added #[0-9]+$/.test(document.querySelector('[role=status]').textContent.trim()) && document.querySelector('#list li .title').textContent==='Feed the raven {{runTag}}'",
    },
    {
        id: 'S2', name: 'Find it', do: 'Search the list for "{{runTag}}".', expect: 'Exactly one todo is listed, tagged "#home" and not done.',
        actions: [{ fill: role('searchbox', 'Search todos'), value: '{{runTag}}', path: '/' }, { 'wait-ready': {} }],
        check: "(()=>{const li=[...document.querySelectorAll('#list li')];return li.length===1 && li[0].querySelector('.chip').textContent==='#home' && !li[0].classList.contains('done');})()",
    },
    {
        id: 'S3', name: 'Tick it off', do: 'Tick the todo off.', expect: 'It is struck through and the progress counts it as done.',
        actions: [{ click: role('button', 'Complete Feed the raven {{runTag}}'), path: '/' }, { 'wait-ready': {} }],
        check: "(()=>{const li=document.querySelector('#list li');return !!li && li.classList.contains('done') && document.getElementById('progress').textContent==='1/1';})()",
    },
    {
        id: 'S4', name: 'Plan it', do: 'Open the todo and move it to "Tomorrow".', expect: 'The todo shows "When: Tomorrow".',
        actions: [
            { click: role('link', 'Feed the raven {{runTag}}'), path: '/' },
            { 'wait-ready': {} },
            { fill: role('combobox', 'Move to'), value: 'Tomorrow', path: '/todos/{{nr}}' },
            { click: role('button', 'Save'), path: '/todos/{{nr}}' },
            { 'wait-ready': {} },
        ],
        check: "document.getElementById('when').textContent==='Tomorrow'",
    },
];

/** The single-file text of the test with its recording, as parseTest reads it. */
export const testText = () => {
    const lines = [`id: ${TEST_ID}`, 'role: user', 'writes: true', 'environments: [a, b]', 'steps:'];
    STEPS.forEach((step, index) => {
        const plain = { id: step.id, name: step.name, do: step.do, expect: step.expect };
        lines.push(
            `  - id: ${step.id}`, `    name: ${JSON.stringify(step.name)}`, `    do: ${JSON.stringify(step.do)}`, `    expect: ${JSON.stringify(step.expect)}`,
            '    recording:', `      hash: ${stepHash(plain)}`, ...(index === 0 ? [] : [`      after: ${STEPS[index - 1].id}`]),
            `      recordedOn: ${RECORDED_ON}`, '      recordedAt: 2026-11-20T10:00:00.000Z', '      locale: en-US', '      timezone: Europe/Berlin',
            '      viewport: { width: 1280, height: 800 }',
            '      actions:', ...step.actions.map((action) => `        - ${JSON.stringify(action)}`),
            `      check: ${JSON.stringify(step.check)}`,
        );
    });
    lines.push('knownMessages:', '  - "Added ##"', '  - Moved to Tomorrow', '  - Nice.');
    return `${lines.join('\n')}\n`;
};

/** The parsed test: the base the simulation renders recordings from (churn). */
export const spikeSpec = () => ({ ...parseTest(testText(), TEST_ID), id: TEST_ID });

/** Writes the whole project into root, replacing config, test, recording and earlier runs. */
export const writeProject = (root, port = SPIKE_PORT) => {
    rmSync(join(root, '.caw'), { recursive: true, force: true });
    rmSync(join(root, 'caw'), { recursive: true, force: true });
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    writeFileSync(join(root, 'caw.config.json'), `${JSON.stringify(spikeConfig(port), null, 4)}\n`);
    writeFileSync(join(root, 'caw/.env'), `${ENV_FILE}\n`);
    writeTest(root, spikeSpec());
};
