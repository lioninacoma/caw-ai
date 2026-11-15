// The human demonstrates in the visible Chrome, the tool records. Steps use the recorder format: the page marks the element a
// pointer or key went to, the host turns the mark into the same locator a step of Claude's gets (recordLocator). Passwords never
// leave the page.

import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { dialogMessage } from './dialogs.mjs';
import { isWorkbenchDocument } from './app-view.mjs';
import { redactDeep } from './secrets.mjs';
import { elementHint, frameworkOf } from './framework/index.mjs';
import { locatorLabel } from './locator.mjs';
import { webPick } from './accessible-name.mjs';
import { extjsCandidates, extjsMatches } from '../ext/extjs/extjs-query.mjs';
import { MARK_ATTRIBUTE, recordLocator, roleAndName } from './record-locator.mjs';
import { HASH_LIMIT_BYTES, matchFixture } from './fixtures.mjs';

const BINDING = '__cawCapture';
const SETTLE_MS = 300;
// If the page loads with no click or key press within this time before it, the human typed the address themselves.
const OWN_NAVIGATION_MS = 3000;
// How often to check for new application failures during a demonstration.
const FAILURE_POLL_MS = 500;
const NOT_TYPED = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'hidden']);
// How long the host may take to read a mark; then the page removes it itself.
const MARK_MS = 10_000;
const HINT_TIMEOUT_MS = 2000;

/**
 * Runs in the browser. Capture phase, on pointerdown and keydown: the element is marked before the application reacts to it
 * (a click often removes what was clicked). The host turns the mark into a locator and removes it again. A click also sends
 * the element's role and name as they are before the application reacts (nameOf: roleAndName from accessible-name.mjs), and
 * a locator chain that is unique right now (pick: pickAtPointerdown; ExtJS components, else role and name), while a list or
 * dialog is still open.
 * A field counts as typed only after trusted input: a value the application sets itself (a combobox taking the entry clicked in
 * its list) is no fill. Files chosen for a file field are reported by name, size and SHA-256 (up to hashLimit bytes), never
 * their content: the host only records files that come from caw/fixtures.
 */
