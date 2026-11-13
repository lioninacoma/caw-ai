// The tests of the native fixture site, recordings written by hand as `record` writes them: one Playwright locator per target.
// writeTests() rewrites them before the scenarios; `caw run` replays them without Claude.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseTest, recordingPath, stepHash, testPath, writeTest } from '../../src/host/test-file.mjs';

const button = (name) => `getByRole('button', { name: '${name}', exact: true })`;
const PAYMENT = "locator('iframe[title=\"Payment\"]').contentFrame()";
const BANK = `${PAYMENT}.locator('iframe[title="Bank"]').contentFrame()`;
const RATING = "getByRole('group', { name: 'Rating' })";
const WIZARD = "getByRole('dialog', { name: 'Wizard' })";
const status = (text) => `document.getElementById('status').textContent===${JSON.stringify(text)}`;

/**
 * The tests by id: steps with name, do, expect, actions (as in the recording file) and check. A step's actions run on path / unless
 * they say otherwise.
 */
export const TESTS = {
    // N3: what the recording keeps besides the locators.
    'n3-layers': [
        { name: 'Preise laden', expect: 'Die Preise sind geladen.', actions: [{ click: button('Load prices') }, { 'wait-ready': {} }], check: "document.getElementById('prices').textContent==='loaded'" },
        {
            name: 'Zweimal zaehlen', expect: 'Der Zaehler steht auf 2, ein fehlendes Cookie-Banner stoert nicht.',
            actions: [{ click: button('Accept cookies'), optional: true }, { click: button('Add one') }, { click: button('Add one') }],
            check: "document.getElementById('count').textContent==='2'",
        },
        { name: 'Anhang', expect: 'Der Anhang ist gewaehlt.', actions: [{ upload: "getByLabel('Attachment')", files: ['files/note.txt'] }], check: "document.getElementById('file-name').textContent==='note.txt'" },
        { name: 'Bericht', expect: 'Der Bericht wird geladen.', actions: [{ download: "getByRole('link', { name: 'Download report', exact: true })", file: '^report\\.csv$' }], check: 'true' },
        {
            name: 'Code bestaetigen', expect: 'Der Code ist bestaetigt.',
            actions: [
                { click: button('Issue code') },
                { remember: { name: 'code', code: "document.getElementById('code').textContent", secret: true } },
                { fill: "getByRole('textbox', { name: 'Confirmation code', exact: true })", value: '{{code}}' },
                { click: button('Verify') },
            ],
            check: status('Verified'),
        },
    ],
    // N6: the wizard's dialogs overlap for 600 ms while one fades out; the locator matches both meanwhile.
    'n6-wizard': [
        { name: 'Assistent', expect: 'Der Assistent ist durch.', actions: [{ click: button('Start wizard') }, { click: `${WIZARD}.${button('Next')}` }, { click: `${WIZARD}.${button('Next')}` }, { click: `${WIZARD}.${button('Next')}` }], check: status('Wizard done') },
    ],
    // N6: two identical buttons: the recording cannot say which one.
    'n6-twins': [
        { name: 'Wiederholen', expect: 'Es wird wiederholt.', actions: [{ click: button('Retry') }], check: "document.getElementById('status').textContent.startsWith('Retry')" },
    ],
    // N7: row 150 of a virtual list exists only after scrolling.
    'n7-vlist': [
        { name: 'Eintrag waehlen', expect: 'Eintrag 150 ist gewaehlt.', actions: [{ click: `getByRole('listitem').filter({ hasText: 'Item 150' }).${button('Pick')}` }], check: status('Picked Item 150') },
    ],
    // N8: a frame inside a frame.
    'n8-frames': [
        {
            name: 'Bezahlen', expect: 'Bezahlt und per TAN bestaetigt.',
            actions: [
                { fill: `${PAYMENT}.getByRole('textbox', { name: 'Amount', exact: true })`, value: '12' },
                { click: `${PAYMENT}.${button('Pay')}` },
                { click: `${BANK}.${button('Confirm with TAN')}` },
            ],
            check: "(()=>{const pay=document.querySelector('iframe[title=Payment]').contentDocument;return pay.getElementById('st').textContent==='Paid 12'&&pay.querySelector('iframe[title=Bank]').contentDocument.querySelector('button').textContent==='Confirmed';})()",
        },
    ],
    // N8: the recording names a frame the page does not have.
    'n8-missing-frame': [
        { name: 'Erstatten', expect: 'Erstattet.', actions: [{ click: `locator('iframe[title="Refunds"]').contentFrame().${button('Refund')}` }], check: 'true' },
    ],
    // N9: a field and a button in an open shadow root.
    'n9-shadow': [
        { name: 'Bewerten', expect: 'Die Bewertung ist bestaetigt.', actions: [{ fill: `${RATING}.getByRole('textbox', { name: 'Comment', exact: true })`, value: 'Good' }, { click: `${RATING}.${button('Rate')}` }], check: "document.querySelector('caw-rating').shadowRoot.querySelector('[role=status]').textContent==='Thanks: Good'" },
        { name: 'Speichern', expect: 'Gespeichert.', actions: [{ click: button('Save') }], check: status('Saved') },
    ],
    // N11: the button was renamed ("Archive" to "Archive all").
    'n11-renamed': [
        { name: 'Archivieren', expect: 'Archiviert.', actions: [{ goto: '/?rename=1' }, { click: button('Archive') }], check: status('Archived') },
    ],
    // N11: a message box covers the button.
    'n11-covered': [
        { name: 'Meldung', expect: 'Die Meldung steht da.', actions: [{ click: button('Show message') }], check: "document.querySelector('[role=alert]')?.textContent==='Session expired.'" },
        { name: 'Alles loeschen', expect: 'Geloescht.', actions: [{ click: button('Delete all') }], check: status('Deleted') },
    ],
};

