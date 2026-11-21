// The application inside the workbench iframe: the workbench (plan, chat, requests) and the application share one window.
//
// The workbench is served at the application's own address, i.e. on its origin. Applications often access the top window
// (`top.Ext`, `parent.config`, `top.location`). In the portal that is the application, here it is the workbench. Therefore:
// - same origin: the browser does not block such access;
// - the workbench passes through global names of the application that it does not have itself (`top.Ext` is the app's Ext);
// - its address follows the application (`top.location.href` is correct);
// - if the application navigates the top window (`top.location = …`, a form with target=_top, also POST), the page lands in
//   the application and the workbench stays.
// The tool serves the workbench: only the top window's document is intercepted, no other request.
//
// So the application can be embedded, the test browser strips X-Frame-Options and frame-ancestors from the documents of the
// application's hosts, only in this browser, only for document requests and only for the application iframe itself: frames
// the application or a page opens inside it keep their headers. This happens at Chrome's response stage: no second
// request, Chrome's network stack and host block still apply, redirects and cookies stay as they are.

export const APP_FRAME = 'caw-app';
/** Name of the chat frame in the workbench (workbench.mjs: CHAT_FRAME). */
export const CHAT_FRAME_NAME = 'caw-chat';

/** Name under which workbench and chat scripts appear in console and stacks, so their messages never count for the application. */
export const WORKBENCH_SOURCE = 'caw-workbench.js';
export const sourceTag = `\n//# sourceURL=${WORKBENCH_SOURCE}\n`;

/** Runs in the browser: is this document the workbench itself? Tool scripts that run in every frame skip it. */
export const isWorkbenchDocument = 'window.__cawWorkbench === true';

/** With the workbench, the top window of its tab is the workbench. Only for that tab, not for the application's popups. */
export const WORKBENCH_MARK_SCRIPT = 'if (window === window.top) Object.defineProperty(window, "__cawWorkbench", { value: true });';

/** Does a message (file or stack) come from the workbench or the chat? */
export const fromWorkbenchSource = (text) => typeof text === 'string' && (text.includes(WORKBENCH_SOURCE) || text === 'about:srcdoc');

/**
 * The headers without what forbids embedding: X-Frame-Options entirely, and only frame-ancestors from the CSP.
 * @param headers [{ name, value }] as in the CDP protocol
 * @returns the new headers, or null if nothing changes
 */
export const embeddableHeaders = (headers) => {
    let changed = false;
    const result = [];
    for (const { name, value } of headers) {
        const lower = name.toLowerCase();
        if (lower === 'x-frame-options') {
            changed = true;
            continue;
        }
        if (lower === 'content-security-policy' && /frame-ancestors/i.test(value)) {
            changed = true;
            const rest = value.split(';').filter((part) => !/^\s*frame-ancestors\b/i.test(part)).join(';').trim();
            if (rest !== '') result.push({ name, value: rest });
            continue;
        }
        result.push({ name, value });
    }
    return changed ? result : null;
};

/** The body of an intercepted request from CDP's postDataEntries (base64 per entry). */
export const postBody = (request) => {
    const entries = request.postDataEntries ?? [];
    if (entries.length > 0) return Buffer.concat(entries.map(({ bytes }) => Buffer.from(bytes ?? '', 'base64')));
    return request.postData === undefined ? undefined : Buffer.from(request.postData);
};

/**
 * Applies `rewrite` byte-exactly: the page goes in as a latin1 string (one char per byte) and comes back the same way. This keeps
 * UTF-8, ISO-8859-1 and any other ASCII-compatible encoding intact without knowing the page's encoding; the tags themselves are ASCII.
 * UTF-16 (BOM) is not ASCII-compatible and stays as it is.
 * @returns the new bytes, or exactly `bytes` if nothing changes
 */
export const rewriteBytes = async (bytes, rewrite, url) => {
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return bytes;
    const text = bytes.toString('latin1');
    const changed = await rewrite(text, { url });
    return changed === text ? bytes : Buffer.from(changed, 'latin1');
};

