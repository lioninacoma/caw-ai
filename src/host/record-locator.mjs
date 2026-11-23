// What a recording stores for the element Claude or the human pointed at: one Playwright locator as code (see locator.mjs).
// Playwright's own generator (Locator.normalize) proposes it; caw then makes it hold up on the next run:
// - the full accessible name with exact: true instead of a shortened prefix, as long as that stays unique: a prefix like
//   "Complete Feed the raven CAW-" matches every run's entry once the run tag is a placeholder;
// - an entry of a list or table scoped by its row text (filter({ hasText })) instead of its position (nth);
// - a <select> inside a <label> by its role and label: the generator puts every option into the label text, so each new
//   option would break it;
// - nothing that only holds for this page state: snapshot references, ExtJS's generated ids, :nth-child (rejectReason);
// - for ExtJS, where nothing else is left, the component as an extjs= locator (extjs-query.mjs).
// Every change is checked against the page: the new locator must match exactly the element pointed at.

import { roleAndName, webContext } from './accessible-name.mjs';
import { extjsCandidates } from '../ext/extjs/extjs-query.mjs';
import { buildLocator, chainPrefix, escapeRegex, parseLocator, printLocator, rejectReason } from './locator.mjs';

const NORMALIZE_TIMEOUT_MS = 5000;
// The marker the demonstration and the crosshair put on an element (demonstrate.mjs). It must never end up in a recording.
export const MARK_ATTRIBUTE = 'data-caw-mark';
const FINDS = /^(locator|getBy[A-Z]\w*)$/;
const NAMED = new Set(['getByRole', 'getByLabel', 'getByText', 'getByPlaceholder', 'getByAltText', 'getByTitle']);
const POSITION = new Set(['nth', 'first', 'last']);

/**
 * getByRole for a dialog by its name. A name with data in it (a number, a date) holds for this record only: then only its
 * beginning; without a usable beginning (or without a name) the role alone.
 */
const dialogCall = (role, name) => {
    if (typeof name !== 'string') return { method: 'getByRole', args: [role] };
    const lead = /\d{3,}/.test(name) ? name.slice(0, name.search(/\d/)).trimEnd() : name;
    if (lead === name) return { method: 'getByRole', args: [role, { name, exact: true }] };
    return lead.length < 3 ? { method: 'getByRole', args: [role] } : { method: 'getByRole', args: [role, { name: new RegExp(`^${escapeRegex(lead)}`) }] };
};

/** A chain of extjs-query.mjs or of accessible-name.mjs's webPick as locator calls. */
const chainAst = (chain) => chain.map((link) => {
    if (link.extjs !== undefined) return { method: 'locator', args: [`extjs=${link.extjs}`] };
    if (link.text !== undefined) return { method: 'filter', args: [{ hasText: link.text }] };
    if (link.exact !== undefined) return { method: 'filter', args: [{ hasText: new RegExp(`^${escapeRegex(link.exact)}$`) }] };
    if (link.has !== undefined) return { method: 'filter', args: [{ has: { chain: [{ method: 'getByText', args: [link.has, { exact: true }] }] } }] };
    if (link.role === 'dialog' || link.role === 'alertdialog') return dialogCall(link.role, link.name);
    if (link.role !== undefined) return { method: 'getByRole', args: [link.role, { name: link.name, exact: true }] };
    return { method: 'locator', args: [link.css] };
});

/**
 * What a demonstration's page checked at the pointerdown (webPick, or an ExtJS chain), as a locator inside `frames`; null if the
 * page found none or it would not hold up (rejectReason).
 */
export const pointerdownLocator = (proposal, { framework = 'web', frames = [] } = {}) => {
    if (proposal === null || proposal === undefined) return null;
    const code = printLocator([...frames, ...chainAst(proposal)]);
    return rejectReason(code, { framework }) === null ? code : null;
};

const withTimeout = (promise, ms = NORMALIZE_TIMEOUT_MS) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
};

/** The calls that lead from the page into root (an iframe's frame): [] for a page or its main frame. */
const rootPrefix = async (root) => {
    if (typeof root.parentFrame !== 'function' || root.parentFrame() === null) return [];
    return chainPrefix((await withTimeout(root.locator(':root').normalize())).toString());
};

export { roleAndName };

// In the page: the element's dialog, table row and named group (accessible-name.mjs), with roleAndName embedded.
const contextOf = new Function('node', `return (${webContext})(node, ${roleAndName});`);

