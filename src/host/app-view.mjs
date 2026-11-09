// Die Anwendung im iframe der Werkbank: Die Werkbank (Plan, Chat, Requests) und die Anwendung teilen sich ein Fenster.
//
// Die Werkbank liegt auf der Adresse der Anwendung selbst, also auf ihrem Origin. Anwendungen greifen oft auf das oberste Fenster
// zu (`top.Ext`, `parent.config`, `top.location`). Im Portal ist das die Anwendung, hier die Werkbank. Darum:
// - gleicher Origin: Der Browser blockt solche Zugriffe nicht;
// - die Werkbank reicht globale Namen der Anwendung durch, die sie selbst nicht hat (`top.Ext` ist das Ext der Anwendung);
// - ihre Adresse folgt der Anwendung (`top.location.href` stimmt);
// - navigiert die Anwendung das oberste Fenster (`top.location = …`, Formular mit target=_top, auch POST), landet die Seite in
//   der Anwendung, und die Werkbank bleibt.
// Ausgeliefert wird die Werkbank vom Tool: Nur das Dokument des obersten Fensters wird abgefangen, kein anderer Request.
//
// Damit sich die Anwendung einbetten laesst, entfernt der Testbrowser X-Frame-Options und frame-ancestors aus den Dokumenten der
// Hosts der Anwendung, nur in diesem Browser und nur im Dokument-Request. Das geschieht auf der Antwortstufe von Chrome: kein zweiter
// Request, Chromes Netz und Host-Sperre gelten weiter, Weiterleitungen und Cookies bleiben, wie sie sind.

export const APP_FRAME = 'caw-app';

/** Name, unter dem Skripte der Werkbank und des Chats in Konsole und Stacks stehen: So zaehlen ihre Meldungen nie zur Anwendung. */
export const WORKBENCH_SOURCE = 'caw-werkbank.js';
export const sourceTag = `\n//# sourceURL=${WORKBENCH_SOURCE}\n`;

/** Laeuft im Browser: Ist dieses Dokument die Werkbank selbst? Skripte des Tools, die in jedem Frame laufen, lassen sie aus. */
export const isWorkbenchDocument = 'window.__cawWorkbench === true';

/** Mit Werkbank ist das oberste Fenster immer die Werkbank. Laeuft vor allen anderen Skripten des Tools. */
export const WORKBENCH_MARK_SCRIPT = 'if (window === window.top) Object.defineProperty(window, "__cawWorkbench", { value: true });';

/** Stammt eine Meldung (Datei oder Stack) aus Werkbank oder Chat? */
export const fromWorkbenchSource = (text) => typeof text === 'string' && (text.includes(WORKBENCH_SOURCE) || text === 'about:srcdoc');

/**
 * Die Header ohne das, was das Einbetten verbietet: X-Frame-Options ganz, aus der CSP nur frame-ancestors.
 * @param headers [{ name, value }] wie im CDP-Protokoll
 * @returns die neuen Header oder null, wenn nichts zu aendern ist
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

/** Der Body eines abgefangenen Requests aus den postDataEntries von CDP (je Eintrag base64). */
export const postBody = (request) => {
    const entries = request.postDataEntries ?? [];
    if (entries.length > 0) return Buffer.concat(entries.map(({ bytes }) => Buffer.from(bytes ?? '', 'base64')));
    return request.postData === undefined ? undefined : Buffer.from(request.postData);
};

const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'cookie']);

/**
 * Faengt die Dokumente der Hosts der Anwendung ab:
 * - das Dokument des obersten Fensters beantwortet `workbench(url)` mit der Werkbank, die Anwendung kommt in ihr iframe;
 * - ein POST des obersten Fensters (Formular mit target=_top) geht ueber den Request-Kontext des Browsers raus, gleiche Cookies;
 *   eine Weiterleitung laedt danach die Anwendung im iframe, eine direkte Antwort bekommt das iframe einmalig als sein Dokument;
 * - alle anderen Dokumente der Anwendung kommen ohne die Header, die das Einbetten verbieten.
 * @param workbench (url) => HTML der Werkbank mit der Anwendung unter url
 * @param request   der Request-Kontext des Browsers (context.request)
 */