/**
 * Intercepts the documents of the application's hosts:
 * - `workbench(url)` answers the top window's document with the workbench, and the application goes into its iframe;
 * - a POST of the top window (form with target=_top) goes out through Chrome (its resolver rules, proxy setting and cookies
 *   apply) and is caught at the response stage, so the top window keeps the workbench: a redirect then loads the application in
 *   the iframe, a direct response is handed to the iframe once as its document;
 * - the documents of the application iframe come without the headers that forbid embedding; other frames keep them.
 * Without `workbench` (no human watching) the top window stays the application; then only `rewrite` applies.
 * @param workbench (url) => workbench HTML with the application at url, or undefined
 * @param refuse    ({ method, url, headers, postData }) => true for a top-window POST that must not go out (a write on
 *                  production): it fails instead of being sent; optional
 * @param rewrite   async (html, { url }) => html, optional: changes every HTML page of the application, e.g. for local code. `html` is a
 *                  byte string (latin1, see rewriteBytes): the page keeps its encoding, and whatever is not changed stays byte for byte.
 */
export const interceptDocuments = async (context, page, hosts, { workbench, rewrite, refuse }) => {
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const topFrame = frameTree.frame.id;
    // The application iframe: the first frame attached to each new workbench document, before the application runs.
    // The CDP frame id of the top frame stays the same across its navigations.
    let appFrame = null;
    if (workbench !== undefined) {
        cdp.on('Page.frameNavigated', ({ frame }) => {
            if (frame.id === topFrame) appFrame = null;
        });
        cdp.on('Page.frameAttached', ({ frameId, parentFrameId }) => {
            if (appFrame === null && parentFrameId === topFrame) appFrame = frameId;
        });
        await cdp.send('Page.enable');
    }
    // Responses to a POST of the top window, handed to the iframe once as its document.
    const pending = new Map();
    const quiet = (promise) => promise.catch(() => {});
    const fulfill = (requestId, responseCode, headers, body) => cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode,
        responseHeaders: headers,
        body: Buffer.from(body).toString('base64'),
    });
    const html = [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }];
    const onRequest = async (event) => {
        const { requestId, frameId } = event;
        const { url, method, headers } = event.request;
        if (frameId === topFrame && workbench !== undefined) {
            if (method === 'GET' || method === 'HEAD') {
                await fulfill(requestId, 200, html, workbench(url));
                return;
            }
            // POST etc. into the top window: it goes out once, through Chrome, and its response is caught at the response stage
            // (onTopPost). Not from Node (context.request): that request bypasses Chrome's resolver rules (the host lock pins
            // *.localhost, which Node does not resolve on Windows, and blocks production hosts there) and its proxy setting.
            // A request the session refuses (a write on production) fails here.
            const body = postBody(event.request);
            if (refuse?.({ method, url, headers: headers ?? {}, postData: body === undefined ? null : body.toString('utf8') }) === true) {
                await quiet(cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }));
                return;
            }
            await cdp.send('Fetch.continueRequest', { requestId, interceptResponse: true });
            return;
        }
        const stored = pending.get(url);
        if (stored !== undefined) {
            pending.delete(url);
            const kept = stored.headers.filter(({ name }) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(name.toLowerCase()));
            await fulfill(requestId, stored.status, (frameId === appFrame ? embeddableHeaders(kept) : null) ?? kept, stored.body);
            return;
        }
        await quiet(cdp.send('Fetch.continueRequest', { requestId }));
    };
    // The response to a POST of the top window belongs to the application: the top window gets the workbench instead, a redirect
    // loads its target in the iframe, any other response is handed to the iframe once as its document. Without a response (the
    // network failed) the top window shows Chrome's error, as without caw.
    const onTopPost = async (event) => {
        const { requestId } = event;
        const { url } = event.request;
        if (event.responseErrorReason !== undefined) {
            await quiet(cdp.send('Fetch.failRequest', { requestId, errorReason: event.responseErrorReason }));
            return;
        }
        const status = event.responseStatusCode;
        const headers = event.responseHeaders ?? [];
        const location = headers.find(({ name }) => name.toLowerCase() === 'location')?.value;
        if (status >= 300 && status < 400 && location !== undefined) {
            await fulfill(requestId, 200, html, workbench(new URL(location, url).href));
            return;
        }
        const { body, base64Encoded } = await cdp.send('Fetch.getResponseBody', { requestId });
        pending.set(url, { status, headers, body: base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body) });
        await fulfill(requestId, 200, html, workbench(url));
    };
    const onResponse = async (event) => {
        if (workbench !== undefined && event.frameId === topFrame && !['GET', 'HEAD'].includes(event.request.method)) {
            await onTopPost(event);
            return;
        }
        const original = event.responseHeaders ?? [];
        const headers = workbench === undefined || event.frameId !== appFrame ? null : embeddableHeaders(original);
        const status = event.responseStatusCode ?? 0;
        const isHtml = original.some(({ name, value }) => name.toLowerCase() === 'content-type' && /text\/html/i.test(value));
        const rewriting = rewrite !== undefined && isHtml && status >= 200 && status < 300;
        if (headers === null && !rewriting) {
            await quiet(cdp.send('Fetch.continueResponse', { requestId: event.requestId }));
            return;
        }
        try {
            const { body, base64Encoded } = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            let bytes = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
            let sent = headers ?? original;
            if (rewriting) {
                const changed = await rewriteBytes(bytes, rewrite, event.request.url);
                if (changed !== bytes) {
                    bytes = changed;
                    // The body is already decoded and now has a different length.
                    sent = sent.filter(({ name }) => !['content-length', 'content-encoding'].includes(name.toLowerCase()));
                }
            }
            await cdp.send('Fetch.fulfillRequest', {
                requestId: event.requestId,
                responseCode: event.responseStatusCode,
                responseHeaders: sent,
                body: bytes.toString('base64'),
            });
        } catch {
            await quiet(cdp.send('Fetch.continueResponse', { requestId: event.requestId }));
        }
    };
    cdp.on('Fetch.requestPaused', (event) => {
        const handle = event.responseStatusCode === undefined && event.responseErrorReason === undefined ? onRequest : onResponse;
        handle(event).catch(() => quiet(cdp.send('Fetch.continueRequest', { requestId: event.requestId })));
    });
    const urls = hosts.flatMap((host) => [`*://${host}/*`, `*://${host}:*`]);
    const patterns = urls.flatMap((urlPattern) => ['Request', 'Response'].map((requestStage) => ({ urlPattern, resourceType: 'Document', requestStage })));
    await cdp.send('Fetch.enable', { patterns });
    if (rewrite !== undefined) await rewriteOtherPages(context, page, hosts, rewrite);
    return cdp;
};

