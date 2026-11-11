// Adapter for any web application, without framework knowledge (config `"framework": "web"`, the default). It describes targets
// like a person with a screen reader: role and accessible name, plus `data-testid` and the named area around it (`inside`).
// The page is ready when no application request is open, nothing has `aria-busy`, no indeterminate progress is running and the
// DOM has been still for a moment. Open shadow roots (web components, Angular with ShadowDom, Lit, Ionic) are included.
import { t } from '../../shared/i18n.mjs';

/**
 * Runs in the browser, so it must not use anything from outside. `describe` describes an element, `find` finds it again. Hits only
 * count if they are really clickable: visible and not covered.
 */
export function webTargets(element, { mode, target, exact = false }) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    // Like TARGET_TEXT_MAX: longer texts would not be a stable target. A pattern, however, checks the whole text.
    const short = (text) => (text.length <= 80 ? text : '');
    // Shadow DOM: parents across the boundary, search in all open shadow roots.
    const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
    // Checking whether a target is free briefly scrolls it to the center. Afterwards everything is restored: otherwise the page
    // would jump on every search, even without a click (clicks scroll to the target themselves).
    const keepScroll = (node, check) => {
        const saved = [];
        for (let at = parentOf(node); at !== null; at = parentOf(at)) saved.push([at, at.scrollTop, at.scrollLeft]);
        const [x, y] = [window.scrollX, window.scrollY];
        try {
            return check();
        } finally {
            for (const [at, top, left] of saved) if (at.scrollTop !== top || at.scrollLeft !== left) { at.scrollTop = top; at.scrollLeft = left; }
            if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
        }
    };
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of [root, ...root.querySelectorAll('*')]) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    const deepClosest = (node, selector) => {
        for (let current = node; current !== null; current = parentOf(current)) if (current.matches?.(selector)) return current;
        return null;
    };
    const deepContains = (outer, inner) => {
        for (let current = inner; current !== null; current = parentOf(current)) if (current === outer) return true;
        return false;
    };
    const byId = (node, id) => node.getRootNode?.().getElementById?.(id) ?? document.getElementById(id);
    const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', number: 'spinbutton' };
    const TAG_ROLES = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog', FORM: 'form', NAV: 'navigation', TABLE: 'table', TR: 'row', LI: 'listitem', OPTION: 'option', SUMMARY: 'button' };
    const roleOf = (node) => {
        const explicit = node.getAttribute('role');
        if (explicit) return explicit.split(' ')[0];
        if (node.tagName === 'A') return node.hasAttribute('href') ? 'link' : null;
        if (node.tagName === 'INPUT') return INPUT_ROLES[node.type] ?? 'textbox';
        return TAG_ROLES[node.tagName] ?? null;
    };
    // Roles whose name comes from their content; for fields only the label counts, never the value.
    const CONTENT_NAMED = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'heading', 'checkbox', 'radio', 'switch', 'treeitem', 'cell', 'gridcell', 'columnheader']);
    // The label without the fields inside: a <select> in a <label> would otherwise put all options into the name, and every new
    // option would break finding it again.
    const labelText = (label) => {
        if (!label) return '';
        const copy = label.cloneNode(true);
        for (const inner of copy.querySelectorAll('select, textarea, datalist, [role=listbox]')) inner.remove();
        return copy.textContent ?? '';
    };
    const fullNameOf = (node) => {
        const role = roleOf(node);
        const labelledBy = (node.getAttribute('aria-labelledby') ?? '').split(' ').filter((id) => id !== '').map((id) => byId(node, id)?.innerText ?? '').join(' ');
        const forLabel = node.id ? labelText((node.getRootNode?.() ?? document).querySelector?.(`label[for="${CSS.escape(node.id)}"]`)) : '';
        return clean(node.getAttribute('aria-label') || labelledBy || forLabel || labelText(node.closest('label'))
            || (CONTENT_NAMED.has(role) ? node.innerText ?? node.textContent : '')
            || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('alt') || '');
    };
    const nameOf = (node) => short(fullNameOf(node));
    const fullOwnText = (node) => clean(node.innerText ?? node.textContent);
    const ownText = (node) => short(fullOwnText(node));
    const CONTAINERS = new Set(['dialog', 'alertdialog', 'form', 'region', 'group', 'tabpanel', 'navigation', 'menu', 'toolbar', 'row', 'listitem', 'article', 'complementary', 'banner', 'main', 'search']);
    // The nearest named area: tells apart identical buttons in different dialogs or rows.
    // With `full` also the whole name (`whole`), for a pattern on the area.
    const insideOf = (node, full = false) => {
        for (let current = parentOf(node); current !== null && current !== document.body; current = parentOf(current)) {
            const role = roleOf(current);
            if (!CONTAINERS.has(role)) continue;
            const whole = role === 'row' || role === 'listitem' ? clean((current.innerText ?? '').split('\n')[0]) : fullNameOf(current);
            const name = short(whole);
            if (name !== '') return { role, name, ...(full ? { whole } : {}) };
        }
        return null;
    };
    const ACTIONABLE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role], [data-testid], [contenteditable=""], [contenteditable=true], [tabindex]';
    // What is on top at this point, also inside shadow roots.
    const hitAt = (x, y) => {
        let hit = document.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (inner === null || inner === hit) break;
            hit = inner;
        }
        return hit;
    };
    const onTop = (node) => {
        const box = node.getBoundingClientRect();
        const hit = hitAt(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && (deepContains(node, hit) || deepContains(hit, node) || hit.closest('label')?.control === node);
    };
    const reachable = (node) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (onTop(node)) return true;
        return keepScroll(node, () => {
            node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            return onTop(node);
        });
    };
    const describeNode = (node) => {
        const role = roleOf(node);
        const name = nameOf(node);
        const testid = node.getAttribute('data-testid') ?? '';
        const inside = insideOf(node);
        const own = role === null && testid === '' ? ownText(node) : '';
        return {
            ...(role === null ? { tag: node.tagName.toLowerCase() } : { role }),
            ...(name === '' ? {} : { name }),
            ...(testid === '' ? {} : { testid }),
            ...(inside === null ? {} : { inside }),
            ...(own === '' ? {} : { own }),
        };
    };
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    // A target value is fixed or a pattern {pattern}. The pattern checks the whole text, even beyond the length limit, e.g.
    // a button with a changing number ("Prüfen 3") or a long name by its beginning.
    const isPattern = (value) => value !== null && typeof value === 'object' && typeof value.pattern === 'string';
    const fits = (wanted, seen, whole) => (isPattern(wanted) ? new RegExp(wanted.pattern).test(whole ?? seen ?? '') : seen === wanted);
    const wholeOf = (node, key) => (key === 'name' ? fullNameOf(node) : key === 'own' ? fullOwnText(node) : undefined);
    const fitsKeys = (wanted, node, seen) => ['role', 'tag', 'name', 'testid', 'own']
        .every((key) => wanted[key] === undefined || fits(wanted[key], seen[key], isPattern(wanted[key]) ? wholeOf(node, key) : undefined));
    const fitsInside = (wanted, node, seen) => {
        if (wanted === undefined) return true;
        if (!isPattern(wanted.name)) return same(seen.inside, wanted);
        const area = insideOf(node, true);
        return area !== null && Object.keys(wanted).every((key) => (key === 'name' ? fits(wanted.name, area.name, area.whole) : area[key] === wanted[key]));
    };
    const visible = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const matches = (wanted) => {
        const pool = deepAll(wanted.tag ?? ACTIONABLE);
        return pool.filter((node) => {
            const seen = describeNode(node);
            return fitsKeys(wanted, node, seen) && fitsInside(wanted.inside, node, seen);
        }).filter(exact ? visible : reachable);
    };

    // Virtualized lists (CDK Virtual Scroll, react-window, vue-virtual-scroller) only have the visible rows in the DOM. If a row or a
    // target in it is missing, each search scrolls the list a bit further until it shows up or the end is reached.
    const LISTISH = new Set(['row', 'listitem', 'option', 'gridcell', 'cell', 'treeitem']);
    const scrollOn = () => {
        const SCROLLERS = '[role=grid], [role=list], [role=listbox], [role=table], [role=tree], [role=rowgroup], ul, ol, table, tbody, div';
        const scrollable = deepAll(SCROLLERS).filter((node) => {
            if (node.scrollHeight <= node.clientHeight + 4 || node.getClientRects().length === 0) return false;
            const overflow = getComputedStyle(node).overflowY;
            return (overflow === 'auto' || overflow === 'scroll') && node.scrollTop + node.clientHeight < node.scrollHeight - 1;
        });
        const list = scrollable.find((node) => node.matches('[role=grid], [role=list], [role=listbox], [role=table], [role=tree], [role=rowgroup]')) ?? scrollable[0];
        if (list === undefined) return;
        list.scrollTop += Math.max(40, Math.floor(list.clientHeight * 0.8));
    };

    if (mode === 'find') {
        const found = matches(target)[target.index ?? 0] ?? null;
        if (found === null && (LISTISH.has(target.role) || LISTISH.has(target.inside?.role))) scrollOn();
        return found;
    }

    // Why a target is not clickable: is it missing, invisible, or covered by something such as an open dialog with a message?
    if (mode === 'explain') {
        const candidates = deepAll(target.tag ?? ACTIONABLE).filter((node) => fitsKeys(target, node, describeNode(node)));
        // The same area as when searching: an invisible twin elsewhere, e.g. the mobile navigation, explains nothing.
        const inArea = candidates.filter((node) => fitsInside(target.inside, node, describeNode(node)));
        if (inArea.length === 0) {
            if (candidates.length > 0) return { elsewhere: true };
            // Missing entirely: the names of visible elements with the same role; the host picks similar ones, e.g. a renamed button.
            const names = target.role === undefined ? [] : [...new Set(deepAll(ACTIONABLE).filter((node) => node.getClientRects().length > 0)
                .map(describeNode).filter((seen) => seen.role === target.role && seen.name).map((seen) => seen.name))].slice(0, 80);
            return { missing: true, names };
        }
        const node = inArea[target.index ?? 0] ?? inArea[0];
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true };
        const hit = keepScroll(node, () => {
            node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            const now = node.getBoundingClientRect();
            return hitAt(now.left + now.width / 2, now.top + now.height / 2);
        });
        if (hit === null || deepContains(node, hit) || deepContains(hit, node)) return { elsewhere: candidates.length > 0 && target.inside !== undefined };
        const layer = deepClosest(hit, 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]');
        const cover = layer ?? hit;
        const heading = deepAll('h1, h2, h3, [role=heading]', cover)[0] ?? null;
        const coverName = nameOf(cover) || (heading === null ? '' : short(clean(heading.innerText)));
        // Even without a role: the backdrop of a modal dialog covers the whole page.
        const scope = layer ?? deepAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]').find((dialog) => dialog.getClientRects().length > 0) ?? null;
        const messages = scope === null ? [] : deepAll('[role=alert], [role=status], [aria-live=assertive]', scope)
            .map((entry) => clean(entry.innerText).slice(0, 200)).filter((text) => text !== '');
        return {
            covered: {
                ...(scope === null ? { tag: cover.tagName.toLowerCase() } : { role: 'dialog' }),
                ...(coverName === '' && scope !== null ? { name: short(clean(deepAll('h1, h2, h3, [role=heading]', scope)[0]?.innerText ?? '')) } : coverName === '' ? {} : { name: coverName }),
                ...(messages.length === 0 ? {} : { messages: [...new Set(messages)].slice(0, 3) }),
            },
        };
    }

    // The control the click belongs to, e.g. the button around an icon. With `exact` the element itself, e.g. an iframe: otherwise
    // the target would be the dialog or role area around it, which holds no frame.
    const node = exact ? element : deepClosest(element, 'button, a[href], input, select, textarea, summary, [data-testid], [role]') ?? element;
    const described = describeNode(node);
    const index = matches(described).indexOf(node);
    return index === -1 ? null : { ...described, ...(index === 0 ? {} : { index }) };
}