export function captureInPage(binding, notTyped, markAttribute, markMs, nameOf, pick, hashLimit) {
    if (window.__cawCaptureOn) return;
    window.__cawCaptureOn = true;
    // The workbench marks itself only after this script runs (tab script vs. this context script): so check here, not at start.
    const send = (event) => { if (window.__cawWorkbench !== true) window[binding]?.({ ...event, path: location.pathname }); };
    let next = 0;
    const mark = (element) => {
        const value = `${Date.now().toString(36)}-${next += 1}`;
        element.setAttribute(markAttribute, value);
        setTimeout(() => { if (element.getAttribute(markAttribute) === value) element.removeAttribute(markAttribute); }, markMs);
        return value;
    };
    // The control the pointer went to, e.g. the button around an icon; across open shadow roots.
    const CONTROL = 'button, a[href], input, select, textarea, summary, [data-testid], [role]';
    const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
    const controlOf = (start) => {
        for (let current = start; current !== null; current = parentOf(current)) if (current.matches?.(CONTROL)) return current;
        return start;
    };
    const isField = (element) => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !notTyped.includes(element.type);
    const flush = (element) => {
        if (!isField(element) || element.cawTyped !== true || element.cawValue === element.value) return;
        element.cawValue = element.value;
        element.cawTyped = false;
        if (element.type === 'password') send({ action: 'fill', secret: true, mark: mark(element) });
        else send({ action: 'fill', mark: mark(element), value: element.value });
    };
    addEventListener('focusin', ({ target }) => {
        if (isField(target) && target.cawValue === undefined) target.cawValue = target.value;
    }, true);
    addEventListener('input', ({ isTrusted, target }) => { if (isTrusted && isField(target)) target.cawTyped = true; }, true);
    const describeFiles = (input) => Promise.all([...(input.files ?? [])].map(async (file) => {
        let sha256;
        try {
            // eslint-disable-next-line n/no-unsupported-features/node-builtins -- runs in the browser, not in Node
            const subtle = window.crypto?.subtle;
            if (file.size <= hashLimit && subtle) {
                const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
                sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
            }
        } catch { /* compared by name and size only */ }
        return { name: file.name, size: file.size, ...(sha256 === undefined ? {} : { sha256 }) };
    }));
    addEventListener('change', ({ isTrusted, target }) => {
        if (window.__cawPicking) return;
        if (isTrusted && target instanceof HTMLInputElement && target.type === 'file') {
            const marked = mark(target);
            describeFiles(target).then((files) => send({ action: 'upload', mark: marked, files }));
            return;
        }
        // A choice in a <select>: fill picks the option by its value, as replay does.
        if (isTrusted && target instanceof HTMLSelectElement && !target.multiple) send({ action: 'fill', mark: mark(target), value: target.value });
        else flush(target);
    }, true);
    // Arrow keys choose in a combobox, list, grid, tab bar or radio group; the application then sets the value itself, so no
    // fill would tell it. Not in a <select>: its choice already becomes a fill.
    const ARROWS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'];
    addEventListener('keydown', ({ isTrusted, key, target }) => {
        if (!isTrusted || window.__cawPicking) return;
        if (!['Enter', 'Tab', 'Escape'].includes(key) && !(ARROWS.includes(key) && !(target instanceof HTMLSelectElement))) return;
        flush(target);
        send({ action: 'press', key });
    }, true);
    addEventListener('pointerdown', (event) => {
        const [target] = event.composedPath();
        if (!event.isTrusted || window.__cawPicking || event.button !== 0 || !(target instanceof Element)) return;
        flush(document.activeElement);
        const control = controlOf(target);
        let seen = null;
        try { seen = nameOf(control); } catch { /* the locator is then built from the element as it is afterwards */ }
        let proposal = null;
        try { proposal = typeof pick === 'function' ? pick(control) : null; } catch { /* no component chain */ }
        send({ action: 'click', mark: mark(control), seen, proposal, hint: target.tagName.toLowerCase() });
    }, true);
    // The browser's own double-click after two clicks: the host turns those two clicks into one dblclick.
    addEventListener('dblclick', (event) => {
        if (event.isTrusted && !window.__cawPicking && event.button === 0) send({ action: 'dblclick' });
    }, true);
}

/**
 * Files chosen in the page (the page reports name, size, SHA-256): recorded as an upload only if every one comes from
 * caw/fixtures. The click that opened the file chooser just before becomes the upload, so replay clicks it and hands the
 * chooser the files; without such a click the file field itself is the target. Files from elsewhere are named, not recorded.
 * @returns { item, replaced } (replaced: the click before became this item in items) or null if no file was chosen
 */
export const uploadItem = (items, event, filesDir) => {
    const chosen = Array.isArray(event.files) ? event.files.filter((file) => typeof file?.name === 'string').slice(0, 20) : [];
    if (chosen.length === 0) return null;
    const files = chosen.map((file) => (filesDir === undefined ? null : matchFixture(filesDir, file)));
    if (files.includes(null)) return { item: { action: 'upload', target: null, files: [], outside: chosen.filter((_file, index) => files[index] === null).map(({ name }) => name), path: event.path }, replaced: false };
    const actions = items.map((item, index) => [item, index]).filter(([item]) => item.action !== 'failure');
    const [last, at] = actions.at(-1) ?? [];
    if (last?.action === 'click' && last.target !== null) {
        const item = { ...last, action: 'upload', files };
        items.splice(at, 1, item);
        return { item, replaced: true };
    }
    return { item: { ...event, files }, replaced: false };
};

/**
 * A dblclick event from the page ends the two clicks just before it: they become one dblclick on the first click's target (read
 * before the application reacted). An application failure noted in between stays where it is. Without two clicks right before
 * it, nothing changes.
 * @returns the dblclick item, which replaced the clicks in `items`, or null
 */
export const mergeDoubleClick = (items) => {
    const actions = items.map((item, index) => [item, index]).filter(([item]) => item.action !== 'failure').slice(-2);
    if (actions.length < 2 || actions.some(([item]) => item.action !== 'click')) return null;
    const [[first, at], [second, secondAt]] = actions;
    const merged = { ...first, action: 'dblclick', target: first.target ?? second.target };
    items.splice(secondAt, 1);
    items.splice(at, 1, merged);
    return merged;
};

