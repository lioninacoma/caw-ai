// Shared parts of the e2e (native-e2e.mjs): result file, scenarios and checks, the fake portal, the native fixture site and the
// human at the workbench. The scripts stand in for Claude in the sandbox and for the human at the chat; Claude never runs.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portTaken } from './infra.mjs';

// Runs without `interactive: true` behave like CI: no chat. The chat is no longer tied to the terminal.
process.env.CI ??= '1';
// The language of a group's checks (`language`, default English); child processes inherit it. Set again per group.
process.env.CAW_LANG = 'en';
export const here = dirname(fileURLToPath(import.meta.url));
// Never write personal settings (e.g. animations off) to the real user folder.
process.env.CAW_AI_HOME = join(here, '.caw-home');

const prefsFile = join(process.env.CAW_AI_HOME, 'prefs.json');
export const prefs = () => (existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, 'utf8')) : {});
export const setPrefs = (values) => {
    mkdirSync(process.env.CAW_AI_HOME, { recursive: true });
    writeFileSync(prefsFile, JSON.stringify({ ...prefs(), ...values }));
};
export const clearPrefs = () => rmSync(prefsFile, { force: true });
/** The token notice only appears in the scenario that checks it; otherwise it would precede every Claude start. */
export const quietTokens = () => setPrefs({ tokenNotice: 'off' });
quietTokens();

export const { run, record, open, lastDemonstration } = await import('../src/host/commands.mjs');
export const { loadTest, parseTest, renderTest, stepHash, writeTest } = await import('../src/host/test-file.mjs');
export const { setLanguage } = await import('../src/shared/i18n.mjs');

// Results also go to a separate file: agent processes inherit stdout. When it is redirected to a file, on Windows they write at
// their own offset and overwrite lines of this script. Only this file counts (watchdog.ps1 reads its RESULT line).
const results = process.env.CAW_E2E_RESULT ?? join(here, 'result.log');
writeFileSync(results, '');
export const print = (line) => {
    console.log(line);
    appendFileSync(results, `${line}\n`);
};
export const tally = { ok: 0, fail: 0, skip: 0 };
export const verify = (name, ok, detail = '') => {
    tally[ok ? 'ok' : 'fail'] += 1;
    print(`${ok ? 'OK  ' : 'FAIL'} ${name} ${detail}`);
};
export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A TCP port nothing listens on right now. */
export const freePort = () => new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});
/** Waits until something answers on 127.0.0.1:port. */
export const waitForPort = async (port, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portTaken(port)) return;
        await sleep(200);
    }
    throw new Error(`nothing listens on ${port}`);
};

/** Restores a file at the end of a scenario as it was before (or removes it). */
export const keep = (path) => {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    return () => { if (before === null) rmSync(path, { force: true }); else writeFileSync(path, before); };
};
/** A config file changed for one scenario; returns the undo. */
export const patchJson = (path, change) => {
    const undo = keep(path);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    change(value);
    writeFileSync(path, JSON.stringify(value, null, 4));
    return undo;
};

/** The newest run of a test in a project: result.json, report.md and its folder. */
export const newestRunOf = (root, id) => {
    const dir = join(root, '.caw/runs');
    // Run folders are <time>Z-<test>; a demonstration is <time>Z-<test>-demonstration.
    const [latest] = readdirSync(dir).filter((name) => name.endsWith(`Z-${id}`)).sort().reverse();
    const path = join(dir, latest);
    const read = (name) => (existsSync(join(path, name)) ? readFileSync(join(path, name), 'utf8') : '');
    return { result: JSON.parse(read('result.json') || 'null'), report: read('report.md'), dir: path };
};
export const runDirsOf = (root, id) => (existsSync(join(root, '.caw/runs')) ? readdirSync(join(root, '.caw/runs')).filter((name) => name.endsWith(`Z-${id}`)) : []);

