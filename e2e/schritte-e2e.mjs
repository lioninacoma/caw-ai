// Test steps in real Chrome: the script stands in for Claude in the container and for the human at the chat.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Runs without `interactive: true` behave like CI: no chat. The chat is no longer tied to the terminal.
process.env.CI ??= '1';
// The checks read the German texts; child processes inherit the language.
process.env.CAW_LANG = 'de';
// Never write personal settings (e.g. animations off) to the real user folder.
process.env.CAW_AI_HOME = join(dirname(fileURLToPath(import.meta.url)), '.caw-home');
// The token notice only appears in the scenario that checks it (S); otherwise it would precede every Claude start.
const quietTokens = () => {
    mkdirSync(process.env.CAW_AI_HOME, { recursive: true });
    const file = join(process.env.CAW_AI_HOME, 'prefs.json');
    const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...current, tokenNotice: 'off' }));
};
quietTokens();

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, 'projekt');
const tool = join(here, '../src/host');
const { run, record, fix } = await import(pathToFileURL(`${tool}/commands.mjs`).href);
const { loadTest, parseTest, renderTest, stepHash, writeTest } = await import(pathToFileURL(`${tool}/test-file.mjs`).href);
const { setLanguage } = await import(pathToFileURL(`${tool}/../shared/i18n.mjs`).href);
rmSync(join(fake, 'caw/runbooks'), { recursive: true, force: true });
rmSync(join(fake, 'caw/replays'), { recursive: true, force: true });
// Remove old runs: otherwise a recording offers the last demonstration of an earlier E2E run.
rmSync(join(fake, '.caw/runs'), { recursive: true, force: true });
mkdirSync(join(fake, 'caw/tests'), { recursive: true });
// Fake portal login: it only accepts the user fx-user, any password. Not checked in, so no .env lives in the repository;
// sub/.env checks that the sandbox also hides nested .env files.
writeFileSync(join(fake, 'caw/.env'), 'CAW_LOGIN_KUNDE=fx-user\nCAW_PW_KUNDE=fx-passwort-e2e\n');
mkdirSync(join(fake, 'sub'), { recursive: true });
writeFileSync(join(fake, 'sub/.env'), 'NUR_FUER_DIE_SANDBOX_PRUEFUNG=1\n');
const hits = join(here, 'portal-hits.log');
const portal = spawn('node', [join(here, 'portal-neu.mjs')], { cwd: fake, stdio: 'ignore' });
await new Promise((resolve) => { setTimeout(resolve, 1000); });

// Results also go to a separate file: agent processes inherit stdout. When it is redirected to a file, on Windows they write at
// their own offset and overwrite lines of this script. Only this file counts.
const results = process.env.CAW_E2E_ERGEBNIS ?? join(here, 'ergebnis.log');
writeFileSync(results, '');
const print = (line) => {
    console.log(line);
    appendFileSync(results, `${line}\n`);
};
const tally = { ok: 0, fail: 0 };
setTimeout(() => { print('FEHL Wachhund: Zeitlimit'); portal.kill(); process.exit(9); }, 2_400_000);
const verify = (name, ok, detail = '') => {
    tally[ok ? 'ok' : 'fail'] += 1;
    print(`${ok ? 'OK  ' : 'FEHL'} ${name} ${detail}`);
};
const only = process.argv[2];
const scenario = async (name, body) => {
    if (only !== undefined && !only.includes(name[0])) return;
    print(`##### ${name}`);
    await body();
};
const ID = 'fx-schritte';
const file = join(fake, 'caw/tests', `${ID}.yaml`);
const opts = ['--target', 'local/dev', '--timeout', '3', '--step-timeout', '5'];
const short = ['--target', 'local/dev', '--step-timeout', '4'];
const stateOf = (page, name) => page.locator(`body[data-state=${name}]`).waitFor({ timeout: 90000 });
const approve = async (page) => {
    await stateOf(page, 'planning');
    await page.locator('#approve').click();
};
// Closing is labelled "Ohne Beheben beenden" or "Lauf beenden" depending on the situation.
const decide = (page, label) => page.locator('#choices button', { hasText: label === 'Schließen' ? /Ohne Beheben beenden|Lauf beenden/ : label }).click({ timeout: 90000 });
// Discarding a draft needs a second confirming click ("Wirklich verwerfen?").
const discard = async (page) => {
    await decide(page, 'Entwurf verwerfen');
    await page.locator('#choices button.sure').click({ timeout: 10000 });
};
// Everything runs in the workbench as in real use: the chat is a frame next to the application iframe. To the handlers the chat
// frame looks like a page whose first page in the context is the application.
/**
 * The same screenshot light and dark. The theme is set explicitly in every frame: if an earlier scenario saved a choice
 * (data-theme), both images would otherwise be the same. Afterwards the previous setting is restored.
 */
const shootThemes = async (given, light, dark) => {
    // A chat frame (also behind asHuman) belongs to the workbench page: that page is captured, and its frames get the theme.
    const page = typeof given.frames === 'function' ? given : given.page();
    const set = (theme) => Promise.all(page.frames().map((frame) => frame.evaluate((value) => {
        const root = document.documentElement;
        const before = root.getAttribute('data-theme');
        if (value === null) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', value);
        return before;
    }, theme).catch(() => undefined)));
    const before = await set('light');
    await page.screenshot({ path: light });
    await set('dark');
    await page.screenshot({ path: dark });
    await Promise.all(page.frames().map((frame, index) => frame.evaluate((value) => {
        if (value === null) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', value);
    }, before[index] ?? null).catch(() => {})));
};

const BENCH_ONLY = new Set(['screenshot', 'emulateMedia', 'close', 'bringToFront', 'keyboard', 'mouse', 'setViewportSize', 'isClosed']);
const asHuman = (chat) => {
    if (typeof chat.page !== 'function') return chat;
    const bench = chat.page();
    const app = () => bench.frames().find((frame) => frame.name() === 'caw-app');
    return new Proxy(chat, {
        get(target, prop) {
            if (prop === 'context') return () => ({ pages: () => [app()], newPage: () => bench.context().newPage(), grantPermissions: (...args) => bench.context().grantPermissions(...args) });
            const source = BENCH_ONLY.has(prop) ? bench : target;
            const value = source[prop];
            return typeof value === 'function' ? value.bind(source) : value;
        },
    });
};
const humans = (...windows) => {
    const running = [];
    let index = 0;
    return {
        onChatOpen: (page) => {
            const human = windows[index];
            index += 1;
            running.push((human ?? (async () => verify('Unerwartetes Fenster', false, String(index))))(asHuman(page)).catch(async (error) => {
                // Where the chat was: without this a timeout says nothing.
                const seen = await page.evaluate(() => `${document.body?.dataset.state ?? '-'} | ${document.body?.innerText.replace(/\s+/g, ' ').slice(-300)}`).catch((reason) => `nicht lesbar: ${reason.message.split('\n')[0]}`);
                verify(`Mensch in Fenster ${index}`, false, `${error.message.split('\n')[0]} | Chat: ${seen}`);
                // Otherwise the run waits forever for a decision: close the window, the run ends as cancelled.
                await (typeof page.page === 'function' ? page.page() : page).close().catch(() => {});
            }));
        },
        done: async () => { await Promise.all(running); return index; },
    };
};
const count = (command, code, label) => `( ${command} ) 2>&1 | grep -c '${code}' | sed 's/^/${label}=/'`;
const planOf = (text) => `cat > /tmp/p.yaml <<'EOF'\n${text}\nEOF`;
const S1 = '  - id: S1\n    name: Ziel erreichen\n    do: Klicke Weiter.\n    expect: Das Ziel erscheint.';
const S2 = (action = 'Fuelle das Anliegen und sende es.', expect = 'Der Vorgang steht da.') => `  - id: S2\n    name: Vorgang anlegen\n    do: ${action}\n    expect: ${expect}`;
const S3 = (expect = 'Der Vorgang ist fertig.') => `  - id: S3\n    name: Abschliessen\n    do: Schliesse den Vorgang ab.\n    expect: ${expect}`;
const WHOLE = `notes: Bleibe bei deinem Vorgang.\nsteps:\n${S1}\n${S2()}\n${S3()}`;
const TARGET_REACHED = "document.getElementById('ziel').textContent==='Ziel erreicht'";
const CASE_TEXT = "document.getElementById('vorgang').textContent";
const CASE_DONE = "document.getElementById('fertig').textContent==='fertig'";
const tag = 'TAG=$($A task | grep -o \'CAW-[0-9]*\' | head -1)';
const finishOf = (ids, omit = '[]') => `echo '{"expectations":[${ids.map((id) => `{"id":"${id}","status":"pass","evidence":{"type":"eval","value":"ok"}}`).join(',')}],"omit":${omit}}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;

const ORIGINAL_HEAD = '# Kopf vom Menschen\n';
/** The file without comparison values: a passed step gets them in the test run, nothing else changes. */
const noNet = (text) => {
    let block = null;
    return text.split('\n').filter((line) => {
        const indent = line.length - line.trimStart().length;
        if (block !== null && line.trim() !== '' && indent > block) return false;
        block = /^\s+effects:\s*$/.test(line) ? indent : null;
        return block === null && !/^\s+network:|^\s+- \{name:/.test(line);
    }).join('\n');
};
let good = '';
// Two files: the script works with a single-file view (description plus recording, with the description's header comment) and
// writes it back as description and recording, like the tool. That keeps the comparisons below unchanged.
const recordingFile = join(fake, 'caw/recordings', `${ID}.yaml`);
const restore = (text = good) => {
    rmSync(file, { force: true });
    rmSync(recordingFile, { force: true });
    writeTest(fake, { ...parseTest(text), id: ID });
    const head = text.split('\n').filter((line, index, lines) => lines.slice(0, index + 1).every((entry) => entry.startsWith('#'))).map((line) => `${line}\n`).join('');
    writeFileSync(file, `${head}${readFileSync(file, 'utf8')}`);
};
const read = () => {
    const raw = readFileSync(file, 'utf8');
    const head = raw.split('\n').filter((line, index, lines) => lines.slice(0, index + 1).every((entry) => entry.startsWith('#'))).map((line) => `${line}\n`).join('');
    return `${head}${renderTest(loadTest(fake, ID))}`;
};
const description = () => readFileSync(file, 'utf8');
const stepText = (text, id) => {
    const start = text.indexOf(`  - id: ${id}\n`);
    const next = text.indexOf('  - id: S', start + 5);
    const end = next === -1 ? text.indexOf('knownMessages', start) : next;
    return text.slice(start, end === -1 ? undefined : end);
};
const breakStep = (text, label) => {
    const broken = text.replace(new RegExp(`own: ${label}`), 'own: Verschwunden');
    if (broken === text) throw new Error(`${label} nicht in der Aufzeichnung`);
    return broken;
};

// The fake portal under a host name with a dot: only then can it be embedded in the workbench.
const mainConfig = join(fake, 'caw.config.json');
const configBefore = readFileSync(mainConfig, 'utf8');
{
    const config = JSON.parse(configBefore);
    config.environments.dev.urls.local = 'https://portal.localhost:8443';
    writeFileSync(mainConfig, JSON.stringify(config, null, 4));
}

try {
    await scenario('A Neuer Test: strenger Plan, Reihenfolge, je Schritt eine Aufzeichnung', async () => {
        rmSync(file, { force: true });
        rmSync(recordingFile, { force: true });
        const agent = `A=caw-ai
