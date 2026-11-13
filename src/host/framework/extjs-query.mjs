// ExtJS components as locators for the `extjs=` engine (extjs-engine.mjs), for elements Playwright's generator only knows by a
// generated id (#ext-element-12) or not at all: an ExtJS Modern button whose <button> is empty, a list entry, a grid row, a
// field whose label stands beside it. Nothing here knows an application: xtypes, titles and texts come from the page.
//
// A proposal is a chain of links, outermost first:
//   { extjs: 'dialog[title="Termin anlegen"]' }   the floating window around the element (always, when there is one)
//   { extjs: 'container' }, { has: 'Zielgruppe' } a container with this exact text inside it, for a component without a name
//   { extjs: 'button[text="Abbrechen"]' }          the component itself (several links: scope, then component)
//   { text: '9000001' } / { exact: 'Sonstiges' }    a data row or list entry by its text (hasText, or the whole text)
//   { css: 'input' }                              the element inside the component's root element
// recordLocator turns it into locator code and keeps the first proposal that finds exactly the element.

/**
 * Runs in the browser (main world, Ext is there), so it must not use anything from outside. The proposals for the element, best
 * first, as { floating, item, chains }: floating is the link of the window around it (or null), item whether it is a data row or
 * list entry (those are only ever recorded by their text), chains the proposals. No Ext or no component: no chains.
 */
