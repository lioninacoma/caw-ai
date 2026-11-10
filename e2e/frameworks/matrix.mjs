// Framework-Matrix: React (Vite und webpack), Vue, Angular (zoneless und Zone.js), Next.js und Nuxt. Je Variante: der Dev-Server als
// Umgebung (dev), der Produktions-Build hinter HTTPS (deployt) und das Overlay ueber dem deployten Stand: ohne Option bleibt er es
// trotz laufendem Watch (e2e-ohne-option), --overlay build mit anderer Aufteilung (React, webpack), caw baut selbst (buildCommand),
// Exit 2 ohne Build oder mit altem Build, --overlay dev mit devCommand, Exit 2 ohne Dev-Server, bei Next und Nuxt Exit 2 wegen SSR.
// Claude wird nie gestartet: Aufzeichnungen stehen von Hand in projekt.mjs.
//   node e2e/frameworks/matrix.mjs [filter]       z. B. "react" oder "angular-zone/dev"
// Voraussetzungen: npm install in jedem Projekt, Chrome. Ergebnis in e2e/frameworks/ergebnis/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasBuild } from '../../src/host/local-build.mjs';
import { writeProject } from './projekt.mjs';
import { ensureCert } from './shared/cert.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '../../bin/caw-ai.mjs');
const out = join(here, 'ergebnis');
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
const waitForFile = async (file, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !existsSync(file)) await sleep(300);
    return existsSync(file);
};

/** Ein caw-ai-Lauf im Projekt, wie in CI. Liefert Exit-Code, Ausgabe und, falls geschrieben, result.json und report.md. */
const cawRun = (root, test, extra = [], env = {}) => {
    rmSync(join(root, '.caw/runs'), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [bin, 'run', test, '--target', 'test', '--headless', ...extra], {
        cwd: root, encoding: 'utf8', timeout: 180_000,
        env: { ...process.env, ...env, CI: '1', CAW_LANG: 'de', CAW_AI_HOME: join(here, '.caw-home'), NO_COLOR: '1' },
    });
    const runs = join(root, '.caw/runs');
    const dir = existsSync(runs) ? readdirSync(runs).map((name) => join(runs, name)).find((path) => existsSync(join(path, 'result.json'))) : undefined;
    return {
        code: result.status ?? (result.error ? `Fehler: ${result.error.code}` : 'kein Exit'),
        output: `${result.stdout}${result.stderr}`,
        verdict: dir ? JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) : null,
        report: dir ? readFileSync(join(dir, 'report.md'), 'utf8') : '',
    };
};

const vite = (dir, port) => ({
    dev: [npx, ['vite', '--port', String(port)]], build: [npx, ['vite', 'build']], out: 'dist', env: (value) => ({ VITE_BUILD: value }),
    // Normale Builds mit Hash: deployt nach deploy/, lokal per Watch nach local/.
    localBuild: { deploy: [npx, ['vite', 'build', '--outDir', 'deploy'], { VITE_BUILD: 'deployed' }], served: 'deploy', watch: [npx, ['vite', 'build', '--watch', '--outDir', 'local'], { VITE_BUILD: 'local', CAW_SPLIT: '1' }], dir: 'local' },
});
// webpack 5: klassische Skripte, eine Laufzeit laedt Chunks per JSONP, Hash als [contenthash] hinter einem Punkt.
const webpack = (port) => ({
    dev: [npx, ['webpack', 'serve', '--mode', 'development', '--port', String(port)]], build: [npx, ['webpack', '--mode', 'production']], out: 'dist', env: (value) => ({ CAW_BUILD: value }),
    localBuild: { deploy: [npx, ['webpack', '--mode', 'production', '--output-path', 'deploy'], { CAW_BUILD: 'deployed' }], served: 'deploy', watch: [npx, ['webpack', '--mode', 'production', '--watch', '--output-path', 'local'], { CAW_BUILD: 'local', CAW_SPLIT: '1' }], dir: 'local' },
});
const ng = (configs) => ({
    deploy: [npx, ['ng', 'build', '-c', configs, '--output-path', 'deploy']], served: 'deploy/browser',
    watch: [npx, ['ng', 'build', '-c', `${configs},local`, '--watch', '--output-path', 'local']], dir: 'local/browser',
});

// Jede Variante: Projekt, Framework fuer caw-ai, und wie sie lokal (Dev-Server) bzw. deployt laeuft.
const APPS = [
    { name: 'react', dir: 'react-vite', framework: 'react', embed: true, devPort: 5173, deployPort: 8441, ...vite('react-vite', 5173) },
    { name: 'webpack', dir: 'react-webpack', framework: 'react', embed: true, devPort: 5175, deployPort: 8447, ...webpack(5175) },
    { name: 'vue', dir: 'vue-vite', framework: 'vue', devPort: 5174, deployPort: 8442, ...vite('vue-vite', 5174) },
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
    const line = `${ok ? 'OK  ' : 'FEHL'} ${scenario} ${test} exit=${run.code} ${steps} ${extra}`.trim();
    console.log(line);
    results.push({ scenario, test, ok, code: run.code, steps, extra });
    writeFileSync(join(out, `${scenario.replaceAll('/', '_')}-${test}.txt`), `${run.output}\n\n----- report.md\n${run.report}`);
};
const passes = (run) => run.code === 0;
// Der absichtliche Fehler muss als Anwendungsfehler auffallen und auf die eigene Quelldatei zeigen (Source Maps, stackSkip).
const failsInApp = (run) => run.code === 1;
const explodeSource = (run) => (/explode\.ts/.test(`${run.report}${run.output}`) ? 'quelle=explode.ts' : 'quelle=?');