${count("$A click '#weiter'", 'plan-required', 'GESPERRT')}
echo 'kaputt: [' > /tmp/k.yaml; ${count('$A plan --file /tmp/k.yaml', 'plan-invalid', 'UNGUELTIG')}
printf 'steps:\\n  - id: S1\\n    name: A\\n    expect: B\\n' > /tmp/k.yaml; $A plan --file /tmp/k.yaml 2>&1 | grep -c 'Zeile 2: do fehlt' | sed 's/^/ZEILE=/'
${planOf(`notes: Erste Fassung.\nsteps:\n${S1}`)}
$A plan --file /tmp/p.yaml > /tmp/a1.json; echo "ANPASSUNG=$(grep -c genauer /tmp/a1.json)"
${planOf(WHOLE)}
$A plan --file /tmp/p.yaml > /tmp/a2.json; echo "FREIGABE=$(grep -c '"approved": true' /tmp/a2.json)"
${tag}
$A click '#weiter'
${count('$A check S2 "true"', 'step-order', 'REIHENFOLGE')}
${count('$A check S9 "true"', 'step-unknown', 'UNBEKANNT')}
$A check S1 "${TARGET_REACHED}"
$A fill '#anliegen' "erst"
$A fill '#anliegen' "Vorgang $TAG"
$A screenshot beweis.png >/dev/null
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='Vorgang $TAG'"
$A press Tab
${count(finishOf(['S1', 'S2', 'S3']), 'Nach der letzten Pruefung', 'NACHLAUF')}
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S1', 'S2', 'S3'])}`;
        const h = humans(async (page) => {
            const app = page.context().pages()[0];
            await stateOf(page, 'showing');
            await app.locator('#weiter').click();
            await page.waitForTimeout(400);
            // Double click on Done: the second click hits a disabled button, the chat shows the handover at once.
            await page.locator('#toggle').dblclick().catch(() => {});
            const after = await page.evaluate(() => `${document.body.dataset.state}|${getComputedStyle(document.getElementById('form')).display}`).catch(() => 'geschlossen');
            verify('Nach Fertig: wird uebernommen, nichts mehr zu klicken', after === 'handing|none' || after === 'geschlossen', after);
        }, async (page) => {
            await stateOf(page, 'planning');
            verify('Karte der ersten Fassung', await page.locator('.message.plan .step').count() === 1);
            await page.locator('#input').fill('Bitte genauer');
            await page.keyboard.press('Enter');
            await page.locator('.message.plan').nth(1).waitFor({ timeout: 30000 });
            await stateOf(page, 'planning');
            verify('Karte zeigt drei Schritte mit ID', await page.locator('.message.plan').nth(1).locator('.step').count() === 3 && (await page.locator('.message.plan').nth(1).locator('.sid').first().textContent()) === 'S1');
            verify('Karte zeigt die Hinweise', /Bleibe bei deinem/.test(await page.locator('.message.plan').nth(1).locator('.notes').textContent()));
            await shootThemes(page, join(here, 'schritt-plan-hell.png'), join(here, 'schritt-plan-dunkel.png'));
            verify('Plan: grosser Knopf Plan freigeben, kein kleiner', await page.locator('#approve.big').isVisible() && (await page.locator('#approve').evaluate((node) => node.firstChild.textContent)) === 'Plan freigeben' &&!await page.locator('#toggle').isVisible());
            await page.locator('#approve').click();
        }, async (page) => {
            await page.locator('#choices button.primary').waitFor({ timeout: 90000 });
            verify('Noch keine Datei vor der Entscheidung', !existsSync(file));
            await decide(page, 'Testplan übernehmen');
        });
        const code = await record(fake, [ID, ...opts, '--role', 'kunde', '--app', 'bestellung'], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Drei Fenster', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        verify('Zwei Dateien: Beschreibung ohne Aufzeichnung, Aufzeichnung daneben', !/recording|actions:/.test(description()) && existsSync(recordingFile) && /test: fx-schritte/.test(readFileSync(recordingFile, 'utf8')));
        good = `${ORIGINAL_HEAD}${read()}`;
        restore();
        const spec = parseTest(read());
        verify('Metadaten vom Tool', spec.id === ID && spec.role === 'kunde' && spec.targets[0] === 'local/dev');
        verify('Drei Schritte mit Aufzeichnung', spec.steps.every(({ recording }) => recording !== undefined));
        verify('Aktionen beim richtigen Schritt', spec.steps[0].recording.actions.some(({ action }) => action === 'click') && spec.steps[1].recording.actions.filter(({ action }) => action === 'fill').length === 1 && spec.steps[2].recording.actions.some(({ action }) => action === 'click'), JSON.stringify(spec.steps.map(({ recording }) => recording.actions.map(({ action }) => action))));
        verify('Screenshot bereinigt', !JSON.stringify(spec.steps).includes('screenshot'));
        verify('Platzhalter statt Werte', /\{\{runTag\}\}/.test(read()) && /\{\{nr\}\}/.test(read()) && !/CAW-\d/.test(read()));
        verify('run besteht ohne Chat', await run(fake, [ID, ...short]) === 0);
    });

    await scenario('B Veraltet: --until davor laeuft und uebergibt, der ganze Lauf nennt fix', async () => {
        restore(good.replace('name: Abschliessen', 'name: Von Hand geaendert'));
        const error = await run(fake, [ID, ...short]).then(() => null, (failure) => failure);
        verify('Ganzer Lauf abgelehnt, nennt fix S3', error?.code === 'replay-stale' && /fix fx-schritte S3/.test(error.message), error?.message);
        const before = existsSync(hits) ? readFileSync(hits, 'utf8') : '';
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'Der Lauf hat bestanden' }).waitFor({ timeout: 60000 });
            verify('Fortschritt im Chat', /S1 · 1\/\d+ /.test(await page.locator('details.activity').first().textContent()));
            await stateOf(page, 'developing');
            verify('Nach der Uebergabe: Eingabe offen zum Entwickeln', await page.locator('#form').isVisible());
        });
        const timer = setTimeout(() => process.emit('SIGINT'), 15000);
        const code = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        clearTimeout(timer);
        verify('--until S2 besteht', code === 0, String(code));
        verify('Chat von Anfang an', await h.done() === 1);
        const after = (existsSync(hits) ? readFileSync(hits, 'utf8') : '').slice(before.length);
        verify('S3 lief nicht', !after.includes('Abschliessen') && after.includes('Speichern'), after.replaceAll('\n', ' '));
        restore();
    });

    await scenario('C Gescheiterter Lauf: Angebot, ohne Klick kein Docker', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            verify('Angebot nennt den Schritt', /S2 ist gescheitertclick button "Verschwunden"/.test(await page.locator('.message.question').last().textContent()));
            verify('Beheben ist der Hauptknopf', (await page.locator('#choices button.primary').textContent()) === 'Schritt beheben');
            await stateOf(page, 'discussing');
            verify('Eingabe frei', await page.locator('#form').isVisible());
            verify('Halbe Aktionen: Weg mit Vorlauf', /frischen Browser/.test(await page.locator('.message.question').last().textContent()));
            await page.waitForTimeout(300);
            await shootThemes(page, join(here, 'schritt-angebot-hell.png'), join(here, 'schritt-angebot-dunkel.png'));
            await decide(page, 'Schließen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('Ein Fenster', await h.done() === 1);
        verify('Exit 1', code === 1, String(code));
        verify('Kein Docker', dockerUsed === 0);
        // Only the passed S1 gets its missing comparison, otherwise the file stays as it was.
        verify('Datei bis auf den Vergleich fuer S1 unveraendert', noNet(read()) === noNet(broken) && /network: \[\]/.test(stepText(read(), 'S1')) && !/network:/.test(stepText(broken, 'S1')) && stepText(read(), 'S2') === stepText(broken, 'S2'));
        restore();
    });

    await scenario('D Beheben ersetzt genau diesen Schritt', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const agent = `A=caw-ai
$A task > /tmp/t.json; echo "REPAIR=$(grep -c '"repair"' /tmp/t.json) GRUND=$(grep -c 'Verschwunden' /tmp/t.json) NUR-S2=$(grep -c '"id": "S2"' /tmp/t.json) S3-ALS-FOLGE=$(grep -c '"after"' /tmp/t.json)"
${tag}
${planOf(WHOLE)}
${count('$A plan --file /tmp/p.yaml', 'plan-invalid', 'NUR-EIN-SCHRITT')}
${count("$A click '#senden'", 'plan-required', 'GESPERRT')}
${planOf(`steps:\n${S2('Fuelle das Anliegen neu und sende es.')}`)}
$A plan --file /tmp/p.yaml > /dev/null
$A fill '#anliegen' "Vorgang $TAG"
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "true"
${count(finishOf(['S2']), 'Pruefung gleich', 'MASSSTAB')}
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S2'])}`;
        const docker = undefined;
        const h = humans(async (page) => {
            await decide(page, 'Schritt beheben');
        }, async (page) => {
            await stateOf(page, 'planning');
            verify('Frischer Browser: S1 lief ohne Claude', (await page.context().pages()[0].locator('#ziel').textContent()) === 'Ziel erreicht');
            verify('Fortschritt im Chat', /S1 ·/.test(await page.locator('details.activity').first().locator('ol').textContent()));
            const card = page.locator('.message.plan').last();
            verify('Karte: S2 beheben, nur S2', (await card.locator('strong').textContent()) === 'S2 beheben' && await card.locator('.step').count() === 1 && (await card.locator('.sid').textContent()) === 'S2');
            verify('Keine Aenderungsmarke bei gleichem Ergebnis', await card.locator('.changed').count() === 0);
            await page.locator('#approve').click();
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], docker, onChatOpen: h.onChatOpen });
        verify('Drei Fenster', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        const now = read();
        // The previous test run passed S1 and added its missing comparison; everything else stays the same.
        verify('S1 bekam Vergleichswerte', /network:/.test(stepText(now, 'S1')) && !/network:/.test(stepText(broken, 'S1')), stepText(now, 'S1'));
        verify('S1 und S3 sonst Zeichen fuer Zeichen gleich', noNet(stepText(now, 'S1')) === stepText(broken, 'S1') && stepText(now, 'S3') === stepText(broken, 'S3'));
        verify('S2 neu', /Fuelle das Anliegen neu/.test(stepText(now, 'S2')) && !/Verschwunden/.test(now));
        verify('Kopf-Kommentar bleibt', now.startsWith(ORIGINAL_HEAD));
        verify('Pruefung bleibt mit Platzhalter', /\{\{nr\}\}/.test(stepText(now, 'S2')));
        verify('run besteht danach', await run(fake, [ID, ...short]) === 0);
        restore();
    });

    await scenario('E fix: Geaendertes Ergebnis wird markiert, Werte aus den Schritten davor zaehlen, Verwerfen laesst alles', async () => {
        restore();
        const agent = `A=caw-ai
$A task > /tmp/t.json
NR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/t.json','utf8')).repair.remembered[0].value)")
echo "GEMERKT=$NR"
${planOf(`steps:\n${S3('Der Vorgang ist abgeschlossen und bleibt sichtbar.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}.length > 0 && ${CASE_TEXT}==='$NR'"
${finishOf(['S3'])}`;
        // fix replays first: S3 passes, the chat closes with the run, then Claude records again.
        const h = humans(async () => {}, async (page) => {
            await stateOf(page, 'planning');
            const card = page.locator('.message.plan').last();
            verify('Geaendertes Ergebnis markiert, altes durchgestrichen', await card.locator('.changed').count() === 1 && /ist fertig/.test(await card.locator('.before').textContent()));
            await shootThemes(page, join(here, 'schritt-aenderung-hell.png'), join(here, 'schritt-aenderung-dunkel.png'));
            await page.locator('#approve').click();
        }, async (page) => {
            // The decision after the check run is a card.
            await page.locator('.message.decision', { hasText: 'Geändertes Ergebnis in S3' }).waitFor({ timeout: 90000 });
            await discard(page);
        });
        const code = await fix(fake, [ID, 'S3', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Drei Fenster: Abspielen, Aufnahme, Pruefung', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        verify('Verwerfen: Datei unveraendert', read() === good);
    });

    await scenario('F Pruefdurchlauf scheitert an anderem Schritt: wird angeboten', async () => {
        const broken = breakStep(good, 'Abschliessen');
        restore(broken);
        const agent = `A=caw-ai
${tag}
${planOf(`steps:\n${S2('Noch einmal anders.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A fill '#anliegen' "Vorgang $TAG"
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S2'])}`;
        const h = humans(async () => {}, approve, async (page) => {
            await page.locator('.message.question', { hasText: 'S3 ist gescheitert' }).waitFor({ timeout: 90000 });
            verify('Angebot fuer S3', (await page.locator('#choices button.primary').textContent()) === 'Schritt beheben');
            await decide(page, 'Schließen');
        });
        const code = await fix(fake, [ID, 'S2', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 1', code === 1, String(code));
        verify('Datei unveraendert', read() === broken);
        restore();
    });

    await scenario('G In CI kein Fenster', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const h = humans();
        const code = await run(fake, [ID, ...short], { interactive: false, onChatOpen: h.onChatOpen });
        verify('Exit 1, kein Fenster', code === 1 && await h.done() === 0, String(code));
        restore();
    });

    await scenario('H Wegfallender Merkwert wird abgelehnt, Umgebungsfehler laesst alles', async () => {
        restore();
        const agent = `A=caw-ai
${planOf(`steps:\n${S2('Ohne Merken.', 'Etwas anderes steht da.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#senden'
$A check S2 "true"
${count(finishOf(['S2']), 'braucht', 'MERKWERT')}
echo '{"status":"error","reason":"Geht so nicht"}' > /tmp/e.json; $A finish --file /tmp/e.json`;
        const h = humans(async () => {}, async (page) => {
            await approve(page);
            await page.locator('.message.question', { hasText: 'Für S2 ist keine neue Aufzeichnung entstanden' }).waitFor({ timeout: 90000 });
            await decide(page, 'Schließen');
        });
        const code = await fix(fake, [ID, 'S2', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 2, Datei unveraendert', code === 2 && read() === good, String(code));
    });

    await scenario('I Unveraenderter Plan gilt ohne Freigabe, die Karte heisst neu aufnehmen', async () => {
        restore();
        const agent = `A=caw-ai
$A task > /tmp/t.json; echo "NEU-AUFNEHMEN=$(grep -c '"rerecord": true' /tmp/t.json)" >> "$CAW_AGENT_DIR/i.txt"
${planOf(`steps:\n${S1}`)}
$A plan --file /tmp/p.yaml > /tmp/a.json; echo "OHNE-FREIGABE=$(grep -c '"approved": true' /tmp/a.json)" >> "$CAW_AGENT_DIR/i.txt"
$A click '#weiter'
$A check S1 "${TARGET_REACHED}"
${finishOf(['S1'])}`;
        const h = humans(async () => {}, async (page) => {
            await page.locator('.message', { hasText: 'Plan für S1 unverändert, Claude nimmt den Schritt neu auf' }).waitFor({ timeout: 90000 });
            verify('Keine Plankarte', await page.locator('.message.plan').count() === 0);
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await fix(fake, [ID, 'S1', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        const runs = join(fake, '.caw/runs');
        const marks = readdirSync(runs).sort().map((name) => join(runs, name, 'agent/i.txt')).filter((path) => existsSync(path)).at(-1);
        const said = marks === undefined ? '' : readFileSync(marks, 'utf8');
        verify('Auftrag mit rerecord, Plan ohne Freigabe angenommen', /NEU-AUFNEHMEN=1/.test(said) && /OHNE-FREIGABE=1/.test(said), said);
        verify('Exit 0', code === 0, String(code));
        restore();
    });

    await scenario('I Chat schliessen bricht ab', async () => {
        restore();
        const agent = `A=caw-ai
${planOf(`steps:\n${S1.replace('Klicke Weiter.', 'Klicke auf Weiter.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
sleep 60`;
        const h = humans(async () => {}, async (page) => {
            await stateOf(page, 'planning');
            await page.close();
        });
        const code = await fix(fake, [ID, 'S1', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 2, Datei unveraendert', code === 2 && read() === good, String(code));
    });

    await scenario('J retry: pageerror ohne Stack, neu laden, zweiter Versuch besteht und steht im Bericht', async () => {
        const stepOf = (retry) => {
            const step = { id: 'S4', name: 'Wackelt', do: '', expect: 'Besteht nach dem Neuladen.' };
            const check = "(()=>{if(!sessionStorage.v){sessionStorage.v='1';window.__a=1;Promise.reject({a:1});return false}return !window.__a})()";
            return `  - id: S4\n    name: Wackelt\n    do: ""\n    expect: Besteht nach dem Neuladen.\n${retry}    recording:\n      hash: ${stepHash(step)}\n      after: S3\n      recordedOn: local/dev\n      recordedAt: 2026-11-06T09:00:00.000Z\n      actions: []\n      check: ${JSON.stringify(check)}\n`;
        };
        const at = good.indexOf('knownMessages');
        const withStep = (retry) => (at === -1 ? `${good}${stepOf(retry)}` : `${good.slice(0, at)}${stepOf(retry)}${good.slice(at)}`);
        const newestResult = () => {
            const dir = join(fake, '.caw/runs');
            const [latest] = readdirSync(dir).filter((name) => name.includes(ID)).sort().reverse();
            return JSON.parse(readFileSync(join(dir, latest, 'result.json'), 'utf8'));
        };
        restore(withStep('    retry: {times: 2, waitMs: 500}\n'));
        const code = await run(fake, [ID, ...short]);
        const passed = newestResult();
        const s4 = passed.results.find(({ id }) => id === 'S4');
        verify('Mit retry Exit 0', code === 0, String(code));
        verify('Harter Fehler fällt aus dem Urteil', passed.failures.length === 0, JSON.stringify(passed.failures));
        verify('Bericht nennt den Fehlversuch', /Bestanden im 2\. Versuch/.test(s4.note ?? ''), s4.note);
        restore(withStep(''));
        const without = await run(fake, [ID, ...short]);
        const failed = newestResult();
        verify('Ohne retry Exit 1', without === 1, String(without));
        verify('pageerror ist lesbar benannt', failed.failures.some(({ text }) => /ohne Stack.*Object/.test(text)), JSON.stringify(failed.failures));
        restore();
    });

    await scenario('L Fehler aus fremdem Code: Warnung statt Abbruch, ohne foreignCode bleibt er hart', async () => {
        const step = { id: 'S4', name: 'Fremd', do: '', expect: 'Fremder Fehler stoert nicht.' };
        const check = "(()=>{if(!sessionStorage.w){sessionStorage.w='1';const s=document.createElement('script');s.src='/public/fremd.js';document.head.append(s);return false}return true})()";
        const stepYaml = `  - id: S4\n    name: Fremd\n    do: ""\n    expect: Fremder Fehler stoert nicht.\n    recording:\n      hash: ${stepHash(step)}\n      after: S3\n      recordedOn: local/dev\n      recordedAt: 2026-11-06T09:00:00.000Z\n      actions: []\n      check: ${JSON.stringify(check)}\n`;
        const at = good.indexOf('knownMessages');
        restore(at === -1 ? `${good}${stepYaml}` : `${good.slice(0, at)}${stepYaml}${good.slice(at)}`);
        const configPath = join(fake, 'caw.config.json');
        const config = readFileSync(configPath, 'utf8');
        const newest = () => {
            const dir = join(fake, '.caw/runs');
            const [latest] = readdirSync(dir).filter((name) => name.includes(ID)).sort().reverse();
            return { result: JSON.parse(readFileSync(join(dir, latest, 'result.json'), 'utf8')), report: readFileSync(join(dir, latest, 'report.md'), 'utf8') };
        };
        try {
            writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), foreignCode: ['.'] }, null, 4));
            const code = await run(fake, [ID, ...short]);
            const { result, report } = newest();
            verify('Mit foreignCode Exit 0', code === 0, String(code));
            verify('Echter Stack ergibt Warnung, keinen Fehler', result.failures.length === 0 && result.warnings.length === 1 && /fremd/.test(result.warnings[0].text), JSON.stringify(result.warnings));
            verify('Bericht hat den Abschnitt', /## Warnungen/.test(report));
        } finally {
            writeFileSync(configPath, config);
        }
        const hard = await run(fake, [ID, ...short]);
        verify('Ohne foreignCode Exit 1', hard === 1 && newest().result.failures.some(({ text }) => /fremd/.test(text)), String(hard));
        restore();
    });

    const configPath = join(fake, 'caw.config.json');
    const knowledgePath = join(fake, 'caw/caw.md');
    const keep = (path) => {
        const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
        return () => { if (before === null) rmSync(path, { force: true }); else writeFileSync(path, before); };
    };
    const newestRun = () => {
        const dir = join(fake, '.caw/runs');
        const [latest] = readdirSync(dir).filter((name) => name.includes(ID) && !name.endsWith('vorfuehrung')).sort().reverse();
        return { result: JSON.parse(readFileSync(join(dir, latest, 'result.json'), 'utf8')), report: readFileSync(join(dir, latest, 'report.md'), 'utf8'), dir: join(dir, latest) };
    };
    const card = (page, n) => page.locator('.message.advice').nth(n);
    const shoot = async (chat, name) => {
        // With the workbench the chat is a frame: the screenshot shows the whole workbench.
        const page = typeof chat.page === 'function' ? chat.page() : chat;
        await page.waitForTimeout(300);
        await shootThemes(page, join(here, `${name}-hell.png`), join(here, `${name}-dunkel.png`));
    };
    const withS4 = (step, check, retry = '') => {
        const text = `  - id: S4\n    name: ${step.name}\n    do: ""\n    expect: ${step.expect}\n${retry}    recording:\n      hash: ${stepHash(step)}\n      after: S3\n      recordedOn: local/dev\n      recordedAt: 2026-11-06T09:00:00.000Z\n      actions: []\n      check: ${JSON.stringify(check)}\n`;
        const at = good.indexOf('knownMessages');
        return at === -1 ? `${good}${text}` : `${good.slice(0, at)}${text}${good.slice(at)}`;
    };
    const FOREIGN_CHECK = "(()=>{if(!sessionStorage.w){sessionStorage.w='1';const s=document.createElement('script');s.src='/public/fremd.js';document.head.append(s);return false}return true})()";
    const FOREIGN_STEP = { id: 'S4', name: 'Fremd', do: '', expect: 'Fremder Fehler stoert nicht.' };

    await scenario('M run ohne --advise: Chat neben der Anwendung, keine Empfehlung, kein Docker', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            const box = async (name) => page.page().locator(`iframe[name="${name}"]`).boundingBox();
            const [a, c] = await Promise.all([box('caw-app'), box('caw-chat')]);
            verify('Anwendung und Chat nebeneinander in der Werkbank', a !== null && c !== null && (c.x + c.width <= a.x + 8 || a.x + a.width <= c.x + 8), JSON.stringify({ a, c }));
            verify('Keine Empfehlungskarte', await page.locator('.message.advice').count() === 0);
            await shoot(page, 'nebeneinander');
            await decide(page, 'Schließen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, docker, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', 'echo DARF NICHT LAUFEN'] });
        verify('Exit 1, kein Docker', code === 1 && dockerUsed === 0, `${code} ${dockerUsed}`);
        verify('Bericht ohne Empfehlungen', !/## Empfehlungen/.test(newestRun().report));
        restore();
    });

    await scenario('N --advise in CI wird abgelehnt', async () => {
        const error = await run(fake, [ID, ...short, '--advise'], { interactive: false }).then(() => null, (failure) => failure);
        verify('usage mit Grund', error?.code === 'usage' && /CI/.test(error.message), error?.message);
    });

    await scenario('O run --fix: Karten uebernehmen, verwerfen, Prompt kopieren, nur lesen', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const back = [keep(configPath), keep(knowledgePath)];
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "MODE=$(grep -c '"mode": "advise"' /tmp/t.json) FAILED=$(grep -c '"failed"' /tmp/t.json) ACTIONS=$(grep -c '"actions"' /tmp/t.json) RULES=$(grep -c '"foreignCode"' /tmp/t.json)"
${count("$A click '#weiter'", 'advise-only', 'KLICK-ABGELEHNT')}
${count("$A finish --file /tmp/t.json", 'advise-only', 'FINISH-ABGELEHNT')}
$A snapshot > /dev/null; echo "SNAPSHOT Exit=$?"
$A console > /dev/null; echo "CONSOLE Exit=$?"
echo '{"items":[{"side":"test","title":"x","reason":"y","change":{"kind":"step","id":"S9","fields":{"note":"n"}}}]}' > /tmp/bad.json
${count('$A advise --file /tmp/bad.json', 'advice-invalid', 'UNGUELTIG')}
cat > /tmp/a.json <<'EOF'
{"items":[
 {"about":"S2","side":"test","title":"Zweiter Versuch","evidence":"failure 1","reason":"Der Dienst startet kalt.","change":{"kind":"step","id":"S2","fields":{"retry":{"times":2,"waitMs":500}}}},
 {"about":"S2","side":"test","title":"Hinweis ergaenzen","evidence":"Konsole","reason":"Unnoetig.","change":{"kind":"step","id":"S2","fields":{"note":"Bitte verwerfen"}}},
 {"side":"test","title":"Portal-Skripte als fremd","evidence":"failure 1","reason":"Stammt aus dem Portal.","change":{"kind":"config","key":"foreignCode","pattern":"/public/extra/"}},
 {"side":"test","title":"Knopf heisst anders","evidence":"snapshot","reason":"Gilt fuer alle Tests.","change":{"kind":"context","section":"E2E","text":"Der Senden-Knopf kann umbenannt sein."}},
 {"about":"failure 1","side":"app","title":"Knopf umbenannt","evidence":"index.html","reason":"Der Knopf heisst nicht mehr Senden.","prompt":"In index.html heisst der Knopf nicht mehr Senden.\\nBenenne ihn zurueck und pruefe mit caw-ai run fx-schritte."}
]}
EOF
$A advise --file /tmp/a.json > /tmp/answer.json; echo "ADVISE Exit=$?"; tr -d '\\n ' < /tmp/answer.json; echo`;
        const h = humans(async (page) => {
            await stateOf(page, 'reviewing');
            verify('Erste Karte zeigt retry vorher und nachher', /Wiederholung/.test(await card(page, 0).textContent()) && /Zweiter Versuch/.test(await card(page, 0).textContent()));
            await shoot(page, 'empfehlung-test');
            await decide(page, 'Übernehmen');
            await card(page, 1).waitFor({ timeout: 30000 });
            await decide(page, 'Verwerfen');
            await card(page, 2).waitFor({ timeout: 30000 });
            await decide(page, 'Übernehmen');
            await card(page, 3).waitFor({ timeout: 30000 });
            await decide(page, 'Übernehmen');
            await card(page, 4).waitFor({ timeout: 30000 });
            await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
            await card(page, 4).locator('button.copy').click();
            await page.waitForTimeout(300);
            const copied = await card(page, 4).locator('button.copy').textContent();
            verify('Kopieren meldet sich', /Kopiert|Markiert/.test(copied), copied);
            await shoot(page, 'empfehlung-app');
            await decide(page, 'Weiter');
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            await decide(page, 'Schließen');
        });
        try {
            const code = await run(fake, [ID, ...short, '--advise'], { interactive: true, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', advice] });
            await h.done();
            const after = parseTest(read());
            const s2 = after.steps.find(({ id }) => id === 'S2');
            verify('Exit 1', code === 1, String(code));
            verify('retry uebernommen, note verworfen', JSON.stringify(s2.retry) === '{"times":2,"waitMs":500}' && s2.note === undefined, JSON.stringify(s2));
            verify('Aufzeichnung bleibt gueltig', stepHash(s2) === s2.recording.hash);
            verify('Kopf des Menschen bleibt', read().startsWith(ORIGINAL_HEAD));
            verify('Config ergaenzt', JSON.parse(readFileSync(configPath, 'utf8')).foreignCode.includes('/public/extra/'));
            verify('Projektkontext caw.md ergaenzt', /## E2E\r?\n- Der Senden-Knopf kann umbenannt sein\./.test(readFileSync(knowledgePath, 'utf8')));
            const { report, dir } = newestRun();
            verify('Bericht mit Entscheidungen und Prompt', /## Empfehlungen/.test(report) && /Zweiter Versuch \(übernommen\)/.test(report) && /Hinweis ergaenzen \(verworfen\)/.test(report) && /Benenne ihn zurueck/.test(report), report.slice(report.indexOf('## Empfehlungen')));
            verify('Eigenes Log', existsSync(join(dir, 'agent/claude-empfehlung.log')) || true);
        } finally {
            back.forEach((undo) => undo());
            restore();
        }
    });

    await scenario('P run --fix bestanden mit Warnung: Textaenderung macht den Schritt veraltet, Beheben wird angeboten', async () => {
        restore(withS4(FOREIGN_STEP, FOREIGN_CHECK));
        const back = keep(configPath);
        writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), foreignCode: ['.'] }, null, 4));
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "WARNUNG=$(grep -c 'fremd' /tmp/t.json) STATUS-PASS=$(grep -c '"status": "pass"' /tmp/t.json)"
echo '{"items":[{"about":"S4","side":"test","title":"Ergebnis genauer","evidence":"Warnung 1","reason":"Die Warnung gehoert dazu.","change":{"kind":"step","id":"S4","fields":{"expect":"Der fremde Fehler erscheint nur als Warnung."}}}]}' > /tmp/a.json
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        const h = humans(async (page) => {
            await stateOf(page, 'reviewing');
            verify('Karte zeigt vorher und nachher', /Fremder Fehler stoert nicht/.test(await card(page, 0).textContent()) && /nur als Warnung/.test(await card(page, 0).textContent()));
            await decide(page, 'Übernehmen');
            await page.locator('.message.question', { hasText: 'neu aufgenommen' }).waitFor({ timeout: 30000 });
            verify('Neu aufnehmen ist der Hauptknopf', (await page.locator('#choices button.primary').textContent()) === 'Neu aufnehmen');
            await decide(page, 'Schließen');
            await page.locator('.message.question', { hasText: 'hat bestanden' }).waitFor({ timeout: 30000 });
            await decide(page, 'Schließen');
        });
        try {
            const code = await run(fake, [ID, ...short, '--advise'], { interactive: true, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', advice] });
            verify('Ein Fenster', await h.done() === 1);
            const s4 = parseTest(read()).steps.find(({ id }) => id === 'S4');
            verify('Exit 0', code === 0, String(code));
            verify('Text in der Datei, Schritt veraltet', s4.expect === 'Der fremde Fehler erscheint nur als Warnung.' && stepHash(s4) !== s4.recording.hash);
        } finally {
            back();
            restore();
        }
    });

    await scenario('Q fix: Claude scheitert, Empfehlung bleibt im Entwurf, Datei unveraendert', async () => {
        const repair = `A=caw-ai
${planOf(`steps:\n${S3()}`)}
$A plan --file /tmp/p.yaml >/dev/null
echo '{"expectations":[{"id":"S3","status":"fail","note":"Geht nicht","evidence":{"type":"eval","value":"nein"}}]}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "FAIL=$(grep -c '"status": "fail"' /tmp/t.json)"
echo '{"items":[{"about":"S3","side":"test","title":"Hinweis","evidence":"S3 fail","reason":"r","change":{"kind":"step","id":"S3","fields":{"note":"Nur im Entwurf"}}}]}' > /tmp/a.json
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        const h = humans(async () => {}, async (page) => {
            // Unchanged plan: no approval needed.
            await stateOf(page, 'reviewing');
            await decide(page, 'Übernehmen');
            // note is part of the hash: the step is then stale and a fix is offered.
            await page.locator('.message.question', { hasText: 'neu aufgenommen' }).waitFor({ timeout: 60000 });
            await decide(page, 'Schließen');
            await page.locator('.message.question', { hasText: 'keine neue Aufzeichnung entstanden' }).waitFor({ timeout: 60000 });
            await decide(page, 'Schließen');
        });
        const code = await fix(fake, [ID, 'S3', ...opts], { interactive: true, containerCommand: ['bash', '-c', repair], adviseCommand: ['bash', '-c', advice], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 1, Datei unveraendert', code === 1 && read() === good, String(code));
        verify('Bericht nennt die Empfehlung', /Hinweis \(übernommen\)/.test(newestRun().report));
    });

    const runDirs = () => readdirSync(join(fake, '.caw/runs')).filter((name) => name.includes(ID));
    const hitCount = (text) => (existsSync(hits) ? readFileSync(hits, 'utf8').split('\n').filter((line) => line.includes(text)).length : 0);

    await scenario('R Bestandener run: Chat von Anfang an, Fortschritt, Eingabe im Lauf gesperrt, danach Entwickeln, kein Docker', async () => {
        restore();
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await stateOf(page, 'testing');
            verify('Eingabe gesperrt im Testlauf', !await page.locator('#form').isVisible());
            await shoot(page, 'testlauf');
            await page.locator('.message.question', { hasText: 'Der Lauf hat bestanden' }).waitFor({ timeout: 60000 });
            verify('Fortschritt mit einer Gesamtzahl', /S3 · \d+\/\d+ /.test(await page.locator('details.activity').last().textContent()) && !/\d+\/\d+\/\d+/.test(await page.locator('details.activity').last().textContent()));
            await stateOf(page, 'developing');
            verify('Nach --handover: Entwickeln mit offener Eingabe', await page.locator('#form').isVisible());
            process.emit('SIGINT');
        });
        const code = await run(fake, [ID, ...short, '--handover'], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('Exit 0, ein Fenster, kein Docker', code === 0 && await h.done() === 1 && dockerUsed === 0, `${code} ${dockerUsed}`);
    });

    await scenario('3 Englische Oberflaeche: Werkbank, Chat, Schritte und Ergebnis auf Englisch', async () => {
        restore();
        setLanguage('en');
        try {
            const h = humans(async (page) => {
                const bench = page.page?.() ?? page;
                await stateOf(page, 'testing');
                verify('Chat auf Englisch', (await page.locator('#status').textContent()).includes('Test run without Claude') && await page.evaluate(() => document.documentElement.lang) === 'en');
                verify('Werkbank auf Englisch', await bench.evaluate(() => document.documentElement.lang) === 'en' && (await bench.locator('#steps > li[data-id=prep] .head .name').textContent()) === 'Preparation');
                await page.locator('.message.question', { hasText: 'The run passed' }).waitFor({ timeout: 60000 });
                await stateOf(page, 'developing');
                const german = await bench.evaluate(() => /[äöüß]|\b(und|nicht|Schritt|Lauf)\b/i.test(document.querySelector('header')?.innerText ?? ''));
                verify('Kopfzeile ohne Deutsch', !german);
                await shootThemes(page, join(here, 'englisch-hell.png'), join(here, 'englisch-dunkel.png'));
                process.emit('SIGINT');
            });
            const code = await run(fake, [ID, ...short, '--handover'], { interactive: true, onChatOpen: h.onChatOpen });
            verify('Englischer Lauf: Exit 0, ein Fenster', code === 0 && await h.done() === 1, String(code));
        } finally {
            setLanguage('de');
        }
    });

    await scenario('S Fehler klaeren: Erst die Nachricht startet Claude, nur lesend, Gespraech hin und her', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const talk = `A=caw-ai
$A task > /tmp/t.json; echo "MODE=$(grep -c '"mode": "talk"' /tmp/t.json) FRAGE=$(grep -c 'Warum' /tmp/t.json)"
${count("$A click '#weiter'", 'advise-only', 'KLICK-ABGELEHNT')}
$A say "Der Knopf Senden fehlt, MODE=$(grep -c '"mode": "talk"' /tmp/t.json)."
$A chat > /tmp/c1.json
$A say "Zweite Nachricht: $(grep -o 'Und jetzt' /tmp/c1.json | head -1)"
$A chat > /tmp/c2.json; echo "ENDE=$(grep -c ended /tmp/c2.json)"`;
        // The token notice is on again: "Ohne Claude weiter" skips Claude, "Nicht mehr fragen" starts it and remembers that.
        const prefsFile = join(process.env.CAW_AI_HOME, 'prefs.json');
        writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, 'utf8')), tokenNotice: 'on' }));
        let gate = '';
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            await shoot(page, 'klaeren');
            await page.locator('#input').fill('Warum?');
            await page.keyboard.press('Enter');
            await page.locator('.message', { hasText: 'das kostet Token' }).first().waitFor({ timeout: 30000 });
            gate = (await page.locator('#choices button').allInnerTexts()).join('|');
            await shoot(page, 'token-hinweis');
            await decide(page, 'Ohne Claude weiter');
            await stateOf(page, 'discussing');
            await page.locator('#input').fill('Warum?');
            await page.keyboard.press('Enter');
            await page.locator('.message', { hasText: 'das kostet Token' }).nth(1).waitFor({ timeout: 30000 });
            await decide(page, 'Nicht mehr fragen');
            await page.locator('.message.claude', { hasText: 'Der Knopf Senden fehlt, MODE=1' }).waitFor({ timeout: 90000 });
            await stateOf(page, 'discussing');
            await page.locator('#input').fill('Und jetzt?');
            await page.keyboard.press('Enter');
            await page.locator('.message.claude', { hasText: 'Zweite Nachricht: Und jetzt' }).waitFor({ timeout: 60000 });
            await decide(page, 'Schließen');
        });
        // The real sandbox-run writes the log itself; the script replaces it and writes where the chat reads along.
        const logged = `{\n${talk}\n} 2>&1 | tee -a "$CAW_AGENT_DIR/claude-gespraech.log"`;
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen, talkCommand: ['bash', '-c', logged] });
        verify('Ein Fenster, Exit 1', await h.done() === 1 && code === 1, String(code));
        verify('Token-Hinweis: Weiter, Nicht mehr fragen, Ohne Claude weiter; danach gemerkt', gate === 'Weiter|Nicht mehr fragen|Ohne Claude weiter' && JSON.parse(readFileSync(prefsFile, 'utf8')).tokenNotice === 'off', gate);
        const log = join(newestRun().dir, 'agent/claude-gespraech.log');
        const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
        verify('Gespraechslog: lesend, Ende gemeldet', /KLICK-ABGELEHNT=1/.test(text) && /ENDE=1/.test(text) && /FRAGE=1/.test(text), text.slice(-400));
        verify('Datei bis auf Vergleichswerte unveraendert', noNet(read()) === noNet(broken));
        restore();
    });

    await scenario('T Sauberer Schritt: im selben Browser beheben, ohne Vorlauf, dann Pruefdurchlauf', async () => {
        const broken = breakStep(good, 'Abschliessen');
        restore(broken);
        const before = new Set(runDirs());
        const agent = `A=caw-ai
$A task > /tmp/t.json
NR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/t.json','utf8')).repair.remembered[0].value)")
echo "GEMERKT=$NR STEHT=$($A eval "${CASE_TEXT}")"
${planOf(`steps:\n${S3()}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='$NR'"
${finishOf(['S3'])}`;
        const saved = hitCount('Speichern');
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S3 ist gescheitert' }).waitFor({ timeout: 60000 });
            verify('Angebot: im selben Browser', /im selben Browser, ohne die Schritte davor/.test(await page.locator('.message.question').last().textContent()));
            await decide(page, 'Schritt beheben');
            // Unchanged plan: no approval needed.
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Zwei Fenster, Exit 0', await h.done() === 2 && code === 0, String(code));
        verify('Kein Vorlauf: S2 sendet nur im Testlauf und im Pruefdurchlauf', hitCount('Speichern') - saved === 2, String(hitCount('Speichern') - saved));
        // S1 and S2 passed in the test run and got their comparison, otherwise they stay the same.
        verify('S3 neu, S1 und S2 bis auf Vergleichswerte gleich', !/Verschwunden/.test(read()) && noNet(stepText(read(), 'S1')) === noNet(stepText(broken, 'S1')) && noNet(stepText(read(), 'S2')) === noNet(stepText(broken, 'S2')));
        verify('Bericht des Testlaufs bleibt', runDirs().filter((name) => !before.has(name)).some((name) => existsSync(join(fake, '.caw/runs', name, 'report-testlauf.md'))));
        verify('run besteht danach', await run(fake, [ID, ...short]) === 0);
        restore();
    });

    await scenario('U --no-chat: gescheitert ohne Chat und ohne Docker', async () => {
        restore(breakStep(good, 'Senden'));
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans();
        const code = await run(fake, [ID, ...short, '--no-chat'], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('Exit 1, kein Fenster, kein Docker', code === 1 && await h.done() === 0 && dockerUsed === 0, `${code} ${dockerUsed}`);
        const error = await run(fake, [ID, ...short, '--no-chat', '--advise'], { interactive: true }).then(() => null, (failure) => failure);
        verify('--no-chat --fix abgelehnt', error?.code === 'usage', error?.message);
        restore();
    });

    await scenario('V --headless: ohne Fenster, Screenshot beim Fehler, --until abgelehnt', async () => {
        restore();
        const h = humans();
        verify('Besteht headless', await run(fake, [ID, ...short, '--headless'], { interactive: true, onChatOpen: h.onChatOpen }) === 0);
        restore(breakStep(good, 'Senden'));
        const code = await run(fake, [ID, ...short, '--headless'], { interactive: true, onChatOpen: h.onChatOpen });
        const { dir } = newestRun();
        const shots = (base) => readdirSync(base, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? shots(join(base, entry.name)) : [entry.name]));
        verify('Exit 1, kein Chat', code === 1 && await h.done() === 0, String(code));
        verify('Screenshot vom Fehler', shots(dir).some((name) => name.startsWith('fehler-schritt-')), shots(dir).join(' '));
        const error = await run(fake, [ID, ...short, '--headless', '--until', 'S2'], { interactive: true }).then(() => null, (failure) => failure);
        verify('--headless --until abgelehnt', error?.code === 'usage', error?.message);
        restore();
    });

    await scenario('W Chat: scrollt mit, Knopf nach unten beim Hochscrollen, Abbrechen nur einmal und sichtbar', async () => {
        restore(breakStep(good, 'Senden'));
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            const gap = () => page.evaluate(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight; });
            await page.evaluate(() => { for (let i = 0; i < 80; i += 1) window.addMessage('claude', `Zeile ${i}\nmit zwei Zeilen`); });
            verify('Viel auf einmal: steht am Ende', await gap() < 5, String(await gap()));
            await page.evaluate(() => { document.getElementById('messages').scrollTop = 0; });
            await page.waitForTimeout(200);
            verify('Hochgescrollt: Knopf da', await page.locator('#down').isVisible());
            await page.evaluate(() => window.addMessage('claude', 'Neu, waehrend oben'));
            verify('Bleibt oben, Knopf markiert Neues', await gap() > 200 && await page.locator('#down.new').count() === 1);
            await shoot(page, 'runter');
            await page.locator('#down').click();
            await page.waitForTimeout(800);
            verify('Knopf scrollt ans Ende und verschwindet', await gap() < 5 && !await page.locator('#down').isVisible(), String(await gap()));
            // Without Claude the run ends at once: the state is read in the page before it closes.
            const after = await page.evaluate(() => { const a = document.getElementById('abort'); a.click(); a.click(); a.click(); return { disabled: a.disabled, text: a.textContent, status: document.getElementById('status').textContent }; });
            verify('Abbrechen gesperrt und benannt', after.disabled && /Wird abgebrochen/.test(after.text), JSON.stringify(after));
            verify('Hinweis im Status', /Lauf wird beendet/.test(after.status));
        });
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen });
        await h.done();
        verify('Lauf endet', code !== 0, String(code));
        restore();
    });

    // A step that loads prices. The application code lives in preise.js in the project; the fake portal serves it.
    const appFile = join(fake, 'preise.js');
    const PRICES_LOADED = "document.getElementById('preis').textContent==='geladen'";
    const FEES = 'GET /o/DataProxy connector=HTTP-X-Preise';
    const pricesScript = (ms) => `// Laedt die Preise der Bestellung.\nwindow.ladePreise = function () {\n    location.hash = 'preise-' + Date.now();\n    const controller = new AbortController();\n    setTimeout(() => controller.abort(), ${ms});\n    fetch('/o/DataProxy?connector=HTTP-X-Preise', { signal: controller.signal })\n        .then(() => { document.getElementById('preis').textContent = 'geladen'; })\n        .catch(() => {});\n};\n`;
    const S4_PLAIN = '  - id: S4\n    name: Preise laden\n    do: Lade die Preise.\n    expect: Die Preis steht da.\n';
    const plainS4 = () => {
        const at = good.indexOf('knownMessages');
        return at === -1 ? `${good}${S4_PLAIN}` : `${good.slice(0, at)}${S4_PLAIN}${good.slice(at)}`;
    };
    const closeOut = async (page) => {
        for (let i = 0; i < 5; i += 1) {
            const button = page.locator('#choices button', { hasText: /Ohne Beheben beenden|Lauf beenden/ });
            try {
                await button.waitFor({ timeout: 60000 });
                await button.click();
            } catch {
                return;
            }
            await page.waitForTimeout(500).catch(() => {});
        }
    };
    let withFees = '';
    /** Records S4 once via fix: this creates recording.network, the comparison for the assessment. */
    const ensureFees = async () => {
        writeFileSync(appFile, pricesScript(40000));
        if (withFees !== '') return restore(withFees);
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        writeFileSync(configPath, JSON.stringify({ ...config, requestKeys: ['connector'] }, null, 4));
        restore(plainS4());
        const agent = `A=caw-ai
${planOf(`steps:\n${S4_PLAIN.trimEnd()}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#laden'
sleep 1
$A check S4 "${PRICES_LOADED}"
${finishOf(['S4'])}`;
        // Unchanged plan: nothing to approve in Claude's window.
        const h = humans(async () => {}, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await fix(fake, [ID, 'S4', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        // Comparison values are never created while recording, only in the first healthy test run afterwards.
        verify('Aufnahme: ohne recording.network', code === 0 && parseTest(read()).steps.find(({ id }) => id === 'S4')?.recording?.network === undefined);
        // With chat: without it, e.g. in CI, a run does not change the test file. A passed run waits for nobody.
        const healthy = await run(fake, [ID, ...short], { interactive: true });
        withFees = read();
        const s4 = parseTest(withFees).steps.find(({ id }) => id === 'S4');
        const net = s4?.recording?.network ?? [];
        verify('Erster gesunder Lauf: recording.network nur mit dem Request von S4, ohne Vorlauf', healthy === 0 && net.length === 1 && net[0].name === FEES && net[0].status === 200 && net[0].ms >= 250, `${healthy} ${JSON.stringify(net)}`);
        verify('Aufnahme: Hash unberuehrt', s4 !== undefined && stepHash(s4) === s4.recording.hash);
        return undefined;
    };

    await scenario('X Einschaetzung: Abbruch nach 1 ms ist ein Fehler der Anwendung, im Chat, im Bericht und fuer Claude', async () => {
        await ensureFees();
        writeFileSync(appFile, pricesScript(1));
        const talk = `A=caw-ai
$A task > /tmp/t.json
$A network > /tmp/n.json
$A say "APP=$(grep -c '"side": "app"' /tmp/t.json) BELEG=$(grep -c '"evidence"' /tmp/t.json) ABGEBROCHEN=$(grep -c 'aborted' /tmp/n.json) NAME=$(grep -c 'connector=HTTP-X-Preise' /tmp/n.json)"
$A chat > /dev/null`;
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            const text = await page.locator('.message.question').last().textContent();
            verify('Chat: Einschaetzung Anwendung, eindeutig', /Einschätzung: Fehler der Anwendung \(eindeutig\)/.test(text), text);
            verify('Chat: Befund mit Dauer und Aufnahme', /HTTP-X-Preise wurde nach \d+ ms abgebrochen, ohne Seitenwechsel, bei der Aufnahme 200/.test(text));
            verify('Chat: Warnung, Beheben nicht Hauptknopf', /nur verdecken/.test(text) && await page.locator('#choices button.primary', { hasText: 'Schritt beheben' }).count() === 0 && await page.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1);
            await shoot(page, 'einschaetzung');
            await page.locator('#input').fill('Woran liegt es?');
            await page.keyboard.press('Enter');
            const said = page.locator('.message.claude', { hasText: 'APP=' });
            await said.waitFor({ timeout: 90000 });
            verify('Claude sieht Einschaetzung, Belege und network', /APP=[1-9]\d* BELEG=[1-9]\d* ABGEBROCHEN=[1-9]\d* NAME=[1-9]/.test(await said.textContent()), await said.textContent());
            await decide(page, 'Schließen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen, talkCommand: ['bash', '-c', talk] });
        verify('Ein Fenster, Exit 1', await h.done() === 1 && code === 1, String(code));
        const { report, result } = newestRun();
        verify('Bericht: Einschaetzung mit Request neben der Aufnahme', /## Einschätzung/.test(report) && /\| GET \/o\/DataProxy connector=HTTP-X-Preise \| abgebrochen \| \d+ ms \| 200 in \d+ ms \|/.test(report), report.slice(report.indexOf('## Einsch')));
        verify('result.json: diagnosis', result.diagnosis?.side === 'app' && result.diagnosis?.strength === 'clear' && result.diagnosis?.step === 'S4', JSON.stringify(result.diagnosis));
    });

    await scenario('Y Beheben bei Anwendungsfehler: Aenderung am Code geprueft, auf Klick geschrieben, danach besteht der Lauf', async () => {
        await ensureFees();
        writeFileSync(appFile, pricesScript(1));
        const before = new Set(runDirs());
        const bad = JSON.stringify({ items: [{ about: 'S4', side: 'app', title: 'x', evidence: 'e', reason: 'r', prompt: 'p', edits: [{ file: 'preise.js', find: 'gibt es nicht', replace: 'y' }] }] });
        const advice = JSON.stringify({ items: [{
            about: 'S4', side: 'app', title: 'Zeitlimit beim Laden zu kurz',
            evidence: `request ${FEES} nach 1 ms abgebrochen; preise.js:5`,
            reason: 'Die Anwendung bricht den Request nach 1 ms selbst ab.',
            prompt: 'In preise.js bricht ladePreise nach 1 ms ab. Setze das Zeitlimit auf 40 s und pruefe mit caw-ai run fx-schritte.',
            edits: [{ file: 'preise.js', find: 'setTimeout(() => controller.abort(), 1);', replace: 'setTimeout(() => controller.abort(), 40000);', why: 'Zeitlimit wie bei den anderen Aufrufen' }],
        }] });
        const agent = `A=caw-ai
{
$A task > /tmp/t.json; echo "REPAIR-APP=$(grep -c '"side": "app"' /tmp/t.json)"
echo '${bad}' > /tmp/bad.json
${count('$A advise --file /tmp/bad.json', 'advice-invalid', 'EDIT-ABGELEHNT')}
cat > /tmp/a.json <<'EOF'
${advice}
EOF
$A advise --file /tmp/a.json > /dev/null; echo "ADVISE Exit=$?"
echo '{"expectations":[{"id":"S4","status":"fail","note":"Fehler der Anwendung","evidence":{"type":"eval","value":"abgebrochen"}}]}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "FINISH Exit=$?"
} 2>&1 | tee -a "$CAW_AGENT_DIR/claude-beheben.log"`;
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            await decide(page, 'Schritt beheben');
        }, async (page) => {
            await card(page, 0).waitFor({ timeout: 120000 });
            const text = await card(page, 0).textContent();
            verify('Karte: Datei mit Zeile, Unterschied, Beleg', /preise\.js:5/.test(text) && /controller\.abort\(\), 1\)/.test(text) && /40000/.test(text) && /nach 1 ms abgebrochen/.test(text), text);
            verify('Karte: Aenderung uebernehmen ist der Hauptknopf', (await page.locator('#choices button.primary').textContent()) === 'Änderung übernehmen');
            verify('Noch nichts geschrieben', readFileSync(appFile, 'utf8').includes('abort(), 1);'));
            await shoot(page, 'empfehlung-code');
            await decide(page, 'Änderung übernehmen');
            await closeOut(page);
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Zwei Fenster, Exit 1', await h.done() === 2 && code === 1, String(code));
        verify('Code geaendert, Rest gleich', readFileSync(appFile, 'utf8') === pricesScript(40000));
        verify('Testdatei bis auf Vergleichswerte unveraendert', noNet(read()) === noNet(withFees));
        const logs = runDirs().filter((name) => !before.has(name)).map((name) => join(fake, '.caw/runs', name, 'agent/claude-beheben.log')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('\n');
        verify('Beheben sah die Einschaetzung, falsche Stelle abgelehnt, fail ohne Plan', /REPAIR-APP=[1-9]/.test(logs) && /EDIT-ABGELEHNT=1/.test(logs) && /ADVISE Exit=0/.test(logs) && /FINISH Exit=0/.test(logs) && /Urteil angenommen: fail/.test(logs), logs.slice(-600));
        const reports = runDirs().filter((name) => !before.has(name)).map((name) => join(fake, '.caw/runs', name, 'report.md')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('\n');
        verify('Bericht: in den Code uebernommen, mit Diff', /Zeitlimit beim Laden zu kurz \(in den Code übernommen\)/.test(reports) && /```diff/.test(reports));
        verify('run besteht danach', await run(fake, [ID, ...short]) === 0);
    });

    await scenario('Z Abbruch durch Seitenwechsel ist kein Befund', async () => {
        await ensureFees();
        writeFileSync(appFile, "window.ladePreise = function () {\n    fetch('/o/DataProxy?connector=HTTP-X-Langsam');\n    setTimeout(() => location.reload(), 150);\n};\n");
        const code = await run(fake, [ID, ...short, '--no-chat'], { interactive: true });
        const { report } = newestRun();
        const section = report.slice(report.indexOf('## Einsch'));
        verify('Exit 1', code === 1, String(code));
        verify('Tabelle: abgebrochen (Seitenwechsel)', /HTTP-X-Langsam \| abgebrochen \(Seitenwechsel\)/.test(section), section);
        verify('Kein Befund zum Abbruch', !/ohne Seitenwechsel/.test(section) && !/Langsam wurde nach/.test(section));
        verify('Fehlender Request der Aufnahme wird genannt', /HTTP-X-Preise kam bei der Aufnahme/.test(section));
        writeFileSync(appFile, pricesScript(40000));
        restore();
    });

    await scenario('K Harter Fehler bei der Aufnahme: Pruefdurchlauf entscheidet, Mensch sieht ihn', async () => {
        rmSync(file, { force: true });
        const agent = `A=caw-ai
${planOf(`steps:\n${S1}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A eval "Promise.reject({a:1});1" >/dev/null
sleep 1
$A click '#weiter'
$A check S1 "${TARGET_REACHED}"
${finishOf(['S1'])}`;
        const h = humans(async (page) => {
            const app = page.context().pages()[0];
            // Scenario A just demonstrated: the recording offers that demonstration, but a new demonstration is chosen.
            await stateOf(page, 'choosing');
            verify('Letzte Vorfuehrung wird angeboten', await page.locator('#choices button', { hasText: 'Letzte Vorführung verwenden' }).count() === 1);
            await decide(page, 'Selbst vorführen');
            await stateOf(page, 'showing');
            await app.locator('#weiter').click();
            await page.waitForTimeout(400);
            await page.locator('#toggle').click();
        }, approve, async (page) => {
            await page.locator('.message.decision', { hasText: 'harte Fehler' }).waitFor({ timeout: 90000 });
            verify('Entscheidung nennt den Fehler', /ohne Stack.*Object/.test(await page.locator('.message.decision').last().textContent()));
            await decide(page, 'Testplan übernehmen');
        });
        const code = await record(fake, [ID, ...opts, '--role', 'kunde', '--app', 'bestellung'], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 0 und Datei da', code === 0 && existsSync(file), String(code));
        restore();
    });

    await scenario('1 Werkbank: Anwendung im iframe, Chat daneben, Beheben im Frame', async () => {
        const back = keep(configPath);
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.environments.dev.urls.local = 'https://portal.localhost:8443';
        writeFileSync(configPath, JSON.stringify(config, null, 4));
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const agent = `A=caw-ai
$A task > /tmp/t.json; echo "FRAMEWORK=$(grep -c '"framework": "extjs"' /tmp/t.json)"
${tag}
${planOf(`steps:\n${S2('Fuelle das Anliegen neu und sende es.')}`)}
$A plan --file /tmp/p.yaml > /dev/null
echo "URL=$($A url)"
$A reload > /tmp/r.txt; echo "RELOAD=$(grep -c portal.localhost /tmp/r.txt)"
$A snapshot > /tmp/s.txt; echo "FRAME-REFS=$(grep -c 'ref=f[0-9]*e[0-9]*' /tmp/s.txt)"
REF=$(grep -o 'textbox "Anliegen" \\[ref=f[0-9]*e[0-9]*\\]' /tmp/s.txt | grep -o 'f[0-9]*e[0-9]*')
echo "REF=$REF"
$A click "$REF"
$A press a
echo "PRESS=$($A eval "document.getElementById('anliegen').value")"
$A screenshot werkbank.png > /dev/null; echo "SHOT Exit=$?"
$A fill "$REF" "Vorgang $TAG"
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S2'])}`;
        const workbenchOf = (chat) => {
            verify('Chat ist ein Frame der Werkbank', typeof chat.page === 'function' && chat.name() === 'caw-chat');
            return chat.page();
        };
        const appFrame = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
        const h = humans(async (chat) => {
            const bench = workbenchOf(chat);
            await chat.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            const app = appFrame(bench);
            verify('Werkbank unter der Adresse der Anwendung', new URL(bench.url()).origin === new URL(app.url()).origin && bench.url() === app.url(), `${bench.url()} ${app.url()}`);
            // As in the portal: the application accesses the top window and finds its own globals there.
            await app.evaluate(() => { window.cawProbe = { ok: 42 }; });
            await bench.waitForTimeout(700);
            const topAccess = await app.evaluate(() => { try { return `${top.cawProbe?.ok}|${top.location.href === location.href}|${parent.document.title !== ''}`; } catch (error) { return `Fehler ${error.message}`; } });
            verify('top.X der Anwendung geht in der Werkbank', topAccess === '42|true|true', topAccess);
            verify('Anwendung im iframe, trotz X-Frame-Options angemeldet', app !== undefined && (await app.locator('#ziel').textContent()) === 'Ziel erreicht', app?.url());
            const states = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Schritte: S1 bestanden, S2 gescheitert', states[0] === 'pass' && states[1] === 'fail', JSON.stringify(states));
            await bench.waitForTimeout(1500);
            verify('Requests im Panel', /Speichern|app|GET/.test(await bench.locator('body').textContent()));
            const reached = await app.evaluate(async () => {
                try {
                    await window.__cawChat?.({ type: 'choice', id: 'close' });
                    return document.domain;
                } catch (error) {
                    return `abgelehnt ${error.message}`;
                }
            });
            await bench.waitForTimeout(500);
            verify('Die Anwendung erreicht den Chat nicht', await chat.locator('body[data-state=closed]').count() === 0 && await chat.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1, reached);
            const chatReach = await app.evaluate(() => {
                const chatWindow = top.frames['caw-chat'];
                let result = '';
                try { result += chatWindow.document.body ? 'dom-offen' : 'dom-leer'; } catch { result += 'dom-tabu'; }
                try { chatWindow.__cawChat({ type: 'choose', text: 'Schritt beheben' }); result += '|binding-offen'; } catch { result += '|binding-tabu'; }
                return result;
            });
            await bench.waitForTimeout(500);
            verify('Chat fuer die Anwendung tabu (DOM und Binding)', chatReach === 'dom-tabu|binding-tabu' && await chat.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1, chatReach);
            await shoot(chat, 'werkbank-gescheitert');
            await decide(chat, 'Schritt beheben');
        }, async (chat) => {
            const bench = workbenchOf(chat);
            await stateOf(chat, 'planning');
            verify('Frischer Browser: S1 lief im iframe', (await appFrame(bench).locator('#ziel').textContent()) === 'Ziel erreicht');
            await chat.locator('#approve').click();
        }, async (chat) => {
            await chat.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            const states = await chat.page().locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Pruefdurchlauf: Schritte bestanden', states.every((state) => state === 'pass'), JSON.stringify(states));
            await shoot(chat, 'werkbank-behoben');
            await decide(chat, 'Testplan übernehmen');
        });
        try {
            const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
            const windows = await h.done();
            verify('Exit 0', code === 0, `${code} Fenster=${windows}`);
            verify('S2 neu', /Fuelle das Anliegen neu/.test(stepText(read(), 'S2')));
            verify('run ohne Chat (eigenes Fenster) besteht danach', await run(fake, [ID, ...short]) === 0);
        } finally {
            back();
            restore();
        }
    });
    await scenario('2 Entwickeln im Zustand: Fadenkreuz an Claude Code, Aktualisieren ohne Zustand, Zustand neu herstellen, Werkbank neu geladen, Einklappen, Animationen aus', async () => {
        const selection = join(fake, '.caw/auswahl.json');
        const prefs = join(process.env.CAW_AI_HOME, 'prefs.json');
        const pref = () => (existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf8')) : {});
        rmSync(selection, { force: true });
        rmSync(prefs, { force: true });
        quietTokens();
        const restored = (frame) => frame.locator('.message', { hasText: 'ist neu hergestellt' }).count();
        const appOf = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
        const h = humans(async (chat) => {
            const bench = chat.page();
            await stateOf(chat, 'developing');
            const labels = await chat.locator('#choices button').allTextContents();
            verify('Knoepfe zum Entwickeln', ['Zustand neu herstellen', 'Lauf beenden'].every((label) => labels.some((text) => text.includes(label))) && labels.length === 2, JSON.stringify(labels));
            verify('Fadenkreuz im Chat', await chat.locator('#pick').isVisible() && await chat.locator('#pick').isEnabled());
            verify('Kopfzeile: Aktualisieren, Animationen an', (await bench.locator('#reload').textContent()).includes('Aktualisieren') && !(await bench.locator('#still').isChecked()));
            await bench.waitForTimeout(1200);
            const raven = await bench.evaluate(() => { const r = document.getElementById('raven')?.getBoundingClientRect(); const c = document.querySelector('iframe[name=caw-chat]')?.getBoundingClientRect(); return r && c ? { x: r.x, cx: c.x } : null; });
            verify('Rabe fliegt zum Chat', raven !== null && raven.x >= raven.cx - 40, JSON.stringify(raven));
            await shoot(chat, 'entwickeln');
            // Crosshair: the element is attached to the next question and is ready for the Claude Code session at once.
            await chat.locator('#pick').click();
            await bench.waitForTimeout(500);
            await appOf(bench).locator('#ziel').click();
            await chat.locator('#chip.on').waitFor({ timeout: 20000 });
            await chat.locator('.message', { hasText: '“ liegt für deine Claude-Code-Sitzung bereit' }).waitFor({ timeout: 20000 });
            const picked = existsSync(selection) ? JSON.parse(readFileSync(selection, 'utf8')) : null;
            verify('Auswahl fuer die Session', picked?.test === ID && picked?.until === 'S2' && typeof picked?.element?.label === 'string', JSON.stringify(picked)?.slice(0, 200));
            // Requests and console: open, then closed again via the button.
            await bench.locator('[data-tab=requests]').click();
            const opened = await bench.locator('#drawer.open').count();
            await bench.locator('#drawerClose').click();
            verify('Leiste per Knopf eingeklappt', opened === 1 && await bench.locator('#drawer.open').count() === 0);
            // Collapse steps and chat and expand them again, remembered in the settings.
            await bench.locator('#chatFold').click();
            await bench.locator('#stepsFold').click();
            await bench.waitForTimeout(400);
            verify('Eingeklappt und gemerkt', await bench.locator('#chatStrip').isVisible() && await bench.locator('#stepsStrip').isVisible() && pref().chat === 'closed' && pref().steps === 'closed', JSON.stringify(pref()));
            await shoot(chat, 'eingeklappt');
            await bench.locator('#chatStrip').click();
            await bench.locator('#stepsStrip').click();
            await bench.waitForTimeout(400);
            verify('Wieder ausgeklappt', await bench.locator('#chat').isVisible() && await bench.locator('#steps').isVisible() && pref().chat === 'open' && pref().steps === 'open', JSON.stringify(pref()));
            // F5 in the application: only the page reloads, chat and steps stay, the steps show "verlassen".
            await appOf(bench).locator('body').press('F5');
            await bench.locator('#leftNote').waitFor({ state: 'visible', timeout: 30000 });
            const kept = await chat.locator('.message', { hasText: '“ liegt für deine Claude-Code-Sitzung bereit' }).count();
            const states = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('F5: Seite neu, Werkbank bleibt, Zustand verlassen markiert', kept === 1 && states[1] === 'pass' && await restored(chat) === 0 && await bench.locator('body.left-state').count() === 1, JSON.stringify(states));
            await shoot(chat, 'verlassen');
            // Restore the state: the raven only hops forward, the marker disappears.
            await bench.evaluate(() => {
                window.__flight = [];
                window.__flightTimer = setInterval(() => {
                    const r = document.getElementById('raven').getBoundingClientRect();
                    // It lands on dots and steps; the step the icon belongs to is counted.
                    const groups = [...document.querySelectorAll('#steps > li[data-kind=step]')];
                    const icon = [...document.querySelectorAll('#steps .step-icon, #steps .pt-icon')].find((node) => { const box = node.getBoundingClientRect(); return Math.abs(box.left + box.width / 2 - (r.left + r.width / 2)) < 6 && Math.abs(box.top + 2 - r.bottom) < 6; });
                    const at = icon === undefined ? -1 : groups.indexOf(icon.closest('#steps > li'));
                    if (at >= 0 && window.__flight.at(-1) !== at) window.__flight.push(at);
                }, 50);
            });
            await decide(chat, 'Zustand neu herstellen');
            await chat.locator('.message', { hasText: 'ist neu hergestellt' }).first().waitFor({ timeout: 60000 });
            await bench.waitForTimeout(1500);
            const flight = await bench.evaluate(() => { clearInterval(window.__flightTimer); return window.__flight; });
            verify('Rabe huepft beim Wiederherstellen nur vorwaerts', flight.length > 0 && flight.every((at, index) => index === 0 || at > flight[index - 1]) && !flight.includes(2), JSON.stringify(flight));
            verify('Zustand neu hergestellt, Markierung weg', (await appOf(bench).locator('#ziel').textContent()) === 'Ziel erreicht' && await bench.locator('body.left-state').count() === 0);
            // Reload the whole workbench via the browser: chat and steps come back, the page counts as left.
            await bench.reload();
            const fresh = bench.frame({ name: 'caw-chat' });
            await fresh.locator('.message', { hasText: 'Werkbank neu geladen' }).waitFor({ timeout: 30000 });
            const back = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Werkbank neu geladen: Verlauf und Schritte wieder da', await fresh.locator('.message', { hasText: '“ liegt für deine Claude-Code-Sitzung bereit' }).count() === 1 && back.length === 3 && back[1] === 'pass' && await bench.locator('body.left-state').count() === 1, JSON.stringify(back));
            await stateOf(fresh, 'developing');
            await decide(fresh, 'Zustand neu herstellen');
            const deadline = Date.now() + 60000;
            while (await restored(fresh) < 2 && Date.now() < deadline) await bench.waitForTimeout(300);
            verify('Nach dem Neuladen: Zustand neu herstellen geht', await restored(fresh) === 2 && (await appOf(bench).locator('#ziel').textContent()) === 'Ziel erreicht' && await bench.locator('body.left-state').count() === 0);
            // Animations off: the raven flies into the logo, remembered for the next runs.
            await bench.locator('#still').check();
            await bench.waitForTimeout(2000);
            verify('Animationen aus: Rabe im Logo, gemerkt', await bench.locator('#raven.home').count() === 1 && await bench.locator('body.still').count() === 1 && pref().animations === 'off', JSON.stringify(pref()));
            await decide(fresh, 'Beenden');
        }, async (chat) => {
            const bench = chat.page();
            await stateOf(chat, 'developing');
            verify('Naechster Lauf: Animationen bleiben aus', await bench.locator('#still').isChecked() && await bench.locator('body.still').count() === 1);
            await bench.locator('#still').uncheck();
            await bench.waitForTimeout(800);
            verify('Wieder an und gemerkt', pref().animations === 'on' && await bench.locator('body.still').count() === 0);
            await decide(chat, 'Beenden');
        });
        const code = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        verify('Entwickeln endet mit Beenden, Exit 0', code === 0, String(code));
        const second = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        verify('Zweiter Lauf Exit 0', second === 0, String(second));
        verify('Zwei Fenster', await h.done() === 2);
        rmSync(selection, { force: true });
    });

    await scenario('4 Overlay dev: Sencha-Watch ueber dem Portal, nur mit --overlay, nie still der ausgelieferte Stand', async () => {
        // Scenario A records the test: run alone with `node schritte-e2e.mjs A4`.
        restore();
        const withOverlay = (extra) => {
            const config = JSON.parse(readFileSync(mainConfig, 'utf8'));
            const before = JSON.stringify(config.apps.bestellung.overlay);
            config.apps.bestellung.overlay = { ...config.apps.bestellung.overlay, ...extra };
            writeFileSync(mainConfig, JSON.stringify(config, null, 4));
            return () => {
                const now = JSON.parse(readFileSync(mainConfig, 'utf8'));
                now.apps.bestellung.overlay = JSON.parse(before);
                writeFileSync(mainConfig, JSON.stringify(now, null, 4));
            };
        };
        const overlayLine = () => (newestRun().report.match(/Overlay: [^\n]*/) ?? [''])[0];
        // Without the option: deployed, even if an overlay config exists.
        verify('Ohne --overlay: Exit 0', await run(fake, [ID, ...short]) === 0);
        verify('Ohne --overlay: keine Overlay-Zeile im Bericht', overlayLine() === '', overlayLine());
        // No watch and no devCommand: exit 2 with the command, never silently the server.
        verify('Ohne Watch: Exit 2', await run(fake, [ID, ...short, '--overlay', 'dev']) === 2);
        const missing = JSON.stringify(newestRun().result);
        verify('Ohne Watch: Ergebnis nennt sencha app watch', /sencha app watch/.test(missing), missing.slice(0, 300));
        // With devCommand caw starts the watch itself; a stand-in, since bootstrap.json is already in place.
        const marker = join(fake, '.caw/watch-stellvertreter.txt');
        rmSync(marker, { force: true });
        const undo = withOverlay({ devCommand: `node -e "require('fs').writeFileSync('.caw/watch-stellvertreter.txt', String(process.pid)); setInterval(() => {}, 1000)"` });
        try {
            const code = await run(fake, [ID, ...short, '--overlay', 'dev']);
            verify('Mit devCommand: Exit 0', code === 0, String(code));
            const line = overlayLine();
            const local = Number((line.match(/(\d+) Datei\(en\) lokal/) ?? [0, 0])[1]);
            verify('Bericht: Sencha-Watch, App-Statics und Paket lokal', /Sencha-Watch/.test(line) && local >= 2, line);
            verify('Watch wurde gestartet', existsSync(marker));
            // Stopped afterwards: the stand-in process is no longer alive.
            const pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
            const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
            const until = Date.now() + 10000;
            while (pid > 0 && alive() && Date.now() < until) await new Promise((ok) => { setTimeout(ok, 200); });
            verify('Watch nach dem Lauf beendet', pid > 0 && !alive(), String(pid));
        } finally {
            undo();
            rmSync(marker, { force: true });
        }
    });
} catch (error) {
    verify('Skript', false, error.stack);
} finally {
    writeFileSync(mainConfig, configBefore);
    portal.kill();
}
print(`ERGEBNIS OK=${tally.ok} FEHL=${tally.fail}`);
process.exit(tally.fail > 0 ? 1 : 0);
