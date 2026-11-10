// Duenne Adapter fuer React, Vue und Angular auf Basis von `web`. Ziele bleiben ARIA, Name, `data-testid` und `inside`; erzeugte
// Klassen und ids (`_ngcontent-…`, CSS-Module-Hashes, `:r1:` aus `useId`) nutzt keiner. Dazu kommen je Framework:
// - `component` (und `source`, wo das Framework ihn kennt) beim Beschreiben eines Ziels, nur als Hinweis: `find` wertet ihn nicht aus,
//   er fuehrt Claude bei einem Anwendungsfehler zur Datei. Nur Dev-Builds tragen die Namen; im Produktions-Build fehlt der Hinweis.
// - Bereitschaft: das Framework hat die Anwendung eingehaengt, Angular zusaetzlich stabil (Zone.js), sonst gilt die DOM-Ruhe von `web`.
// - `stackSkip`: Dateien des Frameworks, damit die erste eigene Zeile im Stack die der Anwendung ist.
// - `hints`: wo Claude im Quellcode typischerweise sucht und wie Pruefungen ohne globalen Store aussehen.

import { DOM_QUIET_MS, web, webBusy, webCount, webTargets } from './web.mjs';

/**
 * Laeuft im Browser: die Komponenten, zu denen das Element gehoert, von aussen nach innen, hoechstens drei. Allein waere die innerste
 * meist ein Baustein wie `Button`; erst der Besitzer (die Komponente, die ihn rendert, `_debugOwner` im Dev-Build) fuehrt zur Datei.
 */
function reactComponent(element) {
    const NAME = /^[A-Z][\w$]*$/;
    const nameOf = (fiber) => {
        const type = fiber?.type;
        if (type === null || type === undefined || typeof type === 'string') return null;
        // memo und forwardRef verpacken die Komponente.
        const inner = type.render ?? type.type ?? type;
        const name = type.displayName ?? inner.displayName ?? inner.name;
        return typeof name === 'string' && NAME.test(name) ? name : null;
    };
    for (let node = element; node !== null; node = node.parentElement) {
        const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactFiber$'));
        if (key === undefined) continue;
        const names = [];
        // Besitzer, wo React sie kennt; sonst die naechste Komponente darueber im Baum.
        let fiber = node[key]._debugOwner;
        if (fiber === undefined) for (fiber = node[key].return; fiber && nameOf(fiber) === null; fiber = fiber.return);
        for (; fiber && names.length < 3; fiber = fiber._debugOwner) {
            const name = nameOf(fiber);
            if (name !== null && !names.includes(name)) names.push(name);
        }
        return names.length === 0 ? null : { component: names.reverse().join(' › ') };
    }
    return null;
}

function vueComponent(element) {
    for (let node = element; node !== null; node = node.parentElement) {
        const instance = node.__vueParentComponent;
        if (instance === undefined) continue;
        // Wie bei React die Kette von aussen nach innen; `source` ist die innerste Datei der Anwendung, nicht einer Bibliothek.
        const names = [];
        let source;
        for (let current = instance; current && names.length < 3; current = current.parent) {
            const type = current.type ?? {};
            const file = typeof type.__file === 'string' ? type.__file : undefined;
            const name = type.__name ?? type.name ?? (file === undefined ? undefined : file.split(/[\\/]/).pop().replace(/\.vue$/, ''));
            if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name);
            if (source === undefined && file !== undefined && !/node_modules/.test(file)) source = file;
        }
        return names.length === 0 ? null : { component: names.reverse().join(' › '), ...(source === undefined ? {} : { source }) };
    }
    return null;
}

function angularComponent(element) {
    const ng = window.ng;
    if (typeof ng?.getOwningComponent !== 'function') return null;
    const owner = ng.getComponent?.(element) ?? ng.getOwningComponent(element);
    const name = owner?.constructor?.name;
    // Minifizierte Klassen heissen etwa `t` oder `_a`.
    return typeof name === 'string' && name.length > 2 && !/^_/.test(name) ? { component: name } : null;
}

/** Ziele wie `web`, beim Beschreiben ergaenzt um die Komponente. */
const withComponent = (hint) => new Function('element', 'options', `
    const found = (${webTargets})(element, options);
    if (options.mode !== 'describe' || found === null) return found;
    let extra = null;
    try { extra = (${hint})(element); } catch { extra = null; }
    return extra === null ? found : { ...found, ...extra };
`);

/** Bereitschaft: `mounted` sagt, ob das Framework die Anwendung eingehaengt hat; `stable` (optional), ob es fertig gerechnet hat. */
const probeWith = (mounted, stable = '() => true') => new Function('store', `
    let busy = (${webBusy})({ domQuietMs: ${DOM_QUIET_MS} });
    let ready = false;
    try { ready = document.readyState === 'complete' && (${mounted})(); } catch { ready = false; }
    try { if (ready && !(${stable})()) busy += 1; } catch { /* ohne Auskunft gilt die DOM-Ruhe */ }
    const counts = (${webCount})(store);
    return { pendingAjax: 0, loadingStores: busy, counts, appReady: ready };
`);

