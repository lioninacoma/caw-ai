#!/usr/bin/env node
// Stands in for Claude in the README demo (scripts/capture-media.mjs): the same plan and the same clicks every time,
// at the pace of the commands themselves, so the video can be recorded again and again without tokens and shows the same.
// It runs as the run's agent on the host and drives the browser with `caw agent`, exactly as Claude does.
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

const runTag = caw('task').match(/CAW-[0-9]+/)[0];
const title = `Feed the raven ${runTag}`;
const role = (kind, name) => `getByRole('${kind}', { name: '${name}', exact: true })`;
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
