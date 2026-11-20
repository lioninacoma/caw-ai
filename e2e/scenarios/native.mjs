// N1–N11: native Playwright locators against the fixture site e2e/native (nested frames, shadow DOM, a dialog transition, a
// virtual list, repeated rows, a select inside its label). The tests come from native/project.mjs; N1, N2 and N5 record their
// own (rec-*) with a scripted agent and a scripted human.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TESTS, testText, writeTests } from '../native/project.mjs';
import {
    appOf, benchBack, clickChoice, decide, endAction, finishOf, here, humans, lastDemonstration, loadTest, newestRunOf, open, parseTest, planOf, print, record, reproduce, run,
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
        verify('(1) report: verdict, bug report, steps, cause, screenshot, draft', /nachgestellt/.test(report) && /> Nach dem Speichern/.test(report) && /Klicke auf Save/.test(report) && /index\.html:91/.test(report) && /after-save\.png/.test(report) && /draft-test\.yaml/.test(report), report.slice(0, 600));
        verify('(1) report names the action by its element, never a reference', /^- click button "Save"/m.test(report), report.split('\n').filter((line) => line.startsWith('- click')).join(' | '));
        const draft = readFileSync(join(dir, 'draft-test.yaml'), 'utf8');
        let valid = true;
        try { parseTest(draft); } catch { valid = false; }
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
        verify('(4) the draft notes name the reference', /Referenz TCK-1234/.test(readFileSync(join(fourth.dir, 'draft-test.yaml'), 'utf8')));
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

// ---- N14: target designs. S2 of n9-shadow ends on the page with "Errands" and Save; a design that matches, one that does not,
// an image, and the needs of a pending S3.

const DESIGNED = 'rec-design';
// The fixture's own font and a default button: the same controls and styles as the site after S2. Free text and the rest of the
// page are left out on purpose: what only the app has does not fail.
const MATCHING = '<!doctype html><html lang="en"><head><style>body{font:14px system-ui,sans-serif;margin:16px}</style></head><body><main><h1>Errands</h1><p>Sample text</p><button>Save</button></main></body></html>';
const OTHER = '<!doctype html><html lang="en"><head><style>body{font:14px system-ui,sans-serif;margin:16px}button{background:#e5533a;color:#fff}</style></head><body><main><h1>Errands</h1><button>Save</button><button>Export</button></main></body></html>';
// A PNG header (signature and IHDR, 390×844): the run only looks at the extension, caw_design checks the bytes.
const PNG_390 = (() => {
    const bytes = Buffer.alloc(45);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(390, 16);
    bytes.writeUInt32BE(844, 20);
    return bytes;
})();

scenario('N14', 'Target design: a matching .html passes, another fails S2 with kind design and the replay goes on, a .png is not judged; needs of the pending S3', async () => {
    const designDir = join(native, 'caw/design');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'n14-match.html'), MATCHING);
    writeFileSync(join(designDir, 'n14-other.html'), OTHER);
    writeFileSync(join(designDir, 'n14.png'), PNG_390);
    const parsed = parseTest(testText(DESIGNED, TESTS['n9-shadow']));
    const withDesign = (file, extra = []) => writeTest(native, { ...parsed, id: DESIGNED, steps: [parsed.steps[0], { ...parsed.steps[1], design: file }, ...extra] });
    const stepOf = (result, id) => (result?.steps ?? []).find((step) => step.id === id);
    try {
        withDesign('design/n14-match.html', [{ id: 'S3', name: 'Exportieren', do: 'Exportiere.', expect: 'Die Datei ist da.', needs: ["getByRole('button', { name: 'Save', exact: true })"] }]);
        const met = await runQuietly(DESIGNED);
        const first = newestRunOf(native, DESIGNED).result;
        verify('matching design: Exit 0, verdict met', met.code === 0 && stepOf(first, 'S2')?.design?.verdict === 'met', `${met.code} ${met.note} ${JSON.stringify(stepOf(first, 'S2')?.design)}`);
        verify('the app frame is only extra', (stepOf(first, 'S2')?.design?.extra ?? []).some((line) => /Orders|Customers|Add/.test(line)), JSON.stringify(stepOf(first, 'S2')?.design?.extra));
        verify('needs of S3 all there: ready to record', first?.needs?.step === 'S3' && first.needs.ready === true, JSON.stringify(first?.needs));

        withDesign('design/n14-other.html', [{ id: 'S3', name: 'Exportieren', do: 'Exportiere.', expect: 'Die Datei ist da.', needs: ["getByRole('button', { name: 'Export', exact: true })"] }]);
        const notMet = await runQuietly(DESIGNED);
        const second = newestRunOf(native, DESIGNED).result;
        const s2 = stepOf(second, 'S2');
        verify('other design: Exit 1, S2 fails with kind design', notMet.code === 1 && s2?.status === 'fail' && s2.kind === 'design', `${notMet.code} ${JSON.stringify(s2)}`);
        verify('names the missing button and the differing style', /Fehlt: .*button "Export"/.test(notMet.note) && /button "Save": background-color .* → /.test(notMet.note), notMet.note);
        verify('needs of S3 missing: named, not ready', second?.needs?.ready === false && /Export/.test(JSON.stringify(second.needs.missing)), JSON.stringify(second?.needs));

        withDesign('design/n14.png');
        const image = await runQuietly(DESIGNED);
        const third = newestRunOf(native, DESIGNED).result;
        verify('image design: Exit 0, not judged', image.code === 0 && stepOf(third, 'S2')?.design?.verdict === 'image', `${image.code} ${JSON.stringify(stepOf(third, 'S2')?.design)}`);
    } finally {
        rmSync(designDir, { recursive: true, force: true });
        for (const dir of ['caw/tests', 'caw/recordings']) rmSync(join(native, dir, `${DESIGNED}.yaml`), { force: true });
    }
});