/** Runs in the browser: the list entry or table row around the element and its first own text, or null. */
function rowOf(node) {
    const parentOf = (current) => current.parentElement ?? (current.getRootNode?.() instanceof ShadowRoot ? current.getRootNode().host : null);
    for (let at = parentOf(node); at !== null && at !== document.body; at = parentOf(at)) {
        const explicit = at.getAttribute('role');
        const role = explicit ? explicit.split(' ')[0] : { LI: 'listitem', TR: 'row' }[at.tagName] ?? null;
        if (role !== 'listitem' && role !== 'row') continue;
        const walker = document.createTreeWalker(at, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
            const clean = text.data.replace(/\s+/g, ' ').trim();
            if (clean === '' || node.contains(text)) continue;
            // At most 80 characters, cut at a word: the row text only has to tell the entry apart.
            const short = clean.length <= 80 ? clean : clean.slice(0, 80).replace(/\s+\S*$/, '');
            return { role, text: short };
        }
        return null;
    }
    return null;
}

/**
 * The locator to record for the element `locator` points at (a snapshot reference, a marker, or code), relative to root, or null
 * if there is no stable one: the step is then reported as unstable.
 * @param root      the application's main frame (with the workbench the frame in its iframe) or the page
 * @param framework the app's framework name from the config ('web', 'extjs', …): generated ids are only rejected for ExtJS
 * @param timeout   how long the element may take to appear; a marked element is there at once or gone
 * @param seen      role and name of a clicked element at the pointerdown (demonstration): the click may rename it ("Confirm"
 *                  becomes "Confirmed"), and the next run finds it under the name it had before the click
 * @param proposal  ExtJS only: a chain the page found unique at the pointerdown (extjsMatches), used when the element is no
 *                  longer where it was (the list it was in closed after the click)
 */