export function extjsCandidates(element) {
    const Ext = window.Ext;
    const NONE = { floating: null, item: false, chains: [] };
    if (typeof Ext?.getCmp !== 'function') return NONE;
    const clean = (value) => (typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    const generated = (id) => /^ext-.*\d/.test(id) || /^[A-Za-z][\w]*(?:-[A-Za-z][\w]*)*-\d+(?:-[\w-]*)?$/.test(id);
    // itemIds ExtJS gives its own message boxes; the button text says more.
    const GENERIC_IDS = new Set(['ok', 'yes', 'no', 'cancel', 'close']);
    const DATA_ITEM = /(^|[._-])(gridrow|listitem|simplelistitem|dataitem|treelistitem|boundlistitem)$/i;
    const FLOATING = /(^|[._-])(dialog|window|messagebox|sheet|actionsheet)$/i;
    const rootOf = (component) => component?.el?.dom ?? component?.element?.dom ?? null;
    const componentOf = (start) => {
        for (let node = start; node !== null; node = node.parentElement) {
            const component = node.id ? Ext.getCmp(node.id) : null;
            if (component) return component;
        }
        return null;
    };
    const parentOf = (component) => component.getParent?.() ?? component.ownerCt ?? componentOf(rootOf(component)?.parentElement ?? null);
    const titleOf = (component) => {
        const title = component.getTitle?.();
        return clean(typeof title === 'string' ? title : title?.getText?.() ?? title?.getTitle?.() ?? '');
    };
    // ComponentQuery has no escapes inside a quoted value: the other quote, or no attribute at all. It splits a query at every
    // comma, also inside quotes, and logs "Invalid ComponentQuery selector" for each half: no attribute with a comma either.
    const attribute = (name, value) => {
        if (typeof value !== 'string' || value === '' || value.length > 120 || value.includes(',')) return null;
        if (!value.includes('"')) return `[${name}="${value}"]`;
        if (!value.includes("'")) return `[${name}='${value}']`;
        return null;
    };
    const xtypeOf = (component) => (typeof component.xtype === 'string' && /^[\w.-]+$/.test(component.xtype) ? component.xtype : null);
    const own = (component, key) => {
        const value = component.config?.[key] ?? component.initialConfig?.[key] ?? (key === 'reference' ? component.getReference?.() : undefined);
        return typeof value === 'string' && value !== '' && !generated(value) ? value : null;
    };
    /** The ways to name the component itself, best first: its own id, its text, label or title, its tool type or icon. */
    const namesOf = (component) => {
        const xtype = xtypeOf(component);
        if (xtype === null) return [];
        const ids = [];
        const texts = [];
        for (const key of ['itemId', 'reference']) {
            const value = own(component, key);
            const part = value === null ? null : attribute(key, value);
            if (part !== null) (GENERIC_IDS.has(value.toLowerCase()) ? texts : ids).push(`${xtype}${part}`);
        }
        const named = [
            ['text', clean(component.getText?.())],
            [typeof component.getLabel === 'function' ? 'label' : 'fieldLabel', clean(component.getLabel?.() ?? component.getFieldLabel?.())],
            ['boxLabel', clean(component.getBoxLabel?.())],
            ['title', titleOf(component)],
        ];
        const textual = named.map(([key, value]) => attribute(key, value)).filter(Boolean).map((part) => `${xtype}${part}`);
        // Generic ids (yes, no) come after the text: "Ja" says which button, "yes" fits every message box.
        const plain = [...ids, ...textual, ...texts];
        if (plain.length > 0) return plain;
        const type = typeof component.getType === 'function' ? attribute('type', component.getType()) : null;
        const icon = typeof component.getIconCls === 'function' ? attribute('iconCls', component.getIconCls()) : null;
        return [type, icon].filter(Boolean).map((part) => `${xtype}${part}`);
    };
    /** The nearest floating window around the component, as a link, or null. */
    const floatingOf = (component) => {
        for (let at = parentOf(component); at !== null && at !== undefined; at = parentOf(at)) {
            const xtype = xtypeOf(at);
            if (xtype !== null && (FLOATING.test(xtype) || at.getFloated?.() === true || at.isWindow === true)) {
                // A title with data in it (a number, a date) holds for this record only: then only its beginning, before the
                // first digits, with ComponentQuery's ^= ("starts with").
                const whole = titleOf(at);
                const lead = /\d{3,}/.test(whole) ? whole.slice(0, whole.search(/\d/)).trimEnd() : whole;
                const title = lead.length < 3 ? null : lead === whole ? attribute('title', whole) : attribute('title', lead)?.replace('[title=', '[title^=');
                return { extjs: `${xtype}${title ?? ''}` };
            }
        }
        return null;
    };
    /** Short own texts in the container's direct children (labels, headings): what names an unnamed field beside it. */
    const headingsOf = (container) => (container.getItems?.()?.items ?? container.items?.items ?? [])
        .filter((child) => !(child.isField || child.isFormField || child.isButton) && child.isVisible?.(true) !== false)
        .map((child) => clean(child.getHtml?.() ?? child.getText?.() ?? child.getTitle?.() ?? ''))
        .filter((text) => text !== '' && text.length <= 80);

    const component = componentOf(element);
    if (component === null) return NONE;
    const root = rootOf(component);
    if (root === null) return NONE;
    // The element inside the component, e.g. the <input> of a text field: by its tag, with an x- class if the tag repeats.
    let part;
    if (element !== root) {
        const tag = element.tagName.toLowerCase();
        part = tag;
        if (root.querySelectorAll(tag).length > 1) {
            const cssClass = [...element.classList].find((name) => /^x-[a-z-]+$/.test(name));
            if (cssClass === undefined) return NONE;
            part = `${tag}.${cssClass}`;
            if (root.querySelectorAll(part).length !== 1) return NONE;
        }
    }
    const tail = part === undefined ? [] : [{ css: part }];
    const floating = floatingOf(component);
    const head = floating === null ? [] : [floating];
    const proposals = [];

    // A data row or list entry: never by position, always by its text. A list entry by its whole text, a row by the shortest
    // cell text (or cell texts) no other row of the same list has.
    const item = [component, parentOf(component)].find((candidate) => candidate && DATA_ITEM.test(xtypeOf(candidate) ?? ''));
    if (item !== undefined) {
        const list = parentOf(item);
        const listName = list ? namesOf(list)[0] ?? xtypeOf(list) : null;
        const itemRoot = rootOf(item);
        const itemXtype = xtypeOf(item);
        if (listName && itemRoot && itemXtype) {
            // Something inside the row: by its own name, a grid cell by its column (dataIndex: the same in every run, while its
            // text is the record's and may repeat in another column of the row), else by its kind and its whole text.
            const column = attribute('dataIndex', typeof component.getDataIndex === 'function' ? component.getDataIndex() : component.dataIndex);
            const cellName = namesOf(component)[0] ?? (column === null || xtypeOf(component) === null ? undefined : `${xtypeOf(component)}${column}`);
            const cellText = clean(root.innerText ?? '');
            const inner = item === component ? tail : xtypeOf(component) === null ? tail
                : [{ extjs: cellName ?? xtypeOf(component) }, ...(cellName === undefined && cellText !== '' && cellText.length <= 80 ? [{ exact: cellText }] : []), ...tail];
            const siblings = [...(rootOf(list)?.querySelectorAll(`.${[...itemRoot.classList].find((name) => /^x-[a-z]+(row|item)$/.test(name)) ?? 'x-listitem'}`) ?? [])].filter((node) => node !== itemRoot);
            const textOf = (node) => clean(node.innerText ?? node.textContent ?? '');
            const whole = textOf(itemRoot);
            const cells = [...itemRoot.querySelectorAll('.x-gridcell')].map(textOf).filter((text) => text !== '' && text.length <= 80);
            // A floating list (the drop-down of a combobox) is its own scope; a list inside a dialog gets the dialog first.
            const listFloats = list.getFloated?.() === true || FLOATING.test(xtypeOf(list) ?? '');
            const scope = [...(listFloats ? [] : head), { extjs: `${listName} ${itemXtype}` }];
            if (cells.length === 0 && whole !== '' && whole.length <= 120) proposals.push([...scope, { exact: whole }, ...inner]);
            const unique = (texts) => siblings.every((node) => !texts.every((text) => textOf(node).includes(text)));
            const single = [...cells].sort((a, b) => a.length - b.length).find((text) => unique([text]));
            if (single !== undefined) proposals.push([...scope, { text: single }, ...inner]);
            else {
                for (let i = 0; i < cells.length && proposals.length === 0; i += 1) {
                    for (let j = i + 1; j < cells.length; j += 1) if (unique([cells[i], cells[j]])) { proposals.push([...scope, { text: cells[i] }, { text: cells[j] }, ...inner]); break; }
                }
            }
            if (proposals.length === 0 && whole !== '' && whole.length <= 200) proposals.push([...scope, { text: whole }, ...inner]);
            return { floating, item: true, chains: proposals };
        }
    }

    const names = namesOf(component);
    for (const name of names) proposals.push([...head, { extjs: name }, ...tail]);
    // No name of its own, or not unique by it: inside the nearest container that is named, or that holds a heading beside it.
    const inner = names.length > 0 ? names : xtypeOf(component) === null ? [] : [xtypeOf(component)];
    for (let at = parentOf(component), depth = 0; at !== null && at !== undefined && depth < 8; at = parentOf(at), depth += 1) {
        if (floating !== null && FLOATING.test(xtypeOf(at) ?? '')) break;
        const outer = namesOf(at);
        const headings = outer.length > 0 ? [] : headingsOf(at);
        if (outer.length === 0 && headings.length === 0) continue;
        for (const query of inner) {
            for (const scope of outer.slice(0, 2)) proposals.push([...head, { extjs: `${scope} ${query}` }, ...tail]);
            if (headings.length > 0 && xtypeOf(at) !== null) proposals.push([...head, { extjs: xtypeOf(at) }, { has: headings[0] }, { extjs: query }, ...tail]);
        }
        break;
    }
    return { floating, item: false, chains: proposals };
}

/**
 * Runs in the browser: does the chain find exactly `element`, judged like the extjs= engine (visible components only)? For the
 * demonstration, which has to decide at the pointerdown, while a list or dialog is still open; recordLocator checks with
 * Playwright otherwise.
 */
export function extjsMatches(element, chain) {
    const Ext = window.Ext;
    if (typeof Ext?.ComponentQuery?.query !== 'function') return false;
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    let scopes = [document.documentElement];
    for (const link of chain) {
        if (link.extjs !== undefined) {
            let hits;
            try { hits = Ext.ComponentQuery.query(link.extjs); } catch { return false; }
            const roots = hits.filter((c) => !c.destroyed && !c.isDestroyed && c.isVisible?.(true) !== false).map((c) => c.el?.dom ?? c.element?.dom).filter((node) => node instanceof Element && node.isConnected);
            scopes = roots.filter((node) => scopes.some((scope) => scope !== node && scope.contains(node)));
        } else if (link.text !== undefined) scopes = scopes.filter((node) => clean(node.innerText).toLowerCase().includes(link.text.toLowerCase()));
        else if (link.exact !== undefined) scopes = scopes.filter((node) => clean(node.innerText) === link.exact);
        else if (link.has !== undefined) scopes = scopes.filter((node) => [...node.querySelectorAll('*')].some((inner) => clean(inner.innerText) === link.has));
        else if (link.css !== undefined) scopes = scopes.flatMap((node) => [...node.querySelectorAll(link.css)]);
        else return false;
    }
    return scopes.length === 1 && scopes[0] === element;
}
