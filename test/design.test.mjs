// Target designs (design.mjs): the structure comparison as pure functions, what caw_design may write, and rendering a design
// against a page in real Chrome (skipped without Chrome).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { compareStructure, createDesignJudge, designKind, designPath, designProblem, isDesignName, listDesigns, maskedView, missingNeeds, normalStyle, renderDesign, structureFrom, structureOf, viewLines, writeDesign } from '../src/host/design.mjs';
import { frameworkOf } from '../src/host/framework/index.mjs';
import { captureStep, createLook, learnLook, learnedLooks, maskProbe, styleLines, withAdoptedLooks } from '../src/host/visual.mjs';
import { launchChrome } from './chrome.mjs';

test('View lines (target designs): ARIA lines without links, field contents, long texts and numbers', () => {
    const aria = [
        '- textbox "Bereich*": Kammerbeitrag',
        '- textbox "Kategorie*" [disabled]',
        '  - /url: https://portal/x?p_auth=abc',
        '- button',
        `- text: ${'x'.repeat(200)}`,
        '- heading "Vorgang 4711" [level=2] [ref=e12]',
    ].join('\n');
    assert.deepEqual(viewLines(aria), ['- textbox "Bereich*"', '- textbox "Kategorie*" [disabled]', '- heading "Vorgang #" [level=#]']);
});

const EXAMPLE = new URL('../examples/errand/caw/', import.meta.url);

