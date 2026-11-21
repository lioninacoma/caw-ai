// Target designs (design.mjs): the structure comparison as pure functions, what caw_design may write, and rendering a design
// against a page in real Chrome (skipped without Chrome).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { compareStructure, createDesignJudge, designKind, designPath, designProblem, isDesignName, listDesigns, maskedView, missingNeeds, normalStyle, pngSize, renderDesign, structureFrom, structureOf, tokensProblem, writeDesign } from '../src/host/design.mjs';
import { frameworkOf } from '../src/host/framework/index.mjs';
import { captureStep, colorDistance, comparePixels, contrastRatio, createLook, learnLook, learnedLooks, lintFacts, lintFindings, readTokens, styleLines, withAdoptedLooks } from '../src/host/visual.mjs';
import { launchChrome } from './chrome.mjs';

const EXAMPLE = new URL('../examples/errand/caw/', import.meta.url);

const tempCaw = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-design-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** A PNG header: signature, IHDR with width and height, and a few bytes after it. */
const png = (width, height) => {
    const bytes = Buffer.alloc(45);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
};

test('design names: under design/, plain segments, .html or .png; caw_design also writes tokens.json', () => {
    assert.ok(isDesignName('design/order.html'));
    assert.ok(isDesignName('design/screens/order.png'));
    for (const name of ['order.html', '../design/order.html', 'design/../x.html', 'design/a\\b.html', 'design/x.svg', '/design/x.html', 'design/', 'design/.hidden/x.html']) {
        assert.equal(isDesignName(name), false, name);
    }
    assert.equal(designKind('design/brand.tokens.json'), 'tokens');
    assert.equal(designKind('design/tokens.json'), 'tokens');
    assert.equal(designKind('design/x.json'), null);
    assert.equal(designKind('design/../tokens.json'), null);
});

test('the view without data rows and free text; numbers neutral', () => {
    const aria = [
        '- heading "Order 12" [level=1]',
        '- list:',
        '  - listitem:',
        '    - button "Complete Feed the raven"',
        '  - listitem:',
        '    - button "Complete Water plants"',
        '- paragraph: Some sample text',
        '- text: more text',
        '- button "Save"',
        '- combobox "Move to": Tomorrow',
        '  - option "Today"',
    ].join('\n');
    assert.deepEqual(maskedView(aria), ['- heading "Order #" [level=#]', '- button "Save"', '- combobox "Move to"']);
});

test('styles become whole pixels and hex colors', () => {
    assert.deepEqual(normalStyle({ fontSize: '14.4px', fontWeight: '700', color: 'rgb(255, 255, 255)', backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '12.8px', padding: '8.25px 16.5px' }), {
        'font-size': '14px', 'font-weight': '700', color: '#ffffff', 'background-color': 'transparent', 'border-radius': '13px', padding: '8px 17px',
    });
    assert.equal(normalStyle({ color: 'rgba(35, 28, 23, 0.5)' }).color, '#231c1780');
});

test('structure comparison: missing lines and differing styles are not met; extra lines and data are not counted', () => {
    const target = structureFrom({
        controls: [
            { line: 'button "Save"', style: { color: 'rgb(255, 255, 255)', fontSize: '15px' } },
            { line: 'input "Title" required,empty', style: { fontSize: '15px' } },
            { line: 'list "Todos" rows' },
        ],
        aria: '- heading "Errand" [level=1]\n- button "Save"',
    });
    const actual = structureFrom({
        controls: [
            { line: 'button "Save"', style: { color: 'rgb(0, 0, 0)', fontSize: '15px' } },
            { line: 'input "Title" required,filled', style: { fontSize: '15px' } },
            { line: 'list "Todos" empty' },
            { line: 'a "Sign out"' },
        ],
        aria: '- heading "Errand" [level=1]\n- button "Save"\n- link "Sign out"',
    });
    const result = compareStructure(target, actual);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.extra, ['a "Sign out"', '- link "Sign out"']);
    assert.deepEqual(result.styleDiffs, ['button "Save": color #ffffff → #000000']);
    assert.equal(result.met, false);
    const same = compareStructure(target, { ...actual, styles: { ...actual.styles, 'button "Save"': target.styles['button "Save"'] } });
    assert.equal(same.met, true, 'only extra lines left');
    const without = compareStructure(target, structureFrom({ controls: [{ line: 'list "Todos" rows' }], aria: '' }));
    assert.deepEqual(without.missing, ['button "Save"', 'input "Title" required', '- heading "Errand" [level=#]', '- button "Save"']);
});

