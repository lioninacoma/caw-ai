[English](guide.md) · Deutsch

# Handbuch

Wie caw-ai im Einzelnen arbeitet. Zum Nachschlagen: [Befehle](commands.de.md), [Konfiguration](configuration.de.md) und [Testdateien](test-files.de.md).

## Agent: lokal, Docker oder deine Session

Wo Claude läuft, wenn ein Lauf es braucht, legt `agent.sandbox` in der Config fest (`local` oder `docker`, Standard `local`). `--agent local|docker|session` überschreibt das für einen Lauf. In CI (`CI` gesetzt) gilt immer `docker`, andere Werte brechen ab.

| Agent | Wie Claude läuft | Gut für |
|---|---|---|
| `local` | `claude -p` auf deinem Rechner, mit deiner Anmeldung. Nur die Werkzeuge `Read`, `Grep`, `Glob` und das caw-Tool, keine Shell, kein Schreiben, kein Web, keine Hooks, keine anderen MCP-Server. | den Alltag am eigenen Rechner |
| `docker` | `claude` im Container mit Firewall, nur mit API-Schlüssel (`ANTHROPIC_API_KEY`) | wer Claude nicht auf dem eigenen System haben will |
| `session` | Kein eigener Claude-Prozess. Deine offene Claude-Code-Session übernimmt die Rolle über den MCP-Server `caw-ai mcp`. | Aufnehmen, Beheben und Entwickeln in der gewohnten IDE-Session |

