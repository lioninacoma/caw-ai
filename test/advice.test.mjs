import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_FILE, adviceView, applyEdits, applyToFiles, applyToSpec, changesFiles, readAdvice } from '../src/host/advice.mjs';
import { CONFIG_FILE } from '../src/shared/config.mjs';
import { loadTest, stepHash, writeTest } from '../src/host/test-file.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

const plain = (id) => ({ id, name: `Step ${id}`, do: `Do ${id}`, expect: `${id} is there` });
const recorded = (id) => {
    const step = plain(id);
    return { ...step, recording: { hash: stepHash(step), recordedOn: 'a/dev', recordedAt: '2026-11-06T09:00:00.000Z', actions: [], check: `check${id}()` } };
};
const meta = { id: 't', app: 'a', role: 'r', targets: ['a/dev'], source: 'overlay', mutates: true, also: [], notes: 'Old.' };
const SPEC = composeTest(meta, { notes: 'Old.', steps: [recorded('S1'), recorded('S2')] });
const CONFIG = { consoleIgnore: ['known'], foreignCode: [] };
const item = (change, extra = {}) => ({ side: 'test', title: 'Title', reason: 'Because.', evidence: 'failure 1', change, ...extra });
const appItem = (extra = {}) => ({ side: 'app', title: 'Timeout', reason: 'Too short.', evidence: 'request GET /fees aborted after 2 ms', prompt: 'Increase the timeout.', ...extra });
const problems = (raw, options) => {
    try {
        readAdvice(raw, SPEC, CONFIG, options);
    } catch (error) {
        assert.equal(error.code, 'advice-invalid');
        return error.message;
    }
    return '';
};

test('advice: valid items pass, an empty list too', () => {
    const items = [
        item({ kind: 'step', id: 'S2', fields: { retry: { times: 3, from: 'S1' } } }, { about: 'S2' }),
        item({ kind: 'test', notes: 'New.' }),
        item({ kind: 'context', section: 'Admin app', text: 'Prices load slowly.' }),
        item({ kind: 'config', key: 'foreignCode', pattern: '/Root/public/' }),
        appItem(),
    ];
    assert.equal(readAdvice({ items }, SPEC, CONFIG).length, 5);
    assert.deepEqual(readAdvice({ items: [] }, SPEC, CONFIG), []);
});

test('advice: every shape violation is rejected before the human sees it', () => {
    assert.match(problems([]), /items/);
    assert.match(problems({ items: [item({ kind: 'step', id: 'S9', fields: { note: 'x' } })] }), /S9 does not exist/);
    assert.match(problems({ items: [item({ kind: 'step', id: 'S1', fields: { hash: 'x' } })] }), /hash/);
    assert.match(problems({ items: [item({ kind: 'step', id: 'S1', fields: { name: null } })] }), /name cannot be removed/);
    assert.match(problems({ items: [item({ kind: 'step', id: 'S2', fields: { retry: { times: 99 } } })] }), /items\[0\]/);
    assert.match(problems({ items: [item({ kind: 'step', id: 'S1', fields: { retry: { times: 2, from: 'S2' } } })] }), /items\[0\]/);
    assert.match(problems({ items: [item({ kind: 'config', key: 'consoleIgnore', pattern: '(' })] }), /not a valid/);
    assert.match(problems({ items: [item({ kind: 'config', key: 'consoleIgnore', pattern: 'known' })] }), /is already/);
    assert.match(problems({ items: [item({ kind: 'config', key: 'roles', pattern: 'x' })] }), /change.key/);
    assert.match(problems({ items: [item({ kind: 'context', section: 'a\nb', text: 'x' })] }), /single-line heading/);
    assert.match(problems({ items: [item({ kind: 'test', notes: 'Ask max@example.org' })] }), /email/);
    assert.match(problems({ items: [item({ kind: 'test', notes: 'control\u0007char' })] }), /control characters/);
    assert.match(problems({ items: [appItem({ prompt: undefined })] }), /prompt/);
    assert.match(problems({ items: [appItem({ change: { kind: 'test', notes: 'x' } })] }), /omit change/);
    assert.match(problems({ items: [{ side: 'both', title: 'T', reason: 'R', evidence: 'x' }] }), /side/);
    assert.match(problems({ items: [item({ kind: 'test', notes: 'x' }, { evidence: undefined })] }), /evidence is missing/);
    assert.match(problems({ items: [appItem({ evidence: '  ' })] }), /evidence is missing/);
    assert.match(problems({ items: [item({ kind: 'test', notes: 'x' }, { edits: [{ file: 'a.js', find: 'a', replace: 'b' }] })] }), /edits are only allowed/);
    assert.match(problems({ items: Array.from({ length: 11 }, () => item({ kind: 'test', notes: 'x' })) }), /At most 10/);
});

