// The browser's host lock (spec §2.8). Pages navigate only to navigation hosts: the run's environment, the other non-production
// environments and allowHosts. Scripts, styles, fonts, images, XHR/fetch, WebSockets and iframes may go to any host (third-party
// hosts), except production hosts of other environments, which stay unreachable for every request type.
//
// Two mechanisms, because neither covers everything alone (measured with Playwright 1.64.1):
// - Chrome's resolver makes production hosts unresolvable: every request type, every redirect hop, WebSockets included. It needs
//   --no-proxy-server, since through a proxy Chrome does not resolve names itself.
// - A context route aborts top-level document navigations (links, form posts, location changes, the first navigation of a popup)
//   to other hosts. A route only sees the first URL of a redirect chain, so a redirect hop onto another host is caught from the
//   request event: the navigation then counts as blocked, although the browser already loaded that page.
import { APP_FRAME } from './app-view.mjs';

// localhost and 127.0.0.1 are the same machine: a dev server under one name often opens its HMR socket under the other.
const LOOPBACK_PAIR = ['localhost', '127.0.0.1'];
/** As a navigation host: pages may navigate anywhere (explore, where the person signs in at an IdP); production stays blocked. */
export const ANY_HOST = '*';
export const withLoopbackPair = (hosts) => (hosts.some((host) => LOOPBACK_PAIR.includes(host)) ? [...new Set([...hosts, ...LOOPBACK_PAIR])] : hosts);

/**
 * Chrome flags of the lock. localhost and names under .localhost are loopback (RFC 6761) and pinned to 127.0.0.1, where a dev
 * server usually listens: Windows does not resolve .localhost itself. Production hosts come first, the first matching rule wins.
 * WebRTC would otherwise bypass the resolver via UDP.
 * @param blocked production hosts of other environments
 */
export const browserArgs = (blocked = []) => [
    `--host-resolver-rules=${[
        ...blocked.map((host) => `MAP ${host} ~NOTFOUND`),
        'MAP localhost 127.0.0.1',
        'MAP *.localhost 127.0.0.1',
    ].join(', ')}`,
    '--no-proxy-server',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
];

const hostOf = (url) => {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
};

/**
 * Is the request a document navigation of a tab's top frame (or of the application frame in the workbench)? A popup's first
 * navigation arrives before its frame exists: that is a top-level navigation too.
 */
export const isTopNavigation = (request) => {
    if (request.resourceType() !== 'document' || !request.isNavigationRequest()) return false;
    try {
        const frame = request.frame();
        return frame.parentFrame() === null || frame.name() === APP_FRAME;
    } catch {
        return true;
    }
};

/**
 * Whether a request may go out: 'allow', 'navigation' (a top-level navigation to another host) or 'production' (a production
 * host of another environment, any request type).
 */
export const lockDecision = ({ url, topNavigation }, { navigation, blocked = [] }) => {
    const host = hostOf(url);
    if (host === '' || /^(data|blob|about|chrome|chrome-extension):/i.test(url)) return 'allow';
    if (blocked.includes(host)) return 'production';
    if (topNavigation && !navigation.includes(ANY_HOST) && !withLoopbackPair(navigation).includes(host)) return 'navigation';
    return 'allow';
};

/**
 * Installs the lock on a browser context. Register it before other routes: routes registered later run first and fall back to it.
 * @param navigation the navigation hosts
 * @param blocked    production hosts of other environments
 * @param onBlocked  ({ host, url, kind: 'navigation'|'redirect'|'production', request }) for the report and explore
 */
export const installHostLock = async (context, { navigation, blocked = [], onBlocked = () => {} }) => {
    const allowed = new Set(withLoopbackPair(navigation));
    const anywhere = allowed.has(ANY_HOST);
    const aborted = new WeakSet();
    // Only requests to other hosts reach the handler; everything for the app's own hosts stays on Playwright's fast path.
    await context.route((url) => (anywhere ? blocked.includes(url.hostname) : !allowed.has(url.hostname)) && /^(https?|wss?):$/.test(url.protocol), async (route) => {
        const request = route.request();
        const decision = lockDecision({ url: request.url(), topNavigation: isTopNavigation(request) }, { navigation, blocked });
        if (decision === 'allow') {
            await route.fallback();
            return;
        }
        aborted.add(request);
        onBlocked({ host: hostOf(request.url()), url: request.url(), kind: decision, request });
        // A navigation aborted as ERR_ABORTED is cancelled like a stopped load: the tab keeps the app's page (and its state)
        // instead of Chrome's error page. Other requests to production fail like a blocked request.
        await route.abort(decision === 'navigation' ? 'aborted' : 'blockedbyclient').catch(() => {});
    });
    context.on('request', (request) => {
        if (anywhere || request.redirectedFrom() === null || !isTopNavigation(request) || allowed.has(hostOf(request.url()))) return;
        onBlocked({ host: hostOf(request.url()), url: request.url(), kind: 'redirect', request });
    });
    return {
        /** Did the lock abort this request? Its requestfailed event is then no application error. */
        aborted: (request) => aborted.has(request),
    };
};

