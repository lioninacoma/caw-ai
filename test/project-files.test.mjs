import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { localFileFor } from '../src/host/devlink-core.mjs';
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

test('isProjectCopy: Eine Kopie aus public/ ist eine, kompilierter Code nie, auch nicht in einem anderen Build-Ordner (Git)', (t) => {
    const dir = project(t, { ...FILES, '.gitignore': 'dist\ndeploy\nnode_modules\n' }, { git: true });
    const skip = [join(dir, 'dist')];
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/env.js'), { skip }), true);
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/assets/index-AB12CD34.js'), { skip }), false, 'deploy/ ist ignoriert, node_modules auch');
    assert.equal(isProjectCopy(dir, Buffer.from("window.__ENV__='local'"), { skip }), true);
    assert.equal(isProjectCopy(dir, Buffer.from("window.__ENV__='lokal'"), { skip }), false, 'gleich lang, anderer Inhalt');
    assert.equal(isProjectCopy(dir, Buffer.alloc(0), { skip }), false);
    assert.equal(isProjectCopy('', Buffer.from('x')), false);
});

test('isProjectCopy: Ohne Git zaehlen node_modules, Punktordner und der Build-Ordner nicht', (t) => {
    const dir = project(t, { 'public/env.js': "window.__ENV__='local'", 'dist/env.js': "window.__ENV__='local'", 'dist/main.js': 'a()', 'node_modules/y/main.js': 'a()', '.cache/main.js': 'a()' });
    const skip = [join(dir, 'dist')];
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/env.js'), { skip }), true);
    assert.equal(isProjectCopyFile(dir, join(dir, 'dist/main.js'), { skip }), false);
});

test('localFileFor: env.js aus public/ kommt vom Server, der kompilierte Einstieg aus dem Build', (t) => {
    const dir = project(t, { 'public/env.js': "window.__ENV__='local'", 'dist/env.js': "window.__ENV__='local'", 'dist/index.html': '<script type="module" src="/assets/index-NEW11111.js"></script>', 'dist/assets/index-NEW11111.js': 'export{}' });
    const config = { projects: [{ active: true, redirects: [], constants: [], statics: [], builds: [{ active: true, localDir: join(dir, 'dist'), projectDir: dir, urlPattern: '^https://app\\.example/([^?#]*)' }] }] };
    assert.equal(localFileFor(config, 'https://app.example/env.js', 'script'), null);
    assert.equal(localFileFor(config, 'https://app.example/assets/index-OLD99999.js', 'script').file, join(dir, 'dist', 'assets', 'index-NEW11111.js'));
});