test('advice: the card shows before and after', () => {
    const view = adviceView(item({ kind: 'step', id: 'S1', fields: { expect: 'New there', retry: { times: 2 } } }), SPEC);
    assert.equal(view.target, 'S1 Step S1');
    assert.deepEqual(view.changes, [{ label: 'Ergebnis', before: 'S1 is there', after: 'New there' }, { label: 'Wiederholung', before: '', after: '2 × neu laden, 10 s warten, ab S1' }]);
    assert.deepEqual(adviceView({ side: 'app', title: 'T', reason: 'R', evidence: 'B', prompt: 'P' }, SPEC), { side: 'app', title: 'T', reason: 'R', evidence: 'B', prompt: 'P' });
    assert.equal(adviceView(item({ kind: 'config', key: 'foreignCode', pattern: 'x' }), SPEC).target, CONFIG_FILE);
    assert.equal(adviceView(item({ kind: 'config', key: 'foreignCode', pattern: 'x' }), SPEC).changes[0].label, 'Fremder Code');
    const selectors = item({ kind: 'config', key: 'messageSelectors', selectors: ['[role=alert]', '.toast'] });
    assert.deepEqual(adviceView(selectors, SPEC, [], { messageSelectors: ['.toasts'] }).changes, [{ label: 'Wo Meldungen stehen', before: '.toasts', after: '[role=alert]  ·  .toast' }]);
    assert.equal(readAdvice({ items: [selectors] }, SPEC, CONFIG).length, 1);
    assert.throws(() => readAdvice({ items: [item({ kind: 'config', key: 'messageSelectors', selectors: [] })] }, SPEC, CONFIG), /CSS selectors/);
    const failures = [{ type: 'pageerror', text: 'TypeError: x is undefined' }];
    assert.equal(adviceView({ side: 'app', title: 'T', reason: 'R', evidence: 'failure 1, failure 3', prompt: 'P' }, SPEC, failures).evidence, 'Harter Fehler 1 (pageerror): TypeError: x is undefined, failure 3', 'unknown numbers stay as they are');
});

test('advice: a test change against a clear app failure is flagged', () => {
    const retry = item({ kind: 'step', id: 'S2', fields: { retry: { times: 2 } } });
    const [marked, app] = readAdvice({ items: [retry, appItem()] }, SPEC, CONFIG, { diagnosis: { side: 'app', strength: 'clear' } });
    assert.deepEqual([marked.contradicts, app.contradicts], [true, undefined]);
    assert.equal(readAdvice({ items: [retry] }, SPEC, CONFIG, { diagnosis: { side: 'app', strength: 'likely' } })[0].contradicts, undefined);
    assert.equal(adviceView(marked, SPEC).contradicts, true);
});

