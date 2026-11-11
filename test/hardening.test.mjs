// Findings of the cross-review: one test each that shows the original bug. Pure functions, no Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAgentHandler } from '../src/host/agent-commands.mjs';
import { hideSecrets } from '../src/host/demonstrate.mjs';
import { diagnose } from '../src/host/diagnose.mjs';
import { isEffectCause } from '../src/host/effects.mjs';
import { parseEnvFile, parseRunArgs } from '../src/host/linux.mjs';
import { buildCheck, moduleAlias, scriptKind, servesBuild, withoutIntegrity } from '../src/host/local-build.mjs';
import { prepareOverlay } from '../src/host/overlay.mjs';
import { swapToken } from '../src/host/replay.mjs';
import { isCaughtScriptError } from '../src/shared/report.mjs';

const folder = (t, files) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-hard-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
};

const CAUSE = 'Die Prüfung ist erfüllt, aber die Anwendung reagiert anders als in gesunden Läufen.';

test('effect: recognised as the cause also after retries and with a failed check', () => {
    assert.equal(isEffectCause(`${CAUSE} Aktion 1 click`), true);
    assert.equal(isEffectCause(`In allen 2 Versuchen gescheitert: ${CAUSE}`), true);
    assert.equal(isEffectCause(`Auch im 3. Versuch gescheitert: ${CAUSE} Davor: Text fehlt.`), true);
    assert.equal(isEffectCause(`Auch im 3. Versuch gescheitert: Text fehlt. Davor: ${CAUSE}`), false, 'only the last attempt counts');
    assert.equal(isEffectCause('Text fehlt.'), false);
    // Every failed check reports a break of kind check: that does not rule out the effect as the cause.
    const deviation = { step: 'S2', number: 1, label: 'click', lists: ['controls', 'requests'], missing: [], extra: ['heading "Assistent"'], instead: [], learned: true, fails: true };
    const found = diagnose({ failed: { id: 'S2', reason: `${CAUSE} Aktion 1 click` }, broken: { step: 'S2', kind: 'check' }, deviation });
    assert.deepEqual([found.side, found.strength], ['app', 'likely']);
    assert.match(found.findings.join(' '), /Datenstand/);
});

test('swapToken: also in the name of enclosing iframes, nested', () => {
    const step = { action: 'click', target: { role: 'button', name: 'Zahlen', frame: { tag: 'iframe', name: 'Bestellung 4711', frame: { tag: 'iframe', name: 'Kasse 4711' } } } };
    const swapped = swapToken(step, '4711', '{{nummer}}');
    assert.equal(swapped.target.frame.name, 'Bestellung {{nummer}}');
    assert.equal(swapped.target.frame.frame.name, 'Kasse {{nummer}}');
    assert.equal(step.target.frame.name, 'Bestellung 4711', 'the original stays');
});

test('demonstration: a password in a visible field counts as secret input, otherwise it is redacted', () => {
    const session = { secrets: () => ['Geheim-1234', ''] };
    assert.deepEqual(hideSecrets(session, { action: 'fill', target: { role: 'textbox', name: 'Passwort' }, value: 'Geheim-1234' }), { action: 'fill', target: { role: 'textbox', name: 'Passwort' }, secret: true });
    assert.deepEqual(hideSecrets(session, { action: 'fill', target: null, value: 'Max' }), { action: 'fill', target: null, value: 'Max' }, 'an empty secret does not match everything');
    assert.doesNotMatch(JSON.stringify(hideSecrets(session, { action: 'note', text: 'mit Geheim-1234 angemeldet' })), /Geheim-1234/);
    assert.deepEqual(hideSecrets({ secrets: () => [] }, { action: 'fill', value: 'x' }), { action: 'fill', value: 'x' });
});

test('caw/.env like dotenv: trailing comment, quotes, whitespace; # without whitespace belongs to the value', () => {
    const env = parseEnvFile('A=secret # test account\nB="quoted" # c\nC=\'a b\'\nD= spaced \nE=pa#ss\r\n# whole line\nexport F=x\nG="two\\nlines"\n');
    assert.deepEqual(env, { A: 'secret', B: 'quoted', C: 'a b', D: 'spaced', E: 'pa#ss', F: 'x', G: 'two\nlines' });
});

test('usage: the test name is a file name in caw/tests, not a path', () => {
    for (const name of ['login', 'order-2', 'a_b.c', 'kündigung', 'überweisung.2']) assert.equal(parseRunArgs('run', [name, '--target', 'shop/dev']).test, name);
    for (const name of ['team/login', '../x', '..', 'x.', '-x', 'a b', 'a\\b', 'a:b', 'ü/x']) {
        assert.throws(() => parseRunArgs('record', [name, '--target', 'shop/dev']), { code: 'usage' }, name);
    }
});

