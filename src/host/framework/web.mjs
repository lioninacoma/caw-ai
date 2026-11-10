// Adapter fuer jede Webanwendung, ohne Wissen ueber ein Framework (Config `"framework": "web"`, der Standard). Ziele beschreibt er
// wie ein Mensch mit Screenreader: Rolle und zugaenglicher Name, dazu `data-testid` und der benannte Bereich darum (`inside`).
// Bereit ist die Seite, wenn kein Request der Anwendung mehr offen ist, nichts `aria-busy` traegt, kein unbestimmter Fortschritt
// laeuft und das DOM kurz still steht. Offene Shadow Roots (Web Components, Angular mit ShadowDom, Lit, Ionic) zaehlen mit.

/**
 * Laeuft im Browser, darf also nichts von aussen benutzen. `describe` beschreibt ein Element, `find` sucht es wieder. Treffer zaehlen
 * nur, wenn sie wirklich klickbar sind: sichtbar und nicht ueberdeckt.
 */
export function webTargets(element, { mode, target, exact = false }) {
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
    // Wie TARGET_TEXT_MAX: Laengere Texte waeren kein stabiles Ziel. Ein Muster prueft dagegen den ganzen Text.
    const short = (text) => (text.length <= 80 ? text : '');
    // Shadow DOM: Eltern ueber die Grenze hinweg, Suche in allen offenen Shadow Roots.
    const parentOf = (node) => node.parentElement ?? (node.getRootNode?.() instanceof ShadowRoot ? node.getRootNode().host : null);
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
    // Rollen, deren Name aus dem Inhalt kommt; bei Feldern zaehlt nur die Beschriftung, nie der Wert.
    const CONTENT_NAMED = new Set(['button', 'link', 'tab', 'menuitem', 'option', 'heading', 'checkbox', 'radio', 'switch', 'treeitem', 'cell', 'gridcell', 'columnheader']);
    // Die Beschriftung ohne die Felder darin: Ein <select> im <label> braechte sonst alle Optionen in den Namen, und jede neue Option
    // braeche das Wiederfinden.
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
    // Der naechste benannte Bereich: unterscheidet gleiche Knoepfe in verschiedenen Dialogen oder Zeilen.
    // Mit `full` auch der ganze Name (`whole`), fuer ein Muster im Bereich.
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
    // Was an dieser Stelle oben liegt, auch innerhalb von Shadow Roots.
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
        node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        return onTop(node);
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
    // Ein Wert des Ziels ist fest oder ein Muster {pattern}. Das Muster prueft den ganzen Text, auch ueber der Laengengrenze, etwa
    // einen Knopf mit wechselnder Zahl ("Prüfen 3") oder einen langen Namen ueber seinen Anfang.
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

    // Virtualisierte Listen (CDK Virtual Scroll, react-window, vue-virtual-scroller) haben nur die sichtbaren Zeilen im DOM. Fehlt eine
    // Zeile oder ein Ziel darin, rollt jede Suche die Liste ein Stueck weiter, bis es auftaucht oder das Ende erreicht ist.
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

    // Warum ein Ziel nicht klickbar ist: fehlt es, ist es unsichtbar, oder liegt etwas darueber, etwa ein offener Dialog mit Meldung?
    if (mode === 'explain') {
        const candidates = deepAll(target.tag ?? ACTIONABLE).filter((node) => fitsKeys(target, node, describeNode(node)));
        // Derselbe Bereich wie beim Suchen: Ein unsichtbarer Zwilling anderswo, etwa die mobile Navigation, erklaert nichts.
        const inArea = candidates.filter((node) => fitsInside(target.inside, node, describeNode(node)));
        if (inArea.length === 0) {
            if (candidates.length > 0) return { elsewhere: true };
            // Fehlt es ganz: die Namen sichtbarer Elemente derselben Rolle, daraus waehlt der Host aehnliche, etwa einen umbenannten Knopf.
            const names = target.role === undefined ? [] : [...new Set(deepAll(ACTIONABLE).filter((node) => node.getClientRects().length > 0)
                .map(describeNode).filter((seen) => seen.role === target.role && seen.name).map((seen) => seen.name))].slice(0, 80);
            return { missing: true, names };
        }
        const node = inArea[target.index ?? 0] ?? inArea[0];
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || style.display === 'none') return { hidden: true };
        node.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        const now = node.getBoundingClientRect();
        const hit = hitAt(now.left + now.width / 2, now.top + now.height / 2);
        if (hit === null || deepContains(node, hit) || deepContains(hit, node)) return { elsewhere: candidates.length > 0 && target.inside !== undefined };
        const layer = deepClosest(hit, 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]');
        const cover = layer ?? hit;
        const heading = deepAll('h1, h2, h3, [role=heading]', cover)[0] ?? null;
        const coverName = nameOf(cover) || (heading === null ? '' : short(clean(heading.innerText)));
        // Auch ohne Rolle: der Hintergrund eines modalen Dialogs liegt ueber der ganzen Seite.
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

    // Das Bedienelement, zu dem der Klick gehoert: etwa der Knopf um ein Icon. Mit `exact` das Element selbst, etwa ein iframe: Sonst
    // stuende statt seiner der Dialog oder Bereich mit Rolle darum im Ziel, und darin liegt kein Frame.
    const node = exact ? element : deepClosest(element, 'button, a[href], input, select, textarea, summary, [data-testid], [role]') ?? element;
    const described = describeNode(node);
    const index = matches(described).indexOf(node);
    return index === -1 ? null : { ...described, ...(index === 0 ? {} : { index }) };
}

