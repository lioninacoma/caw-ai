// Selector engine `extjs=`: finds ExtJS components with Ext.ComponentQuery, e.g. locator('extjs=button[text="Speichern"]').
// Registered for every framework (without Ext it finds nothing). It counts only components that are not destroyed and visible
// including their containers, and that lie inside the root Playwright passes (so locator('extjs=window').locator('extjs=button')
// finds the buttons inside the window). The hits are the components' root elements, in document order.

import { selectors as playwrightSelectors } from 'playwright-core';

/** Runs in the page (main world, Ext is there), so it must not use anything from outside. */
function extjsEngine() {
    const queryAll = (root, selector) => {
        const query = window.Ext?.ComponentQuery?.query;
        if (typeof query !== 'function') return [];
        // ComponentQuery splits at every comma, also inside quotes, and logs an error for each half into the application's
        // console. A quoted value with a comma can never match: say so to whoever wrote it instead.
        if (/\[[^\]]*=\s*(["'])[^"']*,[^"']*\1\s*\]/.test(selector)) {
            throw new Error(`extjs=${selector}: ComponentQuery cannot match a value with a comma. Use a part of the component without one (itemId, reference) or filter({ hasText }) after it.`);
        }
        const hits = [];
        for (const component of query.call(window.Ext.ComponentQuery, selector)) {
            if (typeof component !== 'object' || component === null || component.destroyed || component.isDestroyed) continue;
            if (typeof component.isVisible === 'function' && !component.isVisible(true)) continue;
            const element = component.el?.dom;
            if (!(element instanceof Element) || !element.isConnected) continue;
            // Like CSS: inside the root, not the root itself.
            if (element === root || !root.contains(element) || hits.includes(element)) continue;
            hits.push(element);
        }
        return hits.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    };
    return { query: (root, selector) => queryAll(root, selector)[0] ?? null, queryAll };
}

/** The engine as script content for selectors.register: an expression that evaluates to the engine. */
export const EXTJS_ENGINE = `(${extjsEngine})()`;

const registered = new WeakSet();

/** Registers the caw selector engines once per selectors object (Playwright's `selectors`); repeated calls do nothing. */
export const registerEngines = async (selectors = playwrightSelectors) => {
    if (registered.has(selectors)) return;
    try {
        await selectors.register('extjs', { content: EXTJS_ENGINE });
    } catch (error) {
        if (!/already registered/.test(error?.message ?? '')) throw error;
    }
    registered.add(selectors);
};
