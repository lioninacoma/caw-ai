// Native dialogs (Q11) without a browser: the handler with fake dialogs, the replay findings, the recorded shape, the schema.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDialogs, dialogFindings, dialogMessage, dialogProblem, recordedDialog } from '../src/host/dialogs.mjs';
import { swapToken } from '../src/host/replay.mjs';
import { parseTest } from '../src/host/test-file.mjs';

/** A dialog as Playwright hands it over; `answered` says what the handler did. */
const fakeDialog = (type, message, defaultValue = '') => {
    const dialog = {
        answered: null,
        type: () => type,
        message: () => message,
        defaultValue: () => defaultValue,
        accept: async (value) => { dialog.answered = { accept: true, value }; },
        dismiss: async () => { dialog.answered = { accept: false }; },
    };
    return dialog;
};

test('dialogs: an armed decision answers the next dialog once; an unarmed one is dismissed; alert is always accepted', async () => {
    const dialogs = createDialogs();
    dialogs.begin();
    dialogs.arm({ accept: true, value: 'Note CAW-1' });
    const prompt = fakeDialog('prompt', 'New title', 'Ticket');
    await dialogs.handle(prompt);
    assert.deepEqual(prompt.answered, { accept: true, value: 'Note CAW-1' });
    const second = fakeDialog('confirm', 'Sure?');
    await dialogs.handle(second);
    assert.deepEqual(second.answered, { accept: false }, 'the arming was used up');
    const alert = fakeDialog('alert', 'Pong');
    await dialogs.handle(alert);
    assert.equal(alert.answered.accept, true);
    assert.deepEqual(dialogs.end().map(({ type, accept, decided }) => [type, accept, decided]), [['prompt', true, 'armed'], ['confirm', false, 'dismissed'], ['alert', true, 'dismissed']]);
    assert.deepEqual(dialogs.end(), [], 'end() empties');
});

test('dialogs: in a demonstration the human answers; null dismisses', async () => {
    const dialogs = createDialogs();
    dialogs.asking(async ({ type }) => (type === 'confirm' ? { accept: true } : null));
    const confirm = fakeDialog('confirm', 'Delete order 4711?');
    await dialogs.handle(confirm);
    const prompt = fakeDialog('prompt', 'Name?', 'x');
    await dialogs.handle(prompt);
    assert.deepEqual([confirm.answered.accept, prompt.answered.accept], [true, false]);
    const seen = dialogs.end();
    assert.deepEqual(recordedDialog(seen), { type: 'confirm', accept: true, message: 'Delete order ####?' });
    dialogs.asking(null);
    const later = fakeDialog('confirm', 'Again?');
    await dialogs.handle(later);
    assert.equal(later.answered.accept, false);
});

test('dialogFindings: missing, other type and unexpected dialogs become warnings; the recorded one passes silently', () => {
    const confirm = { type: 'confirm', accept: true };
    assert.deepEqual(dialogFindings(confirm, [{ type: 'confirm', message: 'x', accept: true, decided: 'armed' }]), []);
    assert.deepEqual(dialogFindings(confirm, []).map(({ type }) => type), ['dialog-missing']);
    assert.deepEqual(dialogFindings(confirm, [{ type: 'alert', message: 'x', accept: true, decided: 'armed', expected: 'confirm' }]).map(({ type }) => type), ['dialog-type']);
    assert.deepEqual(dialogFindings(undefined, [{ type: 'alert', message: 'Maintenance', accept: true, decided: 'dismissed' }]).map(({ type }) => type), ['dialog-unexpected']);
    assert.equal(dialogMessage('Delete 3 of 12 orders?'), 'Delete # of ## orders?');
});

test('schema: dialog on the opener action, hover and dragTo with to; wrong shapes are named', () => {
    const recording = (actions) => `id: t\nrole: r\nwrites: false\nsteps:\n  - id: S1\n    name: "A"\n    do: ""\n    expect: "B"\n    recording:\n      hash: x\n      recordedOn: local\n      recordedAt: 2026-11-14T10:00:00.000Z\n      locale: en-US\n      timezone: Europe/Berlin\n      actions:\n${actions.map((action) => `        - ${JSON.stringify(action)}`).join('\n')}\n      check: "true"\n`;
    const button = "getByRole('button', { name: 'Delete', exact: true })";
    const parsed = parseTest(recording([
        { click: button, dialog: { type: 'confirm', accept: true, message: 'Delete?' } },
        { reload: {}, dialog: { type: 'beforeunload', accept: true } },
        { hover: button },
        { dragTo: button, to: "getByRole('list', { name: 'Done', exact: true })" },
    ]), 't');
    assert.deepEqual(parsed.steps[0].recording.actions.map(({ action, dialog, to }) => [action, dialog?.type, to]), [['click', 'confirm', undefined], ['reload', 'beforeunload', undefined], ['hover', undefined, undefined], ['dragTo', undefined, "getByRole('list', { name: 'Done', exact: true })"]]);
    const problems = (action) => {
        try {
            parseTest(recording([action]), 't');
            return '';
        } catch (error) {
            return error.message;
        }
    };
    assert.match(problems({ click: button, dialog: { type: 'alert', accept: false } }), /alert lässt sich nur bestätigen/);
    assert.match(problems({ click: button, dialog: { type: 'confirm', accept: true, value: 'x' } }), /nur bei einem prompt mit accept: true/);
    assert.match(problems({ click: button, dialog: { type: 'popup', accept: true } }), /alert, confirm, prompt oder beforeunload/);
    assert.match(problems({ hover: button, dialog: { type: 'alert', accept: true } }), /dialog/);
    assert.match(problems({ dragTo: button }), /dragTo to/);
    assert.equal(dialogProblem({ type: 'prompt', accept: true, value: 'v' }), null);
});

test('swapToken: a short remembered value (OPEN-7) only in typed values, URLs, string literals of code and whole target arguments', () => {
    const step = {
        action: 'fill',
        value: '7',
        code: "items.length === 7 && document.title === 'Ticket 7'",
        url: '/tickets/7',
        target: "getByRole('row', { name: 'Ticket 7 of 12' }).getByRole('cell', { name: '7', exact: true })",
    };
    assert.deepEqual(swapToken(step, '7', '{{id}}'), {
        action: 'fill',
        value: '{{id}}',
        code: "items.length === 7 && document.title === 'Ticket {{id}}'",
        url: '/tickets/{{id}}',
        target: "getByRole('row', { name: 'Ticket 7 of 12' }).getByRole('cell', { name: '{{id}}', exact: true })",
    });
    assert.equal(swapToken({ action: 'click', target: "getByRole('cell').filter({ hasText: /^7$/ })" }, '7', '{{id}}').target, "getByRole('cell').filter({ hasText: /^{{id}}$/ })");
});
