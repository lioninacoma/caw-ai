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
import { webContext, webPick } from './accessible-name.mjs';
import { extjsCandidates, extjsMatches } from '../ext/extjs/extjs-query.mjs';
import { MARK_ATTRIBUTE, pointerdownLocator, recordLocator, roleAndName } from './record-locator.mjs';
import { HASH_LIMIT_BYTES, matchFixture } from './fixtures.mjs';
import { readPrefs } from '../shared/prefs.mjs';
import { TOKENS, modeOf } from './style.mjs';

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
 * Drawn in Graphite, with the page's CSS kept out (inline styles, closed shadow roots): a 2 px ring in the pick colour with a
 * soft halo around what a click would pick, above it a pill with its role and name in mono (button "Add todo" in dialog
 * "New todo"), and in the application's top document a band with what to do. The page has no caw tokens, so `look` brings
 * the resolved colours of both modes and the mode pref (system follows the page's prefers-color-scheme).
 * @param look { mode, light: { pick, onPick, pickSoft }, dark: {…}, band, font, sans, cross } (pickLook)
 * @param nameOf roleAndName, contextOf webContext (accessible-name.mjs): only for the pill; the host names the result
 */
export function pickInPage(markAttribute, look, nameOf, contextOf) {
    return new Promise((resolve) => {
        const dark = look.mode === 'dark' || (look.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        const colors = dark ? look.dark : look.light;
        const mark = document.createElement('div');
        // A popover: a modal <dialog> lies in the top layer, above any z-index; only another top-layer element is drawn over it.
        mark.popover = 'manual';
        mark.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;border:2px solid ${colors.pick};background:${colors.pickSoft};box-shadow:0 0 0 4px ${colors.pickSoft};border-radius:6px;inset:auto;margin:0;padding:0;overflow:visible;display:none;box-sizing:content-box`;
        document.documentElement.append(mark);
        const pill = `display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:5px 8px;border-radius:6px;font:500 11.5px/1 ${look.font}`;
        const markRoot = mark.attachShadow({ mode: 'closed' });
        markRoot.innerHTML = `<span class="l" style="position:absolute;right:-2px;bottom:calc(100% + 8px);${pill};background:${colors.pick};color:${colors.onPick};box-shadow:0 4px 12px rgba(0,0,0,.2)">${look.cross}<span class="t"></span></span>`;
        const label = markRoot.querySelector('.l');
        // The band only in the application's top document: not in its iframes, the workbench or the chat.
        const appTop = (() => {
            try {
                if (window.__cawWorkbench === true || location.href === 'about:srcdoc') return false;
                return window.top === window || window.parent.__cawWorkbench === true;
            } catch {
                return false;
            }
        })();
        let band = null;
        if (appTop) {
            band = document.createElement('div');
            band.popover = 'manual';
            band.setAttribute('data-caw-band', '');
            band.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;inset:0 0 auto 0;width:auto;height:auto;margin:0;padding:0;border:0;background:none;overflow:visible';
            const bandRoot = band.attachShadow({ mode: 'closed' });
            bandRoot.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:7px 10px;background:${colors.pick};color:${colors.onPick};font:400 12px/1.3 ${look.sans}">${look.cross}<span></span></div>`;
            // "Esc" as a key, as everywhere in caw.
            const text = bandRoot.querySelector('span');
            String(look.band).split(/(Esc)/).forEach((part) => {
                if (part !== 'Esc') {
                    text.append(part);
                    return;
                }
                const key = document.createElement('kbd');
                key.style.cssText = `display:inline-flex;font:500 10.5px/1 ${look.font};padding:2px 4px;margin:0 1px;border-radius:4px;border:1px solid currentColor;background:transparent;color:inherit`;
                key.textContent = part;
                text.append(key);
            });
            document.documentElement.append(band);
            band.showPopover();
        }
        // What the pill says: role and name, and the dialog around it, as the host's label will (locatorLabel).
        const short = (value) => (value.length > 40 ? `${value.slice(0, 39)}…` : value);
        const pillText = (control) => {
            try {
                const own = nameOf(control);
                const self = own === null ? control.tagName.toLowerCase() : `${own.role} "${short(own.name)}"`;
                const dialog = control.matches('dialog, [role=dialog], [role=alertdialog]') ? null : contextOf(control, nameOf).dialog;
                return dialog === null || dialog === undefined ? self : `${self} in ${dialog.role} "${short(dialog.name)}"`;
            } catch {
                return control.tagName.toLowerCase();
            }
        };
        const swallowed = ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu'];
        const swallow = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const CONTROL = 'button, a[href], input, select, textarea, summary, [data-testid], [role]';
        const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
        const controlOf = (start) => {
            for (let current = start; current !== null; current = parentOf(current)) if (current.matches?.(CONTROL)) return current;
            return start;
        };
        // The frame shows what a click would pick. Shown again for every new element: the last one shown is on top, also over a
        // dialog opened while picking.
        let framed = null;
        const move = (event) => {
            const [target] = event.composedPath();
            if (!(target instanceof Element)) return;
            const control = controlOf(target);
            const { left, top, width, height } = control.getBoundingClientRect();
            mark.style.cssText += `;display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
            if (control === framed) return;
            framed = control;
            label.querySelector('.t').textContent = pillText(control);
            // Below the element when there is no room above it (the band lies there too).
            label.style.bottom = top < 64 ? 'auto' : 'calc(100% + 8px)';
            label.style.top = top < 64 ? 'calc(100% + 8px)' : 'auto';
            // Shown again, the band first: the last one shown lies on top.
            if (mark.matches(':popover-open')) mark.hidePopover();
            if (band?.matches(':popover-open')) band.hidePopover();
            band?.showPopover();
            mark.showPopover();
        };
        // Picked on pointerup: a disabled control gets pointer events but no click, and "why is this disabled?" is a common
        // question. The click that follows on an enabled control is still swallowed: the pick ends only after it.
        let chosen = null;
        const choose = (event) => {
            if (!event.isTrusted) return;
            swallow(event);
            if (chosen !== null || event.button !== 0) return;
            const [target] = event.composedPath();
            if (!(target instanceof Element)) return;
            const control = controlOf(target);
            // The host turns the mark into a locator and removes it.
            const value = `pick-${Date.now().toString(36)}`;
            control.setAttribute(markAttribute, value);
            chosen = { mark: value, tag: target.tagName.toLowerCase(), text: (target.innerText ?? target.value ?? '').trim().slice(0, 120) };
            setTimeout(() => done(chosen), 50);
        };
        const click = (event) => {
            if (event.isTrusted) swallow(event);
        };
        const key = (event) => {
            if (event.key !== 'Escape' || !event.isTrusted) return;
            swallow(event);
            done(null);
        };
        const done = (value) => {
            swallowed.forEach((name) => removeEventListener(name, swallow, true));
            removeEventListener('pointerup', choose, true);
            removeEventListener('click', click, true);
            removeEventListener('keydown', key, true);
            removeEventListener('mousemove', move, true);
            mark.remove();
            band?.remove();
            window.__cawPicking = false;
            window.__cawCancelPick = undefined;
            resolve(value);
        };
        window.__cawPicking = true;
        window.__cawCancelPick = () => done(null);
        swallowed.forEach((name) => addEventListener(name, swallow, true));
        addEventListener('pointerup', choose, true);
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
        const root = appFrameOf(session, frame);
        const found = await recordLocator(root, locator, { framework: framework.name, timeout: HINT_TIMEOUT_MS, seen, proposal });
        // The click removed the element before the host looked (a dialog's Schließen, an option whose list closes): what the page
        // checked at the pointerdown counts. Only in the application's own frame: an inner frame's path went with the element.
        const removed = found === null && frame === root && await locator.count().then((count) => count === 0, () => false);
        const target = removed ? pointerdownLocator(proposal, { framework: framework.name }) : found;
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
const quietCancel = (session) => {
    cancelPick(session).catch(() => {});
};

/** What pickInPage draws with: the pick colours of both modes (style.mjs), the mode pref, the band's text, fonts, crosshair. */
export const pickLook = (mode = readPrefs().mode) => {
    const of = (tokens) => ({ pick: tokens.pick, onPick: tokens['on-pick'], pickSoft: tokens['pick-soft'] });
    const cross = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" style="flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>';
    return {
        mode: modeOf(mode), light: of(TOKENS.light), dark: of(TOKENS.dark), band: t('chat.page.picking'), cross,
        // Single quotes: they go into style attributes.
        font: "'Geist Mono',ui-monospace,Consolas,monospace", sans: "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif",
    };
};

/**
 * The crosshair: the next click in the application picks an element.
 * @param mode the personal mode pref, for the overlay's colours (default: from the prefs)
 * @returns { label, target, … } or null if cancelled
 */
export const pickElement = async (session, { mode } = {}) => {
    const script = `(${pickInPage})(${JSON.stringify(MARK_ATTRIBUTE)}, ${JSON.stringify(pickLook(mode))}, ${roleAndName}, ${webContext})`;
    const picked = await new Promise((resolve) => {
        const frames = session.page().frames();
        let open = frames.length;
        for (const frame of frames) {
            frame.evaluate(script).catch(() => undefined).then((value) => {
                open -= 1;
                if (value !== null && value !== undefined) resolve({ value, frame });
                else if (open === 0) resolve(null);
                // Esc in one frame cancels the pick in the others too (a frame that failed to run it cancels nothing): a pick
                // left waiting in an iframe after Esc crashed headless Chrome's page.
                else if (value === null) quietCancel(session);
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
// The keys captureInPage reports; a press with another key did not come from it.
const PRESSED = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']);
const MAX_PATH = 2000;
/**
 * What the page may report through the capture binding, rebuilt from scratch: only the actions captureInPage sends, each with
 * exactly its fields. The binding is reachable by any script of the application, so a page could otherwise slip in notes,
 * checkpoints, checks with code or a ready-made target as the human's. Target and locator always come from the host (the mark).
 * Click, fill and upload need a mark; press only a key captureInPage sends; dblclick carries nothing.
 * @returns { mark?, seen?, proposal?, event } or null to drop it
 */
export const pageEvent = (raw) => {
    if (raw === null || typeof raw !== 'object') return null;
    const path = typeof raw.path === 'string' ? { path: raw.path.slice(0, MAX_PATH) } : {};
    const mark = typeof raw.mark === 'string' && raw.mark !== '' ? raw.mark : null;
    switch (raw.action) {
        case 'click':
            if (mark === null) return null;
            return { mark, seen: raw.seen ?? null, proposal: raw.proposal ?? null, event: { action: 'click', ...(typeof raw.hint === 'string' ? { hint: raw.hint.slice(0, 40) } : {}), ...path } };
        case 'fill':
            if (mark === null) return null;
            if (raw.secret === true) return { mark, event: { action: 'fill', secret: true, ...path } };
            return typeof raw.value === 'string' ? { mark, event: { action: 'fill', value: raw.value, ...path } } : null;
        case 'upload':
            return mark === null || !Array.isArray(raw.files) ? null : { mark, event: { action: 'upload', files: raw.files, ...path } };
        case 'press':
            return PRESSED.has(raw.key) ? { event: { action: 'press', key: raw.key, ...path } } : null;
        case 'dblclick':
            return { event: { action: 'dblclick', ...path } };
        default:
            return null;
    }
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
    await session.context.exposeBinding(BINDING, (source, raw) => {
        if (state.listener === null || !owns(source)) return;
        const accepted = pageEvent(raw);
        if (accepted === null) return;
        const { mark, seen, proposal, event } = accepted;
        const valid = typeof seen?.role === 'string' && typeof seen?.name === 'string' ? { role: seen.role, name: seen.name } : null;
        const resolving = mark === undefined ? Promise.resolve(null) : markedTarget(session, source.frame, mark, valid, chainOf(proposal));
        state.queue = state.queue.then(async () => {
            const found = await resolving;
            state.listener?.(hideSecrets(session, found === null ? event : { ...event, ...found }));
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