const scenario = async (name, body) => {
    if (filter !== undefined && !name.includes(filter)) return;
    console.log(`##### ${name}`);
    try {
        await body();
    } catch (error) {
        console.log(`FEHL ${name} Abbruch: ${error.message.split('\n').slice(0, 6).join(' | ')}`);
        results.push({ scenario: name, test: '-', ok: false, code: 'abbruch', steps: '', extra: error.message.split('\n')[0] });
    } finally {
        while (children.length > 1) stop(children.pop());
        await sleep(1000);
    }
};

// Einmal vorab: Die HTTPS-Server starten parallel und sollen es nicht gleichzeitig erzeugen.
ensureCert();
const api = start('api', here, process.execPath, ['shared/api.mjs', '3999']);
await waitFor('http://127.0.0.1:3999/api/me');

for (const app of APPS) {
    const root = join(here, app.dir);
    await scenario(`${app.name}/dev`, async () => {
        writeProject(root, { framework: app.framework, embed: app.embed === true, url: `http://localhost:${app.devPort}`, build: 'dev' });
        start(`${app.name}-dev`, root, ...app.dev);
        if (!await waitFor(`http://127.0.0.1:${app.devPort}/login`, 180_000)) throw new Error('Dev-Server kommt nicht hoch');
        // Erster Aufruf baut bei Next/Nuxt/Angular die Seiten; einmal vorwaermen, sonst misst der Lauf den Compiler.
        await fetch(`http://127.0.0.1:${app.devPort}/`).catch(() => {});
        const smoke = cawRun(root, 'smoke');
        record(`${app.name}/dev`, 'smoke', passes, smoke);
        const fail = cawRun(root, 'fehler');
        record(`${app.name}/dev`, 'fehler', failsInApp, fail, explodeSource(fail));
    });

    await scenario(`${app.name}/deployt`, async () => {
        build(root, ...app.build, app.env?.('deployed') ?? { VITE_BUILD: 'deployed' });
        if (app.serveCmd) {
            start(`${app.name}-server`, root, ...app.serveCmd, { ...(app.serveEnv ?? {}), ...(app.env?.('deployed') ?? {}) });
            if (!await waitFor(`http://127.0.0.1:${app.servePort}/login`, 60_000)) throw new Error('Produktionsserver kommt nicht hoch');
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', '-', String(app.deployPort), '--proxy', `http://127.0.0.1:${app.servePort}`]);
        } else {
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', join(root, app.out), String(app.deployPort)]);
        }
        await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
        writeProject(root, { framework: app.framework, embed: app.embed === true, url: `https://${app.name.split('-')[0]}.localhost:${app.deployPort}`, build: 'deployed' });
        const smoke = cawRun(root, 'smoke');
        record(`${app.name}/deployt`, 'smoke', passes, smoke);
        const fail = cawRun(root, 'fehler');
        record(`${app.name}/deployt`, 'fehler', failsInApp, fail, explodeSource(fail));
    });

    const expectEnvError = (pattern) => (run) => run.code === 2 && pattern.test(run.output);
    const envHint = (run) => (run.output.match(/\[caw-ai\][^\n]*(Overlay|Build|Dev-Server|serverseitig|lokal)[^\n]*/) ?? [''])[0].slice(0, 160);
    const deployedUrl = `https://${app.name.split('-')[0]}.localhost:${app.deployPort}`;
    const serveDeployed = async () => {
        rmSync(join(root, 'deploy'), { recursive: true, force: true });
        build(root, ...app.localBuild.deploy);
        start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', join(root, app.localBuild.served), String(app.deployPort)]);
        await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
    };
    // Der Befehl, den caw selbst startet: wie auf der Kommandozeile, die Umgebung (VITE_BUILD, CAW_SPLIT) erbt er vom Lauf.
    const commandOf = ([, args]) => ['npx', ...args].join(' ');

    if (app.localBuild !== undefined) {
        const localDir = app.localBuild.dir;
        const buildOnce = [app.localBuild.watch[0], app.localBuild.watch[1].filter((arg) => arg !== '--watch'), app.localBuild.watch[2]];
        const overlay = (extra = {}) => ({ build: localDir, ...extra });

        await scenario(`${app.name}/overlay-build`, async () => {
            // Server: Build "deployed". Lokal: ein Build-Watch "local", bei React und webpack mit anderer Aufteilung (CAW_SPLIT).
            await serveDeployed();
            rmSync(join(root, localDir.split('/')[0]), { recursive: true, force: true });
            start(`${app.name}-watch`, root, ...app.localBuild.watch);
            const ready = () => hasBuild(join(root, localDir)) && existsSync(join(root, localDir, 'index.html'));
            const deadline = Date.now() + 180_000;
            while (Date.now() < deadline && !ready()) await sleep(500);
            if (!ready()) throw new Error(`Watch schreibt ${localDir} nicht`);
            await sleep(2000);
            // Ohne Option: Der laufende Watch wird nicht genutzt, getestet wird der ausgelieferte Stand.
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'deployed', overlay: overlay() });
            record(`${app.name}/e2e-ohne-option`, 'smoke', passes, cawRun(root, 'smoke'));
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const smoke = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/overlay-build`, 'smoke', passes, smoke, /Seite getauscht: ja/.test(smoke.report) ? 'getauscht' : 'nicht getauscht');
            const fail = cawRun(root, 'fehler', ['--overlay', 'build']);
            record(`${app.name}/overlay-build`, 'fehler', failsInApp, fail, explodeSource(fail));
        });

        await scenario(`${app.name}/overlay-build-baut`, async () => {
            // Kein lokaler Build: Mit buildCommand baut caw einmal selbst; ohne endet der Lauf mit Exit 2, ebenso bei einem alten Build.
            await serveDeployed();
            rmSync(join(root, localDir.split('/')[0]), { recursive: true, force: true });
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const missing = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/build-fehlt`, 'smoke', expectEnvError(/kein Build|buildCommand/), missing, envHint(missing));
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay({ buildCommand: commandOf(buildOnce) }) });
            const built = cawRun(root, 'smoke', ['--overlay', 'build'], buildOnce[2]);
            record(`${app.name}/overlay-build-baut`, 'smoke', (run) => passes(run) && /Baue mit/.test(run.output), built);
            // Eine Quelle nach dem Build geaendert, ohne buildCommand: Der Build ist alt.
            const source = ['src/main.tsx', 'src/main.ts', 'index.html'].map((file) => join(root, file)).find(existsSync);
            const now = new Date();
            utimesSync(source, now, now);
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'local', overlay: overlay() });
            const stale = cawRun(root, 'smoke', ['--overlay', 'build']);
            record(`${app.name}/build-alt`, 'smoke', expectEnvError(/älter als deine letzte Änderung/), stale, envHint(stale));
        });

        await scenario(`${app.name}/overlay-dev`, async () => {
            // Der Dev-Server als Quelle ueber der ausgelieferten Umgebung: caw startet ihn mit devCommand und beendet ihn am Ende.
            await serveDeployed();
            const dev = `http://localhost:${app.devPort}`;
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'dev', overlay: { dev, devCommand: commandOf(app.dev) } });
            const smoke = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/overlay-dev`, 'smoke', (run) => passes(run) && /starte/.test(run.output), smoke, /Seite getauscht: ja/.test(smoke.report) ? 'getauscht' : 'nicht getauscht');
            // Danach laeuft er nicht mehr, und ohne devCommand endet der Lauf mit Exit 2.
            writeProject(root, { framework: app.framework, embed: app.embed === true, url: deployedUrl, build: 'dev', overlay: { dev } });
            const down = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/dev-server-aus`, 'smoke', expectEnvError(/antwortet nicht/), down, envHint(down));
        });
    }

    if (app.serveCmd !== undefined) {
        await scenario(`${app.name}/overlay-ssr`, async () => {
            // SSR laesst sich nicht ueberlagern: Exit 2 mit dem Hinweis auf den Dev-Server als Umgebung, nie still der Server.
            build(root, ...app.build, app.env?.('deployed') ?? {});
            start(`${app.name}-server`, root, ...app.serveCmd, { ...(app.serveEnv ?? {}), ...(app.env?.('deployed') ?? {}) });
            if (!await waitFor(`http://127.0.0.1:${app.servePort}/login`, 60_000)) throw new Error('Produktionsserver kommt nicht hoch');
            start(`${app.name}-https`, here, process.execPath, ['shared/serve.mjs', '-', String(app.deployPort), '--proxy', `http://127.0.0.1:${app.servePort}`]);
            await waitFor(`https://127.0.0.1:${app.deployPort}/login`);
            start(`${app.name}-dev`, root, ...app.dev);
            if (!await waitFor(`http://127.0.0.1:${app.devPort}/login`, 180_000)) throw new Error('Dev-Server kommt nicht hoch');
            writeProject(root, { framework: app.framework, url: deployedUrl, build: 'dev', overlay: { dev: `http://127.0.0.1:${app.devPort}` } });
            const run = cawRun(root, 'smoke', ['--overlay', 'dev']);
            record(`${app.name}/overlay-ssr`, 'smoke', expectEnvError(/serverseitig gerendert/), run, envHint(run));
        });
    }
}

stop(api);
const summary = `ERGEBNIS OK=${results.filter((r) => r.ok).length} FEHL=${results.filter((r) => !r.ok).length}`;
console.log(summary);
writeFileSync(join(out, 'matrix.json'), JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
