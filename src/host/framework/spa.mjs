// Thin adapters for React, Vue and Angular on top of `web`. Targets remain ARIA, name, `data-testid` and `inside`; none of them uses
// generated classes and ids (`_ngcontent-…`, CSS module hashes, `:r1:` from `useId`). Per framework they add:
// - `component` (and `source` where the framework knows it) when describing a target, only as a hint: `find` ignores it, it
//   leads Claude to the file on an application error. Only dev builds carry the names; production builds lack the hint.
// - Readiness: the framework has mounted the application, Angular is also stable (Zone.js), otherwise `web`'s DOM quiet applies.
// - `stackSkip`: framework files, so the first own line in the stack is the application's.
// - `hints`: where Claude typically looks in the source code and what checks look like without a global store.

import { DOM_QUIET_MS, web, webBusy, webCount, webTargets } from './web.mjs';

/**
 * Runs in the browser: the components the element belongs to, outermost first, at most three. The innermost alone would usually be
 * a building block like `Button`; only the owner (the component rendering it, `_debugOwner` in dev builds) leads to the file.
 */
function reactComponent(element) {
    const NAME = /^[A-Z][\w$]*$/;
    const nameOf = (fiber) => {
        const type = fiber?.type;
        if (type === null || type === undefined || typeof type === 'string') return null;
        // memo and forwardRef wrap the component.
        const inner = type.render ?? type.type ?? type;
        const name = type.displayName ?? inner.displayName ?? inner.name;
        return typeof name === 'string' && NAME.test(name) ? name : null;
    };
    for (let node = element; node !== null; node = node.parentElement) {
        const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactFiber$'));
        if (key === undefined) continue;
        const names = [];
        // Owners where React knows them; otherwise the next component above in the tree.
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
        // As with React the chain from outside in; `source` is the innermost file of the application, not of a library.
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
    // Minified classes are named like `t` or `_a`.
    return typeof name === 'string' && name.length > 2 && !/^_/.test(name) ? { component: name } : null;
}

/** Targets like `web`, with the component added when describing. */
const withComponent = (hint) => new Function('element', 'options', `
    const found = (${webTargets})(element, options);
    if (options.mode !== 'describe' || found === null) return found;
    let extra = null;
    try { extra = (${hint})(element); } catch { extra = null; }
    return extra === null ? found : { ...found, ...extra };
`);

/** Readiness: `mounted` tells whether the framework has mounted the application; `stable` (optional) whether it has settled. */
const probeWith = (mounted, stable = '() => true') => new Function('store', `
    let busy = (${webBusy})({ domQuietMs: ${DOM_QUIET_MS} });
    let ready = false;
    try { ready = document.readyState === 'complete' && (${mounted})(); } catch { ready = false; }
    try { if (ready && !(${stable})()) busy += 1; } catch { /* without an answer, DOM quiet applies */ }
    const counts = (${webCount})(store);
    return { pendingAjax: 0, loadingStores: busy, counts, appReady: ready };
`);

// Where the framework mounts the application. Searches the first elements, not just #root or #app. With SSR and
// hydrateRoot(document, …) the container is the document itself (Next.js App Router, React Router in framework mode, Remix).
const REACT_MOUNTED = `() => [document, ...document.querySelectorAll('html, body, body *')].slice(0, 300).some((node) => Object.keys(node).some((key) => key.startsWith('__reactContainer$')) && node.childNodes.length > 0)`;
const VUE_MOUNTED = `() => document.querySelector('[data-v-app]') !== null || [...document.querySelectorAll('body *')].slice(0, 300).some((node) => node.__vue_app__ !== undefined)`;
// With SSR, ng-version is already in the server HTML; Angular removes `ngh` from the root element only when hydrating.
const ANGULAR_MOUNTED = `() => { const root = document.querySelector('[ng-version]'); return root !== null && !root.hasAttribute('ngh'); }`;
// Zone.js reports via Testability whether tasks are still running. Without Zone.js (zoneless) the function is missing; DOM quiet suffices then.
const ANGULAR_STABLE = `() => typeof window.getAllAngularTestabilities !== 'function' || window.getAllAngularTestabilities().every((testability) => testability.isStable())`;

export const react = {
    ...web,
    name: 'react',
    label: 'die React-Anwendung',
    targets: withComponent(reactComponent),
    probe: probeWith(REACT_MOUNTED),
    // The login page is usually part of the app and not usable before hydration with SSR; login waits for the mount.
    hydrates: true,
    stackSkip: /\/(react-dom|react|scheduler)[\w.-]*\.js|\/node_modules\/\.vite\/deps\/(react|scheduler)|\/node_modules\/(react-dom|react|scheduler)\//,
    hints: [
        'Requests usually live in hooks (useEffect, React Query/SWR) or an api file using fetch/axios; searching for the request name from the network log leads to the spot.',
        '`component` in the target is the name of the React component; the file is usually named the same.',
        'There is no global store like Ext.getStore: check via visible text, ARIA or the responses in the network log.',
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
        'Requests usually live in composables (use…), Pinia stores or an api file; searching for the request name leads to the spot.',
        '`source` in the target is the path of the single-file component, `component` its name.',
        'Check via visible text, ARIA or the responses in the network log; Pinia stores are reachable from outside only in a dev build.',
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
        'Requests live in services using HttpClient; searching for the request name leads to the spot, `component` in the target to the component (class …Component).',
        'An aborted request right after a route change belongs to the router (the tool does not count it as a failure); without a route change it is often an unsubscribe or takeUntil.',
        'Check via visible text, ARIA or the responses in the network log.',
        'Readiness from Zone.js needs Testability; a standalone app (bootstrapApplication) only offers it with provideProtractorTestingSupport(), otherwise DOM quiet counts.',
    ],
};
