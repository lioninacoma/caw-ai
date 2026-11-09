// Die Unit-Tests pruefen die deutschen Texte; Kindprozesse erben die Sprache.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CAW_LANG = 'de';
// Persoenliche Einstellungen nie aus dem echten Nutzerverzeichnis; ohne Hinweis auf Token, den prueft token-gate.test.mjs.
process.env.CAW_AI_HOME = mkdtempSync(join(tmpdir(), 'caw-home-'));
writeFileSync(join(process.env.CAW_AI_HOME, 'prefs.json'), JSON.stringify({ tokenNotice: 'off' }));
