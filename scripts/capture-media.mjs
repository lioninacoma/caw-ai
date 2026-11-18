#!/usr/bin/env node
// Records the README media (docs/media/*.webp) from the Errand example, in English, with fictitious data only.
//
//   node scripts/capture-media.mjs [--scene states|develop|bugfix|reproduce|demo|all] [--out <dir>]
//
// No scene uses Claude: scripts/media-agent.mjs plays Claude's part with the same plan, clicks and answers every time, so the
// media come out the same on every run and cost no tokens. The video runs in real time (not sped up), with the logo at the end.
// Needs ffmpeg on PATH and Chrome.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const scene = option('--scene', 'all');
const media = join(repo, 'docs/media');
const out = option('--out', join(tmpdir(), 'caw-media'));
const SCENES = ['states', 'develop', 'bugfix', 'reproduce', 'demo'];
if (scene !== 'all' && !SCENES.includes(scene)) throw new Error(`--scene: one of ${SCENES.join(', ')} or all`);
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is not on PATH');

// The README shows the English UI. Personal settings in a folder of their own: no token notice, default theme.
process.env.CAW_LANG = 'en';
delete process.env.CI;
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-media-home-'));
// The steps column stays open: below 1500 px the workbench folds it on its own, and the demo is filmed narrower than that.
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off', steps: 'open', chat: 'open' }));
// The example's fictitious account.
process.env.CAW_USER_USER = 'demo';
process.env.CAW_USER_PASSWORD = 'demo';

const { open, record, reproduce } = await import('../src/host/commands.mjs');
const { activeTheme } = await import('../src/shared/theme-package.mjs');
const { LONG_NAME } = await import('../src/shared/raven.mjs');
const { RAVEN_CSS, ravenLogo, themeAttr, themeCss } = await import('../src/host/theme.mjs');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const freePort = () => new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

/** The example in a folder of its own, so the repository stays as it is, with its server on a free port. */
const project = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-media-errand-'));
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
    const port = await freePort();
    const config = join(dir, 'caw.config.json');
    writeFileSync(config, readFileSync(config, 'utf8').replace('http://localhost:4174', `http://localhost:${port}`));
    const server = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    for (let tries = 0; tries < 50; tries += 1) {
        if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) return { dir, server };
        await sleep(200);
    }
    server.kill();
    throw new Error(`the example server does not answer on ${port}`);
};

