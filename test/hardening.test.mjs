// Befunde der Gegenpruefung: je ein Test, der den Fehler von damals zeigt. Reine Funktionen, ohne Chrome.
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

test('Wirkung: auch nach Wiederholungen und bei einer gescheiterten Prüfung als Abbruch erkannt', () => {
    assert.equal(isEffectCause(`${CAUSE} Aktion 1 click`), true);
    assert.equal(isEffectCause(`In allen 2 Versuchen gescheitert: ${CAUSE}`), true);
    assert.equal(isEffectCause(`Auch im 3. Versuch gescheitert: ${CAUSE} Davor: Text fehlt.`), true);
    assert.equal(isEffectCause(`Auch im 3. Versuch gescheitert: Text fehlt. Davor: ${CAUSE}`), false, 'nur der letzte Versuch zählt');
    assert.equal(isEffectCause('Text fehlt.'), false);
    // Jede gescheiterte Pruefung meldet sich als Abbruch der Art check: Das schliesst die Wirkung als Grund nicht aus.
    const deviation = { step: 'S2', number: 1, label: 'click', lists: ['controls', 'requests'], missing: [], extra: ['heading "Assistent"'], instead: [], learned: true, fails: true };
    const found = diagnose({ failed: { id: 'S2', reason: `${CAUSE} Aktion 1 click` }, broken: { step: 'S2', kind: 'check' }, deviation });
    assert.deepEqual([found.side, found.strength], ['app', 'likely']);
    assert.match(found.findings.join(' '), /Datenstand/);
});

test('swapToken: auch im Namen des iframes darüber, verschachtelt', () => {
    const step = { action: 'click', target: { role: 'button', name: 'Zahlen', frame: { tag: 'iframe', name: 'Bestellung 4711', frame: { tag: 'iframe', name: 'Kasse 4711' } } } };
    const swapped = swapToken(step, '4711', '{{nummer}}');
    assert.equal(swapped.target.frame.name, 'Bestellung {{nummer}}');
    assert.equal(swapped.target.frame.frame.name, 'Kasse {{nummer}}');
    assert.equal(step.target.frame.name, 'Bestellung 4711', 'das Original bleibt');
});

test('Vorführung: ein Passwort im sichtbaren Feld gilt als geheime Eingabe, sonst wird es geschwärzt', () => {
    const session = { secrets: () => ['Geheim-1234', ''] };
    assert.deepEqual(hideSecrets(session, { action: 'fill', target: { role: 'textbox', name: 'Passwort' }, value: 'Geheim-1234' }), { action: 'fill', target: { role: 'textbox', name: 'Passwort' }, secret: true });
    assert.deepEqual(hideSecrets(session, { action: 'fill', target: null, value: 'Max' }), { action: 'fill', target: null, value: 'Max' }, 'ein leeres Geheimnis trifft nicht alles');
    assert.doesNotMatch(JSON.stringify(hideSecrets(session, { action: 'note', text: 'mit Geheim-1234 angemeldet' })), /Geheim-1234/);
    assert.deepEqual(hideSecrets({ secrets: () => [] }, { action: 'fill', value: 'x' }), { action: 'fill', value: 'x' });
});

test('caw/.env wie dotenv: Kommentar am Ende, Anführungszeichen, Leerraum; # ohne Leerraum gehört zum Wert', () => {
    const env = parseEnvFile('A=secret # Testkonto\nB="quoted" # c\nC=\'a b\'\nD= spaced \nE=pa#ss\r\n# ganz\nexport F=x\nG="zwei\\nZeilen"\n');
    assert.deepEqual(env, { A: 'secret', B: 'quoted', C: 'a b', D: 'spaced', E: 'pa#ss', F: 'x', G: 'zwei\nZeilen' });
});

test('Aufruf: Der Name des Tests ist ein Dateiname in caw/tests, kein Pfad', () => {
    for (const test of ['anmelden', 'bestellung-2', 'a_b.c', 'kündigung', 'überweisung.2']) assert.equal(parseRunArgs('run', [test, '--target', 'shop/dev']).test, test);
    for (const test of ['team/login', '../x', '..', 'x.', '-x', 'a b', 'a\\b', 'a:b', 'ü/x']) {
        assert.throws(() => parseRunArgs('record', [test, '--target', 'shop/dev']), { code: 'usage' }, test);
    }
});

