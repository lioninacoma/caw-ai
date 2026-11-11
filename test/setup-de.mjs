// The unit tests check the German texts; child processes inherit the language.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CAW_LANG = 'de';
// Never read personal settings from the real user folder; no token notice (token-gate.test.mjs checks that one).
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-home-'));
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
