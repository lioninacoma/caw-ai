import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { prepareOverlay } from '../src/host/overlay.mjs';
import { isProjectCopy, isProjectCopyFile } from '../src/host/project-files.mjs';

const project = (t, files, { git = false } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-project-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    if (git) execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
};

const FILES = {
    'public/env.js': "window.__ENV__='local'",
    'src/main.tsx': 'import "./app";',
    'dist/env.js': "window.__ENV__='local'",
    'dist/assets/index-AB12CD34.js': 'console.log("kompiliert")',
    'deploy/assets/index-AB12CD34.js': 'console.log("kompiliert")',
    'node_modules/x/env.js': 'console.log("kompiliert")',
};

test('isProjectCopy: a copy from public/ is one, compiled code never, not even in another build folder (Git)', (t) => {
    const dir = project(t, { ...FILES, '.gitignore': 'dist\ndeploy\nnode_modules\n' }, { git: true });
    const skip = [join(dir, 'dist')];
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/env.js'), { skip }), true);
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/assets/index-AB12CD34.js'), { skip }), false, 'deploy/ is ignored, node_modules too');
    assert.equal(isProjectCopy(dir, Buffer.from("window.__ENV__='local'"), { skip }), true);
    assert.equal(isProjectCopy(dir, Buffer.from("window.__ENV__='lokal'"), { skip }), false, 'same length, different content');
    assert.equal(isProjectCopy(dir, Buffer.alloc(0), { skip }), false);
    assert.equal(isProjectCopy('', Buffer.from('x')), false);
});

test('isProjectCopy: without Git, node_modules, dot folders and the build folder do not count', (t) => {
    const dir = project(t, { 'public/env.js': "window.__ENV__='local'", 'dist/env.js': "window.__ENV__='local'", 'dist/main.js': 'a()', 'node_modules/y/main.js': 'a()', '.cache/main.js': 'a()' });
    const skip = [join(dir, 'dist')];
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/env.js'), { skip }), true);
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/main.js'), { skip }), false);
});

test('Overlay: env.js from public/ comes from the server, the compiled entry from the build', async (t) => {
    const dir = project(t, { 'public/env.js': "window.__ENV__='local'", 'dist/env.js': "window.__ENV__='local'", 'dist/index.html': '<script type="module" src="/assets/index-NEW11111.js"></script>', 'dist/assets/index-NEW11111.js': 'export{}' });
    const overlay = await prepareOverlay({ root: dir, config: { apps: { web: { dir: '.' } } }, checked: { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [] } } } });
    assert.equal(await overlay.resolve('https://app.example/env.js', 'script'), null);
    assert.equal((await overlay.resolve('https://app.example/assets/index-OLD99999.js', 'script')).file, join(dir, 'dist', 'assets', 'index-NEW11111.js'));
});
