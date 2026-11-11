import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { overlayCheck, overlayCheckExit, overlayCommand, overlayStatus, overlayStatusExit } from '../src/host/overlay-check.mjs';
import { CawError } from '../src/shared/errors.mjs';
import { folderFetch } from './static-server.mjs';

const PROXY = 'https://dev.firma.intern/o/Proxy?url=repo:///Root/';
const PATTERN = '[?&]url=repo:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)';
const config = (extra = {}) => ({
    framework: 'extjs',
    environments: { local: { url: 'http://localhost:1841' }, dev: { url: 'https://dev.firma.intern', overlay: true }, test: { url: 'https://test.firma.intern' } },
    apps: { web: { dir: 'app', startUrl: '/start' } },
    ...extra,
});

/** A project with an ExtJS app; bootstrap.json only if given. */
const project = (t, { bootstrap = true, settings = config() } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'caw-overlay-check-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'app', 'app'), { recursive: true });
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify(settings, null, 4));
    writeFileSync(join(root, 'app', 'app.json'), JSON.stringify({ name: 'Bestellung' }));
    writeFileSync(join(root, 'app', 'app', 'Main.js'), '');
    if (bootstrap) writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Main.js' }] }));
    return root;
};

const PARTS = [{ label: 'Bestellung', kind: 'app', names: ['app.js'] }, { label: 'modell', kind: 'package', names: ['modell.js', 'modell-debug.js'] }];
const missedDiagnosis = {
    parts: [{ ...PARTS[0], status: 'deployed' }, { ...PARTS[1], status: 'local' }],
    missed: [{ url: `${PROXY}Fa/app.js`, name: 'app.js', part: 'Bestellung' }],
    notLoaded: [],
    suggestions: [{ source: PROXY, pattern: PATTERN, urls: [`${PROXY}Fa/app.js`] }],
    unresolved: [],
};
const completeDiagnosis = { parts: PARTS.map((part) => ({ ...part, status: 'local' })), missed: [], notLoaded: [], suggestions: [], unresolved: [] };

/** A fake session per call, in order; records how it was opened. */
const sessions = (...diagnoses) => {
    const calls = [];
    const openSession = async (options) => {
        calls.push(options);
        const seen = diagnoses[calls.length - 1];
        if (seen instanceof Error) throw seen;
        return { diagnose: () => seen, overlay: () => ({}), close: async () => { calls.at(-1).closed = true; } };
    };
    return { openSession, calls };
};

const now = () => new Date('2026-11-11T12:00:00.000Z');

// The Sencha watch at its default address, serving the app folder (as FA214's watch does); nothing listens anywhere else.
const WATCH = 'http://localhost:1841/';
const watching = (root) => ({ fetchImpl: folderFetch(join(root, 'app'), WATCH), discover: async () => null });
const noWatch = { fetchImpl: async () => { throw new TypeError('fetch failed'); }, discover: async () => null };