test('Build: welche Requests ein Build-Ordner beantwortet, wie die lokale Seite ein Skript lädt, SRI', (t) => {
    assert.equal(servesBuild('script', 'assets/a.js'), true);
    assert.equal(servesBuild('fetch', 'assets/a.js'), true, 'dynamischer Import');
    assert.equal(servesBuild('fetch', 'api/kunden'), false, 'Daten bleiben beim Server');
    assert.equal(servesBuild('xhr', 'config.json'), false);
    assert.equal(servesBuild('document', 'index.html'), false);
    assert.equal(servesBuild(undefined, 'x.map'), true, 'Quellkarten fuer den Host');

    const dir = folder(t, { 'index.html': '<script type="module" src="/assets/index-NEW11111.js"></script><script src="legacy-AB12CD34.js"></script><link rel="modulepreload" href="/assets/chunk-CD34EF56.js">' });
    assert.equal(scriptKind(dir, 'assets/index-NEW11111.js'), 'module');
    assert.equal(scriptKind(dir, 'assets/chunk-CD34EF56.js'), 'module');
    assert.equal(scriptKind(dir, 'legacy-AB12CD34.js'), 'classic');
    assert.equal(scriptKind(dir, 'other.js'), null);
    // Ein klassisches Skript mit "import" im Text ist kein Modul; ein Modul ohne erkennbare Syntax ist eines, wenn die Seite es sagt.
    assert.equal(moduleAlias('legacy-AB12CD34.js', 'var s="x";import("./y.js")', 'classic'), null);
    assert.equal(moduleAlias('a-AB12CD34.js', 'console.log(1)', null), null);
    assert.match(moduleAlias('a-AB12CD34.js', 'console.log(1)', 'module'), /^import "\.\/a-AB12CD34\.js";/);
    assert.equal(moduleAlias('a-AB12CD34.js', 'const t = "export default";', null), null, 'Syntax nur am Anfang einer Anweisung');

    assert.equal(withoutIntegrity('<script src="a.js" integrity="sha384-abc" crossorigin></script><link rel="stylesheet" href="b.css" integrity=\'sha256-x\'><p integrity="bleibt">'),
        '<script src="a.js" crossorigin></script><link rel="stylesheet" href="b.css"><p integrity="bleibt">');
});

test('Build: Liegt der Build eine Ebene tiefer (Angular dist/<app>/browser), nennt die Prüfung den Ordner', (t) => {
    const dir = folder(t, { 'shop/browser/index.html': '<p>', 'shop/browser/main-AB12CD34.js': '' });
    assert.deepEqual(buildCheck(dir), { ok: false, hint: 'shop/browser' });
    assert.deepEqual(buildCheck(join(dir, 'shop/browser')), { ok: true });
    assert.deepEqual(buildCheck(join(dir, 'fehlt')), { ok: false });
});

test('Build: Ein lazy Chunk, den nur der Einstieg nennt, bleibt er selbst, auch wenn die Seite einen anderen Chunk vorlädt', async (t) => {
    const { resolveLocalBuild } = await import('../src/host/local-build.mjs');
    // Angular mit SRI: index.html laedt main und laedt chunk-SHARED vor; die Info-Seite ist chunk-LAZY, nur in main genannt.
    const dir = folder(t, {
        'index.html': '<link rel="modulepreload" href="chunk-SHARED1.js"><script src="main-NEW11111.js" type="module"></script>',
        'main-NEW11111.js': 'import"./chunk-SHARED1.js";const info=()=>import("./chunk-LAZY2222.js");',
        'chunk-SHARED1.js': 'export const a=1;',
        'chunk-LAZY2222.js': 'export const b=2;',
        // Alter Build mit dem deployten Namen, liegengeblieben: Er nennt nur seinen eigenen Chunk.
        'main-OLD33333.js': 'import("./chunk-OLD44444.js");',
        'chunk-OLD44444.js': '',
    });
    assert.equal(resolveLocalBuild(dir, 'chunk-LAZY2222.js').alias, undefined);
    assert.equal(resolveLocalBuild(dir, 'main-OLD33333.js').alias, 'main-NEW11111.js', 'ein alter Einstieg weicht dem aktuellen');
});