export const interceptDocuments = async (context, page, hosts, { workbench, request }) => {
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const topFrame = frameTree.frame.id;
    // Antworten auf ein POST des obersten Fensters, die das iframe einmal als Dokument bekommt.
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
        if (frameId === topFrame) {
            if (method === 'GET' || method === 'HEAD') {
                await fulfill(requestId, 200, html, workbench(url));
                return;
            }
            // POST & Co. ins oberste Fenster: einmal echt abschicken, das Ergebnis gehoert der Anwendung.
            const sent = await request.fetch(url, {
                method,
                headers: Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase()))),
                data: postBody(event.request),
                maxRedirects: 0,
                failOnStatusCode: false,
            });
            const location = sent.headers().location;
            if (sent.status() >= 300 && sent.status() < 400 && location !== undefined) {
                await fulfill(requestId, 200, html, workbench(new URL(location, url).href));
                return;
            }
            pending.set(url, { status: sent.status(), headers: sent.headersArray(), body: await sent.body() });
            await fulfill(requestId, 200, html, workbench(url));
            return;
        }
        const stored = pending.get(url);
        if (stored !== undefined) {
            pending.delete(url);
            const kept = stored.headers.filter(({ name }) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(name.toLowerCase()));
            await fulfill(requestId, stored.status, embeddableHeaders(kept) ?? kept, stored.body);
            return;
        }
        await quiet(cdp.send('Fetch.continueRequest', { requestId }));
    };
    const onResponse = async (event) => {
        const headers = embeddableHeaders(event.responseHeaders ?? []);
        if (headers === null) {
            await quiet(cdp.send('Fetch.continueResponse', { requestId: event.requestId }));
            return;
        }
        try {
            const { body, base64Encoded } = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            await cdp.send('Fetch.fulfillRequest', {
                requestId: event.requestId,
                responseCode: event.responseStatusCode,
                responseHeaders: headers,
                body: base64Encoded ? body : Buffer.from(body).toString('base64'),
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
    return cdp;
};

/**
 * Laeuft in jedem Dokument: merkt sich das zuletzt fokussierte Element. Verliert das iframe den Fokus, etwa an den Chat, steht
 * `document.activeElement` sonst wieder auf body, und eine Taste des Agenten ginge ins Leere.
 */
export const FOCUS_SCRIPT = `addEventListener('focusin', (event) => { window.__cawFocus = event.target; }, true);`;

/** F5 und Strg+R in der Anwendung laden nicht die Werkbank neu, sondern melden ihr „Aktualisieren“: Sie stellt den Zustand wieder her. */
export const RELOAD_SCRIPT = `if (window !== top && window.parent === top && window.name === ${JSON.stringify(APP_FRAME)}) addEventListener('keydown', (event) => {
    if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) { event.preventDefault(); top.postMessage({ caw: 'refresh' }, '*'); }
}, true);`;

const descendants = (frame) => [frame, ...frame.childFrames().flatMap(descendants)];

/**
 * Die Anwendung im iframe, mit der Schnittstelle einer Seite, soweit das Tool sie nutzt. Was es nur an der Seite gibt (Tasten,
 * Screenshot, Neuladen, Ereignisse), geht ueber die Werkbank und betrifft nur den Frame.
 * @param page   die Werkbank
 * @param frame  der Frame der Anwendung
 */
export const frameView = (page, first) => {
    const iframe = () => page.locator(`iframe[name="${APP_FRAME}"]`);
    // Laedt jemand die Werkbank neu, gibt es ein neues iframe: Die Sicht folgt ihm, statt am alten, abgehaengten Frame zu haengen.
    const current = () => {
        const found = page.frame({ name: APP_FRAME });
        return found !== null && !found.isDetached() ? found : first;
    };
    const view = {
        isFrameView: true,
        workbench: page,
        get frame() { return current(); },
        evaluate: (...args) => current().evaluate(...args),
        evaluateHandle: (...args) => current().evaluateHandle(...args),
        locator: (...args) => current().locator(...args),
        getByRole: (...args) => current().getByRole(...args),
        $: (...args) => current().$(...args),
        fill: (...args) => current().fill(...args),
        click: (...args) => current().click(...args),
        press: (...args) => current().press(...args),
        waitForSelector: (...args) => current().waitForSelector(...args),
        waitForLoadState: (...args) => current().waitForLoadState(...args),
        goto: (url, options) => current().goto(url, options),
        // Wie F5: location.reload laedt auch bei einem # in der Adresse neu, ein goto dorthin waere nur ein Sprung im Dokument.
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
            // Die echte Taste: erst das iframe fokussieren, dann das Element, das zuletzt den Fokus hatte.
            press: async (key, options) => {
                const target = await current().evaluateHandle(() => (window.__cawFocus?.isConnected ? window.__cawFocus : document.activeElement));
                await iframe().focus();
                await target.asElement()?.focus().catch(() => {});
                await target.dispose().catch(() => {});
                await page.keyboard.press(key, options);
            },
        },
        /** Ereignisse wie an einer Seite: popup und close von der Werkbank, Navigation nur die des Frames. */
        on: (event, listener) => {
            if (event === 'domcontentloaded' || event === 'load') {
                page.on('framenavigated', (navigated) => {
                    if (navigated === current()) navigated.waitForLoadState(event).then(() => listener(view), () => {});
                });
            } else page.on(event, listener);
            return view;
        },
    };
    return view;
};
