import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detectLanguage, inLanguage, language, setLanguage, t, teamLanguage } from '../src/shared/i18n.mjs';

test('detectLanguage: CAW_LANG, then prefs.json, then LANG, then system, else English; never the project config', () => {
    const none = () => ({});
    assert.equal(detectLanguage({ env: { CAW_LANG: 'en' }, prefs: () => ({ language: 'de' }) }), 'en');
    assert.equal(detectLanguage({ env: { LANG: 'en_US.UTF-8' }, prefs: () => ({ language: 'de' }) }), 'de', 'the personal choice beats the OS');
    assert.equal(detectLanguage({ env: { LANG: 'de_DE.UTF-8' }, system: () => 'en-US', prefs: none }), 'de');
    assert.equal(detectLanguage({ env: {}, system: () => 'de-AT', prefs: none }), 'de');
    assert.equal(detectLanguage({ env: { LANG: 'C.UTF-8' }, system: () => 'fr-FR', prefs: none }), 'en');
    assert.equal(detectLanguage({ env: {}, system: () => { throw new Error('x'); }, prefs: none }), 'en');
    // prefs.json from CAW_AI_HOME; a project config with language de does not count.
    const home = mkdtempSync(join(tmpdir(), 'caw-i18n-'));
    writeFileSync(join(home, 'prefs.json'), JSON.stringify({ language: 'de' }));
    assert.equal(detectLanguage({ env: { CAW_AI_HOME: home, LANG: 'en_US.UTF-8' } }), 'de');
    writeFileSync(join(home, 'caw.config.json'), JSON.stringify({ language: 'en' }));
    writeFileSync(join(home, 'prefs.json'), JSON.stringify({ language: 'xx' }));
    assert.equal(detectLanguage({ env: { CAW_AI_HOME: home, LANG: 'de_DE.UTF-8' } }), 'de', 'an unknown prefs value is ignored');
});

test('team language: config language, else the UI language; inLanguage switches only for the call', () => {
    const before = language();
    setLanguage('de');
    assert.equal(teamLanguage({ language: 'fr' }), 'fr');
    assert.equal(teamLanguage({}), 'de');
    const english = inLanguage('en', () => t('cli.uiLanguage', { language: 'fr' }));
    assert.equal(english, 'team language fr');
    assert.equal(inLanguage('fr', () => t('cli.uiLanguage', { language: 'fr' })), 'team language fr', 'not de/en: English');
    assert.equal(t('cli.uiLanguage', { language: 'fr' }), 'Teamsprache fr', 'back to the UI language');
    assert.throws(() => inLanguage('en', () => { throw new Error('x'); }));
    assert.equal(language(), 'de', 'also after a throw');
    setLanguage(before);
});

test('t: placeholders, an unknown key is returned as is, setLanguage falls back to English', () => {
    const before = language();
    assert.equal(setLanguage('fr'), 'en');
    assert.equal(t('gibt.es.nicht', { a: 1 }), 'gibt.es.nicht');
    setLanguage(before);
});
