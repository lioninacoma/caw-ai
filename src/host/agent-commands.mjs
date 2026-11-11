// The complete list of what the agent may do in the browser. It never gets CDP, since that would allow bypassing
// the host block (e.g. a new browser context with its own proxy).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { evaluateFinish } from '../shared/report.mjs';
import { passwordValues, redactDeep } from './secrets.mjs';

const ACTION_TIMEOUT_MS = 15_000;
const NETWORK_SHOWN = 60;
// Press and release like a human: some UIs react to the press with a delay.
export const CLICK_DELAY_MS = 100;
const COMMAND_TIMEOUT_MS = 300_000;
const SCREENSHOT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$/;
const ARIA_REF = /^(f\d+)?e\d+$/;
const REMEMBER_NAME = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
// Short values would also occur in unrelated text and be replaced there too.
const REMEMBER_MIN_LENGTH = 4;

const usage = (message) => new CawError('usage', message);

const text = (command, field) => {
    const value = command[field];
    if (typeof value !== 'string' || value === '') throw usage(t('run.agent.missing', { field }));
    return value;
};

/** Navigation only to the hosts the Chrome block also lets through. */
export const isAllowedUrl = (url, hosts) => {
    try {
        const { protocol, hostname } = new URL(url);
        return ['http:', 'https:'].includes(protocol) && hosts.includes(hostname);
    } catch {
        return false;
    }
};

/**
 * A value for inside a string literal in code, whichever quotes surround it: ' " ` and ${ cannot end the literal or start an
 * expression, line breaks cannot break the line. For filling remembered values into a check's or remember's code (O'Brien).
 */
export const codeText = (value) => String(value).replace(/[\\'"`$]/g, '\\$&').replaceAll('\n', '\\n').replaceAll('\r', '\\r')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/** A reference from the snapshot, or a CSS selector. */
export const locatorFor = (page, target) => page.locator(ARIA_REF.test(target) ? `aria-ref=${target}` : target);

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

// How long an optional click waits for its target.
const OPTIONAL_WAIT_MS = 3000;
// These commands move focus into the application.
const FOCUSING = new Set(['click', 'fill', 'type', 'press', 'upload', 'download']);

/**
 * @param expand optional: fills placeholders of secret remembered values ({{iban}}) into fill/type values; code with one is refused.
 *   Claude never sees them in plain text and works with the placeholder; only the host fills it in.
 */
export const createAgentHandler = ({ session, run, hosts, agentDir, onVerdict, expand = (value) => value, commandTimeoutMs = COMMAND_TIMEOUT_MS }) => {
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
            await locate(command).click({ timeout: ACTION_TIMEOUT_MS, delay: CLICK_DELAY_MS });
            return 'ok';
        },
        // Empty is allowed: it clears a field regardless of its content. Clicking a clear button fails when the field is empty.
        fill: async (command) => {
            if (typeof command.value !== 'string') throw usage(t('run.agent.missing', { field: 'value' }));
            await fillField(locate(command), command.value, { timeout: ACTION_TIMEOUT_MS });
            return 'ok';
        },
        type: async (command) => { await locate(command).pressSequentially(text(command, 'value'), { timeout: ACTION_TIMEOUT_MS }); return 'ok'; },
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
            if (!isAllowedUrl(url, hosts)) throw new CawError('target-denied', t('run.agent.targetDenied', { url }));
            await session.page().goto(url);
            return session.page().url();
        },
        reload: async () => { await session.page().reload(); return session.page().url(); },
        'wait-ready': (command) => session.waitReady({
            ...(typeof command.store === 'string' ? { store: command.store } : {}),
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
            // Actions that focus the application hand focus back to the chat if the human is typing there.
            const view = session.page?.();
            const act = () => commands[command.action](command);
            const work = FOCUSING.has(command.action) && typeof view?.keepChatFocus === 'function' ? view.keepChatFocus(act) : act();
            const result = await Promise.race([work, limit]);
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