/** Starts a node script as a server and waits for its port; returns the process. */
export const startServer = async (script, args, { cwd, port }) => {
    // Another server there (a leftover of an earlier run) would answer instead and the checks would read the wrong state.
    if (await portTaken(port)) throw new Error(`port ${port} is already in use: stop the process listening there`);
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'ignore' });
    await waitForPort(port);
    return child;
};

// ---- The human at the workbench

export const stateOf = (page, name) => page.locator(`body[data-state=${name}]`).waitFor({ timeout: 90000 });
// After a handover (open) the workbench starts in "App only" and hides steps and chat; the human brings them back
// with F8 (here the button in the solo bar) to work in the chat.
export const benchBack = async (chat) => {
    const bench = chat.page();
    await bench.locator('body.solo').waitFor({ state: 'attached', timeout: 90000 });
    await bench.locator('.soloBar [data-solo]').click();
    await bench.locator('body:not(.solo)').waitFor({ state: 'attached', timeout: 10000 });
};
/** A new test asks how it is made: the human shows it. */
export const showMyself = async (page) => {
    await stateOf(page, 'choosing');
    await page.locator('#choices button', { hasText: 'Selbst vorführen' }).click({ timeout: 90000 });
    await stateOf(page, 'showing');
};
export const approve = async (page) => {
    await stateOf(page, 'planning');
    await page.locator('#approve').click();
};
// Closing is labelled "Ohne Beheben beenden" or "Lauf beenden" depending on the situation.
export const decide = (page, label) => page.locator('#choices button', { hasText: label === 'Close' ? /Ohne Beheben beenden|Lauf beenden/ : label }).click({ timeout: 90000 });
// Discarding a draft needs a second confirming click ("Wirklich verwerfen?").
export const discard = async (page) => {
    await decide(page, 'Entwurf verwerfen');
    await page.locator('#choices button.sure').click({ timeout: 10000 });
};
/** The workbench page of a chat frame (also behind asHuman), or the page itself. */
export const benchOf = (given) => (typeof given.frames === 'function' ? given : given.page());
/** The application's frame in the workbench. */
export const appOf = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
/** A screenshot of the workbench page; a chat frame belongs to it. */
export const shootBench = (given, path) => benchOf(given).screenshot({ path });
export const shoot = async (chat, name) => {
    const page = benchOf(chat);
    await page.waitForTimeout(300);
    await shootBench(page, join(here, `${name}.png`));
};