test('the same control twice is told apart for its styles', () => {
    const { styles } = structureFrom({ controls: [{ line: 'button "Delete"', style: { color: 'rgb(1, 1, 1)' } }, { line: 'button "Delete"', style: { color: 'rgb(2, 2, 2)' } }] });
    assert.deepEqual(Object.keys(styles), ['button "Delete"', 'button "Delete" #2']);
});

test('caw_design checks: PNG signature and size, DTCG tokens, html, size caps', () => {
    assert.deepEqual(pngSize(png(390, 844)), { width: 390, height: 844 });
    assert.equal(pngSize(Buffer.from('not a png at all, just some text here')), null);
    assert.equal(designProblem('png', png(390, 844)), null);
    assert.match(designProblem('png', Buffer.from('GIF89a and more bytes to be long enough....')), /kein PNG/);
    assert.match(designProblem('png', png(0, 844)), /0×844/);
    assert.match(designProblem('png', png(100_000, 10)), /100000×10/);
    assert.match(designProblem('html', Buffer.alloc(3 * 1024 * 1024, 'a')), /größer als 2 MB/);
    assert.match(designProblem('html', Buffer.from('just text')), /keine HTML-Seite/);
    assert.equal(designProblem('html', Buffer.from('<!doctype html><body><button>Save</button></body>')), null);
    assert.match(designProblem('html', Buffer.from([0x3c, 0x64, 0x69, 0x76, 0x3e, 0xff, 0xfe])), /kein UTF-8/);
    assert.equal(tokensProblem({ color: { $type: 'color', ink: { $value: '#231c17' } } }), null);
    assert.match(tokensProblem({ color: { ink: '#231c17' } }), /\/color\/ink/);
    assert.match(tokensProblem({ color: { $type: 'color' } }), /kein Token/);
    assert.match(designProblem('tokens', Buffer.from('{ nope')), /kein JSON/);
    assert.equal(designProblem('tokens', readFileSync(new URL('design/tokens.json', EXAMPLE))), null, 'the example tokens are DTCG');
    assert.match(designProblem('html', Buffer.alloc(0)), /leer/);
});

