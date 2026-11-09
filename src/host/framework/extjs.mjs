// Adapter fuer ExtJS (Config `"framework": "extjs"`). Stabile Ziele: Referenzen aus dem Snapshot und IDs wie ext-element-29 gelten
// nur fuer einen Seitenstand, und ExtJS-Buttons haben oft keinen zugaenglichen Namen. Stabil ist die Komponente: xtype plus Text oder
// Beschriftung, dazu das Teil-Element darin. Bereit ist die Seite, wenn kein Ext.Ajax-Request und kein Store mehr laedt.

/**
 * Laeuft im Browser, darf also nichts von aussen benutzen. `describe` beschreibt ein Element, `find` sucht es
 * wieder. Treffer zaehlen nur, wenn sie wirklich klickbar sind: sichtbar und nicht ueberdeckt. Damit warten
 * Schritte von selbst auf Lademasken und treffen bei Dialogen in Dialogen den obersten.
 */
export function extjsTargets(element, { mode, target }) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    const ownText = (node) => {
        const text = clean(node.innerText ?? node.textContent);
        return text.length <= 80 ? text : '';
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
        // Am Bildrand kann z. B. ein fester Cookie-Banner liegen, mittig ist das Element dann frei.
        node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        return onTop(node, component);
    };
    const named = (component) => {
        const text = clean(component.getText?.());
        const label = clean(component.getLabel?.());
        return { ...(text === '' ? {} : { text }), ...(label === '' ? {} : { label }) };
    };
    // Namenlose Teile wie der Pfeil einer Combobox: erkennbar erst ueber das Feld, zu dem sie gehoeren.
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
    // `all`: auch Treffer, die gerade verdeckt oder unsichtbar sind, etwa der gleiche Knopf im Formular unter einem Sheet.
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

    // Warum ein Ziel nicht klickbar ist: fehlt es, ist es unsichtbar, oder liegt ein schwebendes Fenster darueber, etwa eine Meldung?
    if (mode === 'explain') {
        const candidates = matches(target, true);
        const node = candidates[target.index ?? 0] ?? candidates[0];
        if (node === undefined) return { missing: true };
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true };
        node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        const now = node.getBoundingClientRect();
        const hit = document.elementFromPoint(now.left + now.width / 2, now.top + now.height / 2);
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
    // Namenlose Teile brauchen den Bereich immer. Benannte, sobald es dieselbe Beschreibung noch einmal gibt, auch verdeckt: Sonst
    // traefe das Abspielen den Zwilling, wenn der richtige noch nicht da ist, etwa `Speichern` im Formular statt im Sheet.
    const twins = component !== null && Object.keys(own).length > 0 && matches(plain, true).length > 1;
    const parent = component !== null && (Object.keys(own).length === 0 || twins) ? namedParent(component) : null;
    // Reihenfolge wie bisher, damit sich vorhandene Aufzeichnungen beim Neuschreiben nicht umstellen.
    const { part: _part, own: _own, ...head } = plain;
    const described = parent === null ? plain : { ...head, inside: { xtype: parent.xtype, ...named(parent) }, ...(part === undefined ? {} : { part }), ...(plain.own === undefined ? {} : { own: plain.own }) };
    const index = matches(described).indexOf(element);
    return index === -1 ? null : { ...described, ...(index === 0 ? {} : { index }) };
}

/**
 * Laeuft im Browser: der Zustand, der ueber Fehlschlag oder Nachbessern entscheidet. Die Anwendungen setzen an
 * ihren Dialogen kein Fehler-Merkmal, darum zaehlt jede sichtbare Meldung und wird gegen die Aufzeichnung geprueft.
 * Zahlen werden neutralisiert, damit Bestellnummern und Daten keinen Fehlschlag ausloesen.
 */
export function extjsPageState({ marker, selectors }) {
    const query = window.Ext?.ComponentQuery?.query?.bind(window.Ext.ComponentQuery);
    const components = (selector) => (query === undefined ? [] : query(selector)).filter((component) => !component.destroyed && component.isVisible?.() !== false);
    const seen = (node) => node !== null && node !== undefined && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const boxes = components('dialog, messagebox, toast').map((component) => component.el?.dom ?? component.element?.dom);
    // Meldungen der Seite ausserhalb der Anwendung, etwa eines umgebenden Portals: Selektoren aus der Config (`messageSelectors`).
    const alerts = selectors.length === 0 ? [] : [...document.querySelectorAll(selectors.join(', '))];
    // Der ganze Text, wie bei `web`: Gekuerzt wird erst beim Anzeigen.
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
 * Laeuft im Browser: offene Ext.Ajax-Requests und ladende Stores, mit `store` nur dieser (Store-Id oder ComponentQuery) samt Anzahl.
 * @returns { pendingAjax, loadingStores, counts, appReady }
 */
export function extjsProbe(store) {
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
    label: 'ExtJS',
    targets: extjsTargets,
    pageState: extjsPageState,
    probe: extjsProbe,
    // Ext.Ajax zaehlt selbst; offene Requests ausserhalb von Ext, etwa Long-Polling der umgebenden Seite, sollen das Warten nicht aufhalten.
    countNetwork: false,
    // Die Reihenfolge der schwebenden Fenster (Dialoge) fuer floats.log.
    floats: true,
    // Dateien des Frameworks reichen Fehler meist nur weiter: Die Herkunft ist der erste Eintrag ausserhalb.
    stackSkip: /\/ext-[\w-]*\.js/,
    // Lokaler Code braucht den Sencha-Watch: Er haelt bootstrap.json und die Pakete aktuell. Ohne ihn gilt der deployte Stand.
    watch: { label: 'Sencha-Watch', command: /\bapp["']?\s+["']?watch\b/i },
};