/**
 * Popups and new tabs of the application: the CDP session above only covers one page. A context route applies to every new page
 * before its first request; it only changes documents of other pages, the own page is still answered via CDP.
 */
const rewriteOtherPages = (context, page, hosts, rewrite) => context.route((url) => hosts.includes(url.hostname), async (route) => {
    const request = route.request();
    // A popup's first navigation arrives before its frame exists: then it is never the own page, which has long existed.
    let own = false;
    try {
        own = request.frame().page() === page;
    } catch {
        own = false;
    }
    if (request.resourceType() !== 'document' || own) {
        await route.fallback();
        return;
    }
    const response = await route.fetch({ maxRedirects: 0 });
    const isHtml = /text\/html/i.test(response.headers()['content-type'] ?? '');
    if (!isHtml || response.status() < 200 || response.status() >= 300) {
        await route.fulfill({ response });
        return;
    }
    const changed = await rewriteBytes(await response.body(), rewrite, request.url());
    const headers = Object.fromEntries(Object.entries(response.headers()).filter(([name]) => !['content-length', 'content-encoding'].includes(name.toLowerCase())));
    await route.fulfill({ response, headers, body: changed });
});

/**
 * Runs in every document: remembers the last focused element. When the iframe loses focus, e.g. to the chat,
 * `document.activeElement` falls back to body, and an agent key press would go nowhere.
 */
export const FOCUS_SCRIPT = `addEventListener('focusin', (event) => { window.__cawFocus = event.target; }, true);`;

/** F5 and Ctrl+R in the application do not reload the workbench but send it "refresh": it restores the state. */
export const RELOAD_SCRIPT = `if (window !== top && window.parent === top && window.name === ${JSON.stringify(APP_FRAME)}) addEventListener('keydown', (event) => {
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) { event.preventDefault(); top.postMessage({ caw: 'refresh' }, '*'); }
    // F1: choose a state in the workbench instead of Chrome's help. F7: the target design over the app (instead of Chrome's caret
    // browsing). F8: App only and back, wherever the focus is.
    else if ((event.key === 'F1' || event.key === 'F7' || event.key === 'F8') && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); top.postMessage({ caw: 'key', key: event.key }, '*'); }
    // Ctrl+J: the chat over the app in App only. Only there: elsewhere Chrome's downloads stay as they are.
    else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j' && top.document.body.classList.contains('solo')) { event.preventDefault(); top.postMessage({ caw: 'key', key: 'Ctrl+J' }, '*'); }
}, true);
// The console tools also here: picking an element switches the DevTools console to the app's context. An app that defines its
// own caw (var, function, assignment) keeps it: the first assignment replaces this pointer.
if (window !== top && window.parent === top && window.name === ${JSON.stringify(APP_FRAME)} && !('caw' in window)) Object.defineProperty(window, 'caw', {
    configurable: true,
    get: () => top.caw,
    set: (value) => { Object.defineProperty(window, 'caw', { value, writable: true, configurable: true, enumerable: true }); },
});`;