// The workbench: the chat is a frame of it, the application another one.
const benchOf = (chat) => chat.page();
const appOf = (bench) => bench.frames().find((frame) => frame.name() === 'caw-app');
// The scripted agent answers within seconds; the first run may wait for Chrome.
const CLAUDE_MS = 120000;
const stateOf = (chat, name, timeout = CLAUDE_MS) => chat.locator(`body[data-state=${name}]`).waitFor({ timeout });
const showBench = async (chat) => {
    const bench = benchOf(chat);
    await bench.locator('body.solo').waitFor({ state: 'attached', timeout: 120000 }).catch(async (error) => {
        await bench.screenshot({ path: join(out, 'stuck.png') }).catch(() => {});
        throw new Error(`the workbench did not hand over (see ${join(out, 'stuck.png')}): ${error.message.split('\n')[0]}`);
    });
    await bench.locator('.soloBar [data-solo]').click();
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
/** After a scene: every window's human is done; the first error, if any, ends the scene. */
const settled = async () => {
    const all = pending;
    pending = [];
    await Promise.all(all);
};

/** A still image as WebP. */
const still = async (bench, name) => {
    const png = join(out, `${name}.png`);
    await bench.waitForTimeout(500);
    await bench.screenshot({ path: png });
    webp(['-i', png, '-c:v', 'libwebp', '-quality', '85'], name);
};
/**
 * The workbench's size in CSS pixels while filmed: small, so text comes out large in the README column, but wide enough for
 * the three columns (steps, app, chat; from 1000) and the key bar on one line (from 1120); the app in its pane gets narrower.
 * The video has the same size (on a screen with a higher pixel density the frames are scaled down to it, never up).
 */
const PAGE = { width: 1140, height: 712 };
const VIDEO = PAGE;
/** At most this many frames a second. */
const FPS = 12;
/**
 * Films whichever workbench is current, in real time: screenshots in a loop at the screen's resolution, each frame lasting
 * until the next. Nothing is sped up; only waiting is left out:
 * hold() stops filming until the next window, and the step from one window to the next is a cut. stop() appends the logo and
 * writes the WebP.
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
        hold,
        follow: async (bench) => {
            await hold();
            const own = await bench.context().newCDPSession(bench);
            // caw opens the window maximized; on a large screen the workbench would be tiny in the README. A small window instead
            // (PAGE in CSS pixels): the text comes out larger in the video and stays readable in the README column; the app in its
            // pane gets narrower. Only the window changes, no emulation, which would fight with Playwright's own.
            const { windowId } = await own.send('Browser.getWindowForTarget');
            await own.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
            // Outer size = page plus the browser's frame; measured once, then corrected.
            await own.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: PAGE.width, height: PAGE.height } });
            await sleep(300);
            const inner = await bench.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
            await own.send('Browser.setWindowBounds', { windowId, bounds: { width: 2 * PAGE.width - inner.width, height: 2 * PAGE.height - inner.height } });
            await bench.waitForFunction(({ width, height }) => globalThis.innerWidth === width && globalThis.innerHeight === height, PAGE, { timeout: 5000 }).catch(() => {});
            await sleep(300);
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
        stop: async () => {
            await hold();
            if (!frames.some((frame) => frame.cut === undefined)) return 0;
            // Each frame until the next; at a cut between windows 0.4 s, and no frame longer than 2.5 s.
            const timed = [];
            frames.forEach((frame, index) => {
                if (frame.cut) return;
                const next = frames[index + 1];
                const seconds = next === undefined || next.cut ? 0.4 : Math.min(next.at - frame.at, 2.5);
                timed.push({ path: frame.path, seconds });
            });
            timed.push(...await outro(dir, VIDEO));
            const slash = (path) => path.replaceAll('\\', '/');
            const list = join(dir, 'frames.txt');
            writeFileSync(list, `ffconcat version 1.0\n${timed.map(({ path, seconds }) => `file '${slash(path)}'\nduration ${seconds.toFixed(3)}\n`).join('')}file '${slash(timed.at(-1).path)}'\n`);
            webp(['-f', 'concat', '-safe', '0', '-i', list, '-fps_mode', 'vfr', '-vf', `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos`, '-loop', '0', '-c:v', 'libwebp_anim', '-quality', '70'], name);
            return timed.length;
        },
    };
};
/**
 * The closing card: the raven and the name in the default theme, the cursor blinking a few times, at the film's size.
 * @returns frames with their duration
 */
const outro = async (dir, { width, height }) => {
    const { chromium } = await import('playwright-core');
    const theme = activeTheme();
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.setContent(`<!doctype html><html${themeAttr(theme)}><head><meta charset="utf-8"><style>${themeCss(theme)}${RAVEN_CSS}
html,body{margin:0;height:100%;background:var(--screen);color:var(--text)}
body{display:flex;align-items:center;justify-content:center;gap:56px}
.raven{font-size:64px;line-height:1.05}
.name{font:700 84px/1 var(--font-crt);letter-spacing:-.02em;display:flex;align-items:center}
.cursor{display:inline-block;width:.5em;height:1em;margin-left:.12em;background:var(--warn)}
.off .cursor{visibility:hidden}
.long{margin-top:18px;font:400 22px/1 var(--font-ui);color:var(--muted)}
</style></head><body>${ravenLogo(theme, { size: 64 })}<div><div class="name">caw<span class="cursor"></span></div><div class="long">${LONG_NAME}</div></div></body></html>`);
        await page.evaluate(() => globalThis.document.fonts.ready);
        const shots = [];
        for (const [index, off] of [false, true].entries()) {
            await page.evaluate((hide) => globalThis.document.body.classList.toggle('off', hide), off);
            const path = join(dir, `outro-${index}.jpg`);
            await page.screenshot({ path, type: 'jpeg', quality: 95 });
            shots.push(path);
        }
        // The cursor blinks three times, then stays on.
        return [...[0, 1, 0, 1, 0, 1].map((index) => ({ path: shots[index], seconds: 0.55 })), { path: shots[0], seconds: 2.5 }];
    } finally {
        await browser.close();
    }
};
const webp = (input, name) => {
    const target = join(media, `${name}.webp`);
    const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, target], { stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
    console.log(`written: docs/media/${name}.webp`);
};

// Claude's part: always the same plan, clicks and answers (see the script), as the local agent on this machine.
const agentFor = (part) => ({ [part === 'demo' || part === 'reproduce' ? 'containerCommand' : 'talkCommand']: [process.execPath, join(repo, 'scripts/media-agent.mjs'), part] });
const LOCAL = ['--agent', 'local'];

