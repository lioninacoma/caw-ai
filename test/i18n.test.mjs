import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { detectLanguage, inLanguage, language, setLanguage, t, teamLanguage } from '../src/shared/i18n.mjs';

test('detectLanguage: CAW_LANG, then prefs.json, then the team language, then LANG, then system, else English', () => {
    const none = () => ({});
    assert.equal(detectLanguage({ env: { CAW_LANG: 'en' }, prefs: () => ({ language: 'de' }) }), 'en');
    assert.equal(detectLanguage({ env: { LANG: 'en_US.UTF-8' }, prefs: () => ({ language: 'de' }) }), 'de', 'the personal choice beats the OS');
    assert.equal(detectLanguage({ env: { LANG: 'de_DE.UTF-8' }, system: () => 'en-US', prefs: none }), 'de');
    assert.equal(detectLanguage({ env: {}, system: () => 'de-AT', prefs: none }), 'de');
    assert.equal(detectLanguage({ env: { LANG: 'C.UTF-8' }, system: () => 'fr-FR', prefs: none }), 'en');
    assert.equal(detectLanguage({ env: {}, system: () => { throw new Error('x'); }, prefs: none }), 'en');
    // The project's team language beats the system, a personal choice beats the team language; other languages don't count.
    assert.equal(detectLanguage({ env: { LANG: 'de_DE.UTF-8' }, system: () => 'de-DE', prefs: none, team: 'en' }), 'en');
    assert.equal(detectLanguage({ env: { CAW_LANG: 'de' }, prefs: none, team: 'en' }), 'de');
    assert.equal(detectLanguage({ env: {}, prefs: () => ({ language: 'de' }), team: 'en' }), 'de');
    assert.equal(detectLanguage({ env: { LANG: 'de_DE.UTF-8' }, prefs: none, team: 'fr' }), 'de');
    // prefs.json from CAW_AI_HOME.
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

test('{caw}: commands in hints as the person calls caw, npx caw when npm started it (npm i -D), caw otherwise', async (context) => {
    const { cawCommand } = await import('../src/shared/invocation.mjs');
    assert.equal(cawCommand({}), 'caw');
    assert.equal(cawCommand({ npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }), 'npx caw');
    assert.match(t('cli.untilHint', { test: 'a', target: 'local', step: 'S2' }), /: caw open a@S2 --env local$/);
    process.env.npm_execpath = 'npm-cli.js';
    context.after(() => { delete process.env.npm_execpath; });
    assert.match(t('cli.untilHint', { test: 'a', target: 'local', step: 'S2' }), /: npx caw open a@S2 --env local$/);
    assert.match(t('cli.pendingSteps', { ids: 'S5', count: 1, test: 'a', step: 'S5', target: 'local' }), /Nimm ihn auf: npx caw record a@S5 --env local$/);
    assert.match(t('run.error.todo', { keys: 'signIn.path' }), /; npx caw doctor zeigt/);
    assert.match(t('cli.recordHeadlessPlan', { file: 'caw/tests/a.yaml', command: 'npx caw record a --env local' }), /: npx caw record a --env local\.$/);
});

test('one term per thing: Zielbild for a target design in German (Entwurf is a draft in caw/drafts), App beside it, one phase name for adopting', async () => {
    const de = Object.assign({}, ...await Promise.all(['run', 'session', 'workbench', 'config'].map(async (name) => (await import(`../src/shared/locales/de/${name}.mjs`)).default)));
    const { default: enBench } = await import('../src/shared/locales/en/workbench.mjs');
    assert.equal(de['run.button.openDesign'], 'Mit Zielbild öffnen');
    assert.equal(de['workbench.page.cmp.app'], 'App', 'beside "Zielbild" on the comparison page, as its other texts say App');
    assert.match(de['run.button.buildAgain'], /\{agent\}/, 'like every other button that starts the agent');
    for (const key of ['run.develop.designFailed', 'run.develop.designShown', 'run.develop.buildDesignAsk', 'run.develop.designMissing', 'run.develop.designUpdated', 'run.newWindow.open', 'run.flow.designNext', 'run.mcp.designUnlinked', 'session.design.noFile', 'session.design.error', 'config.report.warning.design']) {
        assert.doesNotMatch(de[key], /Entwurf/, key);
        assert.match(de[key], /Zielbild/, key);
    }
    assert.equal(enBench['workbench.page.flow.adopt'], 'Adopt', 'the button says Adopt, the last step of both flows too');
});
