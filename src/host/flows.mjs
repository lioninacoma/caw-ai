// Die Ablaeufe rund um einen Schritt. Was Claude geschafft hat, muss auch ohne Claude laufen, und erst danach entscheidet der
// Mensch im Chat, ob es den Testplan abloest. Scheitert ein Schritt, klaert der Mensch ihn im Chat und kann ihn beheben lassen.

import { CawError, EXIT } from '../shared/errors.mjs';
import { t } from '../shared/i18n.mjs';
import { CONFIG_FILE, CONTEXT_FILE } from '../shared/names.mjs';
import { cutReplay, positionalActions, replayOf, replayUpToStale, withBaselines, withEffects, withoutEffects } from './replay.mjs';
import { LEARN_RUNS, isEffectCause } from './effects.mjs';
import { staleSteps } from './test-file.mjs';

// Beschriftungen als Getter: Die Sprache steht beim Import noch nicht fest. Kopien mit Spread entstehen erst zur Laufzeit.
const button = (id, key, extra = {}) => ({ id, get label() { return t(key); }, ...extra });
const ADOPT = { id: 'adopt', primary: true };
/** Der Knopf nennt, wie viele Schritte der Testplan dann hat. */
const adoptButton = (count, extra = {}) => ({ ...ADOPT, label: t('run.button.adopt', { count }), ...extra });
// Verwerfen laesst sich nicht rueckgaengig machen: Es will ein zweites Mal geklickt werden, wie Abbrechen im Kopf des Chats.
const DISCARD = { id: 'discard', get label() { return t('run.button.discardDraft'); }, get confirm() { return t('run.button.discardSure'); } };
const FIX = button('fix', 'run.button.fix', { primary: true });
const RERECORD = button('fix', 'run.button.rerecord', { primary: true });
const RERUN = button('rerun', 'run.button.rerun', { primary: true });
// Beendet regulaer („Lauf beenden“): mit dem Ergebnis des Laufs. „Abbrechen“ im Kopf des Chats beendet dagegen sofort, als Fehler ohne Ergebnis.
const CLOSE = button('close', 'run.button.close');
const ASK = button('ask', 'run.button.ask', { primary: true });
// Nur die Wirkung weicht ab, die Pruefung ist erfuellt: Die gelernte Wirkung vergessen, ohne Claude und ohne Tokens.
const FORGET_EFFECT = button('forget-effect', 'run.button.forgetEffect');
const ONLY_CLOSE = button('close', 'run.button.onlyClose', { primary: true });
// Nach der Uebergabe, beim Entwickeln im hergestellten Zustand.
const RESTORE = button('restore', 'run.button.restore', { primary: true });
const END_DEVELOP = button('end', 'run.button.endDevelop');

const withoutDot = (text) => text.replace(/\.$/, '');

/** Ergaenzte Vergleichswerte in einem Satz fuer den Chat. */
const baselineText = (baselines) => t('run.flow.baselines', { ids: [...baselines.keys()].join(', ') });

/** Warum ein Lauf nicht bestanden hat, in einem Satz fuer den Chat. */
const failureText = (verdict) => {
    const failed = (verdict?.results ?? []).find(({ status }) => status === 'fail');
    return withoutDot(verdict?.reason ?? failed?.note ?? verdict?.failures?.[0]?.text ?? (failed === undefined ? t('run.flow.seeReport') : t('run.flow.notMet', { id: failed.id })));
};

const hardFailures = (verdict) => (verdict?.failures ?? []).map(({ type, text, at }) => `${type}: ${withoutDot(text)}${at === undefined ? '' : t('run.flow.at', { at })}`);
const LISTED = 3;
const listed = (texts) => (texts.length <= LISTED ? texts.join('; ') : t('run.flow.andMore', { shown: texts.slice(0, LISTED).join('; '), count: texts.length - LISTED }));

/** Harte Fehler und Warnungen in einem Satz: Ohne Claude ist das alles, was der Mensch im Chat davon sieht. */
const findingsText = (verdict) => [
    ...(hardFailures(verdict).length === 0 ? [] : [t('run.flow.hardFailures', { list: listed(hardFailures(verdict)) })]),
    ...((verdict?.warnings ?? []).length === 0 ? [] : [t('run.flow.warnings', { list: listed(verdict.warnings.map(({ text, origin }) => `${withoutDot(text)}${origin === undefined ? '' : ` (${origin})`}`)) })]),
].join('');