/**
 * Laeuft im Browser: Was gerade laedt, auch in offenen Shadow Roots. `aria-busy`, ein unbestimmter Fortschritt (`role=progressbar`
 * ohne `aria-valuenow`, so zeichnen Material, MUI und Vuetify ihre Spinner) und, mit `domQuietMs`, ein DOM, das sich gerade aendert.
 * Muss als eine Funktion ohne Abhaengigkeiten laufen, darum steckt alles darin.
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
    // Das DOM rendert nach einem Request oft noch nach (Change Detection, Suspense, nextTick). Der Beobachter haengt sich beim
    // ersten Aufruf an und zaehlt nur neue oder geaenderte Knoten, keine Attribute: Eine Uhr oder ein Spinner laesst sonst nie Ruhe.
    // Ein Beobachter am Dokument sieht nicht in Shadow Roots: Jede offene Root bekommt einen eigenen, auch spaeter entstandene.
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

/** Laeuft im Browser: Zustand der Seite ohne Framework. Meldungen aus `selectors` und modale Dialoge, Zahlen als #. */
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
    // Ein modaler Dialog ist eine Meldung, wenn er etwas mitteilt oder bestaetigen laesst. Ein Formular im Dialog (Eingabefelder ausser
    // Haken) ist Bedienung der Anwendung, keine Meldung: Als bekannte Meldung verdeckte es sonst spaeter echte Meldungen.
    const FIELDS = 'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true]';
    const isForm = (node) => node.getAttribute('role') !== 'alertdialog' && deepAll(FIELDS, node).some(seen);
    const modal = deepAll('dialog[open], [role=dialog][aria-modal=true], [role=alertdialog]').filter((node) => !isForm(node));
    const alerts = selectors.length === 0 ? [] : deepAll(selectors.join(', '));
    // Text Knoten fuer Knoten mit Leerzeichen: innerText klebt Inline-Elemente aneinander ("Ich weiß" + Knopf "Auflösen").
    // Offene Shadow Roots mit: Eine Meldung als Web Component traegt ihren Text oft nur dort.
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
        return parts.join(' ').replace(/\s+/g, ' ').replace(/ ([.,;:!?)\]“”"])/g, '$1').replace(/([(\[„]) /g, '$1').trim();
    };
    // Ein Container wie ein Toast-Stapel (`aria-live` um mehrere Toasts) ist keine Meldung, jedes sichtbare Kind ist eine. Sonst
    // entstuende je nach Timing eine neue Kombination ("angelegt. Gespeichert"), die nie bekannt ist.
    const ownText = (node) => [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.data.trim() !== '');
    // Was selbst eine Meldung ist (role alert/status), bleibt ganz, auch wenn Text und Knoepfe eigene Bloecke sind.
    const split = (node) => {
        if (['alert', 'status', 'alertdialog'].includes(node.getAttribute('role'))) return [node];
        const children = [...node.children].filter(seen);
        const blocks = children.every((child) => !getComputedStyle(child).display.startsWith('inline'));
        return children.length > 1 && blocks && !ownText(node) && deepClosest(node, 'dialog, [role=dialog], [role=alertdialog]') === null ? children : [node];
    };
    // Ein Statushinweis (role=status, eine hoefliche Live-Region) teilt nur mit, was gerade geschieht, und kommt je nach Tempo oder
    // nicht. Unbekannt warnt er nur. Fehler (role=alert, assertive) und Dialoge sind Meldungen: Unbekannt lassen sie den Schritt scheitern.
    const isNote = (node) => !modal.includes(node) && deepClosest(node, '[role=alert], [role=alertdialog], [aria-live=assertive]') === null
        && deepClosest(node, '[role=status], [role=log], [role=timer], [role=progressbar], [aria-live=polite]') !== null;
    // Der ganze Text: Nur so trifft eine lange Meldung ihren Eintrag in knownMessages. Gekuerzt wird erst beim Anzeigen.
    const read = (node) => readable(node).replace(/\d+/g, '#');
    const shown = [...modal, ...alerts.flatMap(split)].filter(seen);
    const texts = shown.filter((node) => !isNote(node)).map(read);
    const notes = shown.filter(isNote).map(read);
    return {
        appLoaded: document.readyState === 'complete',
        // Erst das Dokument selbst, nur ohne Treffer alle Shadow Roots: Der Zustand wird bei jedem Schritt gelesen.
        signedIn: marker === undefined || marker === null ? true : document.querySelector(marker) !== null || deepAll(marker).length > 0,
        loading: deepAll('[aria-busy=true], [role=progressbar]:not([aria-valuenow])').some(seen),
        path: location.pathname,
        messages: [...new Set(texts)].filter((text) => text !== ''),
        notes: [...new Set(notes)].filter((text) => text !== '' && !texts.includes(text)),
    };
}

