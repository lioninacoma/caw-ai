// git.mjs and caw audit end to end on a temporary repository: merge base, the test data at a commit, read in one batch.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditCommand } from '../src/host/audit.mjs';
import { auditFiles, changedFiles, mergeBase, readAtCommit } from '../src/host/git.mjs';
import { CawError, exitOf } from '../src/shared/errors.mjs';

const CLI = fileURLToPath(new URL('../bin/caw.mjs', import.meta.url));

const TEST = `id: bestellung
role: kunde
writes: true
steps:
  - id: S1
    name: Bestellen
    do: Bestellung anlegen
    expect: Eine Bestellung steht in der Liste.
`;
const recording = (check) => `test: bestellung
steps:
  - id: S1
    hash: h
    recordedOn: local
    recordedAt: 2026-11-06T09:00:00.000Z
    locale: de-DE
    timezone: Europe/Berlin
    actions: []
    check: ${JSON.stringify(check)}
`;
const CONFIG = JSON.stringify({ language: 'de', environments: { local: { url: 'http://localhost:5173', writable: true } } });

/** A repository whose project folder is app/ (not the top), with one commit on main. */
const repository = (t) => {
    const top = mkdtempSync(join(tmpdir(), 'caw-git-'));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: top, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'audit@example.test');
    git('config', 'user.name', 'Audit');
    git('config', 'core.autocrlf', 'false');
    const root = join(top, 'app');
    const write = (path, text) => {
        mkdirSync(join(root, path, '..'), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    write('caw.config.json', CONFIG);
    write('caw/tests/bestellung.yaml', TEST);
    // Multi-byte text: the batch output is cut by byte size, not characters.
    write('caw/recordings/bestellung.yaml', recording("document.title === 'Übersicht – Bestellungen'"));
    write('caw/tests/notes.txt', 'kein Test');
    write('caw/tests/team/unter.yaml', TEST);
    write('src/app.js', 'export {};');
    git('add', '-A');
    git('commit', '-q', '-m', 'Start');
    return { top, root, git, write };
};

test('git: merge base, the test data at a commit, read in one batch; bad refs are rejected', (t) => {
    const { root, git, write } = repository(t);
    const start = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    write('caw/tests/storno.yaml', TEST.replace('bestellung', 'storno'));
    git('add', '-A');
    git('commit', '-q', '-m', 'Storno');
    assert.equal(mergeBase(root, 'main'), start);
    assert.deepEqual(auditFiles(root, start).sort(), ['caw.config.json', 'caw/recordings/bestellung.yaml', 'caw/tests/bestellung.yaml']);
    assert.deepEqual(auditFiles(root, 'HEAD').sort(), ['caw.config.json', 'caw/recordings/bestellung.yaml', 'caw/tests/bestellung.yaml', 'caw/tests/storno.yaml']);
    const files = readAtCommit(root, start, ['caw/recordings/bestellung.yaml', 'caw/tests/fehlt.yaml', 'caw/tests/bestellung.yaml']);
    assert.deepEqual([...files.keys()], ['caw/recordings/bestellung.yaml', 'caw/tests/bestellung.yaml'], 'a missing path is left out');
    assert.match(files.get('caw/recordings/bestellung.yaml'), /'Übersicht – Bestellungen'"\n$/);
    assert.equal(files.get('caw/tests/bestellung.yaml'), TEST);
    for (const ref of ['gibts-nicht', '--output=x', '']) {
        assert.throws(() => mergeBase(root, ref), (error) => error instanceof CawError && error.code === 'git-ref');
    }
    assert.equal(exitOf('git-ref'), 3);
    assert.equal(exitOf('git-missing'), 3);
});

test('git: changed files since a commit for the fix report: committed, uncommitted and untracked, without caw/ and .caw/', (t) => {
    const { top, root, git, write } = repository(t);
    const start = git('rev-parse', '--short', 'HEAD');
    write('src/app.js', 'export const fixed = true;');
    git('commit', '-q', '-am', 'Fix');
    write('src/search.js', 'export {};');
    write('caw/drafts/bug-x.yaml', 'x');
    write('.caw/runs/r1/report.md', 'x');
    writeFileSync(join(top, 'server.js'), 'neben dem Projektordner');
    git('add', 'server.js');
    assert.deepEqual(changedFiles(root, start), ['../server.js', 'src/app.js', 'src/search.js']);
    assert.throws(() => changedFiles(root, '--output=x'), (error) => error instanceof CawError && error.code === 'git-ref');
});

test('git: the fix report lists tracked changes repo-wide, untracked files only inside the project folder, never an untracked folder', (t) => {
    const { top, root, git, write } = repository(t);
    const start = git('rev-parse', '--short', 'HEAD');
    // Tracked beside the project folder: committed with the start, changed since.
    writeFileSync(join(top, 'api.js'), 'v1');
    git('add', 'api.js');
    git('commit', '-q', '-m', 'Api');
    const before = git('rev-parse', '--short', 'HEAD');
    writeFileSync(join(top, 'api.js'), 'v2');
    // Untracked beside the project folder: not the fix's.
    writeFileSync(join(top, 'scratch.txt'), 'x');
    mkdirSync(join(top, 'tools'), { recursive: true });
    writeFileSync(join(top, 'tools/helper.js'), 'x');
    // Untracked inside: a new file counts; a nested repository is listed by git as a folder ("vendor/lib/") and does not.
    write('src/new.js', 'export {};');
    mkdirSync(join(root, 'vendor/lib'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'vendor/lib') });
    writeFileSync(join(root, 'vendor/lib/index.js'), 'x');
    write('caw/drafts/bug-y.yaml', 'x');
    write('.caw/runs/r2/report.md', 'x');
    assert.match(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root }).toString('utf8'), /^vendor\/lib\/$/m, 'git lists the nested repository as a folder');
    assert.deepEqual(changedFiles(root, before), ['../api.js', 'src/new.js']);
    assert.deepEqual(changedFiles(root, start), ['../api.js', 'src/new.js'], 'a file added since the commit is tracked');
});

