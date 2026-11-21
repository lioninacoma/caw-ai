// Captures runs of the spike test for simulate.mjs: starts app.mjs, writes the project (project.mjs) into e2e/spike/work and
// runs the test headless through the package's own `caw run`, as e2e/scenarios/environments.mjs go() does. Before each run it
// posts a noise profile (and for regression runs one injected regression); after it, it appends one JSON line with the run's
// result.json steps[], the profile and the environment.
//
//   node e2e/spike/capture.mjs [--healthy 150] [--regressions 30] [--envs a,b] [--regression-envs a] [--kinds all]
//                              [--mode raw|live] [--out e2e/spike/data/capture.jsonl] [--seed 1] [--port 18320]
//
// --mode raw (default): CI=1, so no run learns and the recording stays as written: every run is a raw observation and the
//   methods learn offline. --mode live: outside CI, so the product learns (M0 before the spike decision, M1 since); the
//   line then also carries how many recording lines the run changed, to check the offline method against the product.
// Healthy and regression runs are interleaved per environment, so slow drifts of the machine hit every kind alike.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REGRESSIONS, SPIKE_PORT, seeded, startApp } from './app.mjs';
import { TEST_ID, writeProject } from './project.mjs';

const spikeDir = dirname(fileURLToPath(import.meta.url));
const root = join(spikeDir, 'work');

/**
 * The healthy noise per environment: latency with jitter and rare spikes, a sync notice that flickers, and on b foreign rows
 * and a third-party widget that sometimes fails. b's doubled latency comes from app.mjs itself.
 */
export const healthyProfile = (env, seed) => ({
    seed,
    latency: { base: 120, jitter: 120, spikeP: 0.03, spikeMs: 2500, creepPct: 0 },
    flicker: { p: 0.15 },
    foreignRows: env === 'b' ? { p: 0.5, n: 3 } : { p: 0, n: 0 },
    thirdPartyError: env === 'b' ? { p: 0.2 } : { p: 0 },
});

const flag = (args, name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? fallback : args[at + 1];
};

