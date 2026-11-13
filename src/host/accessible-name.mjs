// Role, accessible name and the context of an element as the DOM tells, for every framework: what a recording names an element
// by (record-locator.mjs), what the demonstration checks at the pointerdown (demonstrate.mjs) and what a failure suggests as a
// similar name (framework/web.mjs). All functions run in the browser and must not use anything from outside; one may embed
// another only by its source text.

/**
 * Role and full accessible name of the element, or null. Only a proposal: a locator built from it must still find exactly this
 * element. (Locator.ariaSnapshot would know the exact name, but it renumbers the snapshot references Claude is about to use.)
 */
export function roleAndName(node) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', number: 'spinbutton' };
    const TAG_ROLES = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', DIALOG: 'dialog', NAV: 'navigation', TABLE: 'table', TR: 'row', TD: 'cell', LI: 'listitem', OPTION: 'option', SUMMARY: 'button', IMG: 'img', FIELDSET: 'group' };
    const explicit = node.getAttribute('role');
    let role = explicit ? explicit.split(' ')[0] : TAG_ROLES[node.tagName] ?? null;
    if (!explicit && node.tagName === 'A') role = node.hasAttribute('href') ? 'link' : null;
    if (!explicit && node.tagName === 'INPUT') role = INPUT_ROLES[node.type] ?? 'textbox';
    if (!explicit && node.tagName === 'SELECT' && (node.multiple || node.size > 1)) role = 'listbox';
    if (role === null) return null;
    // A label without the fields inside it: a <select> in a <label> would otherwise carry all its options.
    const labelText = (label) => {
        if (!label) return '';
        const copy = label.cloneNode(true);
        for (const inner of copy.querySelectorAll('select, textarea, input, datalist, [role=listbox]')) inner.remove();
        return copy.textContent ?? '';
    };
    const root = node.getRootNode?.() ?? document;
    const byId = (id) => root.getElementById?.(id) ?? document.getElementById(id);
    const labelledBy = (node.getAttribute('aria-labelledby') ?? '').split(' ').filter((id) => id !== '').map((id) => byId(id)?.textContent ?? '').join(' ');
    // Every <label for> counts, in order: ExtJS gives a checkbox an empty field label and a second one beside the box.
    const forLabel = node.id ? [...(root.querySelectorAll?.(`label[for="${CSS.escape(node.id)}"]`) ?? [])].map(labelText).join(' ') : '';
    const CONTENT_NAMED = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'heading', 'checkbox', 'radio', 'switch', 'treeitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'tooltip']);
    // <input type=submit value="Weiter">: the value is the button's text.
    const inputText = node.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(node.type) ? node.value : '';
    // A fieldset is named by its legend. A dialog never by its content: Playwright's getByRole('dialog', { name }) would not find it.
    const legend = node.tagName === 'FIELDSET' ? node.querySelector(':scope > legend')?.textContent ?? '' : '';
    const name = clean(node.getAttribute('aria-label') || labelledBy || clean(forLabel) || labelText(node.closest('label')) || legend
        || (CONTENT_NAMED.has(role) ? inputText || (node.innerText ?? node.textContent) : '')
        || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('alt') || '');
    return name === '' ? null : { role, name };
}

/**
 * The context of an element, for any framework, from ARIA roles only (`nameOf` is roleAndName):
 * - `dialog`: the nearest open dialog around it with a name ({ role, name }), or null;
 * - `row`: if it is in a table or grid row: { self (the element is the row itself), texts (the shortest cell text, or two cell
 *   texts, no other row of the same table has) }, or null;
 * - `group`: the nearest named group, region or fieldset around it ({ role, name }), for a field without a name of its own.
 */