// Everything runs in the workbench as in real use: the chat is a frame next to the application iframe. To the handlers the chat
// frame looks like a page whose first page in the context is the application.
const BENCH_ONLY = new Set(['screenshot', 'emulateMedia', 'close', 'bringToFront', 'keyboard', 'mouse', 'setViewportSize', 'isClosed']);
export const asHuman = (chat) => {
    if (typeof chat.page !== 'function') return chat;
    const bench = chat.page();
    const app = () => appOf(bench);
    return new Proxy(chat, {
        get(target, prop) {
            if (prop === 'context') return () => ({ pages: () => [app()], newPage: () => bench.context().newPage(), grantPermissions: (...args) => bench.context().grantPermissions(...args) });
            const source = BENCH_ONLY.has(prop) ? bench : target;
            const value = source[prop];
            return typeof value === 'function' ? value.bind(source) : value;
        },
    });
};
/** One handler per chat window, in order; done() resolves with the number of windows that opened. */
export const humans = (...windows) => {
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

// ---- The agent scripts (bash in the sandbox, `caw-ai` stands in for Claude's commands)

export const count = (command, code, label) => `( ${command} ) 2>&1 | grep -c '${code}' | sed 's/^/${label}=/'`;
export const planOf = (text) => `cat > /tmp/p.yaml <<'EOF'\n${text}\nEOF`;
export const tag = 'TAG=$($A task | grep -o \'CAW-[0-9]*\' | head -1)';
export const finishOf = (ids, omit = '[]') => `echo '{"expectations":[${ids.map((id) => `{"id":"${id}","status":"pass","evidence":{"type":"eval","value":"ok"}}`).join(',')}],"omit":${omit}}' > /tmp/e.json; $A finish --file /tmp/e.json; echo "finish Exit=$?"`;

// ---- Scenarios

/** Catalogue ids whose checks live in older scenarios: running the id runs those (locator robustness, kept layers, the matrix). */
export const CATALOGUE_ALIASES = {
    U1: ['N6', 'N7', 'N8', 'N9', 'N10d', 'N10e', 'N11'],
    U2: ['N2', 'N3'],
    H2: ['N14'],
    // Recording: by demonstration and Claude (portal A, refs N1, demonstration N2), by plan in the session with the portability
    // and write checks (S2), the same recording on an environment caw starts (S4).
    S1: ['A', 'K2', 'N1', 'N2', 'S2', 'S4'],
    // Triage and repair: offer (C), repair one step (D, H), run --fix (O, P), assessment (X, Y), backend faults (D3), explanations (N11).
    S5: ['C', 'D', 'H', 'O', 'P', 'X', 'Y', 'D3', 'N11'],
    // Re-recording from a step: stale (B), record @S3 (E, Q, N5), failing check run (F), unchanged plan (I).
    S6: ['B', 'E', 'F', 'I', 'Q', 'N5'],
    // Reaching a state: open @S3 (N4), developing there (2), passed run handed over (R).
    S7: ['N4', '2', 'R'],
    // SSR: hydration-aware sign-in on the Next dev server and production build (N14); a POST while recording promotes writes (S2).
    H1: ['N14', 'S2'],
};

/**
 * Runs the chosen scenarios one after another, in the given order. A scenario is { id, title, body, group, gated }; a group is
 * { setup, teardown, language }: set up before its first scenario and torn down before the next group starts (servers of
 * different groups may share a port). `language` is the UI language its checks read ('en' unless given). A scenario with
 * `gated: '<open point>'` waits for an owner decision: it is counted as SKIP and does not run. `optIn: 'CAW_E2E_…'` runs only when
 * that variable is "1" (e.g. CAW_E2E_LAN for a listener on the network interface), otherwise SKIP. A failing scenario is
 * reported and the next one runs.
 * @param filter ids separated by commas or spaces (e.g. "A,N1"); a trailing * matches a prefix ("N*"); empty runs all
 */
export const runScenarios = async (scenarios, filter = '') => {
    const wanted = filter.split(/[\s,]+/).filter((id) => id !== '').flatMap((id) => CATALOGUE_ALIASES[id] ?? [id]);
    const matches = (id, want) => (want.endsWith('*') ? id.startsWith(want.slice(0, -1)) : id === want);
    const unknown = wanted.filter((want) => !scenarios.some(({ id }) => matches(id, want)));
    if (unknown.length > 0) verify('Known scenario ids', false, `${unknown.join(', ')} (known: ${scenarios.map(({ id }) => id).join(' ')})`);
    let current = null;
    const leave = async () => {
        await current?.teardown?.().catch((error) => verify('Teardown', false, error.stack));
        current = null;
    };
    try {
        for (const scenario of scenarios.filter(({ id }) => wanted.length === 0 || wanted.some((want) => matches(id, want)))) {
            print(`##### ${scenario.id} ${scenario.title}`);
            if (scenario.gated !== undefined) {
                tally.skip += 1;
                print(`SKIP ${scenario.id} gated by ${scenario.gated}`);
                continue;
            }
            if (scenario.optIn !== undefined && process.env[scenario.optIn] !== '1') {
                tally.skip += 1;
                print(`SKIP ${scenario.id} needs ${scenario.optIn}=1`);
                continue;
            }
            try {
                if (scenario.group !== current) {
                    await leave();
                    current = scenario.group ?? null;
                    const language = current?.language ?? 'en';
                    process.env.CAW_LANG = language;
                    setLanguage(language);
                    await current?.setup?.();
                }
                await scenario.body();
            } catch (error) {
                verify(`Scenario ${scenario.id}`, false, error.stack);
            }
        }
    } finally {
        await leave();
    }
};