/**
 * Runs in the browser: what is loading right now, also in open shadow roots. `aria-busy`, indeterminate progress (`role=progressbar`
 * without `aria-valuenow`, which is how Material, MUI and Vuetify draw spinners) and, with `domQuietMs`, a DOM that is changing.
 * Must run as one function without dependencies, so everything lives inside it.
 */
export function webBusy({ domQuietMs = 0 } = {}) {
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of [root, ...root.querySelectorAll('*')]) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const busy = deepAll('[aria-busy=true], [role=progressbar]:not([aria-valuenow])').filter(seen).length;
    if (domQuietMs <= 0) return busy;
    // The DOM often keeps rendering after a request (change detection, Suspense, nextTick). The observer attaches on the first call
    // and counts only new or changed nodes, not attributes: a clock or spinner would otherwise never let it settle.
    // An observer on the document does not see into shadow roots: every open root gets its own, including later ones.
    const KEY = '__cawLastMutation';
    if (window[KEY] === undefined) {
        window[KEY] = 0;
        window.__cawObserved = new WeakSet();
    }
    const watch = (root) => {
        if (window.__cawObserved.has(root)) return;
        window.__cawObserved.add(root);
        new MutationObserver(() => { window[KEY] = Date.now(); }).observe(root, { subtree: true, childList: true, characterData: true });
    };
    watch(document);
    for (const host of deepAll('*')) if (host.shadowRoot) watch(host.shadowRoot);
    return busy + (Date.now() - window[KEY] < domQuietMs ? 1 : 0);
}