test('overlayStatus: no app, no overlay environment, down, wrong app, stale, moved, ready; never starts anything', async (t) => {
    const root = project(t);
    const settings = config();
    const status = (options, deps = watching(root), given = settings) => overlayStatus(root, { config: given, deps, ...options });
    assert.equal((await status({ target: 'dev', app: 'shop' })).state, 'no-app');
    const local = await status({ target: 'test', app: 'web' });
    assert.equal(local.state, 'not-overlay');
    assert.match(local.message, /"overlay": true in environments\.test/);
    assert.deepEqual(await status({ target: 'dev' }), { state: 'ready', framework: 'extjs', app: 'web', appDir: 'app', url: WATCH, start: null });
    const down = await status({ target: 'dev' }, noWatch);
    assert.deepEqual({ ...down, message: undefined }, { state: 'down', framework: 'extjs', app: 'web', appDir: 'app', url: WATCH, start: null, message: undefined });
    assert.match(down.message, /Der lokale Code-Server http:\/\/localhost:1841\/ antwortet nicht\. Starte ihn und trage seinen Befehl in apps\.web\.overlay\.start ein/);
    // The configured address and start command; the earlier names are read as well.
    const own = config({ apps: { web: { dir: 'app', startUrl: '/start', overlay: { url: 'http://localhost:1842/', start: 'pnpm run watch' } } } });
    const named = await status({ target: 'dev' }, noWatch, own);
    assert.deepEqual([named.url, named.start], ['http://localhost:1842/', 'pnpm run watch']);
    assert.match(named.message, /Starte pnpm run watch in app oder starte den Lauf mit --start/);
    const old = config({ apps: { web: { dir: 'app', startUrl: '/start', overlay: { devCommand: 'npx sencha app watch' } } } });
    assert.equal((await status({ target: 'dev' }, noWatch, old)).start, 'npx sencha app watch');
    // Found on another port.
    const moved = await status({ target: 'dev' }, { ...noWatch, discover: async ({ url }) => (url === WATCH ? 'http://localhost:52775/' : null) });
    assert.deepEqual([moved.state, moved.foundUrl, overlayStatusExit(moved)], ['moved', 'http://localhost:52775/', 0]);
    assert.match(moved.message, /läuft unter http:\/\/localhost:52775\/, nicht unter http:\/\/localhost:1841\//);
    // The watch of another app on the port, or a server that is no watch at all.
    const other = project(t);
    writeFileSync(join(other, 'app', 'app.json'), JSON.stringify({ name: 'Zertifizierung' }));
    const otherApp = await status({ target: 'dev' }, watching(other));
    assert.deepEqual([otherApp.state, overlayStatusExit(otherApp)], ['wrong-app', 2]);
    assert.match(otherApp.message, /liefert die App Zertifizierung, nicht Bestellung/);
    const noWatchHere = await status({ target: 'dev' }, { fetchImpl: folderFetch(join(root, 'leer'), WATCH), discover: async () => null });
    assert.equal(noWatchHere.state, 'wrong-app');
    // bootstrap.json missing or naming a file the server lacks.
    writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/weg.js' }] }));
    const stale = await status({ target: 'dev' });
    assert.deepEqual([stale.state, overlayStatusExit(stale)], ['stale', 2]);
    assert.match(stale.message, /app\/weg\.js/);
    rmSync(join(root, 'app', 'bootstrap.json'));
    assert.equal((await status({ target: 'dev' })).state, 'stale');
    // Other frameworks: any answer of the dev server counts; a build needs no server.
    const react = config({ framework: 'react', apps: { web: { dir: 'app', startUrl: '/start', overlay: { url: 'http://localhost:5173/', start: 'npm run dev' } } } });
    const reactUp = { fetchImpl: async () => new Response('<!doctype html>', { status: 200 }) };
    assert.deepEqual(await status({ target: 'dev' }, reactUp, react), { state: 'ready', framework: 'react', app: 'web', appDir: 'app', url: 'http://localhost:5173/', start: 'npm run dev' });
    assert.equal((await status({ target: 'dev' }, noWatch, react)).state, 'down');
    const build = config({ framework: 'react', apps: { web: { dir: 'app', startUrl: '/start', overlay: { build: 'dist' } } } });
    assert.deepEqual(await status({ target: 'dev' }, noWatch, build), { state: 'ready', framework: 'react', app: 'web', appDir: 'app', url: null, start: null });
    const none = await status({ target: 'dev' }, noWatch, config({ framework: 'react' }));
    assert.deepEqual([none.state, overlayStatusExit(none)], ['not-overlay', 3]);
    rmSync(join(root, 'app', 'app.json'));
    assert.equal((await status({ target: 'dev' })).state, 'no-app');
    await assert.rejects(status({ target: 'prod' }), (error) => error.code === 'target-invalid');
});

test('overlay check: headless, not strict; complete and incomplete; always .caw/overlay-check.json and last-run.json', async (t) => {
    const root = project(t);
    const { openSession, calls } = sessions(completeDiagnosis, missedDiagnosis);
    const complete = await overlayCheck(root, { deps: { openSession, ...watching(root), now } });
    assert.equal(complete.state, 'complete');
    assert.equal(complete.target, 'dev', 'the only environment with overlay');
    assert.equal(complete.app, 'web');
    assert.equal(overlayCheckExit(complete), 0);
    assert.equal(calls[0].headless, true);
    assert.equal(calls[0].strict, false);
    assert.equal(calls[0].checked.source, 'overlay');
    assert.equal(calls[0].closed, true);
    const lastRun = JSON.parse(readFileSync(join(root, '.caw', 'last-run.json'), 'utf8'));
    assert.deepEqual({ ...lastRun, pid: undefined }, { runId: '2026-11-11T12-00-00-000Z-overlay-check', runDir: '.caw/runs/2026-11-11T12-00-00-000Z-overlay-check', pid: undefined, command: 'overlay-check', test: null, target: 'dev', startedAt: lastRun.startedAt });
    const incomplete = await overlayCheck(root, { target: 'dev', app: 'web', deps: { openSession, ...watching(root), now } });
    assert.equal(incomplete.state, 'incomplete');
    assert.equal(overlayCheckExit(incomplete), 2);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.caw', 'overlay-check.json'), 'utf8')), incomplete);
    assert.deepEqual(Object.keys(incomplete).slice(0, 9), ['at', 'target', 'app', 'state', 'parts', 'missed', 'notLoaded', 'suggestions', 'unresolved']);
});

test('overlay check --apply: adds only the missing pattern, a single string becomes a list, then checks once more', async (t) => {
    const root = project(t, { settings: config({ assetUrlPattern: '^https://cdn\\.example/([^/?#]+\\.js)' }) });
    const { openSession, calls } = sessions(missedDiagnosis, completeDiagnosis);
    const result = await overlayCheck(root, { apply: true, deps: { openSession, ...watching(root), now } });
    assert.equal(calls.length, 2);
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.applied, [PATTERN]);
    const saved = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.deepEqual(saved.assetUrlPattern, ['^https://cdn\\.example/([^/?#]+\\.js)', PATTERN]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.caw', 'overlay-check.json'), 'utf8')).applied, [PATTERN]);
    // A pattern already listed is not added twice.
    const again = sessions(missedDiagnosis);
    const unchanged = await overlayCheck(root, { apply: true, deps: { openSession: again.openSession, ...watching(root), now } });
    assert.deepEqual(unchanged.applied, []);
    assert.equal(again.calls.length, 1);
});

test('overlay check: server down without a browser, with --start the run starts it; session errors become states', async (t) => {
    const root = project(t, { settings: config({ apps: { web: { dir: 'app', startUrl: '/start', overlay: { start: 'pnpm run watch' } } } }) });
    const { openSession, calls } = sessions(new CawError('login-failed', 'Anmeldung fehlgeschlagen'), new CawError('overlay-stale', 'veraltet'), completeDiagnosis);
    const missing = await overlayCheck(root, { deps: { openSession, ...noWatch, now } });
    assert.equal(missing.state, 'down');
    assert.deepEqual([missing.url, missing.start, missing.appDir], [WATCH, 'pnpm run watch', 'app']);
    assert.equal(calls.length, 0, 'no browser');
    assert.equal(overlayCheckExit(missing), 2);
    const failed = await overlayCheck(root, { deps: { openSession, ...watching(root), now } });
    assert.deepEqual([failed.state, failed.code, failed.message], ['error', 'login-failed', 'Anmeldung fehlgeschlagen']);
    const stale = await overlayCheck(root, { deps: { openSession, ...watching(root), now } });
    assert.deepEqual([stale.state, stale.code], ['stale', 'overlay-stale']);
    const started = await overlayCheck(root, { start: true, deps: { openSession, ...noWatch, now } });
    assert.equal(started.state, 'complete');
    assert.equal(calls[2].checked.apps.web.command, 'pnpm run watch', 'the session may run overlay.start');
    assert.equal(calls[1].checked.apps.web.command, undefined, 'without --start it may not');
    const notOverlay = await overlayCheck(root, { target: 'test', deps: { openSession, ...watching(root), now } });
    assert.equal(overlayCheckExit(notOverlay), 3);
    assert.ok(existsSync(join(root, '.caw', 'overlay-check.json')));
});

test('caw-ai overlay check --json: the result is the only stdout line; unknown arguments are usage errors', async (t) => {
    const root = project(t);
    const { openSession } = sessions(missedDiagnosis);
    const out = [];
    t.mock.method(console, 'error', () => {});
    const exit = await overlayCommand(root, ['check', '--json', '--target', 'dev'], { out: (line) => out.push(line), deps: { openSession, ...watching(root), now } });
    assert.equal(exit, 2);
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).state, 'incomplete');
    await assert.rejects(overlayCommand(root, ['run']), (error) => error.code === 'usage' && /overlay kennt status und check/.test(error.message));
    await assert.rejects(overlayCommand(root, ['check', '--fast']), (error) => error.code === 'usage' && /--fast/.test(error.message));
    await assert.rejects(overlayCommand(root, ['status', '--apply']), (error) => error.code === 'usage' && /overlay status kennt --apply nicht/.test(error.message));
    const lines = [];
    t.mock.method(console, 'log', (text) => lines.push(text));
    const again = sessions(missedDiagnosis);
    assert.equal(await overlayCommand(root, ['check'], { deps: { openSession: again.openSession, ...watching(root), now } }), 2);
    const text = lines.join('\n');
    assert.match(text, /Bestellung: ausgeliefert/);
    assert.match(text, /modell: lokal/);
    assert.match(text, /assetUrlPattern "\[\?&\]url=repo/);
    assert.match(text, /--apply trägt die Muster ein/);
});

