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

test('Source maps: VLQ round trip, also negative and multi-digit', () => {
    for (const values of [[0], [1, -1], [16, 1000, -4096], [0, 0, 41, 6]]) assert.deepEqual(decodeVlq(encode(values)), values);
    assert.throws(() => decodeVlq('A!'), /not a Base64/);
});

// Generated: line 1 from column 0 maps to a.ts 1:1, from column 40 to b.ts 42:7 (relative encoding); line 2 empty; a segment without source is dropped.
const MAP = {
    version: 3,
    sources: ['webpack://shop/./src/a.ts', 'webpack://shop/./src/app/orders.service.ts'],
    mappings: `${encode([0, 0, 0, 0])},${encode([40, 1, 41, 6])},${encode([5])};`,
};

test('Source maps: mappings per line, segments without a source are dropped', () => {
    assert.deepEqual(parseMappings(MAP.mappings), [[[0, 0, 0, 0], [40, 1, 41, 6]], []]);
});

test('Source maps: paths as in the project, without bundler prefixes', () => {
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

test('Source maps: translate a stack, first own position, never load foreign source maps', async () => {
    const fetched = [];
    const files = {
        'https://app.example/vendor.js': 'x()\n//# sourceMappingURL=https://evil.example/vendor.js.map',
        'https://app.example/main.3f9a.js': 'code\n//# sourceMappingURL=main.3f9a.js.map',
        'https://app.example/main.3f9a.js.map': JSON.stringify(MAP),
        'https://app.example/inline.js': `y\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify({ ...MAP, sources: ['../src/inline.ts', 'b'] })).toString('base64')}`,
    };
    const mapper = createSourceMapper({ fetchText: async (url) => { fetched.push(url); return files[url] ?? null; } });
    const { at, stack } = await mapper.translate(STACK);
    assert.equal(at, 'https://app.example/vendor.js:1:20', 'without a source map the URL stays');
    assert.deepEqual(stack, ['https://app.example/vendor.js:1:20', 'src/app/orders.service.ts:42:7', 'src/inline.ts:1:1']);
    assert.ok(!fetched.some((url) => url.includes('evil')), 'no fetch from a foreign origin');
    const skipped = await mapper.translate(STACK, { skip: /vendor/ });
    assert.equal(skipped.at, 'src/app/orders.service.ts:42:7', 'framework files skipped');
    await mapper.translate(STACK);
    assert.equal(fetched.filter((url) => url.endsWith('main.3f9a.js')).length, 1, 'each script loaded only once');
});

test('Source maps: inline map longer than the file tail (Vite in dev mode)', async () => {
    const big = Buffer.from(JSON.stringify({ ...MAP, sourcesContent: ['x'.repeat(50_000)] })).toString('base64');
    const mapper = createSourceMapper({ fetchText: async () => `code\n//# sourceMappingURL=data:application/json;base64,${big}\n` });
    assert.equal((await mapper.translate('    at https://app.example/src/App.tsx?t=1:1:45')).at, 'src/app/orders.service.ts:42:7');
});

test('Source maps: disallowed scripts, broken maps and a missing stack never fail', async () => {
    const mapper = createSourceMapper({ fetchText: async (url) => (url.endsWith('.map') ? '{kaputt' : 'code'), allowed: (url) => !url.includes('gesperrt') });
    assert.deepEqual(await mapper.translate('    at https://gesperrt.example/a.js:1:1\n    at https://app.example/b.js:3:4'), { at: 'https://gesperrt.example/a.js:1:1', stack: ['https://gesperrt.example/a.js:1:1', 'https://app.example/b.js:3:4'] });
    assert.deepEqual(await mapper.translate(undefined), { at: undefined, stack: [] });
});

test('sourceRoot: with exactly one / before, absolute sources stay', () => {
    assert.equal(withRoot('src', 'a.ts'), 'src/a.ts');
    assert.equal(withRoot('src/', 'a.ts'), 'src/a.ts');
    assert.equal(withRoot('', 'a.ts'), 'a.ts');
    assert.equal(withRoot(undefined, 'a.ts'), 'a.ts');
    assert.equal(withRoot('src', 'webpack://app/./a.ts'), 'webpack://app/./a.ts');
    assert.equal(withRoot('src', '/abs/a.ts'), '/abs/a.ts');
});

test('Source maps: index map with sections (Turbopack, next dev) and file:/// sources', async () => {
    const part = (file) => ({ version: 3, sources: [`file:///C:/app/lib/${file}`], mappings: `;${encode([4, 0, 1, 8])}` });
    const map = { version: 3, sources: [], sections: [{ offset: { line: 4, column: 0 }, map: part('Tickets.tsx') }, { offset: { line: 20, column: 0 }, map: part('explode.ts') }] };
    const files = { 'https://a.example/chunk.js': '//# sourceMappingURL=chunk.js.map', 'https://a.example/chunk.js.map': JSON.stringify(map) };
    const mapper = createSourceMapper({ fetchText: async (url) => files[url] ?? null });
    // Line 22 of the file is line 2 of the second section; column 5 hits the segment starting at column 4.
    const { at, stack } = await mapper.translate('Error: x\n    at explode (https://a.example/chunk.js:22:5)\n    at f (https://a.example/chunk.js:6:9)\n    at g (https://a.example/chunk.js:2:1)');
    assert.equal(at, 'C:/app/lib/explode.ts:2:9');
    assert.deepEqual(stack, ['C:/app/lib/explode.ts:2:9', 'C:/app/lib/Tickets.tsx:2:9', 'https://a.example/chunk.js:2:1']);
});
