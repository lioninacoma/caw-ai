// The human demonstrates in the visible Chrome, the tool records. Steps use the recorder format, because targets are described
// by the same function as for the agent. Passwords never leave the page.

import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { isWorkbenchDocument } from './app-view.mjs';
import { redactDeep } from './secrets.mjs';
import { frameTargetOf, frameworkOf, targetLabel } from './framework/index.mjs';

const BINDING = '__cawCapture';
const SETTLE_MS = 300;
// If the page loads with no click or key press within this time before it, the human typed the address themselves.
const OWN_NAVIGATION_MS = 3000;
// How often to check for new application failures during a demonstration.
const FAILURE_POLL_MS = 500;
const NOT_TYPED = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'hidden']);

/** Runs in the browser. Capture phase: the target must be described before the application reacts to it. */
export function captureInPage(binding, describeTarget, notTyped) {
    if (window.__cawCaptureOn) return;
    window.__cawCaptureOn = true;
    // The workbench marks itself only after this script runs (tab script vs. this context script): so check here, not at start.
    const send = (event) => { if (window.__cawWorkbench !== true) window[binding]?.({ ...event, path: location.pathname }); };
    const describe = (element) => {
        try {
            return describeTarget(element, { mode: 'describe' });
        } catch {
            return null;
        }
    };
    const isField = (element) => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !notTyped.includes(element.type);
    const flush = (element) => {
        if (!isField(element) || element.cawValue === element.value) return;
        element.cawValue = element.value;
        if (element.type === 'password') send({ action: 'fill', secret: true, target: describe(element) });
        else send({ action: 'fill', target: describe(element), value: element.value });
    };
    addEventListener('focusin', ({ target }) => {
        if (isField(target) && target.cawValue === undefined) target.cawValue = target.value;
    }, true);
    addEventListener('change', ({ target }) => { if (!window.__cawPicking) flush(target); }, true);
    addEventListener('keydown', ({ isTrusted, key, target }) => {
        if (!isTrusted || window.__cawPicking || !['Enter', 'Tab', 'Escape'].includes(key)) return;
        flush(target);
        send({ action: 'press', key });
    }, true);
    addEventListener('click', ({ isTrusted, target }) => {
        if (!isTrusted || window.__cawPicking || !(target instanceof Element)) return;
        flush(document.activeElement);
        const described = describe(target);
        send({ action: 'click', target: described, ...(described === null ? { hint: target.tagName.toLowerCase() } : {}) });
    }, true);
}

/**
 * Runs in the browser. The next click picks an element instead of triggering anything: it stops at window and reaches
 * neither the application nor the recording. Escape cancels.
 */
export function pickInPage(describeTarget) {
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
        const click = (event) => {
            if (!event.isTrusted) return;
            swallow(event);
            const { target } = event;
            let described = null;
            try {
                described = describeTarget(target, { mode: 'describe' });
            } catch {
                described = null;
            }
            done({ target: described, tag: target.tagName.toLowerCase(), text: (target.innerText ?? target.value ?? '').trim().slice(0, 120) });
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
 * A target from a frame of the application gets `frame`: the iframes up to the main frame. If an iframe cannot be described,
 * the target is not stable (null), like an element without a name.
 */
const withFrame = async (session, frame, target) => {
    if (target === null || target === undefined || frame === undefined || frame === null) return target ?? null;
    // The application's main frame on the page the event came from: with the workbench its iframe, otherwise this page's main
    // frame. Not session.page(): that is the most recently opened window, and a click in the first tab with an open popup belongs there.
    const page = frame.page();
    const top = session.workbench?.page === page ? session.workbench.view.frame : page.mainFrame();
    if (frame === top) return target;
    const chain = await frameTargetOf({ mainFrame: () => top }, frame).catch(() => null);
    return chain === null ? null : chain === undefined ? target : { ...target, frame: chain };
};

/** In every frame, because forms are sometimes inside iframes. The first click wins, the other frames cancel. */
export const cancelPick = (session) => Promise.all(session.page().frames().map((frame) => frame.evaluate('window.__cawCancelPick?.()').catch(() => {})));

export const pickElement = async (session) => {
    const script = `(${pickInPage})(${(session.framework ?? frameworkOf()).targets})`;
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
    }).then(async (hit) => (hit === null ? null : { ...hit.value, target: await withFrame(session, hit.frame, hit.value.target) }));
    await cancelPick(session);
    if (picked === null) return null;
    const label = picked.target === null ? `${picked.tag}${picked.text === '' ? '' : ` "${picked.text.slice(0, 40)}"`}` : targetLabel(picked.target);
    return { label, ...picked };
};