/** A test endpoint of one environment: loopback with the environment's host name, no name resolution needed. */
export const testCall = (port, env, path, body) => new Promise((resolve, reject) => {
    const sent = body === undefined ? undefined : JSON.stringify(body);
    const call = request({ host: '127.0.0.1', port, path, method: sent === undefined ? 'GET' : 'POST', headers: { host: `${env}.localhost:${port}`, 'content-type': 'application/json' } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => (response.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${path} on ${env}: HTTP ${response.statusCode} ${text}`))));
    });
    call.on('error', reject);
    call.end(sent);
});

const newestRun = () => {
    const dir = join(root, '.caw/runs');
    if (!existsSync(dir)) return null;
    const [latest] = readdirSync(dir).filter((name) => name.endsWith(`Z-${TEST_ID}`)).sort().reverse();
    const file = latest === undefined ? null : join(dir, latest, 'result.json');
    return file === null || !existsSync(file) ? null : { name: latest, result: JSON.parse(readFileSync(file, 'utf8')) };
};
const recordingText = () => {
    const file = join(root, 'caw/recordings', `${TEST_ID}.yaml`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

/** One headless run without chat; caw's own output goes to the capture log, not the terminal. */
const runOnce = async (env, { live, log, run, exitOf }) => {
    const saved = process.env.CI;
    process.env.CI = live ? '' : '1';
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { appendFileSync(log, String(chunk)); return true; };
    try {
        return await run(root, [TEST_ID, '--env', env, '--headless', '--step-timeout', '10s']).then((code) => ({ exit: code }), (error) => ({ exit: exitOf(error.code), code: error.code, message: String(error.message) }));
    } finally {
        process.stdout.write = write;
        if (saved === undefined) delete process.env.CI;
        else process.env.CI = saved;
    }
};

/** The run order per environment: healthy and regression runs shuffled together with a seeded generator. */
export const plan = ({ envs, regressionEnvs, healthy, regressions, kinds, seed }) => {
    const random = seeded(seed);
    return envs.flatMap((env) => {
        const list = [
            ...Array.from({ length: healthy }, () => 'healthy'),
            ...(regressionEnvs.includes(env) ? kinds.flatMap((kind) => Array.from({ length: regressions }, () => kind)) : []),
        ];
        for (let index = list.length - 1; index > 0; index -= 1) {
            const other = Math.floor(random() * (index + 1));
            [list[index], list[other]] = [list[other], list[index]];
        }
        return list.map((kind) => ({ env, kind }));
    });
};

const main = async () => {
    // Personal settings of caw go next to the project, never into the real user folder (as e2e/harness.mjs does).
    process.env.CAW_AI_HOME = join(root, '.caw-home');
    mkdirSync(process.env.CAW_AI_HOME, { recursive: true });
    writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
    const { run } = await import('../../src/host/commands.mjs');
    const { exitOf } = await import('../../src/shared/errors.mjs');
    const args = process.argv.slice(2);
    const port = Number(flag(args, 'port', SPIKE_PORT));
    const live = flag(args, 'mode', 'raw') === 'live';
    const out = flag(args, 'out', join(spikeDir, 'data/capture.jsonl'));
    const kindsFlag = flag(args, 'kinds', 'all');
    const options = {
        envs: flag(args, 'envs', 'a,b').split(','),
        regressionEnvs: flag(args, 'regression-envs', 'a').split(','),
        healthy: Number(flag(args, 'healthy', 150)),
        regressions: Number(flag(args, 'regressions', 30)),
        kinds: kindsFlag === 'all' ? REGRESSIONS : kindsFlag.split(','),
        seed: Number(flag(args, 'seed', 1)),
    };
    for (const kind of options.kinds) if (!REGRESSIONS.includes(kind)) throw new Error(`unknown regression kind ${kind}`);
    const app = await startApp({ port });
    mkdirSync(dirname(out), { recursive: true });
    writeProject(root, app.port);
    const log = join(root, 'capture.log');
    writeFileSync(log, '');
    const runs = plan(options);
    const started = Date.now();
    try {
        for (const env of options.envs) await testCall(app.port, env, '/test/profile', { reset: true });
        for (const [index, { env, kind }] of runs.entries()) {
            const seed = options.seed * 100_000 + index;
            const profile = { ...healthyProfile(env, seed), regression: kind === 'healthy' ? null : kind };
            await testCall(app.port, env, '/test/profile', profile);
            const before = newestRun()?.name;
            const recording = recordingText();
            const outcome = await runOnce(env, { live, log, run, exitOf });
            const ran = newestRun();
            const result = ran !== null && ran.name !== before ? ran.result : null;
            const after = recordingText();
            const line = {
                v: 1, at: new Date().toISOString(), index, env, kind, mode: live ? 'live' : 'raw', profile,
                exit: outcome.exit, ...(outcome.code === undefined ? {} : { error: outcome.code, message: outcome.message.split('\n')[0] }),
                status: result?.status, target: result?.target,
                steps: result?.steps ?? [],
                results: (result?.results ?? []).map(({ id, status, note }) => ({ id, status, ...(note === undefined ? {} : { note }) })),
                failures: result?.failures ?? [],
                ...(result?.diagnosis === undefined ? {} : { diagnosis: result.diagnosis }),
                rows: await testCall(app.port, env, '/test/rows'),
                ...(live ? { recordingChanged: after !== recording } : {}),
            };
            appendFileSync(out, `${JSON.stringify(line)}\n`);
            const elapsed = (Date.now() - started) / 1000;
            const left = (elapsed / (index + 1)) * (runs.length - index - 1);
            console.log(`${index + 1}/${runs.length} ${env} ${kind}: exit ${outcome.exit}${outcome.code === undefined ? '' : ` (${outcome.code})`}, ${Math.round(left / 60)} min left`);
        }
    } finally {
        await app.close();
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