const descendants = (frame) => [frame, ...frame.childFrames().flatMap(descendants)];

/**
 * The application in the iframe, with the page interface as far as the tool uses it. What only exists on the page (keys,
 * screenshot, reload, events) goes through the workbench and only affects the frame.
 * @param page   the workbench
 * @param first  the application's frame
 * @param app    returns the application frame of the current workbench document, known by identity (workbench.mjs). Without
 *               it the frame is looked up by its name, which the application can change: only for pages without a workbench.
 */
export const frameView = (page, first, app) => {
    const iframe = () => page.locator(`iframe[name="${APP_FRAME}"]`);
    // If someone reloads the workbench there is a new iframe: the view follows it instead of sticking to the old, detached frame.
    const current = () => {
        const found = app === undefined ? page.frame({ name: APP_FRAME }) : app();
        return found !== null && !found.isDetached() ? found : first;
    };
    // on(load) registers a wrapper; off needs it again.
    const wrappers = new Map();
    const view = {
        isFrameView: true,
        workbench: page,
        get frame() { return current(); },
        evaluate: (...args) => current().evaluate(...args),
        evaluateHandle: (...args) => current().evaluateHandle(...args),
        locator: (...args) => current().locator(...args),
        getByRole: (...args) => current().getByRole(...args),
        $: (...args) => current().$(...args),
        isVisible: (...args) => current().isVisible(...args),
        fill: (...args) => current().fill(...args),
        click: (...args) => current().click(...args),
        press: (...args) => current().press(...args),
        waitForSelector: (...args) => current().waitForSelector(...args),
        waitForLoadState: (...args) => current().waitForLoadState(...args),
        goto: (url, options) => current().goto(url, options),
        // Like F5: location.reload also reloads with a # in the address; a goto there would only jump within the document.
        reload: async (options = {}) => {
            await Promise.all([
                current().waitForNavigation({ waitUntil: options.waitUntil ?? 'load', ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }),
                current().evaluate(() => { setTimeout(() => location.reload(), 0); }),
            ]);
            return null;
        },
        url: () => current().url(),
        title: () => current().title(),
        content: () => current().content(),
        ariaSnapshot: (options) => current().locator('body').ariaSnapshot(options),
        screenshot: (options) => iframe().screenshot(options),
        mainFrame: () => current(),
        frames: () => descendants(current()),
        context: () => page.context(),
        bringToFront: () => page.bringToFront(),
        isClosed: () => page.isClosed() || current().isDetached(),
        keyboard: {
            // A real key press: focus the iframe first, then the element that last had focus. Both come from the page, which can
            // point them at any element of the workbench (top.document, e.g. the chat): only an element of the application's own
            // document gets the focus, checked here by its frame, not by the page.
            press: async (key, options) => {
                const frame = current();
                const own = async (handle) => {
                    const element = handle.asElement();
                    if (element !== null && await element.ownerFrame().catch(() => null) === frame) return element;
                    await handle.dispose().catch(() => {});
                    return null;
                };
                const target = await own(await frame.evaluateHandle(() => (window.__cawFocus?.isConnected ? window.__cawFocus : null)))
                    ?? await own(await frame.evaluateHandle(() => document.activeElement));
                // The iframe by its frame, not by a selector: the page can rename the element or add another one with that name.
                const box = await frame.frameElement();
                await box.focus();
                await box.dispose().catch(() => {});
                await target?.focus().catch(() => {});
                await target?.dispose().catch(() => {});
                await page.keyboard.press(key, options);
            },
        },
        /** Events like on a page: popup and close from the workbench, navigation only for the frame. */
        on: (event, listener) => {
            if (event === 'domcontentloaded' || event === 'load') {
                const wrapped = (navigated) => {
                    if (navigated === current()) navigated.waitForLoadState(event).then(() => listener(view), () => {});
                };
                wrappers.set(listener, wrapped);
                page.on('framenavigated', wrapped);
            } else page.on(event, listener);
            return view;
        },
        // Unsubscribe like on a page; e.g. sign-in inside the frame (restoring a state) watches requests only while it runs.
        off: (event, listener) => {
            if (event === 'domcontentloaded' || event === 'load') {
                const wrapped = wrappers.get(listener);
                if (wrapped !== undefined) page.off('framenavigated', wrapped);
                wrappers.delete(listener);
            } else page.off(event, listener);
            return view;
        },
    };
    return view;
};