test('writeDesign: only under caw/design, never through a link, and listDesigns finds what it wrote', (t) => {
    const caw = tempCaw(t);
    const written = writeDesign(caw, 'design/screens/order.png', png(390, 844));
    assert.deepEqual(written, { file: 'design/screens/order.png', kind: 'png', bytes: 45, replaced: false, width: 390, height: 844 });
    assert.ok(existsSync(join(caw, 'design', 'screens', 'order.png')));
    assert.equal(writeDesign(caw, 'design/screens/order.png', png(10, 10)).replaced, true);
    assert.throws(() => writeDesign(caw, 'design/../tests/x.html', Buffer.from('<body></body>')), /unter design\//);
    assert.throws(() => writeDesign(caw, 'tests/x.html', Buffer.from('<body></body>')), /unter design\//);
    assert.throws(() => writeDesign(caw, 'design/x.html', Buffer.from('plain')), /keine HTML-Seite/);
    writeDesign(caw, 'design/brand.tokens.json', Buffer.from('{"c":{"$value":"#fff"}}'));
    assert.deepEqual(listDesigns(caw).map(({ file, kind }) => [file, kind]), [['design/brand.tokens.json', 'tokens'], ['design/screens/order.png', 'png']]);
    assert.equal(designPath(caw, 'design/screens/order.png'), join(caw, 'design', 'screens', 'order.png'));
    assert.equal(designPath(caw, 'design/missing.html'), null);

    // A folder under caw/design that is a link to elsewhere: nothing is written through it, and a step cannot name a file there.
    const outside = tempCaw(t);
    try {
        symlinkSync(outside, join(caw, 'design', 'linked'), 'junction');
    } catch {
        t.diagnostic('no links on this system');
        return;
    }
    assert.throws(() => writeDesign(caw, 'design/linked/x.html', Buffer.from('<body></body>')), /außerhalb von caw\/design/);
    assert.equal(existsSync(join(outside, 'x.html')), false);
    writeFileSync(join(outside, 'y.html'), '<body></body>');
    assert.equal(designPath(caw, 'design/linked/y.html'), null);
});

let browser = null;
before(async () => {
    browser = await launchChrome();
});
after(async () => {
    await browser?.close();
});
const needsChrome = () => browser === null;

/** The errand app's detail page as it looks after S4: the example design with real data and the app's frame around it. */
const appPage = (design, { save = 'Save', saveColor } = {}) => design
    .replace('#7 Feed the raven CAW-1', '#12 Feed the raven CAW-2026112012345601')
    .replace('<div class="app"><main>', '<div class="app"><div class="me"><b>D</b>demo · <a href="/logout">Sign out</a></div><main>')
    .replace('id="save">Save<', `id="save">${save}<`)
    .replace('</style>', `${saveColor === undefined ? '' : `.btn{color:${saveColor}}`}</style>`);

test('rendered: the errand example design is met by its screen, a renamed button and a changed color are not', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const design = readFileSync(new URL('design/todo-detail.html', EXAMPLE), 'utf8');
    const viewport = { width: 390, height: 844 };
    const target = await structureOf(await renderDesign(browser, design, viewport));
    assert.ok(target.lines.includes('button "Save"'), target.lines.join('\n'));
    assert.ok(target.lines.includes('select "Move to"'), 'a select is a control, its value is data');
    assert.equal(target.styles['button "Save"']['background-color'], '#e5533a');

    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        const judgeOn = async (html) => {
            await page.setContent(html);
            return compareStructure(target, await structureOf(page));
        };
        const met = await judgeOn(appPage(design));
        assert.deepEqual(met.missing, []);
        assert.deepEqual(met.styleDiffs, []);
        assert.ok(met.extra.some((line) => line.includes('Sign out')), 'the app frame is only extra');
        assert.equal(met.met, true);

        const renamed = await judgeOn(appPage(design, { save: 'Store' }));
        assert.ok(renamed.missing.includes('button "Save"'));
        assert.equal(renamed.met, false);
        const recolored = await judgeOn(appPage(design, { saveColor: '#000' }));
        assert.deepEqual(recolored.styleDiffs, ['button "Save": color #ffffff → #000000']);
    } finally {
        await context.close();
    }
});

test('rendered: the design page runs no scripts and loads nothing', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const page = await renderDesign(browser, '<!doctype html><body><img src="https://example.invalid/x.png"><script>document.body.dataset.ran = "yes"</script><button>Go</button></body>');
    try {
        assert.equal(await page.evaluate('document.body.dataset.ran ?? "no"'), 'no');
    } finally {
        await page.context().close();
    }
});

test('the judge: met, missing file, image; its own browser closes', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    writeDesign(caw, 'design/a.html', Buffer.from('<!doctype html><body><button>Go</button></body>'));
    writeDesign(caw, 'design/b.png', png(390, 844));
    let launched = 0;
    const judge = createDesignJudge({ cawDir: caw, launch: async () => { launched += 1; return launchChrome(); }, read: (path) => readFileSync(path, 'utf8') });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><body><button>Go</button></body>');
        assert.equal((await judge.judge({ file: 'design/a.html' }, page)).verdict, 'met');
        assert.equal((await judge.judge({ file: 'design/b.png' }, page)).verdict, 'image');
        assert.equal((await judge.judge({ file: 'design/none.html' }, page)).verdict, 'missing');
        await page.setContent('<!doctype html><body><button>Stop</button></body>');
        const notMet = await judge.judge({ file: 'design/a.html' }, page);
        assert.equal(notMet.verdict, 'not-met');
        assert.deepEqual(notMet.missing, ['button "Go"', '- button "Go"']);
        assert.equal(launched, 1, 'one design browser per run');
    } finally {
        await judge.close();
        await context.close();
    }
});

test('needs: the locators missing on the page', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><body><button>Save</button></body>');
        const missing = await missingNeeds(frameworkOf(), () => page.mainFrame(), ['getByRole("button", { name: "Save" })', 'getByRole("button", { name: "Delete" })'], { timeoutMs: 300 });
        assert.deepEqual(missing, ['getByRole("button", { name: "Delete" })']);
    } finally {
        await context.close();
    }
});

test('the errand example has its design and tokens, and no step links a design that would fail', () => {
    assert.ok(existsSync(new URL('design/todo-detail.html', EXAMPLE)));
    assert.doesNotMatch(readFileSync(new URL('tests/first-errand.yaml', EXAMPLE), 'utf8'), /^\s+design:/m);
});