/**
 * Runs in the browser. The next click picks an element instead of triggering anything: it stops at window and reaches
 * neither the application nor the recording. Escape cancels.
 */
export function pickInPage(markAttribute) {
    return new Promise((resolve) => {
        const mark = document.createElement('div');
        mark.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;display:none';
        document.documentElement.append(mark);
        const swallowed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu'];
        const swallow = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const move = ({ target }) => {
            if (!(target instanceof Element)) return;
            const { left, top, width, height } = target.getBoundingClientRect();
            mark.style.cssText += `;display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
        };
        const CONTROL = 'button, a[href], input, select, textarea, summary, [data-testid], [role]';
        const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
        const controlOf = (start) => {
            for (let current = start; current !== null; current = parentOf(current)) if (current.matches?.(CONTROL)) return current;
            return start;
        };
        const click = (event) => {
            if (!event.isTrusted) return;
            swallow(event);
            const [target] = event.composedPath();
            if (!(target instanceof Element)) return;
            const control = controlOf(target);
            // The host turns the mark into a locator and removes it.
            const value = `pick-${Date.now().toString(36)}`;
            control.setAttribute(markAttribute, value);
            done({ mark: value, tag: target.tagName.toLowerCase(), text: (target.innerText ?? target.value ?? '').trim().slice(0, 120) });
        };
        const key = (event) => {
            if (event.key !== 'Escape' || !event.isTrusted) return;
            swallow(event);
            done(null);
        };
        const done = (value) => {
            swallowed.forEach((name) => removeEventListener(name, swallow, true));
            removeEventListener('click', click, true);
            removeEventListener('keydown', key, true);
            removeEventListener('mousemove', move, true);
            mark.remove();
            window.__cawPicking = false;
            window.__cawCancelPick = undefined;
            resolve(value);
        };
        window.__cawPicking = true;
        window.__cawCancelPick = () => done(null);
        swallowed.forEach((name) => addEventListener(name, swallow, true));
        addEventListener('click', click, true);
        addEventListener('keydown', key, true);
        addEventListener('mousemove', move, true);
    });
}

/**
 * The application's main frame for an element in `frame`: with the workbench the frame in its iframe, otherwise the main frame of
 * the page the event came from. Not session.page(): that is the most recently opened window, and a click in the first tab with
 * an open popup belongs there.
 */
const appFrameOf = (session, frame) => {
    const page = frame.page();
    return session.workbench?.page === page ? session.workbench.view.frame : page.mainFrame();
};

/**
 * The locator for the element the page marked, relative to the application's main frame, frames included: { target } with null
 * if there is no stable one, plus the framework's component hint if any. The mark is removed again.
 */
export const markedTarget = async (session, frame, mark, seen = null, proposal = null) => {
    const framework = session.framework ?? frameworkOf();
    const locator = frame.locator(`[${MARK_ATTRIBUTE}="${String(mark).replace(/["\\]/g, '')}"]`);
    try {
        const target = await recordLocator(appFrameOf(session, frame), locator, { framework: framework.name, timeout: HINT_TIMEOUT_MS, seen, proposal });
        if (target === null || framework.hint === undefined) return { target };
        const element = await locator.elementHandle({ timeout: HINT_TIMEOUT_MS }).catch(() => null);
        const hint = element === null ? null : await elementHint(framework, element);
        await element?.dispose().catch(() => {});
        return { target, ...(hint ?? {}) };
    } catch {
        return { target: null };
    } finally {
        await locator.evaluate((node, name) => node.removeAttribute(name), MARK_ATTRIBUTE, { timeout: HINT_TIMEOUT_MS }).catch(() => {});
    }
};

/** In every frame, because forms are sometimes inside iframes. The first click wins, the other frames cancel. */
export const cancelPick = (session) => Promise.all(session.page().frames().map((frame) => frame.evaluate('window.__cawCancelPick?.()').catch(() => {})));

export const pickElement = async (session) => {
    const script = `(${pickInPage})(${JSON.stringify(MARK_ATTRIBUTE)})`;
    const picked = await new Promise((resolve) => {
        const frames = session.page().frames();
        let open = frames.length;
        for (const frame of frames) {
            frame.evaluate(script).catch(() => null).then((value) => {
                open -= 1;
                if (value !== null && value !== undefined) resolve({ value, frame });
                else if (open === 0) resolve(null);
            });
        }
    }).then(async (hit) => {
        if (hit === null) return null;
        const { mark, ...rest } = hit.value;
        return { ...rest, ...await markedTarget(session, hit.frame, mark) };
    });
    await cancelPick(session);
    if (picked === null) return null;
    const label = picked.target === null ? `${picked.tag}${picked.text === '' ? '' : ` "${picked.text.slice(0, 40)}"`}` : locatorLabel(picked.target);
    return { label, ...picked };
};

// In the page at the pointerdown: the first ExtJS chain that finds exactly the element right now.
// Otherwise, for any framework, role and name if exactly this element has them right now (webPick).
const pickAtPointerdown = `(element) => { const found = (${extjsCandidates})(element); for (const chain of found.chains) if ((${extjsMatches})(element, chain)) return chain; return (${webPick})(element, ${roleAndName}); }`;

/** A chain the page sent, checked for shape: only known links with string values; anything else is dropped. */
const chainOf = (value) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
    const known = (link) => link !== null && typeof link === 'object' && Object.values(link).every((part) => typeof part === 'string')
        && ((Object.keys(link).length === 1 && ['extjs', 'text', 'exact', 'has', 'css'].includes(Object.keys(link)[0]))
            || (Object.keys(link).length === 1 && ['dialog', 'alertdialog'].includes(link.role))
            || (Object.keys(link).length === 2 && typeof link.role === 'string' && typeof link.name === 'string'));
    return value.every(known) ? value : null;
};
// Never in the workbench itself: there the human types into the chat, which is not an application step.
const captureScript = () => `if (!(${isWorkbenchDocument}) && location.href !== 'about:srcdoc') (${captureInPage})(${JSON.stringify(BINDING)}, ${JSON.stringify([...NOT_TYPED])}, ${JSON.stringify(MARK_ATTRIBUTE)}, ${MARK_MS}, ${roleAndName}, ${pickAtPointerdown}, ${HASH_LIMIT_BYTES});`;

