// German and English catalogues stay in step: same keys per area, same {placeholders}, same kind of entry.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { language, setLanguage, t } from '../src/shared/i18n.mjs';
import { CATALOGS } from '../src/shared/locales/index.mjs';

const LOCALES = fileURLToPath(new URL('../src/shared/locales/', import.meta.url));
const areas = readdirSync(join(LOCALES, 'en')).filter((name) => name.endsWith('.mjs')).sort();
const load = async (lang, area) => (await import(pathToFileURL(join(LOCALES, lang, area)).href)).default;
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name))].sort();

test('both languages have the same area files', () => {
    assert.deepEqual(readdirSync(join(LOCALES, 'de')).filter((name) => name.endsWith('.mjs')).sort(), areas);
});

for (const area of areas) {
    test(`${area}: every key exists in de and en`, async () => {
        const [de, en] = [await load('de', area), await load('en', area)];
        assert.deepEqual(Object.keys(de).filter((key) => !(key in en)), [], 'only in de');
        assert.deepEqual(Object.keys(en).filter((key) => !(key in de)), [], 'only in en');
    });
}

test('no key is defined in two areas (the merged catalogue would hide one)', async () => {
    const seen = new Map();
    const twice = [];
    for (const area of areas) {
        for (const key of Object.keys(await load('en', area))) {
            if (seen.has(key)) twice.push(`${key} (${seen.get(key)}, ${area})`);
            else seen.set(key, area);
        }
    }
    assert.deepEqual(twice, []);
});

test('placeholders and entry kind match between de and en', () => {
    const { de, en } = CATALOGS;
    const problems = [];
    for (const [key, german] of Object.entries(de)) {
        const english = en[key];
        if (english === undefined) continue;
        if (typeof german !== typeof english) problems.push(`${key}: ${typeof german} in de, ${typeof english} in en`);
        else if (typeof german === 'string' && placeholders(german).join() !== placeholders(english).join()) {
            problems.push(`${key}: {${placeholders(german).join(', ')}} in de, {${placeholders(english).join(', ')}} in en`);
        }
    }
    assert.deepEqual(problems, []);
});

test('function entries render in both languages with the same variables', () => {
    // Every variable is a value that works as number, text and list, so the entry can't fail on a missing one.
    const anything = Object.assign([2], { toString: () => 'x', valueOf: () => 2 });
    const vars = new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? anything : undefined), has: () => true });
    const render = (entry) => {
        try {
            return typeof entry(vars);
        } catch (error) {
            return `throws ${error.name}`;
        }
    };
    const problems = Object.entries(CATALOGS.de)
        .filter(([, entry]) => typeof entry === 'function')
        .map(([key, entry]) => [key, render(entry), render(CATALOGS.en[key])])
        .filter(([, german, english]) => german !== 'string' || english !== 'string')
        .map(([key, german, english]) => `${key}: de ${german}, en ${english}`);
    assert.deepEqual(problems, []);
});

test('English texts render after setLanguage("en")', () => {
    const before = language();
    after(() => setLanguage(before));
    assert.equal(setLanguage('en'), 'en');
    assert.equal(t('config.env.notBoolean', { name: 'dev', key: 'claude' }), 'Environment dev: claude must be true or false');
    assert.equal(t('cli.batchHeading', { count: 1, target: 'dev' }), 'Result: 1 test on dev');
    assert.equal(t('cli.batchHeading', { count: 3, target: 'dev' }), 'Result: 3 tests on dev');
    assert.equal(t('cli.doctorSummary', { ok: 4, blocking: 1, optional: 0 }), '4 OK, 1 missing, 0 optional open');
    // No English text is left with an unfilled placeholder when its variables are given.
    const text = t('config.test.recordingOnly', { key: 'knownMessages' });
    assert.match(text, /knownMessages/);
    assert.doesNotMatch(text, /\{\w+\}/);
});