test('git: a folder outside any repository is git-missing', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-nogit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // GIT_CEILING_DIRECTORIES: git must not find a repository above the temp folder.
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    t.after(() => {
        if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = saved;
    });
    assert.throws(() => mergeBase(dir, 'main'), (error) => error instanceof CawError && error.code === 'git-missing' && /kein(em)? Git-Repository/.test(error.message));
});

test('caw audit: the working tree against the merge base, Markdown or JSON, exit 1 on a weakening', (t) => {
    const { root, git, write } = repository(t);
    git('checkout', '-q', '-b', 'feature');
    let printed = '';
    const print = (text) => { printed = text; };
    assert.equal(auditCommand(root, ['main'], { print }), 0);
    assert.match(printed, /Kein Test, keine Aufnahme und keine Config geändert/);
    // Uncommitted, as in a working tree: the check changes, the expected result stays.
    write('caw/recordings/bestellung.yaml', recording('true'));
    assert.equal(auditCommand(root, ['main', '--json'], { print }), 1);
    const result = JSON.parse(printed);
    assert.equal(result.weakened, 1);
    assert.equal(result.findings[0].kind, 'check-changed');
    assert.equal(result.findings[0].after, 'true');
    assert.throws(() => auditCommand(root, ['main', '--fix'], { print }), (error) => error.code === 'usage');
    assert.throws(() => auditCommand(root, [], { print }), (error) => error.code === 'usage');

    // Through the CLI: Markdown on stdout, exit 1; an unknown ref exits 3.
    const run = (...args) => spawnSync(process.execPath, [CLI, 'audit', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, INIT_CWD: root } });
    const cli = run('main');
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /### Abgeschwächt \(1\)/);
    assert.match(cli.stdout, /- vorher: `document\.title === 'Übersicht – Bestellungen'`/);
    assert.equal(run('gibts-nicht').status, 3);
});

test('caw audit: a design file a step links, replaced in the working tree, weakens that step; an unlinked one is not read', (t) => {
    const { root, git, write } = repository(t);
    write('caw/tests/bestellung.yaml', TEST.replace('    expect: Eine', '    design: design/form.html\n    expect: Eine'));
    write('caw/design/form.html', '<main><button>Bestellen</button></main>');
    write('caw/design/other.html', '<main>alt</main>');
    git('add', '-A');
    git('commit', '-q', '-m', 'Design');
    git('checkout', '-q', '-b', 'feature');
    let printed = '';
    const print = (text) => { printed = text; };
    write('caw/design/other.html', '<main>neu</main>');
    assert.equal(auditCommand(root, ['main', '--json'], { print }), 0, 'a design no step links changes no judgement');
    write('caw/design/form.html', '<main></main>');
    assert.equal(auditCommand(root, ['main', '--json'], { print }), 1);
    assert.deepEqual(JSON.parse(printed).findings.map(({ kind, step }) => `${kind}:${step}`), ['design-file-changed:S1']);
    rmSync(join(root, 'caw/design/form.html'));
    assert.equal(auditCommand(root, ['main', '--json'], { print }), 1, 'a linked design that is gone weakens too');
});

test('caw audit: decisions this machine took outside the window since the merge base that changed something, for information', (t) => {
    const { root, git } = repository(t);
    git('checkout', '-q', '-b', 'feature');
    const runs = join(root, '.caw', 'runs');
    const result = (runId, decisions) => {
        mkdirSync(join(runs, runId), { recursive: true });
        writeFileSync(join(runs, runId, 'result.json'), JSON.stringify({ status: 'pass', decisions }));
    };
    const now = new Date(Date.now() + 60_000).toISOString().replace(/[:.]/g, '-');
    result(`${now}-bestellung`, [{ id: 'plan.approve', option: 'approve', by: 'auto' }, { id: 'recording.adopt', option: 'adopt', by: 'auto' }, { id: 'step.failed', option: 'close', by: 'session' }]);
    result('2020-01-01T00-00-00-000Z-bestellung', [{ id: 'recording.adopt', option: 'adopt', by: 'auto' }]);
    result(`${now}-andere`, [{ id: 'fix.green', option: 'promote', by: 'elicitation' }, { id: 'recording.adopt', option: 'adopt', by: 'window' }]);
    let printed = '';
    const print = (text) => { printed = text; };
    assert.equal(auditCommand(root, ['main', '--json'], { print }), 0);
    assert.deepEqual(JSON.parse(printed).decided.map(({ test: id, decision, option, by }) => `${id} ${decision} ${option} ${by}`), ['bestellung recording.adopt adopt auto', 'andere fix.green promote elicitation']);
    assert.equal(auditCommand(root, ['main'], { print }), 0);
    assert.match(printed, /### Außerhalb des Fensters entschieden \(2\)/);
    assert.match(printed, /- `bestellung`: recording\.adopt: adopt \(auto\), Lauf /);
});
