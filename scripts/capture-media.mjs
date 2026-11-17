#!/usr/bin/env node
// Records the README media (docs/media/*.webp) from the Errand example, in English, with fictitious data only.
//
//   node scripts/capture-media.mjs [--scene states|develop|bugfix|demo|all] [--claude] [--out <dir>]
//
// `states` needs no Claude. `develop`, `bugfix` and `demo` show Claude in the chat: with --claude the real Claude Code works
// (costs tokens once); without it a scripted agent stands in, in the Docker sandbox, to check the choreography without tokens.
// Media are only written with --claude, or for `states`; a dry run writes its frames to the out folder for a look.
// Needs ffmpeg on PATH, Chrome, and for the dry run Docker (as the e2e does).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const withClaude = args.includes('--claude');
const scene = option('--scene', 'all');
const media = join(repo, 'docs/media');
const out = option('--out', join(tmpdir(), 'caw-media'));
const SCENES = ['states', 'develop', 'bugfix', 'demo'];
if (scene !== 'all' && !SCENES.includes(scene)) throw new Error(`--scene: one of ${SCENES.join(', ')} or all`);
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is not on PATH');

// The README shows the English UI. Personal settings in a folder of their own: no token notice, default theme.
process.env.CAW_LANG = 'en';
delete process.env.CI;
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-media-home-'));
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
// The example's fictitious account.
process.env.CAW_USER_USER = 'demo';
process.env.CAW_USER_PASSWORD = 'demo';

const { open, record } = await import('../src/host/commands.mjs');

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
    cpSync(join(repo, 'examples/errand'), dir, { recursive: true, filter: (path) => !path.includes('.caw') });
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
// Claude may take minutes; a dry run may first build the sandbox image for the copy.
const CLAUDE_MS = withClaude ? 1800000 : 600000;
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
    if (withClaude || name === 'states') webp(['-i', png, '-c:v', 'libwebp', '-quality', '85'], name);
};
/** Frames of whichever workbench is current, every 500 ms, until stop(); played back fourfold. */
const film = (name) => {
    const dir = join(out, `${name}-frames`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    let current = null;
    let running = true;
    let index = 0;
    const loop = (async () => {
        while (running) {
            if (current !== null && !current.isClosed()) {
                index += 1;
                await current.screenshot({ path: join(dir, `f${String(index).padStart(5, '0')}.png`) }).catch(() => { index -= 1; });
            }
            await sleep(500);
        }
    })();
    return {
        follow: (bench) => { current = bench; },
        stop: async () => {
            running = false;
            await loop;
            if (withClaude && index > 0) webp(['-framerate', '8', '-i', join(dir, 'f%05d.png'), '-vf', 'scale=1280:-2', '-loop', '0', '-c:v', 'libwebp', '-quality', '60'], name);
            return index;
        },
    };
};
const webp = (input, name) => {
    const target = join(media, `${name}.webp`);
    const done = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, target], { stdio: 'inherit' });
    if (done.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
    console.log(`written: docs/media/${name}.webp`);
};

/** A scripted agent for the dry run: the same chat states as with Claude, no tokens. */
const dry = (script) => (withClaude ? {} : script);
// The scripted agent calls `caw agent`, which exists in the Docker sandbox (as in the e2e), not on this machine's PATH.
const dryAgent = withClaude ? [] : ['--agent', 'docker'];
const DRY_TALK = ['bash', '-c', "A='caw agent'; $A say 'Dry run: Claude would answer here with file and line.'; $A chat > /dev/null"];
const DRY_BUGFIX = ['bash', '-c', `A='caw agent'
cat > /tmp/a.json <<'EOF'
{"items":[{"about":"search","side":"app","title":"Search ignores tags","evidence":"GET /api/todos?q=home returns no todo tagged #home; server.mjs:197","reason":"The search compares the title only.","prompt":"In server.mjs the todo search compares only the title; also match the tag.","edits":[{"file":"server.mjs","find":"todos.filter((t) => t.title.toLowerCase().includes(q))","replace":"todos.filter((t) => t.title.toLowerCase().includes(q) || t.tag === q)","why":"Tags are searchable too"}]}]}
EOF
$A advise --file /tmp/a.json > /dev/null; $A chat > /dev/null`];
const DRY_RECORD = ['bash', '-c', `A='caw agent'
cat > /tmp/p.yaml <<'EOF'
steps:
  - id: S1
    name: Open the new todo
    do: Click New todo.
    expect: The New todo dialog is open.
heard:
  - {note: H1, as: run}
EOF
$A plan --file /tmp/p.yaml > /dev/null
$A click '#new'
$A check S1 "document.getElementById('dialog').open === true"
echo '{"expectations":[{"id":"S1","status":"pass","evidence":{"type":"eval","value":"dry"}}],"omit":[]}' > /tmp/e.json; $A finish --file /tmp/e.json`];

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
        await open(dir, ['first-errand@S3', '--env', 'local', ...dryAgent], {
            interactive: true,
            ...dry({ talkCommand: DRY_TALK }),
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
        await open(dir, ['first-errand', '--env', 'local', ...dryAgent], {
            interactive: true,
            ...dry({ talkCommand: DRY_BUGFIX }),
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
    // A new test described in the chat: plan, approval, Claude records, the check run, adopting. Filmed throughout.
    demo: async (dir) => {
        rmSync(join(dir, 'caw/tests/morning-errand.yaml'), { force: true });
        const camera = film('demo');
        let window = 0;
        await record(dir, ['morning-errand', '--env', 'local', ...dryAgent], {
            interactive: true,
            ...dry({ containerCommand: DRY_RECORD }),
            onChatOpen: background(async (chat) => {
                window += 1;
                camera.follow(benchOf(chat));
                if (window === 1) {
                    await stateOf(chat, 'choosing');
                    await chat.locator('#choices button', { hasText: 'Describe it' }).click();
                    await stateOf(chat, 'describing');
                    await chat.locator('#input').pressSequentially('Add a todo "Feed the raven" tagged #home for tomorrow, find it with the search and tick it off.', { delay: 25 });
                    await chat.locator('#input').press('Enter');
                    await sleep(800);
                    await chat.locator('#toggle').click();
                } else if (window === 2) {
                    // Claude's window: the plan card, approved after a moment; Claude then records.
                    await stateOf(chat, 'planning');
                    await sleep(2500);
                    await chat.locator('#approve').click();
                } else {
                    // The check run's window: the decision whether the proven test is adopted.
                    await chat.locator('#choices button.primary').waitFor({ timeout: CLAUDE_MS });
                    await sleep(2000);
                    await chat.locator('#choices button.primary').click();
                }
            }),
        });
        await settled();
        const frames = await camera.stop();
        console.log(`demo: ${frames} frames`);
    },
};

mkdirSync(out, { recursive: true });
for (const name of scene === 'all' ? SCENES : [scene]) {
    const { dir, server } = await project();
    try {
        console.log(`scene ${name}${withClaude || name === 'states' ? '' : ' (dry run, scripted agent)'}`);
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