test('build: which requests a build folder answers, how the local page loads a script, SRI', (t) => {
    assert.equal(servesBuild('script', 'assets/a.js'), true);
    assert.equal(servesBuild('fetch', 'assets/a.js'), true, 'dynamic import');
    assert.equal(servesBuild('fetch', 'api/kunden'), false, 'data stays with the server');
    assert.equal(servesBuild('xhr', 'config.json'), false);
    assert.equal(servesBuild('document', 'index.html'), false);
    assert.equal(servesBuild(undefined, 'x.map'), true, 'source maps for the host');

    const dir = folder(t, { 'index.html': '<script type="module" src="/assets/index-NEW11111.js"></script><script src="legacy-AB12CD34.js"></script><link rel="modulepreload" href="/assets/chunk-CD34EF56.js">' });
    assert.equal(scriptKind(dir, 'assets/index-NEW11111.js'), 'module');
    assert.equal(scriptKind(dir, 'assets/chunk-CD34EF56.js'), 'module');
    assert.equal(scriptKind(dir, 'legacy-AB12CD34.js'), 'classic');
    assert.equal(scriptKind(dir, 'other.js'), null);
    // A classic script with "import" in its text is no module; a module without recognisable syntax is one if the page says so.
    assert.equal(moduleAlias('legacy-AB12CD34.js', 'var s="x";import("./y.js")', 'classic'), null);
    assert.equal(moduleAlias('a-AB12CD34.js', 'console.log(1)', null), null);
    assert.match(moduleAlias('a-AB12CD34.js', 'console.log(1)', 'module'), /^import "\.\/a-AB12CD34\.js";/);
    assert.equal(moduleAlias('a-AB12CD34.js', 'const t = "export default";', null), null, 'syntax only at the start of a statement');

    assert.equal(withoutIntegrity('<script src="a.js" integrity="sha384-abc" crossorigin></script><link rel="stylesheet" href="b.css" integrity=\'sha256-x\'><p integrity="bleibt">'),
        '<script src="a.js" crossorigin></script><link rel="stylesheet" href="b.css"><p integrity="bleibt">');
});

test('build: if the build sits one level deeper (Angular dist/<app>/browser), the check names the folder', (t) => {
    const dir = folder(t, { 'shop/browser/index.html': '<p>', 'shop/browser/main-AB12CD34.js': '' });
    assert.deepEqual(buildCheck(dir), { ok: false, hint: 'shop/browser' });
    assert.deepEqual(buildCheck(join(dir, 'shop/browser')), { ok: true });
    assert.deepEqual(buildCheck(join(dir, 'missing')), { ok: false });
});

test('build: a lazy chunk named only by the entry stays itself, even if the page preloads another chunk', async (t) => {
    const { resolveLocalBuild } = await import('../src/host/local-build.mjs');
    // Angular with SRI: index.html loads main and preloads chunk-SHARED; the info page is chunk-LAZY, named only in main.
    const dir = folder(t, {
        'index.html': '<link rel="modulepreload" href="chunk-SHARED1.js"><script src="main-NEW11111.js" type="module"></script>',
        'main-NEW11111.js': 'import"./chunk-SHARED1.js";const info=()=>import("./chunk-LAZY2222.js");',
        'chunk-SHARED1.js': 'export const a=1;',
        'chunk-LAZY2222.js': 'export const b=2;',
        // A leftover old build with the deployed name: it only names its own chunk.
        'main-OLD33333.js': 'import("./chunk-OLD44444.js");',
        'chunk-OLD44444.js': '',
    });
    assert.equal(resolveLocalBuild(dir, 'chunk-LAZY2222.js').alias, undefined);
    assert.equal(resolveLocalBuild(dir, 'main-OLD33333.js').alias, 'main-NEW11111.js', 'an old entry gives way to the current one');
});

test('overlay.statics: if a file is missing, the run names it before the browser starts', async (t) => {
    const root = folder(t, { 'gen/const.js': '' });
    const config = { apps: { web: { dir: '.' } } };
    const checked = (path) => ({ url: 'https://app.example', apps: { web: { kind: 'files', statics: [{ name: 'Const.js', path }] } } });
    await prepareOverlay({ root, config, checked: checked('gen/const.js') });
    await assert.rejects(prepareOverlay({ root, config, checked: checked('gen/x.js') }), (error) => error.code === 'overlay-not-ready' && /gen[\\/]x\.js/.test(error.message));
});

