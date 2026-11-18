// The human's own caw.md in the settings folder: read for Claude, noted in the report, shown by doctor, extended only by a click.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CONTEXT_FILE, adviceView, applyToFiles, readAdvice } from '../src/host/advice.mjs';
import { doctorChecks } from '../src/host/doctor.mjs';
import { personalContextPath, readPersonalContext } from '../src/shared/personal-context.mjs';
import { renderReport } from '../src/shared/report.mjs';
import { composeTest } from '../src/host/test-plan.mjs';

const tempDir = (t, prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const withHome = (t) => {
    const home = tempDir(t, 'caw-home-');
    const before = process.env.CAW_AI_HOME;
    process.env.CAW_AI_HOME = home;
    t.after(() => { if (before === undefined) delete process.env.CAW_AI_HOME; else process.env.CAW_AI_HOME = before; });
    return home;
};

test('personal caw.md: next to prefs.json, empty or missing means none', (t) => {
    const home = withHome(t);
    assert.equal(personalContextPath(), join(home, 'caw.md'));
    assert.equal(readPersonalContext(), undefined);
    writeFileSync(join(home, 'caw.md'), '  \r\n\r\n');
    assert.equal(readPersonalContext(), undefined, 'only whitespace');
    writeFileSync(join(home, 'caw.md'), '# caw\r\n\r\n- Report findings as a short list.\r\n');
    const notes = readPersonalContext();
    assert.equal(notes.text, '# caw\n\n- Report findings as a short list.');
    assert.equal(notes.lines, 3);
    assert.equal(notes.truncated, false);
    writeFileSync(join(home, 'caw.md'), `- ${'x'.repeat(70 * 1024)}`);
    assert.equal(readPersonalContext().truncated, true, 'a huge file is cut, not refused');
});

test('report: names the personal notes by path and size, never their content', () => {
    const text = renderReport({ status: 'pass', testId: 'smoke', target: 'local', testedCode: 'deployed', personalContext: { path: '~/caw-ai/caw.md', lines: 4 } });
    assert.match(text, /persönlichen Notizen: ~\/caw-ai\/caw\.md \(4 Zeilen\)/);
    assert.ok(!/persönlichen Notizen/.test(renderReport({ status: 'pass', testId: 'smoke', target: 'local', testedCode: 'deployed' })));
});

test('doctor: the personal notes are an optional information line either way', async (t) => {
    const home = withHome(t);
    const root = tempDir(t, 'caw-doctor-');
    const line = async () => (await doctorChecks(root, { env: { ...process.env, CAW_AI_HOME: home }, probes: { claude: () => '2.0.0' }, agent: 'local' }))
        .find(({ text }) => /persönlichen Notizen|persönliche Notizen/i.test(text));
    const none = await line();
    assert.equal(none.ok, true);
    assert.equal(none.optional, true);
    assert.match(none.text, /Keine persönlichen Notizen/);
    writeFileSync(join(home, 'caw.md'), '- One.\n- Two.\n');
    assert.match((await line()).text, /\(2 Zeilen\)/);
});

test('advice: a context change goes to the project caw/caw.md or the personal caw.md, nothing else', (t) => {
    const home = withHome(t);
    const root = tempDir(t, 'caw-advice-');
    mkdirSync(join(root, 'caw'), { recursive: true });
    const spec = composeTest({ id: 't', role: 'r', environments: ['dev'], writes: false }, { steps: [{ id: 'S1', name: 'Open', do: 'Open it.', expect: 'It is open.' }] });
    const item = (change) => ({ side: 'test', title: 'Note', reason: 'Because.', evidence: 'failure 1', change });
    const invalid = (change) => {
        try {
            readAdvice({ items: [item(change)] }, spec, {});
        } catch (error) {
            return error.message;
        }
        return '';
    };
    assert.match(invalid({ kind: 'context', file: '../../etc/passwd', section: 'S', text: 'x' }), /change\.file is project/);
    assert.equal(readAdvice({ items: [item({ kind: 'context', file: 'personal', section: 'Reports', text: 'Short lists.' })] }, spec, {}).length, 1);

    // The card names which file and where.
    assert.match(adviceView(item({ kind: 'context', file: 'personal', section: 'Reports', text: 'x' }), spec).target, /caw\.md \(persönlich/);
    assert.match(adviceView(item({ kind: 'context', section: 'Search', text: 'x' }), spec).target, /^caw\/caw\.md \(Projekt/);

    // Applied (after the human's click): the personal file is created in the settings folder, the project file stays as it is.
    assert.equal(applyToFiles(root, { kind: 'context', file: 'personal', section: 'Reports', text: 'Short lists.' }).endsWith('caw.md'), true);
    assert.match(readFileSync(join(home, 'caw.md'), 'utf8'), /^# caw\n\n.*\n\n## Reports\n- Short lists\.\n$/);
    assert.ok(!existsSync(join(root, CONTEXT_FILE)));
    assert.equal(applyToFiles(root, { kind: 'context', section: 'Search', text: 'Clear the filter first.' }), CONTEXT_FILE);
    assert.match(readFileSync(join(root, CONTEXT_FILE), 'utf8'), /## Search\n- Clear the filter first\./);
});
