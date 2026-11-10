// Der Mensch fuehrt im sichtbaren Chrome vor, das Tool schneidet mit. Die Schritte haben das Format des Recorders,
// denn das Ziel beschreibt dieselbe Funktion wie beim Agenten. Passwoerter verlassen die Seite nie.

import { lstatSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CawError } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { isWorkbenchDocument } from './app-view.mjs';
import { redactDeep } from './secrets.mjs';
import { frameTargetOf, frameworkOf, targetLabel } from './framework/index.mjs';

const BINDING = '__cawCapture';
const SETTLE_MS = 300;
// Laedt die Seite ohne Klick oder Taste davor, hat der Mensch die Adresse selbst eingegeben.
const OWN_NAVIGATION_MS = 3000;
// Wie oft beim Vorfuehren nach neuen Fehlern der Anwendung geschaut wird.
const FAILURE_POLL_MS = 500;
const NOT_TYPED = new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'hidden']);

/** Laeuft im Browser. Capture-Phase: Das Ziel muss beschrieben sein, bevor die Anwendung darauf reagiert. */
export function captureInPage(binding, describeTarget, notTyped) {
    if (window.__cawCaptureOn) return;
    window.__cawCaptureOn = true;
    // Die Werkbank markiert sich erst nach diesem Skript (Skript des Tabs, dieses gehoert dem Kontext): Darum hier, nicht beim Start.
    const send = (event) => { if (window.__cawWorkbench !== true) window[binding]?.({ ...event, path: location.pathname }); };
    const describe = (element) => {
        try {
            return describeTarget(element, { mode: 'describe' });
        } catch {
            return null;
        }
    };
    const isField = (element) => (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !notTyped.includes(element.type);
    const flush = (element) => {
        if (!isField(element) || element.cawValue === element.value) return;
        element.cawValue = element.value;
        if (element.type === 'password') send({ action: 'fill', secret: true, target: describe(element) });
        else send({ action: 'fill', target: describe(element), value: element.value });
    };
    addEventListener('focusin', ({ target }) => {
        if (isField(target) && target.cawValue === undefined) target.cawValue = target.value;
    }, true);
    addEventListener('change', ({ target }) => { if (!window.__cawPicking) flush(target); }, true);
    addEventListener('keydown', ({ isTrusted, key, target }) => {
        if (!isTrusted || window.__cawPicking || !['Enter', 'Tab', 'Escape'].includes(key)) return;
        flush(target);
        send({ action: 'press', key });
    }, true);
    addEventListener('click', ({ isTrusted, target }) => {
        if (!isTrusted || window.__cawPicking || !(target instanceof Element)) return;
        flush(document.activeElement);
        const described = describe(target);
        send({ action: 'click', target: described, ...(described === null ? { hint: target.tagName.toLowerCase() } : {}) });
    }, true);
}

/**
 * Laeuft im Browser. Der naechste Klick waehlt ein Element, statt etwas auszuloesen: Er endet schon am window und erreicht
 * weder die Anwendung noch den Mitschnitt. Escape bricht ab.
 */
export function pickInPage(describeTarget) {
    return new Promise((resolve) => {
        const mark = document.createElement('div');
        mark.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:3px;display:none';
        document.documentElement.append(mark);
        const swallowed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu'];
        const swallow = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const move = ({ target }) => {
            if (!(target instanceof Element)) return;
            const { left, top, width, height } = target.getBoundingClientRect();
            mark.style.cssText += `;display:block;left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
        };
        let done;
        const click = (event) => {
            if (!event.isTrusted) return;
            swallow(event);
            const { target } = event;
            let described = null;
            try {
                described = describeTarget(target, { mode: 'describe' });
            } catch {
                described = null;
            }
            done({ target: described, tag: target.tagName.toLowerCase(), text: (target.innerText ?? target.value ?? '').trim().slice(0, 120) });
        };
        const key = (event) => {
            if (event.key !== 'Escape' || !event.isTrusted) return;
            swallow(event);
            done(null);
        };
        done = (value) => {
            swallowed.forEach((name) => removeEventListener(name, swallow, true));
            removeEventListener('click', click, true);
            removeEventListener('keydown', key, true);
            removeEventListener('mousemove', move, true);
            mark.remove();
            window.__cawPicking = false;
            window.__cawCancelPick = undefined;
            resolve(value);
        };
        window.__cawPicking = true;
        window.__cawCancelPick = () => done(null);
        swallowed.forEach((name) => addEventListener(name, swallow, true));
        addEventListener('click', click, true);
        addEventListener('keydown', key, true);
        addEventListener('mousemove', move, true);
    });
}

/**
 * Ein Ziel aus einem Frame der Anwendung bekommt `frame`: die iframes bis zum Hauptframe. Laesst sich ein iframe nicht beschreiben,
 * ist das Ziel nicht stabil (null), wie ein Element ohne Namen.
 */
const withFrame = async (session, frame, target) => {
    if (target === null || target === undefined || frame === undefined || frame === null) return target ?? null;
    // Der Hauptframe der Anwendung auf der Seite, von der das Ereignis kommt: Mit Werkbank ihr iframe, sonst der Hauptframe dieser
    // Seite. Nicht session.page(): Das ist das zuletzt geoeffnete Fenster, und ein Klick im ersten Tab bei offenem Popup gehoert dorthin.
    const page = frame.page();
    const top = session.workbench?.page === page ? session.workbench.view.frame : page.mainFrame();
    if (frame === top) return target;
    const chain = await frameTargetOf({ mainFrame: () => top }, frame).catch(() => null);
    return chain === null ? null : chain === undefined ? target : { ...target, frame: chain };
};

/** In jedem Frame, denn Masken liegen teils in iFrames. Der erste Klick gewinnt, die anderen Frames brechen ab. */
export const cancelPick = (session) => Promise.all(session.page().frames().map((frame) => frame.evaluate('window.__cawCancelPick?.()').catch(() => {})));

export const pickElement = async (session) => {
    const script = `(${pickInPage})(${(session.framework ?? frameworkOf()).targets})`;
    const picked = await new Promise((resolve) => {
        const frames = session.page().frames();
        let open = frames.length;
        for (const frame of frames) {
            frame.evaluate(script).catch(() => null).then((value) => {
                open -= 1;
                if (value !== null && value !== undefined) resolve({ value, frame });
                else if (open === 0) resolve(null);
            });
        }
    }).then(async (hit) => (hit === null ? null : { ...hit.value, target: await withFrame(session, hit.frame, hit.value.target) }));
    await cancelPick(session);
    if (picked === null) return null;
    const label = picked.target === null ? `${picked.tag}${picked.text === '' ? '' : ` "${picked.text.slice(0, 40)}"`}` : targetLabel(picked.target);
    return { label, ...picked };
};

// Nie in der Werkbank selbst: Dort tippt der Mensch in den Chat, das ist kein Schritt der Anwendung.
const captureScript = (framework) => `if (!(${isWorkbenchDocument}) && location.href !== 'about:srcdoc') (${captureInPage})(${JSON.stringify(BINDING)}, ${framework.targets}, ${JSON.stringify([...NOT_TYPED])});`;

// Der Ordner gehoert waehrend des Laufs auch dem Container: Ein Link darin, etwa fehler.json -> ~/.bashrc, darf den Host nicht
// woandershin schreiben lassen. Darum nie einem Link folgen: lstat statt exists, und nur neu anlegen ('wx'), nie ueberschreiben.
const taken = (path) => {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
};
/** Schreibt eine eigene Datei neu. Was dort liegt (auch ein Link), wird entfernt, nicht verfolgt. */
const writeOwn = (path, data) => {
    if (taken(path)) rmSync(path, { force: true });
    writeFileSync(path, data, { flag: 'wx' });
};

/** Mehrmals Hilfe im selben Lauf: Fruehere Bilder bleiben erhalten. */
const freeScreenshot = (dir) => {
    let number = 1;
    while (taken(join(dir, `punkt-${number}.png`))) number += 1;
    return `punkt-${number}.png`;
};

/** Wie das Dokument im Frame entstand: 'reload', 'navigate', 'back_forward' oder null, wenn es sich nicht ermitteln laesst. */
export const navigationType = async (frame) => {
    if (frame === undefined || frame === null) return null;
    try {
        await frame.waitForLoadState('domcontentloaded');
        return await frame.evaluate(() => performance.getEntriesByType('navigation')[0]?.type ?? null);
    } catch {
        return null;
    }
};

/** Einmal je Browser: Binding und Skript bleiben ueber Seitenwechsel erhalten, mitgeschnitten wird nur auf Zuruf. */
const captures = new WeakMap();
const captureOf = async (session) => {
    const known = captures.get(session.context);
    if (known !== undefined) return known;
    const state = { listener: null, queue: Promise.resolve() };
    captures.set(session.context, state);
    // Nur Frames der Anwendung zaehlen; in der Werkbank sieht auch der Chat das Binding.
    const owns = ({ page, frame }) => (session.ownsFrame === undefined ? session.ownsPage(page) : session.ownsFrame(frame));
    // Der Frame eines Ziels wird auf dem Host ermittelt, also asynchron; die Warteschlange haelt die Reihenfolge der Ereignisse.
    await session.context.exposeBinding(BINDING, (source, event) => {
        if (state.listener === null || !owns(source)) return;
        state.queue = state.queue.then(async () => {
            const target = event?.target === undefined ? undefined : await withFrame(session, source.frame, event.target);
            state.listener?.(hideSecrets(session, target === undefined ? event : { ...event, target }));
        }).catch(() => {});
    });
    const script = captureScript(session.framework ?? frameworkOf());
    await session.context.addInitScript({ content: script });
    // In jedem Frame, nicht nur im Hauptframe: In der Werkbank ist der Hauptframe die Werkbank, die Anwendung laeuft schon im iframe.
    await Promise.all(session.context.pages().flatMap((page) => page.frames()).map((frame) => frame.evaluate(script).catch(() => {})));
    // Ein Seitenwechsel der Anwendung: ihr Hauptframe, mit Werkbank der Frame im iframe.
    const isAppMain = (page, frame) => {
        const app = session.workbench?.page === page ? session.workbench.view.frame : page.mainFrame();
        return frame === app;
    };
    // Durch dieselbe Warteschlange wie die Aktionen: Sonst kaeme der Seitenwechsel eines Klicks im iframe vor dem Klick an, dessen Ziel
    // noch ermittelt wird, und zaehlte als eigener Seitenwechsel.
    const watchNavigation = (page) => page.on('framenavigated', (frame) => {
        if (!isAppMain(page, frame) || state.listener === null || !owns({ page, frame })) return;
        const url = frame.url();
        state.queue = state.queue.then(() => state.navigated?.(url, frame)).catch(() => {});
    });
    session.context.on('page', watchNavigation);
    session.context.pages().forEach(watchNavigation);
    return state;
};

const aboutOf = (item) => (item.element === undefined ? '' : t('run.item.about', { label: item.element.label }));
const unstable = (item) => t('run.item.unstable', { hint: item.hint ?? t('run.item.field') });

export const itemLabel = (item) => {
    switch (item.action) {
        case 'checkpoint': return t('run.item.checkpoint', { about: aboutOf(item), text: item.text });
        case 'note': return t('run.item.note', { about: aboutOf(item), text: item.text });
        case 'press': return `press ${item.key}`;
        case 'navigated': return t('run.item.navigated', { url: item.url });
        case 'reloaded': return t('run.item.reloaded', { url: item.url });
        case 'failure': return t('run.item.failure', { type: item.type, text: item.text, url: item.url === undefined ? '' : ` (${item.url})` });
        default: return `${item.action} ${item.target === null ? unstable(item) : targetLabel(item.target)}`;
    }
};

const VERBS = ['click', 'dblclick', 'fill', 'select', 'check', 'uncheck', 'press'];
const verbOf = (action) => (VERBS.includes(action) ? t(`run.verb.${action}`) : action);
/**
 * Was der Mensch beim Vorfuehren mitlesen soll: Aktionen und Seitenwechsel. Pruefpunkte, Hinweise und Fehler zeigt der Chat schon
 * selbst. @returns die Zeile oder null
 */
export const feedLabel = (item) => {
    if (['checkpoint', 'note', 'failure'].includes(item.action)) return null;
    if (item.action === 'navigated' || item.action === 'reloaded') return itemLabel(item);
    if (item.secret) return t('run.item.secret', { verb: verbOf(item.action) });
    const verb = verbOf(item.action);
    if (item.action === 'press') return `${verb} ${item.key}`;
    return `${verb} ${item.target === null ? unstable(item) : targetLabel(item.target)}`;
};

/**
 * Schneidet mit, bis der Mensch fertig ist: Eine Zeile mit { checkpoint } ist ein Pruefpunkt an dieser Stelle, { note } Kontext,
 * eine leere beendet, Fenster schliessen auch.
 * @param operator { nextLine({ page }) } liefert die naechste Zeile, { note } fuer einen Hinweis oder { checkpoint }, beide optional mit element
 * @param onItem   bekommt jeden aufgezeichneten Eintrag, etwa fuer den Chat
 * @param dir      Ordner fuer die Screenshots der Pruefpunkte
 * @returns die Schritte und Pruefpunkte in ihrer Reihenfolge
 */
export const demonstrate = async ({ session, operator, ui, dir, now = Date.now, onFailure, onItem, pollMs = FAILURE_POLL_MS }) => {
    const state = await captureOf(session);
    const items = [];
    // Fehler der Anwendung (Konsole, Skript, Netzwerk) erkennt das Tool schon beim Vorfuehren: Sie stehen an ihrer Stelle in der
    // Aufnahme, der Mensch sieht sie sofort, und Fehler wie Netzwerk landen zusaetzlich als Belege im Ordner der Vorfuehrung.
    const failuresAt = session.failures?.().length ?? 0;
    const networkAt = session.network?.mark() ?? 0;
    let failuresSeen = failuresAt;
    const watchFailures = () => {
        const all = session.failures?.() ?? [];
        for (const failure of all.slice(failuresSeen)) {
            const item = { action: 'failure', type: failure.type, text: String(failure.text ?? '').slice(0, 500), ...(failure.url === undefined ? {} : { url: failure.url }), ...(failure.at === undefined ? {} : { at: failure.at }) };
            items.push(item);
            ui.step({ number: items.length, total: items.length, label: itemLabel(item), elapsed: 0 });
            onFailure?.(item);
        }
        failuresSeen = all.length;
    };
    const failureTimer = setInterval(watchFailures, pollMs);
    let lastAction = now();
    const push = (item) => {
        items.push(item);
        ui.step({ number: items.length, total: items.length, label: itemLabel(item), elapsed: 0 });
        onItem?.(item);
    };
    state.listener = (event) => {
        lastAction = now();
        push(event);
    };
    let lastUrl = (() => {
        try {
            return session.page().url();
        } catch {
            return null;
        }
    })();
    state.navigated = (url, frame) => {
        const { pathname, hash } = new URL(url);
        // Dieselbe Adresse noch einmal: Neu geladen hat der Mensch nur, wenn der Browser es so meldet (F5, Aktualisieren, Knopf).
        // Ein abgeschicktes Formular auf dieselbe Adresse ist ein normaler Seitenwechsel des Klicks davor.
        if (url === lastUrl) {
            lastAction = now();
            navigationType(frame).then((type) => {
                if (type === 'reload' && state.listener !== null) push({ action: 'reloaded', url: `${pathname}${hash}`, path: pathname });
            });
            return;
        }
        lastUrl = url;
        if (now() - lastAction <= OWN_NAVIGATION_MS) return;
        lastAction = now();
        // Nur ein Hinweis: Ob der Mensch die Adresse eingetippt hat oder ein langsamer Klick die Seite gewechselt hat, ist nicht zu
        // unterscheiden. Ein festes goto mit dem Hash dieses Laufs (etwa einer Bestellnummer) traefe beim Abspielen den falschen Zustand.
        push({ action: 'navigated', url: `${pathname}${hash}`, path: pathname });
    };
    let interrupt;
    const interrupted = new Promise((ok) => { interrupt = ok; });
    process.once('SIGINT', interrupt);
    const input = new AbortController();
    // Waehrend der Vorfuehrung darf der Mensch die Seite neu laden; was das fuer den Weg heisst, steht als Hinweis in der Aufnahme.
    session.workbench?.onRefresh?.(() => session.reloadPage());
    try {
        for (;;) {
            const line = await Promise.race([
                operator.nextLine({ page: session.page(), signal: input.signal }),
                session.closed.then(() => null),
                interrupted.then(() => { throw new CawError('aborted', t('run.demo.aborted')); }),
            ]);
            // Erst, was noch auf seinen Frame wartet: Ein Pruefpunkt gehoert hinter den Klick davor.
            await state.queue;
            if (line?.note !== undefined) {
                push({ action: 'note', text: line.note, path: new URL(session.page().url()).pathname, ...(line.element === undefined ? {} : { element: line.element }) });
                continue;
            }
            const shown = typeof line === 'string' ? line : line?.checkpoint;
            if (shown === undefined || shown === null || shown.trim() === '') break;
            const screenshot = freeScreenshot(dir);
            const image = await session.page().screenshot().catch(() => null);
            const saved = image !== null && (() => {
                try {
                    writeFileSync(join(dir, screenshot), image, { flag: 'wx' });
                    return true;
                } catch {
                    return false;
                }
            })();
            push({ action: 'checkpoint', text: shown.trim(), path: new URL(session.page().url()).pathname, ...(saved ? { screenshot } : {}), ...(line?.element === undefined ? {} : { element: line.element }) });
        }
        // Was kurz vor dem Enter passiert ist, ist womoeglich noch unterwegs.
        await new Promise((ok) => { setTimeout(ok, SETTLE_MS); });
        // Ereignisse, deren Frame noch ermittelt wird, gehoeren dazu; danach erst abhaengen.
        await state.queue;
        watchFailures();
        return items;
    } finally {
        clearInterval(failureTimer);
        // Belege unabhaengig vom Trace, der bei einem abrupten Ende unvollstaendig sein kann.
        if (dir !== undefined) {
            try {
                writeOwn(join(dir, 'fehler.json'), JSON.stringify((session.failures?.() ?? []).slice(failuresAt), null, 2));
                if (session.network !== undefined) writeOwn(join(dir, 'netzwerk.json'), JSON.stringify(session.network.since(networkAt), null, 2));
            } catch {
                // Belege sind Zugabe; die Vorfuehrung selbst zaehlt
            }
        }
        // Sonst laese eine offene Eingabe weiter und kaeme der naechsten in die Quere.
        input.abort();
        session.workbench?.onRefresh?.(null);
        process.removeListener('SIGINT', interrupt);
        state.listener = null;
        state.navigated = null;
    }
};

/**
 * Was der Mensch eintippt, sieht Claude und steht in der Aufnahme. Ein Passwort der Rolle oder geheim gemerkter Wert in einem Feld, das
 * kein Passwortfeld ist ("Passwort anzeigen", Dialog zur erneuten Anmeldung), gilt wie eines: als geheime Eingabe ohne Wert.
 */
export const hideSecrets = (session, event) => {
    const secrets = (session.secrets?.() ?? []).filter((secret) => typeof secret === 'string' && secret !== '');
    if (secrets.length === 0 || event === null || typeof event !== 'object') return event;
    if (event.action === 'fill' && typeof event.value === 'string' && secrets.some((secret) => event.value.includes(secret))) {
        const { value: _value, ...rest } = event;
        return redactDeep({ ...rest, secret: true }, secrets);
    }
    return redactDeep(event, secrets);
};

/** Trennt, was sich direkt wiederholen laesst, von dem, was nur der Mensch konnte. */
export const recordableSteps = (items) => {
    const steps = [];
    const problems = [];
    for (const item of items) {
        if (['checkpoint', 'note', 'navigated', 'reloaded', 'failure'].includes(item.action)) continue;
        if (item.secret) problems.push(t('run.demo.secret'));
        else if (item.target === null) problems.push(t('run.demo.unstable', { item: itemLabel(item) }));
        else {
            const { hint: _hint, ...step } = item;
            steps.push(step);
        }
    }
    return { steps, problems };
};