// Wo das Framework die Anwendung einhaengt. Gesucht wird unter den ersten Elementen, nicht nur in #root bzw. #app. Bei SSR mit
// hydrateRoot(document, …) ist der Container das Dokument selbst (Next.js App Router, React Router im Framework-Modus, Remix).
const REACT_MOUNTED = `() => [document, ...document.querySelectorAll('html, body, body *')].slice(0, 300).some((node) => Object.keys(node).some((key) => key.startsWith('__reactContainer$')) && node.childNodes.length > 0)`;
const VUE_MOUNTED = `() => document.querySelector('[data-v-app]') !== null || [...document.querySelectorAll('body *')].slice(0, 300).some((node) => node.__vue_app__ !== undefined)`;
// Bei SSR steht ng-version schon im HTML vom Server; das `ngh` am Wurzelelement entfernt Angular erst beim Hydrieren.
const ANGULAR_MOUNTED = `() => { const root = document.querySelector('[ng-version]'); return root !== null && !root.hasAttribute('ngh'); }`;
// Zone.js meldet ueber Testability, ob noch Aufgaben laufen. Ohne Zone.js (zoneless) gibt es die Funktion nicht, dann reicht die DOM-Ruhe.
const ANGULAR_STABLE = `() => typeof window.getAllAngularTestabilities !== 'function' || window.getAllAngularTestabilities().every((testability) => testability.isStable())`;

export const react = {
    ...web,
    name: 'react',
    label: 'die React-Anwendung',
    targets: withComponent(reactComponent),
    probe: probeWith(REACT_MOUNTED),
    // Die Anmeldeseite ist meist Teil der App und bei SSR vor der Hydration nicht bedienbar; die Anmeldung wartet auf das Einhaengen.
    hydrates: true,
    stackSkip: /\/(react-dom|react|scheduler)[\w.-]*\.js|\/node_modules\/\.vite\/deps\/(react|scheduler)|\/node_modules\/(react-dom|react|scheduler)\//,
    hints: [
        'Requests stehen meist in Hooks (useEffect, React Query/SWR) oder einer api-Datei mit fetch/axios; der Request-Name aus dem Netzwerkprotokoll führt per Suche zur Stelle.',
        '`component` im Ziel ist der Name der React-Komponente; die Datei heißt meist genauso.',
        'Einen globalen Store wie Ext.getStore gibt es nicht: Prüfungen über sichtbaren Text, ARIA oder die Antworten im Netzwerkprotokoll.',
    ],
};

export const vue = {
    ...web,
    name: 'vue',
    label: 'die Vue-Anwendung',
    targets: withComponent(vueComponent),
    probe: probeWith(VUE_MOUNTED),
    hydrates: true,
    stackSkip: /\/(@vue|vue|vue-router|pinia)[\w./-]*\.js|\/node_modules\/\.vite\/deps\/(vue|@vue|pinia)|\/node_modules\/(@vue|vue|vue-router|pinia)\//,
    hints: [
        'Requests stehen meist in Composables (use…), Pinia-Stores oder einer api-Datei; der Request-Name führt per Suche zur Stelle.',
        '`source` im Ziel ist der Pfad der Single-File-Component, `component` ihr Name.',
        'Prüfungen über sichtbaren Text, ARIA oder die Antworten im Netzwerkprotokoll; Pinia-Stores sind von außen nur im Dev-Build erreichbar.',
    ],
};

export const angular = {
    ...web,
    name: 'angular',
    label: 'die Angular-Anwendung',
    targets: withComponent(angularComponent),
    probe: probeWith(ANGULAR_MOUNTED, ANGULAR_STABLE),
    hydrates: true,
    stackSkip: /\/(zone|polyfills)[\w.-]*\.js|\/@angular\/|\/node_modules\/\.vite\/deps\/(@angular|zone|rxjs)|\/node_modules\/(@angular|zone\.js|rxjs)\//,
    hints: [
        'Requests stehen in Services mit HttpClient; der Request-Name führt per Suche zur Stelle, `component` im Ziel zur Komponente (Klasse …Component).',
        'Ein abgebrochener Request kurz nach einem Routenwechsel gehört zum Router (das Tool wertet ihn nicht als Fehler); ohne Routenwechsel ist es oft ein unsubscribe oder takeUntil.',
        'Prüfungen über sichtbaren Text, ARIA oder die Antworten im Netzwerkprotokoll.',
        'Die Bereitschaft laut Zone.js gibt es nur mit Testability; eine Standalone-App (bootstrapApplication) bietet sie erst mit provideProtractorTestingSupport(), sonst zählt die DOM-Ruhe.',
    ],
};
