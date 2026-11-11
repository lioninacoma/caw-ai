// Framework matrix: React (Vite and webpack), Vue, Angular (zoneless and Zone.js), Next.js and Nuxt. Per variant: the dev server as
// the environment (dev), the production build behind HTTPS (deployed) and the overlay over the deployed version: without the option
// it stays the deployed version despite a running watch (no-option), --overlay build with a different chunk split (React, webpack),
// caw builds itself (buildCommand), exit 2 without a build or with a stale build, --overlay dev with devCommand, exit 2 without a dev
// server, and for Next and Nuxt exit 2 because of SSR.
// Claude is never started: the recordings are written by hand in project.mjs.
//   node e2e/frameworks/matrix.mjs [filter]       e.g. "react" or "angular-zone/dev"
// Requires: npm install in every project, Chrome. Results in e2e/frameworks/result/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasBuild } from '../../src/host/local-build.mjs';
import { writeProject } from './project.mjs';
import { ensureCert } from './shared/cert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../../bin/caw-ai.mjs');
const out = join(here, 'result');
mkdirSync(out, { recursive: true });
const filter = process.argv[2];
const sleep = (ms) => new Promise((ok) => { setTimeout(ok, ms); });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const children = [];
const start = (name, cwd, command, args, env = {}) => {
    const log = join(out, `${name}.log`);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
    child.stderr.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
    children.push(child);
    return child;
};
const stop = (child) => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
};
const waitFor = async (url, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    while (Date.now() < deadline) {
        const ok = await fetch(url).then((r) => r.status < 500, () => false);
        if (ok) return true;
        await sleep(500);
    }
    return false;
};
const build = (cwd, command, args, env = {}) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Build ${args.join(' ')} in ${cwd}:\n${result.stdout}\n${result.stderr}`);
};

/** One caw-ai run in the project, as in CI. Returns exit code, output and, if written, result.json and report.md. */
const cawRun = (root, test, extra = [], env = {}) => {
    rmSync(join(root, '.caw/runs'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [bin, 'run', test, '--target', 'test', '--headless', ...extra], {
        cwd: root, encoding: 'utf8', timeout: 180_000,
        env: { ...process.env, ...env, CI: '1', CAW_LANG: 'en', CAW_AI_HOME: join(here, '.caw-home'), NO_COLOR: '1' },
    });
    const runs = join(root, '.caw/runs');
    const dir = existsSync(runs) ? readdirSync(runs).map((name) => join(runs, name)).find((path) => existsSync(join(path, 'result.json'))) : undefined;
    return {
        code: result.status ?? (result.error ? `error: ${result.error.code}` : 'no exit'),
        output: `${result.stdout}${result.stderr}`,
        verdict: dir ? JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) : null,
        report: dir ? readFileSync(join(dir, 'report.md'), 'utf8') : '',
    };
};

const vite = (port) => ({
    dev: [npx, ['vite', '--port', String(port)]], build: [npx, ['vite', 'build']], out: 'dist', env: (value) => ({ VITE_BUILD: value }),
    // Normal builds with hashes: deployed into deploy/, locally by a watch into local/.
    localBuild: { deploy: [npx, ['vite', 'build', '--outDir', 'deploy'], { VITE_BUILD: 'deployed' }], served: 'deploy', watch: [npx, ['vite', 'build', '--watch', '--outDir', 'local'], { VITE_BUILD: 'local', CAW_SPLIT: '1' }], dir: 'local' },
});
// webpack 5: classic scripts, a runtime loads chunks via JSONP, hash as [contenthash] after a dot.
const webpack = (port) => ({
    dev: [npx, ['webpack', 'serve', '--mode', 'development', '--port', String(port)]], build: [npx, ['webpack', '--mode', 'production']], out: 'dist', env: (value) => ({ CAW_BUILD: value }),
    localBuild: { deploy: [npx, ['webpack', '--mode', 'production', '--output-path', 'deploy'], { CAW_BUILD: 'deployed' }], served: 'deploy', watch: [npx, ['webpack', '--mode', 'production', '--watch', '--output-path', 'local'], { CAW_BUILD: 'local', CAW_SPLIT: '1' }], dir: 'local' },
});
const ng = (configs) => ({
    deploy: [npx, ['ng', 'build', '-c', configs, '--output-path', 'deploy']], served: 'deploy/browser',
    watch: [npx, ['ng', 'build', '-c', `${configs},local`, '--watch', '--output-path', 'local']], dir: 'local/browser',
});

// Every variant: project, framework for caw-ai, and how it runs locally (dev server) and deployed.
const APPS = [
    { name: 'react', dir: 'react-vite', framework: 'react', embed: true, devPort: 5173, deployPort: 8441, ...vite(5173) },
    { name: 'webpack', dir: 'react-webpack', framework: 'react', embed: true, devPort: 5175, deployPort: 8447, ...webpack(5175) },
    { name: 'vue', dir: 'vue-vite', framework: 'vue', devPort: 5174, deployPort: 8442, ...vite(5174) },
    {
        name: 'angular', dir: 'angular', framework: 'angular', devPort: 4200, deployPort: 8443,
        dev: [npx, ['ng', 'serve', '--port', '4200']], build: [npx, ['ng', 'build', '--output-path', 'dist/app']], out: 'dist/app/browser',
        localBuild: ng('production'),
    },
    {
        name: 'angular-zone', dir: 'angular', framework: 'angular', devPort: 4201, deployPort: 8444,
        dev: [npx, ['ng', 'serve', '-c', 'development-zone', '--port', '4201']], build: [npx, ['ng', 'build', '-c', 'production,zone', '--output-path', 'dist/zone']], out: 'dist/zone/browser',
        localBuild: ng('production,zone'),
    },
    { name: 'next', dir: 'next', framework: 'react', devPort: 3000, deployPort: 8445, dev: [npx, ['next', 'dev', '-H', '127.0.0.1', '-p', '3000']], build: [npx, ['next', 'build']], serveCmd: [npx, ['next', 'start', '-H', '127.0.0.1', '-p', '3100']], servePort: 3100, env: (value) => ({ NEXT_PUBLIC_BUILD: value }) },
    { name: 'nuxt', dir: 'nuxt', framework: 'vue', devPort: 3001, deployPort: 8446, dev: [npx, ['nuxt', 'dev', '--host', '127.0.0.1', '--port', '3001']], build: [npx, ['nuxt', 'build']], serveCmd: [process.execPath, ['.output/server/index.mjs']], serveEnv: { PORT: '3101', HOST: '127.0.0.1', NITRO_PORT: '3101' }, servePort: 3101, env: (value) => ({ NUXT_PUBLIC_BUILD: value }) },
];

const results = [];
const record = (scenario, test, expect, run, extra = '') => {
    const ok = expect(run);
    const steps = run.verdict?.results?.map((step) => `${step.id}:${step.status}`).join(' ') ?? '';
    const line = `${ok ? 'OK  ' : 'FAIL'} ${scenario} ${test} exit=${run.code} ${steps} ${extra}`.trim();
    console.log(line);
    results.push({ scenario, test, ok, code: run.code, steps, extra });
    writeFileSync(join(out, `${scenario.replaceAll('/', '_')}-${test}.txt`), `${run.output}\n\n----- report.md\n${run.report}`);
};
const passes = (run) => run.code === 0;
// The deliberate error must show up as an application error and point to its own source file (source maps, stackSkip).
const failsInApp = (run) => run.code === 1;
const explodeSource = (run) => (/explode\.ts/.test(`${run.report}${run.output}`) ? 'source=explode.ts' : 'source=?');
const swapped = (run) => (/page swapped: yes/.test(run.report) ? 'swapped' : 'not swapped');

const scenario = async (name, body) => {
    if (filter !== undefined && !name.includes(filter)) return;
    console.log(`##### ${name}`);
    try {
        await body();
    } catch (error) {
        console.log(`FAIL ${name} aborted: ${error.message.split('\n').slice(0, 6).join(' | ')}`);
        results.push({ scenario: name, test: '-', ok: false, code: 'aborted', steps: '', extra: error.message.split('\n')[0] });
    } finally {
        while (children.length > 1) stop(children.pop());
        await sleep(1000);
    }
};

