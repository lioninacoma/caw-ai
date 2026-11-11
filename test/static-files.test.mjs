// overlay.statics with .. : inside the workspace allowed, outside (also through a symlink) and secret files refused.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { overlayStatus } from '../src/host/overlay-check.mjs';
import { prepareOverlay } from '../src/host/overlay.mjs';
import { staticFile, workspaceRoot } from '../src/host/static-files.mjs';
import { validateConfig } from '../src/shared/config.mjs';

/**
 * A pnpm monorepo in a temp folder: <tmp>/ws with .git and pnpm-workspace.yaml, the app (with caw.config.json) in
 * projects/apps/App, a package with the constants next to it, and <tmp>/outside beyond the workspace.
 */
const monorepo = (t, { marker = true } = {}) => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'caw-statics-')));
    t.after(() => rmSync(top, { recursive: true, force: true }));
    const ws = join(top, 'ws');
    const files = {
        'ws/.git/HEAD': 'ref: refs/heads/main\n',
        ...(marker ? { 'ws/pnpm-workspace.yaml': "packages:\n  - 'projects/**'\n" } : {}),
        'ws/projects/apps/App/caw.config.json': '{}',
        'ws/projects/packages/Model/resources/Const.js': "window.CONST = 'v1';",
        'ws/projects/packages/Model/.env': 'SECRET=1',
        'outside/x.js': 'outside',
    };
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(top, name, '..'), { recursive: true });
        writeFileSync(join(top, name), text);
    }
    return { top, ws, app: join(ws, 'projects/apps/App') };
};

const NEIGHBOUR = '../../packages/Model/resources/Const.js';

test('config: a statics path may leave the app folder with .., but is never absolute', () => {
    const config = (path) => ({
        environments: { dev: { url: 'https://dev.example', overlay: true } },
        apps: { web: { dir: '.', startUrl: '/', overlay: { statics: [{ name: 'Fx/Const.js', path }] } } },
    });
    assert.deepEqual(validateConfig(config(NEIGHBOUR)).issues, []);
    assert.deepEqual(validateConfig(config('const.js')).issues, []);
    for (const path of ['/etc/x.js', 'C:/x.js', 'C:\\x.js', '\\\\server\\x.js', '', ' ']) {
        assert.match(validateConfig(config(path)).issues.join('\n'), /overlay\.statics\[0\]/, JSON.stringify(path));
    }
});

test('workspace root: the nearest folder with pnpm-workspace.yaml, never above the repository; without one the project folder', (t) => {
    const { ws, app } = monorepo(t);
    assert.equal(workspaceRoot(app), ws);
    const bare = monorepo(t, { marker: false });
    assert.equal(workspaceRoot(bare.app), bare.app, 'no workspace: the project folder');
    // A workspace marker above the repository (.git) does not count.
    writeFileSync(join(bare.top, 'pnpm-workspace.yaml'), '');
    assert.equal(workspaceRoot(bare.app), bare.app);
    // package.json "workspaces" (npm, yarn) marks one too.
    writeFileSync(join(bare.ws, 'package.json'), JSON.stringify({ workspaces: ['projects/*'] }));
    assert.equal(workspaceRoot(bare.app), bare.ws);
});

test('statics path: a neighbouring package is fine; outside the workspace, through a symlink outside, or a secret file is not', (t) => {
    const { top, ws, app } = monorepo(t);
    const ok = staticFile(app, app, NEIGHBOUR);
    assert.deepEqual([ok.state, ok.file], ['ok', join(ws, 'projects/packages/Model/resources/Const.js')]);
    assert.equal(staticFile(app, app, '../../packages/Model/resources/Nope.js').state, 'missing');
    assert.equal(staticFile(app, app, '../../../../outside/x.js').state, 'outside');
    assert.equal(staticFile(app, app, '../../packages/Model/.env').state, 'secret');
    // A junction (a symlink without admin rights on Windows) inside the app that leads outside: resolved, so outside.
    symlinkSync(join(top, 'outside'), join(app, 'linked'), 'junction');
    assert.equal(staticFile(app, app, 'linked/x.js').state, 'outside');
    // Without a workspace marker the boundary is the project folder: the neighbouring package is outside.
    const bare = monorepo(t, { marker: false });
    assert.equal(staticFile(bare.app, bare.app, NEIGHBOUR).state, 'outside');
});

test('overlay: a static from a neighbouring package is served fresh from disk on every load; outside stops the run before the browser', async (t) => {
    const { ws, app } = monorepo(t);
    const config = { apps: { web: { dir: '.' } } };
    const checked = (path) => ({ url: 'https://portal.example', apps: { web: { kind: 'files', statics: [{ name: 'Fachanwendung/Const.js', path }] } } });
    const overlay = await prepareOverlay({ root: app, config, checked: checked(NEIGHBOUR) });
    const url = 'https://portal.example/Fachanwendung/Const.js';
    assert.equal(String((await overlay.resolve(url, 'script')).body), "window.CONST = 'v1';");
    writeFileSync(join(ws, 'projects/packages/Model/resources/Const.js'), "window.CONST = 'v2';");
    assert.equal(String((await overlay.resolve(url, 'script')).body), "window.CONST = 'v2';", 'changed on disk, no restart');
    assert.equal(overlay.fileFor(url), join(ws, 'projects/packages/Model/resources/Const.js'));
    await assert.rejects(prepareOverlay({ root: app, config, checked: checked('../../../../outside/x.js') }),
        (error) => error.code === 'config-invalid' && error.message.includes(ws));
    await assert.rejects(prepareOverlay({ root: app, config, checked: checked('../../packages/Model/.env') }), { code: 'config-invalid' });
});

test('overlay status: lists every static with its state; a broken one is static-invalid or static-missing', async (t) => {
    const { app } = monorepo(t);
    const config = (statics) => ({
        framework: 'web',
        environments: { dev: { url: 'https://dev.example', overlay: true } },
        apps: { web: { dir: '.', startUrl: '/', overlay: { statics } } },
    });
    const fine = await overlayStatus(app, { config: config([{ name: 'Fx/Const.js', path: NEIGHBOUR }]) });
    assert.equal(fine.state, 'ready');
    assert.deepEqual(fine.statics, [{ name: 'Fx/Const.js', path: NEIGHBOUR, state: 'ok' }]);
    const outside = await overlayStatus(app, { config: config([{ name: 'Fx/X.js', path: '../../../../outside/x.js' }]) });
    assert.equal(outside.state, 'static-invalid');
    assert.equal(outside.statics[0].state, 'outside');
    const missing = await overlayStatus(app, { config: config([{ name: 'Fx/Const.js', path: NEIGHBOUR }, { name: 'Fx/Nope.js', path: 'nope.js' }]) });
    assert.equal(missing.state, 'static-missing');
    assert.deepEqual(missing.statics.map(({ state }) => state), ['ok', 'missing']);
});