const scenes = {
    // The F1 dialog with the example's test and its steps.
    states: async (dir) => {
        await open(dir, ['first-errand', '--env', 'local'], {
            interactive: true,
            onChatOpen: background(async (chat) => {
                await showBench(chat);
                const bench = benchOf(chat);
                await bench.keyboard.press('F1');
                await bench.locator('#stateDlg:not([hidden])').waitFor({ timeout: 10000 });
                await bench.locator('#stests .srow', { hasText: 'first-errand' }).click();
                await still(bench, 'states');
                await bench.close();
            }),
        });
        await settled();
    },
    // A picked element and Claude's explanation in the chat.
    develop: async (dir) => {
        await open(dir, ['first-errand@S3', '--env', 'local', ...LOCAL], {
            interactive: true,
            ...agentFor('develop'),
            onChatOpen: background(async (chat) => {
                await showBench(chat);
                const bench = benchOf(chat);
                await stateOf(chat, 'developing');
                await appOf(bench).locator('#new').click();
                await appOf(bench).locator('#create').waitFor({ timeout: 10000 });
                await chat.locator('#pick').click();
                // The button is disabled: a person clicks it anyway to pick it, Playwright only with force.
                await appOf(bench).locator('#create').click({ force: true });
                await chat.locator('#chip.on').waitFor({ timeout: 20000 });
                await chat.locator('#input').fill('Why does "Add todo" start disabled?');
                await chat.locator('#input').press('Enter');
                await chat.locator('.message.claude').first().waitFor({ timeout: CLAUDE_MS });
                await stateOf(chat, 'developing');
                await still(bench, 'develop');
                await bench.close();
            }),
        });
        await settled();
    },
    // A bug pasted into the chat; Claude reproduces it and proposes a code change.
    bugfix: async (dir) => {
        await open(dir, ['first-errand', '--env', 'local', ...LOCAL], {
            interactive: true,
            ...agentFor('bugfix'),
            onChatOpen: background(async (chat) => {
                await showBench(chat);
                const bench = benchOf(chat);
                await stateOf(chat, 'developing');
                await chat.locator('#input').fill('Bug: searching for "home" finds nothing although todos are tagged #home. Please reproduce it and propose a fix.');
                await chat.locator('#input').press('Enter');
                await chat.locator('#choices button', { hasText: 'Apply change' }).waitFor({ timeout: CLAUDE_MS });
                await still(bench, 'bugfix');
                await bench.close();
            }),
        });
        await settled();
    },
    // caw reproduce: Claude alone walks a bug report; the end card with the verdict, the empty search in the app.
    reproduce: async (dir) => {
        await reproduce(dir, ['Searching for "home" finds nothing although todos are tagged #home.', '--env', 'local', ...LOCAL], {
            interactive: true,
            ...agentFor('reproduce'),
            onChatOpen: background(async (chat) => {
                const bench = benchOf(chat);
                await chat.locator('#next.on').waitFor({ timeout: CLAUDE_MS });
                await sleep(2000);
                await still(bench, 'reproduce');
                await bench.close();
            }),
        });
        await settled();
    },
    // A new test described in the chat: plan, approval, Claude records, the check run, adopting. Filmed throughout, Claude
    // played by scripts/media-agent.mjs. The pauses give each part a few seconds to be read.
    demo: async (dir) => {
        rmSync(join(dir, 'caw/tests/morning-errand.yaml'), { force: true });
        const camera = film('demo');
        let window = 0;
        await record(dir, ['morning-errand', '--env', 'local', ...LOCAL], {
            interactive: true,
            ...agentFor('demo'),
            // caw waits for onChatOpen: the window gets its filming size before the run goes on (the check run replays at once),
            // then the human acts in the background.
            onChatOpen: async (chat) => {
                window += 1;
                await camera.follow(benchOf(chat));
                background((opened) => act(opened, window))(chat);
            },
        });
        await settled();
        const frames = await camera.stop();
        console.log(`demo: ${frames} frames`);
        /** What the human does in each window. */
        async function act(chat, which) {
            if (which === 1) {
                await stateOf(chat, 'choosing');
                await sleep(1200);
                await chat.locator('#choices button', { hasText: 'Describe it' }).click();
                await stateOf(chat, 'describing');
                await sleep(700);
                await chat.locator('#input').pressSequentially('Add a todo "Feed the raven" tagged #home for tomorrow, find it with the search and tick it off.', { delay: 45 });
                await sleep(600);
                await chat.locator('#input').press('Enter');
                await sleep(1000);
                await chat.locator('#toggle').click();
            } else if (which === 2) {
                // Claude's window: the plan card is read for a while, then approved; Claude then records.
                await stateOf(chat, 'planning');
                await sleep(5500);
                await chat.locator('#approve').click();
                // Claude is done once it hands over to the check run; the wait for the next window is left out.
                await chat.getByText('A new window opens for the check run').waitFor({ timeout: CLAUDE_MS }).catch(() => {});
                await sleep(1200);
                await camera.hold(benchOf(chat));
            } else {
                // The check run's window: the decision whether the proven test is adopted.
                await chat.locator('#choices button.primary').waitFor({ timeout: CLAUDE_MS });
                await sleep(3500);
                await chat.locator('#choices button.primary').click();
                await sleep(1800);
                await camera.hold(benchOf(chat));
            }
        }
    },
};

mkdirSync(out, { recursive: true });
for (const name of scene === 'all' ? SCENES : [scene]) {
    const { dir, server } = await project();
    try {
        console.log(`scene ${name}`);
        await scenes[name](dir);
    } finally {
        server.kill();
        // Chrome may still hold files of the copy for a moment; a leftover in the temp folder is harmless.
        await sleep(1000);
        try {
            if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
            console.log(`left behind: ${dir}`);
        }
    }
}
console.log(`frames and stills: ${out}${readdirSync(out).length === 0 ? ' (empty)' : ''}`);
