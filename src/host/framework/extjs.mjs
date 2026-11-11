// Adapter for ExtJS (config `"framework": "extjs"`). Stable targets: snapshot references and IDs like ext-element-29 only hold for
// one page state, and ExtJS buttons often have no accessible name. The component is stable: xtype plus text or label, plus the
// part element inside it. The page is ready when no Ext.Ajax request and no store is loading.

import { t } from '../../shared/i18n.mjs';
import { checkAppFiles, createWatchSource, expectedParts, identifyWatch, staleSources } from './extjs-overlay.mjs';

/**
 * Runs in the browser, so it must not use anything from outside. `describe` describes an element, `find` finds it
 * again. Hits only count if they are really clickable: visible and not covered. That way steps wait for load masks
 * by themselves and hit the topmost dialog when dialogs are stacked.
 */
export function extjsTargets(element, { mode, target }) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    const ownText = (node) => {
        const text = clean(node.innerText ?? node.textContent);
        return text.length <= 80 ? text : '';
    };
    // Checking whether a target is free briefly scrolls it to the center. Afterwards everything is restored: otherwise the page
    // would jump on every search, even without a click (clicks scroll to the target themselves).
    const keepScroll = (node, check) => {
        const saved = [];
        for (let at = node.parentElement; at !== null; at = at.parentElement) saved.push([at, at.scrollTop, at.scrollLeft]);
        const [x, y] = [window.scrollX, window.scrollY];
        try {
            return check();
        } finally {
            for (const [at, top, left] of saved) if (at.scrollTop !== top || at.scrollLeft !== left) { at.scrollTop = top; at.scrollLeft = left; }
            if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
        }
    };
    const componentOf = (start) => {
        for (let node = start; node !== null && window.Ext?.getCmp !== undefined; node = node.parentElement) {
            const component = node.id ? window.Ext.getCmp(node.id) : null;
            if (component) return component;
        }
        return null;
    };
    const rootOf = (component) => component.el?.dom ?? component.element?.dom ?? null;
    const onTop = (node, component) => {
        const box = node.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit === null) return false;
        if (node.contains(hit) || hit.contains(node)) return true;
        const root = component === null ? null : rootOf(component);
        return root !== null && root.contains(hit);
    };
    const reachable = (node, component) => {
        const box = node.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (onTop(node, component)) return true;
        // A fixed cookie banner may cover the edge of the viewport; centered, the element is free.
        return keepScroll(node, () => {
            node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            return onTop(node, component);
        });
    };
    const named = (component) => {
        const text = clean(component.getText?.());
        const label = clean(component.getLabel?.());
        return { ...(text === '' ? {} : { text }), ...(label === '' ? {} : { label }) };
    };
    // Unnamed parts like the arrow of a combobox: only recognizable via the field they belong to.
    const namedParent = (component) => {
        for (let node = rootOf(component)?.parentElement ?? null; node !== null; node = node.parentElement) {
            const parent = componentOf(node);
            if (parent === null) return null;
            if (Object.keys(named(parent)).length > 0) return parent;
            node = rootOf(parent);
            if (node === null) return null;
        }
        return null;
    };
    // `all`: also hits that are currently covered or invisible, e.g. the same button in the form below a sheet.
    const matches = (wanted, all = false) => {
        const isInside = (component) => {
            if (wanted.inside === undefined) return true;
            const parent = namedParent(component);
            return parent !== null && parent.xtype === wanted.inside.xtype
                && (wanted.inside.text === undefined || named(parent).text === wanted.inside.text)
                && (wanted.inside.label === undefined || named(parent).label === wanted.inside.label);
        };
        const components = wanted.xtype === undefined || window.Ext?.ComponentQuery === undefined
            ? []
            : window.Ext.ComponentQuery.query(wanted.xtype).filter((component) => component.xtype === wanted.xtype
                && (wanted.text === undefined || named(component).text === wanted.text)
                && (wanted.label === undefined || named(component).label === wanted.label)
                && isInside(component));
        const candidates = wanted.xtype === undefined
            ? [...document.querySelectorAll(wanted.part)].map((node) => [node, null])
            : components.flatMap((component) => {
                const root = rootOf(component);
                if (root === null) return [];
                return (wanted.part === undefined ? [root] : [...root.querySelectorAll(wanted.part)]).map((node) => [node, component]);
            });
        return candidates
            .filter(([node]) => wanted.own === undefined || ownText(node) === wanted.own)
            .filter(([node, component]) => all || reachable(node, component))
            .map(([node]) => node);
    };

    if (mode === 'find') return matches(target)[target.index ?? 0] ?? null;

    // Several matches of a target without `index`: where they are and the title of the window or panel around them.
    if (mode === 'ambiguity') {
        const all = matches(target);
        const nearOf = (node) => {
            for (let current = componentOf(node.parentElement); current !== null; current = componentOf(rootOf(current)?.parentElement ?? null)) {
                const title = current.getTitle?.();
                const text = clean(typeof title === 'string' ? title : title?.getText?.() ?? '');
                if (text !== '') return text.slice(0, 60);
            }
            return '';
        };
        return {
            count: all.length,
            candidates: all.slice(0, 3).map((node, index) => {
                const box = node.getBoundingClientRect();
                return { index, x: box.left + box.width / 2 + window.scrollX, y: box.top + box.height / 2 + window.scrollY, near: nearOf(node) };
            }),
        };
    }

    // Why a target is not clickable: is it missing, invisible, or covered by a floating window such as a message box?
    if (mode === 'explain') {
        const candidates = matches(target, true);
        const node = candidates[target.index ?? 0] ?? candidates[0];
        if (node === undefined) return { missing: true };
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true };
        const hit = keepScroll(node, () => {
            node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            const now = node.getBoundingClientRect();
            return document.elementFromPoint(now.left + now.width / 2, now.top + now.height / 2);
        });
        if (hit === null || node.contains(hit) || hit.contains(node)) return { elsewhere: false };
        const layer = hit.closest('.x-messagebox, .x-dialog, .x-sheet, .x-floated, [role=dialog], [role=alertdialog]');
        if (layer === null) return { covered: { tag: hit.tagName.toLowerCase() } };
        const title = componentOf(layer)?.getTitle?.();
        const name = clean(typeof title === 'string' ? title : title?.getText?.() ?? '');
        const messages = [...layer.querySelectorAll('[role=alert], [role=status], .x-messagebox .x-innerhtml, .x-msgbox-text')]
            .map((entry) => clean(entry.innerText).slice(0, 200)).filter((text) => text !== '' && text !== name);
        return { covered: { role: 'dialog', ...(name === '' ? {} : { name }), ...(messages.length === 0 ? {} : { messages: [...new Set(messages)].slice(0, 3) }) } };
    }

    const component = componentOf(element);
    const root = component === null ? null : rootOf(component);
    const cssClass = [...element.classList].find((name) => /^x-[a-z-]+$/.test(name));
    const part = element === root ? undefined : `${element.tagName.toLowerCase()}${cssClass === undefined ? '' : `.${cssClass}`}`;
    const own = component === null ? {} : named(component);
    const plain = {
        ...(component === null ? {} : { xtype: component.xtype }),
        ...own,
        ...(part === undefined ? {} : { part }),
        ...(ownText(element) === '' ? {} : { own: ownText(element) }),
    };
    // Unnamed parts always need the enclosing component. Named ones too, as soon as the same description exists again, even covered:
    // otherwise replay would hit the twin while the right one is not there yet, e.g. `Speichern` in the form instead of the sheet.
    const twins = component !== null && Object.keys(own).length > 0 && matches(plain, true).length > 1;
    const parent = component !== null && (Object.keys(own).length === 0 || twins) ? namedParent(component) : null;
    // Keep the key order, so existing recordings do not get reordered when rewritten.
    const head = { ...plain };
    delete head.part;
    delete head.own;
    const described = parent === null ? plain : { ...head, inside: { xtype: parent.xtype, ...named(parent) }, ...(part === undefined ? {} : { part }), ...(plain.own === undefined ? {} : { own: plain.own }) };
    const all = matches(described);
    const index = all.indexOf(element);
    // With several matches even the first one gets its index: replay then knows the choice was deliberate (see `web`).
    return index === -1 ? null : { ...described, ...(index === 0 && all.length === 1 ? {} : { index }) };
}

