// The complete list of what the agent may do in the browser. It never gets CDP, since that would allow bypassing
// the host block (e.g. a new browser context with its own proxy).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { evaluateFinish } from '../shared/report.mjs';
import { fixtureFiles, fixturePath } from './fixtures.mjs';
import { withLoopbackPair } from './host-lock.mjs';
import { buildLocator, parseLocator } from './locator.mjs';
import { passwordValues, redactDeep } from './secrets.mjs';

const ACTION_TIMEOUT_MS = 15_000;
const NETWORK_SHOWN = 60;
// Press and release like a human: some UIs react to the press with a delay.
export const CLICK_DELAY_MS = 100;
const COMMAND_TIMEOUT_MS = 300_000;
const SCREENSHOT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$/;
const ARIA_REF = /^(f\d+)?e\d+$/;
const REMEMBER_NAME = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
// Any value of at least one character (a short id in a fresh database); short ones are replaced carefully (swapToken).
const REMEMBER_MIN_LENGTH = 1;

const usage = (message) => new CawError('usage', message);

const text = (command, field) => {
    const value = command[field];
    if (typeof value !== 'string' || value === '') throw usage(t('run.agent.missing', { field }));
    return value;
};

/** goto only to navigation hosts, checked before navigating: the same rule as the browser's host lock (host-lock.mjs). */
export const isAllowedUrl = (url, hosts) => {
    try {
        const { protocol, hostname } = new URL(url);
        return ['http:', 'https:'].includes(protocol) && withLoopbackPair(hosts).includes(hostname);
    } catch {
        return false;
    }
};
const hostNameOf = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return String(url);
    }
};

/**
 * A value for inside a string literal in code, whichever quotes surround it: ' " ` and ${ cannot end the literal or start an
 * expression, line breaks cannot break the line. For filling remembered values into a check's or remember's code (O'Brien).
 */
