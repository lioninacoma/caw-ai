// Locator code: parse, print (round trip with Locator.toString()), mapStrings, labels, positional, rejects. The cases in
// locator-cases.json are what Playwright 1.64.1 printed (normalize() of snapshot refs on fixture pages, plus hand-built hard
// cases). The last tests build the locators in Chrome and compare with toString(); skipped without Chrome.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import {
    buildLocator, chainPrefix, checkLocator, escapeRegex, isGeneratedId, isPositional, locatorLabel, mapStrings, parseLocator,
    printLocator, rejectReason, renamedLocator,
} from '../src/host/locator.mjs';
import { launchChrome } from './chrome.mjs';

const CASES = JSON.parse(readFileSync(new URL('./locator-cases.json', import.meta.url), 'utf8'));

test('round trip: printLocator(parseLocator(code)) === code for every case Playwright printed', () => {
    assert.ok(CASES.length > 250);
    const differs = CASES.filter((code) => printLocator(parseLocator(code)) !== code);
    assert.deepEqual(differs, []);
});

test('parse: quotes, escapes, umlauts and regex come out as values', () => {
    assert.deepEqual(parseLocator("getByRole('button', { name: 'Kunde \\'O\\'Brien\\' \"zitiert\"', exact: true })"), [
        { method: 'getByRole', args: ['button', { name: 'Kunde \'O\'Brien\' "zitiert"', exact: true }] },
    ]);
    assert.equal(parseLocator("getByText('Zeile1\\nZeile2 \\u00e4\\u{1F600} \\x41')")[0].args[0], 'Zeile1\nZeile2 ä😀 A');
    assert.equal(parseLocator('getByText("Grüße – Straße")')[0].args[0], 'Grüße – Straße');
    const regex = parseLocator("getByRole('link', { name: /a\\/b[/]c/i })")[0].args[1].name;
    assert.ok(regex instanceof RegExp);
    assert.equal(regex.source, 'a\\/b[/]c');
    assert.equal(regex.flags, 'i');
    assert.ok(regex.test('A/B/C'));
});

test('parse: produces the canonical form toString() prints', () => {
    const canonical = (code) => printLocator(parseLocator(code));
    assert.equal(canonical("getByRole('button', { exact: true, pressed: true, name: 'x', level: 1 })"), "getByRole('button', { name: 'x', exact: true, level: 1, pressed: true })");
    assert.equal(canonical("getByRole('button', { name: /x/, exact: true })"), "getByRole('button', { name: /x/ })");
    assert.equal(canonical("getByRole('button', { exact: false })"), "getByRole('button')");
    assert.equal(canonical("getByText('x', { exact: false })"), "getByText('x')");
    assert.equal(canonical("locator('div', { has: getByRole('link'), hasText: 'x' })"), "locator('div').filter({ hasText: 'x' }).filter({ has: getByRole('link') })");
    assert.equal(canonical("locator('div').filter({ visible: true, hasNotText: /b/ })"), "locator('div').filter({ hasNotText: /b/ }).visible()");
    assert.equal(canonical("locator('div').filter({})"), "locator('div')");
    assert.equal(canonical("locator('div').nth(0).nth(-1)"), "locator('div').first().last()");
    assert.equal(canonical("frameLocator('#f').getByRole('button')"), "locator('#f').contentFrame().getByRole('button')");
    assert.equal(canonical('getByText("it\'s")'), "getByText('it\\'s')");
    assert.equal(canonical("getByText(`tick`)"), "getByText('tick')");
});

