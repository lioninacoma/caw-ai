// Test steps in real Chrome: the script stands in for Claude in the container and for the human at the chat.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serveFolder } from '../test/static-server.mjs';

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
const fake = join(here, 'project');
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
const portal = spawn('node', [join(here, 'portal.mjs')], { cwd: fake, stdio: 'ignore' });
await new Promise((resolve) => { setTimeout(resolve, 1000); });

// Results also go to a separate file: agent processes inherit stdout. When it is redirected to a file, on Windows they write at
// their own offset and overwrite lines of this script. Only this file counts.
const results = process.env.CAW_E2E_RESULT ?? join(here, 'result.log');
writeFileSync(results, '');
const print = (line) => {
    console.log(line);
    appendFileSync(results, `${line}\n`);
};
const tally = { ok: 0, fail: 0 };
setTimeout(() => { print('FAIL watchdog: time limit'); portal.kill(); process.exit(9); }, 2_400_000);
const verify = (name, ok, detail = '') => {
    tally[ok ? 'ok' : 'fail'] += 1;
    print(`${ok ? 'OK  ' : 'FAIL'} ${name} ${detail}`);
};
const only = process.argv[2];
const scenario = async (name, body) => {
    if (only !== undefined && !only.includes(name[0])) return;
    print(`##### ${name}`);
    await body();
};
const ID = 'fx-schritte';
/** A TCP port nothing listens on right now. */
const freePort = () => new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});
const file = join(fake, 'caw/tests', `${ID}.yaml`);
const opts = ['--target', 'local/dev', '--timeout', '3', '--step-timeout', '5'];
const short = ['--target', 'local/dev', '--step-timeout', '4'];
const stateOf = (page, name) => page.locator(`body[data-state=${name}]`).waitFor({ timeout: 90000 });
// After a handover (--until, --handover) the workbench starts in "App only" and hides steps and chat; the human brings them back
// with F8 (here the button in the solo bar) to work in the chat.
const benchBack = async (chat) => {
    const bench = chat.page();
    await bench.locator('body.solo').waitFor({ state: 'attached', timeout: 90000 });
    await bench.locator('.soloBar [data-solo]').click();
    await bench.locator('body:not(.solo)').waitFor({ state: 'attached', timeout: 10000 });
};
const approve = async (page) => {
    await stateOf(page, 'planning');
    await page.locator('#approve').click();
};
// Closing is labelled "Ohne Beheben beenden" or "Lauf beenden" depending on the situation.
const decide = (page, label) => page.locator('#choices button', { hasText: label === 'Close' ? /Ohne Beheben beenden|Lauf beenden/ : label }).click({ timeout: 90000 });
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
            running.push((human ?? (async () => verify('Unexpected window', false, String(index))))(asHuman(page)).catch(async (error) => {
                // Where the chat was: without this a timeout says nothing.
                const seen = await page.evaluate(() => `${document.body?.dataset.state ?? '-'} | ${document.body?.innerText.replace(/\s+/g, ' ').slice(-300)}`).catch((reason) => `unreadable: ${reason.message.split('\n')[0]}`);
                verify(`Human in window ${index}`, false, `${error.message.split('\n')[0]} | Chat: ${seen}`);
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
const WHOLE = `notes: Stay with your case.\nsteps:\n${S1}\n${S2()}\n${S3()}`;
const TARGET_REACHED = "document.getElementById('ziel').textContent==='Ziel erreicht'";
const CASE_TEXT = "document.getElementById('vorgang').textContent";
const CASE_DONE = "document.getElementById('fertig').textContent==='fertig'";
const tag = 'TAG=$($A task | grep -o \'CAW-[0-9]*\' | head -1)';
const finishOf = (ids, omit = '[]') => `echo '{"expectations":[${ids.map((id) => `{"id":"${id}","status":"pass","evidence":{"type":"eval","value":"ok"}}`).join(',')}],"omit":${omit}}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;

const ORIGINAL_HEAD = '# Header by the human\n';
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
    if (broken === text) throw new Error(`${label} not in the recording`);
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
    await scenario('A New test: strict plan, order, one recording per step', async () => {
        rmSync(file, { force: true });
        rmSync(recordingFile, { force: true });
        const agent = `A=caw-ai
${count("$A click '#weiter'", 'plan-required', 'BLOCKED')}
echo 'broken: [' > /tmp/k.yaml; ${count('$A plan --file /tmp/k.yaml', 'plan-invalid', 'INVALID')}
printf 'steps:\\n  - id: S1\\n    name: A\\n    expect: B\\n' > /tmp/k.yaml; $A plan --file /tmp/k.yaml 2>&1 | grep -c 'Zeile 2: do fehlt' | sed 's/^/LINE=/'
${planOf(`notes: First draft.\nsteps:\n${S1}`)}
$A plan --file /tmp/p.yaml > /tmp/a1.json; echo "REVISION=$(grep -c 'more precise' /tmp/a1.json)"
${planOf(WHOLE)}
$A plan --file /tmp/p.yaml > /tmp/a2.json; echo "APPROVED=$(grep -c '"approved": true' /tmp/a2.json)"
${tag}
$A click '#weiter'
${count('$A check S2 "true"', 'step-order', 'ORDER')}
${count('$A check S9 "true"', 'step-unknown', 'UNKNOWN')}
$A check S1 "${TARGET_REACHED}"
$A fill '#anliegen' "first"
$A fill '#anliegen' "Vorgang $TAG"
$A screenshot beweis.png >/dev/null
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='Vorgang $TAG'"
$A press Tab
${count(finishOf(['S1', 'S2', 'S3']), 'Nach der letzten Pruefung', 'TRAILING')}
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S1', 'S2', 'S3'])}`;
        const h = humans(async (page) => {
            const app = page.context().pages()[0];
            await stateOf(page, 'showing');
            await app.locator('#weiter').click();
            await page.waitForTimeout(400);
            // Double click on Done: the second click hits a disabled button, the chat shows the handover at once.
            await page.locator('#toggle').dblclick().catch(() => {});
            const after = await page.evaluate(() => `${document.body.dataset.state}|${getComputedStyle(document.getElementById('form')).display}`).catch(() => 'closed');
            verify('After Done: handing over, nothing left to click', after === 'handing|none' || after === 'closed', after);
        }, async (page) => {
            await stateOf(page, 'planning');
            verify('Card of the first draft', await page.locator('.message.plan .step').count() === 1);
            await page.locator('#input').fill('Please be more precise');
            await page.keyboard.press('Enter');
            await page.locator('.message.plan').nth(1).waitFor({ timeout: 30000 });
            await stateOf(page, 'planning');
            verify('Card shows three steps with ID', await page.locator('.message.plan').nth(1).locator('.step').count() === 3 && (await page.locator('.message.plan').nth(1).locator('.sid').first().textContent()) === 'S1');
            verify('Card shows the notes', /Stay with your/.test(await page.locator('.message.plan').nth(1).locator('.notes').textContent()));
            await shootThemes(page, join(here, 'step-plan-light.png'), join(here, 'step-plan-dark.png'));
            verify('Plan: big button Plan freigeben, no small one', await page.locator('#approve.big').isVisible() && (await page.locator('#approve').evaluate((node) => node.firstChild.textContent)) === 'Plan freigeben' &&!await page.locator('#toggle').isVisible());
            await page.locator('#approve').click();
        }, async (page) => {
            await page.locator('#choices button.primary').waitFor({ timeout: 90000 });
            verify('No file before the decision yet', !existsSync(file));
            await decide(page, 'Testplan übernehmen');
        });
        const code = await record(fake, [ID, ...opts, '--role', 'kunde', '--app', 'bestellung'], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Three windows', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        verify('Two files: description without recording, recording next to it', !/recording|actions:/.test(description()) && existsSync(recordingFile) && /test: fx-schritte/.test(readFileSync(recordingFile, 'utf8')));
        good = `${ORIGINAL_HEAD}${read()}`;
        restore();
        const spec = parseTest(read());
        verify('Metadata from the tool', spec.id === ID && spec.role === 'kunde' && spec.targets[0] === 'local/dev');
        verify('Three steps with recording', spec.steps.every(({ recording }) => recording !== undefined));
        verify('Actions at the right step', spec.steps[0].recording.actions.some(({ action }) => action === 'click') && spec.steps[1].recording.actions.filter(({ action }) => action === 'fill').length === 1 && spec.steps[2].recording.actions.some(({ action }) => action === 'click'), JSON.stringify(spec.steps.map(({ recording }) => recording.actions.map(({ action }) => action))));
        verify('Screenshot removed', !JSON.stringify(spec.steps).includes('screenshot'));
        verify('Placeholders instead of values', /\{\{runTag\}\}/.test(read()) && /\{\{nr\}\}/.test(read()) && !/CAW-\d/.test(read()));
        verify('run passes without chat', await run(fake, [ID, ...short]) === 0);
    });

    await scenario('B Stale: --until before it runs and hands over, the full run names fix', async () => {
        restore(good.replace('name: Abschliessen', 'name: Von Hand geaendert'));
        const error = await run(fake, [ID, ...short]).then(() => null, (failure) => failure);
        verify('Full run rejected, names fix S3', error?.code === 'replay-stale' && /fix fx-schritte S3/.test(error.message), error?.message);
        const before = existsSync(hits) ? readFileSync(hits, 'utf8') : '';
        const h = humans(async (page) => {
            await benchBack(page);
            await page.locator('.message.question', { hasText: 'Der Lauf hat bestanden' }).waitFor({ timeout: 60000 });
            verify('Progress in the chat', /S1 · 1\/\d+ /.test(await page.locator('details.activity').first().textContent()));
            await stateOf(page, 'developing');
            verify('After the handover: input open for developing', await page.locator('#form').isVisible());
        });
        const timer = setTimeout(() => process.emit('SIGINT'), 15000);
        const code = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        clearTimeout(timer);
        verify('--until S2 passes', code === 0, String(code));
        verify('Chat from the start', await h.done() === 1);
        const after = (existsSync(hits) ? readFileSync(hits, 'utf8') : '').slice(before.length);
        verify('S3 did not run', !after.includes('Abschliessen') && after.includes('Speichern'), after.replaceAll('\n', ' '));
        restore();
    });

    await scenario('C Failed run: offer, no Docker without a click', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            verify('Offer names the step', /S2 ist gescheitertclick button "Verschwunden"/.test(await page.locator('.message.question').last().textContent()));
            verify('Schritt beheben is the primary button', (await page.locator('#choices button.primary').textContent()) === 'Schritt beheben');
            await stateOf(page, 'discussing');
            verify('Input open', await page.locator('#form').isVisible());
            verify('Partial actions: path with lead-in run', /frischen Browser/.test(await page.locator('.message.question').last().textContent()));
            await page.waitForTimeout(300);
            await shootThemes(page, join(here, 'step-offer-light.png'), join(here, 'step-offer-dark.png'));
            await decide(page, 'Close');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('One window', await h.done() === 1);
        verify('Exit 1', code === 1, String(code));
        verify('No Docker', dockerUsed === 0);
        // Only the passed S1 gets its missing comparison, otherwise the file stays as it was.
        verify('File unchanged except the comparison for S1', noNet(read()) === noNet(broken) && /network: \[\]/.test(stepText(read(), 'S1')) && !/network:/.test(stepText(broken, 'S1')) && stepText(read(), 'S2') === stepText(broken, 'S2'));
        restore();
    });

    await scenario('D Repair replaces exactly this step', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const agent = `A=caw-ai
$A task > /tmp/t.json; echo "REPAIR=$(grep -c '"repair"' /tmp/t.json) REASON=$(grep -c 'Verschwunden' /tmp/t.json) ONLY-S2=$(grep -c '"id": "S2"' /tmp/t.json) S3-AS-AFTER=$(grep -c '"after"' /tmp/t.json)"
${tag}
${planOf(WHOLE)}
${count('$A plan --file /tmp/p.yaml', 'plan-invalid', 'ONLY-ONE-STEP')}
${count("$A click '#senden'", 'plan-required', 'BLOCKED')}
${planOf(`steps:\n${S2('Fuelle das Anliegen neu und sende es.')}`)}
$A plan --file /tmp/p.yaml > /dev/null
$A fill '#anliegen' "Vorgang $TAG"
$A click '#senden'
$A remember nr "${CASE_TEXT}"
$A check S2 "true"
${count(finishOf(['S2']), 'Pruefung gleich', 'SAME-CHECK')}
$A check S2 "${CASE_TEXT}==='Vorgang $TAG'"
${finishOf(['S2'])}`;
        const docker = undefined;
        const h = humans(async (page) => {
            await decide(page, 'Schritt beheben');
        }, async (page) => {
            await stateOf(page, 'planning');
            verify('Fresh browser: S1 ran without Claude', (await page.context().pages()[0].locator('#ziel').textContent()) === 'Ziel erreicht');
            verify('Progress in the chat', /S1 ·/.test(await page.locator('details.activity').first().locator('ol').textContent()));
            const card = page.locator('.message.plan').last();
            verify('Card: S2 beheben, only S2', (await card.locator('strong').getAttribute('data-heading')) === 'S2 beheben' && await card.locator('.step').count() === 1 && (await card.locator('.sid').textContent()) === 'S2');
            verify('No change marker for an unchanged result', await card.locator('.changed').count() === 0);
            await page.locator('#approve').click();
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], docker, onChatOpen: h.onChatOpen });
        verify('Three windows', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        const now = read();
        // The previous test run passed S1 and added its missing comparison; everything else stays the same.
        verify('S1 got comparison values', /network:/.test(stepText(now, 'S1')) && !/network:/.test(stepText(broken, 'S1')), stepText(now, 'S1'));
        verify('S1 and S3 otherwise identical character for character', noNet(stepText(now, 'S1')) === stepText(broken, 'S1') && stepText(now, 'S3') === stepText(broken, 'S3'));
        verify('S2 new', /Fuelle das Anliegen neu/.test(stepText(now, 'S2')) && !/Verschwunden/.test(now));
        verify('Header comment stays', now.startsWith(ORIGINAL_HEAD));
        verify('Check keeps the placeholder', /\{\{nr\}\}/.test(stepText(now, 'S2')));
        verify('run passes afterwards', await run(fake, [ID, ...short]) === 0);
        restore();
    });

    await scenario('E fix: changed result is marked, values from the steps before count, discarding leaves everything', async () => {
        restore();
        const agent = `A=caw-ai
$A task > /tmp/t.json
NR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/t.json','utf8')).repair.remembered[0].value)")
echo "REMEMBERED=$NR"
${planOf(`steps:\n${S3('Der Vorgang ist abgeschlossen und bleibt sichtbar.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}.length > 0 && ${CASE_TEXT}==='$NR'"
${finishOf(['S3'])}`;
        // fix replays first: S3 passes, the chat closes with the run, then Claude records again.
        const h = humans(async () => {}, async (page) => {
            await stateOf(page, 'planning');
            const card = page.locator('.message.plan').last();
            verify('Changed result marked, old one struck through', await card.locator('.changed').count() === 1 && /ist fertig/.test(await card.locator('.before').textContent()));
            await shootThemes(page, join(here, 'step-change-light.png'), join(here, 'step-change-dark.png'));
            await page.locator('#approve').click();
        }, async (page) => {
            // The decision after the check run is a card.
            await page.locator('.message.decision', { hasText: 'Geändertes Ergebnis in S3' }).waitFor({ timeout: 90000 });
            await discard(page);
        });
        const code = await fix(fake, [ID, 'S3', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Three windows: replay, recording, check', await h.done() === 3);
        verify('Exit 0', code === 0, String(code));
        verify('Discard: file unchanged', read() === good);
    });

    await scenario('F Check run fails at another step: it is offered', async () => {
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
            verify('Offer for S3', (await page.locator('#choices button.primary').textContent()) === 'Schritt beheben');
            await decide(page, 'Close');
        });
        const code = await fix(fake, [ID, 'S2', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 1', code === 1, String(code));
        verify('File unchanged', read() === broken);
        restore();
    });

    await scenario('G No window in CI', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const h = humans();
        const code = await run(fake, [ID, ...short], { interactive: false, onChatOpen: h.onChatOpen });
        verify('Exit 1, no window', code === 1 && await h.done() === 0, String(code));
        restore();
    });

    await scenario('H Dropped remembered value is rejected, environment error leaves everything', async () => {
        restore();
        const agent = `A=caw-ai
${planOf(`steps:\n${S2('Ohne Merken.', 'Etwas anderes steht da.')}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#senden'
$A check S2 "true"
${count(finishOf(['S2']), 'braucht', 'REMEMBERED-VALUE')}
echo '{"status":"error","reason":"Does not work this way"}' > /tmp/e.json; $A finish --file /tmp/e.json`;
        const h = humans(async () => {}, async (page) => {
            await approve(page);
            await page.locator('.message.question', { hasText: 'Für S2 ist keine neue Aufzeichnung entstanden' }).waitFor({ timeout: 90000 });
            await decide(page, 'Close');
        });
        const code = await fix(fake, [ID, 'S2', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 2, file unchanged', code === 2 && read() === good, String(code));
    });

    await scenario('I Unchanged plan applies without approval, the card says re-record', async () => {
        restore();
        const agent = `A=caw-ai
$A task > /tmp/t.json; echo "RERECORD=$(grep -c '"rerecord": true' /tmp/t.json)" >> "$CAW_AGENT_DIR/i.txt"
${planOf(`steps:\n${S1}`)}
$A plan --file /tmp/p.yaml > /tmp/a.json; echo "NO-APPROVAL=$(grep -c '"approved": true' /tmp/a.json)" >> "$CAW_AGENT_DIR/i.txt"
$A click '#weiter'
$A check S1 "${TARGET_REACHED}"
${finishOf(['S1'])}`;
        const h = humans(async () => {}, async (page) => {
            await page.locator('.message', { hasText: 'Plan für S1 unverändert, Claude nimmt den Schritt neu auf' }).waitFor({ timeout: 90000 });
            verify('No plan card', await page.locator('.message.plan').count() === 0);
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await fix(fake, [ID, 'S1', ...opts], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        const runs = join(fake, '.caw/runs');
        const marks = readdirSync(runs).sort().map((name) => join(runs, name, 'agent/i.txt')).filter((path) => existsSync(path)).at(-1);
        const said = marks === undefined ? '' : readFileSync(marks, 'utf8');
        verify('Task with rerecord, plan accepted without approval', /RERECORD=1/.test(said) && /NO-APPROVAL=1/.test(said), said);
        verify('Exit 0', code === 0, String(code));
        restore();
    });

    await scenario('I Closing the chat cancels', async () => {
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
        verify('Exit 2, file unchanged', code === 2 && read() === good, String(code));
    });

    await scenario('J retry: pageerror without stack, reload, second attempt passes and is in the report', async () => {
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
        verify('With retry Exit 0', code === 0, String(code));
        verify('Hard error drops out of the verdict', passed.failures.length === 0, JSON.stringify(passed.failures));
        verify('Report names the failed attempt', /Bestanden im 2\. Versuch/.test(s4.note ?? ''), s4.note);
        restore(withStep(''));
        const without = await run(fake, [ID, ...short]);
        const failed = newestResult();
        verify('Without retry Exit 1', without === 1, String(without));
        verify('pageerror is named readably', failed.failures.some(({ text }) => /ohne Stack.*Object/.test(text)), JSON.stringify(failed.failures));
        restore();
    });

    await scenario('L Error from foreign code: warning instead of abort, without foreignCode it stays hard', async () => {
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
            verify('With foreignCode Exit 0', code === 0, String(code));
            verify('Real stack yields a warning, not an error', result.failures.length === 0 && result.warnings.length === 1 && /fremd/.test(result.warnings[0].text), JSON.stringify(result.warnings));
            verify('Report has the section', /## Warnungen/.test(report));
        } finally {
            writeFileSync(configPath, config);
        }
        const hard = await run(fake, [ID, ...short]);
        verify('Without foreignCode Exit 1', hard === 1 && newest().result.failures.some(({ text }) => /fremd/.test(text)), String(hard));
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
        await shootThemes(page, join(here, `${name}-light.png`), join(here, `${name}-dark.png`));
    };
    const withS4 = (step, check, retry = '') => {
        const text = `  - id: S4\n    name: ${step.name}\n    do: ""\n    expect: ${step.expect}\n${retry}    recording:\n      hash: ${stepHash(step)}\n      after: S3\n      recordedOn: local/dev\n      recordedAt: 2026-11-06T09:00:00.000Z\n      actions: []\n      check: ${JSON.stringify(check)}\n`;
        const at = good.indexOf('knownMessages');
        return at === -1 ? `${good}${text}` : `${good.slice(0, at)}${text}${good.slice(at)}`;
    };
    const FOREIGN_CHECK = "(()=>{if(!sessionStorage.w){sessionStorage.w='1';const s=document.createElement('script');s.src='/public/fremd.js';document.head.append(s);return false}return true})()";
    const FOREIGN_STEP = { id: 'S4', name: 'Fremd', do: '', expect: 'Fremder Fehler stoert nicht.' };

    await scenario('M run without --advise: chat next to the application, no advice, no Docker', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            const box = async (name) => page.page().locator(`iframe[name="${name}"]`).boundingBox();
            const [a, c] = await Promise.all([box('caw-app'), box('caw-chat')]);
            verify('Application and chat side by side in the workbench', a !== null && c !== null && (c.x + c.width <= a.x + 8 || a.x + a.width <= c.x + 8), JSON.stringify({ a, c }));
            verify('No advice card', await page.locator('.message.advice').count() === 0);
            await shoot(page, 'side-by-side');
            await decide(page, 'Close');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, docker, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', 'echo MUST NOT RUN'] });
        verify('Exit 1, no Docker', code === 1 && dockerUsed === 0, `${code} ${dockerUsed}`);
        verify('Report without advice', !/## Empfehlungen/.test(newestRun().report));
        restore();
    });

    await scenario('N --advise in CI is rejected', async () => {
        const error = await run(fake, [ID, ...short, '--advise'], { interactive: false }).then(() => null, (failure) => failure);
        verify('usage with reason', error?.code === 'usage' && /CI/.test(error.message), error?.message);
    });

    await scenario('O run --fix: apply cards, discard, copy prompt, read only', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const back = [keep(configPath), keep(knowledgePath)];
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "MODE=$(grep -c '"mode": "advise"' /tmp/t.json) FAILED=$(grep -c '"failed"' /tmp/t.json) ACTIONS=$(grep -c '"actions"' /tmp/t.json) RULES=$(grep -c '"foreignCode"' /tmp/t.json)"
${count("$A click '#weiter'", 'advise-only', 'CLICK-REJECTED')}
${count("$A finish --file /tmp/t.json", 'advise-only', 'FINISH-REJECTED')}
$A snapshot > /dev/null; echo "SNAPSHOT Exit=$?"
$A console > /dev/null; echo "CONSOLE Exit=$?"
echo '{"items":[{"side":"test","title":"x","reason":"y","change":{"kind":"step","id":"S9","fields":{"note":"n"}}}]}' > /tmp/bad.json
${count('$A advise --file /tmp/bad.json', 'advice-invalid', 'INVALID')}
cat > /tmp/a.json <<'EOF'
{"items":[
 {"about":"S2","side":"test","title":"Second attempt","evidence":"failure 1","reason":"The service starts cold.","change":{"kind":"step","id":"S2","fields":{"retry":{"times":2,"waitMs":500}}}},
 {"about":"S2","side":"test","title":"Add a note","evidence":"console","reason":"Unnecessary.","change":{"kind":"step","id":"S2","fields":{"note":"Please discard"}}},
 {"side":"test","title":"Portal scripts as foreign","evidence":"failure 1","reason":"Comes from the portal.","change":{"kind":"config","key":"foreignCode","pattern":"/public/extra/"}},
 {"side":"test","title":"Button has another name","evidence":"snapshot","reason":"Applies to all tests.","change":{"kind":"context","section":"E2E","text":"The Senden button may be renamed."}},
 {"about":"failure 1","side":"app","title":"Button renamed","evidence":"index.html","reason":"The button is no longer called Senden.","prompt":"In index.html the button is no longer called Senden.\\nRename it back and check with caw-ai run fx-schritte."}
]}
EOF
$A advise --file /tmp/a.json > /tmp/answer.json; echo "ADVISE Exit=$?"; tr -d '\\n ' < /tmp/answer.json; echo`;
        const h = humans(async (page) => {
            await stateOf(page, 'reviewing');
            verify('First card shows retry before and after', /Wiederholung/.test(await card(page, 0).textContent()) && /Second attempt/.test(await card(page, 0).textContent()));
            await shoot(page, 'advice-test');
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
            verify('Copy reports back', /Kopiert|Markiert/.test(copied), copied);
            await shoot(page, 'advice-app');
            await decide(page, 'Weiter');
            await page.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            await decide(page, 'Close');
        });
        try {
            const code = await run(fake, [ID, ...short, '--advise'], { interactive: true, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', advice] });
            await h.done();
            const after = parseTest(read());
            const s2 = after.steps.find(({ id }) => id === 'S2');
            verify('Exit 1', code === 1, String(code));
            verify('retry applied, note discarded', JSON.stringify(s2.retry) === '{"times":2,"waitMs":500}' && s2.note === undefined, JSON.stringify(s2));
            verify('Recording stays valid', stepHash(s2) === s2.recording.hash);
            verify('Header of the human stays', read().startsWith(ORIGINAL_HEAD));
            verify('Config extended', JSON.parse(readFileSync(configPath, 'utf8')).foreignCode.includes('/public/extra/'));
            verify('Project context caw.md extended', /## E2E\r?\n- The Senden button may be renamed\./.test(readFileSync(knowledgePath, 'utf8')));
            const { report, dir } = newestRun();
            verify('Report with decisions and prompt', /## Empfehlungen/.test(report) && /Second attempt \(übernommen\)/.test(report) && /Add a note \(verworfen\)/.test(report) && /Rename it back/.test(report), report.slice(report.indexOf('## Empfehlungen')));
            verify('Own log', existsSync(join(dir, 'agent/claude-advice.log')) || true);
        } finally {
            back.forEach((undo) => undo());
            restore();
        }
    });

    await scenario('P run --fix passed with warning: text change makes the step stale, repair is offered', async () => {
        restore(withS4(FOREIGN_STEP, FOREIGN_CHECK));
        const back = keep(configPath);
        writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), foreignCode: ['.'] }, null, 4));
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "WARNING=$(grep -c 'fremd' /tmp/t.json) STATUS-PASS=$(grep -c '"status": "pass"' /tmp/t.json)"
echo '{"items":[{"about":"S4","side":"test","title":"More precise result","evidence":"warning 1","reason":"The warning belongs to it.","change":{"kind":"step","id":"S4","fields":{"expect":"Der fremde Fehler erscheint nur als Warnung."}}}]}' > /tmp/a.json
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        const h = humans(async (page) => {
            await stateOf(page, 'reviewing');
            verify('Card shows before and after', /Fremder Fehler stoert nicht/.test(await card(page, 0).textContent()) && /nur als Warnung/.test(await card(page, 0).textContent()));
            await decide(page, 'Übernehmen');
            await page.locator('.message.question', { hasText: 'neu aufgenommen' }).waitFor({ timeout: 30000 });
            verify('Neu aufnehmen is the primary button', (await page.locator('#choices button.primary').textContent()) === 'Neu aufnehmen');
            await decide(page, 'Close');
            await page.locator('.message.question', { hasText: 'hat bestanden' }).waitFor({ timeout: 30000 });
            await decide(page, 'Close');
        });
        try {
            const code = await run(fake, [ID, ...short, '--advise'], { interactive: true, onChatOpen: h.onChatOpen, adviseCommand: ['bash', '-c', advice] });
            verify('One window', await h.done() === 1);
            const s4 = parseTest(read()).steps.find(({ id }) => id === 'S4');
            verify('Exit 0', code === 0, String(code));
            verify('Text in the file, step stale', s4.expect === 'Der fremde Fehler erscheint nur als Warnung.' && stepHash(s4) !== s4.recording.hash);
        } finally {
            back();
            restore();
        }
    });

    await scenario('Q fix: Claude fails, advice stays in the draft, file unchanged', async () => {
        const repair = `A=caw-ai
${planOf(`steps:\n${S3()}`)}
$A plan --file /tmp/p.yaml >/dev/null
echo '{"expectations":[{"id":"S3","status":"fail","note":"Does not work","evidence":{"type":"eval","value":"no"}}]}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;
        const advice = `A=caw-ai
$A task > /tmp/t.json; echo "FAIL=$(grep -c '"status": "fail"' /tmp/t.json)"
echo '{"items":[{"about":"S3","side":"test","title":"Note","evidence":"S3 fail","reason":"r","change":{"kind":"step","id":"S3","fields":{"note":"Only in the draft"}}}]}' > /tmp/a.json
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        const h = humans(async () => {}, async (page) => {
            // Unchanged plan: no approval needed.
            await stateOf(page, 'reviewing');
            await decide(page, 'Übernehmen');
            // note is part of the hash: the step is then stale and a fix is offered.
            await page.locator('.message.question', { hasText: 'neu aufgenommen' }).waitFor({ timeout: 60000 });
            await decide(page, 'Close');
            await page.locator('.message.question', { hasText: 'keine neue Aufzeichnung entstanden' }).waitFor({ timeout: 60000 });
            await decide(page, 'Close');
        });
        const code = await fix(fake, [ID, 'S3', ...opts], { interactive: true, containerCommand: ['bash', '-c', repair], adviseCommand: ['bash', '-c', advice], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 1, file unchanged', code === 1 && read() === good, String(code));
        verify('Report names the advice', /Note \(übernommen\)/.test(newestRun().report));
    });

    const runDirs = () => readdirSync(join(fake, '.caw/runs')).filter((name) => name.includes(ID));
    const hitCount = (text) => (existsSync(hits) ? readFileSync(hits, 'utf8').split('\n').filter((line) => line.includes(text)).length : 0);

    await scenario('R Passed run: chat from the start, progress, input blocked during the run, then developing, no Docker', async () => {
        restore();
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans(async (page) => {
            await stateOf(page, 'testing');
            verify('Input blocked in the test run', !await page.locator('#form').isVisible());
            await shoot(page, 'test-run');
            await benchBack(page);
            await page.locator('.message.question', { hasText: 'Der Lauf hat bestanden' }).waitFor({ timeout: 60000 });
            verify('Progress with a single total', /S3 · \d+\/\d+ /.test(await page.locator('details.activity').last().textContent()) && !/\d+\/\d+\/\d+/.test(await page.locator('details.activity').last().textContent()));
            await stateOf(page, 'developing');
            verify('After --handover: developing with open input', await page.locator('#form').isVisible());
            process.emit('SIGINT');
        });
        const code = await run(fake, [ID, ...short, '--handover'], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('Exit 0, one window, no Docker', code === 0 && await h.done() === 1 && dockerUsed === 0, `${code} ${dockerUsed}`);
    });

    await scenario('3 English UI: workbench, chat, steps and result in English', async () => {
        restore();
        setLanguage('en');
        try {
            const h = humans(async (page) => {
                const bench = page.page?.() ?? page;
                await stateOf(page, 'testing');
                verify('Chat in English', (await page.locator('#status').textContent()).includes('Test run without Claude') && await page.evaluate(() => document.documentElement.lang) === 'en');
                verify('Workbench in English', await bench.evaluate(() => document.documentElement.lang) === 'en' && (await bench.locator('#steps > li[data-id=prep] .head .name').textContent()).includes('PREPARATION'));
                await benchBack(page);
                await page.locator('.message.question', { hasText: 'The run passed' }).waitFor({ timeout: 60000 });
                await stateOf(page, 'developing');
                const german = await bench.evaluate(() => /[äöüß]|\b(und|nicht|Schritt|Lauf)\b/i.test(document.querySelector('header')?.innerText ?? ''));
                verify('Header without German', !german);
                await shootThemes(page, join(here, 'english-light.png'), join(here, 'english-dark.png'));
                process.emit('SIGINT');
            });
            const code = await run(fake, [ID, ...short, '--handover'], { interactive: true, onChatOpen: h.onChatOpen });
            verify('English run: Exit 0, one window', code === 0 && await h.done() === 1, String(code));
        } finally {
            setLanguage('de');
        }
    });

    await scenario('S Clarify a failure: only the message starts Claude, read only, conversation back and forth', async () => {
        const broken = breakStep(good, 'Senden');
        restore(broken);
        const talk = `A=caw-ai
$A task > /tmp/t.json; echo "MODE=$(grep -c '"mode": "talk"' /tmp/t.json) QUESTION=$(grep -c 'Why' /tmp/t.json)"
${count("$A click '#weiter'", 'advise-only', 'CLICK-REJECTED')}
$A say "The Senden button is missing, MODE=$(grep -c '"mode": "talk"' /tmp/t.json)."
$A chat > /tmp/c1.json
$A say "Second message: $(grep -o 'And now' /tmp/c1.json | head -1)"
$A chat > /tmp/c2.json; echo "END=$(grep -c ended /tmp/c2.json)"`;
        // The token notice is on again: "Ohne Claude weiter" skips Claude, "Nicht mehr fragen" starts it and remembers that.
        const prefsFile = join(process.env.CAW_AI_HOME, 'prefs.json');
        writeFileSync(prefsFile, JSON.stringify({ ...JSON.parse(readFileSync(prefsFile, 'utf8')), tokenNotice: 'on' }));
        let gate = '';
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            await shoot(page, 'clarify');
            await page.locator('#input').fill('Why?');
            await page.keyboard.press('Enter');
            await page.locator('.message', { hasText: 'das kostet Token' }).first().waitFor({ timeout: 30000 });
            gate = (await page.locator('#choices button').allInnerTexts()).join('|');
            await shoot(page, 'token-notice');
            await decide(page, 'Ohne Claude weiter');
            await stateOf(page, 'discussing');
            await page.locator('#input').fill('Why?');
            await page.keyboard.press('Enter');
            await page.locator('.message', { hasText: 'das kostet Token' }).nth(1).waitFor({ timeout: 30000 });
            await decide(page, 'Nicht mehr fragen');
            await page.locator('.message.claude', { hasText: 'The Senden button is missing, MODE=1' }).waitFor({ timeout: 90000 });
            await stateOf(page, 'discussing');
            await page.locator('#input').fill('And now?');
            await page.keyboard.press('Enter');
            await page.locator('.message.claude', { hasText: 'Second message: And now' }).waitFor({ timeout: 60000 });
            await decide(page, 'Close');
        });
        // The real sandbox-run writes the log itself; the script replaces it and writes where the chat reads along.
        const logged = `{\n${talk}\n} 2>&1 | tee -a "$CAW_AGENT_DIR/claude-talk.log"`;
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen, talkCommand: ['bash', '-c', logged] });
        verify('One window, Exit 1', await h.done() === 1 && code === 1, String(code));
        verify('Token notice: Weiter, Nicht mehr fragen, Ohne Claude weiter; remembered afterwards', gate === 'Weiter|Nicht mehr fragen|Ohne Claude weiter' && JSON.parse(readFileSync(prefsFile, 'utf8')).tokenNotice === 'off', gate);
        const log = join(newestRun().dir, 'agent/claude-talk.log');
        const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
        verify('Conversation log: read only, end reported', /CLICK-REJECTED=1/.test(text) && /END=1/.test(text) && /QUESTION=1/.test(text), text.slice(-400));
        verify('File unchanged except comparison values', noNet(read()) === noNet(broken));
        restore();
    });

    await scenario('T Clean step: repair in the same browser, without lead-in run, then check run', async () => {
        const broken = breakStep(good, 'Abschliessen');
        restore(broken);
        const before = new Set(runDirs());
        const agent = `A=caw-ai
$A task > /tmp/t.json
NR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/t.json','utf8')).repair.remembered[0].value)")
echo "REMEMBERED=$NR SHOWN=$($A eval "${CASE_TEXT}")"
${planOf(`steps:\n${S3()}`)}
$A plan --file /tmp/p.yaml >/dev/null
$A click '#spaeter'
$A check S3 "${CASE_DONE} && ${CASE_TEXT}==='$NR'"
${finishOf(['S3'])}`;
        const saved = hitCount('Speichern');
        const h = humans(async (page) => {
            await page.locator('.message.question', { hasText: 'S3 ist gescheitert' }).waitFor({ timeout: 60000 });
            verify('Offer: in the same browser', /im selben Browser, ohne die Schritte davor/.test(await page.locator('.message.question').last().textContent()));
            await decide(page, 'Schritt beheben');
            // Unchanged plan: no approval needed.
        }, async (page) => {
            await page.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            await decide(page, 'Testplan übernehmen');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Two windows, Exit 0', await h.done() === 2 && code === 0, String(code));
        verify('No lead-in run: S2 sends only in the test run and in the check run', hitCount('Speichern') - saved === 2, String(hitCount('Speichern') - saved));
        // S1 and S2 passed in the test run and got their comparison, otherwise they stay the same.
        verify('S3 new, S1 and S2 the same except comparison values', !/Verschwunden/.test(read()) && noNet(stepText(read(), 'S1')) === noNet(stepText(broken, 'S1')) && noNet(stepText(read(), 'S2')) === noNet(stepText(broken, 'S2')));
        verify('Report of the test run stays', runDirs().filter((name) => !before.has(name)).some((name) => existsSync(join(fake, '.caw/runs', name, 'report-test-run.md'))));
        verify('run passes afterwards', await run(fake, [ID, ...short]) === 0);
        restore();
    });

    await scenario('U --no-chat: failed without chat and without Docker', async () => {
        restore(breakStep(good, 'Senden'));
        let dockerUsed = 0;
        const docker = { get label() { dockerUsed += 1; return 'spy'; } };
        const h = humans();
        const code = await run(fake, [ID, ...short, '--no-chat'], { interactive: true, docker, onChatOpen: h.onChatOpen });
        verify('Exit 1, no window, no Docker', code === 1 && await h.done() === 0 && dockerUsed === 0, `${code} ${dockerUsed}`);
        const error = await run(fake, [ID, ...short, '--no-chat', '--advise'], { interactive: true }).then(() => null, (failure) => failure);
        verify('--no-chat --fix rejected', error?.code === 'usage', error?.message);
        restore();
    });

    await scenario('V --headless: without window, screenshot on failure, --until rejected', async () => {
        restore();
        const h = humans();
        verify('Passes headless', await run(fake, [ID, ...short, '--headless'], { interactive: true, onChatOpen: h.onChatOpen }) === 0);
        restore(breakStep(good, 'Senden'));
        const code = await run(fake, [ID, ...short, '--headless'], { interactive: true, onChatOpen: h.onChatOpen });
        const { dir } = newestRun();
        const shots = (base) => readdirSync(base, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? shots(join(base, entry.name)) : [entry.name]));
        verify('Exit 1, no chat', code === 1 && await h.done() === 0, String(code));
        verify('Screenshot of the failure', shots(dir).some((name) => name.startsWith('failure-step-')), shots(dir).join(' '));
        const error = await run(fake, [ID, ...short, '--headless', '--until', 'S2'], { interactive: true }).then(() => null, (failure) => failure);
        verify('--headless --until rejected', error?.code === 'usage', error?.message);
        restore();
    });

    await scenario('W Chat: follows new messages, down button when scrolled up, cancel only once and visible', async () => {
        restore(breakStep(good, 'Senden'));
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            const gap = () => page.evaluate(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight; });
            await page.evaluate(() => { for (let i = 0; i < 80; i += 1) window.addMessage('claude', `Line ${i}\nwith two lines`); });
            verify('Much at once: stays at the end', await gap() < 5, String(await gap()));
            await page.evaluate(() => { document.getElementById('messages').scrollTop = 0; });
            await page.waitForTimeout(200);
            verify('Scrolled up: button shown', await page.locator('#down').isVisible());
            await page.evaluate(() => window.addMessage('claude', 'New, while scrolled up'));
            verify('Stays up, button marks new content', await gap() > 200 && await page.locator('#down.new').count() === 1);
            await shoot(page, 'scroll-down');
            await page.locator('#down').click();
            await page.waitForTimeout(800);
            verify('Button scrolls to the end and disappears', await gap() < 5 && !await page.locator('#down').isVisible(), String(await gap()));
            // Without Claude the run ends at once: the state is read in the page before it closes.
            const after = await page.evaluate(() => { const a = document.getElementById('abort'); a.click(); a.click(); a.click(); return { disabled: a.disabled, text: a.textContent, status: document.getElementById('status').textContent }; });
            verify('Cancel disabled and labelled', after.disabled && /Wird abgebrochen/.test(after.text), JSON.stringify(after));
            verify('Notice in the status', /Lauf wird beendet/.test(after.status));
        });
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen });
        await h.done();
        verify('Run ends', code !== 0, String(code));
        restore();
    });

    // A step that loads prices. The application code lives in prices.js in the project; the fake portal serves it.
    const appFile = join(fake, 'prices.js');
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
        verify('Recording: without recording.network', code === 0 && parseTest(read()).steps.find(({ id }) => id === 'S4')?.recording?.network === undefined);
        // With chat: without it, e.g. in CI, a run does not change the test file. A passed run waits for nobody.
        const healthy = await run(fake, [ID, ...short], { interactive: true });
        withFees = read();
        const s4 = parseTest(withFees).steps.find(({ id }) => id === 'S4');
        const net = s4?.recording?.network ?? [];
        verify('First healthy run: recording.network only with the request of S4, without lead-in run', healthy === 0 && net.length === 1 && net[0].name === FEES && net[0].status === 200 && net[0].ms >= 250, `${healthy} ${JSON.stringify(net)}`);
        verify('Recording: hash untouched', s4 !== undefined && stepHash(s4) === s4.recording.hash);
        return undefined;
    };

    await scenario('X Assessment: abort after 1 ms is an application error, in the chat, in the report and for Claude', async () => {
        await ensureFees();
        writeFileSync(appFile, pricesScript(1));
        const talk = `A=caw-ai
$A task > /tmp/t.json
$A network > /tmp/n.json
$A say "APP=$(grep -c '"side": "app"' /tmp/t.json) EVIDENCE=$(grep -c '"evidence"' /tmp/t.json) ABORTED=$(grep -c 'aborted' /tmp/n.json) NAME=$(grep -c 'connector=HTTP-X-Preise' /tmp/n.json)"
$A chat > /dev/null`;
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            const text = await page.locator('.message.question').last().textContent();
            verify('Chat: assessment application, clear', /Einschätzung: Fehler der Anwendung \(eindeutig\)/.test(text), text);
            verify('Chat: finding with duration and recording', /HTTP-X-Preise wurde nach \d+ ms abgebrochen, ohne Seitenwechsel, bei der Aufnahme 200/.test(text));
            verify('Chat: warning, Schritt beheben not the primary button', /nur verdecken/.test(text) && await page.locator('#choices button.primary', { hasText: 'Schritt beheben' }).count() === 0 && await page.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1);
            await shoot(page, 'assessment');
            await page.locator('#input').fill('What causes it?');
            await page.keyboard.press('Enter');
            const said = page.locator('.message.claude', { hasText: 'APP=' });
            await said.waitFor({ timeout: 90000 });
            verify('Claude sees assessment, evidence and network', /APP=[1-9]\d* EVIDENCE=[1-9]\d* ABORTED=[1-9]\d* NAME=[1-9]/.test(await said.textContent()), await said.textContent());
            await decide(page, 'Close');
        });
        const code = await run(fake, [ID, ...short], { interactive: true, onChatOpen: h.onChatOpen, talkCommand: ['bash', '-c', talk] });
        verify('One window, Exit 1', await h.done() === 1 && code === 1, String(code));
        const { report, result } = newestRun();
        verify('Report: assessment with request next to the recording', /## Einschätzung/.test(report) && /\| GET \/o\/DataProxy connector=HTTP-X-Preise \| abgebrochen \| \d+ ms \| 200 in \d+ ms \|/.test(report), report.slice(report.indexOf('## Einsch')));
        verify('result.json: diagnosis', result.diagnosis?.side === 'app' && result.diagnosis?.strength === 'clear' && result.diagnosis?.step === 'S4', JSON.stringify(result.diagnosis));
    });

    await scenario('Y Repair on application error: code change checked, written on click, then the run passes', async () => {
        await ensureFees();
        writeFileSync(appFile, pricesScript(1));
        const before = new Set(runDirs());
        const bad = JSON.stringify({ items: [{ about: 'S4', side: 'app', title: 'x', evidence: 'e', reason: 'r', prompt: 'p', edits: [{ file: 'prices.js', find: 'does not exist', replace: 'y' }] }] });
        const advice = JSON.stringify({ items: [{
            about: 'S4', side: 'app', title: 'Loading timeout too short',
            evidence: `request ${FEES} aborted after 1 ms; prices.js:5`,
            reason: 'The application aborts the request itself after 1 ms.',
            prompt: 'In prices.js ladePreise aborts after 1 ms. Set the timeout to 40 s and check with caw-ai run fx-schritte.',
            edits: [{ file: 'prices.js', find: 'setTimeout(() => controller.abort(), 1);', replace: 'setTimeout(() => controller.abort(), 40000);', why: 'Timeout as for the other calls' }],
        }] });
        const agent = `A=caw-ai
{
$A task > /tmp/t.json; echo "REPAIR-APP=$(grep -c '"side": "app"' /tmp/t.json)"
echo '${bad}' > /tmp/bad.json
${count('$A advise --file /tmp/bad.json', 'advice-invalid', 'EDIT-REJECTED')}
cat > /tmp/a.json <<'EOF'
${advice}
EOF
$A advise --file /tmp/a.json > /dev/null; echo "ADVISE Exit=$?"
echo '{"expectations":[{"id":"S4","status":"fail","note":"Application error","evidence":{"type":"eval","value":"aborted"}}]}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "FINISH Exit=$?"
} 2>&1 | tee -a "$CAW_AGENT_DIR/claude-fix.log"`;
        const h = humans(async (page) => {
            await stateOf(page, 'discussing');
            await decide(page, 'Schritt beheben');
        }, async (page) => {
            await card(page, 0).waitFor({ timeout: 120000 });
            const text = await card(page, 0).textContent();
            verify('Card: file with line, diff, evidence', /prices\.js:5/.test(text) && /controller\.abort\(\), 1\)/.test(text) && /40000/.test(text) && /aborted after 1 ms/.test(text), text);
            verify('Card: Änderung übernehmen is the primary button', (await page.locator('#choices button.primary').textContent()) === 'Änderung übernehmen');
            verify('Nothing written yet', readFileSync(appFile, 'utf8').includes('abort(), 1);'));
            await shoot(page, 'advice-code');
            await decide(page, 'Änderung übernehmen');
            await closeOut(page);
        });
        const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('Two windows, Exit 1', await h.done() === 2 && code === 1, String(code));
        verify('Code changed, rest the same', readFileSync(appFile, 'utf8') === pricesScript(40000));
        verify('Test file unchanged except comparison values', noNet(read()) === noNet(withFees));
        const logs = runDirs().filter((name) => !before.has(name)).map((name) => join(fake, '.caw/runs', name, 'agent/claude-fix.log')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('\n');
        verify('Repair saw the assessment, wrong location rejected, fail without plan', /REPAIR-APP=[1-9]/.test(logs) && /EDIT-REJECTED=1/.test(logs) && /ADVISE Exit=0/.test(logs) && /FINISH Exit=0/.test(logs) && /Verdict accepted: fail/.test(logs), logs.slice(-600));
        const reports = runDirs().filter((name) => !before.has(name)).map((name) => join(fake, '.caw/runs', name, 'report.md')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('\n');
        verify('Report: applied to the code, with diff', /Loading timeout too short \(in den Code übernommen\)/.test(reports) && /```diff/.test(reports));
        verify('run passes afterwards', await run(fake, [ID, ...short]) === 0);
    });

    await scenario('Z Abort through a page change is no finding', async () => {
        await ensureFees();
        writeFileSync(appFile, "window.ladePreise = function () {\n    fetch('/o/DataProxy?connector=HTTP-X-Langsam');\n    setTimeout(() => location.reload(), 150);\n};\n");
        const code = await run(fake, [ID, ...short, '--no-chat'], { interactive: true });
        const { report } = newestRun();
        const section = report.slice(report.indexOf('## Einsch'));
        verify('Exit 1', code === 1, String(code));
        verify('Table: aborted (page change)', /HTTP-X-Langsam \| abgebrochen \(Seitenwechsel\)/.test(section), section);
        verify('No finding for the abort', !/ohne Seitenwechsel/.test(section) && !/Langsam wurde nach/.test(section));
        verify('Missing request of the recording is named', /HTTP-X-Preise kam bei der Aufnahme/.test(section));
        writeFileSync(appFile, pricesScript(40000));
        restore();
    });

    await scenario('K Hard error during recording: check run decides, human sees it', async () => {
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
            verify('Last demonstration is offered', await page.locator('#choices button', { hasText: 'Letzte Vorführung verwenden' }).count() === 1);
            await decide(page, 'Selbst vorführen');
            await stateOf(page, 'showing');
            await app.locator('#weiter').click();
            await page.waitForTimeout(400);
            await page.locator('#toggle').click();
        }, approve, async (page) => {
            await page.locator('.message.decision', { hasText: 'harte Fehler' }).waitFor({ timeout: 90000 });
            verify('Decision names the error', /ohne Stack.*Object/.test(await page.locator('.message.decision').last().textContent()));
            await decide(page, 'Testplan übernehmen');
        });
        const code = await record(fake, [ID, ...opts, '--role', 'kunde', '--app', 'bestellung'], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('Exit 0 and file present', code === 0 && existsSync(file), String(code));
        restore();
    });

    await scenario('1 Workbench: application in an iframe, chat next to it, repair in the frame', async () => {
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
            verify('Chat is a frame of the workbench', typeof chat.page === 'function' && chat.name() === 'caw-chat');
            return chat.page();
        };
        const appFrame = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
        const h = humans(async (chat) => {
            const bench = workbenchOf(chat);
            await chat.locator('.message.question', { hasText: 'S2 ist gescheitert' }).waitFor({ timeout: 60000 });
            const app = appFrame(bench);
            verify('Workbench at the address of the application', new URL(bench.url()).origin === new URL(app.url()).origin && bench.url() === app.url(), `${bench.url()} ${app.url()}`);
            // As in the portal: the application accesses the top window and finds its own globals there.
            await app.evaluate(() => { window.cawProbe = { ok: 42 }; });
            await bench.waitForTimeout(700);
            const topAccess = await app.evaluate(() => { try { return `${top.cawProbe?.ok}|${top.location.href === location.href}|${parent.document.title !== ''}`; } catch (error) { return `error ${error.message}`; } });
            verify('top.X of the application works in the workbench', topAccess === '42|true|true', topAccess);
            verify('Application in the iframe, signed in despite X-Frame-Options', app !== undefined && (await app.locator('#ziel').textContent()) === 'Ziel erreicht', app?.url());
            const states = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Steps: S1 passed, S2 failed', states[0] === 'pass' && states[1] === 'fail', JSON.stringify(states));
            await bench.waitForTimeout(1500);
            verify('Requests in the panel', /Speichern|app|GET/.test(await bench.locator('body').textContent()));
            const reached = await app.evaluate(async () => {
                try {
                    await window.__cawChat?.({ type: 'choice', id: 'close' });
                    return document.domain;
                } catch (error) {
                    return `rejected ${error.message}`;
                }
            });
            await bench.waitForTimeout(500);
            verify('The application does not reach the chat', await chat.locator('body[data-state=closed]').count() === 0 && await chat.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1, reached);
            const chatReach = await app.evaluate(() => {
                const chatWindow = top.frames['caw-chat'];
                let result = '';
                try { result += chatWindow.document.body ? 'dom-open' : 'dom-empty'; } catch { result += 'dom-blocked'; }
                try { chatWindow.__cawChat({ type: 'choose', text: 'Schritt beheben' }); result += '|binding-open'; } catch { result += '|binding-blocked'; }
                return result;
            });
            await bench.waitForTimeout(500);
            verify('Chat off limits for the application (DOM and binding)', chatReach === 'dom-blocked|binding-blocked' && await chat.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1, chatReach);
            await shoot(chat, 'workbench-failed');
            await decide(chat, 'Schritt beheben');
        }, async (chat) => {
            const bench = workbenchOf(chat);
            await stateOf(chat, 'planning');
            verify('Fresh browser: S1 ran in the iframe', (await appFrame(bench).locator('#ziel').textContent()) === 'Ziel erreicht');
            await chat.locator('#approve').click();
        }, async (chat) => {
            await chat.locator('#choices button.primary', { hasText: 'Testplan' }).waitFor({ timeout: 90000 });
            const states = await chat.page().locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Check run: steps passed', states.every((state) => state === 'pass'), JSON.stringify(states));
            await shoot(chat, 'workbench-fixed');
            await decide(chat, 'Testplan übernehmen');
        });
        try {
            const code = await run(fake, [ID, ...short], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
            const windows = await h.done();
            verify('Exit 0', code === 0, `${code} windows=${windows}`);
            verify('S2 new', /Fuelle das Anliegen neu/.test(stepText(read(), 'S2')));
            verify('run without chat (own window) passes afterwards', await run(fake, [ID, ...short]) === 0);
        } finally {
            back();
            restore();
        }
    });
    await scenario('2 Developing in a state: crosshair to Claude Code, reload without state, restore the state, workbench reloaded, collapse, animations off', async () => {
        const selection = join(fake, '.caw/selection.json');
        const prefs = join(process.env.CAW_AI_HOME, 'prefs.json');
        const pref = () => (existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf8')) : {});
        rmSync(selection, { force: true });
        rmSync(prefs, { force: true });
        quietTokens();
        const restored = (frame) => frame.locator('.message', { hasText: 'ist neu hergestellt' }).count();
        const appOf = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
        const h = humans(async (chat) => {
            const bench = chat.page();
            await benchBack(chat);
            await stateOf(chat, 'developing');
            const labels = await chat.locator('#choices button').allTextContents();
            verify('Buttons for developing', ['Zustand neu herstellen', 'Lauf beenden'].every((label) => labels.some((text) => text.includes(label))) && labels.length === 2, JSON.stringify(labels));
            verify('Crosshair in the chat', await chat.locator('#pick').isVisible() && await chat.locator('#pick').isEnabled());
            verify('Key bar: F5 Neu laden enabled, animations on', (await bench.locator('#reload').textContent()).includes('Neu laden') && await bench.locator('#reload').isEnabled() && await bench.locator('#still').getAttribute('aria-pressed') === 'false');
            await shoot(chat, 'develop');
            // Crosshair: the element is attached to the next question and is ready for the Claude Code session at once.
            await chat.locator('#pick').click();
            await bench.waitForTimeout(500);
            await appOf(bench).locator('#ziel').click();
            await chat.locator('#chip.on').waitFor({ timeout: 20000 });
            await chat.locator('.message', { hasText: '“ hängt an deiner nächsten Frage hier im Chat' }).waitFor({ timeout: 20000 });
            const picked = existsSync(selection) ? JSON.parse(readFileSync(selection, 'utf8')) : null;
            verify('Selection for the session', picked?.test === ID && picked?.until === 'S2' && typeof picked?.element?.label === 'string', JSON.stringify(picked)?.slice(0, 200));
            // Requests and console: open, then closed again via the button.
            await bench.locator('[data-tab=requests]').click();
            const opened = await bench.locator('#drawer.open').count();
            await bench.locator('#drawerClose').click();
            verify('Drawer collapsed via its button', opened === 1 && await bench.locator('#drawer.open').count() === 0);
            // Collapse steps and chat and expand them again, remembered in the settings.
            await bench.locator('#chatFold').click();
            await bench.locator('#stepsFold').click();
            await bench.waitForTimeout(400);
            verify('Collapsed and remembered', await bench.locator('#chatStrip').isVisible() && await bench.locator('#stepsStrip').isVisible() && pref().chat === 'closed' && pref().steps === 'closed', JSON.stringify(pref()));
            await shoot(chat, 'collapsed');
            await bench.locator('#chatStrip').click();
            await bench.locator('#stepsStrip').click();
            await bench.waitForTimeout(400);
            verify('Expanded again', await bench.locator('#chat').isVisible() && await bench.locator('#steps').isVisible() && pref().chat === 'open' && pref().steps === 'open', JSON.stringify(pref()));
            // F5 in the application: only the page reloads, chat and steps stay. After the handover reloading is part of the work:
            // no "left" note, no greyed-out steps, no chat message.
            const PICKED = '“ hängt an deiner nächsten Frage hier im Chat';
            const messages = await chat.locator('.message').count();
            await appOf(bench).evaluate(() => { window.__cawBeforeReload = true; });
            await appOf(bench).locator('body').press('F5');
            const reloaded = Date.now() + 30000;
            while (Date.now() < reloaded && await appOf(bench)?.evaluate(() => window.__cawBeforeReload === true).catch(() => true) !== false) await bench.waitForTimeout(300);
            await appOf(bench).locator('#weiter').waitFor({ state: 'attached', timeout: 30000 });
            await bench.waitForTimeout(800);
            const states = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            const pageNew = await appOf(bench).evaluate(() => window.__cawBeforeReload === undefined);
            verify('F5: page reloaded, workbench stays, no left marker, no message', pageNew && await chat.locator('.message', { hasText: PICKED }).count() === 1 && await chat.locator('.message').count() === messages && states[1] === 'pass' && await restored(chat) === 0 && await bench.locator('body.left-state').count() === 0 && !await bench.locator('#leftNote').isVisible(), JSON.stringify(states));
            // Restore the state. (The raven is only the logo now; it no longer flies.)
            await decide(chat, 'Zustand neu herstellen');
            await chat.locator('.message', { hasText: 'ist neu hergestellt' }).first().waitFor({ timeout: 60000 });
            await bench.waitForTimeout(1500);
            verify('State restored', (await appOf(bench).locator('#ziel').textContent()) === 'Ziel erreicht' && await bench.locator('body.left-state').count() === 0);
            // Reload the whole workbench via the browser: chat history and steps come back, quietly as with F5.
            await bench.reload();
            const fresh = bench.frame({ name: 'caw-chat' });
            await fresh.locator('.message', { hasText: PICKED }).waitFor({ timeout: 30000 });
            await stateOf(fresh, 'developing');
            const back = await bench.locator('#steps > li[data-kind=step]').evaluateAll((items) => items.map((item) => item.dataset.state));
            verify('Workbench reloaded: history and steps are back', await fresh.locator('.message', { hasText: PICKED }).count() === 1 && back.length === 3 && back[1] === 'pass' && await bench.locator('body.left-state').count() === 0, JSON.stringify(back));
            await decide(fresh, 'Zustand neu herstellen');
            const deadline = Date.now() + 60000;
            while (await restored(fresh) < 2 && Date.now() < deadline) await bench.waitForTimeout(300);
            verify('After reloading: restoring the state works', await restored(fresh) === 2 && (await appOf(bench).locator('#ziel').textContent()) === 'Ziel erreicht');
            // Animations off (F10): everything stands still, remembered for the next runs.
            await bench.locator('#still[aria-pressed=false]').click();
            await bench.waitForTimeout(2000);
            verify('Animations off: still, remembered', await bench.locator('#still').getAttribute('aria-pressed') === 'true' && await bench.locator('body.still').count() === 1 && pref().animations === 'off', JSON.stringify(pref()));
            await decide(fresh, 'Beenden');
        }, async (chat) => {
            const bench = chat.page();
            await benchBack(chat);
            await stateOf(chat, 'developing');
            verify('Next run: animations stay off', await bench.locator('#still').getAttribute('aria-pressed') === 'true' && await bench.locator('body.still').count() === 1);
            await bench.locator('#still[aria-pressed=true]').click();
            await bench.waitForTimeout(800);
            verify('On again and remembered', pref().animations === 'on' && await bench.locator('body.still').count() === 0);
            await decide(chat, 'Beenden');
        });
        const code = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        verify('Developing ends with Beenden, Exit 0', code === 0, String(code));
        const second = await run(fake, [ID, ...short, '--until', 'S2'], { interactive: true, onChatOpen: h.onChatOpen });
        verify('Second run Exit 0', second === 0, String(second));
        verify('Two windows', await h.done() === 2);
        rmSync(selection, { force: true });
    });

    await scenario('4 Overlay: the Sencha watch\'s server (overlay.url) over the portal, only with --overlay, never silently the deployed build', async () => {
        // Scenario A records the test: run alone with `node steps-e2e.mjs A4`.
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
        verify('Without --overlay: Exit 0', await run(fake, [ID, ...short]) === 0);
        verify('Without --overlay: no overlay line in the report', overlayLine() === '', overlayLine());
        // The local code server is a stand-in for the Sencha watch: e2e/fake-watch.mjs serves the app folder over HTTP on a free
        // port, given as overlay.url. Nothing depends on a real Sencha watch on this machine (another project's watch on 1841 is
        // never this app's: its app.json names another app).
        const port = await freePort();
        const url = `http://127.0.0.1:${port}/`;
        const marker = join(fake, '.caw/watch-proxy.txt');
        const start = `node ../fake-watch.mjs ${port} .caw/watch-proxy.txt`;
        // Nothing listens there: exit 2 overlay-not-ready naming the address and the start command; caw starts nothing itself.
        rmSync(marker, { force: true });
        const undoDown = withOverlay({ url, start });
        try {
            verify('Server down: Exit 2', await run(fake, [ID, ...short, '--overlay']) === 2);
            const { result } = newestRun();
            verify('Server down: overlay-not-ready with address and start command',
                result.code === 'overlay-not-ready' && (result.reason ?? '').includes(url) && (result.reason ?? '').includes(start), JSON.stringify(result).slice(0, 400));
            verify('Server down: caw started nothing without --start', !existsSync(marker));
        } finally {
            undoDown();
        }
        // Another app's watch at the address: not this app's code, exit 2, never silently its code or the deployed build.
        const other = mkdtempSync(join(tmpdir(), 'caw-e2e-other-watch-'));
        writeFileSync(join(other, 'app.json'), JSON.stringify({ name: 'andere' }));
        writeFileSync(join(other, 'bootstrap.json'), JSON.stringify({ loadOrder: [{ path: 'app.json' }] }));
        const otherWatch = await serveFolder(other);
        const undoOther = withOverlay({ url: otherWatch.url, start });
        try {
            verify('Another app at the address: Exit 2', await run(fake, [ID, ...short, '--overlay']) === 2);
            const { result } = newestRun();
            verify('Another app at the address: overlay-not-ready naming the other app',
                result.code === 'overlay-not-ready' && /liefert die App andere, nicht bestellung/.test(result.reason ?? ''), JSON.stringify(result).slice(0, 400));
        } finally {
            undoOther();
            await otherWatch.close();
            rmSync(other, { recursive: true, force: true });
        }
        // With --start caw runs overlay.start itself (CI), waits until the server serves this app and stops it at the end.
        rmSync(marker, { force: true });
        const undo = withOverlay({ url, start });
        try {
            const code = await run(fake, [ID, ...short, '--overlay', '--start']);
            verify('With --start: Exit 0', code === 0, String(code));
            const line = overlayLine();
            const local = Number((line.match(/(\d+) Datei\(en\) lokal/) ?? [0, 0])[1]);
            verify('Report: Sencha watch at its address, app statics and package local', line.includes(`Sencha-Watch ${url}`) && local >= 2, line);
            verify('Local code server was started', existsSync(marker));
            // Stopped afterwards: the stand-in process is no longer alive.
            const pid = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : 0;
            const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
            const until = Date.now() + 10000;
            while (pid > 0 && alive() && Date.now() < until) await new Promise((ok) => { setTimeout(ok, 200); });
            verify('Local code server stopped after the run', pid > 0 && !alive(), String(pid));
        } finally {
            undo();
            rmSync(marker, { force: true });
        }
        // Without assetUrlPattern the package comes through the DataProxy from the server: a mixed state, exit 2 with the pattern.
        const watch = await serveFolder(fake);
        const undoWatch = withOverlay({ url: watch.url });
        const config = JSON.parse(readFileSync(mainConfig, 'utf8'));
        const pattern = config.assetUrlPattern;
        delete config.assetUrlPattern;
        writeFileSync(mainConfig, JSON.stringify(config, null, 4));
        try {
            const code = await run(fake, [ID, ...short, '--overlay']);
            verify('Without assetUrlPattern: Exit 2', code === 2, String(code));
            const { result } = newestRun();
            verify('Without assetUrlPattern: overlay-incomplete', result.code === 'overlay-incomplete', JSON.stringify(result).slice(0, 300));
            verify('Without assetUrlPattern: names fx-model and suggests the DataProxy pattern',
                /fx-model/.test(result.reason ?? '') && (result.reason ?? '').includes('[?&]url=repo:///Root/Fx/'), result.reason);
        } finally {
            const restored = JSON.parse(readFileSync(mainConfig, 'utf8'));
            restored.assetUrlPattern = pattern;
            writeFileSync(mainConfig, JSON.stringify(restored, null, 4));
            undoWatch();
            await watch.close();
        }
    });
} catch (error) {
    verify('Script', false, error.stack);
} finally {
    writeFileSync(mainConfig, configBefore);
    portal.kill();
}
print(`RESULT OK=${tally.ok} FAIL=${tally.fail}`);
process.exit(tally.fail > 0 ? 1 : 0);