export const recordLocator = async (root, locator, { framework = 'web', timeout = NORMALIZE_TIMEOUT_MS, seen = null, proposal = null } = {}) => {
    // All at once: the application may remove the element right after the click it was marked for (a dialog closing). What
    // needs the element (its token, role and name, row) is read first; the checks below only work while it is still there.
    const token = `caw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const handle = locator.elementHandle({ timeout }).catch(() => null);
    const facts = handle.then((node) => (node === null ? [] : Promise.all([
        // A set: the click into a field and the text typed into it are resolved at the same time on the same element.
        node.evaluate((dom, value) => { (dom.__cawRecord ??= new Set()).add(value); }, token).catch(() => {}),
        node.evaluate(roleAndName).catch(() => null),
        node.evaluate(rowOf).catch(() => null),
        node.evaluate(contextOf).catch(() => null),
    ])));
    const [element, normalized, [, full = null, row = null, context = null], prefix] = await Promise.all([
        handle,
        withTimeout(locator.normalize()).catch(() => null),
        facts,
        rootPrefix(root).catch(() => null),
    ]);
    if (element === null || normalized === null || prefix === null) {
        await element?.evaluate((node, value) => { node.__cawRecord?.delete(value); }, token).catch(() => {});
        await element?.dispose().catch(() => {});
        return null;
    }
    try {
        let ast = parseLocator(normalized.toString());
        if (prefix.length > 0) {
            // Generated from the page: the part that leads into the application's frame goes, the recording starts there.
            if (printLocator(ast.slice(0, prefix.length)) !== printLocator(prefix)) return null;
            ast = ast.slice(prefix.length);
        }
        /** Does the candidate match exactly the element pointed at, and nothing else? */
        const only = async (candidate) => {
            const hits = await buildLocator(root, candidate).evaluateAll((nodes, value) => nodes.map((node) => node.__cawRecord?.has(value) === true), token).catch(() => []);
            return hits.length === 1 && hits[0] === true;
        };
        const none = async (candidate) => (await buildLocator(root, candidate).count().catch(() => -1)) === 0;
        const at = ast.findLastIndex(({ method }) => FINDS.test(method));
        if (at !== -1) {
            let head = ast.slice(0, at);
            const find = ast[at];
            const tail = ast.slice(at + 1);
            const free = tail.filter(({ method }) => !POSITION.has(method));

            // The generator shortens a row's text, often right before the digits of a run tag ("Feed the raven CAW-"): every
            // run's entry matches that. The row's full text keeps the run tag, which becomes {{runTag}}.
            const cut = head.findIndex(({ method, args }) => method === 'filter' && typeof args[0]?.hasText === 'string');
            if (cut !== -1 && row !== null) {
                const text = head[cut].args[0].hasText;
                if (row.text !== text && row.text.toLowerCase().includes(text.toLowerCase())) {
                    const longer = [...head.slice(0, cut), { method: 'filter', args: [{ ...head[cut].args[0], hasText: row.text }] }, ...head.slice(cut + 1)];
                    const candidate = [...longer, find, ...tail];
                    if (await only(candidate)) {
                        head = longer;
                        ast = candidate;
                    }
                }
            }
            let named = find;
            if (NAMED.has(find.method) && full !== null) {
                const options = find.method === 'getByRole' && find.args[0] === full.role && typeof find.args[1] === 'object' ? find.args[1] : {};
                named = { method: 'getByRole', args: [full.role, { ...options, name: full.name, exact: true }] };
                const candidate = [...head, named, ...free];
                if (seen !== null && seen.role === full.role && seen.name !== full.name) {
                    // Renamed by the click: recorded under the earlier name, if the current one finds exactly this element and
                    // nothing else carries the earlier name now. A locator with the later name would fail on the next run.
                    const before = { method: 'getByRole', args: [full.role, { ...options, name: seen.name, exact: true }] };
                    if (!(await only(candidate)) || !(await none([...head, before, ...free]))) return null;
                    named = before;
                    ast = [...head, before, ...free];
                } else if (await only(candidate)) ast = candidate;
            }
            const frames = ast.slice(0, ast.findLastIndex(({ method }) => method === 'contentFrame') + 1);
            const own = [named, ...free].filter(({ method }) => method !== 'contentFrame');
            if (context?.row) {
                // A table or grid row by the cells only it has: never by position, and not by its whole name, which changes with
                // any column (a date, a status).
                const rowChain = [{ method: 'getByRole', args: ['row'] }, ...context.row.texts.map((text) => ({ method: 'filter', args: [{ hasText: text }] }))];
                const candidate = [...frames, ...rowChain, ...(context.row.self ? [] : own)];
                if (await only(candidate)) ast = candidate;
            } else if (ast.some(({ method }) => POSITION.has(method)) && row !== null) {
                // Still chosen by position among equal entries: the entry's row text tells it apart, also when rows are added.
                const candidate = [...head, { method: 'getByRole', args: [row.role] }, { method: 'filter', args: [{ hasText: row.text }] }, named, ...free];
                if (await only(candidate)) ast = candidate;
            }
            // A field without a name of its own, chosen by position: by the named group or region around it.
            if (context?.group && (ast.some(({ method }) => POSITION.has(method)) || (find.method === 'getByRole' && find.args[1]?.name === undefined && full === null))) {
                const role = find.method === 'getByRole' ? find.args[0] : full?.role;
                if (typeof role === 'string') {
                    const candidate = [...frames, { method: 'getByRole', args: [context.group.role, { name: context.group.name, exact: true }] }, { method: 'getByRole', args: [role] }];
                    if (await only(candidate)) ast = candidate;
                }
            }
            // Inside a dialog always scoped by it: a second dialog with an equally named button may come later.
            // The generator's own dialog scope (if any) is replaced: it has no exact name and keeps data in the name.
            const generated = ast[frames.length]?.method === 'getByRole' && ['dialog', 'alertdialog'].includes(ast[frames.length].args[0]);
            const rest = ast.slice(frames.length + (generated ? 1 : 0));
            if (context?.dialog) {
                const candidate = [...frames, dialogCall(context.dialog.role, context.dialog.name), ...rest];
                if (await only(candidate)) ast = candidate;
            }
        }
        const code = printLocator(ast);
        const usable = !code.includes(MARK_ATTRIBUTE) && rejectReason(code, { framework }) === null;
        const frames = ast.slice(0, ast.findLastIndex(({ method }) => method === 'contentFrame') + 1);
        const fits = (candidate) => (rejectReason(printLocator(candidate), { framework }) === null ? only(candidate) : false);
        // The demonstration found a chain at the pointerdown, while a list or dialog was still open; now the element is gone.
        const fromPointerdown = () => pointerdownLocator(proposal, { framework, frames });
        // Gone or hidden now: nothing here can be checked any more, what the page checked at the pointerdown counts.
        const gone = !(await element.isVisible().catch(() => false));
        if (gone && fromPointerdown() !== null) return fromPointerdown();
        if (framework !== 'extjs') return usable ? code : fromPointerdown();
        // ExtJS: the component around the element (extjs= engine), inside the same frames as the generated locator.
        const ext = await element.evaluate(extjsCandidates).catch(() => ({ floating: null, item: false, chains: [] }));
        // Data rows and list entries only ever by their text: a position or a bare row holds for this data only.
        if (ext.item) {
            for (const chain of ext.chains) if (await fits([...frames, ...chainAst(chain)])) return printLocator([...frames, ...chainAst(chain)]);
        }
        // Inside a dialog or message box always scoped by it: a second dialog with an equally named button may come later.
        if (usable && ext.floating !== null) {
            const scoped = [...frames, ...chainAst([ext.floating]), ...ast.slice(frames.length)];
            if (await fits(scoped)) return printLocator(scoped);
        }
        if (usable && !ext.item) return code;
        for (const chain of ext.chains) if (await fits([...frames, ...chainAst(chain)])) return printLocator([...frames, ...chainAst(chain)]);
        return fromPointerdown() ?? (usable ? code : null);
    } catch {
        return null;
    } finally {
        await element.evaluate((node, value) => { node.__cawRecord?.delete(value); }, token).catch(() => {});
        await element.dispose().catch(() => {});
    }
};