/** Geaenderte Dateien nennt auch der Chat: Code der Anwendung pruefen Lint und ein neuer Lauf, committet wird nie. */
const noticeFiles = (files, chat) => {
    if (files.length === 0) return;
    const code = appFilesOf(files).length > 0 ? t('run.flow.checkChange') : '';
    chat.notice?.(t('run.flow.changedFiles', { files: files.join(', '), code }));
};

/** Die geaenderten Dateien der Anwendung, ohne Config und Projektkontext von caw-ai. */
const appFilesOf = (files) => files.filter((file) => file !== CONFIG_FILE && file !== CONTEXT_FILE);

/** Was ein Beheben ergeben hat, so wie es der Pruefdurchlauf und die Entscheidung brauchen. */
const changeOf = ({ id, reason, rerecord, fresh, expectChange }) => ({ id, reason, fresh: fresh ?? [], ...(rerecord ? { rerecord } : {}), ...(expectChange === undefined ? {} : { expectChange }) });

/**
 * Ein im selben Browser behobener Schritt entsteht aus dem Test vom Beginn des Laufs. Was der Mensch seitdem aus Empfehlungen
 * uebernommen hat, gilt fuer die anderen Schritte weiter.
 */
const carry = (candidate, current, repairedId) => {
    const steps = candidate.steps.map((step) => (step.id === repairedId ? step : current.steps.find(({ id }) => id === step.id) ?? step));
    return { ...candidate, notes: current.notes, steps, expectations: steps.map(({ id, expect }) => ({ id, text: expect })) };
};