/** Runs in the browser: page state without a framework. Messages from `selectors` and modal dialogs, digits as #. */
export function webPageState({ marker, selectors }) {
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of [root, ...root.querySelectorAll('*')]) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    const seen = (node) => node !== null && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
    const deepClosest = (node, selector) => {
        for (let current = node; current !== null; current = parentOf(current)) if (current.matches?.(selector)) return current;
        return null;
    };
    // A modal dialog is a message if it informs or asks for confirmation. A form in a dialog (input fields other than checkboxes)
    // is regular use of the application, not a message: as a known message it would later hide real messages.
    const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true]';
    const isForm = (node) => node.getAttribute('role') !== 'alertdialog' && deepAll(FIELDS, node).some(seen);
    const modal = deepAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]').filter((node) => !isForm(node));
    const alerts = selectors.length === 0 ? [] : deepAll(selectors.join(', '));
    // Text node by node with spaces: innerText glues inline elements together ("Ich weiß" + button "Auflösen").
    // Includes open shadow roots: a message implemented as a web component often carries its text only there.
    const readable = (node) => {
        const parts = [];
        const walk = (root, deep) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
            for (let next = walker.nextNode(); next !== null; next = walker.nextNode()) {
                if (next.nodeType === Node.ELEMENT_NODE) {
                    if (deep && next.shadowRoot) walk(next.shadowRoot, deep);
                } else if (next.parentElement?.checkVisibility?.({ visibilityProperty: true }) !== false) {
                    parts.push(next.data);
                }
            }
        };
        walk(node, false);
        if (parts.join('').trim() === '') {
            if (node.shadowRoot) walk(node.shadowRoot, true);
            walk(node, true);
        }
        return parts.join(' ').replace(/\s+/g, ' ').replace(/ ([.,;:!?)\]“”"])/g, '$1').replace(/([([„]) /g, '$1').trim();
    };
    // A container like a toast stack (`aria-live` around several toasts) is not a message, each visible child is one. Otherwise,
    // depending on timing, a new combination ("angelegt. Gespeichert") would appear that is never known.
    const ownText = (node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.data.trim() !== '');
    // Whatever is a message itself (role alert/status) stays whole, even if text and buttons are separate blocks.
    const split = (node) => {
        if (['alert', 'status', 'alertdialog'].includes(node.getAttribute('role'))) return [node];
        const children = [...node.children].filter(seen);
        const blocks = children.every((child) => !getComputedStyle(child).display.startsWith('inline'));
        return children.length > 1 && blocks && !ownText(node) && deepClosest(node, 'dialog, [role=dialog], [role=alertdialog]') === null ? children : [node];
    };
    // A status note (role=status, a polite live region) only tells what is happening and may or may not appear depending on timing.
    // When unknown it only warns. Errors (role=alert, assertive) and dialogs are messages: when unknown they fail the step.
    const isNote = (node) => !modal.includes(node) && deepClosest(node, '[role=alert], [role=alertdialog], [aria-live=assertive]') === null
        && deepClosest(node, '[role=status], [role=log], [role=timer], [role=progressbar], [aria-live=polite]') !== null;
    // The whole text: only then does a long message match its entry in knownMessages. It is shortened only for display.
    const read = (node) => readable(node).replace(/\d+/g, '#');
    const shown = [...modal, ...alerts.flatMap(split)].filter(seen);
    const texts = shown.filter((node) => !isNote(node)).map(read);
    const notes = shown.filter(isNote).map(read);
    return {
        appLoaded: document.readyState === 'complete',
        // The document itself first, all shadow roots only without a hit: the state is read on every step.
        signedIn: marker === undefined || marker === null ? true : document.querySelector(marker) !== null || deepAll(marker).length > 0,
        loading: deepAll('[aria-busy=true], [role=progressbar]:not([aria-valuenow])').some(seen),
        path: location.pathname,
        messages: [...new Set(texts)].filter((text) => text !== ''),
        notes: [...new Set(notes)].filter((text) => text !== '' && !texts.includes(text)),
    };
}

