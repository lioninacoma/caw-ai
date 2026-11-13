// N14: the framework matrix (e2e/frameworks/matrix.mjs) with the recordings frameworks/project.mjs writes as locators. Every line
// the matrix reports counts as one check. CAW_E2E_MATRIX narrows it like the matrix's own filter (e.g. "react/dev").
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { here, print, verify } from '../harness.mjs';

const matrix = () => new Promise((resolve) => {
    const filter = process.env.CAW_E2E_MATRIX;
    const child = spawn(process.execPath, ['matrix.mjs', ...(filter ? [filter] : [])], { cwd: join(here, 'frameworks'), stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '';
    const lines = [];
    const take = (chunk) => {
        rest += chunk;
        const parts = rest.split('\n');
        rest = parts.pop();
        for (const line of parts.map((text) => text.trimEnd())) {
            lines.push(line);
            // The matrix's own lines; build output and the like stay in the console (they keep the watchdog's log alive).
            if (/^(OK {2}|FAIL) /.test(line)) verify(`matrix ${line.slice(5)}`, line.startsWith('OK'));
            else console.log(`  | ${line}`);
        }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => resolve({ code, lines }));
});

export const scenarios = [{
    id: 'N14',
    title: 'Framework matrix with recordings as locators: dev, deployed and overlay per framework',
    body: async () => {
        const { code, lines } = await matrix();
        const summary = lines.find((line) => line.startsWith('RESULT ')) ?? '';
        print(`matrix ${summary}`);
        verify('matrix ran to the end', summary !== '' && /OK=[1-9]/.test(summary), `exit ${code}`);
    },
}];
