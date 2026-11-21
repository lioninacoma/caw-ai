#!/usr/bin/env node
// Stands in for the agent in the README media (scripts/capture-media.mjs): the same plan, clicks and answers every time, at the
// pace of the commands themselves, so the media can be recorded again and again without tokens and show the same.
// It runs as the run's agent on the host, in the project folder, and drives the browser with `caw agent`, as the real agent does.
//
//   media-agent.mjs [demo|develop|cause|reproduce|plan-it|idle]
//
// The answers name real places in the example's server.mjs, found in the file at hand: the search there really compares the
// title only, and BREAK (applied by capture-media before the failing run) really refuses long titles.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The line the regression adds to server.mjs, below the validation of a new todo. */
const LIMIT = "            if (data.title.length > 20) return json(500, { error: 'value too long for column title' });\n";
const VALIDATION = "            if (!data.title?.trim() || !TAGS.includes(data.tag)) return json(400, { error: 'title and tag required' });\n";
/**
 * The regression for the failing run: new todos with a title over 20 characters get HTTP 500, as from a database column made
 * too narrow. "Feed the raven CAW-…" is longer, so S1 of first-errand fails on the app.
 * @param text server.mjs as checked in (LF or CRLF)
 */
export const BREAK = (text) => {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const anchor = VALIDATION.replace('\n', eol);
    if (!text.includes(anchor)) throw new Error('server.mjs: the validation of a new todo is not where BREAK expects it');
    return text.replace(anchor, `${anchor}${LIMIT.replace('\n', eol)}`);
};

const BIN = fileURLToPath(new URL('../bin/caw.mjs', import.meta.url));
const caw = (...args) => {
    const done = spawnSync(process.execPath, [BIN, 'agent', ...args], { encoding: 'utf8', env: process.env });
    if (done.status !== 0) throw new Error(`caw agent ${args[0]}: ${done.stdout}${done.stderr}`);
    return done.stdout;
};
let work = null;
const file = (name, text) => {
    work ??= mkdtempSync(join(tmpdir(), 'caw-media-agent-'));
    const path = join(work, name);
    writeFileSync(path, text);
    return path;
};
const role = (kind, name) => `getByRole('${kind}', { name: '${name}', exact: true })`;
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
/** Waits in the chat until the human ends it (a button or the closed window). */
const untilEnded = () => {
    for (;;) {
        try {
            if (/"ended":\s*true/.test(caw('chat'))) return;
        } catch {
            return;
        }
    }
};
/** `server.mjs:<line>` of the first line that contains `snippet`, in the project the agent runs in. */
const lineOf = (snippet) => {
    const lines = readFileSync(join(process.cwd(), 'server.mjs'), 'utf8').split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes(snippet));
    if (index === -1) throw new Error(`server.mjs has no line with ${snippet}`);
    return `server.mjs:${index + 1}`;
};
const runTagOf = (task) => task.match(/CAW-[0-9]+/)[0];

const SEARCH = 't.title.toLowerCase().includes(q)';