// During the run the folder also belongs to the container: a link inside it, e.g. e1.png -> ~/.bashrc, must not make the host
// write elsewhere. So never follow a link: lstat instead of exists, and only create new files ('wx'), never overwrite.
const taken = (path) => {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
};
/** Writes an own file from scratch. Whatever is there (including a link) is removed, not followed. */
const writeOwn = (path, data) => {
    if (taken(path)) rmSync(path, { force: true });
    writeFileSync(path, data, { flag: 'wx' });
};

/** Several checkpoints in the same run: earlier images are kept. */
const freeScreenshot = (dir) => {
    let number = 1;
    while (taken(join(dir, `point-${number}.png`))) number += 1;
    return `point-${number}.png`;
};

/** How the frame's document came about: 'reload', 'navigate', 'back_forward', or null if it cannot be determined. */
export const navigationType = async (frame) => {
    if (frame === undefined || frame === null) return null;
    try {
        await frame.waitForLoadState('domcontentloaded');
        return await frame.evaluate(() => performance.getEntriesByType('navigation')[0]?.type ?? null);
    } catch {
        return null;
    }
};

/** Once per browser: binding and script survive navigation; recording only happens on request. */
const captures = new WeakMap();
const captureOf = async (session) => {
    const known = captures.get(session.context);
    if (known !== undefined) return known;
    const state = { listener: null, queue: Promise.resolve() };
    captures.set(session.context, state);
    // Only frames of the application count; in the workbench the chat sees the binding too.
    const owns = ({ page, frame }) => (session.ownsFrame === undefined ? session.ownsPage(page) : session.ownsFrame(frame));
    // A mark is turned into a locator right away, while the element still exists; the queue keeps the events in order.
    await session.context.exposeBinding(BINDING, (source, event) => {
        if (state.listener === null || !owns(source)) return;
        const { mark, seen, proposal, ...rest } = event ?? {};
        const valid = typeof seen?.role === 'string' && typeof seen?.name === 'string' ? { role: seen.role, name: seen.name } : null;
        const resolving = mark === undefined ? Promise.resolve(null) : markedTarget(session, source.frame, mark, valid, chainOf(proposal));
        state.queue = state.queue.then(async () => {
            const found = await resolving;
            state.listener?.(hideSecrets(session, found === null ? rest : { ...rest, ...found }));
        }).catch(() => {});
    });
    const script = captureScript();
    await session.context.addInitScript({ content: script });
    // In every frame, not just the main frame: with the workbench the main frame is the workbench, the application already runs in the iframe.
    await Promise.all(session.context.pages().flatMap((page) => page.frames()).map((frame) => frame.evaluate(script).catch(() => {})));
    // A navigation of the application: its main frame, with the workbench the frame in the iframe.
    const isAppMain = (page, frame) => {
        const app = session.workbench?.page === page ? session.workbench.view.frame : page.mainFrame();
        return frame === app;
    };
    // Through the same queue as the actions: otherwise the navigation caused by a click in the iframe would arrive before the click
    // whose target is still being resolved, and count as a navigation of its own.
    const watchNavigation = (page) => page.on('framenavigated', (frame) => {
        if (!isAppMain(page, frame) || state.listener === null || !owns({ page, frame })) return;
        const url = frame.url();
        state.queue = state.queue.then(() => state.navigated?.(url, frame)).catch(() => {});
    });
    session.context.on('page', watchNavigation);
    session.context.pages().forEach(watchNavigation);
    return state;
};

