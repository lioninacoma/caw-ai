import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSourceMapper, decodeVlq, parseMappings, sourcePath, withRoot } from '../src/host/source-maps.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encode = (values) => values.map((number) => {
    let value = number < 0 ? (-number << 1) | 1 : number << 1;
    let out = '';
    do {
        let digit = value & 31;
        value >>>= 5;
        if (value > 0) digit |= 32;
        out += B64[digit];
    } while (value > 0);
    return out;
}).join('');

test('Quellkarten: VLQ hin und zurück, auch negativ und mehrstellig', () => {
    for (const values of [[0], [1, -1], [16, 1000, -4096], [0, 0, 41, 6]]) assert.deepEqual(decodeVlq(encode(values)), values);
    assert.throws(() => decodeVlq('A!'), /kein Base64/);
});

// Erzeugt: Zeile 1 ab Spalte 0 aus a.ts 1:1, ab Spalte 40 aus b.ts 42:7 (relativ codiert); Zeile 2 leer; Segment ohne Quelle faellt weg.
const MAP = {
    version: 3,
    sources: ['webpack://shop/./src/a.ts', 'webpack://shop/./src/app/orders.service.ts'],
    mappings: `${encode([0, 0, 0, 0])},${encode([40, 1, 41, 6])},${encode([5])};`,
};

test('Quellkarten: Zuordnung je Zeile, Segmente ohne Quelle fallen weg', () => {
    assert.deepEqual(parseMappings(MAP.mappings), [[[0, 0, 0, 0], [40, 1, 41, 6]], []]);
});

test('Quellkarten: Pfade wie im Projekt, ohne Praefixe der Bundler', () => {
    assert.equal(sourcePath('webpack://shop/./src/a.ts', 'https://app.example/main.js.map'), 'src/a.ts');
    assert.equal(sourcePath('../src/App.tsx', 'https://app.example/assets/index-3f9a.js.map'), 'src/App.tsx');
    assert.equal(sourcePath('http://app.localhost:5173/src/App.tsx?t=123', 'http://app.localhost:5173/src/App.tsx'), 'src/App.tsx');
    assert.equal(sourcePath('/@fs/C:/work/lib/x.ts', 'http://app.localhost:5173/x'), 'C:/work/lib/x.ts');
    assert.equal(sourcePath('ng:///src/app/a.component.ts', 'https://a.example/main.js.map'), 'src/app/a.component.ts');
});

const STACK = [
    'TypeError: Cannot read properties of undefined',
    '    at load (https://app.example/vendor.js:1:20)',
    '    at https://app.example/main.3f9a.js:1:48',
    '    at x (https://app.example/inline.js:1:3)',
].join('\n');

test('Quellkarten: Stack übersetzen, erste eigene Stelle, fremde Quellkarten nicht laden', async () => {
    const fetched = [];
    const files = {
        'https://app.example/vendor.js': 'x()\n//# sourceMappingURL=https://evil.example/vendor.js.map',
        'https://app.example/main.3f9a.js': 'code\n//# sourceMappingURL=main.3f9a.js.map',
        'https://app.example/main.3f9a.js.map': JSON.stringify(MAP),
        'https://app.example/inline.js': `y\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ ...MAP, sources: ['../src/inline.ts', 'b'] })).toString('base64')}`,
    };
    const mapper = createSourceMapper({ fetchText: async (url) => { fetched.push(url); return files[url] ?? null; } });
    const { at, stack } = await mapper.translate(STACK);
    assert.equal(at, 'https://app.example/vendor.js:1:20', 'ohne Quellkarte bleibt die URL');
    assert.deepEqual(stack, ['https://app.example/vendor.js:1:20', 'src/app/orders.service.ts:42:7', 'src/inline.ts:1:1']);
    assert.ok(!fetched.some((url) => url.includes('evil')), 'kein Abruf auf einem fremden Origin');
    const skipped = await mapper.translate(STACK, { skip: /vendor/ });
    assert.equal(skipped.at, 'src/app/orders.service.ts:42:7', 'Framework-Dateien übersprungen');
    await mapper.translate(STACK);
    assert.equal(fetched.filter((url) => url.endsWith('main.3f9a.js')).length, 1, 'je Skript nur einmal geladen');
});

test('Quellkarten: Inline-Karte länger als das Dateiende (Vite im Dev-Modus)', async () => {
    const big = Buffer.from(JSON.stringify({ ...MAP, sourcesContent: ['x'.repeat(50_000)] })).toString('base64');
    const mapper = createSourceMapper({ fetchText: async () => `code\n//# sourceMappingURL=data:application/json;base64,${big}\n` });
    assert.equal((await mapper.translate('    at https://app.example/src/App.tsx?t=1:1:45')).at, 'src/app/orders.service.ts:42:7');
});

test('Quellkarten: Nicht erlaubte Skripte, kaputte Karten und fehlender Stack scheitern nie', async () => {
    const mapper = createSourceMapper({ fetchText: async (url) => (url.endsWith('.map') ? '{kaputt' : 'code'), allowed: (url) => !url.includes('gesperrt') });
    assert.deepEqual(await mapper.translate('    at https://gesperrt.example/a.js:1:1\n    at https://app.example/b.js:3:4'), { at: 'https://gesperrt.example/a.js:1:1', stack: ['https://gesperrt.example/a.js:1:1', 'https://app.example/b.js:3:4'] });
    assert.deepEqual(await mapper.translate(undefined), { at: undefined, stack: [] });
});

test('sourceRoot: mit genau einem / davor, absolute Quellen bleiben', () => {
    assert.equal(withRoot('src', 'a.ts'), 'src/a.ts');
    assert.equal(withRoot('src/', 'a.ts'), 'src/a.ts');
    assert.equal(withRoot('', 'a.ts'), 'a.ts');
    assert.equal(withRoot(undefined, 'a.ts'), 'a.ts');
    assert.equal(withRoot('src', 'webpack://app/./a.ts'), 'webpack://app/./a.ts');
    assert.equal(withRoot('src', '/abs/a.ts'), '/abs/a.ts');
});