// ------------------------------------------------------------------------------------------------------------ visual layer

/** A page as PNG at a small viewport: the fixture for pixel comparisons. */
const shotOf = async (html, viewport = { width: 200, height: 100 }) => {
    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        await page.setContent(html);
        return await page.screenshot({ scale: 'css' });
    } finally {
        await context.close();
    }
};
const BOX = (left, color = '#e5533a') => `<body style="margin:0;background:#fff"><div style="position:absolute;left:${left}px;top:20px;width:40px;height:40px;background:${color}"></div></body>`;

test('pixels: the share of differing pixels, masks leave areas out, the tolerance absorbs small shifts in colour', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const base = await shotOf(BOX(20));
    const same = await comparePixels(browser, base, await shotOf(BOX(20)));
    assert.equal(same.ratio, 0);
    assert.deepEqual([same.width, same.height], [200, 100]);
    const moved = await comparePixels(browser, base, await shotOf(BOX(120)));
    // Two boxes of 40×40 that do not overlap: 3200 of 20000 pixels.
    assert.ok(Math.abs(moved.ratio - 0.16) < 0.01, String(moved.ratio));
    assert.deepEqual(pngSize(moved.diffPng), { width: 200, height: 100 }, 'the difference image has the actual size');
    const masked = await comparePixels(browser, base, await shotOf(BOX(120)), { masks: [{ x: 0, y: 0, width: 200, height: 100 }] });
    assert.equal(masked.compared, 0);
    assert.equal(masked.ratio, 0, 'everything masked: nothing to differ');
    const half = await comparePixels(browser, base, await shotOf(BOX(120)), { masks: [{ x: 100, y: 0, width: 100, height: 100 }] });
    assert.ok(Math.abs(half.ratio - 1600 / 10000) < 0.01, String(half.ratio));
    const tinted = await shotOf(BOX(20, '#ea5a40'));
    assert.equal((await comparePixels(browser, base, tinted, { tolerance: 24 })).ratio, 0);
    assert.ok((await comparePixels(browser, base, tinted, { tolerance: 2 })).ratio > 0);
});

test('pixels: a @2x export is scaled to the screen, a taller design is compared where both have pixels', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const actual = await shotOf(BOX(20));
    const double = await shotOf('<body style="margin:0;background:#fff"><div style="position:absolute;left:40px;top:40px;width:80px;height:80px;background:#e5533a"></div></body>', { width: 400, height: 200 });
    const scaled = await comparePixels(browser, actual, double);
    assert.equal(scaled.scaled, true);
    assert.ok(scaled.ratio < 0.01, String(scaled.ratio));
    const tall = await comparePixels(browser, actual, await shotOf(BOX(20), { width: 200, height: 300 }));
    assert.equal(tall.cropped, true);
    assert.equal(tall.height, 100);
    assert.equal(tall.ratio, 0);
});

test('capture: masks for run tag, remembered values, dates, list rows, list entries, cards and visualIgnore', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const context = await browser.newContext({ viewport: { width: 400, height: 600 } });
    try {
        const page = await context.newPage();
        await page.setContent(`<body><h1>Order CAW-77 for Ada</h1><p>Due 23.11.2026</p><p id="clock">12:00</p><p>Stable</p>
            <table><tr><th>Name</th></tr><tr><td>Row one</td></tr><tr><td>Row two</td></tr></table>
            <ul><li>Errand one</li><li>Errand two</li></ul><div role="list"><div role="listitem">Entry</div></div>
            <article>Card</article><div role="article">Card two</div>
            <nav><ul><li>Home</li></ul></nav><ul role="menu"><li role="menuitem">Open</li></ul></body>`);
        const shot = await captureStep(page, { texts: ['CAW-77', 'Ada', 'x'], ignore: ['#clock', '::invalid('] });
        assert.deepEqual([shot.width, shot.height], [400, 600]);
        const why = shot.masks.map(({ why: reason }) => reason);
        assert.equal(why.filter((reason) => reason === 'text').length, 2, 'the heading (run tag, value) and the date; "x" is too short to mask');
        assert.equal(why.filter((reason) => reason === 'row').length, 7, 'data rows (not the header row), list entries and cards; not navigation or menu entries');
        assert.equal(why.filter((reason) => reason === 'ignore').length, 1);
    } finally {
        await context.close();
    }
});