// Never in the workbench itself: there the human types into the chat, which is not an application step.
const captureScript = (framework) => `if (!(${isWorkbenchDocument}) && location.href !== 'about:srcdoc') (${captureInPage})(${JSON.stringify(BINDING)}, ${framework.targets}, ${JSON.stringify([...NOT_TYPED])});`;

// During the run the folder also belongs to the container: a link inside it, e.g. fehler.json -> ~/.bashrc, must not make the host
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
    while (taken(join(dir, `punkt-${number}.png`))) number += 1;
    return `punkt-${number}.png`;
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
    // A target's frame is resolved on the host, i.e. asynchronously; the queue keeps events in order.
    await session.context.exposeBinding(BINDING, (source, event) => {
        if (state.listener === null || !owns(source)) return;
        state.queue = state.queue.then(async () => {
            const target = event?.target === undefined ? undefined : await withFrame(session, source.frame, event.target);
            state.listener?.(hideSecrets(session, target === undefined ? event : { ...event, target }));
        }).catch(() => {});
    });
    const script = captureScript(session.framework ?? frameworkOf());
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
        case 'navigated': return t('run.item.navigated', { url: item.url });
        case 'reloaded': return t('run.item.reloaded', { url: item.url });
        case 'failure': return t('run.item.failure', { type: item.type, text: item.text, url: item.url === undefined ? '' : ` (${item.url})` });
        default: return `${item.action} ${item.target === null ? unstable(item) : targetLabel(item.target)}`;
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
    return `${verb} ${item.target === null ? unstable(item) : targetLabel(item.target)}`;
};

/**
 * Records until the human is done: a line with { checkpoint } is a checkpoint at this point, { note } is context,
 * an empty line ends it, and so does closing the window.
 * @param operator { nextLine({ page }) } returns the next line, { note } for a note or { checkpoint }, both optionally with element
 * @param onItem   receives every recorded item, e.g. for the chat
 * @param dir      folder for the checkpoint screenshots
 * @returns the steps and checkpoints in order
 */
export const demonstrate = async ({ session, operator, ui, dir, now = Date.now, onFailure, onItem, pollMs = FAILURE_POLL_MS }) => {
    const state = await captureOf(session);
    const items = [];
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
        items.push(item);
        ui.step({ number: items.length, total: items.length, label: itemLabel(item), elapsed: 0 });
        onItem?.(item);
    };
    state.listener = (event) => {
        lastAction = now();
        push(event);
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
        return items;
    } finally {
        clearInterval(failureTimer);
        // Evidence independent of the trace, which may be incomplete after an abrupt end.
        if (dir !== undefined) {
            try {
                writeOwn(join(dir, 'fehler.json'), JSON.stringify((session.failures?.() ?? []).slice(failuresAt), null, 2));
                if (session.network !== undefined) writeOwn(join(dir, 'netzwerk.json'), JSON.stringify(session.network.since(networkAt), null, 2));
            } catch {
                // Evidence is a bonus; the demonstration itself is what counts.
            }
        }
        // Otherwise a pending input read would continue and get in the way of the next one.
        input.abort();
        session.workbench?.onRefresh?.(null);
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
        else if (item.target === null) problems.push(t('run.demo.unstable', { item: itemLabel(item) }));
        else {
            const step = { ...item };
            delete step.hint;
            steps.push(step);
        }
    }
    return { steps, problems };
};