test('parse: rejects everything outside the allow-list with a German message', () => {
    const rejects = (code, pattern) => assert.throws(() => parseLocator(code), (error) => {
        assert.equal(error.code, 'target-invalid');
        assert.match(error.message, /ist nicht verwendbar/);
        assert.match(error.message, pattern);
        return true;
    }, code);
    rejects("page.getByRole('button')", /Methode page ist nicht erlaubt/);
    rejects("getByRole('button').click()", /Methode click ist nicht erlaubt/);
    rejects("getByRole('button').evaluate('x')", /Methode evaluate ist nicht erlaubt/);
    rejects("getByRole('button').filter(() => 1)", /unerwartet = an Position/);
    rejects("getByRole('button', { name: 'x', timeout: 5 })", /Option timeout ist nicht erlaubt/);
    rejects("getByRole('button', { name: 'x', name: 'y' })", /Option name/);
    rejects("getByRole(1)", /getByRole: unerwartete Argumente/);
    rejects("getByText('a', 'b')", /getByText: unerwartete Argumente/);
    rejects("nth(1)", /nth an Position 0 kann hier nicht stehen/);
    rejects("getByRole('x').nth('1')", /nth: unerwartete Argumente/);
    rejects("getByRole('x').contentFrame().first()", /first an Position \d+ kann hier nicht stehen/);
    rejects("locator('iframe').contentFrame()", /endet mit contentFrame/);
    rejects("getByText(`a${x}`)", /Template-Ausdrücke/);
    rejects("getByText('open", /nicht geschlossen/);
    rejects('getByText(/(/)', /ungültiger regulärer Ausdruck/);
    rejects('getByText(/[/)', /nicht geschlossen/);
    rejects("getByText('a') + 1", /unerwartet \+ an Position/);
    rejects("getByText('a') getByText('b')", /unerwarteter Text nach dem Ende/);
    rejects("getByRole('button').describe('Save')", /describe\(\) ersetzt den Locator/);
    rejects("getByText('a').filter({ has: 1 })", /filter: unerwartete Argumente/);
    rejects("getByRole['constructor']('x')", /unerwartet/);
    rejects("constructor('x')", /Methode constructor ist nicht erlaubt/);
    rejects('', /leer/);
});

const EXT = { framework: 'extjs' };

test('rejectReason: snapshot refs, generated ids, nth-child, describe, syntax', () => {
    assert.equal(rejectReason("locator('aria-ref=e5')"), 'aria-ref');
    assert.equal(rejectReason("locator('main').locator('aria-ref=e5')"), 'aria-ref');
    assert.equal(rejectReason("locator('#ext-element-29')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('#button-1023')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('#combo-1040-inputEl')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('#ext-gen1234')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('div[id=\"textfield-1030\"]')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('//div[@id=\"panel-12\"]')", EXT), 'generated-id');
    assert.equal(rejectReason("locator('extjs=#button-1023')", EXT), 'generated-id');
    assert.equal(rejectReason("getByRole('row').filter({ has: locator('#gridview-1050') })", EXT), 'generated-id');
    assert.equal(rejectReason("locator('div:nth-child(8) > button')"), 'nth-child');
    assert.equal(rejectReason("locator('li:nth-of-type(2)')"), 'nth-child');
    assert.equal(rejectReason("getByRole('button').describe('Save')"), 'describe');
    assert.equal(rejectReason('the save button'), 'syntax');
    for (const code of ["locator('#user-menu')", "locator('a[href=\"#section-1\"]')", "getByText('#button-1023')", "locator('extjs=button[text=\"Save\"]')", "getByRole('button', { name: 'Save' }).nth(2)"]) {
        assert.equal(rejectReason(code), null, code);
    }
    assert.equal(isGeneratedId('ext-comp-1023', 'extjs'), true);
    assert.equal(isGeneratedId('saveButton', 'extjs'), false);
    // Outside ExtJS an id like step-2 is written by hand: kept.
    assert.equal(isGeneratedId('button-1023'), false);
    assert.equal(rejectReason("locator('#button-1023')"), null);
    assert.equal(rejectReason("locator('#step-2')"), null);
    assert.throws(() => checkLocator("locator('#button-1023')", EXT), (error) => error.code === 'target-invalid' && error.reason === 'generated-id' && /die ID button-1023 ist generiert/.test(error.message));
    assert.throws(() => checkLocator("locator('aria-ref=e5')"), /aria-ref= gilt nur für einen Snapshot/);
    assert.deepEqual(checkLocator("getByRole('button', { name: 'Save' })"), [{ method: 'getByRole', args: ['button', { name: 'Save' }] }]);
});