test('the judge: a .png design is judged by pixels against the step\'s capture; a miss saves the difference image', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    writeDesign(caw, 'design/box.png', await shotOf(BOX(20)));
    const saved = [];
    const judge = createDesignJudge({ cawDir: caw, launch: launchChrome, read: (path) => readFileSync(path, 'utf8'), pixels: { tolerance: 24, designMaxRatio: 0.02 }, save: (name, image) => { saved.push([name, image.length > 0]); return name; } });
    try {
        const capture = (html) => async () => ({ png: await shotOf(html), masks: [] });
        const met = await judge.judge({ file: 'design/box.png', step: 'S3' }, null, { capture: capture(BOX(20)) });
        assert.equal(met.verdict, 'met');
        assert.equal(met.ratio, 0);
        const notMet = await judge.judge({ file: 'design/box.png', step: 'S3' }, null, { capture: capture(BOX(120)) });
        assert.equal(notMet.verdict, 'not-met');
        assert.equal(notMet.diff, 'step-S3-diff.png');
        assert.deepEqual(saved, [['step-S3-diff.png', true]]);
        assert.match(notMet.note, /16 % der Pixel weichen ab, höchstens 2 % erlaubt; Differenzbild step-S3-diff\.png/);
    } finally {
        await judge.close();
    }
});

test('token lint: colors off the tokens, spacing off the grid, contrast, clipped text, unnamed controls', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const tokens = { colors: [{ name: 'color.ink', rgb: [35, 28, 23] }, { name: 'color.paper', rgb: [245, 237, 224] }], spacing: [8, 16] };
    const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
    try {
        const page = await context.newPage();
        await page.setContent(`<body style="margin:0;background:#f5ede0;color:#231c17">
            <h1 style="margin:0;padding:8px">Fine</h1>
            <p style="color:#cccccc;margin:0;padding:16px">Pale text</p>
            <p style="margin:0;padding:13px">Odd padding</p>
            <div style="width:40px;overflow:hidden;white-space:nowrap;margin:0">A long label that does not fit</div>
            <button style="margin:0;padding:8px;background:#f5ede0;color:#231c17;border:0"><svg width="10" height="10"></svg></button></body>`);
        const findings = lintFindings(await lintFacts(page.mainFrame()), tokens);
        const rules = findings.map(({ rule }) => rule);
        assert.ok(rules.includes('color'), rules.join());
        assert.ok(findings.some(({ rule, text }) => rule === 'color' && text.includes('#cccccc') && text.includes('color.paper')), JSON.stringify(findings));
        assert.ok(findings.some(({ rule, text }) => rule === 'spacing' && text.includes('13px') && text.includes('8px-Rasters')), JSON.stringify(findings));
        assert.ok(findings.some(({ rule, label }) => rule === 'contrast' && label.includes('Pale text')), JSON.stringify(findings));
        assert.ok(findings.some(({ rule, label }) => rule === 'clipped' && label.includes('A long label')), JSON.stringify(findings));
        assert.ok(findings.some(({ rule, label, path }) => rule === 'unnamed' && label === 'button' && path.endsWith('button:nth-of-type(1)')), JSON.stringify(findings));
        assert.ok(!findings.some(({ label }) => label.includes('Fine')), 'a heading in token colors on the grid is fine');
        // Without tokens only what needs none: contrast, clipped, unnamed.
        assert.deepEqual([...new Set(lintFindings(await lintFacts(page.mainFrame())).map(({ rule }) => rule))].sort(), ['clipped', 'contrast', 'unnamed']);
    } finally {
        await context.close();
    }
});

test('token lint: tokens from DTCG files under caw/design; contrast and color distance', () => {
    const tokens = readTokens(fileURLToPath(EXAMPLE));
    assert.equal(tokens.colors.length, 7);
    assert.deepEqual(tokens.colors.find(({ name }) => name === 'color.tomato').rgb, [229, 83, 58]);
    assert.deepEqual(tokens.spacing, [], 'the example has no spacing scale, so spacing is not linted');
    assert.equal(readTokens(join(tmpdir(), 'caw-no-design-here')), null);
    assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21);
    assert.ok(colorDistance([229, 83, 58], [229, 83, 58]) === 0 && colorDistance([0, 0, 0], [255, 255, 255]) > 99);
});