/** The single-file view of a test (description and recording), as parseTest reads it. */
export const testText = (id, steps, { recordedOn = 'test' } = {}) => {
    const lines = [`id: ${id}`, 'role: visitor', 'targets: [test]', 'mutates: false', 'steps:'];
    steps.forEach((step, index) => {
        const plain = { id: `S${index + 1}`, name: step.name, do: step.do ?? '', expect: step.expect };
        lines.push(
            `  - id: ${plain.id}`, `    name: ${JSON.stringify(plain.name)}`, `    do: ${JSON.stringify(plain.do)}`, `    expect: ${JSON.stringify(plain.expect)}`,
            '    recording:', `      hash: ${stepHash(plain)}`, ...(index === 0 ? [] : [`      after: S${index}`]),
            `      recordedOn: ${recordedOn}`, '      recordedAt: 2026-11-12T10:00:00.000Z', '      locale: en-US', '      timezone: Europe/Berlin',
            '      actions:', ...step.actions.map((action) => `        - ${JSON.stringify(action.goto !== undefined || action.remember !== undefined || action['wait-ready'] !== undefined ? action : { path: '/', ...action })}`),
            `      check: ${JSON.stringify(step.check)}`,
        );
    });
    // The status line's texts are expected: without knownMessages each would be a warning (new status message).
    lines.push('knownMessages:', ...MESSAGES.map((text) => `  - ${JSON.stringify(text)}`));
    return `${lines.join('\n')}\n`;
};
const MESSAGES = ['Added', 'Saved', 'Verified', 'Wrong code', 'Wizard done', 'Picked Item #', 'Thanks: Good', 'Deleted', 'Archived', 'Session expired.', 'Session expired. Close', 'Kind: #', 'Searched: #', 'Completed: Errand #'];

/** Writes every test of TESTS into the project, replacing what is there. */
export const writeTests = (root) => {
    mkdirSync(join(root, 'caw/tests'), { recursive: true });
    for (const [id, steps] of Object.entries(TESTS)) {
        rmSync(testPath(root, id), { force: true });
        rmSync(recordingPath(root, id), { force: true });
        writeTest(root, { ...parseTest(testText(id, steps), id), id });
    }
};