const aboutOf = (item) => (item.element === undefined ? '' : t('run.item.about', { label: item.element.label }));
const unstable = (item) => t('run.item.unstable', { hint: item.hint ?? t('run.item.field') });

export const itemLabel = (item) => {
    switch (item.action) {
        case 'checkpoint': return t('run.item.checkpoint', { about: aboutOf(item), text: item.text });
        case 'note': return t('run.item.note', { about: aboutOf(item), text: item.text });
        case 'press': return `press ${item.key}`;
        case 'upload': return item.outside !== undefined ? t('run.item.uploadOutside', { names: item.outside.join(', ') }) : `upload ${item.target === null ? unstable(item) : locatorLabel(item.target)} ${item.files.join(', ')}`;
        case 'navigated': return t('run.item.navigated', { url: item.url });
        case 'reloaded': return t('run.item.reloaded', { url: item.url });
        case 'failure': return t('run.item.failure', { type: item.type, text: item.text, url: item.url === undefined ? '' : ` (${item.url})` });
        default: return `${item.action} ${item.target === null ? unstable(item) : locatorLabel(item.target)}`;
    }
};

const VERBS = ['click', 'dblclick', 'fill', 'select', 'check', 'uncheck', 'press'];
const verbOf = (action) => (VERBS.includes(action) ? t(`run.verb.${action}`) : action);
/**
 * What the human should see while demonstrating: actions and navigations. Checkpoints, notes and failures are already shown by
 * the chat itself. @returns the line or null
 */
export const feedLabel = (item) => {
    if (['checkpoint', 'note', 'failure'].includes(item.action)) return null;
    if (item.action === 'navigated' || item.action === 'reloaded') return itemLabel(item);
    if (item.secret) return t('run.item.secret', { verb: verbOf(item.action) });
    const verb = verbOf(item.action);
    if (item.action === 'press') return `${verb} ${item.key}`;
    if (item.action === 'upload') return itemLabel(item);
    return `${verb} ${item.target === null ? unstable(item) : locatorLabel(item.target)}`;
};

/** Demonstrated actions that can open a native dialog. */
const OPENS_DIALOG = new Set(['click', 'dblclick', 'fill', 'type', 'upload', 'download', 'press', 'reloaded']);

/**
 * Records until the human is done: a line with { checkpoint } is a checkpoint at this point, { note } is context,
 * an empty line ends it, and so does closing the window.
 * @param operator { nextLine({ page }) } returns the next line, { note } for a note or { checkpoint }, both optionally with element
 * @param onItem   receives every recorded item, e.g. for the chat
 * @param dir      folder for the checkpoint screenshots
 * @param filesDir the project's caw folder: a file chosen for upload is recorded only if it comes from its fixtures folder
 * @param onDialog (info) => Promise<{ accept, value? } | null>: the human's answer to a native dialog of the app (chat)
 * @returns the steps and checkpoints in order
 */