test('look: learned over two runs like effects; a count that flickers becomes ×?, an image that differs starts over', () => {
    const observed = (extra = {}) => ({ png: Buffer.from('a'), styles: ['button ×2: color #ffffff', 'tab ×1: color #000000'], imageRuns: 0, platform: 'linux', basis: 'b', changed: false, ...extra });
    const first = learnLook(undefined, observed(), { maxRatio: 0.01 });
    assert.deepEqual(first.visual, { runs: 1, basis: 'b', styles: ['button ×2: color #ffffff', 'tab ×1: color #000000'], images: { linux: 1 } });
    assert.equal(first.png.platform, 'linux');
    const second = learnLook(first.visual, observed({ imageRuns: 1, ratio: 0.001, styles: ['button ×2: color #ffffff', 'tab ×1: color #111111'] }), { maxRatio: 0.01 });
    assert.deepEqual(second.visual, { runs: 2, basis: 'b', styles: ['button ×2: color #ffffff', 'tab ×?: color #000000', 'tab ×?: color #111111'], images: { linux: 2 } });
    assert.equal(second.png, undefined, 'a confirmed image is not written again');
    const restarted = learnLook(first.visual, observed({ imageRuns: 1, ratio: 0.2 }), { maxRatio: 0.01 });
    assert.deepEqual(restarted.visual.images, { linux: 1 });
    assert.ok(restarted.png !== undefined);
    assert.equal(learnLook(second.visual, observed({ imageRuns: 2, ratio: 0, styles: second.visual.styles }), { maxRatio: 0.01 }), null, 'learned stays');
    const other = learnLook(second.visual, observed({ platform: 'win32', styles: second.visual.styles }), { maxRatio: 0.01 });
    assert.deepEqual(other.visual.images, { linux: 2, win32: 1 }, 'each platform learns its own image');

    const spec = { id: 't', steps: [{ id: 'S1', recording: { recordedOn: 'a/dev', recordedAt: 'r1' } }, { id: 'S2', recording: { recordedOn: 'a/dev', recordedAt: 'r2' } }, { id: 'S3', recording: { recordedOn: 'b/dev', recordedAt: 'r3' } }] };
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'fail' }], ['S3', { status: 'pass' }]]);
    const seen = new Map([['S1', observed()], ['S2', observed()], ['S3', observed()]]);
    assert.deepEqual([...learnedLooks({ spec, results, seen, target: 'a/dev' }).keys()], ['S1'], 'passed, on its recording target');
    assert.deepEqual([...learnedLooks({ spec, results, seen: new Map([['S1', observed({ changed: true })]]), target: 'a/dev' }).keys()], [], 'a changed look is the human\'s to adopt');
    // A window's run (no image) learns the styles and leaves the image as it is.
    const windowed = learnLook(first.visual, { styles: ['button ×2: color #ffffff', 'tab ×1: color #000000'], platform: 'linux', basis: 'b', changed: false }, { maxRatio: 0.01 });
    assert.deepEqual(windowed.visual, { runs: 2, basis: 'b', styles: first.visual.styles, images: { linux: 1 } });
    assert.equal(windowed.png, undefined);

    // Adopting takes every changed step at once. Seen in a window: no image, the stored one goes and is learned anew headless.
    const two = { id: 't', steps: [{ id: 'S1', recording: { visual: second.visual } }, { id: 'S2', recording: { visual: second.visual } }, { id: 'S3', recording: { visual: second.visual } }] };
    const seenInWindow = { styles: ['button ×3: color #000000'], platform: 'win32', basis: 'b', changed: true };
    const adopted = withAdoptedLooks(two, new Map([['S1', seenInWindow], ['S2', seenInWindow]]), '2026-11-21');
    for (const step of adopted.steps.slice(0, 2)) {
        assert.deepEqual(step.recording.visual, { runs: 2, basis: 'b', styles: ['button ×3: color #000000'], images: {}, adopted: '2026-11-21' });
        assert.deepEqual(step.recording.lookPng, { platform: 'win32', data: null });
    }
    assert.deepEqual(adopted.steps[2].recording.visual, second.visual, 'an unchanged step stays');
    const headless = withAdoptedLooks(two, new Map([['S1', observed({ platform: 'win32', changed: true })]]), '2026-11-21');
    assert.deepEqual(headless.steps[0].recording.visual.images, { win32: 2 }, 'seen headless, its image comes along');
    assert.equal(headless.steps[0].recording.lookPng.data.toString(), 'a');

    // By role and style, not by name: names carry data.
    assert.deepEqual(styleLines({ 'button "Complete Feed the raven"': { color: '#fff' }, 'button "Complete Buy bread"': { color: '#fff' }, 'button "Save"': { color: '#000' }, link: { color: '#fff' } }),
        ['button ×1: color #000', 'button ×2: color #fff', 'link ×1: color #fff']);
});