test('mapStrings: every string argument, kinds, nested locators; the AST is not changed', () => {
    const code = "locator('iframe[title=\"{{a}}\"]').contentFrame().getByRole('listitem').filter({ hasText: '{{a}}' }).filter({ has: getByRole('link', { name: /^{{a}} \\d+$/ }) }).getByTestId('{{a}}').or(getByText('{{a}}', { exact: true }))";
    const ast = parseLocator(code);
    const seen = [];
    const mapped = mapStrings(ast, (value, kind, escape) => {
        seen.push(kind);
        return value.replaceAll('{{a}}', escape("O'Brien (1.)"));
    });
    assert.equal(printLocator(ast), code, 'the input AST stays as it was');
    assert.deepEqual(seen, ['selector', 'string', 'string', 'string', 'regex', 'string', 'string']);
    assert.equal(printLocator(mapped), "locator('iframe[title=\"O\\'Brien (1.)\"]').contentFrame().getByRole('listitem').filter({ hasText: 'O\\'Brien (1.)' }).filter({ has: getByRole('link', { name: /^O'Brien \\(1\\.\\) \\d+$/ }) }).getByTestId('O\\'Brien (1.)').or(getByText('O\\'Brien (1.)', { exact: true }))");
    const regex = mapped[4].args[0].has.chain[0].args[1].name;
    assert.ok(regex.test("O'Brien (1.) 42"));
    assert.ok(!regex.test("O'Brien X1Y 42"), 'the inserted value matches literally');
    // Round trip of the result.
    assert.equal(printLocator(parseLocator(printLocator(mapped))), printLocator(mapped));
    // Non-string values stay; a regex the callback breaks is an error.
    assert.deepEqual(mapStrings(parseLocator("getByRole('heading', { level: 2 }).nth(3)"), (value) => value), parseLocator("getByRole('heading', { level: 2 }).nth(3)"));
    assert.throws(() => mapStrings(parseLocator('getByText(/a/)'), () => '('), /ungültiger regulärer Ausdruck/);
    assert.equal(escapeRegex('a.b*c?(d)[e]{f}|g^h$i\\j/k'), 'a\\.b\\*c\\?\\(d\\)\\[e\\]\\{f\\}\\|g\\^h\\$i\\\\j\\/k');
});

test('locatorLabel: element and nearest scope, extjs components, positions', () => {
    const cases = {
        "getByRole('button', { name: 'Save', exact: true })": 'button "Save"',
        "getByRole('dialog', { name: 'New todo' }).getByRole('button', { name: 'Save' })": 'button "Save" in dialog "New todo"',
        "getByRole('listitem').filter({ hasText: 'Feed the raven' }).getByRole('button', { name: 'Complete' })": 'button "Complete" in listitem "Feed the raven"',
        "getByRole('button', { name: /^Prüfen \\d+$/i })": 'button "/^Prüfen \\d+$/i"',
        "getByRole('button', { name: 'Edit' }).nth(1)": 'button "Edit" [2]',
        "getByRole('row').first()": 'row [1]',
        "getByRole('row').last()": 'row [last]',
        "getByText('Hello')": 'text "Hello"',
        "getByLabel('Name')": 'field "Name"',
        "getByPlaceholder('Search')": 'field "Search"',
        "getByAltText('logo')": 'image "logo"',
        "getByTestId('export-btn')": 'Element "#export-btn"',
        "locator('extjs=app_abortButton[text=\"Abbrechen\"]')": 'app_abortButton "Abbrechen"',
        "locator('extjs=window[title=\"Neuer Antrag\"] button[text=\"Speichern\"]')": 'button "Speichern" in window "Neuer Antrag"',
        "locator('extjs=dialog[title=\"Zweiter\"] button[text=\"OK\"]').locator('button')": 'button "OK" in dialog "Zweiter"',
        "locator('extjs=textfield[label=\"Bereich*\"]').locator('input')": 'textfield "Bereich*"',
        "locator('extjs=textfield[fieldLabel=\"Bereich*\"]')": 'textfield "Bereich*"',
        "locator('extjs=#saveButton')": 'Element "#saveButton"',
        "locator('extjs=button#save')": 'button "#save"',
        "locator('iframe[title=\"Payment\"]').contentFrame().getByRole('button', { name: 'Pay' })": 'button "Pay" in iframe "Payment"',
        "locator('div').filter({ hasText: /^Kunde$/ })": 'div "/^Kunde$/"',
        "locator('#user-menu')": '#user-menu',
        'not a locator': 'not a locator',
    };
    for (const [code, label] of Object.entries(cases)) assert.equal(locatorLabel(code), label, code);
    assert.equal(locatorLabel(parseLocator("getByRole('button', { name: 'Save' })")), 'button "Save"', 'takes an AST too');
});