export function webContext(node, nameOf) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    const parentOf = (current) => current.parentElement ?? (current.getRootNode?.() instanceof ShadowRoot ? current.getRootNode().host : null);
    const roleOf = (current) => current.getAttribute?.('role')?.split(' ')[0] ?? { TR: 'row', TD: 'cell', TH: 'columnheader', DIALOG: 'dialog', FIELDSET: 'group', TABLE: 'table' }[current.tagName] ?? null;
    let dialog = null;
    let row = null;
    let group = null;
    for (let at = node; at !== null && at !== document.body; at = parentOf(at)) {
        const role = roleOf(at);
        if (dialog === null && (role === 'dialog' || role === 'alertdialog') && (at.tagName !== 'DIALOG' || at.open)) {
            const named = nameOf(at);
            if (named !== null) dialog = { role, name: named.name };
        }
        if (group === null && at !== node && ['group', 'region', 'radiogroup'].includes(role)) {
            const named = nameOf(at);
            if (named !== null && named.name.length <= 80) group = { role: role === 'radiogroup' ? 'radiogroup' : named.role, name: named.name };
        }
        if (row === null && role === 'row') {
            const table = (() => { for (let up = parentOf(at); up !== null; up = parentOf(up)) if (['table', 'grid', 'treegrid'].includes(roleOf(up))) return up; return null; })();
            const cellsOf = (current) => [...current.children].filter((child) => ['cell', 'gridcell', 'rowheader'].includes(roleOf(child)) || child.tagName === 'TD')
                .map((cell) => clean(cell.innerText ?? cell.textContent)).filter((text) => text !== '' && text.length <= 80);
            const cells = cellsOf(at);
            const rows = table === null ? [] : [...table.querySelectorAll('tr, [role=row]')].filter((other) => other !== at && cellsOf(other).length > 0);
            const textOf = (current) => clean(current.innerText ?? current.textContent).toLowerCase();
            const unique = (texts) => rows.every((other) => !texts.every((text) => textOf(other).includes(text.toLowerCase())));
            let texts = null;
            const single = [...cells].sort((a, b) => a.length - b.length).find((text) => unique([text]));
            if (single !== undefined) texts = [single];
            for (let i = 0; texts === null && i < cells.length; i += 1) {
                for (let j = i + 1; j < cells.length; j += 1) if (unique([cells[i], cells[j]])) { texts = [cells[i], cells[j]]; break; }
            }
            if (texts !== null) row = { self: at === node, texts };
        }
    }
    return { dialog, row, group };
}

/**
 * At the pointerdown of a demonstration: role and name of the element, inside its dialog, if exactly this one visible element
 * has them right now; null otherwise. The element may be gone after the click (an option of a list that closes), so this is
 * the only moment to check. Returns a chain like record-locator's: [{ role, name }] or [{ role: 'dialog', name }, { role, name }];
 * a dialog without a name scopes it only while it is the one open dialog ({ role: 'dialog' } without a name).
 */
export function webPick(element, nameOf) {
    if (!(element instanceof Element) || element.getClientRects().length === 0) return null;
    const own = nameOf(element);
    if (own === null) return null;
    const parentOf = (current) => current.parentElement ?? (current.getRootNode?.() instanceof ShadowRoot ? current.getRootNode().host : null);
    const dialogOf = (current) => {
        for (let at = parentOf(current); at !== null; at = parentOf(at)) {
            const role = at.getAttribute?.('role') ?? (at.tagName === 'DIALOG' ? 'dialog' : null);
            if (role === 'dialog' || role === 'alertdialog') return at;
        }
        return null;
    };
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    const ROLED = '[role], a, button, input, select, textarea, summary, h1, h2, h3, h4, h5, h6, li, tr, td, th, option, img, fieldset, dialog';
    const dialog = dialogOf(element);
    const dialogRole = dialog === null ? null : dialog.getAttribute('role') ?? 'dialog';
    const dialogName = dialog === null ? null : nameOf(dialog);
    const openDialogs = () => deepAll('[role=dialog], [role=alertdialog], dialog', document)
        .filter((other) => other.getClientRects().length > 0 && (other.getAttribute('role') ?? 'dialog') === dialogRole);
    // A named dialog scopes the locator; an unnamed one only while it is the one open dialog; otherwise the whole page.
    const scoped = dialog !== null && (dialogName !== null || openDialogs().length === 1);
    const scope = scoped ? dialog : document;
    const twins = deepAll(ROLED, scope).filter((other) => other.getClientRects().length > 0 && nameOf(other)?.role === own.role && nameOf(other)?.name === own.name);
    if (twins.length !== 1 || twins[0] !== element) return null;
    if (!scoped) return [{ role: own.role, name: own.name }];
    return [dialogName === null ? { role: dialogRole } : { role: dialogRole, name: dialogName.name }, { role: own.role, name: own.name }];
}