test('advice: code edits are checked against the actual files and written only on click', () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-edits-'));
    try {
        mkdirSync(join(root, 'src'), { recursive: true });
        mkdirSync(join(root, 'caw'), { recursive: true });
        writeFileSync(join(root, 'src/fees.js'), 'const a = 1;\r\nload({\r\n    timeout: 1,\r\n});\r\nconst b = 2;\r\nconst b2 = 2;\r\n');
        writeFileSync(join(root, 'caw/caw.md'), 'x');
        const edit = (extra) => appItem({ edits: [{ file: 'src/fees.js', find: '    timeout: 1,', replace: '    timeout: 40000,', why: 'like the others', ...extra }] });
        const at = (extra) => problems({ items: [edit(extra)] }, { root });

        const [ok] = readAdvice({ items: [edit({})] }, SPEC, CONFIG, { root });
        assert.deepEqual(ok.edits, [{ file: 'src/fees.js', line: 3, find: '    timeout: 1,', replace: '    timeout: 40000,', why: 'like the others' }]);
        assert.equal(readAdvice({ items: [edit({ file: './src\\fees.js' })] }, SPEC, CONFIG, { root })[0].edits[0].file, 'src/fees.js');

        assert.match(at({ file: 'src/missing.js' }), /src\/missing\.js does not exist/);
        assert.match(at({ find: 'const b' }), /2 times/);
        assert.match(at({ find: 'does not exist' }), /not at all in src\/fees\.js/);
        assert.match(at({ file: 'caw/caw.md', find: 'x' }), /is not part of the application/);
        // No detour into .git or caw/: dot segments, different casing, what Windows silently reinterprets.
        mkdirSync(join(root, '.git'), { recursive: true });
        writeFileSync(join(root, '.git/config'), '[core]\n');
        for (const file of ['././.git/config', 'src/../.git/config', 'src//fees.js', '.git./config', '.git /config', 'GIT~1/config', '.git::$DATA']) {
            assert.match(at({ file, find: '[core]' }), /relative to the project/, file);
        }
        for (const file of ['.GIT/config', 'CAW/caw.md', 'Node_Modules/x.js']) assert.match(at({ file, find: '[core]' }), /is not part of the application/, file);
        // Not via a link inside the project either (a junction on Windows, which needs no privileges).
        let linked = true;
        try {
            symlinkSync(join(root, '.git'), join(root, 'src/repo'), 'junction');
        } catch {
            linked = false;
        }
        if (linked) assert.match(at({ file: 'src/repo/config', find: '[core]' }), /is not part of the application/);
        assert.match(at({ file: '../outside.js' }), /relative to the project/);
        assert.match(at({ file: 'C:/x.js' }), /relative to the project/);
        assert.match(at({ replace: '    timeout: 1,' }), /identical/);
        assert.match(problems({ items: [appItem({ edits: [] })] }, { root }), /1 to 10/);
        // A second edit to the same file sees the state after the first.
        const chained = appItem({ edits: [{ file: 'src/fees.js', find: 'timeout: 1,', replace: 'timeout: 9,' }, { file: 'src/fees.js', find: 'timeout: 9,', replace: 'timeout: 40000,' }] });
        assert.equal(readAdvice({ items: [chained] }, SPEC, CONFIG, { root })[0].edits.length, 2);

        assert.equal(readFileSync(join(root, 'src/fees.js'), 'utf8').includes('timeout: 1,'), true);
        assert.deepEqual(applyEdits(root, ok.edits), ['src/fees.js']);
        assert.equal(readFileSync(join(root, 'src/fees.js'), 'utf8'), 'const a = 1;\r\nload({\r\n    timeout: 40000,\r\n});\r\nconst b = 2;\r\nconst b2 = 2;\r\n');
        assert.throws(() => applyEdits(root, ok.edits), { code: 'advice-invalid' });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('advice: retry alone does not make a step stale, a text change does', () => {
    const retried = applyToSpec(SPEC, { kind: 'step', id: 'S2', fields: { retry: { times: 2 } } });
    assert.deepEqual([retried.id, retried.stale], ['S2', false]);
    assert.deepEqual(retried.spec.steps[1].retry, { times: 2 });
    const worded = applyToSpec(SPEC, { kind: 'step', id: 'S2', fields: { expect: '  Different  ' } });
    assert.deepEqual([worded.stale, worded.spec.steps[1].expect, worded.spec.expectations[1].text], [true, 'Different', 'Different']);
    const removed = applyToSpec(retried.spec, { kind: 'step', id: 'S2', fields: { retry: null } });
    assert.equal(removed.spec.steps[1].retry, undefined);
    assert.deepEqual(applyToSpec(SPEC, { kind: 'test', notes: 'New.' }), { spec: { ...SPEC, notes: 'New.' }, notes: true });
    assert.deepEqual([changesFiles(item({ kind: 'context' })), changesFiles(item({ kind: 'step' })), changesFiles({ side: 'app' })], [true, false, false]);
});

test('advice: knowledge, config and test file are extended, comments and line endings stay', () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-advice-'));
    try {
        mkdirSync(join(root, 'caw/tests'), { recursive: true });
        writeFileSync(join(root, CONTEXT_FILE), '# Knowledge\r\n\r\n## Admin app\r\n- Old.\r\n\r\n## Other\r\n- Something.\r\n');
        applyToFiles(root, { kind: 'context', section: 'Admin app', text: 'New\non two lines.' });
        applyToFiles(root, { kind: 'context', section: 'Brand new', text: 'First.' });
        assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), '# Knowledge\r\n\r\n## Admin app\r\n- Old.\r\n- New on two lines.\r\n\r\n## Other\r\n- Something.\r\n\r\n## Brand new\r\n- First.\r\n');

        writeFileSync(join(root, CONFIG_FILE), '{\n    "foreignCode": []\n}\n');
        assert.equal(applyToFiles(root, { kind: 'config', key: 'foreignCode', pattern: '/public/' }), CONFIG_FILE);
        applyToFiles(root, { kind: 'config', key: 'consoleIgnore', pattern: 'whatever' });
        assert.deepEqual(JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')), { foreignCode: ['/public/'], consoleIgnore: ['whatever'] });
        applyToFiles(root, { kind: 'config', key: 'messageSelectors', selectors: ['[role=alert]', '.toast'] });
        assert.deepEqual(JSON.parse(readFileSync(join(root, CONFIG_FILE), 'utf8')).messageSelectors, ['[role=alert]', '.toast']);

        writeTest(root, SPEC);
        const file = join(root, 'caw/tests/t.yaml');
        writeFileSync(file, `# Human comment\n${readFileSync(file, 'utf8')}`);
        const retried = applyToSpec(SPEC, { kind: 'step', id: 'S2', fields: { retry: { times: 2, from: 'S1' } } });
        const noted = applyToSpec(retried.spec, { kind: 'test', notes: 'New.' });
        writeTest(root, noted.spec, new Set(['S2']), { withNotes: true });
        const text = readFileSync(file, 'utf8');
        assert.match(text, /# Human comment/);
        // The recording lives in caw/recordings and survives changes to retry and notes.
        const back = loadTest(root, 't');
        assert.deepEqual([back.notes, back.steps[1].retry, back.steps[1].recording.hash], ['New.', { times: 2, from: 'S1' }, SPEC.steps[1].recording.hash]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('advice: a recorded click becomes optional without making the step stale, and is saved that way', () => {
    const clicks = { ...recorded('S1'), recording: { ...recorded('S1').recording, actions: [{ action: 'click', target: { role: 'button', name: 'Accept all' } }, { action: 'fill', target: { role: 'textbox', name: 'Name' }, value: 'x' }] } };
    const spec = composeTest(meta, { notes: 'Old.', steps: [clicks, recorded('S2')] });
    const local = (raw) => {
        try {
            readAdvice(raw, spec, CONFIG);
        } catch (error) {
            return error.message;
        }
        return '';
    };
    assert.equal(local({ items: [item({ kind: 'action', id: 'S1', index: 1, optional: true })] }), '');
    assert.match(local({ items: [item({ kind: 'action', id: 'S1', index: 2, optional: true })] }), /not a click/);
    assert.match(local({ items: [item({ kind: 'action', id: 'S1', index: 3, optional: true })] }), /1 to 2/);
    assert.match(local({ items: [item({ kind: 'action', id: 'S2', index: 1, optional: true })] }), /1 to 0|not recorded/);
    assert.match(local({ items: [item({ kind: 'action', id: 'S1', index: 1, optional: 'yes' })] }), /true or false/);

    const change = { kind: 'action', id: 'S1', index: 1, optional: true };
    const view = adviceView(item(change), spec);
    assert.equal(view.target, 'S1 Step S1');
    assert.equal(view.changes.length, 1);
    assert.match(view.changes[0].label, /^Aktion 1: click /);
    assert.deepEqual([view.changes[0].before, view.changes[0].after], ['immer', 'optional: nur wenn das Ziel da ist']);

    const applied = applyToSpec(spec, change);
    assert.deepEqual([applied.id, applied.stale], ['S1', false]);
    assert.equal(applied.spec.steps[0].recording.actions[0].optional, true);
    assert.equal(applied.spec.steps[0].recording.hash, spec.steps[0].recording.hash);
    assert.equal(applyToSpec(applied.spec, { ...change, optional: false }).spec.steps[0].recording.actions[0].optional, undefined);

    const root = mkdtempSync(join(tmpdir(), 'caw-optional-'));
    try {
        writeTest(root, applied.spec);
        const loaded = loadTest(root, 't');
        assert.equal(loaded.steps[0].recording.actions[0].optional, true);
        assert.equal(loaded.steps[0].recording.actions[1].optional, undefined);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