test('renamedLocator: swaps the name of the element\'s own getByRole, keeps scope, options and narrowing', () => {
    assert.deepEqual(renamedLocator("getByRole('button', { name: 'Speichern', exact: true })", 'Sichern'), { code: "getByRole('button', { name: 'Sichern', exact: true })", from: 'Speichern' });
    assert.deepEqual(renamedLocator("getByRole('dialog', { name: 'Speichern' }).getByRole('button', { name: 'Speichern' }).first()", 'Sichern „neu“'), {
        code: "getByRole('dialog', { name: 'Speichern' }).getByRole('button', { name: 'Sichern „neu“' }).first()",
        from: 'Speichern',
    });
    assert.equal(renamedLocator("getByRole('button', { name: \"It's\" })", "It's new").code, "getByRole('button', { name: 'It\\'s new' })");
    // Nothing caw could prove: no name of its own, a regex, a placeholder, the same name, or another kind of locator.
    assert.equal(renamedLocator("getByRole('button')", 'Sichern'), null);
    assert.equal(renamedLocator("getByRole('button', { name: /Speichern/ })", 'Sichern'), null);
    assert.equal(renamedLocator("getByRole('button', { name: 'Speichern {{runTag}}' })", 'Sichern'), null);
    assert.equal(renamedLocator("getByRole('button', { name: 'Speichern' })", 'Speichern'), null);
    assert.equal(renamedLocator("getByRole('button', { name: 'Speichern' }).getByText('x')", 'Sichern'), null);
    assert.equal(renamedLocator("getByText('Speichern')", 'Sichern'), null);
    assert.equal(renamedLocator('nonsense(', 'Sichern'), null);
    assert.equal(renamedLocator("getByRole('button', { name: 'Speichern' })", ' '), null);
    // The result must still be a recording locator: a generated ExtJS id in the scope stays rejected.
    assert.equal(renamedLocator("locator('#button-1023').getByRole('button', { name: 'Speichern' })", 'Sichern', { framework: 'extjs' }), null);
});

test('isPositional: nth/first/last or a bare tag', () => {
    for (const code of ["getByRole('button').nth(2)", "getByRole('button').first()", "locator('iframe').first().contentFrame().getByRole('button', { name: 'Pay' })", "locator('div')", "getByRole('dialog').locator('button')"]) {
        assert.equal(isPositional(code), true, code);
    }
    for (const code of ["getByRole('button', { name: 'Save' })", "locator('div').filter({ hasText: 'Kunde' })", "locator('extjs=button[text=\"Save\"]')", "locator('extjs=button[text=\"Save\"]').locator('button')", "locator('extjs=combobox[label=\"Kind\"]').locator('div.x-expandtrigger')", "locator('#save')", "locator('iframe').contentFrame().getByRole('button')"]) {
        assert.equal(isPositional(code), false, code);
    }
    assert.equal(isPositional(parseLocator("getByRole('row').last()")), true, 'takes an AST too');
});

test('chainPrefix: the frame part up to the last contentFrame()', () => {
    const prefix = (code) => printLocator(chainPrefix(code));
    assert.equal(prefix("getByRole('button')"), '');
    assert.equal(prefix("locator('iframe[title=\"Payment\"]').contentFrame().locator('iframe[title=\"Bank\"]').contentFrame().getByRole('button', { name: 'Confirm' })"), "locator('iframe[title=\"Payment\"]').contentFrame().locator('iframe[title=\"Bank\"]').contentFrame()");
    assert.equal(prefix("locator('iframe').first().contentFrame().getByRole('listitem').filter({ has: getByRole('link') })"), "locator('iframe').first().contentFrame()");
});