export const codeText = (value) => String(value).replace(/[\\'"`$]/g, '\\$&').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

// Locator code starts with a method call, e.g. getByRole('button', { name: 'Save' }); a CSS selector never does.
const LOCATOR_CODE = /^\s*[A-Za-z_$][\w$]*\s*\(/;

/**
 * A reference from the snapshot (e12, f2e5), Playwright locator code without `page.` (parsed, never evaluated) or a CSS
 * selector. Code starts at the application's main frame, with the workbench the frame in its iframe.
 */
export const locatorFor = (page, target) => {
    if (ARIA_REF.test(target)) return page.locator(`aria-ref=${target}`);
    if (LOCATOR_CODE.test(target)) return buildLocator(page.mainFrame(), parseLocator(target));
    return page.locator(target);
};

/**
 * Sets a field to `value`. A <select> cannot be filled: there the value picks the option by its value, otherwise by its label,
 * so `fill <select> "home"` works the same in recording and replay, independent of the option order.
 * @param element a Playwright Locator or ElementHandle
 */
export const fillField = async (element, value, { timeout }) => {
    const isSelect = await Promise.resolve().then(() => element.evaluate((node) => node.tagName === 'SELECT')).catch(() => false);
    if (!isSelect) {
        await element.fill(value, { timeout });
        return;
    }
    const byValue = await element.evaluate((node, wanted) => [...node.options].some((option) => option.value === wanted), value);
    await element.selectOption(byValue ? { value } : { label: value }, { timeout });
};

/**
 * Before an action on a disabled target: leaves the field that still has the focus, as the pointer going down beside it would.
 * Some fields unlock the next one only when they are left (an ExtJS combobox takes its entry on blur), and Playwright waits for
 * an enabled target without ever leaving the field. Nothing happens if the target is enabled, holds the focus or contains it:
 * typing a filter and then clicking an entry of the open list keeps the field focused.
 * @param element a Playwright Locator or ElementHandle
 */
export const leaveForDisabled = async (element) => {
    const enabled = await Promise.resolve().then(() => element.isEnabled({ timeout: 1000 })).catch(() => true);
    if (enabled) return false;
    return element.evaluate((node) => {
        const focused = node.ownerDocument.activeElement;
        if (focused === null || focused === node.ownerDocument.body || focused === node || focused.contains(node) || node.contains(focused)) return false;
        focused.blur();
        return true;
    }).catch(() => false);
};

/**
 * Sets files for upload: a file input gets them directly, a button in front of a hidden one opens the file chooser on click,
 * which then gets them. The same for Claude and for replay.
 * @param target a Playwright Locator or ElementHandle
 * @param page   the page whose file chooser belongs to the target
 * @returns false if the click opened no file chooser
 */
export const setFiles = async (target, files, { page, timeout }) => {
    if (await target.evaluate((node) => node instanceof globalThis.HTMLInputElement && node.type === 'file')) {
        await target.setInputFiles(files, { timeout });
        return true;
    }
    const chooser = page.waitForEvent('filechooser', { timeout }).catch(() => null);
    // Do not wait for the click first: on Windows it sometimes only returns once the file chooser has been handled.
    const clicked = target.click({ timeout, delay: CLICK_DELAY_MS }).then(() => null, (error) => error);
    const picker = await Promise.race([chooser, clicked.then((error) => (error === null ? chooser : null))]);
    if (picker === null) {
        const error = await clicked;
        if (error !== null) throw error;
        return false;
    }
    await picker.setFiles(files, { timeout });
    // The files are set; a click still hanging afterwards changes nothing.
    await clicked;
    return true;
};

// How long an optional click waits for its target.
const OPTIONAL_WAIT_MS = 3000;

/**
 * @param expand optional: fills placeholders of secret remembered values ({{iban}}) into fill/type values; code with one is refused.
 *   Claude never sees them in plain text and works with the placeholder; only the host fills it in.
 */
/**
 * @param filesDir the project's caw folder: upload takes files from its fixtures folder only
 */
export const createAgentHandler = ({ session, run, hosts, agentDir, filesDir, onVerdict, expand = (value) => value, commandTimeoutMs = COMMAND_TIMEOUT_MS }) => {
    const screenshots = new Set();
    let finished = false;

    const locate = (command) => locatorFor(session.page(), text(command, 'target'));

    const commands = {
        task: () => run,
        snapshot: () => session.page().ariaSnapshot({ mode: 'ai' }),
        url: () => session.page().url(),
        click: async (command) => {
            // Optional, e.g. a cookie banner: if the target is not (or no longer) there, there is nothing to do. Replay skips it the same way.
            if (command.optional === true && !await locate(command).waitFor({ state: 'visible', timeout: OPTIONAL_WAIT_MS }).then(() => true, () => false)) return 'absent';
            await leaveForDisabled(locate(command));
            await locate(command).click({ timeout: ACTION_TIMEOUT_MS, delay: CLICK_DELAY_MS });
            return 'ok';
        },
        // Files from caw/fixtures only, named relative to the caw folder as the recording stores them (fixtures/brief.pdf).
        upload: async (command) => {
            const files = Array.isArray(command.files) ? command.files : [];
            const paths = files.map((file) => (filesDir === undefined ? null : fixturePath(filesDir, file)));
            if (files.length === 0 || paths.includes(null)) {
                const known = filesDir === undefined ? [] : fixtureFiles(filesDir);
                throw usage(t('run.agent.uploadFiles', { files: files.join(', ') || '–', known: known.join(', ') || '–' }));
            }
            await leaveForDisabled(locate(command));
            if (!await setFiles(locate(command), paths.map((path) => join(filesDir, path)), { page: session.page(), timeout: ACTION_TIMEOUT_MS })) {
                throw usage(t('session.replay.noChooser', { target: text(command, 'target') }));
            }
            return { files: paths };
        },
        // The pointer over the target, e.g. a menu that opens on hover. Records as hover.
        hover: async (command) => {
            await locate(command).hover({ timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        // Drag the target onto another element (to), e.g. a card onto a column. Records as dragTo.
        dragTo: async (command) => {
            await locate(command).dragTo(locatorFor(session.page(), text(command, 'to')), { timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        // The answer for the next native dialog (alert, confirm, prompt, beforeunload). Unarmed, a dialog is dismissed and the
        // command that opened it reports it, so Claude can arm and repeat. The decision is recorded on the action that opens it.
        dialog: (command) => {
            if (!['accept', 'dismiss'].includes(command.decision)) throw usage(t('run.agent.dialogDecision'));
            if (command.value !== undefined && (typeof command.value !== 'string' || command.decision !== 'accept')) throw usage(t('run.agent.dialogValue'));
            session.dialogs?.arm({ accept: command.decision === 'accept', ...(command.value === undefined ? {} : { value: command.value }) });
            return 'armed';
        },
        // Two clicks as one gesture, e.g. a grid row that opens on double-click: two separate click commands lie seconds apart,
        // so the browser never fires a dblclick for them.
        dblclick: async (command) => {
            await leaveForDisabled(locate(command));
            await locate(command).dblclick({ timeout: ACTION_TIMEOUT_MS, delay: CLICK_DELAY_MS });
            return 'ok';
        },
        // Empty is allowed: it clears a field regardless of its content. Clicking a clear button fails when the field is empty.
        fill: async (command) => {
            if (typeof command.value !== 'string') throw usage(t('run.agent.missing', { field: 'value' }));
            await leaveForDisabled(locate(command));
            await fillField(locate(command), command.value, { timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        type: async (command) => {
            await leaveForDisabled(locate(command));
            await locate(command).pressSequentially(text(command, 'value'), { timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        press: async (command) => { await session.page().keyboard.press(text(command, 'key')); return 'ok'; },
        eval: (command) => session.page().evaluate(text(command, 'code')),
        // A repeatable check. Only exactly true passes, not any truthy value.
        check: async (command) => {
            const id = text(command, 'id');
            if (!run.expectations.some((expectation) => expectation.id === id)) throw new CawError('step-unknown', t('run.agent.unknownStep', { id }));
            const value = await session.page().evaluate(text(command, 'code'));
            await session.workbench?.step(id, value === true ? 'pass' : 'running');
            return { id, pass: value === true, value };
        },
        // A value that only the run produces. The recording stores the expression instead of the value.
        remember: async (command) => {
            const name = text(command, 'name');
            if (!REMEMBER_NAME.test(name) || name === 'runTag' || name === 'runTagLower') throw usage(t('run.agent.rememberName'));
            const raw = await session.page().evaluate(text(command, 'code'));
            const value = typeof raw === 'number' ? String(raw) : raw;
            if (typeof value !== 'string' || value.trim().length < REMEMBER_MIN_LENGTH) throw usage(t('run.agent.rememberValue', { name, min: REMEMBER_MIN_LENGTH, raw: JSON.stringify(raw) }));
            return { name, value: value.trim() };
        },
        screenshot: async (command) => {
            const name = text(command, 'name');
            if (!SCREENSHOT_NAME.test(name)) throw usage(t('run.agent.screenshotName'));
            const image = await session.page().screenshot();
            // Create, never overwrite: the folder belongs to the container.
            writeFileSync(join(agentDir, name), image, { flag: 'wx' });
            screenshots.add(name);
            return name;
        },
        goto: async (command) => {
            const url = text(command, 'url');
            if (!isAllowedUrl(url, hosts)) throw new CawError('host-blocked', t('run.agent.hostBlocked', { host: hostNameOf(url), url }));
            await session.page().goto(url);
            return session.page().url();
        },
        reload: async () => { await session.page().reload(); return session.page().url(); },
        'wait-ready': (command) => session.waitReady({
            ...(typeof command.for === 'string' ? { store: command.for } : {}),
            ...(Number.isFinite(command.minCount) ? { minCount: command.minCount } : {}),
            ...(Number.isFinite(command.timeout) ? { timeout: command.timeout } : {}),
        }),
        console: () => session.drainFailures(),
        // The application's latest requests with outcome and duration, without parameter values: evidence whether the app is at fault.
        network: () => (session.network === undefined ? [] : session.network.since(Math.max(0, session.network.mark() - NETWORK_SHOWN))),
        finish: (command) => {
            if (typeof command.results !== 'object' || command.results === null) throw new CawError('finish-rejected', t('run.agent.resultMissing'));
            const outcome = evaluateFinish({
                expectations: run.expectations,
                results: command.results,
                failures: session.failures(),
                // Only what the tool captured itself counts as a screenshot.
                fileExists: (name) => screenshots.has(name),
            });
            finished = true;
            onVerdict(outcome);
            return { status: outcome.status };
        },
    };

    // Commands whose answer can contain page text; the others only return ok, a URL or a file name.
    const PAGE_TEXT = new Set(['snapshot', 'eval', 'check', 'remember', 'console']);
    // No password reaches Claude: neither via the snapshot (it contains field values) nor via eval, check or remember.
    const hideSecrets = async (value) => {
        const onPage = await (async () => session.page().evaluate(passwordValues))().catch(() => []);
        const secrets = [...(session.secrets?.() ?? []), ...(Array.isArray(onPage) ? onPage : [])];
        return secrets.length === 0 ? value : redactDeep(value, secrets);
    };

    // Where a placeholder is filled: only in a fill/type value. Never in code (check, eval, remember) and never in a URL: code
    // runs in the page and can leave the value there (a global, the title, a request), where the next eval reads it transformed
    // (split, encoded) past redactDeep. Code with a secret placeholder is refused, so Claude learns why instead of a silent miss.
    const expanded = (key, value) => {
        if ((key !== 'value' && key !== 'code') || typeof value !== 'string') return value;
        // A dialog value is typed into the page like a fill value.
        const filled = expand(value);
        if (filled !== value && key === 'code') throw usage(t('run.agent.secretInCode'));
        return filled;
    };
    const handle = async (given, { reveal = false } = {}) => {
        if (finished) throw new CawError('run-finished', t('run.agent.finished'));
        const command = typeof given === 'object' && given !== null
            ? Object.fromEntries(Object.entries(given).map(([key, value]) => [key, expanded(key, value)]))
            : given;
        if (typeof command !== 'object' || command === null || !Object.hasOwn(commands, command.action)) {
            throw new CawError('unknown-command', t('run.agent.unknownCommand', { action: String(command?.action) }));
        }
        let timer;
        const limit = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new CawError('command-timeout', t('run.agent.timeout', { action: command.action }))), commandTimeoutMs);
        });
        try {
            const result = await Promise.race([commands[command.action](command), limit]);
            return PAGE_TEXT.has(command.action) && !reveal ? await hideSecrets(result) : result;
        } finally {
            clearTimeout(timer);
        }
    };
    const handler = (command) => handle(command);
    // Host only (replay): a secret remember value unredacted. Otherwise a retry of the step would read the value hidden on the
    // first attempt as ••••. Claude only reaches `handler` itself, never this property.
    handler.reveal = (command) => handle(command, { reveal: true });
    return handler;
};