test('overlay: overlay.statics wins, then the build up to the hash; never pages or data', async (t) => {
    const root = folder(t, { 'fixed/index.js': 'fixed' });
    for (const [name, text] of [['dist/assets/index-NEW11111.js', 'x'], ['dist/assets/style-NEW11111.css', 'y']]) {
        mkdirSync(join(root, name, '..'), { recursive: true });
        writeFileSync(join(root, name), text);
    }
    const config = { apps: { web: { dir: '.' } } };
    const checked = { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [{ name: 'assets/index-OLD00000.js', path: 'fixed/index.js' }] } } };
    const overlay = await prepareOverlay({ root, config, checked });
    assert.equal((await overlay.resolve('https://app.example/assets/index-OLD00000.js', 'script')).file, join(root, 'fixed/index.js'));
    assert.equal((await overlay.resolve('https://app.example/assets/style-OLD00000.css', 'stylesheet')).file, join(root, 'dist/assets/style-NEW11111.css'));
    assert.equal(await overlay.resolve('https://app.example/', 'document'), null);
    assert.equal((await overlay.resolve('https://app.example/assets/style-OLD00000.css', 'fetch')).file, join(root, 'dist/assets/style-NEW11111.css'));
    assert.equal(await overlay.resolve('https://app.example/assets/index-OLD00000.json', 'xhr'), null);
    assert.equal(overlay.fileFor('https://app.example/assets/style-OLD00000.css'), join(root, 'dist/assets/style-NEW11111.css'));
});

test('an error in application code that the app catches and logs itself: a request error does not count', () => {
    assert.equal(isCaughtScriptError({ type: 'console', text: "TypeError: Cannot read properties of undefined (reading 'x')", at: 'src/app/explode.ts:12:3' }), true);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'HttpErrorResponse: Http failure response for /api: 500', at: 'src/app/api.ts:4:1' }), false);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'AxiosError: Request failed with status code 404', at: 'src/api.js:9:2' }), false);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'TypeError: x', at: 'node_modules/lib/index.js:1:1' }), false, 'in a library');
    assert.equal(isCaughtScriptError({ type: 'console', text: 'TypeError: x' }), false, 'without a source');
    assert.equal(isCaughtScriptError({ type: 'pageerror', text: 'TypeError: x', at: 'src/a.ts:1:1' }), false, 'uncaught is its own kind');
});

test('handler: Claude never sees secret values, playback gets them, only the host fills placeholders', async () => {
    const evaluated = [];
    const page = {
        evaluate: async (code) => {
            if (typeof code === 'function') return [];
            evaluated.push(code);
            if (code === 'token()') return 'abcd1234';
            return code === 'document.title === "abcd1234"' ? true : code;
        },
    };
    const session = { page: () => page, secrets: () => ['abcd1234'], failures: () => [] };
    const handler = createAgentHandler({
        session, run: { expectations: [{ id: 'S1' }] }, hosts: [], agentDir: tmpdir(), onVerdict: () => {},
        expand: (text) => text.split('{{token}}').join('abcd1234'),
    });
    assert.deepEqual(await handler({ action: 'remember', name: 'token', code: 'token()' }), { name: 'token', value: '••••' }, 'redacted for Claude');
    assert.deepEqual(await handler.reveal({ action: 'remember', name: 'token', code: 'token()' }), { name: 'token', value: 'abcd1234' }, 'not for playback');
    // No code gets the value: a check could leave it in the page (window.x = "{{token}}".split("")), the next eval reads it
    // transformed past the redaction. Refused with a reason, before anything runs in the page.
    const before = evaluated.length;
    for (const command of [
        { action: 'check', id: 'S1', code: 'document.title === "{{token}}"' },
        { action: 'check', id: 'S1', code: '(window.x = "{{token}}".split("").join("|"), true)' },
        { action: 'eval', code: '"{{token}}".split("").join("-")' },
        { action: 'remember', name: 'copy', code: '"{{token}}"' },
    ]) {
        await assert.rejects(handler(command), { code: 'usage', message: /Geheime Werte gehen nur als Wert von fill oder type/ }, command.action);
    }
    assert.equal(evaluated.length, before, 'nothing ran in the page');
    // fill and type still get it; a check without a secret placeholder works as before.
    assert.deepEqual(await handler({ action: 'check', id: 'S1', code: 'document.title === "abcd1234"' }), { id: 'S1', pass: true, value: true });
});