// Once up front: the HTTPS servers start in parallel and must not create it at the same time.
ensureCert();
const api = start('api', here, process.execPath, ['shared/api.mjs', '3999']);
await waitFor('http://127.0.0.1:3999/api/me');

for (const app of APPS) {
    const root = join(here, app.dir);
    await scenario(`${app.name}/dev`, async () => {
        writeProject(root, { framework: app.framework, embed: app.embed === true, url: `http://localhost:${app.devPort}`, build: 'dev' });
        start(`${app.name}-dev`, root, ...app.dev);
        if (!await waitFor(`http://127.0.0.1:${app.devPort}/login`, 180_000)) throw new Error('dev server does not come up');
        // With Next/Nuxt/Angular the first request compiles the pages; warm up once, otherwise the run measures the compiler.
        await fetch(`http://127.0.0.1:${app.devPort}/`).catch(() => {});
        const smoke = cawRun(root, 'smoke');
        record(`${app.name}/dev`, 'smoke', passes, smoke);
        const fail = cawRun(root, 'error');
        record(`${app.name}/dev`, 'error', failsInApp, fail, explodeSource(fail));
    });

    await scenario(`${app.name}/deployed`, async () => {
        build(root, ...app.build, app.env?.('deployed') ?? { VITE_BUILD: 'deployed' });
        if (app.serveCmd) {
            start(`${app.name}-server`, root, ...app.serveCmd, { ...(app.serveEnv ?? {}), ...(app.env?.('deployed') ?? {}) });
            if (!await waitFor(`http://127.0.0.1:${app.servePort}/login`, 60_000)) throw new Error('production server does not come up');
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', '-', String(app.deployPort), '--proxy', `http://127.0.0.1:${app.servePort}`]);
        } else {
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', join(root, app.out), String(app.deployPort)]);
        }
        await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
        writeProject(root, { framework: app.framework, embed: app.embed === true, url: `https://${app.name.split('-')[0]}.localhost:${app.deployPort}`, build: 'deployed' });
        const smoke = cawRun(root, 'smoke');
        record(`${app.name}/deployed`, 'smoke', passes, smoke);
        const fail = cawRun(root, 'error');
        record(`${app.name}/deployed`, 'error', failsInApp, fail, explodeSource(fail));
    });

    const expectEnvError = (pattern) => (run) => run.code === 2 && pattern.test(run.output);
    const envHint = (run) => (run.output.match(/\[caw-ai\][^\n]*(overlay|build|dev server|server-side|local)[^\n]*/i) ?? [''])[0].slice(0, 160);
    const deployedUrl = `https://${app.name.split('-')[0]}.localhost:${app.deployPort}`;
    const serveDeployed = async () => {
        rmSync(join(root, 'deploy'), { recursive: true, force: true });
        build(root, ...app.localBuild.deploy);
        start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', join(root, app.localBuild.served), String(app.deployPort)]);
        await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
    };
    // The command caw starts itself: as on the command line; it inherits the environment (VITE_BUILD, CAW_SPLIT) from the run.
    const commandOf = ([, args]) => ['npx', ...args].join(' ');

    if (app.localBuild !== undefined) {
        const localDir = app.localBuild.dir;
        const buildOnce = [app.localBuild.watch[0], app.localBuild.watch[1].filter((arg) => arg !== '--watch'), app.localBuild.watch[2]];
        const overlay = (extra = {}) => ({ build: localDir, ...extra });

        await scenario(`${app.name}/overlay-build`, async () => {
            // Server: build "deployed". Locally: a build watch "local", for React and webpack with a different chunk split (CAW_SPLIT).
            await serveDeployed();
            rmSync(join(root, localDir.split('/')[0]), { recursive: true, force: true });
            start(`${app.name}-watch`, root, ...app.localBuild.watch);
            const ready = () => hasBuild(join(root, localDir)) && existsSync(join(root, localDir, 'index.html'));
            const deadline = Date.now() + 180_000;
            while (Date.now() < deadline && !ready()) await sleep(500);
            if (!ready()) throw new Error(`watch does not write ${localDir}`);
            await sleep(2000);
            // Without the option the running watch is not used; the deployed version is tested.
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'deployed', overlay: overlay() });
            record(`${app.name}/no-option`, 'smoke', passes, cawRun(root, 'smoke'));
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const smoke = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/overlay-build`, 'smoke', passes, smoke, swapped(smoke));
            const fail = cawRun(root, 'error', ['--overlay', 'build']);
            record(`${app.name}/overlay-build`, 'error', failsInApp, fail, explodeSource(fail));
        });

        await scenario(`${app.name}/overlay-build-command`, async () => {
            // No local build: with buildCommand caw builds once itself; without it the run ends with exit 2, as with a stale build.
            await serveDeployed();
            rmSync(join(root, localDir.split('/')[0]), { recursive: true, force: true });
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const missing = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/build-missing`, 'smoke', expectEnvError(/holds no build|buildCommand/), missing, envHint(missing));
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay({ buildCommand: commandOf(buildOnce) }) });
            const built = cawRun(root, 'smoke', ['--overlay', 'build'], buildOnce[2]);
            record(`${app.name}/overlay-build-command`, 'smoke', (run) => passes(run) && /Building with/.test(run.output), built);
            // A source changed after the build, without buildCommand: the build is stale.
            const source = ['src/main.tsx', 'src/main.ts', 'index.html'].map((file) => join(root, file)).find(existsSync);
            const now = new Date();
            utimesSync(source, now, now);
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const stale = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/build-stale`, 'smoke', expectEnvError(/older than your last change/), stale, envHint(stale));
        });

        await scenario(`${app.name}/overlay-dev`, async () => {
            // The dev server as the source over the deployed environment: caw starts it with devCommand and stops it at the end.
            await serveDeployed();
            const dev = `http://localhost:${app.devPort}`;
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'dev', overlay: { dev, devCommand: commandOf(app.dev) } });
            const smoke = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/overlay-dev`, 'smoke', (run) => passes(run) && /starting/.test(run.output), smoke, swapped(smoke));
            // Afterwards it no longer runs, and without devCommand the run ends with exit 2.
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'dev', overlay: { dev } });
            const down = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/dev-server-down`, 'smoke', expectEnvError(/doesn't answer/), down, envHint(down));
        });
    }

    if (app.serveCmd !== undefined) {
        await scenario(`${app.name}/overlay-ssr`, async () => {
            // SSR cannot be overlaid: exit 2 with the hint to use the dev server as the environment, never silently the server.
            build(root, ...app.build, app.env?.('deployed') ?? {});
            start(`${app.name}-server`, root, ...app.serveCmd, { ...(app.serveEnv ?? {}), ...(app.env?.('deployed') ?? {}) });
            if (!await waitFor(`http://127.0.0.1:${app.servePort}/login`, 60_000)) throw new Error('production server does not come up');
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', '-', String(app.deployPort), '--proxy', `http://127.0.0.1:${app.servePort}`]);
            await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
            start(`${app.name}-dev`, root, ...app.dev);
            if (!await waitFor(`http://127.0.0.1:${app.devPort}/login`, 180_000)) throw new Error('dev server does not come up');
            writeProject(root, { framework: app.framework, url: deployedUrl, build: 'dev', overlay: { dev: `http://127.0.0.1:${app.devPort}` } });
            const run = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/overlay-ssr`, 'smoke', expectEnvError(/server-side rendered/), run, envHint(run));
        });
    }
}

stop(api);
const summary = `RESULT OK=${results.filter((r) => r.ok).length} FAIL=${results.filter((r) => !r.ok).length}`;
console.log(summary);
writeFileSync(join(out, 'matrix.json'), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