/**
 * Runs in the browser: the state that decides between failure and fix-up. Applications put no error marker on
 * their dialogs, so every visible message counts and is checked against the recording.
 * Digits are neutralized so order numbers and dates do not cause a failure.
 */
export function extjsPageState({ marker, selectors }) {
    const query = window.Ext?.ComponentQuery?.query?.bind(window.Ext.ComponentQuery);
    const components = (selector) => (query === undefined ? [] : query(selector)).filter((component) => !component.destroyed && component.isVisible?.() !== false);
    const seen = (node) => node !== null && node !== undefined && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const boxes = components('dialog, messagebox, toast').map((component) => component.el?.dom ?? component.element?.dom);
    // Page messages outside the application, e.g. of a surrounding portal: selectors from the config (`messageSelectors`).
    const alerts = selectors.length === 0 ? [] : [...document.querySelectorAll(selectors.join(', '))];
    // The full text, as with `web`: it is shortened only for display.
    const texts = [...boxes, ...alerts].filter(seen).map((node) => (node.innerText ?? '').replace(/\s+/g, ' ').trim().replace(/\d+/g, '#'));
    return {
        appLoaded: window.Ext !== undefined,
        signedIn: marker === undefined || marker === null ? true : document.querySelector(marker) !== null,
        loading: components('loadmask').length > 0,
        path: location.pathname,
        messages: [...new Set(texts)].filter((text) => text !== ''),
    };
}

