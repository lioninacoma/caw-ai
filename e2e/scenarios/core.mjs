// B…: the core surface as a user gets it, from the packed package installed into an empty project. English.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verify } from '../harness.mjs';
import { installPacked, packTarball, tarballFiles } from '../infra.mjs';

let project = null;
const group = {
    language: 'en',
    setup: async () => {
        project = await installPacked(mkdtempSync(join(tmpdir(), 'caw-e2e-core-')));
    },
    teardown: async () => {
        if (project !== null) rmSync(project.dir, { recursive: true, force: true });
        project = null;
    },
};
const scenario = (id, title, body) => ({ id, title, group, body });

/** `npx caw …` in the installed project, as a user types it; English UI, no colour, CI unless given. */
const caw = (args, env = {}) => {
    const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['caw', ...args], {
        cwd: project.dir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: { ...process.env, CAW_LANG: 'en', NO_COLOR: '1', CI: '1', INIT_CWD: project.dir, ...env },
    });
    return { code: result.status, out: result.stdout, err: result.stderr, all: `${result.stdout}${result.stderr}` };
};

/** The command names of the human help, in order (lines with two spaces and a lowercase word at the start of a block). */
const helpCommands = (text) => [...new Set([...text.matchAll(/^ {2}([a-z]+)\b/gm)].map((match) => match[1]))];

export const scenarios = [
    scenario('B3', 'Package, bin, help surface, moved commands and renamed flags', async () => {
        // (1) The tarball: one bin "caw", no skill-less leftovers of the old name, no scripts.
        const tarball = await packTarball();
        const manifest = JSON.parse(readFileSync(join(project.dir, 'node_modules', 'caw-ai', 'package.json'), 'utf8'));
        verify('bin is exactly { caw }', JSON.stringify(manifest.bin) === JSON.stringify({ caw: 'bin/caw.mjs' }), JSON.stringify(manifest.bin));
        const files = await tarballFiles(tarball);
        verify('no bin/caw-ai.mjs and no scripts/ in the tarball', !files.includes('bin/caw-ai.mjs') && !files.some((file) => file.startsWith('scripts/')));
        verify('the install links caw, not caw-ai', project.bins.includes('caw') && !project.bins.includes('caw-ai'), project.bins.join(' '));

        // (2) Human help: the commands for people; mcp and agent are hidden; overlay only with an overlay block (X4).
        const help = caw(['--help']);
        const commands = helpCommands(help.out);
        verify('help exits 0', help.code === 0, String(help.code));
        verify('help lists the commands for people in order', JSON.stringify(commands) === JSON.stringify(['npx', 'init', 'record', 'run', 'open', 'reproduce', 'list', 'validate', 'audit', 'bisect', 'doctor', 'role', 'skill', 'export']), commands.join(' '));
        verify('help hides mcp, agent, attach, explore and auth', !commands.some((name) => ['mcp', 'agent', 'attach', 'explore', 'auth'].includes(name)));
        verify('help names durations with units', /--step-timeout 30s, --agent-timeout 60m/.test(help.out));

        // (3) Commands from before 1.0 are unknown commands: exit 3, nothing runs.
        for (const args of [['explore', '--url', 'http://localhost:18510'], ['auth', 'clerk'], ['click', 'e1']]) {
            const moved = caw(args);
            const expected = new RegExp(`Unknown command: ${args[0]}\\.`);
            verify(`caw ${args[0]} → exit 3, unknown`, moved.code === 3 && expected.test(moved.err), `${moved.code} ${moved.err.trim().split('\n')[0]}`);
        }

        // (4) Flag names from before 1.0 are unknown options like any other; durations without unit.
        for (const [args, pattern] of [
            [['run', 't', '--target', 'local'], /run has no option --target\. Allowed: --env/],
            [['run', 't', '--step-timeout', '30'], /--step-timeout 30: add a unit, e\.g\. --step-timeout 30s/],
            [['run', 't', '--advise'], /run has no option --advise\. Allowed: .*--explain/],
            [['record', 't', '--max-steps', '5'], /record has no option --max-steps\. Allowed: .*--max-actions/],
            [['record', 't', '--timeout', '60'], /record has no option --timeout\. Allowed: .*--agent-timeout/],
            [['role', 'login', 'clerk', '--target', 'local'], /role doesn't know --target\. Allowed: --env, --json/],
        ]) {
            const refused = caw(args);
            verify(`${args.join(' ')} → exit 3 naming the allowed options`, refused.code === 3 && pattern.test(refused.err), `${refused.code} ${refused.err.trim().split('\n')[0]}`);
        }

        // (6) Claude's commands under caw agent, with their own help.
        const agentHelp = caw(['agent', '--help']);
        verify('caw agent --help lists the agent commands', agentHelp.code === 0 && /^caw agent <command>/.test(agentHelp.out) && /wait-ready \[--for <selector>\]/.test(agentHelp.out) && /finish --file/.test(agentHelp.out));
        const unknownAgent = caw(['agent', 'clik']);
        verify('a typo under caw agent suggests the agent command', unknownAgent.code === 3 && /Unknown command: caw agent clik\. Did you mean click\?/.test(unknownAgent.err), unknownAgent.err.trim());

        // (7) Version.
        const version = caw(['--version']);
        verify('--version is the package version', version.code === 0 && version.out.trim() === manifest.version, version.out.trim());
    }),
];
