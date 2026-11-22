// N1–N15: native Playwright locators against the fixture site e2e/native (nested frames, shadow DOM, a dialog transition, a
// virtual list, repeated rows, a select inside its label). The tests come from native/project.mjs; N1, N2 and N5 record their
// own (rec-*) with a scripted agent and a scripted human.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

import { TESTS, testText, writeTests } from '../native/project.mjs';
import { setStepDesign, stepHash } from '../../src/host/test-file.mjs';
import {
    appOf, benchBack, clickChoice, decide, endAction, finishOf, here, humans, lastDemonstration, loadTest, newestRunOf, open, parseTest, patchJson, planOf, print, record, reproduce, run,
    runDirsOf, showMyself, slash, sleep, startServer, stateOf, tag, verify, writeTest,
} from '../harness.mjs';

const native = join(here, 'native');
const PORT = 8451;
const target = ['--env', 'test', '--step-timeout', '5s'];
const recordArgs = ['--env', 'test', '--agent-timeout', '3m', '--step-timeout', '5s'];
let server = null;
const group = {
    language: 'de',
    setup: async () => {
        // Old runs would offer their demonstration to a new recording; old rec-* tests would be re-recorded instead of created.
        rmSync(join(native, '.caw/runs'), { recursive: true, force: true });
        for (const dir of ['caw/tests', 'caw/recordings']) {
            for (const name of existsSync(join(native, dir)) ? readdirSync(join(native, dir)) : []) if (name.startsWith('rec-')) rmSync(join(native, dir, name));
        }
        writeTests(native);
        server = await startServer(join(native, 'serve.mjs'), [String(PORT)], { cwd: native, port: PORT });
    },
    teardown: async () => { server?.kill(); },
};
export const scenarios = [];
const scenario = (id, title, body) => scenarios.push({ id, title, group, body });

/**
 * Every target of a test's recording, in order. Without a written recording (the check run after recording failed) those of the
 * newest draft the recording run left.
 */
const draftText = (id, root = native) => {
    const runs = join(root, '.caw/runs');
    const draft = existsSync(runs) ? readdirSync(runs).filter((name) => name.endsWith(`Z-${id}`) && existsSync(join(runs, name, 'test-draft.yaml'))).sort().at(-1) : undefined;
    return draft === undefined ? '' : readFileSync(join(runs, draft, 'test-draft.yaml'), 'utf8');
};
const written = (id, root = native) => existsSync(join(root, 'caw/recordings', `${id}.yaml`));
const targetsOf = (id, root = native) => {
    const steps = written(id, root) ? loadTest(root, id).steps : (draftText(id, root) === '' ? [] : parseTest(draftText(id, root)).steps);
    return steps.flatMap((step) => (step.recording?.actions ?? []).filter(({ target: code }) => code !== undefined).map(({ target: code }) => code));
};
const recordingText = (id) => (written(id) ? readFileSync(join(native, 'caw/recordings', `${id}.yaml`), 'utf8') : '');
/** The recording file, or the newest draft if none was written. */
const recordedText = (id) => (written(id) ? recordingText(id) : draftText(id));
/** The text of one step in the recording file, from its "- id:" line to the next. */
const stepBlock = (text, id) => {
    const start = text.indexOf(`  - id: ${id}\n`);
    const next = text.indexOf('\n  - id: ', start + 5);
    const end = next === -1 ? text.indexOf('\nknownMessages', start) : next;
    return start === -1 ? '' : text.slice(start, end === -1 ? undefined : end);
};
/** What a failed run says about its step: the note of the first failed result. */
const failureOf = (id, root = native) => {
    const { result } = newestRunOf(root, id);
    return (result?.results ?? []).find(({ status }) => status === 'fail')?.note ?? JSON.stringify(result?.failures ?? result);
};
/** A run without chat (as in CI): exit code and the failure note. */
const runQuietly = async (id, extra = [], root = native) => {
    const code = await run(root, [id, ...target, ...extra]).catch((error) => `error ${error.code}: ${error.message}`);
    return { code, note: typeof code === 'number' && code !== 0 ? failureOf(id, root) : '' };
};
/**
 * The human for a recording window: follows the test plan when asked, approves the plan, adopts the result. Ends when the
 * window closes or after adopting.
 */