/** Der Mensch entscheidet, ob Claude startet: Bis dahin laufen weder Docker noch Token, und das Angebot steht im offenen Chat. */
const createFixer = ({ sandbox, openSandbox }) => {
    let box = sandbox;
    /** @returns die Sandbox oder null, wenn sie gerade nicht geht; `say` meldet das */
    const open = async (chat, say) => {
        if (box !== undefined && box !== null) return box;
        try {
            chat.progress(t('run.flow.preparingSandbox'));
            box = await openSandbox();
            return box;
        } catch (error) {
            if (!(error instanceof CawError)) throw error;
            await say(withoutDot(error.message));
            return null;
        }
    };
    const cannotFix = (chat) => (message) => chat.choose('deciding', t('run.flow.cannotFix', { message }), [ONLY_CLOSE]);
    return {
        sandbox: () => box,
        open,
        /** Ein Schritt, dessen Plan sich durch eine Empfehlung geaendert hat, braucht eine neue Aufnahme. @returns der Schritt oder null */
        offerChanged: async ({ id, title }, chat) => {
            const choice = await chat.choose('deciding', t('run.flow.offerChanged', { id, title: withoutDot(title) }), [RERECORD, CLOSE]);
            if (choice !== RERECORD.id) return null;
            return await open(chat, cannotFix(chat)) === null ? null : { id, reason: t('run.flow.planChanged', { title: withoutDot(title) }), rerecord: true };
        },
        /**
         * Claude empfiehlt von sich aus, wenn der Lauf Fehler oder Warnungen hatte.
         * @returns das Ergebnis von advise oder null
         */
        advise: async ({ flawed, advise, chat }, spec) => {
            if (!flawed) return null;
            const ready = await open(chat, (message) => { chat.progress(t('run.flow.cannotAdvise', { message })); });
            return ready === null ? null : advise({ sandbox: ready, spec });
        },
        /**
         * Ein Schritt ist gescheitert: Der Mensch kann Claude fragen, im Zustand des Fehlers, und ihn beheben lassen. Erst seine
         * Nachricht oder sein Klick startet Claude.
         * @param spec der Test, auf den sich Empfehlungen im Gespraech beziehen
         * @param canAsk der Knopf „Ursache von Claude untersuchen lassen“: Claude empfiehlt wie mit --advise, nur auf Klick
         * @returns { advice, target, repaired, ask, forget }: `advice` aus dem Gespraech oder null; `forget`: die gelernte Wirkung dieses Schritts vergessen; `target` wird mit Vorlauf behoben; `repaired`
         *          ist schon im selben Browser behoben; `ask`: Claude soll die Ursache suchen und empfehlen
         */
        settle: async ({ failed, chat, verdict, talk, repairHere }, spec, { canAsk = false, repeated = false } = {}) => {
            const { diagnosis } = failed;
            const app = diagnosis?.side === 'app';
            let hint = failed.suspect ? t('run.flow.suspect') : '';
            if (diagnosis !== undefined) {
                const warn = app ? ` ${t('run.flow.hideWarn')}` : '';
                hint = ` ${diagnosis.text} ${diagnosis.findings.join(' ')}${warn}`;
            }
            const where = t(repairHere === undefined ? 'run.flow.whereFresh' : 'run.flow.whereHere');
            // Dass man Claude fragen kann, sagt die Statuszeile darunter.
            const ask = '';
            // Derselbe Fehler nach einem Beheben: Noch ein Beheben desselben Schritts aendert nichts, die Ursache liegt woanders.
            const again = repeated ? t('run.flow.again', { config: CONFIG_FILE }) : '';
            let question = `${t('run.flow.failed', { id: failed.id, reason: withoutDot(failed.reason) })}${hint}${findingsText(verdict)}${again}${where}${ask}`;
            // Dasselbe als Karte: oben Schritt, Grund und Einschaetzung, die Befunde zum Aufklappen, unten der naechste Schritt.
            const card = {
                id: failed.id,
                reason: withoutDot(failed.reason),
                ...(diagnosis === undefined ? {} : { diagnosis: { side: diagnosis.side, strength: diagnosis.strength, text: diagnosis.text, findings: diagnosis.findings } }),
                ...(diagnosis === undefined && failed.suspect ? { suspect: true } : {}),
                ...(app ? { warn: t('run.flow.hideWarn') } : {}),
                failures: hardFailures(verdict),
                warnings: (verdict?.warnings ?? []).map(({ text, origin }) => `${withoutDot(text)}${origin === undefined ? '' : ` (${origin})`}`),
                ...(repeated ? { warn: again.trim() } : {}),
                next: `${where}${ask}`.trim(),
            };
            // Spricht alles fuer die Anwendung, ist die Ursache im Code der naheliegende Weg; beheben bleibt moeglich, der Mensch entscheidet.
            const secondary = (option) => ({ ...option, primary: false });
            let options = canAsk
                ? (app ? [ASK, secondary(FIX), CLOSE] : [FIX, secondary(ASK), CLOSE])
                : (app ? [secondary(FIX), CLOSE] : [FIX, CLOSE]);
            if (repeated) options = canAsk ? [ASK, secondary(FIX), CLOSE] : [{ ...CLOSE, primary: true }, secondary(FIX)];
            const effectOnly = isEffectCause(failed.reason);
            if (effectOnly) options = [secondary(FORGET_EFFECT), ...options];
            let talker = null;
            for (;;) {
                const answer = await chat.discuss(question, options, question === undefined ? undefined : card);
                question = undefined;
                if (answer?.message !== undefined) {
                    if (talk === undefined) continue;
                    if (talker !== null && !talker.over()) {
                        talker.send(answer.message, answer.element);
                        continue;
                    }
                    const ready = await open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                    if (ready !== null) talker = talk({ sandbox: ready, spec }, answer.message, answer.element);
                    continue;
                }
                const advice = talker === null ? null : await talker.end();
                if (answer?.choice === FORGET_EFFECT.id) return { advice, target: null, forget: failed.id };
                if (answer?.choice === ASK.id) return { advice, target: null, ask: true };
                if (answer?.choice !== FIX.id) return { advice, target: null };
                if (await open(chat, cannotFix(chat)) === null) return { advice, target: null };
                if (repairHere === undefined) return { advice, target: failed };
                const repaired = await repairHere({ sandbox: box, reason: failed.reason });
                if (repaired.candidate === undefined) {
                    await chat.choose('deciding', t('run.flow.noNewRecording', { id: failed.id, reason: failureText(repaired.verdict) }), [ONLY_CLOSE]);
                }
                return { advice: advice ?? repaired.repairAdvice ?? null, target: null, repaired: { ...repaired, id: failed.id, reason: failed.reason } };
            }
        },
    };
};

/** Was nach „Neue Wirkung übernehmen“ geschieht, in einem Satz. */
const forgottenText = (id) => t('run.flow.forgotten', { id, runs: LEARN_RUNS });

/** Was „Übernehmen“ in die Testdatei schreibt, in einem Satz. */
const adoptedText = (current, changes, whole) => {
    if (whole) return t('run.flow.adoptWhole', { count: current.steps.length });
    if (changes.length === 0) return '';
    return t('run.flow.adoptChanges', { list: changes.map(({ id, reason, rerecord }) => t(rerecord ? 'run.flow.adoptRerecorded' : 'run.flow.adoptFixed', { id, reason: withoutDot(reason) })).join('; ') });
};