export const demonstrate = async ({ session, operator, ui, dir, filesDir, now = Date.now, onFailure, onItem, onDialog, pollMs = FAILURE_POLL_MS }) => {
    const state = await captureOf(session);
    const items = [];
    let pendingDialog = null;
    const placeDialog = (item) => {
        if (pendingDialog === null || !OPENS_DIALOG.has(item?.action) || item.dialog !== undefined) return;
        item.dialog = pendingDialog;
        pendingDialog = null;
    };
    // A native dialog waits for the human's answer in the chat; the answer goes on the action that opened it (Q11).
    if (onDialog !== undefined) {
        session.dialogs?.asking(async (info) => {
            const answer = await onDialog(info);
            if (answer !== null) {
                const accept = info.type === 'alert' ? true : answer.accept === true;
                const value = info.type === 'prompt' && accept ? answer.value ?? info.defaultValue : undefined;
                // The page is blocked while its dialog is open, so the action that opened it is usually recorded only afterwards:
                // the decision waits for it. At the end it goes on the last action instead.
                pendingDialog = { type: info.type, accept, ...(value === undefined ? {} : { value }), ...(info.message === '' ? {} : { message: dialogMessage(info.message) }) };
            }
            return answer;
        });
    }
    // Application failures (console, script, network) are detected during the demonstration: they appear in place in the
    // recording, the human sees them right away, and failures and network log also land as evidence in the demonstration folder.
    const failuresAt = session.failures?.().length ?? 0;
    const networkAt = session.network?.mark() ?? 0;
    let failuresSeen = failuresAt;
    const watchFailures = () => {
        const all = session.failures?.() ?? [];
        for (const failure of all.slice(failuresSeen)) {
            const item = { action: 'failure', type: failure.type, text: String(failure.text ?? '').slice(0, 500), ...(failure.url === undefined ? {} : { url: failure.url }), ...(failure.at === undefined ? {} : { at: failure.at }) };
            items.push(item);
            ui.step({ number: items.length, total: items.length, label: itemLabel(item), elapsed: 0 });
            onFailure?.(item);
        }
        failuresSeen = all.length;
    };
    const failureTimer = setInterval(watchFailures, pollMs);
    let lastAction = now();
    const push = (item) => {
        placeDialog(item);
        items.push(item);
        ui.step({ number: items.length, total: items.length, label: itemLabel(item), elapsed: 0 });
        onItem?.(item);
    };
    state.listener = (event) => {
        lastAction = now();
        if (event.action === 'upload') {
            const upload = uploadItem(items, event, filesDir);
            if (upload === null) return;
            if (!upload.replaced) {
                push(upload.item);
                return;
            }
            // The click that opened the file chooser was already shown; the upload that replaces it follows as its own line.
            ui.step({ number: items.length, total: items.length, label: itemLabel(upload.item), elapsed: 0 });
            onItem?.(upload.item);
            return;
        }
        if (event.action !== 'dblclick') {
            push(event);
            return;
        }
        // The two clicks were already shown; the double-click that replaces them follows as its own line.
        const merged = mergeDoubleClick(items);
        if (merged === null) return;
        ui.step({ number: items.length, total: items.length, label: itemLabel(merged), elapsed: 0 });
        onItem?.(merged);
    };
    let lastUrl = (() => {
        try {
            return session.page().url();
        } catch {
            return null;
        }
    })();
    state.navigated = (url, frame) => {
        const { pathname, hash } = new URL(url);
        // Same address again: the human only reloaded if the browser reports it that way (F5, refresh button).
        // A form submitted to the same address is a normal navigation of the click before it.
        if (url === lastUrl) {
            lastAction = now();
            navigationType(frame).then((type) => {
                if (type === 'reload' && state.listener !== null) push({ action: 'reloaded', url: `${pathname}${hash}`, path: pathname });
            });
            return;
        }
        lastUrl = url;
        if (now() - lastAction <= OWN_NAVIGATION_MS) return;
        lastAction = now();
        // Only a note: whether the human typed the address or a slow click changed the page cannot be told apart. A fixed goto with
        // this run's hash (e.g. an order number) would hit the wrong state on replay.
        push({ action: 'navigated', url: `${pathname}${hash}`, path: pathname });
    };
    let interrupt;
    const interrupted = new Promise((ok) => { interrupt = ok; });
    process.once('SIGINT', interrupt);
    const input = new AbortController();
    // The human may reload the page during the demonstration; what that means for the path is noted in the recording.
    session.workbench?.onRefresh?.(() => session.reloadPage());
    try {
        for (;;) {
            const line = await Promise.race([
                operator.nextLine({ page: session.page(), signal: input.signal }),
                session.closed.then(() => null),
                interrupted.then(() => { throw new CawError('aborted', t('run.demo.aborted')); }),
            ]);
            // First whatever still waits for its frame: a checkpoint belongs after the click before it.
            await state.queue;
            if (line?.note !== undefined) {
                push({ action: 'note', text: line.note, path: new URL(session.page().url()).pathname, ...(line.element === undefined ? {} : { element: line.element }) });
                continue;
            }
            const shown = typeof line === 'string' ? line : line?.checkpoint;
            if (shown === undefined || shown === null || shown.trim() === '') break;
            const screenshot = freeScreenshot(dir);
            const image = await session.page().screenshot().catch(() => null);
            const saved = image !== null && (() => {
                try {
                    writeFileSync(join(dir, screenshot), image, { flag: 'wx' });
                    return true;
                } catch {
                    return false;
                }
            })();
            push({ action: 'checkpoint', text: shown.trim(), path: new URL(session.page().url()).pathname, ...(saved ? { screenshot } : {}), ...(line?.element === undefined ? {} : { element: line.element }) });
        }
        // What happened just before Enter may still be in flight.
        await new Promise((ok) => { setTimeout(ok, SETTLE_MS); });
        // Events whose frame is still being resolved belong to the recording; only detach afterwards.
        await state.queue;
        watchFailures();
        if (pendingDialog !== null) placeDialog(items.findLast((item) => OPENS_DIALOG.has(item.action)));
        return items;
    } finally {
        clearInterval(failureTimer);
        // Evidence independent of the trace, which may be incomplete after an abrupt end.
        if (dir !== undefined) {
            try {
                writeOwn(join(dir, 'failures.json'), JSON.stringify((session.failures?.() ?? []).slice(failuresAt), null, 2));
                if (session.network !== undefined) writeOwn(join(dir, 'network.json'), JSON.stringify(session.network.since(networkAt), null, 2));
            } catch {
                // Evidence is a bonus; the demonstration itself is what counts.
            }
        }
        // Otherwise a pending input read would continue and get in the way of the next one.
        input.abort();
        session.workbench?.onRefresh?.(null);
        session.dialogs?.asking(null);
        process.removeListener('SIGINT', interrupt);
        state.listener = null;
        state.navigated = null;
    }
};