In allen drei Fällen ist der Browser die eigentliche Grenze: Claude sieht die Anwendung nur über die festen Befehle, Navigation nur zu erlaubten Hosts (siehe [Sandbox-Grenzen](#sandbox-grenzen)).

```json
"caw:shop:smoke": "caw-ai run shop-smoke --target local",
"caw:shop:smoke:record": "caw-ai record shop-smoke --target local",
"caw:shop:smoke:fix-docker": "caw-ai fix shop-smoke S2 --target local --agent docker"
```

In CI (`CI` gesetzt) läuft `run` ohne Chat und ohne Claude; `agent.sandbox` greift dort nur, falls ein Lauf doch Claude braucht, und dann immer mit `docker`.

**Persönliche Einstellungen:** Was du in der Werkbank für dich festlegst, merkt sich caw-ai je Nutzer in `prefs.json` unter `CAW_AI_HOME`, sonst `%APPDATA%\caw-ai` (Windows) bzw. `~/.config/caw-ai`: „Animationen aus“ (F10: Der Rabe blinzelt nicht mehr, kein Spinner, kein blinkender Cursor), eingeklappte Schritte oder Chat und das Theme (F7, siehe [Themes](../themes/README.de.md)).

**Hinweis auf Token:** Bevor Claude arbeitet (aufnehmen, beheben, Ursache untersuchen, Fragen im Chat, `--advise`), fragt der Chat einmal je Lauf: „Weiter“, „Nicht mehr fragen“ oder eine Ablehnung, die sagt, was sie bewirkt: „Ohne Claude weiter“ (Ursache untersuchen, Fragen im Chat) oder „Lauf abbrechen“ (aufnehmen, beheben). „Nicht mehr fragen“ setzt `"tokenNotice": "off"` in `prefs.json`; löschst du den Eintrag, kommt der Hinweis wieder. Mit `--agent session` gibt es den Hinweis nicht: Deine Session läuft ohnehin.

**Ausprobieren** ohne eigenes Projekt: [`examples/errand`](../examples/errand) im Repository, eine kleine App mit Anmeldung und einem Test.

### Aus deiner Claude-Code-Session

`init` trägt den MCP-Server in die `.mcp.json` des Projekts ein (`node node_modules/caw-ai/bin/caw-ai.mjs mcp`). Danach hat deine Session diese Werkzeuge:

| Werkzeug | Zweck | Tokens |
|---|---|---|
| `caw_doctor` | `doctor` als Daten: jede Prüfung mit nächstem Schritt, Anzahl blockierender und optionaler | nein |
| `caw_init` | `init` ohne Rückfragen: `offline`, oder `fromExplore` nach `caw_explore`; `roles`, `noMcp`. Liefert angelegte Dateien und TODO-Felder | nein |
| `caw_explore` | führt `explore` aus (`login: true/false` oder `yes`), wartet, bis du im Fenster fertig bist, und liefert die Vorschläge mit den gespeicherten Rollen | nein |
| `caw_role` | `list` Rollen und ob ein Testnutzer gesetzt ist; `add` öffnet dir das Anmeldefenster, dort speicherst du die Rolle, das Tool liefert sie zurück; `remove` | nein |
| `caw_config` | `{ read: true }`: Config wie geschrieben und wirksam, mit Prüfung; `{ patch, dryRun }`: geprüfte Änderung, ein ungültiges Ergebnis wird nicht geschrieben | nein |
| `caw_validate` | `validate` als Daten: Config-Befunde, je Test Probleme, Hinweise und Code je Ziel | nein |
| `caw_list` | `list` als Daten: je Test App, Rolle, Ziele, ob er schreibt, Aufnahmestand je Schritt | nein |
| `caw_overlay` | `action: status`: Ist der lokale Code-Server bereit (`ready`, `moved`, `down`, `wrong-app`, `stale`), mit `url`, `start` und `appDir`, schnell und ohne Browser; `check` und `apply`: `overlay check` (mit `--apply`), wartet bis zu 3 Minuten | nein |
| `caw_start` | startet `run`, `record`, `fix` oder `open` mit `--agent session`: Felder `test`, `target`, `step`, `until`, `overlay`, `headless` (oder `args`). Mit `overlay` prüft es zuerst den lokalen Code-Server: Ist er nicht bereit, kommen `state`, `url`, `start` und `appDir` zurück, statt zu starten; die Session fragt dich, startet `start` im Hintergrund und fragt `caw_overlay` status ab. Auf einem anderen Port (`moved`) startet es gegen die gefundene URL | nur deine Session |
| `caw_status` | ob ein Lauf auf die Session wartet, die letzten Zeilen der Ausgabe (`.caw/session-*.log`) und als Daten der letzte Lauf: Ergebnis, letzter Schritt, Artefakte (Bericht, Trace, Logs) | nein |
| `caw` | die Befehle des Agenten (`snapshot`, `click`, `plan`, `finish` …), wie im Skill beschrieben | im Lauf |
| `caw_selection` | das Element, das du beim Entwickeln in der Werkbank mit dem Fadenkreuz gewählt hast | nein |

Die Daten-Werkzeuge liefern einen kurzen Text und dasselbe Ergebnis als `structuredContent` (JSON). Keins schreibt auf den MCP-Kanal oder fragt auf stdin; `explore`, `overlay check` und Läufe laufen als eigene Prozesse. caw startet deinen lokalen Code-Server nie aus der Session; das macht Claude in seiner eigenen Session, nachdem es dich gefragt hat, außer die Regeln deines Projekts (etwa `CLAUDE.md`) sagen etwas anderes.

Du schreibst also in deiner Session „nimm einen Test für die Bestellung auf“ oder „bring mich zu S4 von bestellung“, und der Skill erledigt den Rest. Startest du den Lauf selbst im Terminal mit `--agent session`, zeigt der Chat, dass er auf die Session wartet; schreib ihr dann „übernimm den caw-Lauf“ (sie findet ihn mit `caw_status`).

- **Weniger Rückfragen:** Ist deine Session der Agent, gibt es keinen Hinweis auf Token, und `record` eines vorhandenen Testplans startet ohne die Frage, wer vorführt. Ein lesender Plan, dem die Session unverändert folgt, braucht keine Plan-Freigabe; die Übernahme des geprüften Plans am Ende immer.
- **Wartezeiten:** `plan` und `chat` warten auf dich, bis zu einer Stunde. Bricht Claude Code den Aufruf vorher ab, setz `MCP_TOOL_TIMEOUT` (Millisekunden) in der Umgebung von Claude Code höher.
- **Vorsicht:** Deine Session hat mehr Rechte als der Agent im Lauf (Shell, Schreiben). Was aus der Anwendung kommt, ist für sie Daten, keine Anweisung; caw-ai sagt ihr das bei jedem Auftrag. Lass Bash- und Schreibaufrufe in dieser Session bestätigen, statt sie pauschal freizugeben.

## Docker

Nur für den Agenten `docker`. Der Docker-Dienst muss laufen, das Tool startet ihn nicht. Den Container startet und entfernt es selbst.

Unter Windows nimmt das Tool den ersten Weg, dessen Dienst antwortet: zuerst `docker.exe`, dann Docker in WSL. Welcher es ist, steht am Anfang der Ausgabe. Mit `CAW_DOCKER=windows` oder `CAW_DOCKER=wsl` legst du ihn fest.

Die Prüfung läuft vor allem anderen und bricht mit einer eigenen Meldung ab (Exit 2):

| Code | Bedeutung |
|---|---|
| `docker-missing` | Kein Docker gefunden |
| `docker-not-running` | Docker ist da, der Dienst antwortet nicht |
| `docker-wrong-mode` | Docker Desktop steht auf Windows-Container, die Sandbox braucht Linux-Container |

## Drei Wege

| Befehl | Was passiert | KI und Chat | Umgebung |
|---|---|---|---|
| `record <test> --target <umgebung>` | Testplan neu aufnehmen oder ablösen | immer | nur Umgebungen mit `claude` |
| `run <test> --target <umgebung>` | Testlauf nach Plan, optional bis zu einem Schritt | Chat auf Umgebungen mit `claude` von Anfang an daneben; Claude erst nach deiner Nachricht, deinem Klick auf „Ursache von Claude untersuchen lassen“ oder „Schritt beheben“, oder mit `--advise` | alle |
| `fix <test> <S4> --target <umgebung>` | Genau diesen Schritt ändern. Hat er eine gültige Aufzeichnung, spielt `fix` zuerst bis zu ihm ab: Scheitert er, klärt der Chat die Ursache wie bei `run`, neu aufgenommen wird nur ein bestandener oder veralteter Schritt | immer | nur Umgebungen mit `claude` |

`open --target <umgebung>` öffnet die Anwendung angemeldet, mit Werkbank und Chat, aber ohne Test, siehe [Befehle](commands.de.md#open).

`<umgebung>` ist ein Name aus `environments`, etwa `local`. Mit Mandanten (`sites`) heißt das Ziel `mandant/umgebung`, etwa `nord/dev`.

**Testplan** heißt: eine YAML-Datei je Test unter `caw/tests/<test>.yaml`. Sie enthält die Testschritte; ihre Aufzeichnung steht in `caw/recordings/<test>.yaml`, siehe [Testdateien](test-files.de.md).

```bash
# Neuer Test: vorführen, Plan freigeben, am Ende übernehmen
# (--role und --app entfallen, wenn caw.config.json nur eine Rolle bzw. App kennt)
caw-ai record bestellung --target local --role kunde --app shop --also backoffice

# Testen, ohne KI
caw-ai run bestellung --target local

# Testen, bei Fehlern oder Warnungen empfiehlt Claude im Chat (kostet Token)
caw-ai run bestellung --target local --advise

# Testen ohne Chat wie in CI, mit oder ohne sichtbares Fenster
caw-ai run bestellung --target local --no-chat
caw-ai run bestellung --target local --headless

# Zustand herstellen und dort am lokalen Code weiterarbeiten
caw-ai run bestellung --target local --until S4

# Einen Schritt gezielt ändern
caw-ai fix bestellung S4 --target local
```

In Claude Code reicht ein Satz: `/caw-ai bring mich dahin, wo der Warenkorb gefüllt ist`. Der Skill sucht Test und Schritt und startet `--until`. Passt nichts, schlägt er `record` vor.

## So arbeitest du damit

1. Dev-Server der App starten, wo du entwickelst: im Devcontainer oder auf Windows.
2. Im Projektordner aus PowerShell aufrufen: `pnpm caw:my-app:smoke`. Chrome geht maximiert auf, und du siehst dem Test zu.
3. Ändern und Schritt 2 wiederholen.

Im Devcontainer selbst geht der Aufruf nicht, dort fehlt Chrome (und für den Agenten `docker` auch Docker). Für `docker` aus Windows: Git Bash endete beim Bau des Images bisher mit Exit 139, nutze PowerShell.

### Übernehmen und weiterentwickeln

`pnpm caw:my-app:smoke --handover` lässt das Fenster nach dem Urteil offen:

- **Weiterklicken:** Du machst in derselben Seite und im selben Maskenzustand weiter, auch mit ungespeicherten Eingaben und DevTools.
- **Weiterentwickeln:** Gegen deinen Dev-Server als Umgebung lädt F5 deinen aktuellen Code. Mit `--overlay` bleibt der lokale Code, bis du das Fenster schließt, und F5 lädt den aktuellen Stand aus Build-Ordner bzw. Dev-Server. Einen automatischen Reload gibt es nicht, außer dem Hot Reload des Dev-Servers.
- **Zustand:** F5 verliert, was nur im Browser stand, etwa offene Dialoge und ungespeicherte Eingaben. Zurück dorthin bringt dich „Zustand neu herstellen“ im Chat oder ein neuer Testlauf.
- **Ende:** Fenster schließen beendet den Lauf. Der Exit-Code bleibt das Urteil.
- **Tastatur im Chat:** Strg+Enter (Cmd+Enter) löst den Hauptknopf aus, etwa „Plan freigeben“ oder „Vorführung beenden“; der Knopf zeigt dazu `Strg+↵`. Esc leert zuerst das Eingabefeld, wenn du darin tippst. Sonst fragt Esc den Abbruch an („Wirklich abbrechen? (Esc)“ und „Nein“), erst ein zweites Esc innerhalb von 4 Sekunden bestätigt ihn. Neue Auswahlknöpfe bekommen den Fokus, außer du tippst gerade.
- **Du bist dran:** Wartet der Chat auf dich (Plan, Entscheidung, Fehler klären), steht „DU BIST DRAN“ über der Anwendung, und das Terminal meldet einmal „Wartet im Chrome-Fenster auf dich: …“.
- **Aufnahme, Wiedergabe, Pause:** Ein Chip oben rechts in der Werkbank zeigt, was der Lauf tut: „REC“, solange Claude aufnimmt oder repariert, „PLAY“, solange caw-ai abspielt (run, Prüflauf, Zustand herstellen), „PAUSE“, solange ein solcher Lauf pausiert (F9). Läuft nichts (nach dem Lauf, nach der Übergabe, nach dem Abbruch), gibt es keinen Chip.
- **Nach dem Lauf:** Das Ergebnis steht als letzte Zeile im Chat, etwa „Gespeichert: caw/tests/bestellung.yaml“. Das Fenster bleibt mit „Fenster schließen“ noch 15 Sekunden offen und schließt sich dann selbst. Öffnet sich gleich ein neues Fenster (für Claude oder den Prüflauf), sagen Chat und Terminal das vorher.

Eigene Tabs kannst du jederzeit öffnen, auch während des Laufs: Gesteuert wird nur der Anwendungs-Tab samt Popups, und nur deren Fehler zählen. Klickst du dagegen im Anwendungs-Tab, während ein Lauf arbeitet, beeinflusst du den Test.

Du bleibst im Fenster hinter derselben Host-Sperre und bist als Testnutzer angemeldet. Dialoge wie `alert()` schließt Playwright automatisch, sie bleiben also nicht stehen. Das Profil ist frisch und wird am Ende gelöscht. Bleibt es etwa nach einem Abbruch liegen, entfernt es der nächste Lauf, sofern dessen Prozess nicht mehr läuft.

## Ablauf eines Laufs

Ein Lauf mit Claude, also beim Aufnehmen und Beheben, macht Folgendes:

1. **Abweisen, was nicht laufen darf:** Config, Testdatei, Ziel und Schreibschutz werden geprüft. Beim Agenten `local` dazu, ob Claude Code da ist.
2. **Image** (nur `docker`): Einmal bauen, aus dem Image des Projekts plus Claude und dem Container-Teil des Tools. Neu gebaut wird nur nach Änderungen daran.
3. **Öffnen:** mit `--overlay` die Quelle prüfen (lokaler Code-Server unter `overlay.url`, Build, Sencha-Watch; gestartet nur mit `--start`), Chrome starten, anmelden, Seite öffnen; mit `--overlay` nach dem ersten Laden prüfen, ob lokaler Code ankam. Fehler hier ergeben `error`, ohne dass Tokens anfallen.
4. **Claude starten:** Bei `local` startet `claude -p` auf deinem Rechner mit den gesperrten Werkzeugen (siehe [Sandbox-Grenzen](#sandbox-grenzen)), bei `session` wartet der Lauf auf deine Session. Bei `docker` startet der Container (`docker run --rm`): Firewall setzen, danach gibt der Container alle Rechte ab. Ist die Sandbox nicht nachweislich dicht, läuft Claude nicht.
5. **Testen:** `claude -p` arbeitet den Plan ab, jeder Browserbefehl geht als Datei über den Kanal an den Host. Das Urteil prüft der Host.
6. **Abschließen:** Mit dem Urteil endet Claude sofort (Prozess bzw. Container). Bericht, Trace und `floats.log` (Klicks und, bei `extjs`, die Reihenfolge der schwebenden Fenster mit Zeiten, ohne Inhalte) liegen unter `.caw/runs/<lauf>/`. Der Trace (`trace.zip`) enthält Seiteninhalte, Requests und Cookies des Testkontos; gib ihn nicht weiter. Bei `auth.type: basic` zeichnet er keine Snapshots auf, damit das Passwort aus dem Authorization-Header nicht darin landet. Eine erneute Anmeldung im Lauf (Zustand herstellen) unterbricht den Trace: Der Teil davor bleibt als `trace-1.zip`, `trace-2.zip` …, und in keinem steht ein Anmeldeformular oder -Request; Screenshots und `claude.log` unter `agent/`. Das Log entsteht laufend und zeigt Claudes Text und Befehle mit den Sekunden seit dem Start; dieselben Zeilen laufen im Terminal mit. Eine Schlusszusammenfassung nach dem Urteil fehlt darin. Im Terminal ist die Ausgabe farbig, die Datei bleibt ohne Farbcodes; `NO_COLOR=1` schaltet Farben ab. Chrome verschwindet ebenfalls.

Exit-Codes: `0` pass, `1` fail, `2` error (die Umgebung ist schuld), `3` Eingabe abgelehnt, `4` Aufnahme nötig (`record` oder `fix`).

### Fehlercodes

Alle Fehlercodes mit Abhilfe: [Befehle › Fehlercodes](commands.de.md#fehlercodes).

## Testplan aufnehmen: `record`

Rolle und App nennst du nur beim ersten Mal, die Metadaten schreibt das Tool (`targets: [<ziel>]`, `mutates: true`). Bei einer Neuaufnahme bleibt es erhalten. Claude Code bzw. Docker, Token und Image werden vorab geprüft, damit deine Vorführung nicht umsonst ist.

1. **Start.** Chrome und der Chat gehen auf, du bist angemeldet. Bei einem neuen Test führst du direkt vor. Bei einem bestehenden fragt der Chat zuerst: selbst vorführen oder Claude geht dem Testplan nach.
2. **Ablaufplan.** Claude legt den Entwurf als Karte im Chat vor: je Testschritt ID, Titel, Aktion und ein erwartetes Ergebnis, dazu Hinweise mit Annahmen und offenen Fragen. Der Plan ist die spätere Testdatei ohne Aufzeichnung, YAML mit `notes` und `steps`. Metadaten oder Aufzeichnungen, die Claude dort einträgt, wirft das Tool weg. Du gibst frei oder schreibst, was anders sein soll, und Claude legt eine neue Fassung vor. Bis zur Freigabe weist der Host jede Aktion in der Anwendung als `plan-required` ab, Lesen geht.
3. **Ausführen.** Claude geht den Weg in einem frischen Browser. Du kannst pausieren, schreiben, Elemente markieren und klicken. Ändert sich der Weg grundlegend, legt Claude eine neue Fassung vor. Alle Aktionen seit der letzten Prüfung gehören zum nächsten Schritt des Plans, deshalb muss Claude in dieser Reihenfolge prüfen (`step-order`).
4. **Bereinigen.** Claude geht von sich aus die Aktionen durch und nennt im Chat, was wegfällt, ohne dass du freigeben musst. Screenshots und das erste von zwei `fill` aufs selbe Feld streicht das Tool selbst.
5. **Prüflauf.** Das Tool spielt die Aufzeichnung ohne Claude ab, im Chat daneben siehst du den Fortschritt. Scheitert ein Schritt, bietet der Chat an, ihn zu beheben, auch im noch nicht übernommenen Entwurf.
6. **Ablösen.** Der Chat zeigt eine Karte „Prüflauf bestanden“ mit dem, was übernommen würde; Warnungen und über die Position gewählte Aktionen lassen sich aufklappen. Dazu „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“, das ein zweiter Klick bestätigt. Erst dann wird die Testdatei geschrieben. Besteht der Prüflauf nicht, bleibt der alte Testplan unberührt, Plan (`plan.yaml`) und Entwurf (`test-draft.yaml`) liegen im Lauf-Ordner. Committet wird nichts automatisch.

**Testdaten:** Läufe mit `mutates: true` hinterlassen Daten: je einen Datensatz von Claude und vom Prüflauf, je Beheben bis zu zwei weitere. Auch was Claude gestrichen hat, ist in der Anwendung passiert.

### Die Werkbank

Mit Chat läuft alles auf einer Seite, wie bei Cypress:

- **Oben:** Test, Ziel, Rolle, Stand (lokal oder wie unter der Adresse), was Claude oder caw-ai gerade tut, und der Chip REC/PLAY/PAUSE.
- **Links:** die Schritte mit ihrem Zustand (läuft, bestanden, gescheitert, nicht erreicht), darunter die Zähler für Requests und Konsole.
- **Mitte:** die Anwendung in einem iframe mit ihrer Adresse. Darunter Requests (Name, Ausgang, Dauer) und Konsole (Fehler und Warnungen); bei einem Konsolenfehler klappt die Leiste von selbst auf, „Einklappen“ schließt sie.
- **Rechts:** der Chat mit Claude, in einem Rahmen mit dem Titel CHAT.
- **Unten:** die Tastenleiste: F1 Zustand wählen (nach der Übergabe), F5 Neu laden, F9 Pause, Esc Abbrechen, F2 Requests, F3 Konsole, F4 Schritte, F6 Chat, F7 Theme, F8 Nur Anwendung, F10 Animationen aus. Die Tasten wirken auch, wenn der Fokus im Chat liegt.
- **Einklappen:** Schritte und Chat klappen über den Knopf am Rand (F4, F6) zu einer schmalen Leiste ein. Braucht der Chat dich, klappt er von selbst auf.
- **Neu laden:** F5 (die Taste, der Knopf in der Tastenleiste, auch in der Anwendung) lädt nach der Übergabe die aktuelle Seite ohne Cache neu; Chat und Schritte bleiben. Solange der Test läuft, ist das gesperrt und der Knopf ausgegraut: Ein Neuladen würde den Zustand für die folgenden Schritte verfälschen. Lädt jemand die ganze Werkbank über den Browser neu, baut caw-ai sie wieder auf; lief gerade der Test, bricht er ohne Ergebnis ab.

Die Werkbank liegt unter der Adresse der Anwendung selbst, auf ihrem Origin. Viele Anwendungen greifen auf das oberste Fenster zu (`top.Ext`, `parent.config`, `top.location.href`), weil sie sich im Portal dafür halten. In der Werkbank geht das genauso:

- **Gleicher Origin:** Der Browser blockt solche Zugriffe nicht.
- **Globale Namen:** Die Werkbank reicht globale Namen der Anwendung durch, die sie selbst nicht hat. `top.Ext` ist also das `Ext` der Anwendung.
- **Adresse:** Die Adresse der Werkbank folgt der Anwendung, `top.location.href` stimmt.
- **Navigation:** Lenkt die Anwendung das oberste Fenster um (`top.location = …`, Formular mit `target="_top"`, auch per POST), landet die Seite in der Anwendung, und die Werkbank bleibt. Ein laufender Test geht weiter; nur dein Neuladen (F5, Knopf des Browsers) macht ihn ungültig.

Ausgeliefert wird die Werkbank vom Tool: Abgefangen wird nur das Dokument des obersten Fensters, kein anderer Request. Damit sich die Anwendung einbetten lässt, entfernt der Testbrowser bei den Dokumenten ihrer Hosts `X-Frame-Options` und `frame-ancestors` aus der CSP, nur in diesem Browser.

Der Chat liegt in einem abgeschotteten iframe mit eigenem Origin (`sandbox` ohne `allow-same-origin`). Die Anwendung erreicht weder sein DOM noch kann sie dort als Mensch entscheiden. Meldungen von Werkbank und Chat zählen nie als Fehler der Anwendung.

**Mit Chat immer die Werkbank.** Ohne Chat (`--no-chat`, CI, `--headless`) läuft die Anwendung allein im eigenen Fenster. Einen Chat in einem eigenen Fenster gibt es nicht mehr.

**Grenzen:**

- iframes innerhalb der Anwendung, deren Host nicht freigeschaltet ist, bleiben leer wie bisher.
- Was eine Seite nur oben im Fenster tut (`window.top`-Prüfungen, Frame-Busting per Skript), kann im iframe anders laufen. Solche Prüfungen gehören in der Testumgebung abgeschaltet.
- Für das iframe schaltet der Testbrowser die Prüfung auf private Netze (Local Network Access) ab.

### Der Chat

In der Werkbank rechts, auch in einem Testlauf ohne Claude. Der Verlauf wandert über die Werkbänke von Vorführung, Claude und Prüflauf mit. Dort läuft auch Claudes Log mit: Text als Nachricht, Befehle als aufklappbare Aktionen. Das Fenster ist die einzige Quelle für Anweisungen, die Seite der Anwendung erreicht den Chat nicht. Die Mitschrift liegt als `chat.log` im Lauf-Ordner.

- **Vorführen:** Klicks, Feldänderungen und die Tasten Enter, Tab und Escape werden mitgeschnitten. Eine Nachricht gibt Claude Kontext an dieser Stelle des Wegs, „Als Prüfpunkt setzen“ legt dort einen künftigen Schritt mit Screenshot fest; tippe dafür zuerst ins Feld, was zu sehen sein soll. „Vorführung beenden“ beendet die Vorführung. Solange sie läuft, steht über der Anwendung „● AUFNAHME – deine Klicks zählen“. Passwortfelder verlassen die Seite nie. Alle anderen Eingaben gehen an Claude und landen in der Aufzeichnung, führe also nur Testdaten vor.
- **Nachricht schreiben:** Claude liest sie vor der nächsten Aktion, denn solange lehnt das Tool jeden Browserbefehl ab. Denkt Claude gerade, dauert das etwas.
- **Pause:** Claude hält vor der nächsten Aktion an, der Status im Fenster zeigt es. Danach kannst du schreiben und in der Anwendung klicken, bis du „Weiter“ drückst. Deine Klicks kommen in den Test, darum erst klicken, wenn „Pausiert“ dasteht.
- **Element markieren:** In Vorführung, Plan, Pause, Rückfrage und beim Fehler klären wählt „Element“ das Bauteil, auf das du dich beziehst: Der nächste Klick in der Anwendung löst dort nichts aus und kommt nicht in die Aufzeichnung, Esc bricht ab. Das Element hängt an deiner nächsten Nachricht, Claude bekommt seine Beschreibung.
- **Rückfragen:** Claude fragt per `ask-operator`. Deine Antwort oder „Fertig“ gibt den Lauf frei.
- **Schritt zurück:** Eine Rückspultaste gibt es nicht. Sag Claude, was falsch war: Es geht zum passenden Zustand und streicht den Umweg mit `omit`. Abgeschicktes bleibt in der Anwendung, dann hilft nur ein neuer Lauf.
- **Abbrechen:** Esc (oder „Abbrechen“ in der Tastenleiste) fragt „Wirklich abbrechen? (Esc)“; ein zweites Esc oder ein Klick darauf innerhalb von 4 Sekunden bestätigt und beendet alles sofort mit `error`. Den Chat zu schließen wirkt genauso, ohne ihn gibt es weder Freigabe noch Entscheidung.

Die Zeit für den Menschen zählt zum Limit von Claude, darum ist der Standard hier 60 Minuten (`--timeout`).

### Was in der Aufzeichnung steht

- **Was aufgezeichnet wird:** Erfolgreiche `click`, `fill`, `type`, `press`, `goto`, `reload`, `wait-ready`, `remember` und `check`. Fehlversuche, `eval` und `snapshot` fehlen.
- **Vollständigkeit:** Gespeichert wird nur, wenn jeder Schritt ein bestandenes `check` hat und danach keine Aktion mehr folgt. Sonst nennt die Ausgabe, was fehlt, und der Lauf endet mit `fail`.
- **Stabile Ziele:** Statt Referenzen speichert die Datei, wie ein Mensch das Element findet, je nach [Framework](#framework-web-react-vue-angular-oder-extjs): bei `web` Rolle und Name, z. B. `{role: button, name: Senden, inside: {role: dialog, name: Neue Bestellung}}`, bei `extjs` die Komponente, z. B. `{xtype: combobox, label: Land*, part: input.x-input-el}`. Listeneinträge hängen damit am Text; ändern sich die Daten, scheitert der Schritt.
- **Umwege:** Claude nennt beim Einreichen, was nicht zum Weg gehört (`"omit": [12, "14-16"]`). Sind alle Schritte bestanden, ist `omit` Pflicht, auch leer, und die Ablehnung zeigt Claude die ganze Aktionsliste. Prüfungen und `remember` lassen sich nicht streichen. Der Bericht listet alles Gestrichene. Übersieht Claude einen Umweg, bleibt er drin. Der Prüflauf beweist, dass der Weg läuft, nicht dass er der kürzeste ist: Prüfe die Datei vor dem Commit, denn ihre Ausdrücke laufen später ohne Claude in der angemeldeten Seite.
- **Laufkennung:** Jeder Lauf hat eine eigene `runTag`, z. B. `CAW-20261105185233`. Claude schreibt sie in Freitexte, an denen sich ein Datensatz wiedererkennen lässt. Die Aufzeichnung speichert `{{runTag}}`, und jedes Abspielen setzt seinen Wert ein. So findet ein Lauf seinen eigenen Datensatz statt den eines früheren. Bildet die Anwendung aus dem Namen eine Adresse in Kleinbuchstaben (`/akten/akte-caw-20261105185233`), steht dort `{{runTagLower}}`.
- **Daten relativ zu heute:** Ein Datum höchstens 60 Tage vor oder nach dem Aufnahmetag (`TT.MM.JJJJ` oder `JJJJ-MM-TT`) speichert die Aufzeichnung als `{{today}}`, `{{today+7}}` bzw. `{{todayIso-1}}`. Das Abspielen setzt das Datum seines Tages ein, so scheitert ein Test nicht am nächsten Tag an „Datum liegt in der Vergangenheit“. Daten weiter weg bleiben fest.
- **Werte aus dem Lauf:** Eine Bestellnummer gibt es bei jedem Lauf neu. Claude liest sie mit `remember bestellnr "<ausdruck>"`, die Aufzeichnung speichert danach `{{bestellnr}}` samt Ausdruck, und das Abspielen liest den Wert neu aus der Seite. Werte unter vier Zeichen weist der Befehl ab.
- **Projektkontext über Tests hinweg:** `caw/caw.md` ist für die Tests, was CLAUDE.md für Claude Code ist: relevante Infos zum Projekt und Eigenheiten der Anwendungen. Du hältst sie von Hand und checkst sie ein, etwa „die Suche merkt sich die letzte Eingabe“. Claude bekommt sie in jedem Lauf mit Claude. Die Datei zählt nicht zum Schritt-Hash, eine Änderung entwertet also keine Aufzeichnung. Betrifft eine Notiz den Weg, nimm neu auf. Nur Verhalten, keine personenbezogenen Daten.
- **Zwei Apps in einem Test:** Führt der Weg in eine zweite App des Projekts, nenne sie beim ersten `record` mit `--also verwaltung` (in der Testdatei `also: [verwaltung]`). Mit `--overlay` kommt auch deren lokaler Code mit, wenn sie eine Quelle hat. Die App braucht einen Eintrag in `apps`, eine `startUrl` aber nicht.

**Grenzen:**

- **Claude kann beim Suchen schreiben.** Eine Schreibsperre gibt es bewusst nicht: In vielen Anwendungen hängen Abschicken und Folgeschritte voneinander ab, und lesende und schreibende Requests sehen auf HTTP-Ebene oft gleich aus. Stattdessen gilt: Aufnahme nur auf Umgebungen mit `claude` und nur mit Testkonten, die Skill-Regel „nur eigene Datensätze“, die Freigabe des Plans, das Schrittbudget, und der Bericht listet unter „Schreibende Aufrufe“ jeden Aufruf außer GET, HEAD und OPTIONS und jeden mit einem Schlüssel aus `requestKeys`, ohne Parameterwerte. An- und Abmelden, Sitzung und Token (Pfade, die auf login, logout, session, token, auth, refresh, csrf u. Ä. enden) zählen nicht: Sie machen einen Test nicht schreibend.
- **Schrittbudget:** `--max-steps` (sonst `maxSteps` aus der Config, sonst 100) zählt `click`, `fill`, `type`, `press`, `goto` und `reload` von Claude, auch gescheiterte. Was du selbst vorführst, zählt nicht.
- **Claude reagiert nicht sofort:** `claude -p` läuft ohne Eingabe, Nachricht und Pause greifen vor der nächsten Aktion. „Abbrechen“ wirkt sofort.

## Testlauf: `run`

Spielt die Aufzeichnung ohne Modell, Docker und Token ab. Auf Umgebungen mit `claude` steht der Chat von Anfang an neben dem Fenster, außer in CI (Variable `CI` gesetzt), mit `--no-chat` oder `--headless`. Die erste Zeile im Terminal nennt den Modus und ob der Lauf Vergleichswerte lernt (`--no-learn` schaltet das ab), die letzte, was sich an den Dateien des Tests geändert hat. Der Chat: Er zeigt jede Aktion (`S3 · 4/12 click …`) samt neuer Versuche, die Eingabe ist gesperrt. Besteht der Lauf, meldet der Chat das samt Warnungen und wartet nicht; er schließt mit dem Lauf oder bleibt bei `--until` und `--handover` neben dem übergebenen Fenster. Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben). Fehlt die Aufzeichnung ganz, endet es mit Exit 4 und nennt `record`. Ist ein Schritt veraltet, endet es mit Exit 4 und nennt `fix` für genau diesen Schritt.

- **Warten:** Es gibt keine festen Pausen. Ein Schritt wartet, bis sein Ziel sichtbar und nicht überdeckt ist. Das deckt Lademasken, Overlays und Dialoge in Dialogen ab, denn nur der oberste Dialog ist klickbar. `check` wiederholt die Prüfung, bis sie stimmt oder das Zeitlimit abläuft.
- **Zeitlimits:** Standard sind 30 Sekunden je Schritt, änderbar mit `--step-timeout` oder von Hand je Aktion mit `timeoutMs` und je Prüfung mit `recording.timeoutMs` in der Testdatei. Klärt oder behebt Claude aus dem Lauf heraus, gelten `--timeout <minuten>` (Standard 60) und `--max-steps <n>` wie bei `record` und `fix`.
- **Fehler:** Scheitert ein Schritt, nennt der Bericht den Testschritt samt Aktion und verweist auf einen Screenshot. Aufräumschritte wie „Abbrechen“ laufen dann nicht mehr, ein angelegter Datensatz kann offen bleiben.
- **Fehlschläge:** Konsolenfehler, Skriptfehler, fehlgeschlagene Requests und HTTP-Status ab 500 beenden das Abspielen beim nächsten Schritt. Ebenso sichtbare Dialoge, Fehlermeldungen und Meldungen aus `messageSelectors`, die bei der Aufnahme nicht vorkamen, wobei Zahlen im Text nicht zählen. Beim Adapter `web` gilt ein Statushinweis (`role=status`, `aria-live=polite`, etwa ein Erfolgs-Toast) nicht als Fehlschlag: Er kommt je nach Tempo oder nicht, unbekannt steht er einmal als Warnung im Bericht. Ein Dialog mit Eingabefeldern ist Bedienung, keine Meldung. Dazu verlorene Anmeldung, eine nicht geladene Anwendung (bei `extjs`: kein ExtJS auf der Seite), eine stehen gebliebene Lademaske (`aria-busy`, bei `extjs` die Lademaske), eine andere Seite als aufgezeichnet und jedes nicht erfüllte `check`.
- **Beheben:** Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben).
- **Ohne Chat:** `--no-chat` spielt im sichtbaren Fenster ab wie in CI, ohne Chat und ohne Claude: Bericht, Screenshot, Hinweis auf einen Lauf mit Chat zur Ursache (`fix` nur bei gewollter Änderung), Exit-Code. `--headless` ebenso, aber ohne Fenster, mit festem Fenstermaß 1920×1080. Beide gehen nicht mit `--advise`, `--handover` oder `--until` (Exit 3). Ob eine Anwendung den Headless-Modus annimmt, zeigt erst der Lauf; sonst bleibt `--no-chat`.
- **Grenzen:** Abgespielt wird nur, was aufgezeichnet wurde. Claudes Blick auf Auffälliges fehlt, und auch hier gelten Schreibschutz und Host-Sperre. Toasts, die zwischen zwei Schritten wieder verschwinden, sieht das Abspielen nicht.

### Zustand herstellen und übernehmen

```bash
caw-ai run <test> --target local --until S4
```

Das Tool spielt die Aufzeichnung bis zum bestandenen `check` von `S4` ab und übergibt das Fenster. Spätere Schritte laufen nicht, sie dürfen also auch veraltet sein. Der Ablauf ist deterministisch, die Umgebung nicht: Das ist kein Snapshot. Der Weg läuft jedes Mal neu, mit neuen Daten, und weicht die Anwendung ab, scheitert der Schritt sichtbar.

- **Code:** Wie bei jedem Lauf der ausgelieferte Stand, außer du gibst `--overlay` an; gegen deinen Dev-Server als Umgebung ohnehin dein aktueller Code. Die Zeile `Code:` sagt, welcher (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)). Änderungen siehst du mit F5, der Maskenzustand ist danach weg. Um wieder hinzukommen, startest du den Befehl neu.
- **Weg scheitert:** Du klärst den Fehler im Chat und kannst den Schritt beheben lassen. Schließt du ihn, geht das Fenster trotzdem an dich, der Bericht nennt den Fehler. Der Exit-Code bleibt das Urteil.
- **Keine Aufzeichnung:** Exit 4, erst aufnehmen.
- **Zustand nach Reload:** Ob eine Ansicht nach F5 im selben Zustand bleibt, hängt von der Anwendung ab.

`--handover` übergibt das Fenster auch nach einem ganzen Testlauf. Es gilt nur für `run`.

### Im hergestellten Zustand entwickeln

Mit Chat bleibt der Chat nach der Übergabe offen (Zustand „Entwickeln“):

Die Werkbank startet in **Nur Anwendung** (F8 holt Schritte und Chat zurück); das Browserfenster bleibt, wie es ist.

- **Fragen:** Du fragst Claude im Chat, gern zu einem Element, das du mit dem Fadenkreuz-Knopf in der App gewählt hast. Claude liest den Quellcode und antwortet. Code ändert es nie selbst, es schlägt geprüfte Änderungen vor: „Änderung übernehmen“ schreibt sie in deinen Projektordner, „Prompt kopieren“ gibt sie dir für deine eigene Session.
- **Claude bedienen lassen:** Auf deine Bitte klickt Claude, füllt aus, drückt Tasten, navigiert oder lädt neu, etwa „klick den gewählten Button“. Vor allem, was Daten speichert oder löscht, fragt es nach.
- **Bug untersuchen:** Füge ein Bugticket in den Chat ein. Claude stellt es im hergestellten Zustand nach, sieht sich Konsole, Requests, Werte der Komponenten und den Quellcode an, nennt die Ursache mit Datei und Zeile und schlägt die Korrektur als Änderung vor, die du per Klick übernimmst. Danach neu laden oder den Zustand neu herstellen, und Claude prüft, ob der Bug weg ist.
- **Neu laden** (F5): lädt die aktuelle Seite ohne Cache neu, damit deine Änderung sofort da ist. Chat und Schritte bleiben; der Test ist schon vorbei, sein Ergebnis ändert sich nicht.
- **Zustand neu herstellen** (im Chat): beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet neu an und spielt die Aufzeichnung bis zum Schritt ab, mit neuen Testdaten, also genau wie jeder andere Lauf.
- **Zustand wählen (F1):** ein beliebiger Test dieser Umgebung, jeder Rolle, optional mit dem Schritt, bis zu dem er läuft. caw-ai stellt ihn im selben Fenster mit dem Konto der Rolle des Tests her. Scheitert das Herstellen, weiß Claude im Chat warum; es kann den Test auch anpassen, etwa einen Klick auf einen Cookie-Banner optional machen, und die Änderung steht sofort in der Testdatei.
- **Element an Claude Code:** Mit dem Fadenkreuz-Knopf im Chat klickst du in der Anwendung auf ein Element (der Klick löst dort nichts aus, Esc bricht ab). Es hängt an deiner nächsten Frage im Chat, und caw-ai legt es mit Beschriftung, Komponente bzw. Quelle, Seite und Requests für deine Claude-Code-Session ab, abrufbar mit `caw_selection`.
- **Ende:** „Lauf beenden“ oder Fenster schließen.

## Einen Schritt beheben

Scheitert ein Schritt in `run` oder im Prüflauf von `record` und `fix`, hält das Abspielen an, und der Browser bleibt im Zustand des Fehlers. Der Chat nennt „S4 ist gescheitert: <Grund>“ samt harten Fehlern und Warnungen und schaltet die Eingabe frei (Zustand „Fehler klären“), dazu „Schritt beheben“ und „Lauf beenden“. Darunter steht die [Einschätzung](#einschätzung-test-anwendung-oder-umgebung) des Tools mit ihren Befunden. Spricht sie für einen Fehler der Anwendung, ist „Schritt beheben“ nur noch der zweite Knopf, mit dem Hinweis, dass ein angepasster Test den Fehler nur verdecken würde. Das gibt es nur auf Umgebungen mit `claude`; in CI, mit `--no-chat`/`--headless` und auf den anderen Umgebungen bleibt es beim Exit-Code und beim Bericht.

- **Fragen:** Erst deine Nachricht startet Claude, im selben Browser und nur lesend wie bei den [Empfehlungen](#empfehlungen-zu-fehlern-und-warnungen). Es antwortet im Chat, nennt Ursache, Datei und Zeile und kann Empfehlungskarten geben. Jede weitere Nachricht geht ins selbe Gespräch, bis du einen Knopf drückst. Das Log steht in `agent/claude-talk.log`. Ohne Nachricht und ohne Klick fallen keine Token an.
- **Im selben Browser beheben:** Ist vom gescheiterten Schritt noch nichts ausgeführt, scheiterte also seine erste Aktion ohne harten Fehler von außen, behebt Claude ihn direkt dort, ohne Vorlauf. Der Bericht des Testlaufs bleibt als `report-test-run.md` erhalten. Sonst, etwa nach einer halben Aktionsfolge oder einer nicht erfüllten Prüfung, geht es wie unten mit Vorlauf in einem frischen Browser. Der Chat sagt vorher, welcher Weg es wird.

`fix <test> S4 --target <umgebung>` startet den Weg mit Vorlauf direkt, etwa für einen von Hand geänderten oder neu eingetragenen Schritt. Die Schritte davor müssen aktuell sein. Weil S4 dabei nicht gescheitert ist, heißt es im Chat „S4 neu aufnehmen“, und Claude sucht keine Ursache. Legt Claude den Plan unverändert vor, gilt er ohne Freigabe: Der Chat sagt das, und du kannst trotzdem schreiben, wenn sich etwas ändern soll. Die Karte zum Freigeben erscheint nur, wenn sich am Schritt etwas ändert, beim Beheben eines Fehlers ebenso.

Im Chat erscheint als Nachricht nur, was Claude dir mit `say` sagt. Seine übrigen Notizen stehen eingeklappt bei den Aktionen. Brichst du ab, steht im Bericht „Von dir abgebrochen.“

1. **Vorbereiten:** In einem frischen Browser laufen S1 bis S3 ohne Claude, der Chat zeigt den Fortschritt. Scheitert schon davor ein Schritt, wird dieser angeboten. Beim Beheben im selben Browser entfällt das.
2. **Ursache, dann Plan:** Claude bekommt nur diesen Schritt: Text, bisherige Aktionen, Prüfung, Grund, Einschätzung samt Requests, dazu `caw.md` und die bisher gelesenen `remember`-Werte. Zuerst klärt es die Ursache, auch im Quellcode, und sagt sie im Chat. Liegt es an der Anwendung, ändert es den Test nicht, sondern gibt eine Empfehlung mit konkreter Änderung am Code und meldet `fail`. Sonst legt es nur diesen Schritt als Karte vor. Ein geändertes Ergebnis ist dort markiert, erscheint bei der Entscheidung und steht im Bericht.
3. **Ausführen:** Claude führt den Schritt aus und bereinigt ihn. Bleibt das Ergebnis gleich, muss auch die Prüfung gleich bleiben, sonst lehnt `finish` ab. Fällt ein `remember`-Wert weg, den ein späterer Schritt braucht, ebenso.
4. **Prüflauf:** Der ganze Test läuft ohne Claude in einem frischen Browser, bis vor einen womöglich noch veralteten Schritt. Scheitert ein anderer Schritt, kommt wieder das Angebot. Besteht er: „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“.

Nur die behobenen Schritte ändern sich in der Datei, Kommentare und alle anderen Schritte bleiben Zeichen für Zeichen gleich. Neue Meldungen, die Claude dabei sieht, zählen danach als bekannt; die Entscheidung nennt sie, damit kein Fehler der Anwendung unbemerkt durchrutscht.

- **Testdaten:** Ein Beheben kostet bis zu zwei Durchläufe, schreibende Schritte davor legen entsprechend Daten an. Token fallen nur für diesen Schritt an. Scheitert ein Schritt nach dem Absenden, bleibt der Datensatz offen, das Abspielen räumt nicht auf.
- **Ohne Claude:** Fehlt Claude Code (`local`) bzw. Docker oder Token (`docker`), nennt der Chat den Grund, der Lauf bleibt `fail`.
- **Entwurf verwerfen:** Der Testplan bleibt unverändert, nach einer Rückfrage („Wirklich verwerfen?“). Ein zuvor gescheiterter `run` endet mit `fail`.
- **Einfügen, Löschen, Umsortieren:** Einen neuen Schritt trägst du von Hand ein und nimmst ihn per `fix` auf. Ein gelöschter oder verschobener Schritt verlangt `record`, weil spätere Schritte auf ihm aufbauen können.

## Einschätzung: Test, Anwendung oder Umgebung

Scheitert ein Schritt, ordnet das Tool den Fehler ein, ohne Claude und ohne Token. Es nutzt nur, was jeder Browser liefert, unabhängig von Framework und Umgebung:

- **Requests** der Anwendung (`xhr`/`fetch`) mit Name, Status, Dauer und Ausgang: beantwortet, HTTP-Fehler, abgebrochen, fehlgeschlagen. Der Name ist Methode und Pfad; Parameterwerte stehen nie darin, außer für die Parameter aus `requestKeys`. Ein Abbruch durch einen Seitenwechsel zählt nicht. Dazu kommen die **Namen der Parameter** ohne Werte, aus der Query und aus Formular-Bodys (`application/x-www-form-urlencoded`); JSON-Bodys bleiben außen vor.
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

Ohne `recording.network` sagt der Bericht das. Der Vergleich entsteht nie beim Aufnehmen oder Beheben: Unter Claudes Steuerung laufen auch Fehlklicks und Umwege, die aus der Aufzeichnung gestrichen werden, ihre Requests gehörten nicht zum Schritt. Er entsteht ohne Claude und Token im nächsten `run` mit Chat auf einer Umgebung mit `claude`, aus der bereinigten Aufzeichnung: Jeder bestandene Schritt ohne Vergleich bekommt ihn dann aus diesem Lauf, wenn er auf demselben Ziel aufgenommen wurde. Ebenso die Wirkung je Aktion. Der Chat und das Terminal nennen die Schritte, nur dieses Feld ändert sich in der Datei, der Hash bleibt unberührt. Vorhandene Werte überschreibt ein `run` nie, außer sie stammen aus der Zeit vor den Parameternamen (Einträge ohne `params`). Ohne Chat, etwa in CI, bleibt die Datei, wie sie ist.

### Wirkung je Aktion

Jede Aktion (Klick, Eingabe, Taste) hat eine Wirkung auf der Seite. Das Tool misst sie nach jeder Aktion, sobald die Seite ruhig ist, und hält sie in `recording.effects` fest. Die Wirkung ist der Unterschied zwischen vorher und nachher, ohne Werte:

| Liste | Inhalt | Beispiel |
|---|---|---|
| `controls` | Zustand der sichtbaren Bedienelemente: gesperrt, Pflicht, nur lesbar, ungültig, angehakt, aufgeklappt, gewählt, leer/gefüllt. Elemente in Listen- und Tabellenzeilen zählen nicht, denn das sind Daten, oft auch fremde. Von einer Liste zählt nur, ob sie Zeilen hat. | `+ input "Lieferadresse*" empty`, `+ list "Bestellungen" rows` |
| `view` | ARIA-Baum ohne Links, Feldinhalte und lange Texte (Listen sind Daten) | `+ - text: Bestellung vollständig? …` |
| `requests` | beantwortete Requests der Aktion mit Status | `GET /api/orders 200` |
| `responses` | Form der JSON-Antworten (Schlüsselpfade als Kurz-Hash) und fachliche Fehlerzeichen wie `success=false` | `GET /… form 3fa2c… success=true` |
| `console` | Meldungen der Konsole | `error: Bestellung laden fehlgeschlagen` |

Zahlen werden zu `#`, damit Bestellnummern und Daten nicht stören.

**Lernen:** Ein bestandener `run` mit Chat auf einer Umgebung mit `claude` trägt die Wirkung ein. Die ersten zwei gesunden Läufe gleichen sich ab. Erhalten bleibt nur, was in beiden gleich war; die Konsole sammelt alles, was vorkam. Danach gilt die Wirkung als gelernt (`runs: 2`) und kein Lauf ändert sie mehr. Ein neu aufgenommener Schritt lernt neu.

**Vergleich:**
- Fehlt beim Abspielen etwas aus der gelernten Wirkung, ist das eine Abweichung, ebenso eine neue Konsolenmeldung.
- Scheitert ein Schritt, nennt die Einschätzung die erste abweichende Aktion bis zu diesem Schritt (Anwendung, wahrscheinlich) und was stattdessen geschah. Claude bekommt sie als `evidence.effect`.
- Ist die Prüfung erfüllt, entscheidet die Art der Abweichung. Weicht eine gelernte Wirkung in einer Liste aus `effects.fail` der Config ab, **scheitert der Schritt** (Einschätzung: Anwendung, wahrscheinlich; auch ein anderer Datenstand als beim Lernen kann das erklären, etwa eine Liste, die damals leer war). Standard ist `["controls", "console"]`: der Zustand der Bedienelemente und neue Konsolenmeldungen. Diese Signale waren in gesunden Läufen völlig stabil. Abweichungen in `view`, `requests` und `responses` bleiben Warnungen im Bericht; so fällt Drift auf, bevor eine Prüfung reißt. Mit `"effects": { "fail": [] }` bleiben alle Abweichungen Warnungen.
- **Wiederholungen (`retry`)** verändern die Anwendung, etwa wird ein Eintrag ein zweites Mal geöffnet und damit gesperrt. Deshalb gilt nach dem ersten neuen Versuch im Lauf: Schritte, die nur als Vorlauf erneut laufen (bei `retry.from`), werden weder verglichen noch gelernt; spätere Schritte warnen nur noch, nur der wiederholte Schritt selbst scheitert weiter an seiner Wirkung. Weicht er zweimal gleich ab (gemessen an den Listen aus `effects.fail`), gibt es keinen weiteren Versuch.
- **Selbstbereinigung:** Besteht ein ganzer Lauf ohne Wiederholung, und weicht ein Schritt nur in Listen außerhalb von `effects.fail` ab, dann schwankt das offenbar. Die fehlenden Zeilen fallen aus der gelernten Wirkung, etwa ein Request, der nicht in jedem Lauf kommt. Die Warnung erscheint so nur einmal. Abweichungen in Listen aus `effects.fail` bleiben Befunde.
- Ein Schritt mit gelernter Abweichung lernt sonst nicht, damit kein Fehler aus dem Vergleich verschwindet. Soll eine geänderte Wirkung gelten, im Chat **„Neue Wirkung übernehmen“** wählen. Der Knopf erscheint, wenn nur die Wirkung abweicht und die Prüfung erfüllt ist. Er löscht `effects` dieses Schritts aus der Datei, ohne Claude und ohne Tokens; die nächsten zwei gesunden Läufe lernen sie neu. Ohne Chat geht dasselbe, indem man `effects` aus der Datei löscht.

## Empfehlungen zu Fehlern und Warnungen

Ohne Fix-Parameter kostet nichts Token, solange du nicht schreibst oder klickst: Ein `run` zeigt bei einem gescheiterten Schritt im Chat den Grund, die harten Fehler und die Warnungen. Claude empfiehlt von sich aus nur hier, und im Gespräch, wenn du danach fragst:

| Lauf | Wann |
|---|---|
| `run` und „Ursache von Claude untersuchen lassen“ | Ein Schritt ist gescheitert, du klickst den Knopf im Chat. Lautet die Einschätzung „Anwendung“, ist er der Hauptknopf, sonst steht er neben „Schritt beheben“. Danach wie mit `--advise`: Karten, bei übernommener Änderung an der Anwendung „Erneut testen“ |
| `run … --advise` | Ohne Klick: Ein Schritt scheitert, ein harter Fehler tritt auf oder es gibt Warnungen, auch in einem bestandenen Lauf. Für Läufe, deren Ergebnis du dir erst später ansiehst. Nur auf Umgebungen mit `claude` und mit Chat (nicht in CI), sonst Exit 3 |
| `fix <test> <S4>` und „Schritt beheben“ | Fehler oder Warnungen beim Beheben und im Prüflauf danach |
| `record` | erst, wenn du im Prüflauf „Schritt beheben“ wählst |

Claude arbeitet im Browser des gescheiterten Laufs, der Zustand ist also noch da. Es darf nur lesen (`snapshot`, `eval`, `console`, `network`, `screenshot`, `url`), alles andere lehnt der Host mit `advise-only` ab. Den Quellcode liest es wie immer schreibgeschützt und sucht dort nach der Ursache, egal mit welchem Framework. Sein Log steht in `agent/claude-advice.log`.

Jede Empfehlung nennt ihren Beleg (`evidence`), etwa einen Request, einen harten Fehler oder eine Fundstelle im Code; ohne lehnt der Host sie ab. Im Chat erscheint jede als Karte, eine nach der anderen:

- **Test:** Titel, Begründung, Beleg und das Geänderte als Vorher und Nachher, dazu „Übernehmen“ und „Verwerfen“. Möglich sind `name`, `do`, `expect`, `note` und `retry` eines vorhandenen Schritts, die `notes` des Testfalls, ein Eintrag in `caw/caw.md` und ein Muster in `consoleIgnore` oder `foreignCode`. Spricht die Einschätzung eindeutig für einen Fehler der Anwendung, markiert die Karte die Empfehlung als Widerspruch dazu.
- **Anwendung:** Titel, Begründung, Beleg und ein fertiger Prompt für eine Claude-Code-Sitzung bei dir, mit „Prompt kopieren“ und „Weiter“. Bringt Claude konkrete Änderungen mit (`edits`: Datei, gesuchte Stelle, Ersatz, Grund), prüft der Host sie gegen den echten Code: Pfad relativ zum Projekt, nicht unter `caw/`, `.caw/`, `node_modules/`, `.git/` oder `.claude/`, die Stelle genau einmal in der Datei. Die Karte zeigt Datei, Zeile und den Unterschied. „Änderung übernehmen“ schreibt sie in die Dateien, Zeilenenden bleiben; hat sich die Stelle inzwischen geändert, schreibt es nichts. Claude selbst ändert Anwendungscode nie.

Was Übernehmen bewirkt:

- **Nur `retry`:** wirkt sofort, ohne neue Aufnahme, denn `retry` zählt nicht zum Hash.
- **Geänderter Text** in `name`, `do`, `expect` oder `note`: Der Schritt ist danach veraltet, und der Chat bietet „Schritt beheben“ an.
- **`caw.md` und Config:** werden sofort geschrieben, die Config gilt ab dem nächsten Lauf.
- **Testdatei:** Im `run` steht die Änderung sofort in der Datei. Bei `fix` und `record` kommt sie in den Entwurf und gilt erst mit „Testplan übernehmen“.
- **Änderung am Code:** steht sofort in der Datei. Prüfe sie mit dem Lint des Projekts und einem neuen `run`.

Der Abschnitt „Empfehlungen“ in `report.md` nennt jede Empfehlung mit Beleg und deiner Entscheidung, bei einer Anwendungsempfehlung samt Prompt und Änderungen als Diff. Committet wird nie.

## Konsolenausgabe

Im Terminal zeigt das Tool Farben, Symbole und am Ende einen Ergebnisblock mit jedem Schritt. In Dateien und Pipes bleiben es schlichte Zeilen mit `[caw-ai]` davor. `NO_COLOR` schaltet das ab, `FORCE_COLOR` erzwingt es.

## Wie der lokale Code in die Anwendung kommt

Wann lokaler Code läuft, was du einträgst und wie Build-Ordner und Dev-Server in die Seite kommen: [Konfiguration › Lokalen Code testen](configuration.de.md#lokalen-code-testen). Dieser Abschnitt behandelt das gemeinsame Modell, ExtJS (Sencha) und die Reihenfolge beim Einrichten.

Für jedes Framework gilt dasselbe Modell: Der **lokale Code-Server** deines Projekts läuft unter `overlay.url`, gestartet mit dem eigenen Befehl deines Projekts `overlay.start`. caw startet nichts selbst (nur mit `--start`, für CI); es prüft den Server, nimmt den Code von dort und nennt `start`, wenn er nicht läuft.

Mit `"framework": "extjs"` nimmt `--overlay` (oder `--overlay dev`) den lokalen Code vom Webserver des Sencha-Watch, `overlay.url`, standardmäßig `http://localhost:1841/`. `--overlay http://localhost:1842/` ersetzt ihn für einen Lauf. Die ExtJS-App wird in einer ausgelieferten Seite unter ihren Build-Namen geladen; caw beantwortet diese Requests mit den Quellen, die `bootstrap.json` des Watch nennt, in ihrer Reihenfolge. Optional an der App: `start` (etwa `"pnpm run watch"`) und `statics`. `--overlay build` wird abgelehnt (Exit 3).

**Build-Namen.** caw leitet sie ab, wie Sencha Cmd baut:

- **App:** `output.js.path` (oder `output.js` als Text) in `app.json`, auch in den Stages `production`, `testing` und `development`; sonst `app.output.js.path` bzw. `app.output.js` aus `.sencha/app/*.properties`; sonst `app.js`. Welche Stage ausgeliefert ist, weiß caw nicht, darum zählt jeder dieser Namen.
- **Paket:** `<name>.js` und `<name>-debug.js`, der Name aus den Paketen in `bootstrap.json`.

Ein Request passt über den letzten Teil seines Pfads; der Ordner davor ist der Ablageort im Portal. Der Name kommt aus dem Pfad unterhalb der Umgebungs-URL oder aus Gruppe 1 von `assetUrlPattern`. Pakete des Frameworks (`ext/`, `node_modules/@sencha/`) werden nie ersetzt, Ext JS selbst kommt also immer vom Server. Passt ein Name zu zwei Teilen oder lädt die Seite zwei Dateien mit demselben Build-Namen, endet der Lauf mit Exit 2 (`overlay-ambiguous`) und nennt beide; gib einer App einen eigenen `output.js.path`.

**Der Watch.** caw liest `bootstrap.json` und jede Quelle, die sie nennt, per HTTP vom Watch unter `url` (Pfade mit `../` relativ dazu aufgelöst), `bootstrap.json` einmal je Laden der Seite. Die Build-Namen kommen weiter aus `app.json` und `.sencha/app/*.properties` im Projektordner. Der Watch darf also laufen, wo sein Port erreichbar ist, etwa in einem Devcontainer mit weitergeleitetem Port.

- **Der Watch dieser App:** Vor dem Browser fragt caw `<url>app.json` und `<url>bootstrap.json` an. Der Name muss zum lokalen `app.json` passen, die Ladereihenfolge darf nicht leer sein. Der Watch eines anderen Projekts auf demselben Port ist `wrong-app` (Exit 2, `overlay-not-ready`) und wird nie still verwendet.
- **Zufälliger Port:** War 1841 belegt, nimmt der Sencha-Watch einen anderen Port. caw sieht sich die laufenden Watch-Prozesse an, fragt ihre offenen Ports ab und nimmt den, der diese App ausliefert (`moved`), mit dem Hinweis, `apps.<app>.overlay.url` anzupassen.
- **Kein Watch aktiv:** Exit 2 (`overlay-not-ready`) mit `start` und App-Ordner. Mit `--start` führt caw `start` im App-Ordner aus, wartet bis zu 180 s, bis der Watch diese App ausliefert, schreibt die Ausgabe nach `.caw/<app>-watch.log` und beendet ihn am Ende.
- **Geänderte Dateien kommen beim nächsten Laden an.** Neue Klassen stehen erst in `bootstrap.json`, wenn der Watch gebaut hat.
- **`bootstrap.json` fehlt, ist leer oder nennt eine Datei, die der Watch nicht ausliefert:** Exit 2 (`overlay-stale`). Warten, bis der Watch gebaut hat, oder ihn neu starten.

**Vollständigkeit.** Nach dem ersten Laden vergleicht caw die Skript-Requests der Seite mit den Teilen aus `bootstrap.json` (App und eigene Pakete). Einen Teil erkennt es an seinem Dateinamen irgendwo in der URL, im Pfad oder in einem Parameterwert wie `/o/FormProxyServlet?url=…/Root/…/x.js`, unabhängig von `assetUrlPattern`. Kam ein Teil vom Server, endet der Lauf mit Exit 2 (`overlay-incomplete`): Die Seite liefe teils mit deinem Code, teils mit dem ausgelieferten, und das zeigt sich als Fehler fern der Ursache (`$jscomp is not defined`, ein kaputtes Grid). Die Meldung nennt die Teile, bis zu fünf URLs und das `assetUrlPattern`, das sie abfängt. Ein Teil, der nie angefragt wurde, ist nur ein Hinweis: Vielleicht lädt die App ihn später.

Das Overlay richtest du in dieser Reihenfolge ein:

1. `overlay.url` und `overlay.start` an der App eintragen (`init` schreibt bei ExtJS den Standard `http://localhost:1841/`; der Skill leitet beides aus `vite.config`, `angular.json`, den Skripten in `package.json` oder der README ab).
2. Den Server selbst mit `start` im App-Ordner starten oder deine Claude-Code-Session das tun lassen (sie fragt vorher und startet ihn im Hintergrund).
3. `npx caw-ai overlay status`, bis es `ready` meldet (`moved`: `url` auf die genannte Adresse setzen).
4. `npx caw-ai overlay check`, bis es vollständig meldet (`--apply` trägt vorgeschlagene Muster ein).

`doctor` zeigt Server, `bootstrap.json` und die letzte Prüfung je Teil.

## Framework: `web`, `react`, `vue`, `angular` oder `extjs`

Fast alles im Tool kennt kein Framework: Snapshot, Klicks, Konsole, Requests, Einschätzung, Chat. Was davon abhängt, steckt in einem Adapter, gewählt mit `framework` in der Config. Ein Projekt hat genau einen; die Testdatei nennt ihn nicht. `react`, `vue` und `angular` sind `web` mit drei Zusätzen: Sie erkennen, wann das Framework die Anwendung eingehängt hat, nennen zu jedem Ziel die Komponente (nur als Hinweis für Claude und den Bericht) und überspringen Framework-Dateien im Stack.

| | `web` (Standard) | `react` / `vue` / `angular` | `extjs` |
|---|---|---|---|
| Ziel speichern | Rolle und zugänglicher Name (`aria-label`, Beschriftung, Text), dazu `data-testid` und der nächste benannte Bereich als `inside` (Dialog, Formular, Zeile). Ohne Rolle: Tag und eigener Text. Werte von Feldern nie. Offene Shadow Roots zählen mit (geschlossene sind nicht erreichbar); in einem iframe der Anwendung trägt das Ziel das iframe als `frame` | wie `web`, dazu `component`: die Komponenten von außen nach innen, etwa `GroupsScreen › Button`; bei Vue auch `source`, die Datei der SFC. Nur im Dev-Build, beim Wiederfinden ohne Bedeutung | Komponente: `xtype`, Beschriftung, `itemId`, Teil-Element |
| Bereit | Dokument geladen, kein Request der Seite offen (länger als 10 s offene wie Long-Polling zählen nicht), nichts mit `aria-busy`, kein unbestimmter Fortschritt (`role=progressbar` ohne `aria-valuenow`), DOM seit 150 ms still | wie `web`, dazu eingehängt: React-Root-Container, Vue `data-v-app`, Angular `[ng-version]`; Angular zusätzlich stabil laut Zone.js, wenn die App Testability anbietet (bei `bootstrapApplication` nur mit `provideProtractorTestingSupport()`) | Kein `Ext.Ajax`-Request offen, kein Store lädt |
| `wait-ready --store` | CSS-Selektor, `--min-count` zählt sichtbare Treffer | wie `web` | `storeId` oder ComponentQuery, zählt Datensätze |
| Meldungen | modale Dialoge ohne Eingabefelder, `role=alert`, `role=alertdialog`, oder `messageSelectors`; `role=status` (Toasts, Snackbars) nur als Hinweis | wie `web` | modale Dialoge, `messageSelectors`, dazu ExtJS-Dialoge und Toasts |
| Stack-Herkunft | oberster Eintrag | oberster außerhalb von `react-dom`, `@vue/*`, `@angular/*`, `zone.js` | oberster Eintrag außerhalb von `ext-*.js` |

Für alle gilt:

- **Quellkarten:** Ein Skriptfehler zeigt auf den Quellcode, wenn die Anwendung Quellkarten ausliefert (Vite im Dev-Modus immer, Builds mit `sourcemap`): `src/screens/GroupsScreen.tsx:190:15` statt `index-3f9a.js:1:48211`. Geladen wird nur vom Origin des Skripts und nur von Hosts der Sperre.
- **Routenwechsel:** Bricht ein Single-Page-Router beim Wechsel der Route offene Requests ab (bis 1 s davor oder 0,5 s danach), gilt das nicht als Fehler der Anwendung, ebenso wenig wie ein Abbruch durch einen Seitenwechsel.
- **Verdeckte Ziele:** Ist ein Ziel nicht klickbar, sagt das Tool, warum: es fehlt, es ist unsichtbar, oder ein Dialog liegt darüber, samt seiner Meldung.
- **Virtualisierte Listen:** Fehlt eine Zeile, rollt die Suche die Liste weiter, bis sie auftaucht.

Für `web` und die SPA-Adapter hilft eine zugängliche Oberfläche: Knöpfe mit Text oder `aria-label`, Felder mit `<label>`, Dialoge mit Titel. Wo das fehlt, macht `data-testid` ein Ziel eindeutig. Sonst bleibt der Index unter gleichen Treffern, und der bricht, sobald sich die Reihenfolge ändert. Erzeugte Klassen und ids (`_ngcontent-…`, CSS-Module-Hashes, `:r1:` aus `useId`) nutzt kein Adapter.

**Dev-Server statt Bundle:** Eine gebündelte Anwendung (Vite, Angular CLI, webpack) testest du lokal direkt gegen ihren Dev-Server, etwa `http://localhost:5173`; das Backend erreicht sie über den Proxy des Dev-Servers, auch ein entferntes. `http` ist nur auf dem eigenen Rechner erlaubt: `localhost`, `127.0.0.1` oder ein Name unter `.localhost` (etwa `app.localhost`, wenn mehrere Anwendungen getrennte Cookies brauchen). Chrome erreicht diese Namen immer über `127.0.0.1`; lauscht der Dev-Server nur auf `::1`, starte ihn mit `--host 127.0.0.1`.

## Sandbox-Grenzen

**Lokal (Agent `local`):**

- **Werkzeuge:** Claude Code startet mit `--tools Read,Grep,Glob`, `--permission-mode dontAsk` und `--strict-mcp-config`: keine Shell, kein Schreiben, kein Web, nur das caw-Tool als MCP-Server. Hooks sind abgeschaltet. `--tools` legt die Liste fest, eigene Einstellungen schalten keine weiteren Werkzeuge frei.
- **Reichweite:** Freigegeben ist nur `Read(./**)`, `Grep(./**)` und `Glob(./**)`, also der Projektordner; alles andere lehnt `dontAsk` ab, auch `~/.ssh` oder die Anmeldung von Claude Code (geprüft mit Claude Code 2.1.319). Deine eigenen und die Claude-Code-Einstellungen des Projekts werden nicht geladen (`--setting-sources ""`), ihre `allow`-Regeln erweitern das also nicht; aus `~/.claude/settings.json` kommen nur die Verbindungseinstellungen mit (`env`, `apiKeyHelper`, `model`, AWS-Helfer). Screenshots im Agent-Ordner unter `.caw/` kann Claude lokal nicht ansehen.
- **Dateien:** `.env*`, `.git`, `.claude`, `.worktrees`, `.caw`, `caw/.auth` sowie typische Schlüsseldateien (`.npmrc`, `*.pem`, `id_rsa*` …) sind per `permissions.deny` gesperrt. Das ist eine Sperre von Claude Code, kein Dateisystem-Schutz wie im Container: Wer stärkere Garantien braucht, nimmt `docker`.
- **Netz:** Claude selbst hat kein Web-Werkzeug. Die Anwendung erreicht es nur über den Browser mit dessen Sperre.

**Session (Agent `session`):** Es gelten die Rechte deiner eigenen Claude-Code-Session. caw-ai gibt ihr nur die Befehle für den Browser dazu.

**Container (Agent `docker`):**

- **Dateien:** Der Projektordner ist read-only eingebunden, im Container immer unter dem Linux-Pfad (`C:\x` als `/mnt/c/x`). Beschreibbar sind nur der Agent-Ordner des Laufs und das Innere des Containers. `.git`, `.claude`, `.worktrees`, `.caw` und alle `.env`-Dateien sind ausgeblendet, auch `caw/.env`. Andere Geheimnisse im Projektordner sieht der Agent.
- **Netz:** Default deny für IPv4 und IPv6. Erlaubt sind Loopback und HTTPS zur Anthropic-API. Deren Adressen löst die Firewall beim Start auf und trägt sie in `/etc/hosts` ein; danach ist auch DNS gesperrt, samt Dockers eingebautem Resolver, damit sich keine Daten in DNS-Namen hinaustragen lassen. Ändern sich die Adressen der API während eines Laufs, hilft ein neuer Lauf. Die Anwendung ist aus dem Container nicht erreichbar.
- **Rechte:** Der Container startet nur für die Firewall als root und läuft danach als Sandbox-Benutzer (`sandboxUser`) ohne Capabilities, mit `no-new-privileges`. Es gibt keine veröffentlichten Ports und keinen Docker-Socket.
- **Token:** Es kommt zur Laufzeit als Umgebungsvariable und liegt nicht im Image.

**Chrome (auf dem Host, außerhalb der Docker-Firewall):**

- **Steuerung:** Der Agent bekommt nie CDP. Es gibt nur die festen Befehle aus `caw-ai help`, als Dateien im Agent-Ordner. Navigation per `goto` geht nur zu erlaubten Hosts.
- **Netz:** `--host-resolver-rules` lässt nur die Hosts aus `environments` und `extraAllowedHosts` zu, auch IP-Adressen sind gesperrt. Dazu `--no-proxy-server` und eine WebRTC-Sperre.
- **Werkbank:** Das Dokument des obersten Fensters beantwortet das Tool selbst, unter der Adresse der Anwendung. Die Anwendung teilt sich damit den Origin mit der Werkbank und kann deren Seite verändern; Entscheidungen fallen nur im Chat, und den erreicht sie nicht (eigener, opaker Origin). Ein POST ins oberste Fenster schickt das Tool einmal über den Browser-Kontext (gleiche Cookies, gleiche Host-Sperre) ab.
- **Grenze der Sperre:** Sie kennt Hosts, keine Ports. Andere Dienste auf einem erlaubten Host sind aus der Seite erreichbar.
- **Einsicht:** `eval` läuft in der angemeldeten Seite. Claude sieht und kann also alles, was der Testnutzer in der Anwendung sieht und kann. Deshalb nur Testkonten mit wenig Rechten verwenden.
- **Backend:** Die Sperre endet am Host der Anwendung. Requests über einen Proxy der Anwendung gehen durch, und wohin er weiterleitet, entscheidet der Server. Die eigentliche Grenze sind die Rechte des Testkontos.
- **`mutates: false`:** Ein neuer Test ist schreibend, außer `record … --read-only`. Schreibt ein lesender Test bei der Aufnahme doch, wird er beim Übernehmen schreibend. Das Tool prüft das Feld vor dem Start gegen `environments.<umgebung>.writable`. Im Lauf verhindert nur die Anweisung im Skill das Schreiben, technisch blockiert ist es nicht.
- **Firmenrichtlinien:** Eine zentral erzwungene Chrome-Richtlinie (z. B. ein Proxy) kann die Sperre aushebeln. Prüfe das auf dem Rechner, auf dem die Tests laufen (`chrome://policy`).

**Urteil:** Bericht und `result.json` schreibt nur der Host, außerhalb des Agent-Ordners. Als Screenshot zählt nur, was der Host selbst aufgenommen hat.

## Entwicklung

```bash
npm test                          # Unit-Tests; die Browser-Tests brauchen Chrome und laufen sonst nicht mit
npm run e2e                       # E2E gegen das Fake-Portal unter e2e/, mit Skripten statt Claude und Mensch
npm run pack:check                # Paketinhalt: keine Geheimnisse, keine Tests, keine Projektbegriffe
```

Unter Windows läuft das E2E am besten aus PowerShell über `e2e/watchdog.ps1`: Der Wächter beendet den Lauf, wenn das Log zu lange still steht. Maßgeblich sind die Ergebnisse in `<log>.result` mit der Summe `RESULT OK=… FAIL=…`, die auch in `<log>.status` steht: Ins Log schreiben die Prozesse des Agenten mit und können dabei Zeilen überschreiben. Gibt es ein FAIL, endet das E2E mit Exit 1. Das E2E baut beim ersten Lauf das Sandbox-Image aus `node:22-bookworm-slim` und braucht dafür Docker, aber kein Token.

Erprobt ist das Tool mit ExtJS 6.5.3 Modern, React 19 (Vite-Dev-Server), Vue 3.5 und Angular 19. `e2e/frameworks` prüft React 19 (Vite 8), Vue 3.5 (Vite 8), Angular 21 (zoneless und mit Zone.js), Next.js 16 und Nuxt 4, jeweils am Dev-Server, als Produktions-Build über HTTPS und, wo möglich, mit `--overlay` (`node e2e/frameworks/matrix.mjs`). Offiziell unterstützt sind Windows und Linux als Host; macOS ist ungetestet. Für den Agenten `docker` erprobt ist Docker in WSL; ungeprüft ist Docker Desktop: Firewall im Container, Schreibrechte im Agent-Ordner und der Kanal über dessen Dateifreigabe.