/** Laeuft im Browser: die sichtbaren Treffer eines Selektors, auch in offenen Shadow Roots; null ohne Selektor. */
export function webCount(store) {
    if (store === null || store === undefined) return null;
    const deepAll = (selector, root = document) => {
        const found = [...root.querySelectorAll(selector)];
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) found.push(...deepAll(selector, host.shadowRoot));
        return found;
    };
    return deepAll(store).filter((node) => node.getClientRects().length > 0).length;
}

/** So lang darf ein Name oder Text sein, damit er als Ziel zaehlt; `webTargets` liest laengere als leer. */
export const TARGET_TEXT_MAX = 80;

/** Wie lange das DOM still stehen muss, bevor der Adapter `web` die Seite fuer ruhig haelt. */
export const DOM_QUIET_MS = 150;

/**
 * Laeuft im Browser: was noch laedt. Offene Requests zaehlt der Host aus dem Netzwerkprotokoll dazu. Mit `store` (ein CSS-Selektor)
 * zaehlt `counts` die sichtbaren Treffer, etwa Zeilen einer Liste. `busy` ist `webBusy` als Text, denn die Funktion laeuft im Browser.
 */
export const webProbe = new Function('store', `
    const busy = (${webBusy})({ domQuietMs: ${DOM_QUIET_MS} });
    const counts = (${webCount})(store);
    return { pendingAjax: 0, loadingStores: busy, counts, appReady: document.readyState === 'complete' };
`);

/** Meldungen der Seite: Fehler, Warnungen und, als Hinweis, Statusmeldungen wie Toasts und Snackbars. */
export const WEB_MESSAGE_SELECTORS = ['[role=alert]', '[role=alertdialog]', '[role=status]'];

export const web = {
    name: 'web',
    label: 'die Anwendung',
    targets: webTargets,
    pageState: webPageState,
    probe: webProbe,
    messageSelectors: WEB_MESSAGE_SELECTORS,
    countNetwork: true,
    floats: false,
    stackSkip: null,
};
