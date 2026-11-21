#!/usr/bin/env node
// Records the README media (docs/media/*.webp) from the Errand example, in English, with fictitious data only.
//
//   node scripts/capture-media.mjs [--scene main|stills|all|plan|triage|fix|reproduce|states|develop] [--parts <a,b>]
//                                  [--media <dir>] [--out <dir>] [--lint]
//
// main is the README video (demo.webp), filmed by one camera across its parts:
//   breaks     a regression in the app fails S1 of first-errand; caw's assessment says app; the agent finds the cause,
//              "Apply change" writes the fix, the server restarts on its own (node --watch), "Test again" is green
//   develop    open first-errand@S3, /element on the disabled "Add todo", the agent answers with file and line
//   reproduce  caw reproduce of the search bug, the end card says "Reproduced"
//   create     a new test described in the chat: the plan, approved, recorded, the check run, adopted (short)
//   design     S4 pending with a target design: the run names it ready to record, record @S4, the check run is green
//   audit      caw audit names the check S4 got in place of the old one
//   ci         the regression again: run --all headless, JUnit types the failure by caw's assessment (app)
// --parts runs only some of them, to try one (audit finds the changed check only after design). The terminal parts show the
// real output of the command, run in the project.
// The stills come from the same flows, in windows of the video's size, so they have its zoom: plan (create), triage and fix
// (breaks), reproduce, states (the F1 dialog), develop. --media writes the WebP files elsewhere than docs/media. --lint keeps
// the example's design tokens (see project()).
//
// No scene uses a real agent: scripts/media-agent.mjs plays its part with the same plan, clicks and answers every time, so the
// media come out the same on every run and cost no tokens. The video runs in real time (not sped up); left out are the waits
// between windows and the replays before the moment a part is about (each a cut), with the logo at the end. Needs ffmpeg on
// PATH and Chrome.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BREAK } from './media-agent.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(repo, 'bin/caw.mjs');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const scene = option('--scene', 'all');
const media = option('--media', join(repo, 'docs/media'));
const out = option('--out', join(tmpdir(), 'caw-media'));
// --lint keeps the example's design tokens (see project()).
const LINT = args.includes('--lint');
const PARTS = ['breaks', 'develop', 'reproduce', 'create', 'design', 'audit', 'ci'];
/** Each still and the flow it comes from. */
const STILLS = { plan: 'create', triage: 'breaks', fix: 'breaks', reproduce: 'reproduce', states: 'states', develop: 'develop' };
const SCENES = ['main', 'stills', 'all', ...Object.keys(STILLS)];
if (!SCENES.includes(scene)) throw new Error(`--scene: one of ${SCENES.join(', ')}`);
const parts = option('--parts', PARTS.join(',')).split(',');
if (parts.some((part) => !PARTS.includes(part))) throw new Error(`--parts: some of ${PARTS.join(', ')}`);
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is not on PATH');

// The README shows the English UI. Personal settings in a folder of their own: no token notice, the system's light or dark mode.
process.env.CAW_LANG = 'en';
delete process.env.CI;
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-media-home-'));
// The steps column stays open: below 1500 px the workbench folds it on its own, and the media are filmed narrower than that.
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off', steps: 'open', chat: 'open' }));
// The example's fictitious account.
process.env.CAW_USER_USER = 'demo';
process.env.CAW_USER_PASSWORD = 'demo';

const { open, record, reproduce, run } = await import('../src/host/commands.mjs');
const { LONG_NAME } = await import('../src/shared/brand.mjs');
const { MODE_SCRIPT, logo, modeAttr, styleSheet } = await import('../src/host/style.mjs');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const freePort = () => new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

/**
 * The example in a folder of its own, so the repository stays as it is, with its server on a free port. The server runs with
 * node --watch: a change to server.mjs (a regression put in, "Apply change") restarts it, as a dev server would.
 * @param git the copy as a Git repository with one commit, for caw audit
 * @returns { dir, restart(patch), watch(), stop() }
 */