const modes = {
    // A new test described in the chat: the plan, then the steps in the app.
    demo: () => {
        const runTag = runTagOf(caw('task'));
        const title = `Feed the raven ${runTag}`;
        const first = "document.querySelector('#list li')";

        caw('say', 'Let me look at the app first.');
        caw('snapshot');
        caw('plan', '--file', file('plan.yaml', `notes: |-
  Someone adds a todo for tomorrow, finds it with the search and ticks it off.
steps:
  - id: S1
    name: Add a todo for tomorrow
    do: Click "New todo", enter the title "Feed the raven {{runTag}}", the tag "#home" and "When" = "Tomorrow", click "Add todo".
    expect: A confirmation shows the number of the new todo, and it is at the top of the list, marked "Tomorrow" and tagged "#home".
  - id: S2
    name: Find it
    do: Search the list for "{{runTag}}".
    expect: Exactly one todo is listed, tagged "#home", marked "Tomorrow" and not done.
  - id: S3
    name: Tick it off
    do: Tick the todo off.
    expect: It is struck through (done) and the progress ring counts it as done (1/1).
heard:
  - {note: H1, as: run}
`));

        // S1: the dialog, field by field.
        caw('click', role('button', 'New todo'));
        caw('type', role('textbox', 'Title'), title);
        caw('fill', role('combobox', 'Tag'), 'home');
        caw('fill', role('combobox', 'When'), 'Tomorrow');
        caw('click', role('button', 'Add todo'));
        caw('wait-ready');
        caw('remember', 'nr', "(document.querySelector('[role=status]').textContent.match(/#([0-9]+)/)||[])[1]");
        caw('check', 'S1', `/^Added #[0-9]+$/.test(document.querySelector('[role=status]').textContent.trim()) && ${first}.querySelector('.title').textContent==='${title}' && ${first}.querySelector('.when').textContent==='Tomorrow' && ${first}.querySelector('.chip').textContent==='#home'`);

        // S2: the search.
        caw('type', role('searchbox', 'Search todos'), runTag);
        caw('wait-ready');
        caw('check', 'S2', `(()=>{const li=[...document.querySelectorAll('#list li')];return li.length===1 && li[0].querySelector('.chip').textContent==='#home' && li[0].querySelector('.when').textContent==='Tomorrow' && !li[0].classList.contains('done');})()`);

        // S3: tick it off.
        caw('click', role('button', `Complete ${title}`));
        caw('wait-ready');
        caw('check', 'S3', `${first}.classList.contains('done') && document.getElementById('progress').textContent==='1/1'`);

        const pass = (id) => ({ id, status: 'pass', evidence: { type: 'eval', value: 'true' } });
        caw('finish', '--file', file('finish.json', JSON.stringify({ expectations: ['S1', 'S2', 'S3'].map(pass), omit: [] })));
    },

    // A question about the picked "Add todo" button, answered from the dialog's code.
    develop: () => {
        caw('task');
        caw('say', `"Add todo" starts disabled on purpose: check() in ${lineOf('const check = () =>')} enables it only once the title is not empty and a tag is chosen. "When" has a default ("Today"), so it is not checked. Choose a tag and the button turns on.`);
        untilEnded();
    },

    // S1 of first-errand failed on the app (BREAK): the cause in the code, the fix proposed as a change.
    cause: () => {
        caw('task');
        caw('network');
        const limit = lineOf('data.title.length > 20');
        caw('say', `POST /api/todos answers 500 because ${limit} refuses titles over 20 characters; "Feed the raven CAW-…" is longer. The todo itself keeps up to 120 (${lineOf('.slice(0, 120)')}).`);
        caw('advise', '--file', file('advice.json', JSON.stringify({
            items: [{
                about: 'S1',
                side: 'app',
                title: 'New todos with long titles fail',
                evidence: `POST /api/todos responded with HTTP 500; ${limit}`,
                reason: 'The new length check refuses any title over 20 characters with HTTP 500, although a todo keeps up to 120.',
                prompt: `In server.mjs the length check at ${limit} refuses titles over 20 characters with HTTP 500; allow 120, as the todo keeps.`,
                edits: [{ file: 'server.mjs', find: 'data.title.length > 20)', replace: 'data.title.length > 120)', why: 'A todo keeps up to 120 characters' }],
            }],
        })));
    },

    // caw reproduce: the agent alone, walking the report, then the verdict with the steps for the draft.
    reproduce: async () => {
        caw('task');
        const search = lineOf(SEARCH);
        caw('say', 'Signed in. Searching the list for "home", as the report says.');
        caw('snapshot');
        caw('type', role('searchbox', 'Search todos'), 'home');
        caw('wait-ready');
        caw('network');
        caw('screenshot', 'search-home.png');
        caw('say', `The list stays empty for "home", although two todos are tagged #home. The search request answers []; ${search} compares the title only.`);
        await pause(1000);
        caw('finish', '--file', file('finish.json', JSON.stringify({
            reproduced: 'yes',
            observed: 'Searching for "home" lists no todo; GET /api/todos?q=home answers an empty list.',
            expected: 'The todos tagged "#home" are listed.',
            steps: [
                { name: 'Search by tag', do: 'Search the list for "home".', expect: 'The todos tagged "#home" are listed.' },
            ],
            writes: false,
            cause: `${search} compares the search with the title only, never with the tag.`,
            screenshots: ['search-home.png'],
        })));
    },

    // record first-errand@S4: the pending S4 recorded after S1 to S3 replayed. Its check reads the confirmation instead of the
    // "When" field: a different check for the same expected result, which caw audit then names.
    'plan-it': () => {
        const runTag = runTagOf(caw('task'));
        caw('plan', '--file', file('plan.yaml', `steps:
  - id: S4
    name: Plan it
    do: Open the todo and move it to "Tomorrow".
    expect: 'The todo shows "When: Tomorrow".'
`));
        caw('click', role('link', `Feed the raven ${runTag}`));
        caw('wait-ready');
        caw('fill', role('combobox', 'Move to'), 'Tomorrow');
        caw('click', role('button', 'Save'));
        caw('wait-ready');
        caw('check', 'S4', "document.querySelector('[role=status]').textContent==='Moved to Tomorrow'");
        caw('finish', '--file', file('finish.json', JSON.stringify({ expectations: [{ id: 'S4', status: 'pass', evidence: { type: 'eval', value: 'true' } }], omit: [] })));
    },

    // Wherever caw would start an agent the flow does not script (e.g. advice after warnings): reads the task and stops, so no
    // real agent ever runs.
    idle: () => {
        caw('task');
    },
};

// Run as the agent, not when capture-media imports BREAK.
const main = process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (main) {
    const mode = process.argv[2] ?? 'demo';
    if (modes[mode] === undefined) throw new Error(`media-agent: one of ${Object.keys(modes).join(', ')}`);
    await modes[mode]();
}