test('caw-ai overlay status: --json is the status as one line; exit 0 ready or moved, 2 server, 3 config', async (t) => {
    const root = project(t);
    t.mock.method(console, 'error', () => {});
    const out = [];
    assert.equal(await overlayCommand(root, ['status', '--json'], { out: (line) => out.push(line), deps: watching(root) }), 0);
    assert.deepEqual(JSON.parse(out[0]), { state: 'ready', framework: 'extjs', app: 'web', appDir: 'app', url: WATCH, start: null });
    assert.equal(await overlayCommand(root, ['status', '--json', '--target', 'dev'], { out: (line) => out.push(line), deps: noWatch }), 2);
    assert.equal(JSON.parse(out[1]).state, 'down');
    assert.equal(await overlayCommand(root, ['status', '--json', '--target', 'test'], { out: (line) => out.push(line), deps: noWatch }), 3);
    const lines = [];
    t.mock.method(console, 'log', (text) => lines.push(text));
    assert.equal(await overlayCommand(root, ['status'], { deps: watching(root) }), 0);
    assert.match(lines.join('\n'), /Lokaler Code für web ist bereit: http:\/\/localhost:1841\//);
    assert.equal(existsSync(join(root, '.caw', 'overlay-check.json')), false, 'status writes nothing');
});