test('look: a learned look whose style changed fails the step (design.fail visual) or only warns', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    const context = await browser.newContext({ viewport: { width: 200, height: 100 } });
    try {
        const page = await context.newPage();
        await page.setContent('<body style="margin:0"><button style="color:#000000;background:#ffffff">Save</button></body>');
        const stepWith = (styles, extra = {}) => ({ id: 'S1', look: true, ...extra, recording: { recordedAt: 'r1', recordedOn: 'a/dev', visual: { runs: 2, styles, images: { [process.platform]: 2 } } } });
        const looks = (designFail, step, pixels = true) => createLook({
            spec: { id: 't', steps: [step] }, cawDir: caw, root: caw, settings: { screenshots: false, maxRatio: 0.01 }, compare: async () => ({ ratio: 0.5, diffPng: Buffer.from('d') }), save: (name) => name, readImage: () => Buffer.from('stored'), designFail, pixels,
        });
        let captures = 0;
        const capture = async () => { captures += 1; return { png: await page.screenshot(), masks: [] }; };
        const styleOnly = await looks([], stepWith([]), true)('S1', { capture, page });
        assert.deepEqual(styleOnly.observed.styles.map((line) => line.replace(/: .*/, '')), ['button ×1'], 'by role and style, the name is gone');
        assert.ok(styleOnly.observed.styles[0].includes('color #000000'), styleOnly.observed.styles[0]);
        const learned = styleOnly.observed.styles;

        // A color changed: one button fewer with the learned style, one more with the new one.
        const changedStyle = [learned[0].replace('color #000000', 'color #ff0000')];
        const failing = await looks(['visual'], stepWith(changedStyle), false)('S1', { capture, page });
        assert.equal(failing.fail.kind, 'visual');
        assert.equal(failing.record.visual.verdict, 'changed');
        assert.equal(failing.record.visual.pixels, 'headless-only');
        assert.equal(failing.record.visual.styles.length, 2);
        assert.match(failing.record.visual.styles[0], /^1 button weniger mit .*color #ff0000/);
        assert.match(failing.record.visual.styles[1], /^1 button mehr mit .*color #000000/);
        const warning = await looks([], stepWith(changedStyle), false)('S1', { capture, page });
        assert.equal(warning.fail, undefined);
        assert.equal(warning.warnings[0].type, 'visual');
        assert.match(warning.warnings[0].text, /S1 sieht anders aus als gelernt: Styles geändert: 1 button weniger mit/);

        // In a window the styles alone decide: same styles are the same look, the image is neither captured nor compared.
        captures = 0;
        const inWindow = await looks(['visual'], stepWith(learned), false)('S1', { capture, page });
        assert.deepEqual(inWindow.record.visual, { verdict: 'same', pixels: 'headless-only' });
        assert.equal(inWindow.fail, undefined);
        assert.equal(captures, 0, 'no capture for the look in a window');
        assert.equal(inWindow.observed.png, undefined);
        // Headless the same styles with 50 % differing pixels: changed by pixels.
        const headless = await looks(['visual'], stepWith(learned), true)('S1', { capture, page });
        assert.equal(headless.record.visual.verdict, 'changed');
        assert.equal(headless.record.visual.ratio, 0.5);
        assert.equal(headless.record.visual.diff, 'step-S1-look-diff.png');
        assert.equal(headless.record.visual.pixels, undefined);
        // A count that flickered while learning (×?) allows any number.
        const flickered = await looks(['visual'], stepWith([learned[0].replace('×1', '×?')]), false)('S1', { capture, page });
        assert.equal(flickered.record.visual.verdict, 'same');
        // Without look: true nothing is learned or compared.
        const off = await looks(['visual'], { ...stepWith(changedStyle), look: undefined }, true)('S1', { capture, page });
        assert.equal(off.record.visual, undefined);
        assert.equal(off.observed, undefined);
    } finally {
        await context.close();
    }
});
