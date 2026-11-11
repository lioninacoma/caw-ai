import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { overlayCheck, overlayCheckExit, overlayCommand, overlayPreconditions } from '../src/host/overlay-check.mjs';
import { CawError } from '../src/shared/errors.mjs';

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

test('overlayPreconditions: no app, no overlay environment, watch missing or stale, ready; never starts anything', (t) => {
    const root = project(t, { bootstrap: false });
    const settings = config();
    assert.equal(overlayPreconditions(root, settings, { target: 'dev', app: 'shop' }).state, 'no-app');
    const local = overlayPreconditions(root, settings, { target: 'test', app: 'web', running: () => true });
    assert.equal(local.state, 'not-overlay');
    assert.match(local.message, /"overlay": true in environments\.test/);
    const missing = overlayPreconditions(root, settings, { target: 'dev', app: 'web', running: () => false });
    assert.deepEqual({ ...missing, message: undefined }, { state: 'watch-missing', framework: 'extjs', appDir: 'app', command: 'sencha app watch', message: undefined });
    assert.match(missing.message, /Starte sencha app watch in app .*caw startet ihn nicht selbst/);
    const noBootstrap = overlayPreconditions(root, settings, { target: 'dev', app: 'web', running: () => true });
    assert.equal(noBootstrap.state, 'watch-missing');
    assert.match(noBootstrap.message, /bootstrap\.json fehlt/);
    writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/weg.js' }] }));
    assert.equal(overlayPreconditions(root, settings, { target: 'dev', app: 'web', running: () => true }).state, 'watch-stale');
    writeFileSync(join(root, 'app', 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app/Main.js' }] }));
    assert.deepEqual(overlayPreconditions(root, settings, { target: 'dev', running: () => null }), { state: 'ready', framework: 'extjs', appDir: 'app', command: 'sencha app watch' }, 'unknown process list: as running');
    // With devCommand caw may start the watch itself during the run: ready.
    const withCommand = config({ apps: { web: { dir: 'app', startUrl: '/start', overlay: { devCommand: 'npx sencha app watch' } } } });
    assert.equal(overlayPreconditions(root, withCommand, { target: 'dev', running: () => false }).state, 'ready');
    assert.deepEqual(overlayPreconditions(root, { ...settings, framework: 'react' }, { target: 'dev' }), { state: 'ready', framework: 'react', appDir: 'app' });
    assert.throws(() => overlayPreconditions(root, settings, { target: 'prod' }), (error) => error.code === 'target-invalid');
});

test('overlay check: headless, not strict; complete and incomplete; always .caw/overlay-check.json and last-run.json', async (t) => {
    const root = project(t);
    const { openSession, calls } = sessions(completeDiagnosis, missedDiagnosis);
    const complete = await overlayCheck(root, { deps: { openSession, running: () => true, now } });
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
    const incomplete = await overlayCheck(root, { target: 'dev', app: 'web', deps: { openSession, running: () => true, now } });
    assert.equal(incomplete.state, 'incomplete');
    assert.equal(overlayCheckExit(incomplete), 2);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.caw', 'overlay-check.json'), 'utf8')), incomplete);
    assert.deepEqual(Object.keys(incomplete).slice(0, 9), ['at', 'target', 'app', 'state', 'parts', 'missed', 'notLoaded', 'suggestions', 'unresolved']);
});

test('overlay check --apply: adds only the missing pattern, a single string becomes a list, then checks once more', async (t) => {
    const root = project(t, { settings: config({ assetUrlPattern: '^https://cdn\\.example/([^/?#]+\\.js)' }) });
    const { openSession, calls } = sessions(missedDiagnosis, completeDiagnosis);
    const result = await overlayCheck(root, { apply: true, deps: { openSession, running: () => true, now } });
    assert.equal(calls.length, 2);
    assert.equal(result.state, 'complete');
    assert.deepEqual(result.applied, [PATTERN]);
    const saved = JSON.parse(readFileSync(join(root, 'caw.config.json'), 'utf8'));
    assert.deepEqual(saved.assetUrlPattern, ['^https://cdn\\.example/([^/?#]+\\.js)', PATTERN]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.caw', 'overlay-check.json'), 'utf8')).applied, [PATTERN]);
    // A pattern already listed is not added twice.
    const again = sessions(missedDiagnosis);
    const unchanged = await overlayCheck(root, { apply: true, deps: { openSession: again.openSession, running: () => true, now } });
    assert.deepEqual(unchanged.applied, []);
    assert.equal(again.calls.length, 1);
});

test('overlay check: watch missing without a browser; session errors become state error', async (t) => {
    const root = project(t);
    const { openSession, calls } = sessions(new CawError('login-failed', 'Anmeldung fehlgeschlagen'));
    const missing = await overlayCheck(root, { deps: { openSession, running: () => false, now } });
    assert.equal(missing.state, 'watch-missing');
    assert.equal(missing.command, 'sencha app watch');
    assert.equal(calls.length, 0, 'no browser');
    assert.equal(overlayCheckExit(missing), 2);
    const failed = await overlayCheck(root, { deps: { openSession, running: () => true, now } });
    assert.deepEqual([failed.state, failed.code, failed.message], ['error', 'login-failed', 'Anmeldung fehlgeschlagen']);
    const notOverlay = await overlayCheck(root, { target: 'test', deps: { openSession, running: () => true, now } });
    assert.equal(overlayCheckExit(notOverlay), 3);
    assert.ok(existsSync(join(root, '.caw', 'overlay-check.json')));
});

test('caw-ai overlay check --json: the result is the only stdout line; unknown arguments are usage errors', async (t) => {
    const root = project(t);
    const { openSession } = sessions(missedDiagnosis);
    const out = [];
    t.mock.method(console, 'error', () => {});
    const exit = await overlayCommand(root, ['check', '--json', '--target', 'dev'], { out: (line) => out.push(line), deps: { openSession, running: () => true, now } });
    assert.equal(exit, 2);
    assert.equal(out.length, 1);
    assert.equal(JSON.parse(out[0]).state, 'incomplete');
    await assert.rejects(overlayCommand(root, ['run']), (error) => error.code === 'usage' && /overlay kennt nur check/.test(error.message));
    await assert.rejects(overlayCommand(root, ['check', '--fast']), (error) => error.code === 'usage' && /--fast/.test(error.message));
    const lines = [];
    t.mock.method(console, 'log', (text) => lines.push(text));
    const again = sessions(missedDiagnosis);
    assert.equal(await overlayCommand(root, ['check'], { deps: { openSession: again.openSession, running: () => true, now } }), 2);
    const text = lines.join('\n');
    assert.match(text, /Bestellung: ausgeliefert/);
    assert.match(text, /modell: lokal/);
    assert.match(text, /assetUrlPattern "\[\?&\]url=repo/);
    assert.match(text, /--apply trägt die Muster ein/);
});
