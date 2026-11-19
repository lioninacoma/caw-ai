// The unit tests check the German texts; child processes inherit the language.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CAW_LANG = 'de';

// Everything a test process creates in the temp folder (its own folders, Chrome profiles, Playwright artifacts, child
// processes) goes into one folder of its own, removed when the process ends. Otherwise every run leaves hundreds behind.
// A child process started with this setup inherits the folder and leaves it to its parent.
if (process.env.CAW_TEST_TMP === undefined) {
    const own = mkdtempSync(join(tmpdir(), 'caw-test-'));
    process.env.CAW_TEST_TMP = own;
    for (const name of ['TEMP', 'TMP', 'TMPDIR']) process.env[name] = own;
    process.on('exit', () => {
        try {
            rmSync(own, { recursive: true, force: true, maxRetries: 3 });
        } catch {
            // A file Chrome still holds: the rest is gone, the folder goes with the next cleanup.
        }
    });
}

// Never read personal settings from the real user folder; no token notice (token-gate.test.mjs checks that one).
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-home-'));
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
