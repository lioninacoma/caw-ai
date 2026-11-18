#!/usr/bin/env node
// Stands in for Claude in the README media (scripts/capture-media.mjs): the same plan, clicks and answers every time, at the
// pace of the commands themselves, so the media can be recorded again and again without tokens and show the same.
// It runs as the run's agent on the host and drives the browser with `caw agent`, exactly as Claude does.
//
//   media-agent.mjs [demo|develop|bugfix|reproduce]
//
// The answers name real places in examples/errand/server.mjs: the search there really compares the title only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/caw.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'caw-media-agent-'));
const caw = (...args) => {
    const done = spawnSync(process.execPath, [BIN, 'agent', ...args], { encoding: 'utf8', env: process.env });
    if (done.status !== 0) throw new Error(`caw agent ${args[0]}: ${done.stdout}${done.stderr}`);
    return done.stdout;
};
const file = (name, text) => {
    const path = join(work, name);
    writeFileSync(path, text);
    return path;
};
const role = (kind, name) => `getByRole('${kind}', { name: '${name}', exact: true })`;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
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

const SEARCH_LINE = 'server.mjs:197';
const FIND = 'todos.filter((t) => t.title.toLowerCase().includes(q))';

const modes = {
    demo: () => {
        const runTag = caw('task').match(/CAW-[0-9]+/)[0];
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
        caw('say', '"Add todo" starts disabled on purpose: check() in server.mjs:134 enables it only once the title is not empty and a tag is chosen. "When" has a default ("Today"), so it is not checked. Choose a tag and the button turns on.');
        untilEnded();
    },

    // A pasted bug: searched in the page, the cause found in the code, the fix proposed as a change.
    bugfix: () => {
        caw('task');
        caw('say', 'Searching for "home" as in the report.');
        // The test ends on the todo's detail page; the search is on the list.
        caw('click', role('link', '← All todos'));
        caw('wait-ready');
        caw('type', role('searchbox', 'Search todos'), 'home');
        caw('wait-ready');
        caw('network');
        caw('say', `Reproduced: the list stays empty, although "Book the dentist" and "Water the monstera" are tagged #home. GET /api/todos?q=home answers []: ${SEARCH_LINE} compares the search with the title only, never with the tag.`);
        caw('advise', '--file', file('advice.json', JSON.stringify({
            items: [{
                about: 'search',
                side: 'app',
                title: 'Search ignores tags',
                evidence: `GET /api/todos?q=home returns no todo tagged #home; ${SEARCH_LINE}`,
                reason: 'The search compares the title only.',
                prompt: 'In server.mjs the todo search compares only the title; also match the tag.',
                edits: [{ file: 'server.mjs', find: FIND, replace: 'todos.filter((t) => t.title.toLowerCase().includes(q) || t.tag === q)', why: 'Tags are searchable too' }],
            }],
        })));
        untilEnded();
    },

    // caw reproduce: Claude alone, walking the report, then the verdict with the steps for the draft test plan.
    reproduce: async () => {
        caw('task');
        caw('say', 'Signed in. Searching the list for "home", as the report says.');
        caw('snapshot');
        caw('type', role('searchbox', 'Search todos'), 'home');
        caw('wait-ready');
        caw('network');
        caw('screenshot', 'search-home.png');
        caw('say', `The list stays empty for "home", although two todos are tagged #home. The search request answers []; ${SEARCH_LINE} compares the title only.`);
        await pause(1500);
        caw('finish', '--file', file('finish.json', JSON.stringify({
            reproduced: 'yes',
            observed: 'Searching for "home" lists no todo; GET /api/todos?q=home answers an empty list.',
            expected: 'The todos tagged "#home" are listed.',
            steps: [
                { name: 'Search by tag', do: 'Search the list for "home".', expect: 'The todos tagged "#home" are listed.' },
            ],
            cause: `${SEARCH_LINE} compares the search with the title only, never with the tag.`,
            screenshots: ['search-home.png'],
        })));
    },
};

const mode = process.argv[2] ?? 'demo';
if (modes[mode] === undefined) throw new Error(`media-agent: one of ${Object.keys(modes).join(', ')}`);
await modes[mode]();