/**
 * Runs in the browser: open Ext.Ajax requests and loading stores; with `store` only that one (store id or ComponentQuery) with its count.
 * @returns { pendingAjax, loadingStores, counts, appReady }
 */
export function extjsProbe(given) {
    // { store, ignore } with `readyIgnore`: Ext readiness looks at requests and stores, not at the DOM, so `ignore` does not apply.
    const store = given !== null && typeof given === 'object' ? given.store ?? null : given;
    const Ext = window.Ext;
    if (!(Ext && Ext.data && Ext.data.StoreManager)) return { pendingAjax: 0, loadingStores: 0, counts: null, appReady: false };
    const pendingAjax = Ext.Ajax?.isLoading?.() ? (Ext.Ajax.requests ? Object.keys(Ext.Ajax.requests).length : 1) : 0;
    let stores = [];
    if (store !== null) {
        const byId = Ext.data.StoreManager.lookup(store);
        if (byId) stores = [byId];
        else if (Ext.ComponentQuery) stores = Ext.ComponentQuery.query(store).map((component) => component.getStore?.() ?? null).filter((candidate) => candidate !== null);
    } else {
        Ext.data.StoreManager.each((candidate) => { stores.push(candidate); });
    }
    const loadingStores = stores.filter((candidate) => candidate.isLoading?.()).length;
    const counts = store === null ? null : stores.reduce((total, candidate) => total + (candidate.getCount?.() ?? 0), 0);
    return { pendingAjax, loadingStores, counts, appReady: true };
}

export const extjs = {
    name: 'extjs',
    label: () => 'ExtJS',
    targets: extjsTargets,
    pageState: extjsPageState,
    probe: extjsProbe,
    // Ext.Ajax counts itself; open requests outside Ext, e.g. long polling of the surrounding page, must not hold up the wait.
    countNetwork: false,
    // The order of floating windows (dialogs) for floats.log.
    floats: true,
    // Framework files mostly just pass errors on: the origin is the first entry outside them.
    stackSkip: /\/ext-[\w-]*\.js/,
    // The overlay source is the Sencha watch's web server (port 1841, a random one if that is taken). The command pattern is only
    // used to find the port of a watch that moved; whether the watch is ready is asked of its server, never of the process list.
    watch: { label: () => t('session.overlay.senchaWatch'), command: /\bapp["']?\s+["']?watch\b/i, start: 'sencha app watch' },
    // The adapter derives what gets replaced from app.json, package.json and bootstrap.json (extjs-overlay.mjs).
    overlay: { defaultUrl: 'http://localhost:1841/', identify: identifyWatch, stale: staleSources, createWatchSource, checkAppFiles, expected: expectedParts },
};