const project = async ({ git = false } = {}) => {
    // The header shows the project's folder: errand, as in the repository.
    const dir = join(mkdtempSync(join(tmpdir(), 'caw-media-')), 'errand');
    // Only what is checked in: tests someone tried locally in the example must not show up in the media.
    const files = spawnSync('git', ['ls-files', '-z', 'examples/errand'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    if (files.length === 0) throw new Error('git ls-files found no files in examples/errand');
    // Each tracked file and every folder above it.
    const keep = new Set(files.flatMap((file) => {
        const paths = [];
        for (let path = join(repo, file); path.length > repo.length; path = dirname(path)) paths.push(path);
        return paths;
    }));
    cpSync(join(repo, 'examples/errand'), dir, { recursive: true, filter: (path) => keep.has(path) });
    // Without the example's design tokens: their lint warns about the example's own colours on every screen, and every card
    // of the media would list those warnings (and a recording's check run would ask the agent about them).
    if (!LINT) rmSync(join(dir, 'caw/design/tokens.json'), { force: true });
    const port = await freePort();
    const config = join(dir, 'caw.config.json');
    writeFileSync(config, readFileSync(config, 'utf8').replace('http://localhost:4174', `http://localhost:${port}`));
    if (git) {
        // A fictitious author of its own, only in this copy.
        const gitIn = (...more) => spawnSync('git', ['-c', 'user.name=Errand', '-c', 'user.email=errand@example.invalid', '-c', 'core.autocrlf=false', ...more], { cwd: dir, stdio: 'ignore' });
        gitIn('init', '-q', '-b', 'main');
        writeFileSync(join(dir, '.gitignore'), '.caw/\nout/\n');
        gitIn('add', '-A');
        if (gitIn('commit', '-q', '-m', 'Errand').status !== 0) throw new Error('git commit failed in the copy');
    }
    const serverFile = join(dir, 'server.mjs');
    const original = readFileSync(serverFile, 'utf8');
    const server = spawn(process.execPath, ['--watch', 'server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Every start prints "Errand on …"; node --watch restarts on each change of server.mjs.
    let starts = 0;
    let waiters = [];
    server.stdout.setEncoding('utf8').on('data', (chunk) => {
        starts += chunk.split('Errand on').length - 1;
        waiters = waiters.filter(({ count, resolve }) => (starts >= count ? (resolve(), false) : true));
    });
    server.stderr.resume();
    const started = (count, what) => new Promise((resolve, reject) => {
        if (starts >= count) return resolve();
        const timer = setTimeout(() => reject(new Error(`the example server did not ${what} on ${port}`)), 15000);
        waiters.push({ count, resolve: () => { clearTimeout(timer); resolve(); } });
        return undefined;
    });
    /** @returns a function that waits for the next start after now */
    const watch = () => {
        const count = starts + 1;
        return () => started(count, 'restart');
    };
    const stop = () => {
        // On Windows killing node --watch would leave its child, the server, running.
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
        else server.kill();
    };
    try {
        await started(1, 'start');
    } catch (error) {
        stop();
        throw error;
    }
    return {
        dir,
        watch,
        stop,
        /** server.mjs as checked in, or changed by `patch`; waits until the server runs it. */
        restart: async (patch) => {
            const text = patch === undefined ? original : patch(original);
            if (readFileSync(serverFile, 'utf8') === text) return;
            const restarted = watch();
            writeFileSync(serverFile, text);
            await restarted();
        },
    };
};

// The workbench: the chat is a frame of it, the application another one.
const benchOf = (chat) => chat.page();
const appOf = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
// The scripted agent answers within seconds; the first run may wait for Chrome.
const AGENT_MS = 120000;
const stateOf = (chat, name, timeout = AGENT_MS) => chat.locator(`body[data-state=${name}]`).waitFor({ timeout });
/** A choice in the chat by its label: beside the primary one, or behind "More". */
const choose = async (chat, label) => {
    const button = chat.locator('#choices button', { hasText: label });
    await button.waitFor({ state: 'attached', timeout: AGENT_MS });
    if (!(await button.isVisible()) && await chat.locator('#choicesMore').isVisible()) await chat.locator('#choicesMore').click();
    await button.click();
};
/** The end card of a run, then the window is closed. */
const ended = async (chat, ms) => {
    await chat.locator('#next.on').waitFor({ timeout: AGENT_MS });
    await sleep(ms);
    await benchOf(chat).close();
};
/** After open hands over the workbench keeps steps and chat: waits until the chat is the human's. */
const handedOver = async (chat) => {
    const bench = benchOf(chat);
    await chat.locator('body[data-state=developing]').waitFor({ state: 'attached', timeout: 120000 }).catch(async (error) => {
        await bench.screenshot({ path: join(out, 'stuck.png') }).catch(() => {});
        throw new Error(`the workbench did not hand over (see ${join(out, 'stuck.png')}): ${error.message.split('\n')[0]}`);
    });
    await bench.locator('body:not(.solo)').waitFor({ state: 'attached', timeout: 10000 });
};

// caw waits for onChatOpen to return: the human acts in the background, like the e2e's humans().
let pending = [];
const background = (handler) => (chat) => {
    pending.push(handler(chat).catch(async (error) => {
        const shot = join(out, `failed-${Date.now()}.png`);
        await benchOf(chat).screenshot({ path: shot }).catch(() => {});
        console.log(`the human failed, see ${shot}: ${error.message.split('\n')[0]}`);
        await benchOf(chat).close().catch(() => {});
        throw error;
    }));
};
/** After a part: every window's human is done; the first error, if any, ends the scene. */
const settled = async () => {
    const all = pending;
    pending = [];
    await Promise.all(all);
};

/**
 * The workbench's size in CSS pixels, for the video and the stills alike: small, so text comes out large in the README column,
 * but wide enough for the three columns (steps, app, chat; from 1000) and the key bar on one line (from 1120); the app in its
 * pane gets narrower. On a screen with a higher pixel density the frames are scaled down to it, never up.
 */
const PAGE = { width: 1140, height: 712 };
const VIDEO = PAGE;
/** At most this many frames a second. */
const FPS = 12;
/**
 * caw opens the window maximized; on a large screen the workbench would be tiny in the README. A small window instead (PAGE in
 * CSS pixels). Only the window changes, no emulation, which would fight with Playwright's own.
 */
const fitWindow = async (bench) => {
    const own = await bench.context().newCDPSession(bench);
    const { windowId } = await own.send('Browser.getWindowForTarget');
    await own.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    // Outer size = page plus the browser's frame; measured once, then corrected.
    await own.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: PAGE.width, height: PAGE.height } });
    await sleep(300);
    const inner = await bench.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
    await own.send('Browser.setWindowBounds', { windowId, bounds: { width: 2 * PAGE.width - inner.width, height: 2 * PAGE.height - inner.height } });
    await bench.waitForFunction(({ width, height }) => globalThis.innerWidth === width && globalThis.innerHeight === height, PAGE, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    // The workbench follows the system's light or dark mode; the terminal and the closing card show the same.
    scheme = await bench.evaluate(() => (globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    return own;
};
/** The mode the workbench showed last (headless Chrome alone would always be light). */
let scheme = 'light';

const webp = (input, name) => {
    mkdirSync(media, { recursive: true });
    const target = join(media, `${name}.webp`);
    const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, target], { stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
    console.log(`written: ${target}`);
};
/** A still image as WebP, at the window's size (fitWindow). */
const still = async (bench, name) => {
    const png = join(out, `${name}.png`);
    await bench.waitForTimeout(500);
    await bench.screenshot({ path: png });
    webp(['-i', png, '-c:v', 'libwebp', '-quality', '85'], name);
};

/**
 * Films whichever workbench is current, in real time: screenshots in a loop at the screen's resolution, each frame lasting
 * until the next. Nothing is sped up; only waiting is left out: hold() stops filming until the next window, and the step from
 * one window to the next is a cut. insert() adds frames made elsewhere (the terminal), each with its own duration. stop()
 * appends the logo and writes the WebP.
 */
const film = (name) => {
    const dir = join(out, `${name}-frames`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const frames = [];
    let session = null;
    let filmed = null;
    /** Stops filming; with a workbench only while that one is filmed. */
    const hold = async (bench) => {
        if (session === null || (bench !== undefined && bench !== filmed)) return;
        const was = session;
        session = null;
        filmed = null;
        await was.looping;
        frames.push({ cut: true });
    };
    return {
        dir,
        hold,
        follow: async (bench) => {
            await hold();
            const own = await fitWindow(bench);
            session = own;
            filmed = bench;
            own.looping = (async () => {
                while (session === own) {
                    const at = Date.now();
                    const shot = await own.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 }).catch(() => null);
                    if (session !== own || shot === null) break;
                    const path = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
                    writeFileSync(path, Buffer.from(shot.data, 'base64'));
                    frames.push({ path, at: at / 1000 });
                    await sleep(Math.max(0, 1000 / FPS - (Date.now() - at)));
                }
            })();
        },
        insert: async (made) => {
            await hold();
            frames.push(...made, { cut: true });
        },
        stop: async () => {
            await hold();
            if (!frames.some((frame) => frame.cut === undefined)) return 0;
            // Each frame until the next; at a cut between windows 0.4 s, and no frame longer than 2.5 s.
            const timed = [];
            frames.forEach((frame, index) => {
                if (frame.cut) return;
                if (frame.seconds !== undefined) {
                    timed.push(frame);
                    return;
                }
                const next = frames[index + 1];
                const seconds = next === undefined || next.cut || next.at === undefined ? 0.4 : Math.min(next.at - frame.at, 2.5);
                timed.push({ path: frame.path, seconds });
            });
            timed.push(...await outro(dir));
            const slash = (path) => path.replaceAll('\\', '/');
            const list = join(dir, 'frames.txt');
            writeFileSync(list, `ffconcat version 1.0\n${timed.map(({ path, seconds }) => `file '${slash(path)}'\nduration ${seconds.toFixed(3)}\n`).join('')}file '${slash(timed.at(-1).path)}'\n`);
            webp(['-f', 'concat', '-safe', '0', '-i', list, '-fps_mode', 'vfr', '-vf', `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos`, '-loop', '0', '-c:v', 'libwebp_anim', '-quality', '70'], name);
            return timed.length;
        },
    };
};
/** For the stills: every window gets the video's size, nothing is filmed. */
const NO_FILM = { hold: async () => {}, follow: async (bench) => { await fitWindow(bench); }, insert: async () => {} };

/** A page at the film's size in a Chrome of its own: the outro and the terminal. */
const card = async (work) => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
        return await work(await browser.newPage({ viewport: { width: VIDEO.width, height: VIDEO.height }, colorScheme: scheme }));
    } finally {
        await browser.close();
    }
};
const page = (css, body) => `<!doctype html><html${modeAttr('system')}><head><meta charset="utf-8"><script>${MODE_SCRIPT}</script><style>${styleSheet()}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text)}${css}</style></head><body>${body}</body></html>`;

/**
 * The closing card: the logo and the name, the cursor blinking a few times, at the film's size.
 * @returns frames with their duration
 */
const outro = (dir) => card(async (shown) => {
    await shown.setContent(page(`body{display:flex;align-items:center;justify-content:center;gap:40px}
.name{font:600 84px/1 var(--font);letter-spacing:-.04em;display:flex;align-items:center}
.cursor{display:inline-block;width:.08em;height:.9em;margin-left:.08em;background:var(--accent)}
.off .cursor{visibility:hidden}
.long{margin-top:18px;font:400 22px/1 var(--font);color:var(--muted)}`, `${logo({ size: 120 })}<div><div class="name">caw<span class="cursor"></span></div><div class="long">${LONG_NAME}</div></div>`));
    await shown.evaluate(() => globalThis.document.fonts.ready);
    const shots = [];
    for (const [index, off] of [false, true].entries()) {
        await shown.evaluate((hide) => globalThis.document.body.classList.toggle('off', hide), off);
        const path = join(dir, `outro-${index}.jpg`);
        await shown.screenshot({ path, type: 'jpeg', quality: 95 });
        shots.push(path);
    }
    // The cursor blinks three times, then stays on.
    return [...[0, 1, 0, 1, 0, 1].map((index) => ({ path: shots[index], seconds: 0.55 })), { path: shots[0], seconds: 2.5 }];
});

/** caw in the project, as the terminal shows it: its plain output (no colours in a pipe). */
const cawIn = (dir, ...more) => {
    const done = spawnSync(process.execPath, [BIN, ...more], { cwd: dir, encoding: 'utf8', env: process.env });
    return { code: done.status, text: `${done.stdout}${done.stderr}`.replace(/\r\n/g, '\n').trimEnd() };
};
let terminals = 0;
/**
 * A terminal at the film's size: each command is typed, then its real output shows and stays for `hold` seconds.
 * @param shell [{ command, output, hold }], command as typed (without the prompt), output as text
 * @returns frames with their duration
 */
const terminal = (dir, shell) => card(async (shown) => {
    const esc = (text) => text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    await shown.setContent(page(`body{display:flex;align-items:center;justify-content:center}
.term{width:calc(100% - 64px);height:calc(100% - 64px);box-sizing:border-box;border:1px solid var(--line);border-radius:var(--r3);background:var(--panel);box-shadow:var(--shadow-lg);display:flex;flex-direction:column;overflow:hidden}
.bar{display:flex;gap:7px;padding:11px 14px;border-bottom:1px solid var(--line)}.bar i{width:11px;height:11px;border-radius:50%;background:var(--line2)}
pre{flex:1;margin:0;padding:16px 20px;font:400 15px/1.5 var(--font-mono);white-space:pre-wrap;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}#screen{white-space:pre-wrap}
.p{color:var(--accent-text)}.c{color:var(--text)}.o{color:var(--muted)}.k{display:inline-block;width:.6em;height:1.1em;vertical-align:text-bottom;background:var(--accent)}`,
    '<div class="term"><div class="bar"><i></i><i></i><i></i></div><pre><div id="screen"></div></pre></div>'));
    await shown.evaluate(() => globalThis.document.fonts.ready);
    const frames = [];
    let done = '';
    const shoot = async (html, seconds) => {
        await shown.evaluate((text) => { globalThis.document.getElementById('screen').innerHTML = text; }, html);
        terminals += 1;
        const path = join(dir, `term-${String(terminals).padStart(4, '0')}.jpg`);
        await shown.screenshot({ path, type: 'jpeg', quality: 92 });
        frames.push({ path, seconds });
    };
    for (const { command, output, hold } of shell) {
        // Typed in a few strokes, a short pause, then the output.
        const strokes = 8;
        for (let stroke = 1; stroke <= strokes; stroke += 1) {
            const typed = command.slice(0, Math.ceil((command.length * stroke) / strokes));
            await shoot(`${done}<span class="p">$ </span><span class="c">${esc(typed)}</span><span class="k"></span>`, 0.07);
        }
        await shoot(`${done}<span class="p">$ </span><span class="c">${esc(command)}</span>`, 0.5);
        done += `<span class="p">$ </span><span class="c">${esc(command)}</span>\n<span class="o">${esc(output)}</span>\n\n`;
        await shoot(`${done}<span class="p">$ </span><span class="k"></span>`, hold);
    }
    return frames;
});

// The agent's part: always the same plan, clicks and answers (see the script), as the local agent on this machine.
const script = (mode) => [process.execPath, join(repo, 'scripts/media-agent.mjs'), mode];
/**
 * The agent for every way a flow may start one: the run's agent (recording, fixing, reproducing), advice and conversation.
 * Each one caw does not get from here would be the real agent, e.g. advice caw starts on its own after warnings: the slots
 * not named run media-agent's idle mode, which reads the task and stops.
 * @param modes { run, advise, talk } media-agent modes
 */
const agent = ({ run: runs = 'idle', advise = 'idle', talk = 'idle' } = {}) => ({ containerCommand: script(runs), adviseCommand: script(advise), talkCommand: script(talk) });
const LOCAL = ['--agent', 'local'];
const ENV = ['--env', 'local'];

/**
 * The flows. Each gets the project, the camera (or NO_FILM) and `shot(name, bench)`, which takes a still if that one is wanted.
 * `windows(handler)` gives caw's onChatOpen: the camera follows each new window, then the human acts in the background with
 * handler(chat, number of the window in this flow).
 */
const flows = {
    // A regression in the app fails S1 (HTTP 500 for long titles). caw's assessment: the app. The agent finds the cause,
    // "Apply change" writes the fix, the server restarts on its own, "Test again" replays the test green.
    breaks: async (p, { cam, windows, shot }) => {
        await p.restart(BREAK);
        await run(p.dir, ['first-errand', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent({ advise: 'cause' }),
            onChatOpen: windows(async (chat, which) => {
                const bench = benchOf(chat);
                if (which > 1) {
                    // The new run with the fixed app, in a window of its own: its start, then a cut to its end card.
                    await sleep(1500);
                    await cam.hold(bench);
                    await chat.locator('#next.on').waitFor({ timeout: AGENT_MS });
                    await cam.follow(bench);
                    await ended(chat, 2000);
                    return;
                }
                // The failure card: the step, the reason, the assessment with its findings.
                await chat.locator('#choices button', { hasText: 'find the cause' }).waitFor({ timeout: AGENT_MS });
                await sleep(2500);
                await shot('triage', bench);
                await choose(chat, 'find the cause');
                // The agent's answer and its code change as a card with the diff.
                await chat.locator('#choices button', { hasText: 'Apply change' }).waitFor({ timeout: AGENT_MS });
                await sleep(3000);
                await shot('fix', bench);
                const restarted = p.watch();
                await choose(chat, 'Apply change');
                await restarted();
                await sleep(1200);
                // This window closes, the new run opens the next one.
                await choose(chat, 'Test again');
            }),
        });
    },
    // open @S3, a picked element and the agent's explanation in the chat.
    develop: async (p, { cam, windows, shot }) => {
        await open(p.dir, ['first-errand@S3', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent({ talk: 'develop' }),
            onChatOpen: windows(async (chat) => {
                const bench = benchOf(chat);
                // The replay up to S3 starts, then a cut to the window handed over.
                await sleep(2000);
                await cam.hold(bench);
                await handedOver(chat);
                await cam.follow(bench);
                await sleep(800);
                await appOf(bench).locator('#new').click();
                await appOf(bench).locator('#create').waitFor({ timeout: 10000 });
                await sleep(600);
                // The element: "/" in the field, then /element.
                await chat.locator('#input').fill('/');
                await sleep(500);
                await chat.locator('#pick').click();
                await sleep(600);
                // The button is disabled: a person clicks it anyway to pick it, the browser driver only with force.
                await appOf(bench).locator('#create').click({ force: true });
                await chat.locator('#chip.on').waitFor({ timeout: 20000 });
                await chat.locator('#input').pressSequentially('Why does "Add todo" start disabled?', { delay: 25 });
                await chat.locator('#input').press('Enter');
                await chat.locator('.message.claude').first().waitFor({ timeout: AGENT_MS });
                await stateOf(chat, 'developing');
                await sleep(3500);
                await shot('develop', bench);
                await bench.close();
            }),
        });
    },
    // caw reproduce: the agent alone walks a bug report; the end card with the verdict.
    reproduce: async (p, { windows, shot }) => {
        await reproduce(p.dir, ['Searching for "home" finds nothing although todos are tagged #home.', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent({ run: 'reproduce' }),
            onChatOpen: windows(async (chat) => {
                const bench = benchOf(chat);
                await chat.locator('#next.on').waitFor({ timeout: AGENT_MS });
                await sleep(3000);
                await shot('reproduce', bench);
                await bench.close();
            }),
        });
    },
    // A new test described in the chat: the plan, approved, the agent records, the check run, adopted. Short: the agent's
    // recording is cut after its start.
    create: async (p, { cam, windows, shot }) => {
        rmSync(join(p.dir, 'caw/tests/morning-errand.yaml'), { force: true });
        await record(p.dir, ['morning-errand', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent({ run: 'demo' }),
            onChatOpen: windows(async (chat, which) => {
                const bench = benchOf(chat);
                if (which === 1) {
                    await stateOf(chat, 'choosing');
                    await sleep(800);
                    await choose(chat, 'Describe it');
                    await stateOf(chat, 'describing');
                    await sleep(400);
                    await chat.locator('#input').pressSequentially('Add "Feed the raven" tagged #home for tomorrow, find it and tick it off.', { delay: 22 });
                    await sleep(400);
                    await chat.locator('#input').press('Enter');
                    await sleep(700);
                    await chat.locator('#toggle').click();
                } else if (which === 2) {
                    // The agent's window: the plan card is read, then approved; its recording is cut after a moment.
                    await stateOf(chat, 'planning');
                    await sleep(3000);
                    await shot('plan', bench);
                    await chat.locator('#approve').click();
                    await sleep(1500);
                    await cam.hold(bench);
                } else {
                    // The check run's window: its start, a cut to its result, the proven test adopted.
                    await sleep(1500);
                    await cam.hold(bench);
                    await chat.locator('#choices button.primary').waitFor({ timeout: AGENT_MS });
                    await cam.follow(bench);
                    await sleep(2500);
                    await chat.locator('#choices button.primary').click();
                    await sleep(1200);
                    await cam.hold(bench);
                }
            }),
        });
    },
    // S4 not recorded yet, with the target design it should end on: the run passes and names it ready to record; recorded, its
    // check run judges the screen against the design and is green.
    design: async (p, { cam, windows }) => {
        const testFile = join(p.dir, 'caw/tests/first-errand.yaml');
        const recordingFile = join(p.dir, 'caw/recordings/first-errand.yaml');
        const test = readFileSync(testFile, 'utf8');
        const s4 = test.indexOf('  - id: S4');
        if (s4 === -1) throw new Error('first-errand has no S4');
        writeFileSync(testFile, `${test.trimEnd()}\n    design: design/todo-detail.html\n    needs: ["getByRole('list', { name: 'Todos', exact: true })"]\n`);
        const recording = readFileSync(recordingFile, 'utf8');
        const from = recording.indexOf('  - id: S4');
        const to = recording.indexOf('knownMessages:');
        if (from === -1 || to === -1) throw new Error('the recording of first-errand has no S4');
        writeFileSync(recordingFile, `${recording.slice(0, from)}${recording.slice(to)}`);
        const pendingRun = cawIn(p.dir, 'run', 'first-errand', ...ENV, '--headless');
        if (pendingRun.code !== 0) throw new Error(`the run with S4 pending failed:\n${pendingRun.text}`);
        await cam.insert(await terminal(cam.dir ?? out, [{ command: 'npx caw run first-errand --env local --headless', output: pendingRun.text, hold: 3 }]));
        await record(p.dir, ['first-errand@S4', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent({ run: 'plan-it' }),
            onChatOpen: windows(async (chat, which) => {
                const bench = benchOf(chat);
                // Both windows: their start, then a cut. In the first S1 to S3 replay and the agent records S4 (an unchanged
                // plan needs no approval); it closes on its own when the check run opens.
                await sleep(1500);
                await cam.hold(bench);
                if (which === 1) return;
                // The check run's window: S4 green, its design met; adopted.
                const adopt = chat.locator('#choices button.primary', { hasText: 'Adopt' });
                await adopt.waitFor({ timeout: AGENT_MS });
                await cam.follow(bench);
                await sleep(2500);
                await adopt.click();
                await sleep(1200);
                await cam.hold(bench);
            }),
        });
    },
    // caw audit against the commit the copy started from: the check S4 got instead of the one it had.
    audit: async (p, { cam }) => {
        const audit = cawIn(p.dir, 'audit', 'main');
        await cam.insert(await terminal(cam.dir ?? out, [{ command: 'npx caw audit main', output: audit.text, hold: 3.5 }]));
    },
    // The regression again, in CI: the failed step typed by caw's assessment in JUnit.
    ci: async (p, { cam }) => {
        await p.restart(BREAK);
        const ci = cawIn(p.dir, 'run', '--all', ...ENV, '--headless', '--report', 'junit=out/caw.xml');
        const xml = existsSync(join(p.dir, 'out/caw.xml')) ? readFileSync(join(p.dir, 'out/caw.xml'), 'utf8') : '';
        const typed = xml.split('\n').filter((line) => line.includes('<failure')).map((line) => line.trim()).join('\n');
        await p.restart();
        await cam.insert(await terminal(cam.dir ?? out, [
            { command: 'npx caw run --all --env local --headless --report junit=out/caw.xml', output: ci.text, hold: 1 },
            { command: 'grep "<failure" out/caw.xml', output: typed || '(no failure in out/caw.xml)', hold: 3.5 },
        ]));
    },
    // The F1 dialog with the example's test and its steps.
    states: async (p, { windows, shot }) => {
        await open(p.dir, ['first-errand', ...ENV, ...LOCAL], {
            interactive: true,
            ...agent(),
            onChatOpen: windows(async (chat) => {
                await handedOver(chat);
                const bench = benchOf(chat);
                await bench.keyboard.press('F1');
                await bench.locator('#stateDlg:not([hidden])').waitFor({ timeout: 10000 });
                await bench.locator('#stests .srow', { hasText: 'first-errand' }).click();
                await shot('states', bench);
                await bench.close();
            }),
        });
    },
};

/** Runs one flow with its camera and the stills wanted from it. */
const play = async (name, p, cam, shots = new Set()) => {
    console.log(`flow ${name}`);
    let window = 0;
    const windows = (handler) => async (chat) => {
        window += 1;
        const which = window;
        await cam.follow(benchOf(chat));
        background((opened) => handler(opened, which))(chat);
    };
    const shot = async (id, bench) => { if (shots.has(id)) await still(bench, id); };
    try {
        await flows[name](p, { cam, windows, shot });
    } finally {
        await settled();
        await cam.hold();
    }
};

/** A project for a scene, cleaned up after it. */
const inProject = async (options, work) => {
    const p = await project(options);
    try {
        await work(p);
    } finally {
        p.stop();
        // Chrome may still hold files of the copy for a moment; a leftover in the temp folder is harmless.
        await sleep(1000);
        try {
            if (existsSync(p.dir)) rmSync(dirname(p.dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
            console.log(`left behind: ${dirname(p.dir)}`);
        }
    }
};

mkdirSync(out, { recursive: true });
// The stills: each flow once, for all of its stills, in a project of its own.
const wanted = scene === 'all' || scene === 'stills' ? Object.keys(STILLS) : Object.keys(STILLS).filter((name) => name === scene);
for (const name of [...new Set(wanted.map((id) => STILLS[id]))]) {
    await inProject({}, (p) => play(name, p, NO_FILM, new Set(wanted.filter((id) => STILLS[id] === name))));
}
// The video: one camera across its parts, in one project that they build on.
if (scene === 'all' || scene === 'main') {
    await inProject({ git: true }, async (p) => {
        const camera = film('demo');
        for (const name of PARTS.filter((part) => parts.includes(part))) await play(name, p, camera);
        console.log(`demo: ${await camera.stop()} frames`);
    });
}
console.log(`frames and stills: ${out}${readdirSync(out).length === 0 ? ' (empty)' : ''}`);
