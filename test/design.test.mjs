// Target designs (design.mjs): the structure comparison as pure functions, what caw_design may write, and rendering a design
// against a page in real Chrome (skipped without Chrome).
/* global document, scrollX, scrollY, window -- inside page.evaluate callbacks */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { LAYOUT_TOLERANCE_PX, compareDetailed, compareStructure, createDesignJudge, designKind, designPath, designProblem, isDesignName, layoutMeasures, listDesigns, maskedView, relation, missingNeeds, normalStyle, renderDesign, structureFrom, structureOf, viewLines, writeDesign } from '../src/host/design.mjs';
import { frameworkOf } from '../src/host/framework/index.mjs';
import { captureStep, createLook, designComparison, learnLook, learnedLooks, maskProbe, styleLines, withAdoptedLooks } from '../src/host/visual.mjs';
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

test('the view without data rows, free text and headings or links named by data; numbers neutral', () => {
    const aria = [
        '- heading "Order 12" [level=1]',
        '- heading "Feed the raven CAW-ab" [level=2]',
        '- link "Open #7"',
        '- heading "Details" [level=2]',
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
    assert.deepEqual(maskedView(aria, ['CAW-ab']), ['- heading "Details" [level=#]', '- button "Save"', '- combobox "Move to"']);
    assert.deepEqual(maskedView('- button "Delete 3"'), ['- button "Delete #"'], 'a control keeps its line, numbers neutral');
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

// An artboard as a Design artifact holds it (shape of the format: template in <x-dc>, values from the logic script).
const ARTBOARD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Detail</title><script src="./support.js"></script></head>
<body><x-dc><helmet><style>body{margin:0}</style></helmet>
<div style="padding: 20px"><h2>{{title}}</h2><button type="button" style="background: {{noteColor}}">Save note</button>
<sc-if value="{{mark}}" hint-placeholder-val="{{true}}"><span>1</span></sc-if></div></x-dc>
<script type="text/x-dc" data-dc-script data-props='{"mark":{"editor":"boolean","default":true}}'>
class Component extends DCLogic { renderVals() { return { title: '#7 Feed the raven', noteColor: '#5f8f6b', mark: false }; } }
</script></body></html>`;

test('caw_design refuses an artboard of a Design artifact that is not converted to a static page', () => {
    assert.match(designProblem('html', Buffer.from(ARTBOARD)), /Zeichenfläche eines Design-Artifacts/);
    // Converted by the guide's procedure: holes filled, <sc-if> resolved, <x-dc>, <helmet> and the scripts gone.
    const converted = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Detail</title><style>body{margin:0}</style></head>'
        + '<body><div style="padding: 20px"><h2>#7 Feed the raven</h2><button type="button" style="background: #5f8f6b">Save note</button></div></body></html>';
    assert.equal(designProblem('html', Buffer.from(converted)), null);
    // One hole left over is enough: it would be judged as text.
    assert.match(designProblem('html', Buffer.from(converted.replace('#7 Feed the raven', '{{ title }}'))), /Zeichenfläche/);
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

/**
 * A todo's detail page with a note, as a design exports it and as an app shows it (the frame, other data). The options build
 * the deviations the comparison must name and the data it must leave alone.
 */
const noteScreen = ({
    frame = false, number = 7, title = 'Feed the raven CAW-1', note = 'Bring sunflower seeds', saveNote = 'Save note', noteClass = 'btn sage',
    fieldFont = true, noteFirst = false, noteMargin = '1.2rem', headingFont = 'var(--serif)', heading = 'Note', marked = '',
} = {}) => {
    const row = '<div class="row"><label>Move to <select id="next"><option>Today</option><option selected>Tomorrow</option><option>Someday</option></select></label><button class="btn" id="save">Save</button></div>';
    const section = `<div class="note"><h3>${heading}</h3><p class="note-text">${note}</p><label>Note <textarea id="note" rows="3">${note}</textarea></label><div class="actions"><button class="${noteClass}" id="save-note">${saveNote}</button></div></div>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
:root{--card:#fffaf2;--ink:#231c17;--muted:#8a7d70;--line:#e6dacb;--tomato:#e5533a;--sage:#5f8f6b;--serif:Georgia,serif;--sans:"Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box}body{margin:0;color:var(--ink);font:15px/1.45 var(--sans);background:#f5ede0}
button,select${fieldFont ? ',textarea' : ''}{font:inherit;color:inherit}
.app{max-width:30rem;margin:0 auto;padding:1.1rem}.me{display:flex;justify-content:flex-end;gap:.5rem;font-size:.8rem}
.back{display:inline-block;margin:1rem 0;color:var(--muted)}
.detail{background:var(--card);border-radius:1.2rem;padding:1.3rem;box-shadow:0 6px 16px -12px #5a3a2066}
.detail h2{font:600 1.8rem/1.1 var(--serif);margin:0 0 .6rem}.meta{display:flex;gap:.6rem;color:var(--muted);margin-bottom:1.1rem}
.row{display:flex;gap:.6rem;align-items:end}label{display:grid;gap:.3rem;font-weight:600;font-size:.85rem}
.row select{padding:.55rem .75rem;border:1.5px solid var(--line);border-radius:.8rem;background:#fff}
.btn{border:0;border-radius:999px;padding:.55rem 1.1rem;font-weight:700;background:var(--tomato);color:#fff}.btn.sage{background:var(--sage)}
.note{margin-top:${noteMargin};padding-top:1rem;border-top:1.5px dashed var(--line)}.note h3{font:600 1.15rem/1.2 ${headingFont};margin:0 0 .5rem}
.note-text{margin:0 0 .8rem;font:italic 1rem/1.4 var(--serif)}
.note textarea{width:100%;min-height:4.5rem;padding:.55rem .75rem;border:1.5px solid var(--line);border-radius:.8rem;background:#fff}
.actions{display:flex;justify-content:flex-end;margin-top:.6rem}
</style></head><body><div class="app">${frame ? '<div class="me"><b>D</b>demo · <a href="/logout">Sign out</a></div>' : ''}<main>
<a class="back" href="/">← All todos</a><div class="detail"><h2>#${number} ${title}</h2>
<div class="meta"><span${marked}>Done</span><span>When: <output>Tomorrow</output></span></div>
${noteFirst ? section + row : row + section}</div></main></div></body></html>`;
};

test('rendered: layout, texts and looks of a design; the app with other data meets it, each deviation is named', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const viewport = { width: 390, height: 844 };
    const rendered = await renderDesign(browser, noteScreen(), viewport);
    const target = await structureOf(rendered);
    await rendered.context().close();
    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        const judgeOn = async (options, texts = []) => {
            await page.setContent(noteScreen({ frame: true, ...options }));
            return compareStructure(target, await structureOf(page, { texts }));
        };
        const lines = ({ missing, textDiffs, styleDiffs, layoutDiffs }) => [...missing, ...textDiffs, ...styleDiffs, ...layoutDiffs];

        // Data: a long title that wraps onto three lines, another number, another note; the run tag is data on both sides.
        for (const data of [
            { title: 'Feed the raven and bring the big bag of sunflower seeds from the market on the way home CAW-2026112212345601' },
            { number: 1234 },
            { note: 'Ask the neighbours about the cage' },
        ]) {
            const result = await judgeOn(data, ['CAW-2026112212345601']);
            assert.deepEqual(lines(result), [], JSON.stringify(data));
            assert.equal(result.met, true);
        }
        const title = (structure) => structure.elements.find(({ tag, data }) => tag === 'heading' && data);
        await page.setContent(noteScreen({ frame: true, title: 'Feed the raven and bring the big bag of sunflower seeds from the market on the way home CAW-2026112212345601' }));
        assert.ok(title(await structureOf(page)).height > 2 * title(target).height, 'the data title wraps');

        // Each deviation fails with a line that says what differs.
        const deviations = [
            [{ noteClass: 'btn' }, ['button "Save note": background-color #5f8f6b → #e5533a']],
            [{ saveNote: 'Save Note' }, ['button "Save note"', '- button "Save note"']],
            [{ heading: 'Notes' }, ['Text: heading "Note" → "Notes"']],
            [{ headingFont: 'Arial' }, ['heading "Note": font-family Georgia → Arial']],
            [{ noteMargin: 'calc(1.2rem + 24px)' }, ['Abstand button "Save" → block "Note": 19px → 43px']],
            [{ noteFirst: true }, ['block "Note": unter button "Save" → über button "Save"']],
        ];
        for (const [options, expected] of deviations) {
            const result = await judgeOn(options);
            assert.equal(result.met, false, JSON.stringify(options));
            for (const line of expected) assert.ok(lines(result).includes(line), `${JSON.stringify(options)}: ${line}\n${lines(result).join('\n')}`);
        }
        const unstyled = lines(await judgeOn({ fieldFont: false }));
        assert.ok(unstyled.includes('textarea "Note": font-family Segoe UI → monospace'), unstyled.join('\n'));
        assert.ok(unstyled.some((line) => /^textarea "Note": height \d+px → \d+px$/.test(line)), unstyled.join('\n'));

        // A static text marked as data in the design and the app is compared only by its place.
        const markedTarget = await (async () => {
            const markedDesign = await renderDesign(browser, noteScreen({ marked: ' data-caw-data' }), viewport);
            try {
                return await structureOf(markedDesign);
            } finally {
                await markedDesign.context().close();
            }
        })();
        await page.setContent(noteScreen({ frame: true, marked: ' data-caw-data' }).replace('>Done<', '>Open<'));
        assert.equal(compareStructure(markedTarget, await structureOf(page)).met, true, 'data-caw-data');
        const open = lines(compareStructure(target, await (async () => {
            await page.setContent(noteScreen({ frame: true }).replace('>Done<', '>Open<'));
            return structureOf(page);
        })()));
        assert.deepEqual(open, ['Text: "Done" → "Open"'], 'without the mark it is a static text');
    } finally {
        await context.close();
    }
});

test('rendered: every deviation with where its element is in the design and in the app (the comparison page), the app\'s boxes moved by its scroll', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const viewport = { width: 390, height: 844 };
    const cawDir = mkdtempSync(join(tmpdir(), 'caw-compare-'));
    t.after(() => rmSync(cawDir, { recursive: true, force: true }));
    writeDesign(cawDir, 'design/note.html', Buffer.from(noteScreen()));
    const rendered = await renderDesign(browser, noteScreen(), viewport);
    const target = await structureOf(rendered);
    const boxIn = (page, selector) => page.evaluate((query) => {
        const rect = document.querySelector(query).getBoundingClientRect();
        return { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
    }, selector);
    const near = (a, b) => ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);
    const saveNote = '#save-note';
    const designBox = await boxIn(rendered, saveNote);
    await rendered.context().close();
    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        await page.setContent(noteScreen({ frame: true, noteClass: 'btn' }));
        const found = compareDetailed(target, await structureOf(page));
        assert.equal(compareStructure(target, await structureOf(page)).deviations, undefined, 'the judge keeps its result as it was');
        const style = found.deviations.find(({ text }) => text === 'button "Save note": background-color #5f8f6b → #e5533a');
        assert.equal(style?.kind, 'style', JSON.stringify(found.deviations));
        assert.ok(near(style.design, designBox), `${JSON.stringify(style.design)} ${JSON.stringify(designBox)}`);
        assert.ok(near(style.app, await boxIn(page, saveNote)), 'the same button in the app');
        await page.setContent(noteScreen({ frame: true, saveNote: 'Save Note' }));
        const missing = compareDetailed(target, await structureOf(page)).deviations.find(({ text }) => text === 'button "Save note"');
        assert.equal(missing.kind, 'missing');
        assert.ok(near(missing.design, designBox), 'a missing element has its place in the design');
        assert.equal(missing.app, undefined, 'and none in the app');
        await page.setContent(noteScreen({ frame: true, heading: 'Notes' }));
        const text = compareDetailed(target, await structureOf(page)).deviations.find(({ kind }) => kind === 'text');
        assert.ok(text.design !== undefined && text.app !== undefined, JSON.stringify(text));
        await page.setContent(noteScreen({ frame: true, noteMargin: 'calc(1.2rem + 24px)' }));
        const layout = compareDetailed(target, await structureOf(page)).deviations.filter(({ kind }) => kind === 'layout');
        assert.ok(layout.length > 0 && layout.every((item) => item.design !== undefined && item.app !== undefined), JSON.stringify(layout));
        // The comparison page's data: the design as a whole page, the app as captured, its boxes on the captured part.
        await page.setContent(noteScreen({ frame: true, noteClass: 'btn' }).replace('</body>', '<div style="height:2000px"></div></body>'));
        await page.evaluate(() => window.scrollTo(0, 40));
        const shown = await designComparison({ cawDir, file: 'design/note.html', viewport, page, capture: () => captureStep(page), launch: () => launchChrome() });
        assert.equal(shown.met, false);
        assert.deepEqual([shown.app.width, shown.app.height], [390, 844], 'the app at the recorded size');
        assert.equal(shown.design.width, 390);
        assert.match(shown.design.src, /^data:image\/png;base64,/);
        const scrolled = shown.deviations.find((item) => item.text === 'button "Save note": background-color #5f8f6b → #e5533a');
        const appBox = await boxIn(page, saveNote);
        assert.ok(near(scrolled.app, { ...appBox, y: appBox.y - 40 }), `${JSON.stringify(scrolled.app)} ${JSON.stringify(appBox)}`);
        assert.equal(await designComparison({ cawDir, file: 'design/none.html', viewport, page, capture: () => captureStep(page), launch: () => launchChrome() }), null, 'no file, nothing to compare');
    } finally {
        await context.close();
    }
});

test('layout: the relation of neighbours, the tolerance and the indent in their block', () => {
    const element = (key, box, extra = {}) => ({ key, shown: key, kind: 'text', data: false, order: extra.order ?? 0, sub: 1, style: {}, size: [], ...box, ...extra });
    const a = element('heading "A"', { x: 0, y: 0, width: 100, height: 20 }, { order: 1 });
    const b = element('text "B"', { x: 0, y: 28, width: 100, height: 20 }, { order: 2 });
    const measures = layoutMeasures([a, b], [a, { ...b, y: 28.5 }]);
    assert.deepEqual(measures.filter(({ type }) => type === 'gap').map(({ target, actual }) => [target, actual]), [[8, 8.5]]);
    assert.deepEqual(compareStructure({ lines: [], styles: {}, elements: [a, b] }, { lines: [], styles: {}, elements: [a, { ...b, y: 28.5 }] }).layoutDiffs, [], 'within the tolerance');
    assert.deepEqual(compareStructure({ lines: [], styles: {}, elements: [a, b] }, { lines: [], styles: {}, elements: [a, { ...b, y: 30 }] }).layoutDiffs, ['Abstand heading "A" → text "B": 8px → 10px']);
    assert.equal(LAYOUT_TOLERANCE_PX, 1);
    // Below its neighbour, an element keeps its indent in its block: a right-aligned button moved to the left is named.
    const card = element('block "Card"', { x: 10, y: 0, width: 300, height: 100 }, { kind: 'block', order: 0, sub: 0, end: 5 });
    const button = element('button "Go"', { x: 250, y: 60, width: 50, height: 20 }, { kind: 'control', order: 3, sub: 0 });
    const moved = compareStructure({ lines: [], styles: {}, elements: [card, a, button] }, { lines: [], styles: {}, elements: [card, a, { ...button, x: 20 }] });
    assert.deepEqual(moved.layoutDiffs, ['Einzug block "Card" → button "Go": 240px → 10px']);
    // The first element in a block: its gap and indent from the block's edges.
    assert.deepEqual(relation(card, a), { where: 'inside', gap: 0, indent: -10 });
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

/**
 * A screen with a heading outside and a form card inside a structure area (data-caw-match="structure" in the design). The
 * options build the app's deviations: its own look inside the area, a missing or renamed element, swapped buttons, a style
 * outside the area.
 */
const structureScreen = ({ marked = true, card = 'background:#eeeeee;padding:20px;border-radius:4px', button = 'background:#e5533a;color:#fff;padding:6px 14px',
    label = 'font-size:14px;color:#222', gap = '8px', heading = 'Note', buttons = ['Save', 'Cancel'], title = 'color:#111111;font-size:28px' } = {}) => `<!doctype html><html><head><style>
body{margin:0;font-family:Arial,sans-serif}h1{${title};margin:16px}.card{${card};display:flex;flex-direction:column;gap:${gap};margin:16px}
.card label{${label}}.card button{${button};border:0}.row{display:flex;gap:${gap}}
</style></head><body><h1>Orders</h1><main${marked ? ' data-caw-match="structure"' : ''}><div class="card"><h2>${heading}</h2>
<label>Title <input></label><div class="row">${buttons.map((name) => `<button>${name}</button>`).join('')}</div></div></main></body></html>`;

test('rendered: inside data-caw-match="structure" only presence, order, texts and relations count; outside everything stays exact', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const viewport = { width: 800, height: 600 };
    const rendered = await renderDesign(browser, structureScreen(), viewport);
    const target = await structureOf(rendered);
    await rendered.context().close();
    assert.ok(target.elements.some(({ loose }) => loose === true), 'the area is marked loose');
    assert.equal(target.elements.find(({ key }) => key === 'heading "Orders"').loose, undefined, 'outside it nothing is loose');
    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        const judge = async (options) => {
            await page.setContent(structureScreen({ marked: false, ...options }));
            return compareDetailed(target, await structureOf(page));
        };
        // The framework's own look inside the area: colours, paddings, radius, font sizes, gaps and sizes.
        const looked = await judge({ card: 'background:#fafafa;padding:32px;border-radius:12px;box-shadow:0 1px 3px #0003', button: 'background:#2196f3;color:#fff;padding:10px 24px;font-size:15px', label: 'font-size:12px;color:#757575', gap: '20px' });
        assert.deepEqual(looked.deviations, []);
        assert.equal(looked.met, true);
        // Presence, texts and order still count.
        const missing = await judge({ buttons: ['Save'] });
        assert.equal(missing.met, false);
        assert.ok(missing.missing.includes('button "Cancel"'), missing.missing.join('; '));
        const renamed = await judge({ heading: 'Notes' });
        assert.deepEqual(renamed.textDiffs, ['Text: heading "Note" → "Notes"']);
        const swapped = await judge({ buttons: ['Cancel', 'Save'] });
        assert.equal(swapped.met, false);
        assert.ok(swapped.layoutDiffs.some((line) => line.includes('button "Cancel"')), swapped.layoutDiffs.join('; '));
        assert.deepEqual(swapped.styleDiffs, []);
        // Outside the area a style is compared as before.
        const outside = await judge({ title: 'color:#cc0000;font-size:28px' });
        assert.deepEqual(outside.styleDiffs, ['heading "Orders": color #111111 → #cc0000']);
        assert.equal(outside.met, false);
    } finally {
        await context.close();
    }
});

test('without data-caw-match the same look differences are style and layout deviations', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const viewport = { width: 800, height: 600 };
    const rendered = await renderDesign(browser, structureScreen({ marked: false }), viewport);
    const target = await structureOf(rendered);
    await rendered.context().close();
    const context = await browser.newContext({ viewport });
    try {
        const page = await context.newPage();
        await page.setContent(structureScreen({ marked: false, card: 'background:#fafafa;padding:32px;border-radius:12px', button: 'background:#2196f3;color:#fff;padding:10px 24px', gap: '20px' }));
        const found = compareDetailed(target, await structureOf(page));
        assert.ok(found.styleDiffs.some((line) => line.startsWith('button "Save": background-color')), found.styleDiffs.join('; '));
        assert.ok(found.layoutDiffs.length > 0);
        assert.equal(found.met, false);
    } finally {
        await context.close();
    }
});

test('rendered: a font embedded as a data: URL loads although the design renders offline (guide topic design)', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const font = readFileSync(new URL('../assets/fonts/geist-mono.woff2', import.meta.url)).toString('base64');
    const page = await renderDesign(browser, `<!doctype html><head><style>@font-face{font-family:Embedded;src:url(data:font/woff2;base64,${font}) format("woff2")}
        h1,h2{display:inline-block;font:400 26px serif}h1{font-family:Embedded,serif}</style></head><body><h1>Feed the raven</h1><h2>Feed the raven</h2></body>`);
    try {
        const { status, embedded, fallback } = await page.evaluate(`document.fonts.ready.then(() => ({ status: [...document.fonts].map((face) => face.status),
            embedded: document.querySelector('h1').getBoundingClientRect().width, fallback: document.querySelector('h2').getBoundingClientRect().width }))`);
        assert.deepEqual(status, ['loaded']);
        assert.notEqual(Math.round(embedded), Math.round(fallback));
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

test('the judge and the comparison page redact secrets on both sides: a design showing the signed-in user is met, no secret in the result', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    // The header of a design shows the test user like the app does; the user's name is a secret of the run.
    const screen = '<!doctype html><body><header><b>D</b><span>Dana Example · Sign out</span></header><main><h1>Note</h1><p>Bring seeds</p></main></body>';
    writeDesign(caw, 'design/header.html', Buffer.from(screen));
    const judge = createDesignJudge({ cawDir: caw, launch: launchChrome, read: (path) => readFileSync(path, 'utf8'), secrets: () => ['Dana Example'] });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    try {
        const page = await context.newPage();
        await page.setContent(screen);
        const met = await judge.judge({ file: 'design/header.html' }, page);
        assert.equal(met.verdict, 'met', JSON.stringify(met));
        await page.setContent(screen.replace('Bring seeds', 'Bring nuts'));
        const notMet = await judge.judge({ file: 'design/header.html' }, page);
        assert.equal(notMet.verdict, 'not-met');
        assert.ok(!JSON.stringify(notMet).includes('Dana Example'), 'the secret never reaches the result');
        const shown = await designComparison({ cawDir: caw, file: 'design/header.html', viewport: { width: 800, height: 600 }, page, capture: () => captureStep(page), launch: () => launchChrome(), secrets: ['Dana Example'] });
        assert.deepEqual(shown.deviations.map(({ kind }) => kind), ['text'], JSON.stringify(shown.deviations));
        assert.ok(!JSON.stringify(shown.deviations).includes('Dana Example'));
    } finally {
        await judge.close();
        await context.close();
    }
});

test('the judge at a pending step\'s entry: only the design\'s controls count, ready or still missing, never met', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    const caw = tempCaw(t);
    // The screen after saving: the saved note and a bold button. At the entry only the field and the button must be there.
    writeDesign(caw, 'design/note.html', Buffer.from('<!doctype html><body><main><h1>Note</h1><label>Note <input></label><button style="font-weight:700">Save note</button><p>Bring sunflower seeds</p></main></body>'));
    const judge = createDesignJudge({ cawDir: caw, launch: launchChrome, read: (path) => readFileSync(path, 'utf8') });
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><body><main><h2>Todo</h2><label>Note <input></label><button>Save note</button><p>No note yet.</p></main></body>');
        assert.deepEqual(await judge.judge({ file: 'design/note.html', entry: true }, page), { file: 'design/note.html', verdict: 'ready', missing: [] });
        await page.setContent('<!doctype html><body><main><h2>Todo</h2><label>Note <input></label></main></body>');
        assert.deepEqual(await judge.judge({ file: 'design/note.html', entry: true }, page), { file: 'design/note.html', verdict: 'not-ready', missing: ['button "Save note"'] });
        assert.equal((await judge.judge({ file: 'design/note.html' }, page)).verdict, 'not-met', 'after the check the whole design counts');
    } finally {
        await judge.close();
        await context.close();
    }
});

test('the judge: the app\'s scrollbar in a window narrows no block of the design (headless design browser)', async (t) => {
    if (needsChrome()) return t.skip('no Chrome');
    // A window shows scrollbars, the headless design browser hides them (Playwright's --hide-scrollbars): an app taller than its
    // viewport lays out its blocks narrower by the scrollbar's width than the design, which fits.
    const windowed = await launchChrome({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    t.after(() => windowed?.close());
    const caw = tempCaw(t);
    writeDesign(caw, 'design/message.html', Buffer.from('<!doctype html><body><div style="border:1px solid #888"><p>Show message</p></div></body>'));
    const judge = createDesignJudge({ cawDir: caw, launch: launchChrome, read: (path) => readFileSync(path, 'utf8') });
    const context = await windowed.newContext({ viewport: { width: 1280, height: 720 } });
    try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><body><div style="border:1px solid #888"><p>Show message</p></div><div style="height:3000px"></div></body>');
        const scrollbar = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);
        assert.ok(scrollbar > 0, `the app shows a scrollbar (${scrollbar}px)`);
        const judged = await judge.judge({ file: 'design/message.html', viewport: { width: 1280, height: 720 } }, page);
        assert.deepEqual(judged.layoutDiffs, []);
        assert.equal(judged.verdict, 'met');
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
