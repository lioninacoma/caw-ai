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
//
// While Claude is attached to the run (record, a run with chat, open) the lock is closed for every request type (`reach`): the
// browser reaches only the environments, allowHosts (sign-in services among them) and thirdPartyHosts. A page Claude drives must
// not be able to send what it sees to any host; the Docker firewall only covers Claude's container, not this Chrome on the host.
// Again two mechanisms: the resolver makes every other name unresolvable (`MAP * ~NOTFOUND` with an EXCLUDE per allowed host),
// which covers what no route sees: WebSockets that no route handles, workers, preconnect and DNS prefetch (a DNS lookup alone can
// carry data out). A context route and a WebSocket route abort the requests first, so the run names the blocked host instead of
// showing a name-not-resolved error.
//
// Hosts are compared normalized (lower case, no trailing dot; Chrome resolves `prod.example.com.` like `prod.example.com`).
// Known limit: the lock knows names, not addresses. A production host reached by its IP address (or another name for the same
// address) is not blocked by name; without Claude only a production host is blocked, so this matters only for those.
import { normalizeHost } from '../shared/environments.mjs';
import { APP_FRAME } from './app-view.mjs';

// localhost and 127.0.0.1 are the same machine: a dev server under one name often opens its HMR socket under the other.
const LOOPBACK_PAIR = ['localhost', '127.0.0.1'];
/** As a navigation host: pages may navigate anywhere (explore, where the person signs in at an IdP); production stays blocked. */
export const ANY_HOST = '*';
export const withLoopbackPair = (hosts) => {
    const normalized = hosts.map(normalizeHost);
    return normalized.some((host) => LOOPBACK_PAIR.includes(host)) ? [...new Set([...normalized, ...LOOPBACK_PAIR])] : normalized;
};
const isLoopbackName = (host) => host === 'localhost' || host.endsWith('.localhost');

/**
 * Chrome flags of the lock. localhost and names under .localhost are loopback (RFC 6761) and pinned to 127.0.0.1, where a dev
 * server usually listens: Windows does not resolve .localhost itself. Production hosts come first, the first matching rule wins;
 * each also with a trailing dot, which Chrome resolves as the same host but the rule would not match. WebRTC would otherwise
 * bypass the resolver via UDP.
 * With `reach` (Claude attached) every name outside it is unresolvable. EXCLUDE takes a host out of every MAP rule (measured with the
 * system Chrome and Playwright 1.64.1), so allowed loopback names are pinned by their own MAP rule instead, and a production host is never excluded
 * (agentHosts leaves them out). IP addresses count too: an allowed 127.0.0.1 needs its EXCLUDE.
 * @param blocked production hosts of other environments
 * @param reach   every host the browser may reach (agentHosts), or undefined for any host but production
 */
export const browserArgs = (blocked = [], { reach } = {}) => {
    const production = blocked.map(normalizeHost).flatMap((host) => [`MAP ${host} ~NOTFOUND`, `MAP ${host}. ~NOTFOUND`]);
    const allowed = reach === undefined ? [] : withLoopbackPair(reach).filter((host) => host !== ANY_HOST);
    const rules = reach === undefined
        ? [...production, 'MAP localhost 127.0.0.1', 'MAP *.localhost 127.0.0.1']
        : [
            ...production,
            ...allowed.filter(isLoopbackName).map((host) => `MAP ${host} 127.0.0.1`),
            'MAP * ~NOTFOUND',
            ...allowed.filter((host) => !isLoopbackName(host)).map((host) => `EXCLUDE ${host}`),
        ];
    return [`--host-resolver-rules=${rules.join(', ')}`, '--no-proxy-server', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];
};

const hostOf = (url) => {
    try {
        return normalizeHost(new URL(url).hostname);
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
 * Whether a request may go out: 'allow', 'production' (a production host of another environment, any request type), 'navigation'
 * (a top-level navigation to another host) or 'agent' (with Claude attached, any request to a host outside `reach`).
 */
export const lockDecision = ({ url, topNavigation }, { navigation, blocked = [], reach }) => {
    const host = hostOf(url);
    if (host === '' || /^(data|blob|about|chrome|chrome-extension):/i.test(url)) return 'allow';
    if (blocked.map(normalizeHost).includes(host)) return 'production';
    if (topNavigation && !navigation.includes(ANY_HOST) && !withLoopbackPair(navigation).includes(host)) return 'navigation';
    if (reach !== undefined && !withLoopbackPair(reach).includes(host)) return 'agent';
    return 'allow';
};

const WEB = /^(https?|wss?):$/;

/**
 * Installs the lock on a browser context. Register it before other routes: routes registered later run first and fall back to it.
 * @param navigation the navigation hosts
 * @param blocked    production hosts of other environments
 * @param reach      with Claude attached: every host the browser may reach (agentHosts); launch Chrome with the same reach
 * @param onBlocked  ({ host, url, kind: 'navigation'|'redirect'|'production'|'agent', request }) for the report and explore;
 *                   request is undefined for a WebSocket
 */
export const installHostLock = async (context, { navigation, blocked = [], reach, onBlocked = () => {} }) => {
    const allowed = new Set(withLoopbackPair(navigation));
    const reachable = reach === undefined ? null : new Set(withLoopbackPair(reach));
    const production = new Set(blocked.map(normalizeHost));
    const anywhere = allowed.has(ANY_HOST);
    const aborted = new WeakSet();
    const outside = (host) => (anywhere ? production.has(host) : !allowed.has(host)) || (reachable !== null && !reachable.has(host));
    // Only requests to other hosts reach the handler; everything for the app's own hosts stays on Playwright's fast path.
    await context.route((url) => WEB.test(url.protocol) && outside(normalizeHost(url.hostname)), async (route) => {
        const request = route.request();
        const decision = lockDecision({ url: request.url(), topNavigation: isTopNavigation(request) }, { navigation, blocked, reach });
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
    // With Claude attached, a WebSocket outside the reach that no later route handles is closed before it connects, and named (the
    // resolver blocks it anyway). Without Claude no WebSocket route: Playwright would wrap every page's WebSocket for it.
    if (reachable !== null) {
        await context.routeWebSocket((url) => !reachable.has(normalizeHost(url.hostname)), (ws) => {
            onBlocked({ host: hostOf(ws.url()), url: ws.url(), kind: production.has(hostOf(ws.url())) ? 'production' : 'agent', request: undefined });
            ws.close({ code: 1008, reason: 'blocked by caw' }).catch(() => {});
        });
    }
    context.on('request', (request) => {
        if (request.redirectedFrom() === null) return;
        const host = hostOf(request.url());
        // A redirect hop: the route only saw the first address. With Claude attached the resolver stops a hop outside its reach.
        if (reachable !== null && !reachable.has(host) && !production.has(host)) {
            onBlocked({ host, url: request.url(), kind: 'agent', request });
            return;
        }
        if (anywhere || !isTopNavigation(request) || allowed.has(host)) return;
        onBlocked({ host, url: request.url(), kind: 'redirect', request });
    });
    return {
        /** Did the lock abort this request? Its requestfailed event is then no application error. */
        aborted: (request) => aborted.has(request),
    };
};
