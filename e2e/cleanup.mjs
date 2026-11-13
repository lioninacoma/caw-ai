// Removes what the e2e left on this machine, and only that: containers, networks and volumes of compose projects named caw-e2e-*
// (left by an aborted run or CAW_E2E_KEEP=1), the packed tarball, the e2e's own prefs folder. With --images also the images of
// e2e/images.lock.json (about 0.5 GB and more; a later run pulls them again with node e2e/pull.mjs).
// The suite changes no network, firewall or hosts settings; WSL is started by Docker use and left running (stop it yourself with
// `wsl --terminate <distribution>` if you want: other WSL work of yours may be running there).
//   node e2e/cleanup.mjs [--images]
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { docker, imageLock } from './infra.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_LABEL = 'com.docker.compose.project';
const OURS = /^caw-e2e-/;

/** Rows "<id> <project>" of a docker list command, only those of our projects. */
const ours = async (args) => {
    const { stdout } = await docker([...args, '--filter', `label=${PROJECT_LABEL}`, '--format', `{{.ID}} {{.Label "${PROJECT_LABEL}"}}`]);
    return stdout.split('\n').map((line) => line.trim().split(' ')).filter(([id, project]) => id && OURS.test(project ?? ''));
};
const remove = async (kind, rows, command) => {
    if (rows.length === 0) return;
    await docker([...command, ...rows.map(([id]) => id)]);
    console.log(`removed ${rows.length} ${kind}: ${[...new Set(rows.map(([, project]) => project))].join(', ')}`);
};

await remove('containers', await ours(['ps', '-a']), ['rm', '-f']);
await remove('networks', await ours(['network', 'ls']), ['network', 'rm']);
// Volumes have no ID column: their name is the key.
const { stdout: volumes } = await docker(['volume', 'ls', '--filter', `label=${PROJECT_LABEL}`, '--format', `{{.Name}} {{.Label "${PROJECT_LABEL}"}}`]);
await remove('volumes', volumes.split('\n').map((line) => line.trim().split(' ')).filter(([name, project]) => name && OURS.test(project ?? '')), ['volume', 'rm']);

if (process.argv.includes('--images')) {
    for (const image of Object.keys(imageLock())) {
        const { code, stderr } = await docker(['rmi', image], { allowFail: true });
        console.log(code === 0 ? `removed image ${image}` : `kept image ${image}: ${stderr.trim().split('\n').pop()}`);
    }
}
for (const folder of ['.pack', '.caw-home']) {
    if (!existsSync(join(here, folder))) continue;
    rmSync(join(here, folder), { recursive: true, force: true });
    console.log(`removed e2e/${folder}`);
}
console.log('done');