test('overlay.statics: fehlt eine Datei, sagt der Lauf welche, vor dem Browser', async (t) => {
    const root = folder(t, { 'gen/const.js': '' });
    const config = { apps: { web: { dir: '.' } } };
    const checked = (path) => ({ url: 'https://app.example', apps: { web: { kind: 'files', statics: [{ name: 'Const.js', path }] } } });
    await prepareOverlay({ root, config, checked: checked('gen/const.js') });
    await assert.rejects(prepareOverlay({ root, config, checked: checked('gen/x.js') }), (error) => error.code === 'overlay-not-ready' && /gen[\\/]x\.js/.test(error.message));
});

test('Overlay: overlay.statics geht vor, dann der Build bis auf den Hash; Seiten und Daten nie', async (t) => {
    const root = folder(t, { 'fest/index.js': 'fest' });
    for (const [name, text] of [['dist/assets/index-NEW11111.js', 'x'], ['dist/assets/style-NEW11111.css', 'y']]) {
        mkdirSync(join(root, name, '..'), { recursive: true });
        writeFileSync(join(root, name), text);
    }
    const config = { apps: { web: { dir: '.' } } };
    const checked = { url: 'https://app.example', apps: { web: { kind: 'build', dir: 'dist', statics: [{ name: 'assets/index-OLD00000.js', path: 'fest/index.js' }] } } };
    const overlay = await prepareOverlay({ root, config, checked });
    assert.equal((await overlay.resolve('https://app.example/assets/index-OLD00000.js', 'script')).file, join(root, 'fest/index.js'));
    assert.equal((await overlay.resolve('https://app.example/assets/style-OLD00000.css', 'stylesheet')).file, join(root, 'dist/assets/style-NEW11111.css'));
    assert.equal(await overlay.resolve('https://app.example/', 'document'), null);
    assert.equal((await overlay.resolve('https://app.example/assets/style-OLD00000.css', 'fetch')).file, join(root, 'dist/assets/style-NEW11111.css'));
    assert.equal(await overlay.resolve('https://app.example/assets/index-OLD00000.json', 'xhr'), null);
    assert.equal(overlay.fileFor('https://app.example/assets/style-OLD00000.css'), join(root, 'dist/assets/style-NEW11111.css'));
});

test('Fehler im Code der Anwendung, den sie selbst fängt und meldet: ein Request-Fehler zählt nicht dazu', () => {
    assert.equal(isCaughtScriptError({ type: 'console', text: "TypeError: Cannot read properties of undefined (reading 'x')", at: 'src/app/explode.ts:12:3' }), true);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'HttpErrorResponse: Http failure response for /api: 500', at: 'src/app/api.ts:4:1' }), false);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'AxiosError: Request failed with status code 404', at: 'src/api.js:9:2' }), false);
    assert.equal(isCaughtScriptError({ type: 'console', text: 'TypeError: x', at: 'node_modules/lib/index.js:1:1' }), false, 'in einer Bibliothek');
    assert.equal(isCaughtScriptError({ type: 'console', text: 'TypeError: x' }), false, 'ohne Quelle');
    assert.equal(isCaughtScriptError({ type: 'pageerror', text: 'TypeError: x', at: 'src/a.ts:1:1' }), false, 'ungefangen ist eine eigene Art');
});

test('Handler: Claude sieht geheime Werte nie, das Abspielen bekommt sie, Platzhalter füllt erst der Host', async () => {
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
    assert.deepEqual(await handler({ action: 'remember', name: 'token', code: 'token()' }), { name: 'token', value: '••••' }, 'für Claude geschwärzt');
    assert.deepEqual(await handler.reveal({ action: 'remember', name: 'token', code: 'token()' }), { name: 'token', value: 'abcd1234' }, 'für das Abspielen nicht');
    // eval, remember, goto: kein Füllen, sonst käme der Wert umgeformt zurück ("{{token}}".split("").join("-")).
    assert.equal(await handler({ action: 'eval', code: '"{{token}}".split("").join("-")' }), '"{{token}}".split("").join("-")');
    assert.equal(evaluated.at(-1), '"{{token}}".split("").join("-")', 'eval bekommt den Platzhalter');
    // Eine Pruefung bekommt den Wert, meldet aber nur bestanden oder nicht.
    assert.deepEqual(await handler({ action: 'check', id: 'S1', code: 'document.title === "{{token}}"' }), { id: 'S1', pass: true });
    assert.equal(evaluated.at(-1), 'document.title === "abcd1234"');
    assert.deepEqual(await handler({ action: 'check', id: 'S1', code: '"{{token}}"' }), { id: 'S1', pass: false }, 'ohne value, auch wenn die Pruefung den Wert liefert');
});