/** Runs in the browser: the visible hits of a selector, also in open shadow roots; null without a selector. */
export function webCount(store) {
    if (store === null || store === undefined) return null;
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    return deepAll(store).filter((node) => node.getClientRects().length > 0).length;
}

/** Maximum length of a name or text to count as a target; `webTargets` treats longer ones as empty. */
export const TARGET_TEXT_MAX = 80;

/** How long the DOM must be still before the `web` adapter considers the page quiet. */
export const DOM_QUIET_MS = 150;

/**
 * Runs in the browser: what is still loading. The host adds open requests from the network log. With `store` (a CSS selector)
 * `counts` counts the visible hits, e.g. rows of a list. `webBusy` is inlined as text, since the function runs in the browser.
 */
export const webProbe = new Function('store', `
    const busy = (${webBusy})({ domQuietMs: ${DOM_QUIET_MS} });
    const counts = (${webCount})(store);
    return { pendingAjax: 0, loadingStores: busy, counts, appReady: document.readyState === 'complete' };
`);

/** Page messages: errors, warnings and, as notes, status messages like toasts and snackbars. */
export const WEB_MESSAGE_SELECTORS = ['[role=alert]', '[role=alertdialog]', '[role=status]'];

export const web = {
    name: 'web',
    label: () => t('session.app.web'),
    targets: webTargets,
    pageState: webPageState,
    probe: webProbe,
    messageSelectors: WEB_MESSAGE_SELECTORS,
    countNetwork: true,
    floats: false,
    stackSkip: null,
};