/**
 * What the human types is seen by Claude and stored in the recording. A role password or secret remembered value in a field that
 * is not a password field ("show password", re-authentication dialog) is treated like one: as a secret input without a value.
 */
export const hideSecrets = (session, event) => {
    const secrets = (session.secrets?.() ?? []).filter((secret) => typeof secret === 'string' && secret !== '');
    if (secrets.length === 0 || event === null || typeof event !== 'object') return event;
    if (event.action === 'fill' && typeof event.value === 'string' && secrets.some((secret) => event.value.includes(secret))) {
        const rest = { ...event, secret: true };
        delete rest.value;
        return redactDeep(rest, secrets);
    }
    return redactDeep(event, secrets);
};

/** Separates what can be replayed directly from what only the human could do. */
export const recordableSteps = (items) => {
    const steps = [];
    const problems = [];
    for (const item of items) {
        if (['checkpoint', 'note', 'navigated', 'reloaded', 'failure'].includes(item.action)) continue;
        if (item.secret) problems.push(t('run.demo.secret'));
        else if (item.outside !== undefined) problems.push(itemLabel(item));
        else if (item.target === null) problems.push(t('run.demo.unstable', { item: itemLabel(item) }));
        else {
            const step = { ...item };
            delete step.hint;
            steps.push(step);
        }
    }
    return { steps, problems };
};