const followAndAdopt = async (page) => {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
        const follow = page.locator('#choices button', { hasText: 'Claude Code geht dem Testplan nach' });
        const adopt = page.locator('#choices button', { hasText: 'Testplan übernehmen' });
        if (await adopt.count().catch(() => 0) > 0) {
            await clickChoice(page, adopt);
            return;
        }
        // The check run after the recording failed: nothing to adopt, the scenario's checks report it.
        const close = page.locator('#choices button', { hasText: /Ohne Beheben beenden|Lauf beenden/ });
        if (await page.locator('.message:is(.question,.result,.notice)', { hasText: /ist gescheitert|[Kk]eine (neue )?Aufzeichnung/ }).count().catch(() => 0) > 0 && await close.count().catch(() => 0) > 0) {
            await clickChoice(page, close);
            return;
        }
        if (await follow.count().catch(() => 0) > 0) await clickChoice(page, follow).catch(() => {});
        else if (await page.locator('body[data-state=planning] #approve').isVisible().catch(() => false)) await page.locator('#approve').click().catch(() => {});
        else if (await page.locator('body').count().catch(() => 0) === 0) return;
        await sleep(300);
    }
    throw new Error('no decision within 4 minutes');
};
const NO_MARKER = (code) => !/data-caw-mark|aria-ref|ref=|nth\(|:nth-child/.test(code);

// ---- N1: Claude records via snapshot references and CSS

const ERRANDS = 'rec-errands';
const ERRANDS_PLAN = `notes: Eine Besorgung anlegen und erledigen.
steps:
  - id: S1
    name: Anlegen
    do: Lege die Besorgung "Feed the raven {{runTag}}" an.
    expect: Sie steht oben in der Liste.
  - id: S2
    name: Erledigen
    do: Erledige die neue Besorgung.
    expect: Sie ist durchgestrichen.
  - id: S3
    name: Speichern
    do: Speichere.
    expect: Gespeichert.`;
const S1_COMMANDS = `REF=$($A snapshot | grep 'textbox "New errand"' | grep -oE 'ref=[a-z0-9]+' | head -1 | cut -d= -f2)
echo "REF-FIELD=$REF"
$A fill "$REF" "Feed the raven $TAG"
$A click '#add'
$A check S1 "document.querySelector('#errands li span').textContent==='Errand Feed the raven $TAG'"`;
const LATER_COMMANDS = `REF=$($A snapshot | grep -A3 "Feed the raven $TAG" | grep 'button "Complete"' | grep -oE 'ref=[a-z0-9]+' | head -1 | cut -d= -f2)
echo "REF-COMPLETE=$REF"
$A click "$REF"
$A check S2 "document.querySelector('#errands li').classList.contains('done')"
$A click 'button#save'
$A check S3 "document.getElementById('status').textContent==='Saved'"`;

const recordErrands = async () => {
    const agent = `A='caw agent'
${tag}
${planOf(ERRANDS_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
${S1_COMMANDS}
${LATER_COMMANDS}
${finishOf(['S1', 'S2', 'S3'])}`;
    // The description exists, the recording does not: the human lets Claude follow the plan instead of demonstrating.
    rmSync(join(native, 'caw/recordings', `${ERRANDS}.yaml`), { force: true });
    writeFileSync(join(native, 'caw/tests', `${ERRANDS}.yaml`), `id: ${ERRANDS}\nenvironments: [test]\nwrites: false\n${ERRANDS_PLAN}\n`);
    const h = humans(followAndAdopt, followAndAdopt, followAndAdopt);
    const code = await record(native, [ERRANDS, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N1 recording: Exit 0', code === 0, String(code));
    const targets = targetsOf(ERRANDS);
    print(`     targets: ${targets.join(' | ')}`);
    verify('Field from a snapshot reference: role and full name, exact', targets[0] === "getByRole('textbox', { name: 'New errand', exact: true })", targets[0]);
    verify('Button from CSS: role and name, exact', targets[1] === "getByRole('button', { name: 'Add', exact: true })", targets[1]);
    verify('Row scoped by its text with {{runTag}} kept, no position',
        targets[2] === "getByRole('listitem').filter({ hasText: 'Errand Feed the raven {{runTag}}' }).getByRole('button', { name: 'Complete', exact: true })", targets[2]);
    verify('No reference, marker or position in any target', targets.length === 4 && targets.every(NO_MARKER), String(targets.length));
    verify('Fill value keeps the placeholder', /\{\{runTag\}\}/.test(recordedText(ERRANDS)) && !/CAW-\d/.test(recordedText(ERRANDS)));
    verify('Recording written: the check run after recording passed', written(ERRANDS));
};

scenario('N1', 'Record via snapshot references and CSS: full names exact, {{runTag}} kept, rows scoped by text; the run passes', async () => {
    await recordErrands();
    const first = await runQuietly(ERRANDS);
    verify('run passes without chat', first.code === 0, `${first.code} ${first.note}`);
    // The server keeps the errands of every run (serve.mjs): only the run tag in the row text tells them apart.
    const second = await runQuietly(ERRANDS);
    verify('run passes again with more equal rows', second.code === 0, `${second.code} ${second.note}`);
});

// ---- N2: the human demonstrates, the crosshair picks

scenario('N2', 'Demonstration (pointerdown, Enter, select, frames, shadow DOM) yields locators; the crosshair hands a locator to caw_selection', async () => {
    const id = 'rec-demo';
    const agent = `A='caw agent'
${planOf('steps:\n  - id: S1\n    name: Speichern\n    do: Speichere.\n    expect: Gespeichert.')}
$A plan --file /tmp/p.yaml > /dev/null
$A click 'button#save'
$A check S1 "document.getElementById('status').textContent==='Saved'"
${finishOf(['S1'])}`;
    const h = humans(async (page) => {
        const app = page.context().pages()[0];
        await showMyself(page);
        await app.locator('#save').click();
        await app.locator('#customer').click();
        await app.locator('#customer').pressSequentially('Meier');
        await app.locator('#customer').press('Enter');
        // A real key press on the closed select changes it (Windows, Linux) and fires a trusted change.
        await app.locator('#kind').focus();
        await app.locator('#kind').press('ArrowDown');
        const payment = app.frameLocator('iframe[title="Payment"]');
        await payment.getByRole('button', { name: 'Pay' }).click();
        await payment.frameLocator('iframe[title="Bank"]').getByRole('button', { name: 'Confirm with TAN' }).click();
        await app.locator('caw-rating').getByRole('button', { name: 'Rate' }).click();
        await page.waitForTimeout(800);
        await page.locator('#toggle').click();
    }, followAndAdopt, followAndAdopt);
    const recorded = await record(native, [id, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N2 recording: Exit 0', recorded === 0, String(recorded));
    const items = lastDemonstration(native, id)?.items ?? [];
    const acts = items.filter(({ action }) => ['click', 'fill', 'press'].includes(action));
    print(`     demonstration: ${acts.map(({ action, target: code, key, value }) => `${action} ${code ?? key}${value === undefined ? '' : `=${value}`}`).join(' | ')}`);
    const find = (action, test) => acts.find((item) => item.action === action && typeof item.target === 'string' && test(item.target));
    verify('Click on a button', find('click', (code) => code === "getByRole('button', { name: 'Save', exact: true })") !== undefined);
    const typed = acts.findIndex((item) => item.action === 'fill' && item.target === "getByRole('textbox', { name: 'Customer', exact: true })" && item.value === 'Meier');
    verify('Typed text as fill, Enter after it', typed !== -1 && acts[typed + 1]?.action === 'press' && acts[typed + 1]?.key === 'Enter', String(typed));
    verify('Select inside its label: combobox by the label without its options, recorded as fill',
        find('fill', (code) => code === "getByRole('combobox', { name: 'Kind', exact: true })")?.value === 'b');
    verify('Click in an iframe through contentFrame()', find('click', (code) => code === `locator('iframe[title="Payment"]').contentFrame().getByRole('button', { name: 'Pay', exact: true })`) !== undefined);
    verify('Click in a nested iframe', find('click', (code) => (code.match(/contentFrame\(\)/g) ?? []).length === 2 && code.includes("'Confirm with TAN'")) !== undefined);
    verify('Click in a shadow root', find('click', (code) => code.includes("name: 'Rate'")) !== undefined);
    verify('Every action has a stable locator, never the marker', acts.every((item) => item.action === 'press' || (typeof item.target === 'string' && NO_MARKER(item.target))), JSON.stringify(acts.filter((item) => item.target === null)));

    // The crosshair after a handover: the picked element goes to caw_selection as a locator.
    const selection = join(native, '.caw/selection.json');
    const picks = [];
    const pick = async (chat, click) => {
        rmSync(selection, { force: true });
        await slash(chat, 'pick');
        await chat.page().waitForTimeout(500);
        await click(appOf(chat.page()));
        const deadline = Date.now() + 20000;
        while (!existsSync(selection) && Date.now() < deadline) await sleep(200);
        picks.push(existsSync(selection) ? JSON.parse(readFileSync(selection, 'utf8')).element : null);
    };
    const p = humans(async (chat) => {
        await benchBack(chat);
        await stateOf(chat, 'developing');
        await pick(chat, (app) => app.locator('caw-rating').getByRole('button', { name: 'Rate' }).click());
        await pick(chat, (app) => app.frameLocator('iframe[title="Payment"]').frameLocator('iframe[title="Bank"]').getByRole('button').click());
        await decide(chat, 'Beenden');
    });
    const opened = await open(native, ['n9-shadow@S2', ...target], { interactive: true, onChatOpen: p.onChatOpen });
    await p.done();
    verify('open for picking: Exit 0', opened === 0, String(opened));
    print(`     picked: ${picks.map((element) => element?.target).join(' | ')}`);
    verify('Pick in a shadow root: locator for caw_selection', picks[0]?.target === "getByRole('group', { name: 'Rating' }).getByRole('button', { name: 'Rate', exact: true })" || picks[0]?.target === "getByRole('button', { name: 'Rate', exact: true })", picks[0]?.target);
    verify('Pick in a nested frame: locator through both frames', (picks[1]?.target?.match(/contentFrame\(\)/g) ?? []).length === 2 && /Confirm with TAN|Confirmed/.test(picks[1]?.target ?? ''), picks[1]?.target);
    verify('Picks carry a label', picks.every((element) => typeof element?.label === 'string' && element.label !== ''));
});

// ---- N3: what replay keeps besides the locators

scenario('N3', 'Kept layers: wait-ready, repeated click, optional click, upload, download, secret remembered value', async () => {
    const { code, note } = await runQuietly('n3-layers');
    verify('n3-layers passes', code === 0, `${code} ${note}`);
    const { result, report, dir } = newestRunOf(native, 'n3-layers');
    verify('Optional click without target is skipped and named', /Optionalen Klick übersprungen/.test(result.results.find(({ id }) => id === 'S2')?.note ?? ''));
    // The secret value (the page always issues 482913) appears in none of the run's text files.
    const texts = readdirSync(dir, { recursive: true }).filter((name) => /\.(md|json|log|txt)$/.test(name)).map((name) => readFileSync(join(dir, name), 'utf8'));
    verify('Secret remembered value in no file of the run', texts.length > 0 && texts.every((text) => !text.includes('482913')) && !report.includes('482913'), String(texts.length));
});

// ---- N4: open at a step's entry, then another test via F1

scenario('N4', 'open <test>@S3: the steps before run, S3 does not; F1 "Öffnen…" opens another test at its entry', async () => {
    const h = humans(async (chat) => {
        const bench = chat.page();
        await benchBack(chat);
        await stateOf(chat, 'developing');
        const app = appOf(bench);
        const state = await app.evaluate(() => [document.getElementById('prices').textContent, document.getElementById('count').textContent, document.getElementById('file-name').textContent].join('|'));
        verify('S1 and S2 ran, S3 did not', state === 'loaded|2|', state);
        await bench.locator('#more').click();
        await bench.locator('#menu [data-states]').click();
        await bench.locator('#stateDlg:not([hidden])').waitFor({ timeout: 10000 });
        await bench.locator('#stests .srow', { hasText: 'n9-shadow' }).click();
        await bench.locator('#ssteps .srow:not(.all)', { hasText: 'S2' }).click();
        verify('F1 explains the entry', /bis zum Einstieg in S2/.test(await bench.locator('#sfoot').textContent()));
        await bench.locator('#sgo').click();
        // The chat asks before it replaces the state.
        await chat.locator('.message:is(.question,.result,.notice)', { hasText: 'bis zum Einstieg in S2 öffnen?' }).waitFor({ timeout: 30000 });
        await decide(chat, 'S2 öffnen');
        await chat.locator('.message', { hasText: 'Einstieg in n9-shadow S2 ist neu hergestellt' }).waitFor({ timeout: 60000 });
        const shadow = await appOf(bench).evaluate(() => `${document.querySelector('caw-rating').shadowRoot.querySelector('[role=status]').textContent}|${document.getElementById('status').textContent}`);
        verify('Other test at its entry: S1 ran, S2 did not', shadow === 'Thanks: Good|', shadow);
        await decide(chat, 'Beenden');
    });
    const code = await open(native, ['n3-layers@S3', ...target], { interactive: true, onChatOpen: h.onChatOpen });
    verify('open @S3: Exit 0, one window', code === 0 && await h.done() === 1, String(code));
});

// ---- N5: record from a step on

// A copy of n9-shadow: its S1 replays first (shadow DOM), S2 is recorded again.
const RANGE = 'rec-range';
scenario('N5', 'record <test>@S2: S2 recorded again after S1 replayed, S1 byte for byte the same', async () => {
    writeTest(native, { ...parseTest(testText(RANGE, TESTS['n9-shadow'])), id: RANGE });
    const before = recordingText(RANGE);
    const agent = `A='caw agent'
${planOf('steps:\n  - id: S2\n    name: "Speichern"\n    do: ""\n    expect: "Gespeichert."')}
$A plan --file /tmp/p.yaml > /dev/null
$A eval "document.querySelector('caw-rating').shadowRoot.querySelector('[role=status]').textContent" > /tmp/s1.txt; echo "S1-REPLAYED=$(grep -c 'Thanks: Good' /tmp/s1.txt)" >> "$CAW_AGENT_DIR/n5.txt"
$A click 'button#save'
$A check S2 "document.getElementById('status').textContent===\\"Saved\\""
${finishOf(['S2'])}`;
    const h = humans(followAndAdopt, followAndAdopt, followAndAdopt);
    const code = await record(native, [`${RANGE}@S2`, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    const after = recordingText(RANGE);
    verify('record @S2: Exit 0', code === 0, String(code));
    verify('S1 byte for byte the same', stepBlock(after, 'S1') !== '' && stepBlock(after, 'S1') === stepBlock(before, 'S1'), stepBlock(after, 'S1').slice(0, 300));
    verify('S2 recorded again', stepBlock(after, 'S2') !== stepBlock(before, 'S2') && stepBlock(after, 'S2').includes("getByRole('button', { name: 'Save', exact: true })"), stepBlock(after, 'S2'));
    const logs = runDirsOf(native, RANGE).map((name) => join(native, '.caw/runs', name, 'agent/n5.txt')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('');
    verify('S1 had replayed before Claude recorded S2', /S1-REPLAYED=1/.test(logs), logs.slice(-300));
    const again = await runQuietly(RANGE);
    verify('run passes afterwards', again.code === 0, `${again.code} ${again.note}`);
});

// ---- N6–N9: replay against what the page does

scenario('N6', 'Dialog transition passes; a true twin fails after the 2 s tolerance with its candidates', async () => {
    const wizard = await runQuietly('n6-wizard');
    verify('Wizard with overlapping dialogs passes', wizard.code === 0, `${wizard.code} ${wizard.note}`);
    const started = Date.now();
    const twins = await runQuietly('n6-twins', ['--step-timeout', '20s']);
    const took = Date.now() - started;
    verify('Twins fail', twins.code === 1, String(twins.code));
    verify('Failure names both candidates', /trifft 2 Elemente/.test(twins.note) && /#1 bei \d+,\d+/.test(twins.note) && /#2 bei \d+,\d+/.test(twins.note), twins.note);
    // With a 20 s step timeout the run would take far longer if it waited for the timeout instead of the 2 s tolerance.
    verify('Fails after the tolerance, not after the step timeout', took < 18000, `${took} ms`);
});

scenario('N7', 'Virtual list: the row is found by scrolling', async () => {
    const { code, note } = await runQuietly('n7-vlist', ['--step-timeout', '20s']);
    verify('Row 150 of a virtual list: passes', code === 0, `${code} ${note}`);
});

scenario('N8', 'Nested frames pass; a missing frame is explained', async () => {
    const frames = await runQuietly('n8-frames');
    verify('Field and buttons in a frame and in a frame inside it: passes', frames.code === 0, `${frames.code} ${frames.note}`);
    const missing = await runQuietly('n8-missing-frame');
    verify('Missing frame: fails and names the frame', missing.code === 1 && /Der Frame iframe "Refunds" fehlt auf der Seite/.test(missing.note), missing.note);
});

scenario('N9', 'Shadow DOM: field and button inside a web component', async () => {
    const { code, note } = await runQuietly('n9-shadow');
    verify('n9-shadow passes', code === 0, `${code} ${note}`);
});

// ---- N10: ExtJS, components as extjs= locators

// A project of its own with framework extjs, on the same server: native/site/ext.html is a fake ExtJS Modern application whose
// buttons are an empty <button> and whose ids change on every load.
const extRoot = join(native, 'ext');
const EXT = 'rec-ext';
const EXT_PLAN = `notes: Weiter und Abbrechen im Anliegen.
steps:
  - id: S1
    name: Weiter
    do: Klicke auf Weiter.
    expect: Weiter ist geklickt.
  - id: S2
    name: Abbrechen
    do: Brich ab.
    expect: Abgebrochen.`;
const setCover = (on) => fetch(`http://127.0.0.1:${PORT}/api/cover?on=${on ? 1 : 0}`, { method: 'POST' });

scenario('N10', 'ExtJS: empty Modern buttons recorded as extjs= components (text, itemId), replayed with new ids; a message box over them is named by its title', async () => {
    rmSync(join(extRoot, '.caw'), { recursive: true, force: true });
    rmSync(join(extRoot, 'caw'), { recursive: true, force: true });
    mkdirSync(join(extRoot, 'caw/tests'), { recursive: true });
    writeFileSync(join(extRoot, 'caw/tests', `${EXT}.yaml`), `id: ${EXT}\nstart: /ext.html\nenvironments: [test]\nwrites: false\n${EXT_PLAN}\n`);
    await setCover(false);
    const agent = `A='caw agent'
${planOf(EXT_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
$A click '.x-formpanel > div:first-child > button'
$A check S1 "document.getElementById('status').textContent==='Weiter geklickt'"
$A click '.x-formpanel > div:last-child > button'
$A check S2 "document.getElementById('status').textContent==='Abgebrochen'"
${finishOf(['S1', 'S2'])}`;
    const h = humans(followAndAdopt, followAndAdopt, followAndAdopt);
    const code = await record(extRoot, [EXT, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N10 recording: Exit 0', code === 0, String(code));
    const recorded = existsSync(join(extRoot, 'caw/recordings', `${EXT}.yaml`));
    verify('Recording written: the check run after recording passed', recorded);
    const targets = recorded ? loadTest(extRoot, EXT).steps.flatMap((step) => (step.recording?.actions ?? []).map(({ target: code2 }) => code2).filter(Boolean)) : [];
    print(`     targets: ${targets.join(' | ')}`);
    verify('Empty button by its component\'s text', targets[0] === 'locator(\'extjs=button[text="Weiter"]\').locator(\'button\')', targets[0]);
    verify('Empty button by its component\'s itemId', targets[1] === 'locator(\'extjs=button[itemId="abortButton"]\').locator(\'button\')', targets[1]);
    verify('No generated id in any target', targets.length === 2 && targets.every((code2) => !/#ext-|ext-\w+-\d/.test(code2)), String(targets.length));
    const quiet = async () => {
        const exit = await run(extRoot, [EXT, ...target]).catch((error) => `error ${error.code}: ${error.message}`);
        const { result } = newestRunOf(extRoot, EXT);
        return { exit, note: (result?.results ?? []).find(({ status }) => status === 'fail')?.note ?? '' };
    };
    const again = await quiet();
    verify('Run passes with new ids', again.exit === 0, `${again.exit} ${again.note}`);
    await setCover(true);
    try {
        const covered = await quiet();
        verify('Covered by a message box: fails and names it by its title', covered.exit === 1 && /verdeckt von dialog "Hinweis"/.test(covered.note), covered.note);
    } finally {
        await setCover(false);
    }
});

// ---- N10b, N10c: ExtJS input components (native/site/ext-data.html, app extdata of the ext project)

// Comboboxes whose list floats at the end of the body, fields disabled until the one before has a selection, a grid with repeated
// cells, pickers named only by a heading beside them, icon-only remove buttons, a message box above a dialog.
const EXT_DATA = 'rec-ext-data';
const EXT_DEMO = 'rec-ext-demo';
const GENERATED = /#ext-|ext-\w+-\d/;
const entry = (text) => `.x-boundlist:visible .x-simplelistitem:has(> .x-list-label:text-is("${text}"))`;
const PICKER = '.x-auswahl:has-text("Zielgruppe*")';
// The recorded shapes (extjs-query.mjs): list entries by their whole text, a row by the shortest cell no other row has, the
// picker by the heading beside it, the icon button by iconCls, everything in a dialog or message box scoped by its title.
const SHAPES = {
    sonstiges: "locator('extjs=boundlist simplelistitem').filter({ hasText: /^Sonstiges$/ })",
    row: "locator('extjs=grid gridrow').filter({ hasText: '9000001' })",
    picker: "locator('extjs=auswahl').filter({ has: getByText('Zielgruppe*', { exact: true }) })",
    trash: "locator('extjs=list listitem').filter({ hasText: /^Ärzte$/ }).locator('extjs=button[iconCls=\"x-fa fa-trash\"]').locator('button')",
    pruefen: "locator('extjs=dialog[title=\"Termin anlegen\"]').locator('extjs=button[text=\"Prüfen\"]').locator('button')",
    ja: "locator('extjs=messagebox[title=\"Fenster Schließen\"]').locator('extjs=button[text=\"Ja\"]').locator('button')",
    abbrechen: "locator('extjs=dialog[title=\"Termin anlegen\"]').locator('extjs=button[text=\"Abbrechen\"]').locator('button')",
};
const DATA_DONE = "document.body.dataset.bereich==='Sonstiges' && document.body.dataset.unterbereich==='Beschwerde' && document.querySelector('.x-textfield input').value==='Rueckfrage' && document.body.dataset.zeile==='9000001' && document.body.dataset.zielgruppe==='Psychotherapeuten' && document.body.dataset.geprueft==='ja' && document.body.dataset.termin==='abgebrochen'";
/** Removes what an earlier e2e run left of a test in the ext project: its files, its runs and demonstrations. */
const freshExt = (id) => {
    mkdirSync(join(extRoot, 'caw/tests'), { recursive: true });
    rmSync(join(extRoot, 'caw/tests', `${id}.yaml`), { force: true });
    rmSync(join(extRoot, 'caw/recordings', `${id}.yaml`), { force: true });
    const runs = join(extRoot, '.caw/runs');
    for (const name of existsSync(runs) ? readdirSync(runs) : []) if (name.endsWith(`Z-${id}`) || name.endsWith(`Z-${id}-demonstration`)) rmSync(join(runs, name), { recursive: true, force: true });
};
/** Every target of an ext test's recording; without a written recording (the check run failed) those of the newest draft. */
const extTargets = (id) => {
    const runs = join(extRoot, '.caw/runs');
    const draft = existsSync(runs) ? readdirSync(runs).filter((name) => name.endsWith(`Z-${id}`) && existsSync(join(runs, name, 'test-draft.yaml'))).sort().at(-1) : undefined;
    let steps = [];
    if (existsSync(join(extRoot, 'caw/recordings', `${id}.yaml`))) steps = loadTest(extRoot, id).steps;
    else if (draft !== undefined) steps = parseTest(readFileSync(join(runs, draft, 'test-draft.yaml'), 'utf8')).steps;
    return steps.flatMap((step) => (step.recording?.actions ?? []).map(({ target: code }) => code).filter(Boolean));
};
/** A run of an ext test without chat (each load gives new ids): exit code and the failure note. */
const quietExt = async (id) => {
    const exit = await run(extRoot, [id, ...target]).catch((error) => `error ${error.code}: ${error.message}`);
    const { result } = newestRunOf(extRoot, id);
    return { exit, note: (result?.results ?? []).find(({ status }) => status === 'fail')?.note ?? '' };
};

const EXT_DATA_PLAN = `notes: Ein Anliegen mit Auswahllisten, Tabelle, Auswahl und Dialog.
steps:
  - id: S1
    name: Bereich
    do: Waehle den Bereich Sonstiges ueber die gefilterte Liste.
    expect: Bereich Sonstiges ist gewaehlt.
  - id: S2
    name: Unterbereich und Betreff
    do: Gib den Unterbereich Beschwerde ein und fuelle den Betreff.
    expect: Unterbereich und Betreff sind gesetzt.
  - id: S3
    name: Zeile
    do: Waehle die Zeile 9000001.
    expect: Zeile 9000001 ist gewaehlt.
  - id: S4
    name: Zielgruppe
    do: Fuege Psychotherapeuten hinzu und entferne Aerzte.
    expect: Nur Psychotherapeuten ist Zielgruppe.
  - id: S5
    name: Termin
    do: Pruefe den Termin, bestaetige mit Ja und brich den Dialog ab.
    expect: Der Termin ist geprueft und abgebrochen.`;

scenario('N10b', 'ExtJS input components (Claude): filtered floating list, disabled fields, grid row, picker by heading, icon button, stacked dialogs; replayed with new ids', async () => {
    freshExt(EXT_DATA);
    writeFileSync(join(extRoot, 'caw/tests', `${EXT_DATA}.yaml`), `id: ${EXT_DATA}\nenvironments: [test]\nwrites: false\n${EXT_DATA_PLAN}\n`);
    // Betreff is disabled until Unterbereich is left with an entry: fill on it has to leave Unterbereich first (leaveForDisabled).
    // The filter typed into Bereich must keep its list open for the click on the entry.
    const agent = `A='caw agent'
${planOf(EXT_DATA_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
$A type 'input[placeholder="Bereich*"]' 'Sons'
$A click '${entry('Sonstiges')}'
$A check S1 "document.body.dataset.bereich==='Sonstiges'"
$A type 'input[placeholder="Unterbereich*"]' 'Beschwerde'
$A fill '.x-textfield input' 'Rueckfrage'
$A check S2 "document.body.dataset.unterbereich==='Beschwerde' && document.querySelector('.x-textfield input').value==='Rueckfrage'"
$A click '.x-gridrow:has-text("9000001")'
$A check S3 "document.body.dataset.zeile==='9000001'"
$A click '${PICKER} .x-expandtrigger'
$A click '${entry('Psychotherapeuten')}'
$A click '${PICKER} .x-button:has-text("Hinzufügen") button'
$A click '${PICKER} .x-listitem:has-text("Ärzte") button'
$A check S4 "document.body.dataset.zielgruppe==='Psychotherapeuten'"
$A click '.x-button:has(> .x-button-label:text-is("Termin")) button'
$A click '.x-dialog .x-button:has-text("Prüfen") button'
$A click '.x-messagebox .x-button:has(> .x-button-label:text-is("Ja")) button'
$A click '.x-dialog .x-button:has-text("Abbrechen") button'
$A check S5 "document.body.dataset.geprueft==='ja' && document.body.dataset.termin==='abgebrochen'"
${finishOf(['S1', 'S2', 'S3', 'S4', 'S5'])}`;
    const h = humans(followAndAdopt, followAndAdopt, followAndAdopt);
    const code = await record(extRoot, [EXT_DATA, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N10b recording: Exit 0', code === 0, String(code));
    verify('Recording written: the check run after recording passed', existsSync(join(extRoot, 'caw/recordings', `${EXT_DATA}.yaml`)));
    const targets = extTargets(EXT_DATA);
    print(`     targets: ${targets.join(' | ')}`);
    verify('All 13 actions recorded', targets.length === 13, String(targets.length));
    verify('Bereich by its placeholder', targets[0] === "getByRole('combobox', { name: 'Bereich*', exact: true })", targets[0]);
    verify('List entry by its whole text, not "Sonstiges Weiteres"', targets[1] === SHAPES.sonstiges, targets[1]);
    verify('Betreff by its label', targets[3] === "getByRole('textbox', { name: 'Betreff', exact: true })", targets[3]);
    verify('Grid row by the cell no other row has', targets[4] === SHAPES.row, targets[4]);
    verify('Expand trigger in the picker named by its heading', targets[5] === `${SHAPES.picker}.locator('extjs=expandtrigger')`, targets[5]);
    verify('Entry of the picker\'s floating list by its text', targets[6] === "locator('extjs=boundlist simplelistitem').filter({ hasText: /^Psychotherapeuten$/ })", targets[6]);
    verify('Hinzufügen (twice on the page) in the picker named by its heading', targets[7] === `${SHAPES.picker}.locator('extjs=button[text="Hinzufügen"]').locator('button')`, targets[7]);
    verify('Icon-only remove button by iconCls in its list entry', targets[8] === SHAPES.trash, targets[8]);
    verify('Prüfen scoped by its dialog', targets[10] === SHAPES.pruefen, targets[10]);
    verify('Ja in the message box by its text, not the generic itemId', targets[11] === SHAPES.ja, targets[11]);
    verify('Abbrechen of the dialog scoped by it (the page has one too)', targets[12] === SHAPES.abbrechen, targets[12]);
    verify('No generated id, marker or position in any target', targets.length > 0 && targets.every((code2) => !GENERATED.test(code2) && NO_MARKER(code2)), targets.filter((code2) => GENERATED.test(code2) || !NO_MARKER(code2)).join(' | '));
    for (const attempt of [1, 2]) {
        const again = await quietExt(EXT_DATA);
        verify(`Headless run ${attempt} passes with new ids`, again.exit === 0, `${again.exit} ${again.note}`);
    }
});

scenario('N10c', 'ExtJS input components (human): the demonstration records list entries, grid row, icon button and dialog buttons stably, no fill after a list selection; the recording replays', async () => {
    freshExt(EXT_DEMO);
    // The human's demonstration comes first (a new test, as in N2). The scripted agent then does exactly what was demonstrated,
    // with the demonstrated locators, as Claude would, and the check run replays what it recorded.
    const replay = `const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const items = JSON.parse(readFileSync('/tmp/task.json', 'utf8')).demonstration || [];
for (const item of items) {
    const args = item.action === 'click' ? ['click', item.target] : item.action === 'fill' ? ['fill', item.target, item.value] : item.action === 'press' ? ['press', item.key] : null;
    if (args === null || typeof args[1] !== 'string') { console.log('SKIP ' + JSON.stringify(item)); continue; }
    console.log('DO ' + args.join(' '));
    execFileSync('caw', ['agent', ...args], { stdio: 'inherit' });
}`;
    const agent = `A='caw agent'
${planOf(`steps:\n  - id: S1\n    name: Anliegen\n    do: Fuehre die Vorfuehrung aus.\n    expect: Anliegen erfasst, Termin geprueft und abgebrochen.`)}
$A plan --file /tmp/p.yaml > /dev/null
$A task > /tmp/task.json
cat > /tmp/replay.cjs <<'EOF'
${replay}
EOF
node /tmp/replay.cjs >> "$CAW_AGENT_DIR/n10c.txt" 2>&1; echo "REPLAY-EXIT=$?" >> "$CAW_AGENT_DIR/n10c.txt"
$A check S1 "${DATA_DONE}"
${finishOf(['S1'])}`;
    const h = humans(async (page) => {
        const app = page.context().pages()[0];
        await showMyself(page);
        // Pointer down and up like a person: a dialog closed by the click is only gone after the pointer is up again.
        const human = { delay: 80 };
        const bereich = app.locator('input[placeholder="Bereich*"]');
        await bereich.click(human);
        await bereich.pressSequentially('Sons', { delay: 40 });
        await app.locator(entry('Sonstiges')).click(human);
        // The open list covers Betreff: the human leaves Unterbereich with Tab, which takes the typed entry.
        const unterbereich = app.locator('input[placeholder="Unterbereich*"]');
        await unterbereich.click(human);
        await unterbereich.pressSequentially('Beschwerde', { delay: 40 });
        await unterbereich.press('Tab');
        const betreff = app.locator('.x-textfield input');
        await betreff.click(human);
        await betreff.pressSequentially('Rueckfrage', { delay: 40 });
        await app.locator('.x-gridrow:has-text("9000001")').click(human);
        await app.locator(`${PICKER} .x-expandtrigger`).click(human);
        await app.locator(entry('Psychotherapeuten')).click(human);
        await app.locator(`${PICKER} .x-button:has-text("Hinzufügen") button`).click(human);
        await app.locator(`${PICKER} .x-listitem:has-text("Ärzte") button`).click(human);
        await app.locator('.x-button:has(> .x-button-label:text-is("Termin")) button').click(human);
        await app.locator('.x-dialog .x-button:has-text("Prüfen") button').click(human);
        await app.locator('.x-messagebox .x-button:has(> .x-button-label:text-is("Ja")) button').click(human);
        await app.locator('.x-dialog .x-button:has-text("Abbrechen") button').click(human);
        const state = await app.evaluate(DATA_DONE);
        verify('Demonstrated flow reached its end in the application', state === true, String(state));
        await page.waitForTimeout(800);
        await page.locator('#toggle').click();
    }, followAndAdopt, followAndAdopt);
    const code = await record(extRoot, [EXT_DEMO, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N10c recording: Exit 0', code === 0, String(code));
    const acts = (lastDemonstration(extRoot, EXT_DEMO)?.items ?? []).filter(({ action }) => ['click', 'fill', 'press'].includes(action));
    print(`     demonstration: ${acts.map(({ action, target: code2, key, value }) => `${action} ${code2 ?? key}${value === undefined ? '' : `=${value}`}`).join(' | ')}`);
    const clicks = acts.filter(({ action }) => action === 'click').map(({ target: code2 }) => code2);
    const fills = acts.filter(({ action }) => action === 'fill');
    verify('List entry by its whole text', clicks.includes(SHAPES.sonstiges));
    verify('Grid row by the cell no other row has', clicks.some((code2) => typeof code2 === 'string' && code2.startsWith(SHAPES.row)));
    verify('Icon-only remove button by iconCls', clicks.includes(SHAPES.trash));
    verify('Prüfen scoped by its dialog', clicks.includes(SHAPES.pruefen));
    verify('Ja (message box hidden by the click) from the chain found at the pointerdown', clicks.includes(SHAPES.ja));
    verify('Abbrechen (dialog destroyed by the click) scoped by its dialog', clicks.includes(SHAPES.abbrechen));
    verify('Typed text as fill: the filter, the full Unterbereich, Betreff; no fill after a list selection',
        JSON.stringify(fills.map(({ value }) => value)) === JSON.stringify(['Sons', 'Beschwerde', 'Rueckfrage']), JSON.stringify(fills.map(({ target: code2, value }) => `${code2}=${value}`)));
    verify('Every action has a stable locator: no generated id, marker or position', acts.length > 0 && acts.every((item) => item.action === 'press' || (typeof item.target === 'string' && NO_MARKER(item.target) && !GENERATED.test(item.target))),
        JSON.stringify(acts.filter((item) => item.action !== 'press' && (typeof item.target !== 'string' || !NO_MARKER(item.target) || GENERATED.test(item.target)))));
    const replayLog = runDirsOf(extRoot, EXT_DEMO).map((name) => join(extRoot, '.caw/runs', name, 'agent/n10c.txt')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('');
    verify('The agent replayed every demonstrated action', /REPLAY-EXIT=0/.test(replayLog) && !/SKIP /.test(replayLog), replayLog.slice(-600));
    verify('Recording written: the check run after recording replayed it', existsSync(join(extRoot, 'caw/recordings', `${EXT_DEMO}.yaml`)));
    const recorded = extTargets(EXT_DEMO);
    print(`     recorded: ${recorded.join(' | ')}`);
    verify('The recording uses the demonstrated locators', recorded.length > 0 && recorded.every((code2) => acts.some((item) => item.target === code2)), recorded.filter((code2) => !acts.some((item) => item.target === code2)).join(' | '));
    const again = await quietExt(EXT_DEMO);
    verify('Headless run passes with new ids', again.exit === 0, `${again.exit} ${again.note}`);
});

// ---- N10d, N10e: the generic recording rules on plain HTML with ARIA (native/site/aria.html, app aria of the native project)

// No framework: a native <dialog> named only by its heading, an ARIA dialog named by aria-labelledby and one whose title carries a
// record number, each with a "Speichern" like the page's own; a grid whose rows repeat their first cell; a combobox whose options
// are rendered at the end of the body; unlabelled fields in named groups. Every id differs on each load.
const ARIA = 'rec-aria';
const ARIA_DEMO = 'rec-aria-demo';
// One application per project: a new recording begins at the start path, so the demonstration on aria.html has a project of its own.
const ariaRoot = join(native, 'aria');
const SAVE = "getByRole('button', { name: 'Speichern', exact: true })";
// The recorded shapes (record-locator.mjs, accessible-name.mjs): a row by the cells only it has, everything in a dialog scoped by
// it (by the beginning of its name when the name holds a record number), an option by role and name, an unnamed field by its group.
const ARIA_SHAPES = {
    notizAnlegen: "getByRole('button', { name: 'Notiz anlegen', exact: true })",
    notiz: "getByRole('textbox', { name: 'Notiz', exact: true })",
    vermerkAnlegen: "getByRole('button', { name: 'Vermerk anlegen', exact: true })",
    vermerk: `getByRole('dialog', { name: 'Vermerk anlegen', exact: true }).${SAVE}`,
    oeffnen: "getByRole('row').filter({ hasText: '1000001' }).filter({ hasText: 'Beispiel, Max' }).getByRole('button', { name: 'Öffnen', exact: true })",
    vorgang: `getByRole('dialog', { name: /^Vorgang/ }).${SAVE}`,
    schliessen: "getByRole('dialog', { name: /^Vorgang/ }).getByRole('button', { name: 'Schließen', exact: true })",
    sachgebiet: "getByRole('combobox', { name: 'Sachgebiet', exact: true })",
    beitrag: "getByRole('option', { name: 'Beitrag', exact: true })",
    rechnung: "getByRole('group', { name: 'Rechnungsadresse', exact: true }).getByRole('textbox')",
    verwaltung: "getByRole('group', { name: 'Ansprechpartner Verwaltung', exact: true }).getByRole('textbox')",
    seite: SAVE,
};
// The native <dialog> has no accessible name for Playwright (none from its heading): its "Speichern" is scoped by a dialog, never
// by the page's own or an id.
const NATIVE_SAVE = /^getByRole\('dialog'(, \{ [^)]*\})?\)\.getByRole\('button', \{ name: 'Speichern', exact: true \}\)$/;
// What a per-load id or a position looks like in a target: neither holds on the next load.
const ARIA_UNSTABLE = (code) => /#[a-z]\d[a-z]\d|locator\('#|\[id=/.test(code) || !NO_MARKER(code);
const ARIA_DONE = "document.body.dataset.notiz==='Rueckruf' && document.body.dataset.vermerk==='gespeichert' && document.body.dataset.vorgang==='1000001 Beispiel, Max' && document.body.dataset.geschlossen==='ja' && document.body.dataset.sachgebiet==='Beitrag' && document.body.dataset.rechnung==='Musterstadt' && document.body.dataset.verwaltung==='Beispiel, Max' && document.body.dataset.seite==='gespeichert'";
const ARIA_PLAN = `notes: Ein Vorgang mit Dialogen, Tabelle, Auswahlliste und Adressgruppen.
steps:
  - id: S1
    name: Notiz
    do: Lege die Notiz Rueckruf an und speichere sie im Dialog.
    expect: Die Notiz ist gespeichert.
  - id: S2
    name: Vermerk
    do: Lege einen Vermerk an und speichere ihn im Dialog.
    expect: Der Vermerk ist gespeichert.
  - id: S3
    name: Vorgang
    do: Oeffne den Vorgang 1000001 von Beispiel, Max, speichere und schliesse ihn.
    expect: Der Vorgang ist gespeichert und geschlossen.
  - id: S4
    name: Sachgebiet
    do: Waehle das Sachgebiet Beitrag ueber die Auswahlliste.
    expect: Sachgebiet Beitrag ist gewaehlt.
  - id: S5
    name: Adressen
    do: Trage den Ort der Rechnungsadresse und den Ansprechpartner der Verwaltung ein.
    expect: Beide sind gesetzt.
  - id: S6
    name: Seite
    do: Speichere die Seite.
    expect: Die Seite ist gespeichert.`;
/** Removes what an earlier e2e run left of a test in the native project (or another root): its files, its runs and demonstrations. */
const freshNative = (id, root = native) => {
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    rmSync(join(root, 'caw/tests', `${id}.yaml`), { force: true });
    rmSync(join(root, 'caw/recordings', `${id}.yaml`), { force: true });
    const runs = join(root, '.caw/runs');
    for (const name of existsSync(runs) ? readdirSync(runs) : []) if (name.endsWith(`Z-${id}`) || name.endsWith(`Z-${id}-demonstration`)) rmSync(join(runs, name), { recursive: true, force: true });
};

scenario('N10d', 'Plain ARIA (Claude): buttons in named dialogs scoped by them (record number as prefix), grid row by its unique cells, option of a portal list, unnamed fields by their group; replayed with new ids', async () => {
    freshNative(ARIA);
    writeFileSync(join(native, 'caw/tests', `${ARIA}.yaml`), `id: ${ARIA}\nstart: /aria.html\nenvironments: [test]\nwrites: false\n${ARIA_PLAN}\n`);
    // CSS targets as Claude might write them; the recording names each element by role, name and context instead.
    const agent = `A='caw agent'
${planOf(ARIA_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
$A click 'section[aria-label="Notizen"] button:text-is("Notiz anlegen")'
$A fill 'dialog input' 'Rueckruf'
$A click 'dialog button:text-is("Speichern")'
$A check S1 "document.body.dataset.notiz==='Rueckruf'"
$A click 'section[aria-label="Notizen"] button:text-is("Vermerk anlegen")'
$A click '.fenster button:text-is("Speichern")'
$A check S2 "document.body.dataset.vermerk==='gespeichert'"
$A click '[role=row]:has-text("1000001"):has-text("Beispiel, Max") button'
$A click '.vorgang button:text-is("Speichern")'
$A click '.vorgang button:text-is("Schließen")'
$A check S3 "document.body.dataset.vorgang==='1000001 Beispiel, Max' && document.body.dataset.geschlossen==='ja'"
$A type '[role=combobox]' 'Bei'
$A click '.liste [role=option]:text-is("Beitrag")'
$A check S4 "document.body.dataset.sachgebiet==='Beitrag'"
$A fill 'fieldset:nth-of-type(2) input' 'Musterstadt'
$A fill '[aria-label="Ansprechpartner Verwaltung"] input' 'Beispiel, Max'
$A check S5 "document.body.dataset.rechnung==='Musterstadt' && document.body.dataset.verwaltung==='Beispiel, Max'"
$A click 'section[aria-label="Notizen"] button:text-is("Speichern")'
$A check S6 "document.body.dataset.seite==='gespeichert'"
${finishOf(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'])}`;
    const h = humans(followAndAdopt, followAndAdopt, followAndAdopt);
    const code = await record(native, [ARIA, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N10d recording: Exit 0', code === 0, String(code));
    verify('Recording written: the check run after recording passed', written(ARIA));
    const targets = targetsOf(ARIA);
    print(`     targets: ${targets.join(' | ')}`);
    verify('All 13 actions recorded', targets.length === 13, String(targets.length));
    verify('Notiz anlegen by role and name', targets[0] === ARIA_SHAPES.notizAnlegen, targets[0]);
    verify('Field in the native dialog by its label', targets[1] === ARIA_SHAPES.notiz, targets[1]);
    verify('Speichern of the native <dialog> scoped by a dialog, not the page\'s, no id', NATIVE_SAVE.test(targets[2] ?? ''), targets[2]);
    verify('Vermerk anlegen by role and name', targets[3] === ARIA_SHAPES.vermerkAnlegen, targets[3]);
    verify('Speichern of the ARIA dialog scoped by its exact name', targets[4] === ARIA_SHAPES.vermerk, targets[4]);
    verify('Öffnen in the row by its two cells no other row has together, not by position', targets[5] === ARIA_SHAPES.oeffnen, targets[5]);
    verify('Speichern in the dialog with a record number: only the beginning of its name', targets[6] === ARIA_SHAPES.vorgang, targets[6]);
    verify('Schließen in the dialog with a record number: only the beginning of its name', targets[7] === ARIA_SHAPES.schliessen, targets[7]);
    verify('Combobox by its label', targets[8] === ARIA_SHAPES.sachgebiet, targets[8]);
    verify('Option of the list at the end of the body by role and name', targets[9] === ARIA_SHAPES.beitrag, targets[9]);
    verify('Unlabelled field by its fieldset', targets[10] === ARIA_SHAPES.rechnung, targets[10]);
    verify('Unlabelled field by its role=group', targets[11] === ARIA_SHAPES.verwaltung, targets[11]);
    verify('The page\'s own Speichern unscoped', targets[12] === ARIA_SHAPES.seite, targets[12]);
    verify('No id, marker or position in any target', targets.length > 0 && targets.every((code2) => !ARIA_UNSTABLE(code2)), targets.filter(ARIA_UNSTABLE).join(' | '));
    for (const attempt of [1, 2]) {
        const again = await runQuietly(ARIA);
        verify(`Headless run ${attempt} passes with new ids`, again.code === 0, `${again.code} ${again.note}`);
    }
});

scenario('N10e', 'Plain ARIA (human): the demonstration records dialog buttons, grid row, portal option and grouped fields stably; the recording replays', async () => {
    freshNative(ARIA_DEMO, ariaRoot);
    // As N10c: the human's demonstration comes first, the scripted agent then does exactly what was demonstrated, with the
    // demonstrated locators, and the check run replays what it recorded.
    const replay = `const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const items = JSON.parse(readFileSync('/tmp/task.json', 'utf8')).demonstration || [];
for (const item of items) {
    const args = item.action === 'click' ? ['click', item.target] : item.action === 'fill' ? ['fill', item.target, item.value] : item.action === 'press' ? ['press', item.key] : null;
    if (args === null || typeof args[1] !== 'string') { console.log('SKIP ' + JSON.stringify(item)); continue; }
    console.log('DO ' + args.join(' '));
    execFileSync('caw', ['agent', ...args], { stdio: 'inherit' });
}`;
    const agent = `A='caw agent'
${planOf(`steps:\n  - id: S1\n    name: Vorgang\n    do: Fuehre die Vorfuehrung aus.\n    expect: Notiz, Vermerk, Vorgang, Sachgebiet, Adressen und Seite gespeichert.`)}
$A plan --file /tmp/p.yaml > /dev/null
$A task > /tmp/task.json
cat > /tmp/replay.cjs <<'EOF'
${replay}
EOF
node /tmp/replay.cjs >> "$CAW_AGENT_DIR/n10e.txt" 2>&1; echo "REPLAY-EXIT=$?" >> "$CAW_AGENT_DIR/n10e.txt"
$A check S1 "${ARIA_DONE}"
${finishOf(['S1'])}`;
    const h = humans(async (page) => {
        const app = page.context().pages()[0];
        await showMyself(page);
        // Pointer down and up like a person: a dialog closed by the click is only gone after the pointer is up again.
        const human = { delay: 80 };
        const typeInto = async (field, text) => {
            await field.click(human);
            await field.pressSequentially(text, { delay: 40 });
        };
        await app.getByRole('button', { name: 'Notiz anlegen' }).click(human);
        await typeInto(app.locator('dialog input'), 'Rueckruf');
        await app.locator('dialog button').click(human);
        await app.getByRole('button', { name: 'Vermerk anlegen' }).click(human);
        await app.locator('.fenster button').click(human);
        await app.locator('[role=row]:has-text("1000001"):has-text("Beispiel, Max") button').click(human);
        await app.locator('.vorgang button:text-is("Speichern")').click(human);
        await app.locator('.vorgang button:text-is("Schließen")').click(human);
        await typeInto(app.getByRole('combobox'), 'Bei');
        await app.locator('.liste [role=option]:text-is("Beitrag")').click(human);
        await typeInto(app.locator('fieldset:nth-of-type(2) input'), 'Musterstadt');
        await typeInto(app.locator('[aria-label="Ansprechpartner Verwaltung"] input'), 'Beispiel, Max');
        await app.locator('section[aria-label="Notizen"] button:text-is("Speichern")').click(human);
        const state = await app.evaluate(ARIA_DONE);
        verify('Demonstrated flow reached its end in the application', state === true, String(state));
        await page.waitForTimeout(800);
        await page.locator('#toggle').click();
    }, followAndAdopt, followAndAdopt);
    const code = await record(ariaRoot, [ARIA_DEMO, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
    await h.done();
    verify('N10e recording: Exit 0', code === 0, String(code));
    const acts = (lastDemonstration(ariaRoot, ARIA_DEMO)?.items ?? []).filter(({ action }) => ['click', 'fill', 'press'].includes(action));
    print(`     demonstration: ${acts.map(({ action, target: code2, key, value }) => `${action} ${code2 ?? key}${value === undefined ? '' : `=${value}`}`).join(' | ')}`);
    const clicks = acts.filter(({ action }) => action === 'click').map(({ target: code2 }) => code2);
    const fills = acts.filter(({ action }) => action === 'fill');
    // The first Speichern is the native <dialog>'s: Playwright knows no name for it, a name from its heading finds nothing.
    const nativeSave = clicks.find((code2) => /Speichern/.test(code2 ?? '')) ?? '';
    verify('Speichern of the native <dialog> (closed by the click) scoped by a dialog Playwright finds', NATIVE_SAVE.test(nativeSave) && !nativeSave.includes("'dialog', { name: 'Notiz anlegen'"), nativeSave);
    verify('Speichern of the ARIA dialog (closed by the click) scoped by its exact name', clicks.includes(ARIA_SHAPES.vermerk));
    verify('Öffnen in the row by its unique cells', clicks.includes(ARIA_SHAPES.oeffnen));
    verify('Speichern in the dialog with a record number: only the beginning of its name', clicks.includes(ARIA_SHAPES.vorgang));
    verify('Schließen (dialog removed by the click) by the beginning of the dialog\'s name', clicks.includes(ARIA_SHAPES.schliessen), clicks.filter((code2) => /Schließen/.test(code2 ?? '')).join(' | '));
    verify('Option (list removed by the click) by role and name from the pointerdown', clicks.includes(ARIA_SHAPES.beitrag));
    verify('The page\'s own Speichern unscoped', clicks.includes(ARIA_SHAPES.seite));
    verify('Unlabelled fields by their group', fills.some(({ target: code2 }) => code2 === ARIA_SHAPES.rechnung) && fills.some(({ target: code2 }) => code2 === ARIA_SHAPES.verwaltung),
        JSON.stringify(fills.map(({ target: code2 }) => code2)));
    verify('Typed text as fill: Notiz, the filter, both fields; no fill after the list selection',
        JSON.stringify(fills.map(({ value }) => value)) === JSON.stringify(['Rueckruf', 'Bei', 'Musterstadt', 'Beispiel, Max']), JSON.stringify(fills.map(({ target: code2, value }) => `${code2}=${value}`)));
    verify('Every action has a stable locator: no id, marker or position', acts.length > 0 && acts.every((item) => item.action === 'press' || (typeof item.target === 'string' && !ARIA_UNSTABLE(item.target))),
        JSON.stringify(acts.filter((item) => item.action !== 'press' && (typeof item.target !== 'string' || ARIA_UNSTABLE(item.target)))));
    const replayLog = runDirsOf(ariaRoot, ARIA_DEMO).map((name) => join(ariaRoot, '.caw/runs', name, 'agent/n10e.txt')).filter(existsSync).map((path) => readFileSync(path, 'utf8')).join('');
    verify('The agent replayed every demonstrated action', /REPLAY-EXIT=0/.test(replayLog) && !/SKIP /.test(replayLog), replayLog.slice(-600));
    verify('Recording written: the check run after recording replayed it', written(ARIA_DEMO, ariaRoot));
    const recorded = targetsOf(ARIA_DEMO, ariaRoot);
    print(`     recorded: ${recorded.join(' | ')}`);
    verify('The recording uses the demonstrated locators', recorded.length > 0 && recorded.every((code2) => acts.some((item) => item.target === code2)), recorded.filter((code2) => !acts.some((item) => item.target === code2)).join(' | '));
    const again = await runQuietly(ARIA_DEMO, [], ariaRoot);
    verify('Headless run passes with new ids', again.code === 0, `${again.code} ${again.note}`);
});

// ---- N11: failures and what the human gets offered

scenario('N11', 'Failures: renamed (similar name), covered (diagnosis with the message), repair offered in the chat', async () => {
    const renamed = await runQuietly('n11-renamed');
    verify('Renamed: fails, similar name offered', renamed.code === 1 && /Es fehlt auf der Seite\. Ähnlich: button "Archive all"/.test(renamed.note), renamed.note);
    const covered = await runQuietly('n11-covered');
    verify('Covered: fails, names the cover and its message', covered.code === 1 && /verdeckt von dialog/.test(covered.note) && /"Session expired\."/.test(covered.note), covered.note);
    let dockerUsed = 0;
    const docker = { get label() { dockerUsed += 1; return 'spy'; } };
    const h = humans(async (page) => {
        await page.locator('.message:is(.question,.result,.notice)', { hasText: 'S1 ist gescheitert' }).waitFor({ timeout: 60000 });
        const text = await page.locator('.message:is(.question,.result,.notice)').last().textContent();
        verify('Chat: the failed step with its locator label and the similar name', /button "Archive"/.test(text) && /Archive all/.test(text), text.slice(0, 400));
        verify('Repair offered', await page.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 1);
        await decide(page, 'Close');
    });
    const code = await run(native, ['n11-renamed', ...target], { interactive: true, docker, onChatOpen: h.onChatOpen });
    verify('With chat: Exit 1, one window, no Docker without a click', code === 1 && await h.done() === 1 && dockerUsed === 0, `${code} ${dockerUsed}`);
});

// ---- N12: caw reproduce, Claude alone (scripted), with a report and a draft test plan

const reproduceOf = async (args, { agent, onChatOpen } = {}) => reproduce(native, [...args, '--env', 'test'], { interactive: true, containerCommand: ['bash', '-c', agent], ...(onChatOpen === undefined ? {} : { onChatOpen }) });

scenario('N12', 'reproduce: Claude reproduces a bug alone (no plan, no decision), report and valid draft; not reproducible; read-only blocks writes', async () => {
    const before = readFileSync(join(native, 'caw.config.json'), 'utf8');
    const tests = readdirSync(join(native, 'caw/tests')).sort().join(',');
    try {
        // (1) With a window: the status reads English although the app speaks German. Claude finds it without a plan; plan and
        // check are refused, the human only watches.
        const seen = humans(async (page) => {
            await page.locator('#next.on').waitFor({ timeout: 90000 });
            verify('(1) end card: bug reproduced', /Fehler nachgestellt/.test(await page.locator('#next').textContent()));
            await endAction(page, 'closeWindow', { timeout: 5000 }).catch(() => {});
        });
        const found = `exec 2>&1
A='caw agent'
echo 'notes: x' > /tmp/p.yaml
if $A plan --file /tmp/p.yaml 2>&1 | grep -q 'reproduce-refused'; then echo PLAN-REFUSED; fi
if $A check S1 "true" 2>&1 | grep -q 'reproduce-refused'; then echo CHECK-REFUSED; fi
$A task | grep -q 'reproduce' && echo TASK-REPRODUCE
$A click '#save'
$A screenshot after-save.png > /dev/null
S=$($A eval "document.getElementById('status').textContent")
V=no; echo "$S" | grep -q Saved && V=yes
cat > /tmp/f.json <<JSON
{"reproduced":"$V","observed":"The status reads Saved after saving.","expected":"The status is in German.","writes":false,"steps":[{"name":"Speichern","do":"Klicke auf Save.","expect":"Der Status steht auf Deutsch da."}],"cause":"site/index.html:91 sets an English text.","screenshots":["after-save.png"]}
JSON
$A finish --file /tmp/f.json`;
        const code = await reproduceOf(['Nach dem Speichern steht der Status auf Englisch da.'], { agent: found, onChatOpen: seen.onChatOpen });
        await seen.done();
        const { result, report, dir } = newestRunOf(native, 'reproduce');
        verify('(1) Exit 0: reproduced', code === 0 && result?.reproduce?.reproduced === 'yes', `${code} ${JSON.stringify(result?.reproduce ?? result).slice(0, 300)}`);
        const log = ['agent/claude.log', 'claude.log'].map((name) => join(dir, name)).filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8')).join('') || readFileSync(join(here, 'n12.log'), 'utf8');
        verify('(1) task in mode reproduce, plan and check refused', /TASK-REPRODUCE/.test(log) && /PLAN-REFUSED/.test(log) && /CHECK-REFUSED/.test(log), log.slice(-400));
        verify('(1) report: verdict, bug report, steps, cause, screenshot, draft', /nachgestellt/.test(report) && /> Nach dem Speichern/.test(report) && /Klicke auf Save/.test(report) && /index\.html:91/.test(report) && /after-save\.png/.test(report) && /caw\/drafts\/bug-nach-dem-speichern/.test(report), report.slice(0, 600));
        verify('(1) report names the action by its element, never a reference', /^- click button "Save"/m.test(report), report.split('\n').filter((line) => line.startsWith('- click')).join(' | '));
        // Reproduced: the draft is in caw/drafts, plan only, its last step to be recorded red.
        const draftFile = join(native, result?.reproduce?.draft?.file ?? 'caw/drafts/missing.yaml');
        const draft = existsSync(draftFile) ? readFileSync(draftFile, 'utf8') : '';
        let valid = true;
        try { parseTest(draft, 'draft', { draft: true }); } catch { valid = false; }
        rmSync(draftFile, { force: true });
        verify('(1) the draft is a valid test plan with the step, the environment and the id from the bug', valid && /^id: bug-nach-dem-speichern-steht-der-status/m.test(draft) && /environments: \[ ?test ?\]/.test(draft) && /Klicke auf Save\./.test(draft), draft);
        verify('(1) caw/tests untouched', readdirSync(join(native, 'caw/tests')).sort().join(',') === tests);

        // (2) Not reproducible, headless: Claude ends with no; exit 1.
        const missed = `exec 2>&1
A='caw agent'
cat > /tmp/f.json <<JSON
{"reproduced":"no","observed":"The list shows the new errand at the top.","expected":"The new errand is at the top.","writes":true,"steps":[{"do":"Lege die Besorgung Test an.","expect":"Sie steht oben."}]}
JSON
$A finish --file /tmp/f.json`;
        const notFound = await reproduceOf(['Neue Besorgungen stehen nicht oben.', '--headless'], { agent: missed });
        const second = newestRunOf(native, 'reproduce');
        verify('(2) headless, not reproduced: exit 1 and the verdict in the report', notFound === 1 && second.result?.reproduce?.reproduced === 'no' && /nicht nachgestellt/.test(second.report), `${notFound} ${second.report.slice(0, 200)}`);

        // (3) Without writable: the add request is aborted, the page never says "Added", the report says read-only.
        writeFileSync(join(native, 'caw.config.json'), before.replace('"writable": true', '"writable": false'));
        const blocked = `exec 2>&1
A='caw agent'
REF=$($A snapshot | grep 'textbox "New errand"' | grep -oE 'ref=[a-z0-9]+' | head -1 | cut -d= -f2)
$A fill "$REF" "Read only $($A task | grep -o 'CAW-[0-9]*' | head -1)"
$A click '#add'
sleep 1
S=$($A eval "document.getElementById('status').textContent")
cat > /tmp/f.json <<JSON
{"reproduced":"unclear","observed":"status: $S","expected":"Added.","writes":true,"steps":[{"do":"Lege eine Besorgung an.","expect":"Added erscheint."}]}
JSON
$A finish --file /tmp/f.json`;
        const readOnly = await reproduceOf(['Hinzufügen geht nicht.', '--headless'], { agent: blocked });
        const third = newestRunOf(native, 'reproduce');
        verify('(3) read-only: the POST is blocked and named, the page never confirms, the report says read-only',
            readOnly === 1 && !/status: Added/.test(JSON.stringify(third.result?.reproduce ?? {})) && /write-blocked/.test(JSON.stringify(third.result?.failures ?? [])) && /Nur lesend/.test(third.report),
            `${readOnly} ${JSON.stringify(third.result?.failures ?? []).slice(0, 300)}`);

        // (4) With a ticket id and a covering test: an unknown test is refused, a recorded one is taken with its newest run.
        writeFileSync(join(native, 'caw.config.json'), before);
        const coveredBy = `exec 2>&1
A='caw agent'
cat > /tmp/f.json <<JSON
{"reproduced":"no","observed":"The counter counts.","expected":"The counter counts.","writes":false,"steps":[{"do":"Klicke zweimal auf Add one.","expect":"Der Zaehler steht auf 2."}],"covered":{"test":"no-such-test","why":"x"}}
JSON
if $A finish --file /tmp/f.json 2>&1 | grep -q 'no test no-such-test'; then echo COVER-REFUSED >> "$CAW_AGENT_DIR/n12.txt"; fi
cat > /tmp/f.json <<JSON
{"reproduced":"no","observed":"The counter counts.","expected":"The counter counts.","writes":false,"steps":[{"do":"Klicke zweimal auf Add one.","expect":"Der Zaehler steht auf 2."}],"covered":{"test":"n3-layers","step":"S2","why":"S2 prueft den Zaehler."}}
JSON
$A finish --file /tmp/f.json`;
        const withRef = await reproduceOf(['Der Zaehler zaehlt nicht.', '--headless', '--ref', 'TCK-1234'], { agent: coveredBy });
        const fourth = newestRunOf(native, 'reproduce');
        const marks = join(fourth.dir, 'agent/n12.txt');
        const fourthLog = existsSync(marks) ? readFileSync(marks, 'utf8') : '';
        verify('(4) an unknown covering test is refused', /COVER-REFUSED/.test(fourthLog), fourthLog.slice(-400));
        const cover = fourth.result?.reproduce?.covered;
        verify('(4) ref and covering test in result.json, with that test\'s newest run',
            withRef === 1 && fourth.result?.reproduce?.ref === 'TCK-1234' && cover?.test === 'n3-layers' && cover?.step === 'S2' && (cover.lastRun === undefined || /-n3-layers$/.test(cover.lastRun.runId)),
            `${withRef} ${JSON.stringify(fourth.result?.reproduce ?? {}).slice(0, 400)}`);
        verify('(4) report: the reference and the section on the covering test', /^Referenz: TCK-1234$/m.test(fourth.report) && /## Schon abgedeckt/.test(fourth.report) && /n3-layers@S2/.test(fourth.report), fourth.report.slice(0, 600));
        verify('(4) not reproduced: no draft', fourth.result?.reproduce?.draft === undefined, JSON.stringify(fourth.result?.reproduce?.draft));
    } finally {
        writeFileSync(join(native, 'caw.config.json'), before);
    }
});

// ---- N13: pending steps (the unrecorded tail) pass, --strict does not; open lands before the first pending step

// A copy of n9-shadow (S1, S2 recorded) with S3 and S4 written but not recorded yet.
const PENDING = 'rec-pending';
scenario('N13', 'Pending steps: run passes with S1–S2 and names S3, S4; --strict exits 4; open @S4 names S3; open @S3 lands after S2; the workbench marks them', async () => {
    const parsed = parseTest(testText(PENDING, TESTS['n9-shadow']));
    const later = [
        { id: 'S3', name: 'Exportieren', do: 'Exportiere die Bewertung.', expect: 'Die Datei ist da.' },
        { id: 'S4', name: 'Teilen', do: 'Teile die Bewertung.', expect: 'Der Link ist kopiert.' },
    ];
    writeTest(native, { ...parsed, id: PENDING, steps: [...parsed.steps, ...later] });
    const plain = await runQuietly(PENDING);
    const { result, report } = newestRunOf(native, PENDING);
    verify('run: Exit 0 with S3, S4 pending', plain.code === 0, `${plain.code} ${plain.note}`);
    verify('result.json: pending and the step statuses', JSON.stringify(result?.pending) === '["S3","S4"]'
        && JSON.stringify((result?.steps ?? []).map(({ id, status }) => `${id}:${status}`)) === '["S1:pass","S2:pass","S3:pending","S4:pending"]', JSON.stringify({ pending: result?.pending, steps: result?.steps?.map(({ id, status }) => `${id}:${status}`) }));
    verify('report.md names them', /Offen, noch nicht aufgenommen: S3, S4\./.test(report), report.slice(0, 600));
    const strict = await runQuietly(PENDING, ['--strict']);
    verify('--strict: replay-pending (exit 4), names the record command', /^error replay-pending: .*caw record rec-pending@S3/.test(String(strict.code)), String(strict.code));
    const behind = await open(native, [`${PENDING}@S4`, ...target], { interactive: true }).catch((error) => `error ${error.code}: ${error.message}`);
    verify('open @S4 behind the pending S3: refused, names S3', /^error replay-stale: S3 ist offen, noch nicht aufgenommen\. Nimm ihn zuerst auf: caw record rec-pending@S3/.test(String(behind)), String(behind));
    // open @S3: S1 and S2 ran (shadow status and Saved), nothing of S3.
    const atEntry = humans(async (chat) => {
        const bench = chat.page();
        await benchBack(chat);
        await stateOf(chat, 'developing');
        const state = await appOf(bench).evaluate(() => `${document.querySelector('caw-rating').shadowRoot.querySelector('[role=status]').textContent}|${document.getElementById('status').textContent}`);
        verify('open @S3: S1 and S2 ran', state === 'Thanks: Good|Saved', state);
        await decide(chat, 'Beenden');
    });
    const entryCode = await open(native, [`${PENDING}@S3`, ...target], { interactive: true, onChatOpen: atEntry.onChatOpen });
    verify('open @S3: Exit 0, one window', entryCode === 0 && await atEntry.done() === 1, String(entryCode));
    // open <test>: plays up to S2; the step list shows S3 and S4 as skipped with the pending note.
    const whole = humans(async (chat) => {
        const bench = chat.page();
        await benchBack(chat);
        await stateOf(chat, 'developing');
        const marks = await bench.evaluate(() => ['S1', 'S2', 'S3', 'S4'].map((id) => {
            const li = document.querySelector(`#steps>li[data-id="${id}"]`);
            return `${id}:${li?.dataset.state}:${li?.querySelector(':scope>.note')?.textContent ?? ''}`;
        }).join(' '));
        verify('workbench: S1, S2 pass, S3, S4 skipped as pending', marks === 'S1:pass: S2:pass: S3:skipped:offen: noch nicht aufgenommen S4:skipped:offen: noch nicht aufgenommen', marks);
        await decide(chat, 'Beenden');
    });
    const wholeCode = await open(native, [PENDING, ...target], { interactive: true, onChatOpen: whole.onChatOpen });
    verify('open <test>: Exit 0, one window', wholeCode === 0 && await whole.done() === 1, String(wholeCode));
});

// ---- N18: target designs. S2 of n9-shadow ends on the page with "Errands" and Save; a design that matches, one that does not,
// an image, and the needs of a pending S3.

const DESIGNED = 'rec-design';
// The fixture's own font and a default button: the same controls and styles as the site after S2. Free text and the rest of the
// page are left out on purpose: what only the app has does not fail.
const MATCHING = '<!doctype html><html lang="en"><head><style>body{font:14px system-ui,sans-serif;margin:16px}</style></head><body><main><h1>Errands</h1><p>Sample text</p><button>Save</button></main></body></html>';
const OTHER = '<!doctype html><html lang="en"><head><style>body{font:14px system-ui,sans-serif;margin:16px}button{background:#e5533a;color:#fff}</style></head><body><main><h1>Errands</h1><button>Save</button><button>Export</button></main></body></html>';
// A PNG header (signature and IHDR, 390×844) without image data: caw_design would refuse nothing, the pixel comparison cannot
// decode it, so the design only warns (N17 judges real images).
const PNG_390 = (() => {
    const bytes = Buffer.alloc(45);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(390, 16);
    bytes.writeUInt32BE(844, 20);
    return bytes;
})();

scenario('N18', 'Target design: a matching .html passes, another fails S2 with kind design and the replay goes on, a .png that is no image only warns; needs of the pending S3', async () => {
    const designDir = join(native, 'caw/design');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'n18-match.html'), MATCHING);
    writeFileSync(join(designDir, 'n18-other.html'), OTHER);
    writeFileSync(join(designDir, 'n18.png'), PNG_390);
    const parsed = parseTest(testText(DESIGNED, TESTS['n9-shadow']));
    const withDesign = (file, extra = []) => writeTest(native, { ...parsed, id: DESIGNED, steps: [parsed.steps[0], { ...parsed.steps[1], design: file }, ...extra] });
    const stepOf = (result, id) => (result?.steps ?? []).find((step) => step.id === id);
    try {
        withDesign('design/n18-match.html', [{ id: 'S3', name: 'Exportieren', do: 'Exportiere.', expect: 'Die Datei ist da.', needs: ["getByRole('button', { name: 'Save', exact: true })"] }]);
        const met = await runQuietly(DESIGNED);
        const first = newestRunOf(native, DESIGNED).result;
        verify('matching design: Exit 0, verdict met', met.code === 0 && stepOf(first, 'S2')?.design?.verdict === 'met', `${met.code} ${met.note} ${JSON.stringify(stepOf(first, 'S2')?.design)}`);
        verify('the app frame is only extra', (stepOf(first, 'S2')?.design?.extra ?? []).some((line) => /Orders|Customers|Add/.test(line)), JSON.stringify(stepOf(first, 'S2')?.design?.extra));
        verify('needs of S3 all there: ready to record', first?.needs?.step === 'S3' && first.needs.ready === true, JSON.stringify(first?.needs));

        withDesign('design/n18-other.html', [{ id: 'S3', name: 'Exportieren', do: 'Exportiere.', expect: 'Die Datei ist da.', needs: ["getByRole('button', { name: 'Export', exact: true })"] }]);
        const notMet = await runQuietly(DESIGNED);
        const second = newestRunOf(native, DESIGNED).result;
        const s2 = stepOf(second, 'S2');
        verify('other design: Exit 1, S2 fails with kind design', notMet.code === 1 && s2?.status === 'fail' && s2.kind === 'design', `${notMet.code} ${JSON.stringify(s2)}`);
        verify('names the missing button and the differing style', /Fehlt: .*button "Export"/.test(notMet.note) && /button "Save": background-color .* → /.test(notMet.note), notMet.note);
        verify('needs of S3 missing: named, not ready', second?.needs?.ready === false && /Export/.test(JSON.stringify(second.needs.missing)), JSON.stringify(second?.needs));

        withDesign('design/n18.png');
        const image = await runQuietly(DESIGNED);
        const third = newestRunOf(native, DESIGNED).result;
        verify('undecodable image design: Exit 0, only a warning', image.code === 0 && stepOf(third, 'S2')?.design?.verdict === 'error' && (third?.warnings ?? []).some(({ type }) => type === 'design'), `${image.code} ${JSON.stringify(stepOf(third, 'S2')?.design)}`);
    } finally {
        rmSync(designDir, { recursive: true, force: true });
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${DESIGNED}.yaml`), { force: true });
    }
});

// ---- N16: a renamed target repaired with proof. Five runs learn the effect of clicking "Archive" (Undo appears), the server renames it to
// "Archive all" (/api/rename), a run proposes the one similar button without AI; adopting it in the chat changes only that target.

const REPAIRED = 'rec-repair';
const ARCHIVE = "getByRole('button', { name: 'Archive', exact: true })";
const ARCHIVE_ALL = "getByRole('button', { name: 'Archive all', exact: true })";
const renameSwitch = (on) => fetch(`http://127.0.0.1:${PORT}/api/rename?on=${on ? 1 : 0}`, { method: 'POST' });

scenario('N16', 'Locator repair: learned effect, rename, run proposes "Archive all" with proof (CI: report only), adopting it in the chat changes only the target, then green', async () => {
    writeTest(native, { ...parseTest(testText(REPAIRED, [{ name: 'Archivieren', expect: 'Archiviert.', actions: [{ click: ARCHIVE }], check: "document.getElementById('status').textContent==='Archived'" }])), id: REPAIRED });
    const hashOf = () => loadTest(native, REPAIRED).steps[0].recording.hash;
    const hash = hashOf();
    try {
        await renameSwitch(false);
        const learning = [];
        for (let count = 0; count < 5; count += 1) learning.push(await runQuietly(REPAIRED, ['--learn']));
        const effects = loadTest(native, REPAIRED).steps[0].recording.effects;
        verify('five runs learn the click\'s effect: Undo appears', learning.every(({ code }) => code === 0) && effects?.runs === 5
            && effects.actions.some(({ action, controls }) => action === 1 && (controls ?? []).includes('+ button "Undo"')), `${JSON.stringify(learning)} ${JSON.stringify(effects)}`);

        await renameSwitch(true);
        const proposed = await runQuietly(REPAIRED);
        const { result, report } = newestRunOf(native, REPAIRED);
        const step = (result?.steps ?? []).find(({ id }) => id === 'S1');
        verify('without chat (as in CI): Exit 1, S1 fails on its target with the proposal', proposed.code === 1 && step?.status === 'fail' && step.kind === 'target'
            && step.proposal?.action === 1 && step.proposal.from === ARCHIVE && step.proposal.to === ARCHIVE_ALL && /=> true$/.test(step.proposal.evidence?.check ?? ''), `${proposed.code} ${JSON.stringify(step)}`);
        verify('the note says why it is proven', /caw schlägt für Aktion 1 stattdessen button "Archive all" vor: Es bewirkte dieselbe gelernte Wirkung, schrieb nichts/.test(proposed.note), proposed.note);
        verify('report.md: the section with both locators', /## Vorgeschlagene Ziele/.test(report) && report.includes(`- S1, Aktion 1: \`${ARCHIVE}\` → \`${ARCHIVE_ALL}\``), report.slice(0, 900));
        verify('CI changed nothing in the recording', loadTest(native, REPAIRED).steps[0].recording.actions[0].target === ARCHIVE);

        const h = humans(async (page) => {
            const use = page.locator('#choices button', { hasText: '„Archive all“ verwenden' });
            await use.waitFor({ state: 'attached', timeout: 90000 });
            const text = await page.locator('.message:is(.question,.result,.notice)').last().textContent();
            verify('Chat: the failure names the proposal', /S1 ist gescheitert/.test(text) && /stattdessen button "Archive all" vor/.test(text), text.slice(0, 500));
            await clickChoice(page, use);
        }, async () => {});
        const code = await run(native, [REPAIRED, ...target], { interactive: true, onChatOpen: h.onChatOpen });
        const recording = loadTest(native, REPAIRED).steps[0].recording;
        verify('adopted: Exit 0 after the new run, two windows', code === 0 && await h.done() === 2, String(code));
        verify('only the target changed: hash and learned effects stay', recording.actions[0].target === ARCHIVE_ALL && hashOf() === hash && JSON.stringify(recording.effects) === JSON.stringify(effects), JSON.stringify(recording));
        const green = newestRunOf(native, REPAIRED).result;
        verify('the new run: S1 passes with the new target', (green?.steps ?? []).find(({ id }) => id === 'S1')?.status === 'pass', JSON.stringify(green?.steps));
    } finally {
        await renameSwitch(false).catch(() => {});
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${REPAIRED}.yaml`), { force: true });
    }
});

// ---- N15: from a reproduced bug to a proven fix: draft, red, the fix (a server switch), green, promote with a fix report

// Its own project (fix/, start /fix.html): run --all there is the draft's neighbour fix-page only, not the native tests that fail on purpose.
const fixRoot = join(native, 'fix');
const FIX_URL = `http://127.0.0.1:${PORT}`;
const switchBug = (on) => fetch(`${FIX_URL}/api/fix-bug?on=${on ? 1 : 0}`, { method: 'POST' });
const FIX_PLAN = `notes: Die Summe des Warenkorbs.
steps:
  - id: S1
    name: Warenkorb
    do: Öffne den Warenkorb.
    expect: Der Knopf Show total ist da.
  - id: S2
    name: Summe
    do: Klicke auf Show total.
    expect: 'Die Summe zeigt Total: 5.'`;

/** A fresh fix project: no tests but the neighbour fix-page that run --all checks before promoting, the bug switched on. */
const fixSetup = async () => {
    rmSync(join(fixRoot, 'caw'), { recursive: true, force: true });
    rmSync(join(fixRoot, '.caw'), { recursive: true, force: true });
    rmSync(join(fixRoot, 'src'), { recursive: true, force: true });
    const page = { id: 'S1', name: 'Seite', do: 'Öffne den Warenkorb.', expect: 'Der Knopf ist da.' };
    writeTest(fixRoot, { id: 'fix-page', environments: ['test'], writes: false, notes: '', steps: [{ ...page, recording: { hash: stepHash(page), recordedOn: 'test', recordedAt: '2026-11-21T09:00:00.000Z', locale: 'de-DE', timezone: 'Europe/Berlin', actions: [], check: "!!document.getElementById('total')" } }] });
    await switchBug(true);
};
const FIX_ID = 'bug-die-summe-zeigt-0-statt-5';
// Claude (scripted) sees Total: 0 and finishes with yes; with a cause the fix card shows it.
const foundScript = (cause = '') => `exec 2>&1
A='caw agent'
$A click '#total'
sleep 1
S=$($A eval "document.getElementById('sum').textContent")
V=no; echo "$S" | grep -q 'Total: 0' && V=yes
cat > /tmp/f.json <<JSON
{"reproduced":"$V","observed":"$S","expected":"Total: 5","writes":false,${cause === '' ? '' : `"cause":"${cause}",`}"steps":[{"name":"Warenkorb","do":"Öffne den Warenkorb.","expect":"Der Knopf Show total ist da."},{"name":"Summe","do":"Klicke auf Show total.","expect":"Die Summe zeigt Total: 5."}]}
JSON
$A finish --file /tmp/f.json`;
// The recording: S1 passes, S2's check of the expected total evaluates to false while the bug is there.
const recorderScript = `exec 2>&1
A='caw agent'
${planOf(FIX_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
$A task | grep -q '"red"' && echo TASK-RED
$A check S1 "!!document.getElementById('total')"
$A click '#total'
sleep 1
$A check S2 "document.getElementById('sum').textContent==='Total: 5'"
echo '{"expectations":[{"id":"S1","status":"pass","evidence":{"type":"eval","value":"ok"}},{"id":"S2","status":"fail","evidence":{"type":"eval","value":"Total: 0"}}],"omit":[]}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;
/** Reproduces headless; @returns the draft's id. */
const reproduceHeadless = async () => {
    const reproduced = await reproduce(fixRoot, ['Die Summe zeigt 0 statt 5.', '--env', 'test', '--headless'], { interactive: true, containerCommand: ['bash', '-c', foundScript()] });
    const repro = newestRunOf(fixRoot, 'reproduce').result?.reproduce;
    const id = repro?.draft?.file?.replace(/^caw\/drafts\/|\.yaml$/g, '');
    verify('(1) reproduced: exit 0, the draft in caw/drafts', reproduced === 0 && id === FIX_ID && existsSync(join(fixRoot, repro.draft.file)), `${reproduced} ${JSON.stringify(repro?.draft)}`);
    return id;
};
const findCard = (chat, text) => chat.locator('.message:is(.question,.result,.notice,.decision)', { hasText: text }).waitFor({ timeout: 120000 });
/** The check run of the recording: S2 red as expected, the person saves the draft with its proof. */
const adoptRed = async (chat) => {
    await findCard(chat, 'S2 rot wie erwartet: der Test fängt den Fehler');
    verify('(2) no step fix offered at the red card', await chat.locator('#choices button', { hasText: 'Schritt beheben' }).count() === 0);
    await decide(chat, 'Testplan übernehmen');
    await findCard(chat, 'Jetzt den Fehler beheben');
};
/** The run of the draft after the fix: green, then Übernehmen promotes it or Später keeps the draft. */
const greenWindow = (choice) => async (chat) => {
    await findCard(chat, 'S2 grün: der Fehler ist behoben');
    await decide(chat, choice === 'promote' ? /^Übernehmen$/ : 'Später');
    if (choice === 'promote') await findCard(chat, /Übernommen: caw\/tests\//);
};
/** Promoted: the test in caw/tests and caw/recordings, the draft gone, the green run's fix report. */
const verifyPromoted = (label, red) => {
    const { dir } = newestRunOf(fixRoot, FIX_ID);
    const reportFile = join(dir, 'fix-report.md');
    const fixReport = existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '';
    verify(`${label} promoted: the test in caw/tests and caw/recordings, the draft gone`, existsSync(join(fixRoot, 'caw/tests', `${FIX_ID}.yaml`)) && existsSync(join(fixRoot, 'caw/recordings', `${FIX_ID}.yaml`)) && !existsSync(join(fixRoot, 'caw/drafts', `${FIX_ID}.yaml`)));
    verify(`${label} the test file carries no red`, !/^red:/m.test(readFileSync(join(fixRoot, 'caw/tests', `${FIX_ID}.yaml`), 'utf8')));
    verify(`${label} fix report: red at S2 with run and commit, green with its run, the changed files, one other test green`,
        new RegExp(`Rot bei S2: Lauf ${red.run}, Commit ${red.head}`).test(fixReport) && new RegExp(`Grün: Lauf .*-${FIX_ID}`).test(fixReport)
        && /## Geänderte Dateien seit/.test(fixReport) && /1 andere\(r\) Test\(s\) auf test grün/.test(fixReport), fixReport);
};

scenario('N15', 'Reproduce → red draft → fix (server switch) → green → promote on the command line: the workbench offers the fix after the red proof, Später ends there; still red, --promote refused, green, fix report', async () => {
    await fixSetup();
    try {
        const id = await reproduceHeadless();
        const draftFile = readFileSync(join(fixRoot, 'caw/drafts', `${id}.yaml`), 'utf8');
        verify('(1) its notes carry the trail with the locator', /click getByRole\('button', \{ name: 'Show total', exact: true \}\)/.test(draftFile), draftFile);
        verify('(1) not in caw/tests', !existsSync(join(fixRoot, 'caw/tests', `${id}.yaml`)));

        // (2) record the draft; after the red proof the card offers the fix, Später ends the run with the proof saved.
        const redCard = async (chat) => {
            await adoptRed(chat);
            verify('(2) the fix card offers the agent, fixing myself and later', await chat.locator('#choices button', { hasText: /beheben lassen/ }).count() === 1 && await chat.locator('#choices button', { hasText: 'Ich behebe selbst' }).count() === 1);
            await decide(chat, 'Später');
        };
        // Windows: follow the test plan, the recording (approve the plan), the check run with the red card.
        const h = humans(followAndAdopt, followAndAdopt, redCard);
        const recorded = await record(fixRoot, [id, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', recorderScript], onChatOpen: h.onChatOpen });
        verify('(2) three windows, none after Später', await h.done() === 3);
        const red = loadTest(fixRoot, id);
        verify('(2) recorded red: exit 0, red at S2 with run and commit, still a draft', recorded === 0 && red.draft === true && red.red?.step === 'S2' && /Z-bug-die-summe/.test(red.red?.run ?? '') && /^[0-9a-f]{4,40}$/.test(red.red?.head ?? ''), `${recorded} ${JSON.stringify(red.red)}`);
        verify('(2) S2 keeps the failing check of the expected total', red.steps[1].recording?.check === "document.getElementById('sum').textContent==='Total: 5'", red.steps[1].recording?.check);

        // (3) Still red without the fix; --promote refuses (exit 1) and the draft stays.
        const still = await runQuietly(id, [], fixRoot);
        verify('(3) still red: exit 1 at S2', still.code === 1, `${still.code} ${still.note}`);
        const early = await run(fixRoot, [id, '--promote', ...target]);
        verify('(3) --promote while red: exit 1, the draft stays', early === 1 && existsSync(join(fixRoot, 'caw/drafts', `${id}.yaml`)), String(early));

        // (4) The fix: the server computes the total again. The same recording without AI is green.
        await switchBug(false);
        const green = await runQuietly(id, [], fixRoot);
        verify('(4) green after the fix: exit 0', green.code === 0, `${green.code} ${green.note}`);

        // (5) Promote: the draft and run --all (fix-page) green; the test moves to caw/tests, the draft goes, the fix report is written.
        const promoted = await run(fixRoot, [id, '--promote', ...target]);
        verify('(5) promoted: exit 0', promoted === 0, String(promoted));
        verifyPromoted('(5)', red.red);
    } finally {
        await switchBug(false).catch(() => {});
    }
});

scenario('N15b', 'Guided bug fix in one process: reproduce in a window → Rot aufnehmen → red → Ich behebe selbst → server switch → Erneut testen green → Übernehmen promotes with a fix report', async () => {
    await fixSetup();
    try {
        // One process, one script for both agents: the reproduction and the recording.
        const agent = `if caw agent task | grep -Eq '"mode": ?"reproduce"'; then
${foundScript('serve.mjs: /api/total antwortet 0')}
else
${recorderScript}
fi`;
        const reproduced = async (chat) => {
            await findCard(chat, `Nachgestellt: Entwurf caw/drafts/${FIX_ID}.yaml`);
            await decide(chat, 'Rot aufnehmen');
        };
        let redProof = null;
        const fixMyself = async (chat) => {
            await adoptRed(chat);
            const fix = await chat.locator('.message.decision', { hasText: 'Jetzt den Fehler beheben' }).last().textContent();
            verify('(2) the fix card names the red step, its expectation, its check and the suspected cause', /Roter Schritt: S2/.test(fix) && /Erwartet: Die Summe zeigt Total: 5/.test(fix) && /textContent==='Total: 5'/.test(fix) && /Vermutete Ursache: serve\.mjs: \/api\/total antwortet 0/.test(fix), fix);
            redProof = loadTest(fixRoot, FIX_ID).red;
            await decide(chat, 'Ich behebe selbst');
            await findCard(chat, 'Behebe den Fehler, dann teste erneut');
            // The person's fix: the server computes the total again.
            await switchBug(false);
            await decide(chat, 'Erneut testen');
        };
        // Windows: the reproduction, follow the test plan, the recording, the check run (red, fix), the run after the fix.
        const h = humans(reproduced, followAndAdopt, followAndAdopt, fixMyself, greenWindow('promote'));
        const code = await reproduce(fixRoot, ['Die Summe zeigt 0 statt 5.', '--env', 'test'], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        verify('(1–3) one process, five windows, exit 0', await h.done() === 5 && code === 0, String(code));
        verify('(2) the red proof was saved before the fix', redProof?.step === 'S2' && /^[0-9a-f]{4,40}$/.test(redProof?.head ?? ''), JSON.stringify(redProof));
        verifyPromoted('(3)', redProof ?? {});
        const notes = readFileSync(join(fixRoot, 'caw/tests', `${FIX_ID}.yaml`), 'utf8');
        verify('(3) the suspected cause stays in the notes', /Vermutete Ursache: serve\.mjs: \/api\/total antwortet 0/.test(notes), notes);
    } finally {
        await switchBug(false).catch(() => {});
    }
});

scenario('N15c', 'Guided bug fix, Von Claude Code beheben lassen: the advice gets the red step as its task, its edit is applied on its card, Erneut testen green, Später keeps the draft, --promote promotes it', async () => {
    await fixSetup();
    mkdirSync(join(fixRoot, 'src'), { recursive: true });
    writeFileSync(join(fixRoot, 'src/total.mjs'), 'export const total = (items) => {\n    return 0;\n};\n');
    try {
        const id = await reproduceHeadless();
        const advice = `exec 2>&1
A='caw agent'
$A task > /tmp/t.json; grep -q '"fix"' /tmp/t.json && echo TASK-FIX
cat > /tmp/a.json <<'JSON'
{"items":[{"about":"S2","side":"app","title":"Summe aus den Preisen","evidence":"src/total.mjs:2","reason":"total gibt immer 0 zurück.","edits":[{"file":"src/total.mjs","find":"return 0;","replace":"return items.reduce((sum, item) => sum + item.price, 0);","why":"Die Summe der Preise"}],"prompt":"Rechne die Summe in src/total.mjs aus den Preisen."}]}
JSON
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        const byAgent = async (chat) => {
            await adoptRed(chat);
            await decide(chat, /beheben lassen/);
            await stateOf(chat, 'reviewing');
            const card = await chat.locator('.message.advice').last().textContent();
            verify('(2) the advice card shows the edit to src/total.mjs', /src\/total\.mjs/.test(card) && /items\.reduce/.test(card), card);
            await decide(chat, 'Änderung übernehmen');
            await findCard(chat, 'Änderung übernommen');
            // The fixture's bug lives in the server: the switch stands in for the edit taking effect.
            await switchBug(false);
            await decide(chat, 'Erneut testen');
        };
        const h = humans(followAndAdopt, followAndAdopt, byAgent, greenWindow('later'));
        const recorded = await record(fixRoot, [id, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', recorderScript], adviseCommand: ['bash', '-c', advice], onChatOpen: h.onChatOpen });
        verify('(2–3) four windows, the green run ends the process with exit 0', await h.done() === 4 && recorded === 0, String(recorded));
        verify('(2) the edit is in the file, written only on the click', /return items\.reduce\(\(sum, item\) => sum \+ item\.price, 0\);/.test(readFileSync(join(fixRoot, 'src/total.mjs'), 'utf8')));
        verify('(3) Später keeps the draft', existsSync(join(fixRoot, 'caw/drafts', `${id}.yaml`)));
        const red = loadTest(fixRoot, id).red;
        // The advice ran in the red check run: its log shows the task carried the red step.
        const adviceFile = join(fixRoot, '.caw/runs', red?.run ?? '-', 'agent/claude-advice.log');
        const adviceLog = existsSync(adviceFile) ? readFileSync(adviceFile, 'utf8') : '';
        verify('(2) the advice task carried the red step (task.fix)', /TASK-FIX/.test(adviceLog), adviceLog.slice(-400));
        const promoted = await run(fixRoot, [id, '--promote', ...target]);
        verify('(4) --promote: exit 0', promoted === 0, String(promoted));
        verifyPromoted('(4)', red);
    } finally {
        await switchBug(false).catch(() => {});
        rmSync(join(fixRoot, 'src'), { recursive: true, force: true });
    }
});

scenario('N15d', 'Guided bug fix, the cause outside the project: the agent says where, the card applies nothing, Ich behebe es dort → server switch → Erneut testen green → Übernehmen promotes', async () => {
    await fixSetup();
    try {
        const id = await reproduceHeadless();
        const advice = `exec 2>&1
A='caw agent'
cat > /tmp/a.json <<'JSON'
{"items":[{"about":"S2","side":"outside","title":"Der Summendienst antwortet 0","evidence":"request GET /api/total answered total 0","reason":"Die Seite zeigt nur, was der Dienst liefert; sein Code liegt nicht in diesem Projekt.","where":"Dienst /api/total (eigenes Repository)","prompt":"Die Summe in /api/total aus den Preisen berechnen."}]}
JSON
$A advise --file /tmp/a.json; echo "ADVISE Exit=$?"`;
        let redProof = null;
        const outside = async (chat) => {
            await adoptRed(chat);
            redProof = loadTest(fixRoot, id).red;
            await decide(chat, /beheben lassen/);
            await stateOf(chat, 'reviewing');
            const card = await chat.locator('.message.advice').last().textContent();
            verify('(2) the advice card says the cause lies outside and where', /Ursache außerhalb des Projekts/.test(card) && /Dienst \/api\/total/.test(card), card);
            verify('(2) nothing to apply on it', await chat.locator('#choices button', { hasText: 'Änderung übernehmen' }).count() === 0);
            await decide(chat, 'Weiter');
            await findCard(chat, 'Die Ursache liegt außerhalb dieses Projekts');
            await decide(chat, 'Ich behebe es dort');
            await findCard(chat, 'Behebe den Fehler, dann teste erneut');
            // Fixed there: the service computes the total again.
            await switchBug(false);
            await decide(chat, 'Erneut testen');
        };
        const h = humans(followAndAdopt, followAndAdopt, outside, greenWindow('promote'));
        const recorded = await record(fixRoot, [id, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', recorderScript], adviseCommand: ['bash', '-c', advice], onChatOpen: h.onChatOpen });
        verify('(2–3) four windows, exit 0', await h.done() === 4 && recorded === 0, String(recorded));
        verifyPromoted('(3)', redProof ?? {});
    } finally {
        await switchBug(false).catch(() => {});
    }
});

// ---- N17: the visual layer on n9-shadow. Screenshots per step; S2's own screen as a .png design is met, a red page is not;
// design tokens lint (warning, then failing with design.fail lint); visual regression (look: true on S1 and S2) learns both
// looks over two headless runs. The rename switch ("Archive" to "Archive all") keeps role and style: a run with a window
// passes (styles only), a headless one fails both steps by pixels and names the image file to delete. The restyle switch
// (Archive bold) changes a style: the chat window fails S1 and S2, "Neuen Look übernehmen" adopts both at once and drops their
// images of every platform, two headless runs learn them
// again and the third compares them; open @S2 --design lays the design over the app and F7 toggles it.

const LOOKED = 'rec-visual';
const pngSide = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
const restyleSwitch = (on) => fetch(`http://127.0.0.1:${PORT}/api/restyle?on=${on ? 1 : 0}`, { method: 'POST' });

scenario('N17', 'Visual layer: step screenshots, a .png design judged by pixels, token lint, learned look (pixels headless only) changed and adopted for all steps, open --design with F7', async () => {
    const designDir = join(native, 'caw/design');
    mkdirSync(designDir, { recursive: true });
    const parsed = parseTest(testText(LOOKED, TESTS['n9-shadow']));
    // writeTest keeps a design the file has (only people write it): without one, it is taken out explicitly. look: true goes on
    // both steps or off both (undefined overrides what the file has).
    const writeWith = (design, look = false) => {
        const looked = (step) => ({ ...step, look: look ? true : undefined });
        writeTest(native, { ...parsed, id: LOOKED, steps: [looked(parsed.steps[0]), looked({ ...parsed.steps[1], ...(design === undefined ? {} : { design }) })] });
        if (design === undefined) setStepDesign(native, LOOKED, 'S2', null);
    };
    const stepOf = (result, id) => (result?.steps ?? []).find((step) => step.id === id);
    const undo = patchJson(join(native, 'caw.config.json'), (config) => { config.visual = { screenshots: true }; });
    try {
        await renameSwitch(false);
        writeWith();
        const shots = await runQuietly(LOOKED);
        const first = newestRunOf(native, LOOKED);
        const shot = join(first.dir, 'agent', 'step-S2.png');
        verify('screenshots: Exit 0, steps[].screenshot and the file', shots.code === 0 && stepOf(first.result, 'S2')?.screenshot === 'step-S2.png' && existsSync(shot), `${shots.code} ${JSON.stringify(stepOf(first.result, 'S2'))}`);

        // S2's own screen as its design: met. A red page of the same size: not met, with the difference image.
        copyFileSync(shot, join(designDir, 'n17-own.png'));
        const [width, height] = pngSide(readFileSync(shot));
        const browser = await chromium.launch({ channel: 'chrome', headless: true });
        try {
            const page = await browser.newPage({ viewport: { width, height } });
            await page.setContent('<body style="margin:0;background:#e5533a"></body>');
            writeFileSync(join(designDir, 'n17-red.png'), await page.screenshot());
        } finally {
            await browser.close();
        }
        writeWith('design/n17-own.png');
        const own = await runQuietly(LOOKED);
        const ownDesign = stepOf(newestRunOf(native, LOOKED).result, 'S2')?.design;
        verify('its own screen as .png design: Exit 0, met by pixels', own.code === 0 && ownDesign?.verdict === 'met' && ownDesign.ratio < 0.03, `${own.code} ${JSON.stringify(ownDesign)}`);
        writeWith('design/n17-red.png');
        const red = await runQuietly(LOOKED);
        const redRun = newestRunOf(native, LOOKED);
        const redDesign = stepOf(redRun.result, 'S2')?.design;
        verify('a red page: Exit 1, S2 fails with kind design, difference image saved', red.code === 1 && stepOf(redRun.result, 'S2')?.kind === 'design' && redDesign?.verdict === 'not-met'
            && redDesign.diff === 'step-S2-diff.png' && existsSync(join(redRun.dir, 'agent', 'step-S2-diff.png')), `${red.code} ${JSON.stringify(redDesign)}`);
        verify('the note names the share and the limit', /der Pixel weichen ab, höchstens 3 % erlaubt/.test(red.note), red.note);

        // Token lint: a palette the page does not use. A warning first, with design.fail lint a failure.
        writeWith();
        writeFileSync(join(designDir, 'tokens.json'), JSON.stringify({ color: { $type: 'color', ink: { $value: '#123456' } } }));
        const linted = await runQuietly(LOOKED);
        const lintRun = newestRunOf(native, LOOKED).result;
        verify('lint: Exit 0, findings under steps[].lint and a lint warning', linted.code === 0 && (stepOf(lintRun, 'S2')?.lint ?? []).some(({ rule }) => rule === 'color')
            && (lintRun?.warnings ?? []).some(({ type }) => type === 'lint'), `${linted.code} ${JSON.stringify(stepOf(lintRun, 'S2')?.lint?.slice(0, 2))}`);
        const undoLint = patchJson(join(native, 'caw.config.json'), (config) => { config.design = { fail: ['target', 'lint'] }; });
        try {
            const strict = await runQuietly(LOOKED);
            verify('design.fail lint: Exit 1, kind design', strict.code === 1 && stepOf(newestRunOf(native, LOOKED).result, 'S1')?.kind === 'design', `${strict.code} ${strict.note}`);
        } finally {
            undoLint();
        }
        rmSync(join(designDir, 'tokens.json'), { force: true });

        // Visual regression: look: true on S1 and S2. Learning runs are headless: only they learn and compare pixels. The
        // threshold is tight, since the rename differs in about 0.009 % of the pixels; between headless runs on one machine
        // nothing else differs.
        const undoRegression = patchJson(join(native, 'caw.config.json'), (config) => { config.visual = { maxRatio: 0.00002 }; });
        try {
            writeWith(undefined, true);
            const headless = ['--headless'];
            const learning = [await runQuietly(LOOKED, ['--learn', ...headless]), await runQuietly(LOOKED, ['--learn', ...headless])];
            const looks = () => loadTest(native, LOOKED).steps.map((step) => step.recording.visual);
            const imageOf = (id) => join(native, 'caw/recordings', LOOKED, `${id}.${process.platform}.png`);
            const learned = looks();
            verify('two headless runs learn both looks: styles by role and style, an image per platform', learning.every(({ code }) => code === 0)
                && learned.every((visual) => visual?.runs === 2 && visual.images?.[process.platform] === 2 && visual.styles.some((line) => /^button ×\d+: /.test(line)))
                && existsSync(imageOf('S1')) && existsSync(imageOf('S2')), `${JSON.stringify(learning)} ${JSON.stringify(learned)}`);
            verify('no style line names a control', learned.every((visual) => visual.styles.every((line) => !line.includes('"'))), JSON.stringify(learned[1]?.styles));

            // The rename keeps role and style: the window compares styles only and passes; headless the pixels fail both steps.
            await renameSwitch(true);
            const windowed = await runQuietly(LOOKED);
            const windowedStep = stepOf(newestRunOf(native, LOOKED).result, 'S2');
            verify('renamed, run with a window: Exit 0, S2 the same by its styles, pixels headless only', windowed.code === 0 && windowedStep?.visual?.verdict === 'same'
                && windowedStep.visual.pixels === 'headless-only' && windowedStep.visual.ratio === undefined, `${windowed.code} ${JSON.stringify(windowedStep)}`);
            const changed = await runQuietly(LOOKED, headless);
            const changedRun = newestRunOf(native, LOOKED);
            const changedStep = stepOf(changedRun.result, 'S2');
            verify('renamed, headless: Exit 1, S1 and S2 fail with kind visual by pixels, no style changed, difference image saved', changed.code === 1
                && ['S1', 'S2'].every((id) => stepOf(changedRun.result, id)?.kind === 'visual') && changedStep?.visual?.verdict === 'changed'
                && changedStep.visual.ratio > 0.00002 && changedStep.visual.styles === undefined && existsSync(join(changedRun.dir, 'agent', 'step-S2-look-diff.png')), `${changed.code} ${JSON.stringify(changedStep)}`);
            verify('only pixels see it: the note names the image file to delete for learning anew', new RegExp(`ein Lauf im Fenster nicht.*lösche caw/recordings/${LOOKED}/S[12]\\.${process.platform}\\.png: Die nächsten 2 Läufe headless lernen das Bild neu`).test(changed.note), changed.note);
            verify('CI changed nothing in the recording', JSON.stringify(looks()) === JSON.stringify(learned));

            // A style change (Archive bold) is what a window sees: the chat fails S1 and S2, adopting takes both at once. An image
            // of another platform (stands in for one committed from CI) shows the old look too: adopting deletes it as well.
            const otherPlatform = process.platform === 'linux' ? 'win32' : 'linux';
            const otherImageOf = (id) => join(native, 'caw/recordings', LOOKED, `${id}.${otherPlatform}.png`);
            for (const id of ['S1', 'S2']) copyFileSync(imageOf(id), otherImageOf(id));
            await restyleSwitch(true);
            const h = humans(async (page) => {
                const adopt = page.locator('#choices button', { hasText: 'Neuen Look übernehmen' });
                await adopt.waitFor({ state: 'attached', timeout: 90000 });
                const text = await page.locator('.message:is(.question,.result,.notice)').last().textContent();
                verify('Chat: the look changed, a bold button more, the card names S1 and S2 and the headless relearning', /sieht anders aus als gelernt/.test(text)
                    && /1 button mehr mit .*font-weight 700/.test(text) && /Aussehen von S1, S2 weicht/.test(text) && /headless neu/.test(text), text.slice(0, 700));
                await clickChoice(page, adopt);
            });
            await run(native, [LOOKED, ...target], { interactive: true, onChatOpen: h.onChatOpen }).catch(() => {});
            await h.done();
            const adopted = looks();
            verify('adopted for S1 and S2: styles learned at once with the bold button, the day, no image files of any platform', adopted.every((visual) => visual?.runs === 2
                && /^\d{4}-\d{2}-\d{2}$/.test(visual.adopted ?? '') && visual.images?.[process.platform] === undefined && visual.styles.some((line) => line.includes('font-weight 700')))
                && ['S1', 'S2'].every((id) => !existsSync(imageOf(id)) && !existsSync(otherImageOf(id))), JSON.stringify(adopted));

            // The next headless runs: styles match, the images are learned again over two runs, then compared.
            const relearning = [await runQuietly(LOOKED, ['--learn', ...headless]), await runQuietly(LOOKED, ['--learn', ...headless])];
            const relearned = looks();
            verify('the next two headless runs with the new look: Exit 0, the images learned again', relearning.every(({ code }) => code === 0)
                && relearned.every((visual) => visual.images?.[process.platform] === 2 && visual.adopted === adopted[0].adopted) && existsSync(imageOf('S1')) && existsSync(imageOf('S2')),
            `${JSON.stringify(relearning)} ${JSON.stringify(relearned.map((visual) => visual.images))}`);
            const green = await runQuietly(LOOKED, headless);
            const greenStep = stepOf(newestRunOf(native, LOOKED).result, 'S2');
            verify('then a headless run compares pixels: Exit 0, S2 the same', green.code === 0 && greenStep?.visual?.verdict === 'same' && typeof greenStep.visual.ratio === 'number',
                `${green.code} ${green.note} ${JSON.stringify(greenStep?.visual)}`);
        } finally {
            undoRegression();
            await renameSwitch(false).catch(() => {});
            await restyleSwitch(false).catch(() => {});
        }

        // open @S2 --design: through S2, the design over the app; F7 hides and shows it.
        writeWith('design/n17-own.png');
        const overlay = humans(async (chat) => {
            const bench = chat.page();
            await benchBack(chat);
            await stateOf(chat, 'developing');
            const shown = () => bench.evaluate(() => !document.getElementById('design').hidden && document.getElementById('design').getAttribute('src')?.startsWith('data:image/png') === true);
            verify('open --design: the design lies over the app', await shown(), await bench.evaluate(() => document.getElementById('design')?.outerHTML.slice(0, 120)));
            const status = await appOf(bench).evaluate(() => document.getElementById('status').textContent);
            verify('open --design: through S2 (Saved)', status === 'Saved', status);
            await bench.keyboard.press('F7');
            verify('F7 hides it', !(await shown()));
            await bench.keyboard.press('F7');
            verify('F7 shows it again', await shown());
            await decide(chat, 'Beenden');
        });
        const openCode = await open(native, [`${LOOKED}@S2`, '--design', ...target], { interactive: true, onChatOpen: overlay.onChatOpen });
        verify('open --design: Exit 0, one window', openCode === 0 && await overlay.done() === 1, String(openCode));
    } finally {
        undo();
        await renameSwitch(false).catch(() => {});
        await restyleSwitch(false).catch(() => {});
        rmSync(designDir, { recursive: true, force: true });
        rmSync(join(native, 'caw/recordings', LOOKED), { recursive: true, force: true });
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${LOOKED}.yaml`), { force: true });
    }
});

// ---- N19: after a recording, the check run suggests steps for look: true by where their text comes from. S1 shows contacts
// the server sends (look.html, /api/contacts), as paragraphs: nothing masked, only the text origin rules it out. S2 is a static
// form with the list hidden: offered, none ticked. Ticking S2 and adopting writes look: true on S2 only.

const LOOK_SUGGESTED = 'rec-look';
const LOOK_PLAN = `notes: Kontakte ansehen und das leere Formular öffnen.
steps:
  - id: S1
    name: Kontakte
    do: Öffne die Kontakte.
    expect: Die Kontakte vom Server stehen da.
  - id: S2
    name: Formular
    do: Klicke auf New contact.
    expect: Das leere Formular ist offen.`;

scenario('N19', 'Look suggestion: the check run after a recording offers the static S2 (not S1 with server data) unticked; ticking S2 and adopting writes look: true only on S2', async () => {
    const agent = `A='caw agent'
${planOf(LOOK_PLAN)}
$A plan --file /tmp/p.yaml > /dev/null
$A check S1 "document.getElementById('rows').dataset.loaded==='yes' && document.querySelectorAll('#rows p').length===2"
$A click '#new'
$A check S2 "!document.getElementById('form').hidden && document.getElementById('list').hidden"
${finishOf(['S1', 'S2'])}`;
    // The description exists, the recording does not: the human lets Claude follow the plan.
    rmSync(join(native, 'caw/recordings', `${LOOK_SUGGESTED}.yaml`), { force: true });
    writeFileSync(join(native, 'caw/tests', `${LOOK_SUGGESTED}.yaml`), `id: ${LOOK_SUGGESTED}\nenvironments: [test]\nwrites: false\nstart: /look.html\n${LOOK_PLAN}\n`);
    try {
        const checkRun = async (chat) => {
            const adopt = chat.locator('#choices button', { hasText: 'Testplan übernehmen' });
            await adopt.waitFor({ state: 'attached', timeout: 180000 });
            const boxes = chat.locator('.decision fieldset.picks input[type=checkbox]');
            const offered = await boxes.evaluateAll((list) => list.map((box) => `${box.value}:${box.checked}`));
            verify('the card offers S2, not S1, none ticked', JSON.stringify(offered) === '["S2:false"]', JSON.stringify(offered));
            const explained = await chat.locator('.decision fieldset.picks').textContent().catch(() => '');
            verify('the card explains it: no server data or lists, caw cannot be sure', /keine Daten vom Server und keine Listen/.test(explained) && /Sicher ist das nicht/.test(explained), explained);
            await chat.getByRole('checkbox', { name: 'S2 Formular' }).check();
            await clickChoice(chat, adopt);
            await chat.locator('.message', { hasText: 'look: true bei S2' }).waitFor({ timeout: 30000 });
        };
        // Windows: follow the test plan, the recording (approve the plan), the check run with the card.
        const h = humans(followAndAdopt, followAndAdopt, checkRun);
        const code = await record(native, [LOOK_SUGGESTED, ...recordArgs], { interactive: true, containerCommand: ['bash', '-c', agent], onChatOpen: h.onChatOpen });
        await h.done();
        verify('N19 recording: Exit 0, recording written', code === 0 && written(LOOK_SUGGESTED), String(code));
        const steps = loadTest(native, LOOK_SUGGESTED).steps;
        verify('look: true only on S2', JSON.stringify(steps.map(({ id, look }) => `${id}:${look === true}`)) === '["S1:false","S2:true"]', JSON.stringify(steps.map(({ id, look }) => [id, look])));
        const file = readFileSync(join(native, 'caw/tests', `${LOOK_SUGGESTED}.yaml`), 'utf8');
        verify('the test file keeps its start and carries look: true in S2 only', /^start: \/look\.html$/m.test(file) && (file.match(/^ {4}look: true$/gm) ?? []).length === 1 && file.indexOf('look: true') > file.indexOf('- id: S2'), file);
        // The response values stay in memory: no text file of the check run names the server's contacts.
        const { dir } = newestRunOf(native, LOOK_SUGGESTED);
        const texts = readdirSync(dir, { recursive: true }).filter((name) => /\.(md|json|log|txt|yaml)$/.test(name)).map((name) => readFileSync(join(dir, name), 'utf8'));
        verify('no file of the check run names the served values', texts.length > 0 && texts.every((text) => !/Sampletown|Testville/.test(text)), String(texts.length));
    } finally {
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${LOOK_SUGGESTED}.yaml`), { force: true });
    }
});

// ---- N20: fixed data for a look. S1 shows the contacts look.html loads from /api/contacts, with look: true. A run with a window
// passes and offers "Daten einfrieren": the notice names the file and personal data, Anonymisieren (caw's own replacement) shows
// the anonymized data for review, Daten speichern writes caw/recordings/rec-fixed/fixed-data.json without the server's names and
// marks S1. Then the server sends other contacts: two headless runs learn the look on the frozen answers, a third compares it
// and stays green. Then the answers get a new field: the headless run names the fixed data as outdated (a warning by default).

const FIXED = 'rec-fixed';
const contactsMode = (mode) => fetch(`http://127.0.0.1:${PORT}/api/contacts-mode?mode=${mode}`, { method: 'POST' });

scenario('N20', 'Fixed data: freeze anonymized in the window, the headless look stays green on frozen data while the server data changes, a changed answer shape names the data outdated', async () => {
    const parsed = parseTest(testText(FIXED, [{ name: 'Kontakte', expect: 'Die Kontakte vom Server stehen da.', actions: [{ goto: '/look.html' }], check: "document.getElementById('rows').dataset.loaded==='yes'" }]));
    const stepOf = (result, id) => (result?.steps ?? []).find((step) => step.id === id);
    const file = join(native, 'caw/recordings', FIXED, 'fixed-data.json');
    const undo = patchJson(join(native, 'caw.config.json'), (config) => { config.visual = { maxRatio: 0.00002 }; });
    try {
        await contactsMode('fixed');
        writeTest(native, { ...parsed, id: FIXED, steps: [{ ...parsed.steps[0], look: true }] });

        // The window: the passed run offers to freeze; notice, anonymize, review, store.
        const h = humans(async (page) => {
            const freeze = page.locator('#choices button', { hasText: 'Daten einfrieren' });
            await freeze.waitFor({ state: 'attached', timeout: 90000 });
            const offer = await page.locator('.message').last().textContent();
            verify('Chat: the passed run offers to freeze the data of S1', /caw kann die Daten einfrieren/.test(offer) && /S1/.test(offer), offer.slice(0, 400));
            await clickChoice(page, freeze);
            const anonymize = page.locator('#choices button', { hasText: 'Anonymisieren' });
            await anonymize.waitFor({ state: 'attached', timeout: 30000 });
            const notice = await page.locator('.message').last().textContent();
            verify('Chat: the notice names the file, personal data, that data protection is the person\'s, and that obfuscating is no protection', /caw\/recordings\/rec-fixed\/fixed-data\.json/.test(notice)
                && /personenbezogene Daten/.test(notice) && /Den Datenschutz prüfst du/.test(notice) && /es ist kein Schutz/.test(notice), notice.slice(0, 900));
            await clickChoice(page, anonymize);
            const store = page.locator('#choices button', { hasText: 'Daten speichern' });
            await store.waitFor({ state: 'attached', timeout: 30000 });
            const review = await page.locator('.message').last().textContent();
            verify('Chat: the review shows the anonymized answer of /api/contacts, without the server\'s names', /Anonymisiert \(caws eigene Ersetzung\)/.test(review) && /GET \/api\/contacts/.test(review)
                && !/Ada Example|Sampletown|Bo Placeholder|Testville/.test(review), review.slice(0, 600));
            await clickChoice(page, store);
            await page.locator('.message', { hasText: 'eingefroren' }).waitFor({ timeout: 30000 });
        });
        const windowed = await run(native, [FIXED, ...target], { interactive: true, onChatOpen: h.onChatOpen }).catch((error) => `error ${error.message}`);
        await h.done();
        verify('the window run: Exit 0', windowed === 0, String(windowed));
        const stored = existsSync(file) ? readFileSync(file, 'utf8') : '';
        const data = stored === '' ? null : JSON.parse(stored);
        verify('fixed-data.json: anonymized by caw, steps S1, the contacts answer, no name or city of the server', data?.mode === 'anonymized' && data.by === 'built-in' && JSON.stringify(data.steps) === '["S1"]'
            && data.answers.some(({ name, body }) => name === 'GET /api/contacts' && Array.isArray(body) && body.length === 2) && !/Ada Example|Sampletown|Bo Placeholder|Testville/.test(stored), stored.slice(0, 500));
        const marked = loadTest(native, FIXED).steps[0].recording.fixed;
        verify('the recording marks S1 as compared on fixed data', marked?.mode === 'anonymized' && /^\d{4}-\d{2}-\d{2}$/.test(marked.frozen ?? ''), JSON.stringify(marked));
        const freezeRun = newestRunOf(native, FIXED).result;
        verify('the report holds the choice, not the data', freezeRun?.fixedData?.stored === true && freezeRun.fixedData.mode === 'anonymized' && freezeRun.fixedData.confirmed === false
            && !/Ada Example|Sampletown/.test(JSON.stringify(freezeRun.fixedData)), JSON.stringify(freezeRun?.fixedData));

        // Other contacts on the server: the look pass serves the frozen answers, learns the look and then compares it, green.
        await contactsMode('changed');
        const headless = ['--headless'];
        const learning = [await runQuietly(FIXED, ['--learn', ...headless]), await runQuietly(FIXED, ['--learn', ...headless])];
        const visual = loadTest(native, FIXED).steps[0].recording.visual;
        verify('two headless runs learn the look on the frozen data, with the data in its basis', learning.every(({ code }) => code === 0) && visual?.runs === 2
            && visual.images?.[process.platform] === 2 && /fixed:[0-9a-f]{12}/.test(visual.basis ?? ''), `${JSON.stringify(learning)} ${JSON.stringify(visual)}`);
        const green = await runQuietly(FIXED, headless);
        const greenRun = newestRunOf(native, FIXED).result;
        const greenStep = stepOf(greenRun, 'S1');
        verify('other data on the server, headless: Exit 0, the look the same on the frozen data, no fixed-data warning', green.code === 0 && greenStep?.visual?.verdict === 'same'
            && greenStep.visual.fixed === 'served' && !(greenRun?.warnings ?? []).some(({ type }) => type === 'fixed-data'), `${green.code} ${green.note} ${JSON.stringify(greenStep?.visual)}`);

        // A new field in the answer: the real request's shape no longer fits the frozen one.
        await contactsMode('shape');
        const outdated = await runQuietly(FIXED, headless);
        const outdatedRun = newestRunOf(native, FIXED).result;
        const warning = (outdatedRun?.warnings ?? []).find(({ type }) => type === 'fixed-data');
        verify('a new field: Exit 0 (a warning by default), the warning says the fixed data no longer fits and names the field, S1 outdated', outdated.code === 0
            && /passen nicht mehr zum Backend/.test(warning?.text ?? '') && /GET \/api\/contacts/.test(warning.text) && /Feld \[\]\.phone ist neu/.test(warning.text)
            && stepOf(outdatedRun, 'S1')?.visual?.fixed === 'outdated', `${outdated.code} ${JSON.stringify(warning)} ${JSON.stringify(stepOf(outdatedRun, 'S1')?.visual)}`);
    } finally {
        undo();
        await contactsMode('fixed').catch(() => {});
        rmSync(join(native, 'caw/recordings', FIXED), { recursive: true, force: true });
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${FIXED}.yaml`), { force: true });
    }
});
