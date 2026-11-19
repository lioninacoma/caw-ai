[English](guide.md) · Deutsch

# Handbuch

Wie caw im Einzelnen arbeitet. Zum Nachschlagen: [Befehle](commands.de.md), [Konfiguration](configuration.de.md) und [Testdateien](test-files.de.md).

**Features:**

1. [Tests in normaler Sprache: einmal aufnehmen, ohne KI abspielen](#tests-in-normaler-sprache-einmal-aufnehmen-ohne-ki-abspielen)
2. [Einen Fehler nachstellen: `reproduce`](#einen-fehler-nachstellen-reproduce)
3. [Jeden Zustand erreichen und entwickeln](#jeden-zustand-erreichen-und-entwickeln)
4. [Einordnen und reparieren](#einordnen-und-reparieren)
5. [Aus Claude Code steuern](#aus-claude-code-steuern)
6. [Sicher mit Zugangsdaten und Produktion](#sicher-mit-zugangsdaten-und-produktion)
7. [Export nach Playwright](#export-nach-playwright)

## Tests in normaler Sprache: einmal aufnehmen, ohne KI abspielen

Ein Test ist ein Plan in normaler Sprache. Du gehst ihn einmal im Browser durch, oder Claude tut es; caw speichert, was getan wurde, und spielt es ab dann ohne KI ab, lokal und in CI.

### Drei Wege

| Befehl | Was passiert | KI und Chat | Umgebung |
|---|---|---|---|
| `record <test> --env <umgebung>` | Testplan neu aufnehmen oder ablösen | immer | nur Umgebungen mit `agent` |
| `run <test> --env <umgebung>` | Testlauf nach Plan | Chat auf Umgebungen mit `agent` von Anfang an daneben; Claude erst nach deiner Nachricht, deinem Klick auf „Ursache von Claude Code untersuchen lassen“ oder „Schritt beheben“, oder mit `--explain` | alle |
| `record <test>@S4 --env <umgebung>` | Ab S4 bis zum Ende neu aufnehmen. S1 bis S3 laufen ohne Claude, dann folgt Claude dem alten Plan ab S4; einen Prüflauf vorher gibt es nicht, die Ursache klärst du also mit `run` | immer | nur Umgebungen mit `agent` |

`open --env <umgebung>` öffnet die Anwendung angemeldet, mit Werkbank und Chat, aber ohne Test, siehe [Befehle](commands.de.md#open). `open <test>` spielt vorher einen Test ab, `open <test>@S4` hält am Einstieg in S4 an, siehe [Zustand herstellen und übernehmen](#zustand-herstellen-und-übernehmen).

`<umgebung>` ist ein Name aus `environments`, etwa `local`. Mandanten sind eigene Umgebungen (`extends`).

**Testplan** heißt: eine YAML-Datei je Test unter `caw/tests/<test>.yaml`. Sie enthält die Testschritte; ihre Aufzeichnung steht in `caw/recordings/<test>.yaml`, siehe [Testdateien](test-files.de.md).

```bash
# Neuer Test: vorführen, Plan freigeben, am Ende übernehmen
# (--role entfällt, wenn caw.config.json nur eine Rolle kennt)
caw record bestellung --env local --role kunde

# Testen, ohne KI
caw run bestellung --env local

# Testen, bei Fehlern oder Warnungen empfiehlt Claude im Chat (kostet Token)
caw run bestellung --env local --explain

# Testen ohne Chat wie in CI, mit oder ohne sichtbares Fenster
caw run bestellung --env local --no-chat
caw run bestellung --env local --headless

# Bis zum Einstieg in S4 (S1 bis S3 ausgeführt, seine Eingaben offen) und dort am lokalen Code weiterarbeiten
caw open bestellung@S4 --env local

# Ab S4 bis zum Ende neu aufnehmen
caw record bestellung@S4 --env local
```

In Claude Code reicht ein Satz: „bring mich dahin, wo der Warenkorb gefüllt ist“. Die Session sucht Test und Schritt und startet `open`. Passt nichts, schlägt sie `record` vor.

### Testplan aufnehmen: `record`

Die Rolle nennst du nur beim ersten Mal; das Tool schreibt `role` und `writes` (`true`, außer mit `--read-only`), nie `environments`. Bei einer Neuaufnahme bleiben sie erhalten. Claude Code bzw. Docker, Token und Image werden vorab geprüft, damit deine Vorführung nicht umsonst ist.

1. **Start.** Chrome und der Chat gehen auf, du bist angemeldet. Bei einem neuen Test fragt der Chat: „Selbst vorführen“ oder „Beschreiben, Claude Code nimmt auf“. Beim Beschreiben schreibst du in den Chat, was der Test tun soll; du kannst dabei zu der Seite gehen, um die es in einem Satz geht, und jede Nachricht behält die Seite, auf der sie entstand; der Chat bestätigt sie mit ihrer Nummer (H1, H2 …), wie die Freigabekarte sie zeigt. Klicks werden nicht aufgenommen, „An Claude Code übergeben“ beendet es, und Claude findet den Weg selbst. Bei einem bestehenden Test fragt der Chat: selbst vorführen oder Claude geht dem Testplan nach.
2. **Ablaufplan.** Claude legt den Entwurf als Karte im Chat vor: je Testschritt ID, Titel, Aktion und ein erwartetes Ergebnis, dazu Hinweise mit Annahmen und offenen Fragen. Der Plan ist die spätere Testdatei ohne Aufzeichnung, YAML mit `notes` und `steps`. Metadaten oder Aufzeichnungen, die Claude dort einträgt, wirft das Tool weg. Du gibst frei oder schreibst, was anders sein soll, und Claude legt eine neue Fassung vor. Bis zur Freigabe weist der Host jede Aktion in der Anwendung als `plan-required` ab, Lesen geht.
3. **Ausführen.** Claude geht den Weg in einem frischen Browser. Du kannst pausieren, schreiben, Elemente markieren und klicken. Ändert sich der Weg grundlegend, legt Claude eine neue Fassung vor. Alle Aktionen seit der letzten Prüfung gehören zum nächsten Schritt des Plans, deshalb muss Claude in dieser Reihenfolge prüfen (`step-order`).
4. **Bereinigen.** Claude geht von sich aus die Aktionen durch und nennt im Chat, was wegfällt, ohne dass du freigeben musst. Screenshots und das erste von zwei `fill` aufs selbe Feld streicht das Tool selbst.
5. **Prüflauf.** Das Tool spielt die Aufzeichnung ohne Claude ab, im Chat daneben siehst du den Fortschritt. Scheitert ein Schritt, bietet der Chat an, ihn zu beheben, auch im noch nicht übernommenen Entwurf.
6. **Ablösen.** Der Chat zeigt eine Karte „Prüflauf bestanden“ mit dem, was übernommen würde; Warnungen und über die Position gewählte Aktionen lassen sich aufklappen. Dazu „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“, das ein zweiter Klick bestätigt. Erst dann wird die Testdatei geschrieben. Besteht der Prüflauf nicht, bleibt der alte Testplan unberührt, Plan (`plan.yaml`) und Entwurf (`test-draft.yaml`) liegen im Lauf-Ordner. Committet wird nichts automatisch.

**Testdaten:** Läufe mit `writes: true` hinterlassen Daten: je einen Datensatz von Claude und vom Prüflauf, je Beheben bis zu zwei weitere. Auch was Claude gestrichen hat, ist in der Anwendung passiert.

#### Die Werkbank

Mit Chat läuft alles auf einer Seite, wie bei Cypress:

- **Oben:** das caw-Logo, dann `/ Projekt / Test` und ein Badge mit dem, was der Lauf tut („Claude Code nimmt auf“, „Prüflauf“, „Entwickeln“); der ganze Satz („Claude Code nimmt morning-errand auf“) steht in seinem Tooltip. Rechts die Fakten in Mono (Umgebung und Rolle nur, wenn das Projekt mehrere hat, eine Produktionsumgebung immer, dein lokaler Build nur unter einem Overlay), eine Status-Pille mit Punkt und Wort („Claude Code arbeitet“, „Du bist dran“, „S3 gescheitert“, „Alle bestanden“), der Chip REC/PLAY/PAUSE und das Menü ⋯.
- **Links:** die Schritte mit ihrem Zustand (läuft, bestanden, gescheitert, nicht erreicht) und ihrer Dauer. Nach der Übergabe bietet ein Schritt, der sich öffnen lässt, „Öffnen bis S3“ an, wenn du auf ihn zeigst (wie F1).
- **Mitte:** die Anwendung in einem iframe, darüber ihre Adresse; auf einer Produktions- oder nur lesenden Umgebung trägt die Adresse ein Badge. Darunter die Zähler, etwa „12 Requests · 1 Konsole“: Ein Klick darauf (oder F2, F3) öffnet Requests (Name, Ausgang, Dauer) und Konsole (Fehler und Warnungen) in einer Schublade. Bei einem Konsolenfehler geht sie von selbst auf; Esc (oder „Esc schließt“ in der Schublade) schließt sie.
- **Rechts:** der Chat mit Claude.
- **Menü ⋯** (auch Strg+K): jede Funktion mit ihrer Taste, in zwei Gruppen. Lauf: Pause (F9), Anwendung neu laden (F5), Lauf abbrechen (Esc) und nach der Übergabe Öffnen… (F1). Ansicht: Requests (F2), Konsole (F3), Schritte ausblenden (F4), Chat ausblenden (F6), Nur Anwendung (F8). Darunter Animationen aus (F10), Einstellungen (Strg+,) und Tastenkürzel (?). Die Pfeiltasten bewegen, Enter wählt, Esc schließt. Die Tasten wirken auch, wenn der Fokus im Chat liegt.
- **Einklappen:** Ein Klick auf den Titel „Schritte“ oder „Chat“ (oder F4, F6) klappt den Bereich zu einer schmalen Leiste ein. Braucht der Chat dich, klappt er von selbst auf.
- **Nur Anwendung:** F8 zeigt nur die Anwendung, mit einer Zeile darüber und „Zurück zur Werkbank F8“.
- **Neu laden:** F5 (auch Strg+R, in der Anwendung und im Chat, ⋯ → Anwendung neu laden oder `/reload` im Chat) lädt nach der Übergabe die aktuelle Seite ohne Cache neu; Chat und Schritte bleiben. Solange der Test läuft, auch während „Neu öffnen“ oder F1 einen Zustand herstellt, ist das gesperrt und der Menüeintrag ausgegraut: Ein Neuladen würde den Zustand für die folgenden Schritte verfälschen. Lädt jemand die ganze Werkbank über den Browser neu, baut caw sie wieder auf; lief gerade der Test, bricht er ohne Ergebnis ab.

#### Einstellungen

Strg+, (oder ⋯ → Einstellungen, `/settings` im Chat) macht aus der Werkbank ihre Einstellungsseite; Esc oder „Zurück zum Lauf“ führt zurück. Die Seite gehört dir, gilt für jedes Projekt und nennt die `prefs.json`, in die sie speichert. Sie ändert nur, wie die Werkbank aussieht; alles andere zeigt sie nur lesend:

- **Allgemein:** Erscheinungsbild System, Hell oder Dunkel, sofort in Werkbank und Chat (System folgt deinem Betriebssystem, bis du Hell oder Dunkel wählst); Animationen (F10); die Sprache mit ihrer Herkunft (`CAW_LANG`, `prefs.json`, `caw.config.json` oder das System), nur lesend. Aufteilung: ob Schrittliste (F4) und Chat (F6) offen sind, wenn ein Lauf beginnt.
- **Claude:** „Fragen, bevor Claude Code Token verbraucht“, nur lesend: „Nicht mehr fragen“ im Hinweis schaltet es aus, `tokenNotice` aus `prefs.json` zu entfernen bringt ihn zurück. Die Werkbank kann es nicht ändern, weil sie ihren Ursprung mit der getesteten Anwendung teilt. Mit einem Agenten der Agent dieses Laufs (aus `--agent` oder der Config).
- **Notizen für Claude:** deine eigene `caw.md` und die `caw/caw.md` des Projekts, jede mit Pfad und Zahl der Zeilen, nie mit ihrem Inhalt; „Pfad kopieren“ kopiert deinen.
- **Tastatur:** die Tasten unten.
- **Dieser Lauf**, nur lesend: Projekt, Umgebung mit ihren Schaltern (Claude erlaubt, beschreibbar, Produktion), Rolle, Code und Version.

Hell und dunkel: Werkbank, Chat, Berichtsseite und die Karte „caw explore“ folgen deinem System, solange du keinen Modus festlegst; die Wahl steht als `mode` in `prefs.json` (`system`, `light` oder `dark`).

#### Tastatur

| Taste | Was sie tut |
|---|---|
| F1 | Öffnen… einen Test oder Schritt (nach der Übergabe) |
| F2, F3 | Requests, Konsole |
| F4, F6 | Schritte, Chat ein- oder ausklappen |
| F5 | Die Anwendung ohne Cache neu laden (nach der Übergabe) |
| F8 | Nur Anwendung und zurück |
| F9 | Claude anhalten oder weitermachen lassen |
| F10 | Animationen aus oder an |
| Esc | Schließt das offene Menü, den Dialog, die Einstellungen oder die Schublade, bricht das Wählen eines Elements ab; sonst fragt es den Abbruch des Laufs an, ein zweites Esc innerhalb von 4 Sekunden bestätigt |
| Strg+K | Das Menü ⋯ |
| Strg+, | Einstellungen |
| ? | Tastenkürzel (nicht beim Tippen) |
| Strg+↵ | Chat: die Hauptaktion, solange das Eingabefeld leer ist (Cmd+↵ auf dem Mac) |
| Alt+↵ | Chat: schickt deinen Text als Prüfpunkt, während du vorführst |
| / | Chat: die Befehle, am Anfang des Eingabefelds |

F11 und F12 bleiben bei Chrome. Die DevTools-Konsole beginnt in der Werkbank, nicht in der App; Rechtsklick → Untersuchen in der App stellt sie auf den App-Frame. In der Werkbank hält `caw` Werkzeuge bereit (`caw.help()` listet sie):

| | |
|---|---|
| `caw.app` | Das Fenster der App: `caw.app.fetch('/api/…')`, `caw.app.document.title` |
| `caw.info` | Projekt, Test, laufender Schritt, Modus, Lauf-Ordner, Umgebung, URL, Rolle, Framework, Version. Nur Namen, nie Passwörter |
| `caw.requests()`, `caw.console()` | Die Listen hinter den Zählern in der Fußzeile |
| `caw.locator(el)` | Der Locator, den caw für ein Element aufnehmen würde, etwa `await caw.locator($0)` nach Untersuchen |
| `caw.ready()` | Die Bereit-Prüfung des Frameworks und die offenen Requests, jetzt |

Die App teilt ihren Ursprung mit der Werkbank und kann `caw` ebenfalls lesen; deshalb steht darin nichts Geheimes, und nichts davon ändert den Lauf.

Die Werkbank liegt unter der Adresse der Anwendung selbst, auf ihrem Origin. Viele Anwendungen greifen auf das oberste Fenster zu (`top.Ext`, `parent.config`, `top.location.href`), weil sie sich im Portal dafür halten. In der Werkbank geht das genauso:

- **Gleicher Origin:** Der Browser blockt solche Zugriffe nicht.
- **Globale Namen:** Die Werkbank reicht globale Namen der Anwendung durch, die sie selbst nicht hat. `top.Ext` ist also das `Ext` der Anwendung.
- **Adresse:** Die Adresse der Werkbank folgt der Anwendung, `top.location.href` stimmt.
- **Navigation:** Lenkt die Anwendung das oberste Fenster um (`top.location = …`, Formular mit `target="_top"`, auch per POST), landet die Seite in der Anwendung, und die Werkbank bleibt. Ein laufender Test geht weiter; nur dein Neuladen (F5, Knopf des Browsers) macht ihn ungültig.

Ausgeliefert wird die Werkbank vom Tool: Abgefangen wird nur das Dokument des obersten Fensters, kein anderer Request. Damit sich die Anwendung einbetten lässt, entfernt der Testbrowser bei den Dokumenten ihrer Hosts `X-Frame-Options` und `frame-ancestors` aus der CSP, nur in diesem Browser.

Der Chat liegt in einem abgeschotteten iframe mit eigenem Origin (`sandbox` ohne `allow-same-origin`). Die Anwendung erreicht weder sein DOM noch kann sie dort als Mensch entscheiden. Weil sie den Origin der Werkbank teilt, kann sie die Sandbox des iframes entfernen oder ihn neu laden; das Tool schreibt den Chat nur in ein Dokument mit opakem Origin und prüft das in einem Skript, das die Seite nicht anfassen kann. Wurde der Chat-Rahmen neu geladen oder hat er seine Sandbox verloren, endet der Lauf mit `chat-tampered`. Meldungen von Werkbank und Chat zählen nie als Fehler der Anwendung.

**Mit Chat immer die Werkbank.** Ohne Chat (`--no-chat`, CI, `--headless`) läuft die Anwendung allein im eigenen Fenster.

**Grenzen:**

- iframes innerhalb der Anwendung, deren Host nicht freigeschaltet ist, bleiben leer.
- Was eine Seite nur oben im Fenster tut (`window.top`-Prüfungen, Frame-Busting per Skript), kann im iframe anders laufen. Solche Prüfungen gehören in der Testumgebung abgeschaltet.
- Die Werkbank liefert caw selbst aus, deshalb hält Chrome sie für eine öffentliche Seite, und seine Prüfung auf private Netze (Local Network Access) würde die Anwendung im Intranet oder auf diesem Rechner sperren. Der Testbrowser erteilt diese Berechtigung nur dem Origin der Anwendung.

#### Der Chat

In der Werkbank rechts, auch in einem Testlauf ohne Claude. Der Verlauf wandert über die Werkbänke von Vorführung, Claude und Prüflauf mit. Dort läuft auch Claudes Log mit: Text als Nachricht, Befehle als aufklappbare Aktionen. Das Fenster ist die einzige Quelle für Anweisungen, die Seite der Anwendung erreicht den Chat nicht. Die Mitschrift liegt als `chat.log` im Lauf-Ordner.

- **Dein Kontext auf der Freigabekarte:** Jede Nachricht, die du beim Vorführen oder Beschreiben geschrieben hast, steht mit einer Markierung (✎) auf der Karte, zusammen mit dem, was Claude daraus gemacht hat: Hinweis eines Schritts, seine Wiederholung, Notizen des Tests oder „nur für diese Aufnahme“. Claude muss jede davon zuordnen; ein Plan, der eine auslässt, wird abgelehnt.
- **Vorführen:** Klicks, Doppelklicks, Feldänderungen, aus `caw/fixtures` gewählte Dateien und die Tasten Enter, Tab, Escape und die Pfeiltasten werden mitgeschnitten (Pfeile nicht in einer nativen Auswahlliste, deren Wahl als Feldänderung ankommt). Eine Nachricht gibt Claude Kontext an dieser Stelle des Wegs. Alt+↵ (oder `/checkpoint` vor dem Text) schickt sie stattdessen als Prüfpunkt: einen künftigen Schritt mit Screenshot an dieser Stelle; tippe dafür zuerst, was zu sehen sein soll. „Vorführung beenden“, die Hauptaktion über dem Eingabefeld, beendet die Vorführung. Solange sie läuft, steht über der Anwendung „● AUFNAHME – deine Klicks zählen“. Passwortfelder verlassen die Seite nie. Alle anderen Eingaben gehen an Claude und landen in der Aufzeichnung, führe also nur Testdaten vor.
- **Nachricht schreiben:** Claude liest sie vor der nächsten Aktion, denn solange lehnt das Tool jeden Browserbefehl ab. Denkt Claude gerade, dauert das etwas.
- **Pause:** Solange Claude arbeitet, steht „Pause F9“ in der Statuszeile über dem Eingabefeld (auch F9 oder `/pause`). Claude hält vor der nächsten Aktion an, die Status-Pille zeigt es. Danach kannst du schreiben und in der Anwendung klicken, bis du „Weiter“ drückst. Deine Klicks kommen in den Test, darum erst klicken, wenn „Pausiert“ dasteht.
- **Hauptaktion:** Das, was als Nächstes zu tun ist („Fertig“, „Plan freigeben“, „Vorführung beenden“, „An Claude Code übergeben“, „Weiter“), steht in voller Breite über dem Eingabefeld; Strg+↵ löst es aus, solange das Feld leer ist.
- **Befehle:** `/` am Anfang des Eingabefelds öffnet die Befehle: `/element`, `/checkpoint`, `/pause`, `/open`, `/requests`, `/console`, `/reload`, `/app`, `/settings`, `/keys`, `/cancel`, jeder mit seiner Taste. Pfeiltasten und Enter wählen, Tab ergänzt, Esc schließt; ein Befehl, der gerade nicht geht, ist ausgegraut. `/open`, `/requests`, `/console`, `/app`, `/settings` und `/keys` öffnen diese Ansicht in der Werkbank, wie ihre Tasten.
- **Karten:** Plan, Rückfrage, Empfehlung (bei einer Code-Änderung mit dem Unterschied), Fehler, Entscheidung und der Hinweis auf Token kommen als Karten. Jede Karte hat eine Hauptaktion; eine weitere Wahl steht daneben, mehr liegen hinter „Mehr“.
- **Element markieren:** In Vorführung, Plan, Pause, Rückfrage und beim Fehler klären wählt `/element` das Bauteil, auf das du dich beziehst: Ein Ring mit Beschriftung (Rolle und Name, etwa `button "Add todo" in dialog "New todo"`) zeigt, was ein Klick wählen würde, und ein Band oben in der Anwendung sagt, dass der Klick dort nichts auslöst und Esc abbricht. Der Klick kommt nicht in die Aufzeichnung. Das Element erscheint als Chip über dem Eingabefeld (× entfernt es) und hängt an deiner nächsten Nachricht; Claude bekommt seine Beschreibung.
- **Rückfragen:** Claude fragt per `ask-operator`. Deine Antwort oder „Fertig“ gibt den Lauf frei.
- **Schritt zurück:** Eine Rückspultaste gibt es nicht. Sag Claude, was falsch war: Es geht zum passenden Zustand und streicht den Umweg mit `omit`. Abgeschicktes bleibt in der Anwendung, dann hilft nur ein neuer Lauf.
- **Abbrechen:** Esc (oder `/cancel`, ⋯ → Lauf abbrechen) fragt „Wirklich abbrechen? (Esc)“; ein zweites Esc oder ein Klick darauf innerhalb von 4 Sekunden bestätigt und beendet alles sofort mit `error`. Den Chat zu schließen wirkt genauso, ohne ihn gibt es weder Freigabe noch Entscheidung.

Die Zeit für den Menschen zählt zum Limit von Claude, darum ist der Standard hier 60 Minuten (`--agent-timeout 60m`).

#### Was in der Aufzeichnung steht

- **Was aufgezeichnet wird:** Erfolgreiche `click`, `fill`, `type`, `press`, `goto`, `reload`, `wait-ready`, `remember` und `check`. Fehlversuche, `eval` und `snapshot` fehlen.
- **Vollständigkeit:** Gespeichert wird nur, wenn jeder Schritt ein bestandenes `check` hat und danach keine Aktion mehr folgt. Sonst nennt die Ausgabe, was fehlt, und der Lauf endet mit `fail`.
- **Stabile Ziele:** Statt Referenzen speichert die Datei, wie ein Mensch das Element findet, als Playwright-Locator: Rolle und vollständiger Name, Beschriftung oder Text, eingegrenzt auf den Dialog oder die Zeile darum, z. B. `getByRole('dialog', { name: 'Neue Bestellung' }).getByRole('button', { name: 'Senden', exact: true })`; für ExtJS-Komponenten ohne Rolle auch `locator('extjs=…')` ([ExtJS](extensions/extjs.de.md)). Listeneinträge hängen damit am Text; ändern sich die Daten, scheitert der Schritt.
- **Umwege:** Claude nennt beim Einreichen, was nicht zum Weg gehört (`"omit": [12, "14-16"]`). Sind alle Schritte bestanden, ist `omit` Pflicht, auch leer, und die Ablehnung zeigt Claude die ganze Aktionsliste. Prüfungen und `remember` lassen sich nicht streichen. Der Bericht listet alles Gestrichene. Übersieht Claude einen Umweg, bleibt er drin. Der Prüflauf beweist, dass der Weg läuft, nicht dass er der kürzeste ist: Prüfe die Datei vor dem Commit, denn ihre Ausdrücke laufen später ohne Claude in der angemeldeten Seite.
- **Laufkennung:** Jeder Lauf hat eine eigene `runTag`, z. B. `CAW-20261105185233`. Claude schreibt sie in Freitexte, an denen sich ein Datensatz wiedererkennen lässt. Die Aufzeichnung speichert `{{runTag}}`, und jedes Abspielen setzt seinen Wert ein. So findet ein Lauf seinen eigenen Datensatz statt den eines früheren. Bildet die Anwendung aus dem Namen eine Adresse in Kleinbuchstaben (`/akten/akte-caw-20261105185233`), steht dort `{{runTagLower}}`.
- **Daten relativ zu heute:** Ein Datum höchstens 60 Tage vor oder nach dem Aufnahmetag (im Format der Browsersprache oder `JJJJ-MM-TT`) speichert die Aufzeichnung als `{{date}}`, `{{date+7}}` bzw. `{{isoDate-1}}`; `{{date}}` schreibt das Datum, wie die Sprache es schreibt (`de-DE` 23.11.2026, `en-US` 11/23/2026). Das Abspielen setzt das Datum seines Tages ein, so scheitert ein Test nicht am nächsten Tag an „Datum liegt in der Vergangenheit“. Daten weiter weg bleiben fest.
- **Werte aus dem Lauf:** Eine Bestellnummer gibt es bei jedem Lauf neu. Claude liest sie mit `remember bestellnr "<ausdruck>"`, die Aufzeichnung speichert danach `{{bestellnr}}` samt Ausdruck, und das Abspielen liest den Wert neu aus der Seite. Einen leeren Wert weist der Befehl ab.
- **Projektkontext über Tests hinweg:** `caw/caw.md` ist für die Tests, was CLAUDE.md für Claude Code ist: relevante Infos zum Projekt und Eigenheiten der Anwendungen. Du hältst sie von Hand und checkst sie ein, etwa „die Suche merkt sich die letzte Eingabe“. Claude bekommt sie in jedem Lauf mit Claude. Die Datei zählt nicht zum Schritt-Hash, eine Änderung entwertet also keine Aufzeichnung. Betrifft eine Notiz den Weg, nimm neu auf. Nur Verhalten, keine personenbezogenen Daten.

**Grenzen:**

- **Claude kann beim Suchen schreiben.** Eine Schreibsperre gibt es bewusst nicht: In vielen Anwendungen hängen Abschicken und Folgeschritte voneinander ab, und lesende und schreibende Requests sehen auf HTTP-Ebene oft gleich aus. Stattdessen gilt: Aufnahme nur auf Umgebungen mit `agent` und nur mit Testkonten, die Leitfaden-Regel „nur eigene Datensätze“, die Freigabe des Plans, das Schrittbudget, und der Bericht listet unter „Schreibende Aufrufe“ jeden schreibenden Request an die Hosts der Anwendung, mit Namen und ohne Parameterwerte. Lesend ist ein Request mit GET, HEAD oder OPTIONS, eine GraphQL-Query oder einer, auf den ein Muster aus `reads` passt; An- und Abmelden, Sitzung und Token (Pfade, die auf login, logout, session, token, auth, refresh, csrf u. Ä. enden) zählen nicht; alles andere schreibt. Requests an Anmeldedienste aus `allowHosts` und an fremde Hosts (Analytics, CDNs) machen einen Test nie schreibend.
- **Schrittbudget:** `--max-actions` (sonst `maxActions` aus der Config, sonst 100) zählt `click`, `fill`, `type`, `press`, `goto` und `reload` von Claude, auch gescheiterte. Was du selbst vorführst, zählt nicht.
- **Claude reagiert nicht sofort:** `claude -p` läuft ohne Eingabe, Nachricht und Pause greifen vor der nächsten Aktion. „Abbrechen“ wirkt sofort.

### Testlauf: `run`

Spielt die Aufzeichnung ohne Modell, Docker und Token ab. Auf Umgebungen mit `agent` steht der Chat von Anfang an neben dem Fenster, außer in CI (Variable `CI` gesetzt), mit `--no-chat` oder `--headless`. Die erste Zeile im Terminal nennt den Modus und ob der Lauf Vergleichswerte lernt (nur mit `--learn` oder wenn du auf der Abschlusskarte „Vergleichswerte speichern“ klickst), die letzte, was sich an den Dateien des Tests geändert hat. Der Chat: Er zeigt jede Aktion (`S3 · 4/12 click …`) samt neuer Versuche, die Eingabe ist gesperrt. Besteht der Lauf, meldet der Chat das samt Warnungen und wartet nicht; er schließt mit dem Lauf oder bleibt bei [`open <test>`](#zustand-herstellen-und-übernehmen) neben dem übergebenen Fenster. Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben). Fehlt die Aufzeichnung ganz, endet es mit Exit 4 und nennt `record`. Ist ein Schritt veraltet, endet es mit Exit 4 und nennt `record <test>@<schritt>`, um ab diesem Schritt neu aufzunehmen.

- **Warten:** Es gibt keine festen Pausen. Ein Schritt wartet, bis sein Ziel sichtbar und nicht überdeckt ist. Das deckt Lademasken, Overlays und Dialoge in Dialogen ab, denn nur der oberste Dialog ist klickbar. `check` wiederholt die Prüfung, bis sie stimmt oder das Zeitlimit abläuft.
- **Zeitlimits:** Standard sind 30 Sekunden je Schritt, änderbar mit `--step-timeout` (etwa `--step-timeout 45s`) oder von Hand je Aktion mit `timeoutMs` und je Prüfung mit `recording.timeoutMs` in der Testdatei. Klärt oder behebt Claude aus dem Lauf heraus, gelten `--agent-timeout <dauer>` (Standard 60m) und `--max-actions <n>` wie bei `record`.
- **Fehler:** Scheitert ein Schritt, nennt der Bericht den Testschritt samt Aktion und verweist auf einen Screenshot. Aufräumschritte wie „Abbrechen“ laufen dann nicht mehr, ein angelegter Datensatz kann offen bleiben.
- **Fehlschläge:** Konsolenfehler, Skriptfehler, fehlgeschlagene Requests und HTTP-Status ab 500 beenden das Abspielen beim nächsten Schritt. Ebenso sichtbare Dialoge, Fehlermeldungen und Meldungen aus `messageSelectors`, die bei der Aufnahme nicht vorkamen, wobei Zahlen im Text nicht zählen. Beim Adapter `web` gilt ein Statushinweis (`role=status`, `aria-live=polite`, etwa ein Erfolgs-Toast) nicht als Fehlschlag: Er kommt je nach Tempo oder nicht, unbekannt steht er einmal als Warnung im Bericht. Ein Dialog mit Eingabefeldern ist Bedienung, keine Meldung. Dazu verlorene Anmeldung, eine nicht geladene Anwendung (bei `extjs`: kein ExtJS auf der Seite), eine stehen gebliebene Lademaske (`aria-busy`, bei `extjs` die Lademaske), eine andere Seite als aufgezeichnet und jedes nicht erfüllte `check`.
- **Beheben:** Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben).
- **Ohne Chat:** `--no-chat` spielt im sichtbaren Fenster ab wie in CI, ohne Chat und ohne Claude: Bericht, Screenshot, Hinweis auf einen Lauf mit Chat zur Ursache (`record <test>@<schritt>` nur bei gewollter Änderung), Exit-Code. `--headless` ebenso, aber ohne Fenster, in der aufgenommenen Größe (sonst 1920×1080). Beide gehen nicht mit `--explain` (Exit 3). Ob eine Anwendung den Headless-Modus annimmt, zeigt erst der Lauf; sonst bleibt `--no-chat`.
- **Grenzen:** Abgespielt wird nur, was aufgezeichnet wurde. Claudes Blick auf Auffälliges fehlt, und auch hier gelten Schreibschutz und Host-Sperre. Toasts, die zwischen zwei Schritten wieder verschwinden, sieht das Abspielen nicht.

### Ablauf eines Laufs

Ein Lauf mit Claude, also beim Aufnehmen und Beheben, macht Folgendes:

1. **Abweisen, was nicht laufen darf:** Config, Testdatei, Ziel und Schreibschutz werden geprüft. Beim Agenten `local` dazu, ob Claude Code da ist.
2. **Image** (nur `docker`): Einmal bauen, aus dem Image des Projekts plus Claude und dem Container-Teil des Tools. Neu gebaut wird nur nach Änderungen daran.
3. **Öffnen:** Chrome starten, anmelden, Seite öffnen und warten, bis die App geladen ist (mit der [Overlay-Erweiterung](extensions/overlay.de.md) auch den lokalen Code prüfen). Fehler hier ergeben `error`, ohne dass Tokens anfallen.
4. **Claude starten:** Bei `local` startet `claude -p` auf deinem Rechner mit den gesperrten Werkzeugen (siehe [Sandbox-Grenzen](#sandbox-grenzen)), bei `session` wartet der Lauf auf deine Session. Bei `docker` startet der Container (`docker run --rm`): Firewall setzen, danach gibt der Container alle Rechte ab. Ist die Sandbox nicht nachweislich dicht, läuft Claude nicht.
5. **Testen:** `claude -p` arbeitet den Plan ab, jeder Browserbefehl geht als Datei über den Kanal an den Host. Das Urteil prüft der Host.
6. **Abschließen:** Mit dem Urteil endet Claude sofort (Prozess bzw. Container). Bericht, Trace und `floats.log` (Klicks und, bei `extjs`, die Reihenfolge der schwebenden Fenster mit Zeiten, ohne Inhalte) liegen unter `.caw/runs/<lauf>/`. Der Trace (`trace.zip`) enthält Seiteninhalte, Requests und Cookies des Testkontos; gib ihn nicht weiter. Bei `signIn.type: basic` zeichnet er keine Snapshots auf, damit das Passwort aus dem Authorization-Header nicht darin landet. Eine erneute Anmeldung im Lauf (Zustand herstellen) unterbricht den Trace: Der Teil davor bleibt als `trace-1.zip`, `trace-2.zip` …, und in keinem steht ein Anmeldeformular oder -Request; Screenshots und `claude.log` unter `agent/`. Das Log entsteht laufend und zeigt Claudes Text und Befehle mit den Sekunden seit dem Start; dieselben Zeilen laufen im Terminal mit. Eine Schlusszusammenfassung nach dem Urteil fehlt darin. Im Terminal ist die Ausgabe farbig, die Datei bleibt ohne Farbcodes; `NO_COLOR=1` schaltet Farben ab. Chrome verschwindet ebenfalls.

Exit-Codes: `0` pass, `1` fail, `2` error (die Umgebung ist schuld), `3` Eingabe abgelehnt, `4` Aufnahme nötig (`record`).

#### Fehlercodes

Alle Fehlercodes mit Abhilfe: [Befehle › Fehlercodes](commands.de.md#fehlercodes).

## Einen Fehler nachstellen: `reproduce`

Claude geht ein Fehlerticket selbstständig durch und berichtet, ob es sich nachstellen lässt.

`caw reproduce "<fehlerbericht>"` gibt Claude einen Fehlerbericht und einen angemeldeten Browser, sonst nichts zu tun: kein Plan
zum Freigeben, keine Rückfragen, keine Entscheidungen (siehe [Befehle](commands.de.md#reproduce)). Mit `--from <test>@S3` führen
zuerst die Schritte eines Tests in den Zustand, in dem der Fehler auftritt. Claude liest den Bericht, geht ihn nach, urteilt nach
Belegen (Screenshot, Konsole, Netzwerk) und endet mit `yes`, `no` oder `unclear`, den Schritten in Klartext und, wenn es den
Quelltext gelesen hat, einem Hinweis auf die Ursache mit Datei und Zeile.

Was Claude dabei darf und was nicht:

- Nur auf Umgebungen mit `agent`, nie auf Produktion; der Browser erreicht nur die Hosts des Projekts.
- Schreiben nur, wo die Umgebung `writable` ist; sonst wird jeder schreibende Request abgebrochen und im Bericht genannt.
- Kein Plan, kein `check`, keine Frage an dich, keine Empfehlung und keine Code-Änderung: Diese Befehle werden abgelehnt.
- Nichts landet im Projekt: Bericht und `draft-test.yaml` bleiben im Laufordner. Die Erwartungen des Entwurfs beschreiben das
  richtige Verhalten, der aufgenommene Test scheitert also, solange der Fehler da ist, und besteht, sobald er behoben ist.

Aus deiner Claude-Code-Session bittest du darum („stell diesen Fehler nach: …“): Die Session startet `caw_start` mit
`command: "reproduce"`, ist selbst der Agent ohne zusätzliche Tokens und bekommt Urteil, Bericht und Entwurf über `caw_status`.

## Jeden Zustand erreichen und entwickeln

Dieselben Tests bringen dich angemeldet in jeden Zustand deiner App und übergeben dir das Fenster: um dort mit Claude im Chat zu entwickeln.

### Zustand herstellen und übernehmen

```bash
caw open <test> --env local
caw open <test>@S4 --env local
```

`open <test>` spielt den ganzen Test ab und übergibt dann das Fenster. `open <test>@S4` hält am Einstieg in `S4` an: S1 bis S3 laufen ganz, mit ihren Prüfungen, von S4 nur die Navigation am Anfang (`goto`, Klicks, `wait-ready`). Seine Eingaben und seine Prüfung bleiben offen, du machst also genau dort weiter, wo die Arbeit von S4 beginnt, etwa in der Maske, die er ausfüllt. Im Terminal steht „Bereit für S4 <Name>: Navigation ausgeführt, Eingaben offen.“ S4 selbst wird nicht bewertet; spätere Schritte laufen nicht, sie dürfen also auch veraltet sein. `@S1` meldet an, öffnet die Anwendung und führt die Navigation von S1 aus.

Von S4 läuft nichts, wenn er gar keine Eingabe hat (`fill`, `type`, `upload`, etwa nur ein Klick auf „Absenden“) oder nicht aktuell aufgenommen ist. Hat einer seiner Klicks am Anfang in früheren Läufen Daten geschrieben (gelernte Wirkungen), hält es vor diesem Klick an. Das Terminal nennt den Grund.

Der Ablauf ist deterministisch, die Umgebung nicht: Das ist kein Snapshot. Der Weg läuft jedes Mal neu, mit neuen Daten, und weicht die Anwendung ab, scheitert der Schritt sichtbar.

- **Code:** Wie bei jedem Lauf der Code der Umgebung: gegen deinen Dev-Server dein aktueller Code, sonst der ausgelieferte Stand. Die Zeile `Code:` sagt, welcher (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)). Änderungen siehst du mit F5, der Maskenzustand ist danach weg. Um wieder hinzukommen, startest du den Befehl neu.
- **Weg scheitert:** Du klärst den Fehler im Chat und kannst den Schritt beheben lassen. Schließt du ihn, geht das Fenster trotzdem an dich, der Bericht nennt den Fehler. Der Exit-Code bleibt das Urteil.
- **Keine Aufzeichnung:** Exit 4, erst aufnehmen. Das gilt für die Schritte vor S4; S4 selbst darf veraltet sein.
- **Lernt nichts:** Anders als `run` lernt `open` keine Vergleichswerte und keine Wirkungen.
- **Nicht in CI:** Mit gesetztem `CI` endet `open` mit Exit 3; niemand ist da, der das Fenster übernimmt.
- **Zustand nach Reload:** Ob eine Ansicht nach F5 im selben Zustand bleibt, hängt von der Anwendung ab.

### Im hergestellten Zustand entwickeln

Mit Chat bleibt der Chat nach der Übergabe offen (Zustand „Entwickeln“):

Die Werkbank startet in **Nur Anwendung** (F8 holt Schritte und Chat zurück); das Browserfenster bleibt, wie es ist. Die Anwendung füllt jetzt die ganze Fläche; die aufgenommene Größe gilt nur, solange caw abspielt, auch beim Herstellen eines Zustands.

- **Fragen:** Du fragst Claude im Chat, gern zu einem Element, das du mit `/element` in der App gewählt hast. Claude liest den Quellcode und antwortet. Code ändert es nie selbst, es schlägt geprüfte Änderungen vor: „Änderung übernehmen“ schreibt sie in deinen Projektordner, „Prompt kopieren“ gibt sie dir für deine eigene Session.
- **Claude bedienen lassen:** Auf deine Bitte klickt Claude, füllt aus, drückt Tasten, navigiert oder lädt neu, etwa „klick den gewählten Button“. Vor allem, was Daten speichert oder löscht, fragt es nach.
- **Bug untersuchen:** Füge ein Bugticket in den Chat ein. Claude stellt es im hergestellten Zustand nach, sieht sich Konsole, Requests, Werte der Komponenten und den Quellcode an, nennt die Ursache mit Datei und Zeile und schlägt die Korrektur als Änderung vor, die du per Klick übernimmst. Danach neu laden oder den Zustand neu herstellen, und Claude prüft, ob der Bug weg ist.
- **Neu laden** (F5): lädt die aktuelle Seite ohne Cache neu, damit deine Änderung sofort da ist. Chat und Schritte bleiben; der Test ist schon vorbei, sein Ergebnis ändert sich nicht.
- **Neu öffnen** (im Chat): beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet neu an und spielt die Aufzeichnung bis zur selben Stelle ab (bei `@S4` bis zum Einstieg in S4), mit neuen Testdaten, also genau wie jeder andere Lauf.
- **Öffnen… (F1):** ein beliebiger Test dieser Umgebung, jeder Rolle, optional mit einem Schritt. Bevor caw dein Fenster ersetzt, bestätigst du im Chat, etwa mit „S2 öffnen“. Dann spielt caw den Test im selben Fenster mit dem Konto der Rolle des Tests ab: ohne Schritt den ganzen Test, mit Schritt bis zu dessen Einstieg, wie bei `open <test>@<schritt>`. Scheitert das Herstellen, weiß Claude im Chat warum; es kann den Test auch anpassen, etwa einen Klick auf einen Cookie-Banner optional machen, und die Änderung steht sofort in der Testdatei.
- **Element an Claude Code:** Mit `/element` im Chat klickst du in der Anwendung auf ein Element, auch auf einen ausgegrauten Knopf oder einen in einem Dialog; ein Ring mit Beschriftung zeigt, was der Klick wählt (der Klick löst dort nichts aus, Esc bricht ab). Es hängt an deiner nächsten Frage im Chat, und caw legt es mit Beschriftung, Komponente bzw. Quelle, Seite und Requests für deine Claude-Code-Session ab, abrufbar mit `caw_selection`.
- **Ende:** „Lauf beenden“ oder Fenster schließen.

### So arbeitest du damit

1. Dev-Server der App starten, wo du entwickelst: im Devcontainer oder auf Windows.
2. Im Projektordner aus PowerShell aufrufen: `pnpm caw:my-app:smoke`. Chrome geht maximiert auf, und du siehst dem Test zu.
3. Ändern und Schritt 2 wiederholen.

Im Devcontainer selbst geht der Aufruf nicht, dort fehlt Chrome (und für den Agenten `docker` auch Docker). Für `docker` aus Windows: Git Bash endete beim Bau des Images bisher mit Exit 139, nutze PowerShell.

#### Übernehmen und weiterentwickeln

`npx caw open my-app-smoke` spielt den Test ab und lässt das Fenster nach dem Urteil offen:

- **Weiterklicken:** Du machst in derselben Seite und im selben Maskenzustand weiter, auch mit ungespeicherten Eingaben und DevTools.
- **Weiterentwickeln:** Gegen deinen Dev-Server als Umgebung lädt F5 deinen aktuellen Code. Mit der [Overlay-Erweiterung](extensions/overlay.de.md) bleibt der lokale Code, bis du das Fenster schließt. Einen automatischen Reload gibt es nicht, außer dem Hot Reload des Dev-Servers.
- **Zustand:** F5 verliert, was nur im Browser stand, etwa offene Dialoge und ungespeicherte Eingaben. Zurück dorthin bringt dich „Zustand neu herstellen“ im Chat oder ein neuer Testlauf.
- **Ende:** Fenster schließen beendet den Lauf. Der Exit-Code bleibt das Urteil.
- **Tastatur im Chat:** Strg+↵ (Cmd+↵) löst die Hauptaktion aus, solange das Eingabefeld leer ist, etwa „Plan freigeben“ oder „Vorführung beenden“; der Knopf zeigt dazu `Strg ↵`. Alt+↵ schickt einen Prüfpunkt, während du vorführst. Esc schließt zuerst ein offenes Menü und leert dann das Eingabefeld, wenn du darin tippst. Sonst fragt Esc den Abbruch an („Wirklich abbrechen? (Esc)“ und „Nein“), erst ein zweites Esc innerhalb von 4 Sekunden bestätigt ihn. Neue Auswahlknöpfe bekommen den Fokus, außer du tippst gerade.
- **Du bist dran:** Wartet der Chat auf dich (Plan, Entscheidung, Fehler klären), steht „DU BIST DRAN“ über der Anwendung, und das Terminal meldet einmal „Wartet im Chrome-Fenster auf dich: …“.
- **Aufnahme, Wiedergabe, Pause:** Ein Chip oben rechts in der Werkbank zeigt, was der Lauf tut: „REC“, solange Claude aufnimmt oder repariert, „PLAY“, solange caw abspielt (run, Prüflauf, Zustand herstellen), „PAUSE“, solange ein solcher Lauf pausiert (F9). Läuft nichts (nach dem Lauf, nach der Übergabe, nach dem Abbruch), gibt es keinen Chip.
- **Nach dem Lauf:** Das Ergebnis steht als letzte Zeile im Chat, etwa „Gespeichert: caw/tests/bestellung.yaml“. Darunter sagt die Abschlusskarte „Lauf bestanden“ oder „Lauf gescheitert“ (bei `reproduce` das Urteil, mit Beobachtet, Erwartet und Ursache), zählt die Schritte und zeigt den Befehl für einen neuen Lauf, mit einem Knopf zum Kopieren. Ihre Hauptaktion ist „Vergleichswerte speichern“, wenn der Lauf welche lernen kann, sonst „Fenster schließen“ oder „Bericht öffnen“; die übrigen stehen daneben oder, wenn es zwei sind, hinter „Mehr“. „Bericht öffnen“ öffnet die [Berichtsseite](#die-berichtsseite) in einem neuen Tab. Das Fenster bleibt noch 15 Sekunden offen, „Fenster schließen“ zählt herunter, und schließt sich dann selbst. Öffnet sich gleich ein neues Fenster (für Claude oder den Prüflauf), sagen Chat und Terminal das vorher.

Eigene Tabs kannst du jederzeit öffnen, auch während des Laufs: Gesteuert wird nur der Anwendungs-Tab samt Popups, und nur deren Fehler zählen. Klickst du dagegen im Anwendungs-Tab, während ein Lauf arbeitet, beeinflusst du den Test.

Du bleibst im Fenster hinter derselben Host-Sperre und bist als Testnutzer angemeldet. Dialoge wie `alert()` schließt Playwright automatisch, sie bleiben also nicht stehen. Das Profil ist frisch und wird am Ende gelöscht. Bleibt es etwa nach einem Abbruch liegen, entfernt es der nächste Lauf, sofern dessen Prozess nicht mehr läuft.

## Einordnen und reparieren

Scheitert ein Schritt, ordnet caw den Fehler ohne KI ein; Claude erklärt ihn auf Wunsch, nimmt einen Schritt neu auf oder schlägt eine Code-Änderung vor.

### Einschätzung: Test, Anwendung oder Umgebung

Scheitert ein Schritt, ordnet das Tool den Fehler ein, ohne Claude und ohne Token. Es nutzt nur, was jeder Browser liefert, unabhängig von Framework und Umgebung:

- **Requests** der Anwendung (`xhr`/`fetch`) mit Name, Status, Dauer und Ausgang: beantwortet, HTTP-Fehler, abgebrochen, fehlgeschlagen. Der Name ist Methode und Pfad, bei GraphQL dazu Typ und Name der Operation; Parameterwerte stehen nie darin, außer für die Parameter aus `requestKeys`. Ein Abbruch durch einen Seitenwechsel zählt nicht. Dazu kommen die **Namen der Parameter** ohne Werte, aus der Query, aus Formular-Bodys (`application/x-www-form-urlencoded`) und von der obersten Ebene von JSON-Bodys (als `json.<key>`).
- **Harte Fehler** des Laufs: Skriptfehler, Konsolenfehler, HTTP-Status.
- **Der Vergleich aus der Aufnahme:** `recording.network` hält je Schritt fest, welche Requests bei der Aufnahme beantwortet wurden und wie lange sie dauerten und mit welchen Parameternamen (`params`).

| Befund | Einschätzung |
|---|---|
| Request bricht ohne Seitenwechsel früh ab (unter 1 s oder einem Fünftel der Dauer bei der Aufnahme), HTTP ab 500, Skriptfehler | Anwendung, eindeutig |
| Ein Request, der scheitert, schickt andere Parameternamen als bei der Aufnahme („fehlt jetzt `a`, neu `b`“) | Anwendung, eindeutig |
| HTTP 4xx, Konsolenfehler, ein Request der Aufnahme kommt nicht mehr, andere Parameternamen bei beantwortetem Request | Anwendung, wahrscheinlich |
| Anmeldung verloren | Umgebung, eindeutig |
| Request deutlich langsamer als bei der Aufnahme (über 5 s und dreimal so lang), Netzfehler, später Abbruch | Umgebung, wahrscheinlich |
| Ziel fehlt bei sonst unauffälliger Seite | Test oder Testdaten, wahrscheinlich |

Der stärkste Befund entscheidet, die übrigen stehen darunter. Ohne auffällige Belege bleibt es „unklar“. Die Einschätzung steht im Chat, als Abschnitt „Einschätzung“ in `report.md` samt Tabelle der Requests neben denen der Aufnahme, in `result.json` und im Auftrag an Claude (`diagnosis`, `evidence`). Claude liest dort zuerst und kann mit `network` die letzten Requests abrufen.

Ohne `recording.network` sagt der Bericht das. Der Vergleich entsteht nie beim Aufnehmen oder Beheben: Unter Claudes Steuerung laufen auch Fehlklicks und Umwege, die aus der Aufzeichnung gestrichen werden, ihre Requests gehörten nicht zum Schritt. Er entsteht ohne Claude und Token durch ein `run --learn` (oder „Vergleichswerte speichern“ auf der Abschlusskarte eines bestandenen Laufs mit Chat), aus der bereinigten Aufzeichnung: Jeder bestandene Schritt ohne Vergleich bekommt ihn dann aus diesem Lauf, wenn er auf derselben Umgebung aufgenommen wurde. Ebenso die Wirkung je Aktion. Der Chat und das Terminal nennen die Schritte, nur dieses Feld ändert sich in der Datei, der Hash bleibt unberührt. Vorhandene Werte überschreibt ein `run` nie, außer sie stammen aus der Zeit vor den Parameternamen (Einträge ohne `params`). Sonst ändert ein Lauf keine Datei.

#### Wirkung je Aktion

Jede Aktion (Klick, Eingabe, Taste) hat eine Wirkung auf der Seite. Das Tool misst sie nach jeder Aktion, sobald die Seite ruhig ist, und hält sie in `recording.effects` fest. Die Wirkung ist der Unterschied zwischen vorher und nachher, ohne Werte:

| Liste | Inhalt | Beispiel |
|---|---|---|
| `controls` | Zustand der sichtbaren Bedienelemente: gesperrt, Pflicht, nur lesbar, ungültig, angehakt, aufgeklappt, gewählt, leer/gefüllt. Elemente in Listen- und Tabellenzeilen zählen nicht, denn das sind Daten, oft auch fremde. Von einer Liste zählt nur, ob sie Zeilen hat. | `+ input "Lieferadresse*" empty`, `+ list "Bestellungen" rows` |
| `view` | ARIA-Baum ohne Links, Feldinhalte und lange Texte (Listen sind Daten) | `+ - text: Bestellung vollständig? …` |
| `requests` | beantwortete Requests der Aktion mit Status | `GET /api/orders 200` |
| `responses` | Form der JSON-Antworten (Schlüsselpfade als Kurz-Hash) und fachliche Fehlerzeichen wie `success=false` | `GET /… form 3fa2c… success=true` |
| `console` | Meldungen der Konsole | `error: Bestellung laden fehlgeschlagen` |

Zahlen werden zu `#`, damit Bestellnummern und Daten nicht stören.

**Lernen:** Ein bestandener `run --learn` (oder „Vergleichswerte speichern“) trägt die Wirkung ein. Die ersten zwei gesunden Läufe gleichen sich ab. Erhalten bleibt nur, was in beiden gleich war; die Konsole sammelt alles, was vorkam. Danach gilt die Wirkung als gelernt (`runs: 2`) und kein Lauf ändert sie mehr. Ein neu aufgenommener Schritt lernt neu.

**Vergleich:**
- Fehlt beim Abspielen etwas aus der gelernten Wirkung, ist das eine Abweichung, ebenso eine neue Konsolenmeldung.
- Scheitert ein Schritt, nennt die Einschätzung die erste abweichende Aktion bis zu diesem Schritt (Anwendung, wahrscheinlich) und was stattdessen geschah. Claude bekommt sie als `evidence.effect`.
- Ist die Prüfung erfüllt, entscheidet die Art der Abweichung. Weicht eine gelernte Wirkung in einer Liste aus `effects.fail` der Config ab, **scheitert der Schritt** (Einschätzung: Anwendung, wahrscheinlich; auch ein anderer Datenstand als beim Lernen kann das erklären, etwa eine Liste, die damals leer war). Standard ist `["controls", "console"]`: der Zustand der Bedienelemente und neue Konsolenmeldungen. Diese Signale waren in gesunden Läufen völlig stabil. Abweichungen in `view`, `requests` und `responses` bleiben Warnungen im Bericht; so fällt Drift auf, bevor eine Prüfung reißt. Mit `"effects": { "fail": [] }` bleiben alle Abweichungen Warnungen.
- **Wiederholungen (`retry`)** verändern die Anwendung, etwa wird ein Eintrag ein zweites Mal geöffnet und damit gesperrt. Deshalb gilt nach dem ersten neuen Versuch im Lauf: Schritte, die nur als Vorlauf erneut laufen (bei `retry.from`), werden weder verglichen noch gelernt; spätere Schritte warnen nur noch, nur der wiederholte Schritt selbst scheitert weiter an seiner Wirkung. Weicht er zweimal gleich ab (gemessen an den Listen aus `effects.fail`), gibt es keinen weiteren Versuch.
- **Selbstbereinigung:** Besteht ein ganzer Lauf ohne Wiederholung, und weicht ein Schritt nur in Listen außerhalb von `effects.fail` ab, dann schwankt das offenbar. Die fehlenden Zeilen fallen aus der gelernten Wirkung, etwa ein Request, der nicht in jedem Lauf kommt. Die Warnung erscheint so nur einmal. Abweichungen in Listen aus `effects.fail` bleiben Befunde.
- Ein Schritt mit gelernter Abweichung lernt sonst nicht, damit kein Fehler aus dem Vergleich verschwindet. Soll eine geänderte Wirkung gelten, im Chat **„Neue Wirkung übernehmen“** wählen. Der Knopf erscheint, wenn nur die Wirkung abweicht und die Prüfung erfüllt ist. Er löscht `effects` dieses Schritts aus der Datei, ohne Claude und ohne Tokens; die nächsten zwei gesunden Läufe lernen sie neu. Ohne Chat geht dasselbe, indem man `effects` aus der Datei löscht.

### Empfehlungen zu Fehlern und Warnungen

Ohne Fix-Parameter kostet nichts Token, solange du nicht schreibst oder klickst: Ein `run` zeigt bei einem gescheiterten Schritt im Chat den Grund, die harten Fehler und die Warnungen. Claude empfiehlt von sich aus nur hier, und im Gespräch, wenn du danach fragst:

| Lauf | Wann |
|---|---|
| `run` und „Ursache von Claude Code untersuchen lassen“ | Ein Schritt ist gescheitert, du klickst den Knopf im Chat. Lautet die Einschätzung „Anwendung“, ist er der Hauptknopf, sonst steht er neben „Schritt beheben“. Danach wie mit `--explain`: Karten, bei übernommener Änderung an der Anwendung „Erneut testen“ |
| `run … --explain` | Ohne Klick: Ein Schritt scheitert, ein harter Fehler tritt auf oder es gibt Warnungen, auch in einem bestandenen Lauf. Für Läufe, deren Ergebnis du dir erst später ansiehst. Nur auf Umgebungen mit `agent` und mit Chat (nicht in CI), sonst Exit 3 |
| `record <test>@<S4>` und „Schritt beheben“ | Fehler oder Warnungen beim Neuaufnehmen oder Beheben und im Prüflauf danach |
| `record` | erst, wenn du im Prüflauf „Schritt beheben“ wählst |

Claude arbeitet im Browser des gescheiterten Laufs, der Zustand ist also noch da. Es darf nur lesen (`snapshot`, `eval`, `console`, `network`, `screenshot`, `url`), alles andere lehnt der Host mit `advise-only` ab. Den Quellcode liest es wie immer schreibgeschützt und sucht dort nach der Ursache, egal mit welchem Framework. Sein Log steht in `agent/claude-advice.log`.

Jede Empfehlung nennt ihren Beleg (`evidence`), etwa einen Request, einen harten Fehler oder eine Fundstelle im Code; ohne lehnt der Host sie ab. Im Chat erscheint jede als Karte, eine nach der anderen:

- **Test:** Titel, Begründung, Beleg und das Geänderte als Vorher und Nachher, dazu „Übernehmen“ und „Verwerfen“. Möglich sind `name`, `do`, `expect`, `note` und `retry` eines vorhandenen Schritts, die `notes` des Testfalls, ein Eintrag in `caw/caw.md` und ein Muster in `consoleIgnore` oder `foreignCode`. Spricht die Einschätzung eindeutig für einen Fehler der Anwendung, markiert die Karte die Empfehlung als Widerspruch dazu.
- **Anwendung:** Titel, Begründung, Beleg und ein fertiger Prompt für eine Claude-Code-Sitzung bei dir, mit „Prompt kopieren“ und „Weiter“. Bringt Claude konkrete Änderungen mit (`edits`: Datei, gesuchte Stelle, Ersatz, Grund), prüft der Host sie gegen den echten Code: Pfad relativ zum Projekt, nicht unter `caw/`, `.caw/` oder `.claude/`, nicht in `node_modules/` oder `.git` in beliebiger Tiefe, keine Geheimnis-, Build-, CI- oder Agenten-Anweisungsdatei (`package.json`, Lock-Dateien, Dockerfiles, `.github/`, `.circleci/`, `Jenkinsfile`, `CLAUDE.md`, `AGENTS.md`, `.cursor/` …), die Stelle genau einmal in der Datei. Die Karte zeigt Datei, Zeile und den Unterschied. „Änderung übernehmen“ schreibt sie in die Dateien, Zeilenenden bleiben; hat sich die Stelle inzwischen geändert, schreibt es nichts. Claude selbst ändert Anwendungscode nie.

Was Übernehmen bewirkt:

- **Nur `retry`:** wirkt sofort, ohne neue Aufnahme, denn `retry` zählt nicht zum Hash.
- **Geänderter Text** in `name`, `do`, `expect` oder `note`: Der Schritt ist danach veraltet, und der Chat bietet „Schritt beheben“ an.
- **`caw.md` und Config:** werden sofort geschrieben, die Config gilt ab dem nächsten Lauf.
- **Testdatei:** Im `run` steht die Änderung sofort in der Datei. Bei `record` und „Schritt beheben“ kommt sie in den Entwurf und gilt erst mit „Testplan übernehmen“.
- **Änderung am Code:** steht sofort in der Datei. Prüfe sie mit dem Lint des Projekts und einem neuen `run`.

Der Abschnitt „Empfehlungen“ in `report.md` nennt jede Empfehlung mit Beleg und deiner Entscheidung, bei einer Anwendungsempfehlung samt Prompt und Änderungen als Diff. Committet wird nie.

### Einen Schritt beheben

Scheitert ein Schritt in `run` oder im Prüflauf von `record`, hält das Abspielen an, und der Browser bleibt im Zustand des Fehlers. Der Chat nennt „S4 ist gescheitert: <Grund>“ samt harten Fehlern und Warnungen und schaltet die Eingabe frei (Zustand „Fehler klären“), dazu „Schritt beheben“ und „Lauf beenden“. Darunter steht die [Einschätzung](#einschätzung-test-anwendung-oder-umgebung) des Tools mit ihren Befunden. Spricht sie für einen Fehler der Anwendung, ist „Schritt beheben“ nur noch der zweite Knopf, mit dem Hinweis, dass ein angepasster Test den Fehler nur verdecken würde. Das gibt es nur auf Umgebungen mit `agent`; in CI, mit `--no-chat`/`--headless` und auf den anderen Umgebungen bleibt es beim Exit-Code und beim Bericht.

- **Fragen:** Erst deine Nachricht startet Claude, im selben Browser und nur lesend wie bei den [Empfehlungen](#empfehlungen-zu-fehlern-und-warnungen). Es antwortet im Chat, nennt Ursache, Datei und Zeile und kann Empfehlungskarten geben. Jede weitere Nachricht geht ins selbe Gespräch, bis du einen Knopf drückst. Das Log steht in `agent/claude-talk.log`. Ohne Nachricht und ohne Klick fallen keine Token an.
- **Im selben Browser beheben:** Ist vom gescheiterten Schritt noch nichts ausgeführt, scheiterte also seine erste Aktion ohne harten Fehler von außen, behebt Claude ihn direkt dort, ohne Vorlauf. Der Bericht des Testlaufs bleibt als `report-test-run.md` erhalten. Sonst, etwa nach einer halben Aktionsfolge oder einer nicht erfüllten Prüfung, geht es wie unten mit Vorlauf in einem frischen Browser. Der Chat sagt vorher, welcher Weg es wird.

`record <test>@S4 --env <umgebung>` nimmt ab S4 bis zum Ende neu auf, etwa nach einer gewollten Änderung der Anwendung oder für einen von Hand geänderten oder neu eingetragenen Schritt. Die Schritte vor S4 müssen aktuell sein; ab S4 dürfen Schritte veraltet oder noch gar nicht aufgenommen sein. Einen Prüflauf vorher und eine Vorführung gibt es nicht: S1 bis S3 laufen ohne Claude, dann folgt Claude dem alten Plan ab S4, du lenkst im Chat, und Claude sucht keine Ursache. Ab S4 darf Claude Schritte ergänzen, entfernen, umbenennen oder umstellen; die Schritte davor bleiben, wie sie sind. Legt Claude den Plan ab S4 unverändert vor, gilt er ohne Freigabe: Der Chat sagt das, und du kannst trotzdem schreiben, wenn sich etwas ändern soll. Die Karte zum Freigeben erscheint nur, wenn sich etwas ändert, beim Beheben eines Fehlers ebenso. `@S1` ist dasselbe wie `record <test>`. `--role` und `--read-only` gehen nicht zusammen mit einem Schritt (Exit 3): Der Test behält seine Metadaten. Genau einen Schritt behebst du nur mit „Schritt beheben“ im Chat eines Laufs.

Im Chat erscheint als Nachricht nur, was Claude dir mit `say` sagt. Seine übrigen Notizen stehen eingeklappt bei den Aktionen. Brichst du ab, steht im Bericht „Von dir abgebrochen.“

1. **Vorbereiten:** In einem frischen Browser laufen S1 bis S3 ohne Claude, der Chat zeigt den Fortschritt. Scheitert schon davor ein Schritt, wird dieser angeboten. Beim Beheben im selben Browser entfällt das.
2. **Ursache, dann Plan:** Claude bekommt nur diesen Schritt (bei `record <test>@S4` alle Schritte ab S4, ohne Ursachensuche): Text, bisherige Aktionen, Prüfung, Grund, Einschätzung samt Requests, dazu `caw.md` und die bisher gelesenen `remember`-Werte. Zuerst klärt es die Ursache, auch im Quellcode, und sagt sie im Chat. Liegt es an der Anwendung, ändert es den Test nicht, sondern gibt eine Empfehlung mit konkreter Änderung am Code und meldet `fail`. Sonst legt es nur diesen Schritt als Karte vor. Ein geändertes Ergebnis ist dort markiert, erscheint bei der Entscheidung und steht im Bericht.
3. **Ausführen:** Claude führt den Schritt aus und bereinigt ihn. Bleibt das Ergebnis gleich, muss auch die Prüfung gleich bleiben, sonst lehnt `finish` ab. Fällt ein `remember`-Wert weg, den ein späterer Schritt braucht, ebenso.
4. **Prüflauf:** Der ganze Test läuft ohne Claude in einem frischen Browser, bis vor einen womöglich noch veralteten Schritt. Scheitert ein anderer Schritt, kommt wieder das Angebot. Besteht er: „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“.

Nur die behobenen Schritte ändern sich in der Datei, Kommentare und alle anderen Schritte bleiben Zeichen für Zeichen gleich. Bei `record <test>@S4` bleiben die Schritte vor S4 gleich, Schritte, die nicht mehr im Plan stehen, fallen weg, und die Schritte ab S4 verlieren ihre Vergleichswerte der Requests und ihre Wirkungen; der nächste `run --learn` (oder „Vergleichswerte speichern“ auf seiner Abschlusskarte) lernt sie neu. Neue Meldungen, die Claude dabei sieht, zählen danach als bekannt; die Entscheidung nennt sie, damit kein Fehler der Anwendung unbemerkt durchrutscht.

- **Testdaten:** Ein Beheben kostet bis zu zwei Durchläufe, schreibende Schritte davor legen entsprechend Daten an. Token fallen nur für diesen Schritt an, bei `record <test>@S4` für alle Schritte ab S4. Scheitert ein Schritt nach dem Absenden, bleibt der Datensatz offen, das Abspielen räumt nicht auf.
- **Ohne Claude:** Fehlt Claude Code (`local`) bzw. Docker oder Token (`docker`), nennt der Chat den Grund, der Lauf bleibt `fail`.
- **Entwurf verwerfen:** Der Testplan bleibt unverändert, nach einer Rückfrage („Wirklich verwerfen?“). Ein zuvor gescheiterter `run` endet mit `fail`.
- **Einfügen, Löschen, Umsortieren:** Mit `record <test>@S4` darf Claude den Plan ab S4 ändern, denn spätere Schritte können auf früheren aufbauen. Einen Schritt, den du von Hand einträgst, nimmst du ebenso auf: `record <test>@<seine id>`.

### Konsolenausgabe

Im Terminal liest sich ein Lauf wie die Werkbank: der Kopf mit der Version, der Modus fett, was caw gerade tut, dann die Linie „Run“ mit einer Zeile je Schritt und seiner Dauer, der Grund unter einem gescheiterten Schritt, die Zusammenfassung, der Bericht und was als Nächstes zu tun ist (hier ein englischer Lauf):

```
● caw · Context-Aware Web Testing · <version>
  › Mode on local (team language en): no window and no chat (--headless); learns: no.
Replay without Claude · first-errand on local as user · team language en
Code: dev server localhost:4874, your current version

  › Opening Chrome and signing in ...
  › Replaying the recording (19 steps, recorded on local) ...
    ›  1/19 click button "New todo" +0.0s
    …

Run ────────────────────────────────────────────────
  ✓ S1  Add a todo     4.0s
  ✓ S2  Find it        1.5s
  ✕ S3  Tick it off   32.1s
      └ Not met after 30 s: …
  ○ S4  Plan it      not reached

Failed. 2 of 4 steps passed. · 39.9s
report  .caw/runs/<run>/report.md
        file:///…/report.md
next    S3 failed. Find the cause: caw run first-errand --env local in the terminal, …
        Up to the entry of the step: caw open first-errand@S3 --env local
```

Die Zeichen sind ✓ bestanden, ✕ gescheitert, ! Warnung und ○ nicht erreicht. In Dateien und Pipes bleiben es schlichte Zeilen mit `[caw]` davor, mit `Report:` vor dem Pfad des Berichts. `NO_COLOR` schaltet die Farben ab, `FORCE_COLOR` erzwingt sie.

### Die Berichtsseite

„Bericht öffnen“ auf der Abschlusskarte öffnet `report.md` als Seite in einem neuen Tab desselben Browsers, in deinem hellen oder dunklen Modus. Oben Logo, „Bericht“ und der Pfad; dann der Titel mit einem Badge (bestanden, gescheitert, Fehler oder das Urteil einer Nachstellung), die Zeilen darunter, Kacheln für bestanden, fehlgeschlagen, nicht erreicht und schreibende Aufrufe, und die Schritte mit ihren Badges. Harte Fehler und Warnungen sind Listen mit Symbolen, schreibende Aufrufe stehen in Mono, und Screenshots, auf die der Bericht verweist, erscheinen als Vorschaubilder. Nur lesende Läufe, Gründe und Hinweise sind Banner. Die Seite zeigt nur, was in `report.md` steht; die Datei selbst bleibt unverändert.

## Aus Claude Code steuern

Claude läuft als dein eigenes Claude Code, in einer Docker-Sandbox oder als deine Claude-Code-Session. In deiner Session ist caw ein Satz MCP-Werkzeuge: einrichten, aufnehmen, abspielen, nachstellen, einen Zustand öffnen.

### Agent: lokal, Docker oder deine Session

Wo Claude läuft, wenn ein Lauf es braucht, legt `agent.mode` in der Config fest (`local`, `docker` oder `session`, Standard `local`). `--agent local|docker|session` überschreibt das für einen Lauf. In CI (`CI` gesetzt) gilt immer `docker`, andere Werte brechen ab.

| Agent | Wie Claude läuft | Gut für |
|---|---|---|
| `local` | `claude -p` auf deinem Rechner, mit deiner Anmeldung. Nur die Werkzeuge `Read`, `Grep`, `Glob` und das caw-Tool, keine Shell, kein Schreiben, kein Web, keine Hooks, keine anderen MCP-Server. | den Alltag am eigenen Rechner |
| `docker` | `claude` im Container mit Firewall, nur mit API-Schlüssel (`ANTHROPIC_API_KEY`) | wer Claude nicht auf dem eigenen System haben will |
| `session` | Kein eigener Claude-Prozess. Deine offene Claude-Code-Session übernimmt die Rolle über den MCP-Server `caw mcp`. | Aufnehmen, Beheben und Entwickeln in der gewohnten IDE-Session |

In allen drei Fällen ist der Browser die eigentliche Grenze: Claude sieht die Anwendung nur über die festen Befehle, Navigation nur zu erlaubten Hosts (siehe [Sandbox-Grenzen](#sandbox-grenzen)).

```json
"caw:shop:smoke": "caw run shop-smoke --env local",
"caw:shop:smoke:record": "caw record shop-smoke --env local",
"caw:shop:smoke:rerecord-docker": "caw record shop-smoke@S2 --env local --agent docker"
```

In CI (`CI` gesetzt) läuft `run` ohne Chat und ohne Claude; `agent.mode` greift dort nur, falls ein Lauf doch Claude braucht, und dann immer mit `docker`.

**Persönliche Einstellungen:** Was du in der Werkbank für dich festlegst, merkt sich caw je Nutzer in `prefs.json` unter `CAW_AI_HOME`, sonst `%APPDATA%\caw-ai` (Windows) bzw. `~/.config/caw-ai`: „Animationen aus“ (F10: kein Spinner, keine pulsierenden Punkte, kein blinkender Cursor), eingeklappte Schritte oder Chat und der Modus (`system`, `light` oder `dark`; `system` folgt deinem Betriebssystem und ist der Standard). Du änderst sie auf der [Einstellungsseite](#einstellungen) (Strg+,). Im selben Ordner hält deine eigene `caw.md` Notizen für Claude in jedem Projekt, gelesen vor der `caw/caw.md` des Projekts ([Konfiguration](configuration.de.md#deine-eigene-cawmd)).

**Hinweis auf Token:** Bevor Claude arbeitet (aufnehmen, beheben, Ursache untersuchen, Fragen im Chat, `--explain`), fragt der Chat einmal je Lauf: „Weiter“, „Nicht mehr fragen“ oder eine Ablehnung, die sagt, was sie bewirkt: „Ohne Claude Code weiter“ (Ursache untersuchen, Fragen im Chat) oder „Lauf abbrechen“ (aufnehmen, beheben). „Nicht mehr fragen“ setzt `"tokenNotice": "off"` in `prefs.json`; löschst du den Eintrag, kommt der Hinweis wieder. Mit `--agent session` gibt es den Hinweis nicht: Deine Session läuft ohnehin.

**Ausprobieren** ohne eigenes Projekt: [`examples/errand`](../examples/errand) im Repository, eine kleine App mit Anmeldung und einem Test.

#### Aus deiner Claude-Code-Session

Melde caw einmal als MCP-Server des Projekts an:

```bash
claude mcp add caw --scope project -- npx caw-ai mcp
```

Unter Windows (nicht WSL) braucht `npx` einen Wrapper: `claude mcp add caw --scope project -- cmd /c npx caw-ai mcp`. Ist caw im
Projekt installiert (`npm i -D caw-ai`), stellt `init` den Eintrag auf die installierte Kopie um
(`node node_modules/caw-ai/bin/caw.mjs mcp`); danach Claude Code neu starten. Deine Session hat dann diese Werkzeuge:

| Werkzeug | Zweck | Tokens |
|---|---|---|
| `caw_guide` | Wie man mit caw arbeitet, je Thema (`setup`, `tests`, `run`, `session`, `config` …); ohne Thema die Übersicht | nein |
| `caw_init` | `mode: explore` öffnet dir die App zum Anmelden und liefert die Vorschläge; `mode: write` schreibt daraus die Config; `mode: offline` die Vorlage mit TODO | nein |
| `caw_config` | `{ read: true }`: Config wie geschrieben und wirksam, mit Prüfung; `{ patch, dryRun }`: geprüfte Änderung, ein ungültiges Ergebnis wird nicht geschrieben. Befehle (`start`, `stop`, `reset`, `ready`, `lintCommand`, Overlay-`start`), die Umgebungs-Schalter (`production`, `agent`, `writable`, `allowHttp`, `insecureTls`), `browser.executablePath`, `sandboxImage`, `sandboxUser` und `agent.mode` lehnt es ab: Die ändert die Session in der Datei, wo Claude Code dir den Diff zeigt | nein |
| `caw_role` | `list` Rollen und ob ein Testnutzer gesetzt ist; `add` trägt eine Rolle in die Config ein und nennt ihre Variablen, `caw/.env` füllst du selbst; `login` speichert eine Sitzung (SSO); `remove` | nein |
| `caw_doctor`, `caw_validate`, `caw_list` | `doctor`, `validate` und `list` als Daten | nein |
| `caw_start` | startet `run`, `record`, `open` oder `reproduce` mit deiner Session als Agent: Felder `test`, `env`, `step`, `headless`, `learn`, `start`, `reset`; bei `reproduce` `bug`, `from`, `role` (oder `args`) | nur deine Session |
| `caw_status` | ob ein Lauf auf die Session wartet und welche Guide-Themen gelten, die letzten Zeilen der Ausgabe und der letzte Lauf: Ergebnis, letzter Schritt, Artefakte | nein |
| `caw` | die Befehle des Agenten (`snapshot`, `click`, `plan`, `finish` …) für den wartenden Lauf | im Lauf |
| `caw_selection` | das Element, das du beim Entwickeln im Chat der Werkbank mit `/element` gewählt hast | nein |
| `caw_overlay` | nur mit einem `overlay`-Block: Ist der lokale Code-Server bereit, `check` und `apply` | nein |

Der Server sagt Claude Code, wofür caw da ist und dass es zuerst `caw_guide` liest; eine Skill-Datei gibt es nicht. Die Daten-Werkzeuge liefern einen kurzen Text und dasselbe Ergebnis als `structuredContent` (JSON). Keins schreibt auf den MCP-Kanal oder fragt auf stdin; Explore, `overlay check` und Läufe laufen als eigene Prozesse. caw startet deinen lokalen Code-Server nie aus der Session; das macht Claude in seiner eigenen Session, nachdem es dich gefragt hat, außer die Regeln deines Projekts (etwa `CLAUDE.md`) sagen etwas anderes.

Du schreibst also in deiner Session „nimm einen Test für die Bestellung auf“ oder „bring mich zu S4 von bestellung“, und die Session erledigt den Rest mit dem Guide. Startest du den Lauf selbst im Terminal mit `--agent session`, zeigt der Chat, dass er auf die Session wartet; schreib ihr dann „übernimm den caw-Lauf“ (sie findet ihn mit `caw_status`).

- **Weniger Rückfragen:** Ist deine Session der Agent, gibt es keinen Hinweis auf Token, und `record` eines vorhandenen Testplans startet ohne die Frage, wer vorführt. Ein lesender Plan, dem die Session unverändert folgt, braucht keine Plan-Freigabe; die Übernahme des geprüften Plans am Ende immer.
- **Wartezeiten:** `plan` und `chat` warten auf dich, bis zu einer Stunde. Bricht Claude Code den Aufruf vorher ab, setz `MCP_TOOL_TIMEOUT` (Millisekunden) in der Umgebung von Claude Code höher.
- **Vorsicht:** Deine Session hat mehr Rechte als der Agent im Lauf (Shell, Schreiben). Was aus der Anwendung kommt, ist für sie Daten, keine Anweisung; caw sagt ihr das bei jedem Auftrag. Lass Bash- und Schreibaufrufe in dieser Session bestätigen, statt sie pauschal freizugeben. Auch die caw-Werkzeuge führen Befehle des Projekts aus: `caw_start` mit `start` führt das `start` der Umgebung aus (und später ihr `stop`), mit `reset` ihr `reset`, und ein `run` mit schreibendem Test führt `reset` vor diesem Test aus; alles aus `caw.config.json`, auf deinem Rechner. `caw_config` kann diese Befehle und die Umgebungs-Schalter nicht ändern; diese Änderung geht über Claude Codes eigenes Datei-Bearbeiten, prüf ihren Diff wie Code.

### Docker

Nur für den Agenten `docker`. Der Docker-Dienst muss laufen, das Tool startet ihn nicht. Den Container startet und entfernt es selbst.

Unter Windows nimmt das Tool den ersten Weg, dessen Dienst antwortet: zuerst `docker.exe`, dann Docker in WSL. Welcher es ist, steht am Anfang der Ausgabe. Mit `CAW_DOCKER=windows` oder `CAW_DOCKER=wsl` legst du ihn fest.

Die Prüfung läuft vor allem anderen und bricht mit einer eigenen Meldung ab (Exit 2):

| Code | Bedeutung |
|---|---|
| `docker-missing` | Kein Docker gefunden |
| `docker-not-running` | Docker ist da, der Dienst antwortet nicht |
| `docker-wrong-mode` | Docker Desktop steht auf Windows-Container, die Sandbox braucht Linux-Container |

## Sicher mit Zugangsdaten und Produktion

Testkonten bleiben in deiner `caw/.env`, Produktion wird nur gelesen, und Claude erreicht die Anwendung nur über den Browser und feste Befehle.

### Sandbox-Grenzen

**Lokal (Agent `local`):**

- **Werkzeuge:** Claude Code startet mit `--tools Read,Grep,Glob`, `--permission-mode dontAsk` und `--strict-mcp-config`: keine Shell, kein Schreiben, kein Web, nur das caw-Tool als MCP-Server. Hooks sind abgeschaltet. `--tools` legt die Liste fest, eigene Einstellungen schalten keine weiteren Werkzeuge frei.
- **Reichweite:** Freigegeben ist nur `Read(./**)`, `Grep(./**)` und `Glob(./**)`, also der Projektordner; alles andere lehnt `dontAsk` ab, auch `~/.ssh` oder die Anmeldung von Claude Code (geprüft mit Claude Code 2.1.319). Deine eigenen und die Claude-Code-Einstellungen des Projekts werden nicht geladen (`--setting-sources ""`), ihre `allow`-Regeln erweitern das also nicht; aus `~/.claude/settings.json` kommen nur die Verbindungseinstellungen mit (`env`, `apiKeyHelper`, `model`, AWS-Helfer). Screenshots im Agent-Ordner unter `.caw/` kann Claude lokal nicht ansehen.
- **Dateien:** `.env*`, `.git`, `.claude`, `.worktrees`, `.caw`, `caw/.auth` sowie typische Schlüsseldateien (`.npmrc`, `*.pem`, `id_rsa*` …) sind per `permissions.deny` gesperrt. Das ist eine Sperre von Claude Code, kein Dateisystem-Schutz wie im Container: Wer stärkere Garantien braucht, nimmt `docker`.
- **Netz:** Claude selbst hat kein Web-Werkzeug. Die Anwendung erreicht es nur über den Browser mit dessen Sperre.

**Session (Agent `session`):** Es gelten die Rechte deiner eigenen Claude-Code-Session. caw gibt ihr nur die Befehle für den Browser dazu.

**Container (Agent `docker`):**

- **Dateien:** Der Projektordner ist read-only eingebunden, im Container immer unter dem Linux-Pfad (`C:\x` als `/mnt/c/x`). Beschreibbar sind nur der Agent-Ordner des Laufs und das Innere des Containers. `.git`, `.claude`, `.worktrees`, `.caw` und alle `.env`-Dateien sind ausgeblendet, auch `caw/.env`. Andere Geheimnisse im Projektordner sieht der Agent.
- **Netz:** Default deny für IPv4 und IPv6. Erlaubt sind Loopback und HTTPS zur Anthropic-API. Deren Adressen löst die Firewall beim Start auf und trägt sie in `/etc/hosts` ein; danach ist auch DNS gesperrt, samt Dockers eingebautem Resolver, damit sich keine Daten in DNS-Namen hinaustragen lassen. Ändern sich die Adressen der API während eines Laufs, hilft ein neuer Lauf. Die Anwendung ist aus dem Container nicht erreichbar.
- **Rechte:** Der Container startet nur für die Firewall als root und läuft danach als Sandbox-Benutzer (`sandboxUser`) ohne Capabilities, mit `no-new-privileges`. Es gibt keine veröffentlichten Ports und keinen Docker-Socket.
- **Token:** Es kommt zur Laufzeit als Umgebungsvariable und liegt nicht im Image.

**Chrome (auf dem Host, außerhalb der Docker-Firewall):**

- **Steuerung:** Der Agent bekommt nie CDP. Es gibt nur die festen Befehle aus `caw agent --help`, als Dateien im Agent-Ordner. Navigation per `goto` geht nur zu erlaubten Hosts.
- **Netz:** Die Docker-Firewall deckt nur Claudes Container ab, nicht dieses Chrome. Seiten navigieren nur zu den Hosts aus `environments` und `allowHosts` (eine Request-Route; eine Weiterleitung auf einen anderen Host lässt die Aktion ebenfalls scheitern). Solange Claude dabei ist (record, ein Lauf mit Chat, `open`), geht jeder Request nur an diese Hosts und `thirdPartyHosts`: fetch, XHR, WebSockets, Beacons, iframes, Skripte und Weiterleitungen. Jeden anderen Namen kann Chrome nicht einmal auflösen (`--host-resolver-rules` mit `MAP * ~NOTFOUND` und einer Ausnahme je erlaubtem Host), das stoppt auch DNS-Abfragen und Verbindungen, die keine Route sieht; eine Request-Route und eine WebSocket-Route brechen die Requests vorher ab und nennen jeden gesperrten Host als Warnung im Lauf, mit dem Schlüssel, der ihn freigibt. Ohne Claude dürfen Unterressourcen und iframes jeden Host erreichen und stehen im Bericht als fremde Hosts. Produktions-Hosts anderer Umgebungen sind in jedem Lauf für jeden Request-Typ nicht auflösbar, auch mit Punkt am Ende. Dazu `--no-proxy-server`, damit die Resolver-Regeln greifen, und eine WebRTC-Sperre.
- **Sandbox:** Chrome läuft immer in seiner eigenen Sandbox. Wo sie nicht starten kann (Linux als root, manche Container), hält caw mit `browser-sandbox` an; `browser.noSandbox: true` schaltet sie bewusst ab (unsicher).
- **Werkbank:** Das Dokument des obersten Fensters beantwortet das Tool selbst, unter der Adresse der Anwendung. Die Anwendung teilt sich damit den Origin mit der Werkbank und kann deren Seite verändern; Entscheidungen fallen nur im Chat, und dessen Dokument erreicht sie nicht (eigener, opaker Origin). Sie kann die Sandbox des Chat-iframes entfernen oder ihn neu laden; dann schreibt das Tool den Chat nicht hinein und der Lauf endet mit `chat-tampered`. Von den Dokumenten der Anwendung verlieren nur die des Anwendungs-iframes selbst `X-Frame-Options` und `frame-ancestors`, und den Anwendungsrahmen kennt das Tool an seiner Identität, nicht an seinem Namen. Ein POST ins oberste Fenster schickt das Tool einmal über den Browser-Kontext (gleiche Cookies, gleiche Host-Sperre) ab.
- **Grenze der Sperre:** Sie kennt Hostnamen, keine Ports oder Adressen. Andere Dienste auf einem erlaubten Host sind aus der Seite erreichbar, und ein Produktions-Host, der über seine IP-Adresse (oder einen anderen Namen für dieselbe Adresse) erreicht wird, ist nicht gesperrt.
- **Einsicht:** `eval` läuft in der angemeldeten Seite. Claude sieht und kann also alles, was der Testnutzer in der Anwendung sieht und kann. Deshalb nur Testkonten mit wenig Rechten verwenden.
- **Backend:** Die Sperre endet am Host der Anwendung. Requests über einen Proxy der Anwendung gehen durch, und wohin er weiterleitet, entscheidet der Server. Die eigentliche Grenze sind die Rechte des Testkontos.
- **`writes: false`:** Ein neuer Test ist schreibend, außer `record … --read-only`. Schreibt ein lesender Test bei der Aufnahme doch, wird er beim Übernehmen schreibend. Das Tool prüft das Feld vor dem Start gegen `environments.<umgebung>.writable`. Im Lauf verhindert nur die Anweisung des Leitfadens das Schreiben, technisch blockiert ist es nicht (auf `production`-Umgebungen sind schreibende Requests an jeden Host gesperrt, Formular-Posts ins oberste Fenster eingeschlossen; Nachrichten über einen offenen WebSocket nicht, denn auch lesende Apps schicken welche).
- **Firmenrichtlinien:** Eine zentral erzwungene Chrome-Richtlinie (z. B. ein Proxy) kann die Sperre aushebeln. Prüfe das auf dem Rechner, auf dem die Tests laufen (`chrome://policy`).

**Urteil:** Bericht und `result.json` schreibt nur der Host, außerhalb des Agent-Ordners. Als Screenshot zählt nur, was der Host selbst aufgenommen hat.

## Export nach Playwright

`caw export <test>` schreibt einen aufgenommenen Test als Playwright-Test, der ohne caw läuft, nur mit `@playwright/test`: die aufgenommenen Locators, ein `test.step()` je Schritt, die Anmeldung aus `signIn`, Prüfungen als `expect.poll`. Was nicht exportiert wird und wie du ihn startest: [Befehle](commands.de.md#export).

## Weiteres

### Lokaler Code in der Anwendung

Gegen deinen Dev-Server läuft ohnehin dein Code: Er ist einfach eine Umgebung ([Konfiguration › Lokalen Code testen](configuration.de.md#lokalen-code-testen)). Für Anwendungen, die nur in einer ausgelieferten Umgebung laufen, legt die [Overlay-Erweiterung](extensions/overlay.de.md) deinen lokalen Code darüber; bei ExtJS aus dem Sencha-Watch ([ExtJS](extensions/extjs.de.md)).

### Framework: `web`, `react`, `vue`, `angular` oder `extjs`

Fast alles im Tool kennt kein Framework: Snapshot, Klicks, Konsole, Requests, Einschätzung, Chat. Was davon abhängt, steckt in einem Adapter, gewählt mit `framework` in der Config. Ein Projekt hat genau einen; die Testdatei nennt ihn nicht. `react`, `vue` und `angular` sind `web` mit drei Zusätzen: Sie erkennen, wann das Framework die Anwendung eingehängt hat, nennen zu jedem Ziel die Komponente (nur als Hinweis für Claude und den Bericht) und überspringen Framework-Dateien im Stack.

| | `web` (Standard) | `react` / `vue` / `angular` | `extjs` |
|---|---|---|---|
| Ziel speichern | Ein Playwright-Locator: Rolle und vollständiger zugänglicher Name (`aria-label`, Beschriftung, Text), `data-testid`, eingegrenzt auf den benannten Dialog, das Formular oder die Zeile darum. Nie Feldwerte. Offene Shadow Roots zählen (geschlossene sind nicht erreichbar); ein iframe der Anwendung über `contentFrame()` | wie `web`, dazu `component` als Hinweis: die Komponenten von außen nach innen, z. B. `GroupsScreen › Button`; bei Vue auch `source`, die SFC-Datei. Nur im Dev-Build, für das Wiederfinden ohne Belang | wie `web`; eine Komponente ohne Rolle oder Namen als `locator('extjs=…')` (`Ext.ComponentQuery`) |
| Bereit | Dokument geladen, kein Request der Seite offen (länger als 10 s offene wie Long-Polling zählen nicht), nichts mit `aria-busy`, kein unbestimmter Fortschritt (`role=progressbar` ohne `aria-valuenow`), DOM seit 150 ms still | wie `web`, dazu eingehängt: React-Root-Container, Vue `data-v-app`, Angular `[ng-version]`; Angular zusätzlich stabil laut Zone.js, wenn die App Testability anbietet (bei `bootstrapApplication` nur mit `provideProtractorTestingSupport()`) | Kein `Ext.Ajax`-Request offen, kein Store lädt |
| `wait-ready --for` | CSS-Selektor, `--min-count` zählt sichtbare Treffer | wie `web` | `storeId` oder ComponentQuery, zählt Datensätze |
| Meldungen | modale Dialoge ohne Eingabefelder, `role=alert`, `role=alertdialog`, oder `messageSelectors`; `role=status` (Toasts, Snackbars) nur als Hinweis | wie `web` | modale Dialoge, `messageSelectors`, dazu ExtJS-Dialoge und Toasts |
| Stack-Herkunft | oberster Eintrag | oberster außerhalb von `react-dom`, `@vue/*`, `@angular/*`, `zone.js` | oberster Eintrag außerhalb von `ext-*.js` |

Für alle gilt:

- **Quellkarten:** Ein Skriptfehler zeigt auf den Quellcode, wenn die Anwendung Quellkarten ausliefert (Vite im Dev-Modus immer, Builds mit `sourcemap`): `src/screens/GroupsScreen.tsx:190:15` statt `index-3f9a.js:1:48211`. Geladen wird nur vom Origin des Skripts und nur von Hosts der Sperre.
- **Routenwechsel:** Bricht ein Single-Page-Router beim Wechsel der Route offene Requests ab (bis 1 s davor oder 0,5 s danach), gilt das nicht als Fehler der Anwendung, ebenso wenig wie ein Abbruch durch einen Seitenwechsel.
- **Verdeckte Ziele:** Ist ein Ziel nicht klickbar, sagt das Tool, warum: es fehlt, es ist unsichtbar, oder ein Dialog liegt darüber, samt seiner Meldung.
- **Virtualisierte Listen:** Fehlt eine Zeile, rollt die Suche die Liste weiter, bis sie auftaucht.

Für `web` und die SPA-Adapter hilft eine zugängliche Oberfläche: Knöpfe mit Text oder `aria-label`, Felder mit `<label>`, Dialoge mit Titel. Wo das fehlt, macht `data-testid` ein Ziel eindeutig. Sonst bleibt der Index unter gleichen Treffern, und der bricht, sobald sich die Reihenfolge ändert. Erzeugte Klassen und ids (`_ngcontent-…`, CSS-Module-Hashes, `:r1:` aus `useId`) nutzt kein Adapter.

**Dev-Server statt Bundle:** Eine gebündelte Anwendung (Vite, Angular CLI, webpack) testest du lokal direkt gegen ihren Dev-Server, etwa `http://localhost:5173`; das Backend erreicht sie über den Proxy des Dev-Servers, auch ein entferntes. `http` ist nur auf dem eigenen Rechner erlaubt: `localhost`, `127.0.0.1` oder ein Name unter `.localhost` (etwa `app.localhost`, wenn mehrere Anwendungen getrennte Cookies brauchen). Chrome erreicht diese Namen immer über `127.0.0.1`; lauscht der Dev-Server nur auf `::1`, starte ihn mit `--host 127.0.0.1`.

### Entwicklung

```bash
npm test                          # Unit-Tests; die Browser-Tests brauchen Chrome und laufen sonst nicht mit
npm run e2e                       # E2E gegen das Fake-Portal unter e2e/, mit Skripten statt Claude und Mensch
npm run pack:check                # Paketinhalt: keine Geheimnisse, keine Tests, keine Projektbegriffe
```

Unter Windows läuft das E2E am besten aus PowerShell über `e2e/watchdog.ps1`: Der Wächter beendet den Lauf, wenn das Log zu lange still steht. Maßgeblich sind die Ergebnisse in `<log>.result` mit der Summe `RESULT OK=… FAIL=…`, die auch in `<log>.status` steht: Ins Log schreiben die Prozesse des Agenten mit und können dabei Zeilen überschreiben. Gibt es ein FAIL, endet das E2E mit Exit 1. Das E2E baut beim ersten Lauf das Sandbox-Image aus `node:22-bookworm-slim` und braucht dafür Docker, aber kein Token.

Erprobt ist das Tool mit ExtJS 6.5.3 Modern, React 19 (Vite-Dev-Server), Vue 3.5 und Angular 19. `e2e/frameworks` prüft React 19 (Vite 8), Vue 3.5 (Vite 8), Angular 21 (zoneless und mit Zone.js), Next.js 16 und Nuxt 4, jeweils am Dev-Server, als Produktions-Build über HTTPS und, wo möglich, mit `--overlay` (`node e2e/frameworks/matrix.mjs`). Offiziell unterstützt sind Windows und Linux als Host; macOS ist ungetestet. Für den Agenten `docker` erprobt ist Docker in WSL; ungeprüft ist Docker Desktop: Firewall im Container, Schreibrechte im Agent-Ordner und der Kanal über dessen Dateifreigabe.