// In Chrome: the built locator prints like printLocator and finds what the code says.
let browser = null;
let page = null;
before(async () => {
    browser = await launchChrome();
    page = await browser?.newPage();
});
after(async () => { await browser?.close(); });

test('buildLocator: toString() of the built locator equals printLocator for every case and for non-canonical input', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const differs = CASES.filter((code) => buildLocator(page, parseLocator(code)).toString() !== code);
    assert.deepEqual(differs, []);
    const loose = [
        "getByRole('button', { exact: true, pressed: true, name: 'x', level: 1, checked: false, selected: true, description: 'd' })",
        "getByRole('button', { name: /x/, exact: true })", "getByText(/x/, { exact: true })",
        "locator('div', { has: getByRole('link'), hasText: 'x', hasNot: getByText('a'), hasNotText: /b/ })",
        "locator('div').filter({ has: getByRole('link'), hasText: 'x', hasNot: getByText('a'), hasNotText: /b/, visible: true })",
        "locator('div').filter({ visible: false })", "locator('div').filter({})", "locator('div').nth(0)", "locator('div').nth(-1)",
        "frameLocator('#f').locator('x')", "getByText(\"a'b\")", "getByRole('button', { name: `O'Brien` })",
    ];
    for (const code of loose) assert.equal(buildLocator(page, parseLocator(code)).toString(), printLocator(parseLocator(code)), code);
    return undefined;
});

test('buildLocator: finds the elements in the page and in frames, on a Frame as root too', async (t) => {
    if (browser === null) return t.skip('no Chrome');
    const inner = '<ul><li>Order 1 <button>Edit</button></li><li>Order 2 <a href=#x>Feed</a> <button>Edit</button></li></ul>';
    await page.setContent(`<main><button>Save</button><button>O'Brien</button><button>Prüfen 12</button></main><iframe title="Payment" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`);
    await page.locator('iframe').contentFrame().locator('ul').waitFor({ state: 'attached' });
    const text = (code, root = page) => buildLocator(root, parseLocator(code)).textContent({ timeout: 2000 });
    assert.equal(await text("getByRole('button', { name: 'Save', exact: true })"), 'Save');
    assert.equal(await text("getByRole('button', { name: 'O\\'Brien' })"), "O'Brien");
    assert.equal(await text("getByRole('button', { name: /^Prüfen \\d+$/ })"), 'Prüfen 12');
    assert.equal(await text("locator('iframe[title=\"Payment\"]').contentFrame().getByRole('listitem').filter({ hasText: 'Order 2' }).getByRole('button')"), 'Edit');
    assert.equal(await text("locator('iframe').contentFrame().getByRole('listitem').filter({ has: getByRole('link', { name: 'Feed' }) })"), 'Order 2 Feed Edit');
    assert.equal(await buildLocator(page, parseLocator("locator('iframe').contentFrame().getByRole('button', { name: 'Edit' })")).count(), 2);
    assert.equal(await buildLocator(page, parseLocator("getByRole('button', { name: 'Save' }).or(getByRole('button', { name: 'Missing' }))")).count(), 1);
    assert.equal(await text("getByRole('listitem').last().getByRole('button')", page.frames()[1]), 'Edit', 'root is a Frame');
    const filled = mapStrings(parseLocator("getByRole('button', { name: /^{{x}}$/ })"), (value, _kind, escape) => value.replace('{{x}}', escape("O'Brien")));
    assert.equal(await buildLocator(page, filled).textContent({ timeout: 2000 }), "O'Brien");
    assert.throws(() => buildLocator(page.frames()[1], [{ method: 'contentFrame', args: [] }]), /contentFrame\(\) ist hier nicht verfügbar/);
    assert.throws(() => buildLocator(page, [{ method: 'evaluate', args: ['1'] }]), /Methode evaluate ist nicht erlaubt/, 'hand-built ASTs are checked too');
    return undefined;
});
