// Lifecycle commands for the spa fixture, as a team would write them around docker compose (P4, scenarios S4 and D1). Run from
// the project root (e2e/spa/work), which is where caw runs environment commands. Every call appends a line to lifecycle.log
// there, so a scenario can count how often start, stop and reset ran.
//   node ../ctl.mjs up <port>      start serve.mjs <port> --only detached, wait for /healthz, exit 0 (like up -d --wait)
//   node ../ctl.mjs down <port>    end the server started by up
//   node ../ctl.mjs reset <port>   clear the environment's data (POST /test/reset on life.localhost)
//   node ../ctl.mjs fail           print a reason and exit 3 (a broken start or reset)
//   node ../ctl.mjs mode <port>    app.mode in the project root says abort: the page aborts its search (a commit with the bug, S12)
//   node ../ctl.mjs hang           run until killed, never ready (a start that never gets ready)
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [command, port] = process.argv.slice(2);
const pidFile = join(process.cwd(), `.ctl-${port}.pid`);
appendFileSync(join(process.cwd(), 'lifecycle.log'), `${command}${port === undefined ? '' : ` ${port}`} ${process.env.CAW_ENV ?? '-'}\n`);

const call = (method, path) => new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: Number(port), method, path, headers: { host: `life.localhost:${port}` }, timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
});

if (command === 'up') {
    const child = spawn(process.execPath, [join(here, 'serve.mjs'), port, '--only'], { cwd: here, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    writeFileSync(pidFile, String(child.pid));
    const until = Date.now() + 15000;
    while (Date.now() < until && await call('GET', '/healthz') !== 200) await new Promise((resolve) => { setTimeout(resolve, 200); });
    process.exit(await call('GET', '/healthz') === 200 ? 0 : 1);
} else if (command === 'down') {
    if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'));
        try {
            if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            else process.kill(pid, 'SIGTERM');
        } catch {
            // already gone
        }
        rmSync(pidFile, { force: true });
    }
} else if (command === 'reset') {
    process.exit(await call('POST', '/test/reset') === 200 ? 0 : 1);
} else if (command === 'mode') {
    const mode = existsSync(join(process.cwd(), 'app.mode')) ? readFileSync(join(process.cwd(), 'app.mode'), 'utf8').trim() : 'ok';
    process.exit(await call('POST', mode === 'abort' ? '/test/abort-on' : '/test/abort-off') === 200 ? 0 : 1);
} else if (command === 'fail') {
    console.log('seed: table tickets is missing (fictitious failure)');
    process.exit(3);
} else if (command === 'hang') {
    setInterval(() => {}, 1000);
} else {
    console.error(`unknown command ${command}`);
    process.exit(2);
}