const decisionText = (current, changes, seen, warnings = [], { fresh = [], whole = false } = {}) => [
    t('run.flow.checkPassed'),
    ...(adoptedText(current, changes, whole) === '' ? [] : [adoptedText(current, changes, whole)]),
    ...(warnings.length === 0 ? [] : [t('run.flow.decisionWarnings', { list: warnings.map(({ text }) => withoutDot(text)).join('; ') })]),
    ...(seen.length === 0 ? [] : [t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') })]),
    ...(() => {
        const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
        return known.length === 0 ? [] : [t('run.flow.decisionKnown', { list: known.join('; ') })];
    })(),
    ...(() => {
        const positional = positionalActions(current, whole ? undefined : new Set(changes.map(({ id }) => id)));
        return positional.length === 0 ? [] : [t('run.flow.decisionPositional', { list: positional.join(', ') })];
    })(),
    ...changes.flatMap(({ expectChange }) => (expectChange === undefined ? [] : [t('run.flow.decisionExpect', { id: expectChange.id, after: expectChange.after, before: expectChange.before })])),
    ...(staleSteps(current).length === 0 ? [] : [t('run.flow.decisionStale', { ids: staleSteps(current).map(({ id }) => id).join(', ') })]),
    t('run.flow.decisionQuestion'),
].join(' ');

/**
 * Dieselbe Entscheidung als Karte: oben was uebernommen wuerde und was der Mensch vorher wissen muss, je ein Punkt; Warnungen,
 * bekannte Meldungen und ueber die Position gewaehlte Aktionen zum Aufklappen.
 */
const decisionCard = (current, changes, seen, warnings = [], { fresh = [], whole = false } = {}) => {
    const adopted = adoptedText(current, changes, whole);
    const known = [...new Set([...fresh, ...changes.flatMap((change) => change.fresh)])];
    const stale = staleSteps(current);
    return {
        title: t('run.flow.decisionTitle'),
        facts: [
            ...(adopted === '' ? [] : [adopted]),
            ...changes.flatMap(({ expectChange }) => (expectChange === undefined ? [] : [t('run.flow.decisionExpect', { id: expectChange.id, after: expectChange.after, before: expectChange.before })])),
            ...(stale.length === 0 ? [] : [t('run.flow.decisionStale', { ids: stale.map(({ id }) => id).join(', ') })]),
        ],
        ...(seen.length === 0 ? {} : { warn: t('run.flow.decisionSeen', { list: [...new Set(seen)].join('; ') }) }),
        details: [
            { title: t('run.flow.decisionWarningsTitle'), items: warnings.map(({ text }) => withoutDot(text)) },
            { title: t('run.flow.decisionKnownTitle'), items: known },
            { title: t('run.flow.decisionPositionalTitle'), items: positionalActions(current, whole ? undefined : new Set(changes.map(({ id }) => id))) },
        ].filter(({ items }) => items.length > 0),
        question: t('run.flow.decisionQuestion'),
    };
};

const changeNote = (changes) => {
    if (changes.length === 0) return undefined;
    return changes.map(({ id, reason, rerecord, expectChange }) => `${t(rerecord ? 'run.flow.noteRerecorded' : 'run.flow.noteFixed', { id, reason: withoutDot(reason) })}${expectChange === undefined ? '' : t('run.flow.noteBefore', { before: expectChange.before })}`).join(' ');
};

/**
 * Behebt einen Schritt und prueft den ganzen Test ohne Claude, bis er besteht oder der Mensch aufhoert. Scheitert dabei ein anderer
 * Schritt, klaert ihn der Mensch im Chat. Nur was wirklich behoben wurde, aendert sich in der Datei.
 * @param draft        der Test, im Speicher: die Datei oder eine noch nicht uebernommene Aufnahme
 * @param target       { id, reason }, null prueft zuerst
 * @param changes      schon behobene Schritte, etwa im selben Browser nach einem Testlauf
 * @param whole        der ganze Plan ist neu und wird als Ganzes uebernommen
 * @param discardCode  Exit-Code beim Verwerfen, sonst der des Pruefdurchlaufs
 * @param fresh        bei einer ganzen Aufnahme: Meldungen, die neu als bekannt gelten
 * @param seenFailures harte Fehler aus der Aufnahme davor, der Mensch sieht sie vor seiner Entscheidung
 * @param execute      ein einzelner Lauf
 * @param adopt        (Test, geaenderte Schritte oder undefined fuer alle, { withNotes }) schreibt die Datei und nennt sie
 * @param advising     Claude empfiehlt von sich aus bei Fehlern und Warnungen; nach einer Aufnahme erst, wenn ein Schritt behoben wird
 * @param log          Meldung im Terminal
 */
export const fixFlow = async ({ draft, target = null, changes: done = [], whole = false, fresh = [], discardCode, seenFailures = [], sandbox, openSandbox, execute, adopt, log, advising: advisingFirst = true }) => {
    const fixer = createFixer({ sandbox, openSandbox });
    const changes = [...done];
    const seen = [...seenFailures];
    // Was der Mensch aus Empfehlungen uebernimmt, gilt erst mit dem Testplan: Bis dahin steht es nur im Entwurf.
    const advised = new Set();
    let advisedNotes = false;
    let advising = advisingFirst || changes.length > 0;
    let current = draft;
    let next = target;
    /** Empfehlungen in den Entwurf. @returns der Schritt, den eine Empfehlung veraltet gemacht hat, wenn der Mensch ihn beheben will */
    const absorb = async (result, chat, { offer = true } = {}) => {
        if (result === null) return null;
        current = result.spec;
        result.touched.forEach((id) => advised.add(id));
        advisedNotes ||= result.notes;
        for (const file of result.files) log(t('run.flow.adviceAdopted', { file }));
        noticeFiles(result.files, chat);
        return offer && result.stale.length > 0 ? fixer.offerChanged(result.stale[0], chat) : null;
    };
    const takeAdvice = async (concluded) => (advising ? absorb(await fixer.advise(concluded, current), concluded.chat) : null);
    // Welcher Schritt mit genau diesem Grund schon behoben wurde: Kommt derselbe Fehler wieder, sagt der Chat das.
    const fixedBefore = new Set();
    /** Scheitert ein Schritt, klaert der Mensch ihn. @returns { next, repaired } */
    const settle = async (concluded) => {
        const key = `${concluded.failed.id} ${concluded.failed.reason}`;
        const settled = await fixer.settle(concluded, current, { repeated: fixedBefore.has(key) });
        if (settled.forget !== undefined) {
            current = withoutEffects(current, settled.forget);
            advised.add(settled.forget);
            concluded.chat.notice(forgottenText(settled.forget));
        }
        if (settled.target !== null || settled.repaired !== undefined) fixedBefore.add(key);
        const changed = await absorb(settled.advice, concluded.chat, { offer: settled.target === null && settled.repaired === undefined });
        return { next: settled.target ?? changed, repaired: settled.repaired?.candidate === undefined ? null : settled.repaired };
    };
    const lostAdvice = () => {
        if (advised.size > 0 || advisedNotes) log(t('run.flow.adviceLost'));
    };
    for (;;) {
        if (next !== null) {
            const { id, reason, rerecord, diagnosis, evidence } = next;
            advising = true;
            let offered = null;
            const repaired = await execute({
                sandbox: fixer.sandbox(),
                spec: current,
                repair: { id, reason, ...(rerecord ? { rerecord } : {}), ...(diagnosis === undefined ? {} : { diagnosis, evidence }) },
                conclude: async (concluded) => {
                    const { verdict, candidate, failed, chat, repairAdvice } = concluded;
                    // Als Naechstes prueft ein Lauf ohne Claude, in einem neuen Fenster.
                    if (candidate !== undefined) return { next: 'check' };
                    // Hat Claude beim Beheben schon empfohlen, etwa eine Aenderung an der Anwendung, startet es dafuer nicht noch einmal.
                    offered = repairAdvice === undefined ? await takeAdvice(concluded) : await absorb(repairAdvice, chat);
                    if (offered !== null) return { next: 'claude' };
                    if (failed) ({ next: offered } = await settle(concluded));
                    else await chat.choose('deciding', t('run.flow.noNewRecording', { id, reason: failureText(verdict) }), [ONLY_CLOSE]);
                    return offered === null ? undefined : { next: 'claude' };
                },
            });
            next = offered;
            if (next !== null) continue;
            if (repaired.candidate === undefined) {
                lostAdvice();
                return repaired.exitCode;
            }
            current = repaired.candidate;
            seen.push(...hardFailures(repaired.verdict));
            changes.push(changeOf({ id, reason, rerecord, ...repaired }));
        }

        let choice = null;
        let offered = null;
        let repairedHere = null;
        // Die geschriebene Testdatei: Uebernommen wird gleich nach der Wahl, damit der Chat sie noch nennen kann.
        let saved = null;
        const played = await execute({
            spec: current,
            replay: replayUpToStale(current),
            note: changeNote(changes),
            conclude: async (concluded) => {
                const { verdict, failed, chat } = concluded;
                offered = await takeAdvice(concluded);
                if (offered !== null) return { next: 'claude' };
                if (verdict.status === 'pass') {
                    // Bleibt nach dem Pruefdurchlauf ein Schritt veraltet, etwa der zweite von zwei angepassten, kommt er als Naechstes dran.
                    const [stale] = staleSteps(current);
                    const again = stale === undefined ? null : { id: 'rerecord-next', label: t('run.button.rerecordStep', { id: stale.id }), primary: true };
                    const count = current.steps.length;
                    const options = again === null ? [adoptButton(count), DISCARD] : [again, adoptButton(count, { primary: false }), DISCARD];
                    choice = await chat.choose('deciding', decisionText(current, changes, seen, verdict.warnings, { fresh, whole }), options, decisionCard(current, changes, seen, verdict.warnings, { fresh, whole }));
                    if (choice === 'rerecord-next' && await fixer.open(chat, (message) => chat.choose('deciding', t('run.flow.cannotFix', { message }), [ONLY_CLOSE])) !== null) {
                        offered = { id: stale.id, reason: t('run.flow.stillStale'), rerecord: true };
                        return { next: 'claude' };
                    }
                    if (choice === ADOPT.id) {
                        const only = whole ? undefined : new Set([...changes.map(({ id }) => id), ...advised]);
                        saved = adopt(current, only, { withNotes: advisedNotes });
                        return { outcome: t('run.flow.saved', { file: saved }) };
                    }
                    return { outcome: t('run.flow.discarded') };
                }
                if (failed) {
                    ({ next: offered, repaired: repairedHere } = await settle(concluded));
                    if (offered !== null) return { next: 'claude' };
                    return repairedHere === null ? undefined : { next: 'check' };
                }
                await chat.choose('deciding', t('run.flow.checkFailed', { reason: failureText(verdict), findings: findingsText(verdict) }), [ONLY_CLOSE]);
                return undefined;
            },
        });
        next = offered;
        if (next !== null) continue;
        if (repairedHere !== null) {
            // Im selben Browser behoben: Der naechste Pruefdurchlauf zeigt, ob es auch ohne Claude geht.
            current = carry(repairedHere.candidate, current, repairedHere.id);
            seen.push(...hardFailures(repairedHere.verdict));
            changes.push(changeOf(repairedHere));
            continue;
        }
        if (played.verdict.status !== 'pass') {
            log(t('run.flow.notRepeatable'));
            lostAdvice();
            return played.exitCode;
        }
        if (choice === ADOPT.id && saved !== null) {
            log(t('run.flow.planReplaced', { file: saved }));
            return played.exitCode;
        }
        log(t('run.flow.discarded'));
        return discardCode ?? played.exitCode;
    }
};

/**
 * Neu aufnehmen: Claude arbeitet mit dem Menschen am Chat, danach geht es weiter wie beim Beheben.
 * @param sandbox  Docker, Token und Image
 * @param execute  ein einzelner Lauf, liefert { exitCode, verdict, candidate, failed }
 */
export const recordFlow = async ({ sandbox, execute, adopt, log }) => {
    const recorded = await execute({
        sandbox,
        conclude: async ({ verdict, candidate, chat }) => {
            // Die Aufnahme steht: Der Pruefdurchlauf kommt in einem neuen Fenster.
            if (candidate !== undefined) return { next: 'check' };
            await chat.choose('deciding', t('run.flow.noRecording', { reason: failureText(verdict) }), [ONLY_CLOSE]);
            return undefined;
        },
    });
    if (recorded.candidate === undefined) return recorded.exitCode;
    // Der Pruefdurchlauf einer Aufnahme kostet ohne Zutun keine weiteren Token: Empfohlen wird erst, wenn ein Schritt behoben wird.
    return fixFlow({ draft: recorded.candidate, whole: true, fresh: recorded.fresh ?? [], seenFailures: hardFailures(recorded.verdict), sandbox, execute, adopt, log, advising: false });
};

/**
 * Testlauf nach Plan, ohne Claude. Auf dev mit Terminal steht der Chat von Anfang an daneben und zeigt die Schritte; scheitert einer,
 * klaert der Mensch ihn dort sofort. Docker und Token gibt es erst auf seine Nachricht oder seinen Klick.
 * @param canFix    auf dev, mit Terminal und Chat
 * @param advise    --advise: Bei Fehlern oder Warnungen empfiehlt Claude von sich aus, auch in einem bestandenen Lauf. Kostet Token
 * @param handover  der Mensch will das Fenster danach bekommen
 * @param fillBaselines bestandene Schritte ohne Vergleich der Requests bekommen ihn aus diesem Lauf, ohne Claude und Token
 * @param onPlayed  bekommt das Ergebnis des Abspielens, bevor es weitergeht
 */
export const runFlow = async (options) => {
    const { spec, until, handover, canFix, advise = false, fillBaselines = false, sessionAgent = false, openSandbox, execute, adopt, log, hint } = options;
    const fixer = createFixer({ openSandbox });
    let target = null;
    let repaired = null;
    let rerun = false;
    let current = spec;
    /** Beim Testlauf ist die Datei der Massstab: Was der Mensch uebernimmt, steht sofort darin. @returns ein veralteter Schritt zum Beheben */
    const keep = async (result, chat, { offer = true } = {}) => {
        if (result === null) return null;
        current = result.spec;
        if (result.touched.length > 0 || result.notes) log(t('run.flow.adviceAdopted', { file: adopt(current, new Set(result.touched), { withNotes: result.notes }) }));
        for (const file of result.files) log(t('run.flow.adviceAdopted', { file }));
        noticeFiles(result.files, chat);
        return offer && result.stale.length > 0 ? fixer.offerChanged(result.stale[0], chat) : null;
    };
    /** Ob gleich ein neues Fenster kommt: fuer Claude (beheben), den Pruefdurchlauf oder einen neuen Testlauf. */
    const windowAfter = () => {
        if (rerun) return { next: 'run' };
        if (repaired !== null) return { next: 'check' };
        return target === null ? undefined : { next: 'claude' };
    };
    const played = await execute({
        spec,
        replay: until === undefined ? replayOf(spec) : cutReplay(spec, until),
        handover: () => handover && target === null && repaired === null && !rerun,
        ...(canFix ? {
            testing: true,
            /**
             * Der Mensch entwickelt im hergestellten Zustand. Der Test ist vorbei: Neuladen veraendert kein Ergebnis mehr, die Werkbank
             * zeigt danach nur, dass die Seite den Zustand verlassen hat. „Zustand neu herstellen“ spielt die Schritte von vorn ab.
             * @param refresh    laedt die aktuelle Seite ohne Cache neu (Aktualisieren, F5, Logo)
             * @param restore    laedt neu und spielt die Schritte bis zum Zustand ab; liefert die Meldung
             * @param onRefresh  meldet der Werkbank, wer aktualisiert (null: gesperrt)
             * @param onReload   nach dem Neuladen der ganzen Werkbank; liefert die Abmeldung
             */
            develop: async ({ chat, talk, until: state, refresh, restore, onRefresh, onReload, toCode }) => {
                let talker = null;
                const at = state === undefined ? t('run.develop.atEnd') : t('run.develop.atState', { state });
                let question = t('run.develop.intro', {
                    start: state === undefined ? t('run.develop.runDone') : t('run.develop.stateReady', { state }),
                    at,
                    restore: RESTORE.label,
                    agent: t(sessionAgent ? 'run.develop.sessionAgent' : 'run.develop.costsTokens'),
                });
                const options = [RESTORE, END_DEVELOP];
                // Laedt der Dev-Server gerade neu, scheitert das Neuladen: Das ist eine Meldung im Chat, kein Ende des Laufs.
                const attempt = async (what, work) => {
                    try {
                        const text = await work();
                        if (text) chat.notice(text);
                    } catch (error) {
                        chat.notice(t('run.develop.attemptFailed', { what, message: String(error?.message ?? error).split(/\r?\n/)[0] }));
                    }
                };
                onRefresh?.(() => attempt(t('run.develop.refresh'), refresh));
                const offReload = onReload?.(() => { chat.notice(t('run.develop.benchReloaded', { at, restore: RESTORE.label })); });
                chat.onPicked?.((picked) => {
                    toCode(picked);
                    chat.notice(t('run.develop.picked', { label: picked.label }));
                });
                try {
                // Mit der eigenen Claude-Code-Session als Agent wartet sie nicht auf die erste Frage im Chat: Wer in Claude Code
                // arbeitet, will die Seite im Zustand gleich ansehen. Fragen aus dem Chat bekommt sie danach wie sonst.
                if (sessionAgent) {
                    const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                    if (ready !== null) talker = talk({ sandbox: ready, spec: current });
                }
                for (;;) {
                    const answer = await chat.develop(question, options);
                    question = undefined;
                    if (answer === null || answer.choice === END_DEVELOP.id) return;
                    if (answer.choice === RESTORE.id) {
                        chat.progress(t('run.develop.restoring'));
                        await attempt(RESTORE.label, restore);
                    } else if (answer.message !== undefined) {
                        if (talker !== null && !talker.over()) {
                            talker.send(answer.message, answer.element);
                            continue;
                        }
                        const ready = await fixer.open(chat, (message) => { chat.progress(t('run.flow.claudeUnavailable', { message })); });
                        if (ready !== null) talker = talk({ sandbox: ready, spec: current }, answer.message, answer.element);
                    }
                }
                } finally {
                    onRefresh?.(null);
                    offReload?.();
                    chat.onPicked?.(null);
                    // Auch bei Fenster zu oder Fehler: Claude laeuft nicht weiter und verbraucht keine Token.
                    if (talker !== null) await Promise.resolve(talker.end()).catch(() => {});
                }
            },
            conclude: async (concluded) => {
                const { failed, chat, verdict } = concluded;
                /** Nach Claudes Empfehlung. @returns true, wenn damit alles entschieden ist */
                const afterAdvice = async (advised) => {
                    target = await keep(advised, chat);
                    if (target !== null) return true;
                    // Der Code der Anwendung ist geaendert: Den Test jetzt anzupassen wuerde den Fehler verdecken. Ob es reicht, zeigt ein neuer Lauf.
                    if (failed && (advised?.files ?? []).length > 0) {
                        // Nur was wirklich geaendert ist: Wer die Aenderung am Code abgelehnt und nur die Config uebernommen hat, liest das so.
                        const app = appFilesOf(advised.files);
                        const what = app.length > 0 ? t('run.flow.appChanged', { files: app.join(', ') }) : t('run.flow.filesChanged', { files: advised.files.join(', ') });
                        rerun = await chat.choose('deciding', t('run.flow.rerunOffer', { id: failed.id, what }), [RERUN, CLOSE]) === RERUN.id;
                        return true;
                    }
                    return false;
                };
                const advised = advise ? await fixer.advise(concluded, current) : null;
                if (await afterAdvice(advised)) return windowAfter();
                if (!failed) {
                    const filled = fillBaselines && concluded.baselines !== undefined ? ` ${baselineText(concluded.baselines)}` : '';
                    const summary = `${t(verdict.status === 'pass' ? 'run.flow.runPassed' : 'run.flow.runFailed')}${filled}${findingsText(verdict)}${advised === null ? '' : t('run.flow.adviceInReport')}`;
                    // Ein bestandener Lauf wartet auf niemanden, auch nicht mit Warnungen.
                    if (advised === null && verdict.status === 'pass') chat.notice(summary);
                    else await chat.choose('deciding', summary, [ONLY_CLOSE]);
                    return;
                }
                // Mit --advise hat Claude schon empfohlen; sonst sucht Claude die Ursache erst auf Klick, dasselbe wie --advise, nur bei Bedarf.
                let settled = await fixer.settle(concluded, current, { canAsk: !advise });
                if (settled.ask) {
                    await keep(settled.advice, chat, { offer: false });
                    if (await afterAdvice(await fixer.advise(concluded, current))) return windowAfter();
                    settled = await fixer.settle(concluded, current);
                }
                if (settled.forget !== undefined) {
                    current = withoutEffects(current, settled.forget);
                    log(t('run.flow.effectForgotten', { id: settled.forget, file: adopt(current, new Set([settled.forget])) }));
                    chat.notice(forgottenText(settled.forget));
                }
                const changed = await keep(settled.advice, chat, { offer: settled.target === null && settled.repaired === undefined });
                if (settled.repaired?.candidate !== undefined) repaired = settled.repaired;
                else target = settled.target ?? changed;
                return windowAfter();
            },
        } : {}),
    });
    options.onPlayed?.(played);
    if (fillBaselines && played.baselines !== undefined) {
        current = withBaselines(current, played.baselines);
        log(t('run.flow.baselinesAdded', { ids: [...played.baselines.keys()].join(', '), file: adopt(current, new Set(played.baselines.keys())) }));
    }
    if (fillBaselines && played.effects !== undefined) {
        current = withEffects(current, played.effects);
        log(t('run.flow.effectsLearned', { ids: [...played.effects.keys()].join(', '), file: adopt(current, new Set(played.effects.keys())) }));
    }
    if (rerun) {
        log(t('run.flow.rerunning'));
        return runFlow({ ...options, spec: current, openSandbox: fixer.sandbox() === undefined ? openSandbox : async () => fixer.sandbox() });
    }
    const shared = { discardCode: EXIT.fail, sandbox: fixer.sandbox(), openSandbox, execute, adopt, log };
    if (repaired !== null) {
        return fixFlow({ ...shared, draft: carry(repaired.candidate, current, repaired.id), changes: [changeOf(repaired)], seenFailures: hardFailures(repaired.verdict) });
    }
    if (target !== null) return fixFlow({ ...shared, draft: current, target });
    if (played.failed && !canFix) hint?.(played.failed);
    return played.exitCode;
};
