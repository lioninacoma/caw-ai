import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detectLanguage, language, setLanguage, t } from '../src/shared/i18n.mjs';

test('detectLanguage: CAW_LANG, dann Config, dann LANG, dann System, sonst Englisch', () => {
    const root = mkdtempSync(join(tmpdir(), 'caw-i18n-'));
    writeFileSync(join(root, 'caw.config.json'), JSON.stringify({ language: 'de' }));
    assert.equal(detectLanguage({ env: { CAW_LANG: 'en' }, root }), 'en');
    assert.equal(detectLanguage({ env: { LANG: 'en_US.UTF-8' }, root }), 'de');
    assert.equal(detectLanguage({ env: { LANG: 'de_DE.UTF-8' }, system: () => 'en-US' }), 'de');
    assert.equal(detectLanguage({ env: {}, system: () => 'de-AT' }), 'de');
    assert.equal(detectLanguage({ env: { LANG: 'C.UTF-8' }, system: () => 'fr-FR' }), 'en');
    assert.equal(detectLanguage({ env: {}, system: () => { throw new Error('x'); } }), 'en');
});

test('t: Platzhalter, unbekannter Schluessel bleibt stehen, setLanguage faellt auf Englisch', () => {
    const before = language();
    assert.equal(setLanguage('fr'), 'en');
    assert.equal(t('gibt.es.nicht', { a: 1 }), 'gibt.es.nicht');
    setLanguage(before);
});