const tempCaw = (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'caw-design-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

test('design names: under design/, plain segments, .html', () => {
    assert.ok(isDesignName('design/order.html'));
    assert.ok(isDesignName('design/screens/order.html'));
    for (const name of ['design/order.png', 'order.html', '../design/order.html', 'design/../x.html', 'design/a\\b.html', 'design/x.svg', '/design/x.html', 'design/', 'design/.hidden/x.html']) {
        assert.equal(isDesignName(name), false, name);
    }
    assert.equal(designKind('design/order.html'), 'html');
    assert.equal(designKind('design/tokens.json'), null);
    assert.equal(designKind('design/order.png'), null);
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

test('caw_design checks: html, size cap', () => {
    assert.match(designProblem('html', Buffer.alloc(3 * 1024 * 1024, 'a')), /größer als 2 MB/);
    assert.match(designProblem('html', Buffer.from('just text')), /keine HTML-Seite/);
    assert.equal(designProblem('html', Buffer.from('<!doctype html><body><button>Save</button></body>')), null);
    assert.match(designProblem('html', Buffer.from([0x3c, 0x64, 0x69, 0x76, 0x3e, 0xff, 0xfe])), /kein UTF-8/);
    assert.match(designProblem('html', Buffer.alloc(0)), /leer/);
});

test('writeDesign: only under caw/design, never through a link, and listDesigns finds what it wrote', (t) => {
    const caw = tempCaw(t);
    const page = Buffer.from('<!doctype html><body><button>Order</button></body>');
    const written = writeDesign(caw, 'design/screens/order.html', page);
    assert.deepEqual(written, { file: 'design/screens/order.html', kind: 'html', bytes: page.length, replaced: false });
    assert.ok(existsSync(join(caw, 'design', 'screens', 'order.html')));
    assert.equal(writeDesign(caw, 'design/screens/order.html', page).replaced, true);
    assert.throws(() => writeDesign(caw, 'design/order.png', Buffer.from('png')), /unter design\//);
    assert.throws(() => writeDesign(caw, 'design/../tests/x.html', Buffer.from('<body></body>')), /unter design\//);
    assert.throws(() => writeDesign(caw, 'tests/x.html', Buffer.from('<body></body>')), /unter design\//);
    assert.throws(() => writeDesign(caw, 'design/x.html', Buffer.from('plain')), /keine HTML-Seite/);
    writeFileSync(join(caw, 'design', 'old.png'), 'png');
    assert.deepEqual(listDesigns(caw).map(({ file, kind }) => [file, kind]), [['design/screens/order.html', 'html']], 'other files are left out');
    assert.equal(designPath(caw, 'design/screens/order.html'), join(caw, 'design', 'screens', 'order.html'));
    assert.equal(designPath(caw, 'design/old.png'), null);
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

test('the judge: met, missing file; its own browser closes', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    writeDesign(caw, 'design/a.html', Buffer.from('<!doctype html><body><button>Go</button></body>'));
    let launched = 0;
    const judge = createDesignJudge({ cawDir: caw, launch: async () => { launched += 1; return launchChrome(); }, read: (path) => readFileSync(path, 'utf8') });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><body><button>Go</button></body>');
        assert.equal((await judge.judge({ file: 'design/a.html' }, page)).verdict, 'met');
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

test('the errand example has its design, and no step links a design that would fail', () => {
    assert.ok(existsSync(new URL('design/todo-detail.html', EXAMPLE)));
    assert.doesNotMatch(readFileSync(new URL('tests/first-errand.yaml', EXAMPLE), 'utf8'), /^\s+design:/m);
});

// ------------------------------------------------------------------------------------------------------------ visual layer

test('capture: the step\'s screen as PNG at the page\'s viewport, for the report', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
    try {
        const page = await context.newPage();
        await page.setContent('<body><h1>Screen</h1></body>');
        const { png } = await captureStep(page);
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [400, 300]);
    } finally {
        await context.close();
    }
});

test('masks for the look suggestion: run tag, remembered values, dates, list rows, list entries, cards and visualIgnore', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const context = await browser.newContext({ viewport: { width: 400, height: 600 } });
    try {
        const page = await context.newPage();
        await page.setContent(`<body><h1>Order CAW-77 for Ada</h1><p>Due 23.11.2026</p><p id="clock">12:00</p><p>Stable</p>
            <table><tr><th>Name</th></tr><tr><td>Row one</td></tr><tr><td>Row two</td></tr></table>
            <ul><li>Errand one</li><li>Errand two</li></ul><div role="list"><div role="listitem">Entry</div></div>
            <article>Card</article><div role="article">Card two</div>
            <nav><ul><li>Home</li></ul></nav><ul role="menu"><li role="menuitem">Open</li></ul></body>`);
        const masks = await page.mainFrame().evaluate(maskProbe, { texts: ['CAW-77', 'Ada', 'x'], ignore: ['#clock', '::invalid('], max: 400 });
        const why = masks.map(({ why: reason }) => reason);
        assert.equal(why.filter((reason) => reason === 'text').length, 2, 'the heading (run tag, value) and the date; "x" is too short to count');
        assert.equal(why.filter((reason) => reason === 'row').length, 7, 'data rows (not the header row), list entries and cards; not navigation or menu entries');
        assert.equal(why.filter((reason) => reason === 'ignore').length, 1);
    } finally {
        await context.close();
    }
});

test('look: learned over two runs like effects; a count that flickers becomes ×?', () => {
    const observed = (extra = {}) => ({ styles: ['button ×2: color #ffffff', 'tab ×1: color #000000'], basis: 'b', changed: false, ...extra });
    const first = learnLook(undefined, observed());
    assert.deepEqual(first.visual, { runs: 1, basis: 'b', styles: ['button ×2: color #ffffff', 'tab ×1: color #000000'] });
    const second = learnLook(first.visual, observed({ styles: ['button ×2: color #ffffff', 'tab ×1: color #111111'] }));
    assert.deepEqual(second.visual, { runs: 2, basis: 'b', styles: ['button ×2: color #ffffff', 'tab ×?: color #000000', 'tab ×?: color #111111'] });
    assert.equal(learnLook(second.visual, observed({ styles: second.visual.styles })), null, 'learned stays');

    const spec = { id: 't', steps: [{ id: 'S1', recording: { recordedOn: 'a/dev', recordedAt: 'r1' } }, { id: 'S2', recording: { recordedOn: 'a/dev', recordedAt: 'r2' } }, { id: 'S3', recording: { recordedOn: 'b/dev', recordedAt: 'r3' } }] };
    const results = new Map([['S1', { status: 'pass' }], ['S2', { status: 'fail' }], ['S3', { status: 'pass' }]]);
    const seen = new Map([['S1', observed()], ['S2', observed()], ['S3', observed()]]);
    assert.deepEqual([...learnedLooks({ spec, results, seen, target: 'a/dev' }).keys()], ['S1'], 'passed, on its recording target');
    assert.deepEqual([...learnedLooks({ spec, results, seen: new Map([['S1', observed({ changed: true })]]), target: 'a/dev' }).keys()], [], 'a changed look is the human\'s to adopt');

    // Adopting takes every changed step at once.
    const two = { id: 't', steps: [{ id: 'S1', recording: { visual: second.visual } }, { id: 'S2', recording: { visual: second.visual } }, { id: 'S3', recording: { visual: second.visual } }] };
    const changed = { styles: ['button ×3: color #000000'], basis: 'b', changed: true };
    const adopted = withAdoptedLooks(two, new Map([['S1', changed], ['S2', changed]]), '2026-11-21');
    for (const step of adopted.steps.slice(0, 2)) {
        assert.deepEqual(step.recording.visual, { runs: 2, basis: 'b', styles: ['button ×3: color #000000'], adopted: '2026-11-21' });
    }
    assert.deepEqual(adopted.steps[2].recording.visual, second.visual, 'an unchanged step stays');

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
        const stepWith = (styles, extra = {}) => ({ id: 'S1', look: true, ...extra, recording: { recordedAt: 'r1', recordedOn: 'a/dev', visual: { runs: 2, styles } } });
        const looks = (designFail, step, settings = { screenshots: false }) => createLook({ spec: { id: 't', steps: [step] }, cawDir: caw, settings, save: (name) => name, designFail });
        let captures = 0;
        const capture = async () => { captures += 1; return { png: await page.screenshot() }; };
        const styleOnly = await looks([], stepWith([]))('S1', { capture, page });
        assert.deepEqual(styleOnly.observed.styles.map((line) => line.replace(/: .*/, '')), ['button ×1'], 'by role and style, the name is gone');
        assert.ok(styleOnly.observed.styles[0].includes('color #000000'), styleOnly.observed.styles[0]);
        const learned = styleOnly.observed.styles;

        // A color changed: one button fewer with the learned style, one more with the new one.
        const changedStyle = [learned[0].replace('color #000000', 'color #ff0000')];
        const failing = await looks(['visual'], stepWith(changedStyle))('S1', { capture, page });
        assert.equal(failing.fail.kind, 'visual');
        assert.equal(failing.record.visual.verdict, 'changed');
        assert.equal(failing.record.visual.styles.length, 2);
        assert.match(failing.record.visual.styles[0], /^1 button weniger mit .*color #ff0000/);
        assert.match(failing.record.visual.styles[1], /^1 button mehr mit .*color #000000/);
        const warning = await looks([], stepWith(changedStyle))('S1', { capture, page });
        assert.equal(warning.fail, undefined);
        assert.equal(warning.warnings[0].type, 'visual');
        assert.match(warning.warnings[0].text, /S1 sieht anders aus als gelernt: Styles geändert: 1 button weniger mit/);

        // The same styles are the same look; the look takes no capture.
        captures = 0;
        const same = await looks(['visual'], stepWith(learned))('S1', { capture, page });
        assert.deepEqual(same.record.visual, { verdict: 'same' });
        assert.equal(same.fail, undefined);
        assert.equal(captures, 0, 'no capture for the look');
        // A count that flickered while learning (×?) allows any number.
        const flickered = await looks(['visual'], stepWith([learned[0].replace('×1', '×?')]))('S1', { capture, page });
        assert.equal(flickered.record.visual.verdict, 'same');
        // Without look: true nothing is learned or compared; with screenshots the step's screen goes into the run folder.
        const off = await looks(['visual'], { ...stepWith(changedStyle), look: undefined }, { screenshots: true })('S1', { capture, page });
        assert.equal(off.record.visual, undefined);
        assert.equal(off.observed, undefined);
        assert.equal(off.record.screenshot, 'step-S1.png');
    } finally {
        await context.close();
    }
});

test('look: the style lines leave out the controls in masked areas, a list with one entry more looks the same', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    const context = await browser.newContext({ viewport: { width: 400, height: 600 } });
    try {
        const page = await context.newPage();
        const button = (label, color = '#000000') => `<button style="color:${color}">${label}</button>`;
        const screen = (count) => {
            const many = (make) => Array.from({ length: count }, (_, index) => make(index)).join('');
            return '<body>'
                + `<nav><ul><li>${button('Home', '#0000ff')}</li><li>${button('Tasks', '#0000ff')}</li></ul></nav>`
                + `<table><tr><th>Name ${button('Sort', '#00ff00')}</th></tr>${many((index) => `<tr><td>Row ${index} ${button('Open')}</td></tr>`)}</table>`
                + `<ul>${many((index) => `<li>Entry ${index} ${button('Done')}</li>`)}</ul>`
                + many((index) => `<article>Card ${index} ${button('Edit')}</article>`)
                + `<div role="list">${many((index) => `<div role="listitem">${button(`Item ${index}`)}</div>`)}</div>`
                + `<section class="feed">${many((index) => `<div>${button(`Feed ${index}`)}</div>`)}</section>`
                + `${button('Save', '#ff0000')}</body>`;
        };
        const step = { id: 'S1', look: true, recording: { recordedAt: 'r1', recordedOn: 'a/dev' } };
        const look = createLook({ spec: { id: 't', steps: [step] }, cawDir: caw, settings: { screenshots: false, ignore: ['.feed'] }, save: () => undefined });
        const linesOf = async (count) => {
            await page.setContent(screen(count));
            return (await look('S1', { capture: async () => assert.fail('no capture for a look'), page })).observed.styles;
        };
        const two = await linesOf(2);
        assert.deepEqual(await linesOf(3), two, 'the third row, entry, card and feed item change nothing');
        // Counted: the page's own button, the header row's and the navigation's entries.
        assert.deepEqual(two.map((line) => `${line.split(':')[0]} ${/, color (#\w+)/.exec(line)[1]}`).sort(), ['button ×1 #00ff00', 'button ×1 #ff0000', 'button ×2 #0000ff']);
    } finally {
        await context.close();
    }
});
