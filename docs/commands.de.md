[English](commands.md) · Deutsch

# Befehle

Jeder Befehl läuft im Wurzelordner deines Projekts: `npx caw <befehl>` (oder `pnpm exec`, `yarn`). `<env>` ist ein Name aus `environments` in `caw.config.json`, etwa `local`. Mandanten sind eigene Umgebungen (`extends`).

`--env` darf fehlen, wenn die Wahl klar ist: Ein Test, der auf genau eine Umgebung passt, nimmt sie; sonst auf deinem Rechner die einzige seiner Kandidaten, auf der Claude arbeiten darf (bei `record` eines neuen Tests die einzige Umgebung, auf der Claude arbeiten darf). In CI rät caw nie. Das Terminal nennt die Wahl, etwa `Umgebung: local (die einzige mit claude)`. Ist sie nicht eindeutig, bricht der Befehl ab und nennt die Auswahl (Exit 3).

| Befehl | Was er tut | Claude? |
|---|---|---|
| [`init`](#init) | Projekt einrichten: App ansehen, Config und `.mcp.json` schreiben; mit `--explore-only` nur Einstellungen vorschlagen | nein |
| [`doctor`](#doctor) | Rechner, Config, Zugangsdaten und Umgebungen prüfen | nein |
| [`overlay`](extensions/overlay.de.md) | Erweiterung: lokaler Code auf einer ausgelieferten Umgebung (nur mit einem `overlay`-Block) | nein |
| [`validate`](#validate) | Config und Tests offline prüfen | nein |
| [`list`](#list) | Tests und Schritte mit Stand der Aufnahme auflisten | nein |
| [`record`](#record) | Einen Test aufnehmen oder seine Aufzeichnung ersetzen, auch ab einem Schritt | ja |
| [`run`](#run) | Einen Test abspielen, oder mehrere für CI | nur auf Wunsch |
| [`open`](#open) | Die App angemeldet öffnen, mit Werkbank und Chat; mit Test an seinem Ende oder am Einstieg in einen Schritt | nur auf Wunsch |
| [`role`](#role) | Rollen und ihre Testnutzer auflisten, hinzufügen oder entfernen; `role login` speichert eine Sitzung (SSO) | nein |
| [`export`](#export) | Den aufgenommenen Test als Playwright-Test, der ohne caw läuft | nein |
| [`theme`](#theme) | Themes der Werkbank auflisten, wählen oder prüfen | nein |
| [`mcp`](#mcp) | MCP-Server für deine eigene Claude-Code-Sitzung (startet Claude Code, nicht in `--help`) | – |

`npx caw help` zeigt dieselbe Übersicht im Terminal. `npx caw <befehl> --help` (oder `-h`, an beliebiger Stelle) zeigt nur diesen Befehl, `npx caw agent --help` die Befehle für den Agenten. `npx caw --version` zeigt die Version.

Bricht ein Befehl ab, steht im Terminal zuerst der Grund, bei einem ungültigen Aufruf dann die Kurzform des Befehls, zuletzt Code und Exit-Code:

```
✗ create-ticket@s2: Ein Schritt steht als <test>@S<n> hinter dem Test, etwa bestellung@S3.
  Aufruf: caw record <test> [--env <umgebung>] [--role <rolle>]  oder  caw record <test>@<S4> [--env <umgebung>]
  (code: usage, exit 3)
```

Eine Option, die einen Wert braucht, nimmt nie die nächste Option als Wert: `--env --headless` bricht ab mit `--env braucht einen Wert, etwa --env local`.

## init

```bash
npx caw init --url http://localhost:5173
```

Fragt im Terminal, ob die App eine Anmeldung braucht, und öffnet sie dann in Chrome. Mit einem Testkonto anmelden (caw merkt, wenn das Anmeldeformular verschwunden ist), zur Seite gehen, auf der Tests beginnen sollen, und in der Karte unten rechts im Fenster auf **Fertig** klicken. caw erkennt Framework, Anmeldeformular und eine Marke für „angemeldet“ und legt an:

- `caw.config.json`
- `caw/.env.example` mit den Variablen für die Zugangsdaten je Rolle
- einen Eintrag `caw` in `.mcp.json` (auf die installierte Kopie, wenn caw in `node_modules` des Projekts oder eines Ordners darüber bis zur Wurzel des Repositorys liegt, sonst `npx caw-ai@<diese Version> mcp`; ein `npx`-Eintrag wird auf die installierte Kopie umgestellt, sobald es eine gibt)
- `caw/tests/` für deine Testpläne und `caw/caw.md` für Notizen, die Claude in jedem Lauf liest
- Einträge in `.gitignore` für `caw/.env`, `.caw/` und `caw/.auth/`

Was es nicht erkennen konnte, steht auf `TODO`. `doctor` listet es auf, `validate` scheitert mit Exit 3, bis es eingetragen ist. Vorhandene Dateien bleiben unberührt.

| Option | |
|---|---|
| `--url <adresse>` | Adresse der App. Ohne fragt `init` nach. |
| `--env <name>` | Name der Umgebung. Standard: `local` auf diesem Rechner, sonst der erste Teil des Hostnamens (`staging.example.com` → `staging`); ein Name, der nach Produktion aussieht, wird `production: true`. |
| `--language <code>` | Teamsprache für Pläne und Claudes Texte. Standard: die Sprache der App, erfragt. |
| `--login`, `--no-login` | Die Frage nach der Anmeldung vorab beantworten (Skripte). |
| `--yes` | Nicht aufs Anmelden warten, nichts fragen. Gut für Apps ohne Anmeldung. Mit Anmeldung meldet sich niemand an: `signedInSelector` bleibt `TODO`, `start` bleibt `/` (oder der Pfad aus `--url`). |
| `--from <datei>` | Ein vorhandenes Ergebnis von `--explore-only` nehmen, statt die App zu öffnen. Gibt es `caw/.explore.json`, nimmt `init` es von selbst. |
| `--no-mcp` | `.mcp.json` nicht anfassen. |
| `--offline` | Die App nicht öffnen: die Vorlage schreiben, die Anmeldung bleibt `TODO`. Ohne Terminal und ohne `--url` macht `init` das von selbst. |
| `--insecure-tls` | Selbstsignierte Zertifikate annehmen; an der Umgebung gespeichert. |
| `--allow-http` | Einfaches `http` zu einem anderen Rechner erlauben; an der Umgebung gespeichert. |

### Nur ansehen: `--explore-only`

```bash
npx caw init --explore-only --url http://localhost:5173
```

Sieht die App an wie `init`, schreibt aber nur Vorschläge nach `caw/.explore.json`: Framework, Anmeldeart und Selektoren, Marke für angemeldet, Startseite, Meldungen und Konsolenrauschen. Jeder Vorschlag hat `confidence: certain` oder `likely`. Die Datei übernimmt später `init --from`.

Dazu: `--yes`, `--insecure-tls` (wie bei `init`); `--login` oder `--no-login` beantworten die Frage nach der Anmeldung für Skripte.

Führt die Anmeldung zu einem Identitätsanbieter auf einem anderen Host (etwa Keycloak), meldest du dich dort wie gewohnt an. explore liest dessen Seiten und schlägt `signIn`-`steps` vor, die Benutzername und Passwort füllen (auch identifier-first und ein Einmalcode), und den Host des Anbieters in `allowHosts`; `path` ist die App-Seite, auf der die Anmeldung begann. Haben seine Seiten keine Felder, die caw füllen kann, schlägt es eine gespeicherte Sitzung vor (`type: session`, [role login](#role)).

Die Anmeldung tippst du selbst; caw liest nur den Aufbau der Seite (Felder, Selektoren), nie, was du eingibst. `init` fragt danach im Terminal nach den Rollennamen und listet ihre Variablen in `caw/.env.example`: nach `caw/.env` kopieren und die Testnutzer eintragen (siehe [role](#role)).

## doctor

```bash
npx caw doctor
npx caw doctor --agent docker
npx caw doctor --env staging
```

Prüft Node, Chrome, Claude Code (Agent `local`) oder Docker und Token (Agent `docker`), die Config, `TODO`-Werte, die Zugangsdaten je Rolle und ob jede Umgebung antwortet. Jede fehlgeschlagene Prüfung nennt den nächsten Schritt. Bei einer ungültigen Config zeigt es den ersten Befund, `validate` alle. Platzhalter-Adressen (`example.com`, `.test`, `.invalid`) meldet es, ohne sie anzufragen.

Mit der [Overlay-Erweiterung](extensions/overlay.de.md) und ExtJS-Teilen kommen optionale Zeilen zum lokalen Code-Server und zum letzten `overlay check` dazu.

## validate

```bash
npx caw validate
```

Prüft `caw.config.json` und alle Dateien in `caw/tests/` ohne Browser und ohne Claude. Fehler nennen Datei und Zeile, alle auf einmal. Gut für CI und Pre-Commit-Hooks.

Werte in `signIn`, die noch `TODO` sind, lassen die Prüfung scheitern (Exit 3, Code `config-invalid`); jeder sagt, was hineingehört.

Je Test und Umgebung nennt es, welcher Code dort läuft, etwa `smoke (staging): ausgelieferter Stand` oder `smoke (local): Dev-Server localhost:5173, dein aktueller Stand`.

## list

```bash
npx caw list
npx caw list create-ticket
```

Ohne Test: je Test eine Zeile mit Zielen, Stand der Aufnahme (`aufgenommen`, `veraltet (S2, S3)`, `nicht aufgenommen`) und ob er Daten schreibt. Mit Test: je Schritt eine Zeile, etwa `S2  Ticket anlegen  (veraltet)`. Ohne Browser und ohne Claude.

Ohne `caw.config.json` bricht es ab wie jeder andere Befehl (`config-missing`). Einen Testnamen, den es nicht gibt, beantwortet caw mit den bekannten Tests und bei einem Tippfehler mit dem nächstliegenden (`Meintest du create-ticket?`); `record <name>` bietet es nur für einen neuen Test an. Einen unbekannten Schritt mit den Schritten des Tests (`Schritte: S1–S6.`).

## record

```bash
npx caw record create-ticket --env local
```

Nimmt den Testplan aus `caw/tests/create-ticket.yaml` auf, oder legt einen neuen Test an, wenn es die Datei nicht gibt. Chrome öffnet sich mit Werkbank und Chat:

1. Du führst den Ablauf vor, oder Claude geht dem Testplan nach.
2. Claude zeigt einen Plan im Chat. Du gibst ihn frei oder schreibst, was sich ändern soll.
3. Claude geht den Ablauf durch und prüft jeden Schritt.
4. caw spielt die Aufzeichnung ohne Claude ab.
5. Du wählst „Testplan übernehmen“. Erst dann werden Dateien geschrieben.

Nur auf Umgebungen, auf denen Claude arbeiten darf (`"claude": true`). Gibt es nur eine, darf `--env` fehlen.

| Option | |
|---|---|
| `--role <rolle>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine Rolle hat. |
| `--read-only` | Nur beim ersten Aufnehmen: Der Test schreibt keine Daten (`writes: false`); schreibt er beim Aufnehmen doch, wird er `writes: true`. |
| `--overlay` | Nur mit der [Overlay-Erweiterung](extensions/overlay.de.md): lokaler Code über die ausgelieferte Umgebung |
| `--start` | Die Umgebung mit ihrem `start`-Befehl starten, wenn sie nicht antwortet, und am Ende stoppen ([Lebenszyklus](configuration.de.md#umgebung-starten-stoppen-und-zurücksetzen)). Mit `--overlay` auch die lokalen Code-Server der Teile. Ohne die Option startet caw nichts und nennt den Befehl. |
| `--reset` | Vor der Aufnahme den `reset` der Umgebung ausführen. |
| `--agent local\|docker\|session` | Wo Claude läuft. Standard: `agent.mode` aus der Config, sonst `local`. |
| `--claude-timeout <dauer>` | Zeitgrenze für Claude, Standard `60m`. |
| `--max-actions <n>` | Grenze für Claudes Browser-Aktionen, Standard `maxActions` oder 100. |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt im Prüflauf, Standard `30s`. |

### Ab einem Schritt

```bash
npx caw record create-ticket@S3 --env local
```

Nimmt den Test ab S3 bis zum Ende neu auf. Für eine gewollte Änderung der Anwendung ab dort, nachdem du den Text eines Schritts von Hand geändert hast, oder für neue Schritte am Ende. S1 und S2 laufen ohne Claude, dann folgt Claude dem alten Plan ab S3, du lenkst im Chat; eine Vorführung gibt es nicht. Ab S3 darf sich der Plan ändern: Claude kann Schritte ergänzen, entfernen, umbenennen oder umstellen. Die Schritte vor S3 und ihre Aufzeichnungen bleiben genau, wie sie sind; Schritte, die nicht mehr im Plan stehen, fallen beim Übernehmen weg. Vergleichswerte und Netzwerk-Wirkungen ab S3 lernt der nächste gesunde Lauf neu. `@S1` nimmt den ganzen Test auf, wie `record create-ticket`.

Einen Prüflauf vorher gibt es nicht: Scheitert ein Schritt an einem Fehler der Anwendung, klärst du die Ursache stattdessen mit `run`. Nur den einen gescheiterten Schritt reparierst du mit „Schritt beheben“ im Chat eines Laufs. `--role` und `--read-only` gelten hier nicht (Exit 3): Der Test behält seine Metadaten.

## run

```bash
npx caw run create-ticket --env local
```

Spielt die Aufzeichnung ab. Kein Claude, keine Token. Auf Umgebungen, auf denen Claude arbeiten darf (`claude`), steht der Chat neben der App: Schlägt ein Schritt fehl, fragst du Claude dort nach der Ursache oder lässt den Schritt gleich beheben.

Ein Lauf ändert von sich aus keine Datei. Mit `--learn` lernt er fehlende Vergleichswerte und Effekte in `caw/recordings/<test>.yaml`, in jedem Modus, auch in CI; mit Chat bietet ein bestandener Lauf, der lernen könnte, stattdessen „Baselines lernen“ auf seiner Abschlusskarte an, und nur dieser Klick schreibt. Die erste Zeile nennt Umgebung, Teamsprache und ob der Lauf lernt, etwa `Modus auf local (Teamsprache en): mit Chat; lernt: nein.` Am Ende sagt ein Lauf, der gelernt hat, was sich geändert hat, etwa `Geändert: caw/recordings/create-ticket.yaml (Vergleichswerte S2, S5)`, oder `Testdatei unverändert.` Nach einem Fehlschlag nennt er den Grund des gescheiterten Schritts (auch mit `--headless` und in CI) und die nächsten Aufrufe: einen Lauf mit Chat, der die Ursache klärt, und `open <test>@<schritt>` bis zum Einstieg in den gescheiterten Schritt. Den Bericht gibt es zusätzlich als `file://`-Link. In `report.md` stehen Schritte nach dem gescheiterten auf `skipped`, Screenshots verlinken in den Ordner `agent/` des Laufs.

| Option | |
|---|---|
| `--overlay` | Nur mit der [Overlay-Erweiterung](extensions/overlay.de.md): lokaler Code über die ausgelieferte Umgebung |
| `--start` | Wie bei `record`. |
| `--reset`, `--no-reset` | Der `reset` der Umgebung läuft einmal vor dem ersten schreibenden Test; `--reset` vor dem ersten Test, `--no-reset` nie. |
| `--explain` | Bei Fehlern oder Warnungen erklärt Claude die Ursache ungefragt. Kostet Token. |
| `--no-chat` | Sichtbares Fenster, kein Chat, kein Claude. Wie in der CI. |
| `--headless` | Kein Fenster, kein Chat. In der aufgenommenen Größe (sonst 1920×1080). |
| `--learn` | Fehlende Vergleichswerte und Effekte bestandener Schritte in `caw/recordings/` lernen. Ohne die Option lässt ein Lauf jede Datei, wie sie ist. |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt, Standard `30s`. |
| `--claude-timeout <dauer>` | Zeitgrenze für Claude beim Untersuchen und Beheben, Standard `60m`. |
| `--max-actions <n>` | Grenze für Claudes Aktionen beim Beheben. |
| `--agent local\|docker\|session` | Wie bei `record`. |

Mit gesetztem `CI` hat `run` keinen Chat und startet nie Claude, wie `--no-chat`. `record` und `open` brauchen einen Menschen und werden in CI abgelehnt (Exit 3), denn niemand übernähme den Browser. Auf Runnern ohne Bildschirm zusätzlich `--headless` angeben oder `xvfb-run` nutzen.

### Mehrere Tests (CI)

```bash
npx caw run --all --env dev --headless --report junit=caw-junit.xml
npx caw run create-ticket close-ticket --env dev
```

Spielt die Tests nacheinander ab, ohne Chat (`--explain` wird abgelehnt). `--all` nimmt jeden Test, der das Ziel nennt. Ohne `--env` gilt das einzige Ziel der Tests. Ein Test, der nicht laufen kann (Aufnahme fehlt, Tippfehler), hält die anderen nicht auf. Am Ende zeigt eine Tabelle je Test `PASS`, `FAIL`, `ERROR`, `AUFNAHME NÖTIG` oder `ABGELEHNT`. Der Exit-Code ist der des schlimmsten Laufs, in dieser Reihenfolge: `2` error > `1` fail > `4` Aufnahme nötig > `3` abgelehnt > `0` pass.

`--report junit=<datei>` schreibt die Tabelle zusätzlich als JUnit-XML (relativ zum Projektordner und darin; ein Pfad außerhalb, auch über einen Link, wird abgelehnt, bevor ein Test läuft): `fail` als `<failure>`, alles andere, was nicht bestanden hat, als `<error>`.

## open

```bash
npx caw open --env dev
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local
```

Öffnet die App angemeldet, mit Werkbank und Chat: navigieren, ausprobieren, mit Claude entwickeln. Lernt nichts und schreibt keine Testdatei.

- **Ohne Test** öffnet es die Startseite der App. Ohne `--env` nimmt es die einzige Umgebung, auf der Claude arbeiten darf.
- **`open <test>`** spielt erst den ganzen Test ab, dann gehört dir das Fenster.
- **`open <test>@S3`** hält am Einstieg in S3: S1 und S2 laufen ganz, von S3 nur die Navigation (`goto`, Klicks, Warten auf die Seite). Seine Eingaben und seine Prüfung bleiben für dich offen; das Terminal meldet `Bereit für S3 …: Navigation ausgeführt, Eingaben offen`. Hat S3 gar keine Eingaben (etwa nur ein Klick auf „Absenden“), läuft von S3 nichts; hat einer seiner Klicks in früheren Läufen Daten geschrieben, hält es vor diesem Klick; ist S3 nicht oder nicht aktuell aufgenommen, läuft davon nichts. Das Terminal nennt den Grund.

Mit Test meldet sich `open` mit der Rolle des Tests an und spielt ohne Claude ab; der Schritt, an dem es hält, wird nicht bewertet. Es läuft der ausgelieferte Stand, außer du gibst `--overlay` an.

| Option | |
|---|---|
| `--role <rolle>` | Nur ohne Test; nicht nötig, wenn die Config nur eine hat. Ein Test bringt seine mit. |
| `--start`, `--reset` | Wie bei `run` (`reset` nur mit `--reset`). |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt beim Abspielen, Standard `30s`. |
| `--agent local\|docker\|session`, `--claude-timeout <dauer>`, `--max-actions <n>` | Wie bei `record`. |

Nach der Übergabe öffnet **F1** in der Werkbank „Öffnen…“: einen beliebigen Test dieser Umgebung, optional mit Schritt. Ohne Schritt läuft der Test bis zum letzten Schritt, mit Schritt landet er an dessen Einstieg, wie `open <test>@<schritt>`. caw beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet sich mit dem Konto der Rolle des Tests neu an und spielt ihn im selben Fenster ab, ohne Claude. Bei Basic-Auth nur Tests der eigenen Rolle.

Scheitert das Herstellen an etwas, das nicht immer kommt (etwa ein Cookie-Banner, der schon weg ist), frag im Chat: Claude kann den Klick optional machen. Was du übernimmst, steht sofort in der Testdatei. Beim Aufnehmen geht das direkt mit `click <ziel> --optional`.

## role

```bash
npx caw role                          # Rollen, ob ein Testnutzer gesetzt ist (nie die Werte), Tests je Rolle
npx caw role list --json              # dasselbe als eine JSON-Zeile
npx caw role add sb                  # Rolle in die Config, ihre Variablennamen nach caw/.env.example
npx caw role remove sb                # nur wenn kein Test sie nutzt; caw/.env bleibt, wie es ist
npx caw role login sb --env dev       # signIn.type session: von Hand anmelden, Sitzung speichern
```

Eine Rolle ist ein Testnutzer. caw fragt nie nach Benutzernamen und Passwörtern, liest sie nicht aus einer Seite, schreibt und zeigt sie nicht: Du trägst sie selbst in `caw/.env` ein (oder setzt sie als CI-Secrets), unter `CAW_<ROLLE>_USER` und `CAW_<ROLLE>_PASSWORD` (`CAW_<ROLLE>_TOTP` für Einmalcodes, `__<ENV>` für ein anderes Konto auf einer Umgebung, siehe [Konfiguration](configuration.de.md#roles)). `role add` schreibt die Rolle (`{}`) in `caw.config.json`, die Variablennamen ohne Werte in `caw/.env.example` und `caw/.env` in `.gitignore` und nennt die Variablen, die du füllst. `role remove` nimmt die Rolle aus der Config und nennt ihre Zeilen, die noch in `caw/.env` stehen; löschen musst du sie selbst.

Braucht `record`, `run` oder `open` eine Rolle ohne Testnutzer, endet der Befehl, bevor Chrome oder Claude starten, mit `credentials-missing` und nennt die Variablen. Bei `signIn.type: session` gilt `role login`: Du meldest dich von Hand an, caw speichert die Sitzung, nie ein Passwort.

`role login` ist für `signIn.type: session` (SSO, OAuth, MFA, die sich nicht automatisieren lassen). Es öffnet Chrome auf der Anmeldung, du meldest dich von Hand an. Sobald `signedInSelector` erscheint, speichert caw Cookies und Storage in `caw/.auth/<env>/<rolle>.json`. Erneut ausführen, wenn die Sitzung abläuft.

## export

```bash
npx caw export bestellung --env ci
npx playwright test -c caw/export/playwright
```

Schreibt den aufgenommenen Test als Playwright-Test, der ohne caw läuft, nur mit `@playwright/test`, nach `caw/export/playwright/` (`--out <ordner>` für einen anderen Ordner):

| Datei | |
|---|---|
| `<test>.spec.mjs` | Ein `test()`, ein `test.step()` je caw-Schritt. Die Locators sind die aufgenommenen; Prüfungen werden zu `expect.poll`, eine Dialog-Entscheidung wird rund um die Aktion beantwortet, die den Dialog öffnet, `remember` und die Platzhalter `{{runTag}}`/Datum werden je Lauf gefüllt |
| `caw-support.mjs` | Anmeldung aus `signIn` (Formular, Schritte, Basic, gespeicherte Sitzung, TOTP), Warten auf eine ruhige Seite wie caw, Upload, Download, Auswahl in `<select>`; bei ExtJS die Engine `extjs=`. Jeder Export überschreibt sie |
| `playwright.config.mjs` | Basis-URL, Sprache, Zeitzone und Viewport der Aufnahme, Chrome, `trace: 'off'`. Nur geschrieben, wenn sie fehlt; danach gehört sie dir. Der Trace ist aus, weil die Anmeldung Passwort und Einmalcode des Testnutzers einträgt und ein Playwright-Trace sie im Klartext behält (caw bereinigt seine eigenen Traces, Playwright nicht). Schalte ihn nur ein, wo das in Ordnung ist, und lade so einen Trace nie hoch |

Die Umgebung (`--env`, sonst die einzige passende) liefert Adresse und Anmeldung. Beim Ausführen überschreibt `CAW_BASE_URL` die Adresse; die Testnutzer kommen aus denselben Variablen wie bei caw (`CAW_<ROLLE>_USER`, `CAW_<ROLLE>_PASSWORD`, `CAW_<ROLLE>_TOTP`, wahlweise mit `__<ENV>`). Eine Datei im Ordner, die nicht von export stammt, wird nie überschrieben.

Nicht exportiert: gelernte Wirkungen und Netzwerk-Vergleichswerte, `knownMessages`, die Fehlerregeln für Konsole und Requests, `retry`, `readyIgnore` und die 2-s-Toleranz für einen zweiten Treffer, während ein Dialog schließt. Der Test muss vollständig und aktuell aufgenommen sein, sonst Exit 4 mit dem passenden `record`-Befehl.

## theme

```bash
npx caw theme                 # Themes auflisten, aktives markiert
npx caw theme use raster      # eines wählen
npx caw theme mode light      # hell oder dunkel
npx caw theme check mein-theme  # Schema, Kontrast, Markenbreite, Schriften
```

Das Theme gehört dir, steht in `prefs.json` und gilt in allen Projekten. Eingebaut: `studio` (Standard), `terminal`, `raster`, `glas`, jedes mit dunklem und hellem Modus (`mode`, Standard dunkel). Theme und Modus wählst du mit F7 in der Werkbank; eigene Themes sind Ordner neben `prefs.json`, von Hand geschrieben. Details: [themes/README.de.md](../themes/README.de.md).

## mcp

Startet Claude Code über `.mcp.json` (`claude mcp add caw --scope project -- npx caw-ai mcp`). Du rufst es nicht selbst auf. Der Server heißt `caw`; beim Start sagt er Claude, wofür caw da ist und dass es zuerst `caw_guide` liest. Deine Sitzung bekommt diese Tools:

| Tool | | Tokens |
|---|---|---|
| `caw_guide` | Die Anleitung je Thema (`topic`); ohne Thema die Übersicht. `overlay` und `extjs` nur, wenn das Projekt sie nutzt | nein |
| `caw_doctor` | `doctor` als Daten (`agent`, `env`) | nein |
| `caw_init` | `mode: explore` (`url`, `login` oder `yes`): das Fenster, wartet und liefert die Vorschläge (`wait: false` startet nur); `mode: write` (`fromExplore`) und `mode: offline` schreiben die Dateien; `env`, `language`, `insecureTls`, `allowHttp`, `roles`, `noMcp` | nein |
| `caw_role` | Rollen als Daten (`list`), eine neue in der Config mit ihren Variablennamen (`add`, `name`; `caw/.env` füllt der Mensch), eine gespeicherte Sitzung (`login`), `remove`; nie Benutzernamen oder Passwörter | nein |
| `caw_config` | Config lesen oder geprüft ändern (`patch`, `dryRun`). Ein Patch, der den `overlay`-Block hinzufügt oder entfernt, ändert die Tool-Liste. Abgelehnt: Befehle (`start`, `stop`, `reset`, `ready`, `lintCommand`, Overlay-`start`), Umgebungs-Schalter, `browser.executablePath`, `sandboxImage`, `sandboxUser`, `agent.mode`; die ändert die Session in der Datei, wo du den Diff siehst | nein |
| `caw_validate` | `validate` als Daten | nein |
| `caw_list` | `list` als Daten | nein |
| `caw_overlay` | Nur mit `overlay`-Block: `action: status` (`overlay status` im Prozess, schnell), `check` oder `apply` (`overlay check`, `--apply`; wartet bis zu 3 Minuten); `env`, `part` | nein |
| `caw_start` | `run`, `record` oder `open` mit `--agent session` starten (`test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset` oder `args`; `step` bei `record` und `open`, nur mit `test`). Mit `overlay` prüft es zuerst den lokalen Code-Server: `down`, `wrong-app` oder `stale` liefert `state`, `url`, `start` und `partDir`, statt zu starten; `moved` startet mit `--overlay <foundUrl>`. Nie `--start` zusammen mit `overlay`: Die Session startet den lokalen Code-Server selbst, nachdem sie dich gefragt hat. `start` und `reset` führen die konfigurierten Befehle der Umgebung aus | nur deine Session |
| `caw_status` | Wartet ein Lauf auf die Sitzung? Letzte Zeilen der Ausgabe; Ergebnis und Artefakte des letzten Laufs als Daten. `wait` (bis 120 s) antwortet, sobald der Lauf die Sitzung braucht, endet oder etwas Neues meldet | nein |
| `caw` | Die Agenten-Befehle (`snapshot`, `click`, `plan`, `finish`, …) | im Lauf |
| `caw_selection` | Das Element, das du mit dem Fadenkreuz in der Werkbank gewählt hast | nein |

Ergebnisse kommen als kurzer Text plus `structuredContent` (JSON).

## Agenten-Befehle

`caw agent <befehl>` mit `snapshot`, `click`, `dblclick`, `hover`, `drag`, `dialog`, `fill`, `type`, `press`, `upload`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

Nur über diese Befehle kann Claude den Browser bedienen. Sie sind für den Agenten während `record` und im Chat da; du brauchst sie nicht. `npx caw agent --help` listet ihre Argumente.

## Exit-Codes

| Code | |
|---|---|
| `0` | bestanden |
| `1` | fehlgeschlagen: Die App tut nicht, was der Test erwartet |
| `2` | Fehler: Die Umgebung hat ein Urteil verhindert (Server aus, Anmeldung fehlgeschlagen, Chrome fehlt, …), oder ein unerwarteter interner Fehler (der Stack steht in der Ausgabe) |
| `3` | abgewiesen: Aufruf, Config (auch `TODO`-Werte aus `init`) oder Testdatei ungültig. Es lief nichts. |
| `4` | Aufnahme nötig: Die Aufzeichnung fehlt (`record`) oder ein Schritt hat sich seit der Aufnahme geändert (`record <test>@<schritt>`). Es lief nichts. |

## Umgebungsvariablen

| Variable | |
|---|---|
| `CAW_LANG` | `en` oder `de`: deine eigene Sprache für caws Texte (CLI, Werkbank) statt der Teamsprache (`language` in der Config). Claude schreibt Pläne weiter in der Teamsprache. |
| `CAW_AI_HOME` | Ordner für persönliche Einstellungen (`prefs.json`). Standard `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` oder `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API-Schlüssel aus der Claude Console für den Agenten `docker`. `local` und `session` nutzen deine Claude-Code-Anmeldung. |
| `CAW_CLAUDE_MODEL`, `CAW_CLAUDE_BUDGET` | Modell und Budget in US-Dollar für Claude-Läufe (`--model`, `--max-budget-usd`); überschreiben `agent.model` und `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Nur Windows: `windows` oder `wsl` legt den Weg zu Docker fest. |
| `CI` | Gesetzt: kein Chat, nur Agent `docker`; `record` und `open` werden abgelehnt. |
| `NO_COLOR`, `FORCE_COLOR` | Farben im Terminal aus oder an. |
| `MCP_TOOL_TIMEOUT` | In der Umgebung von Claude Code: erhöhen, wenn `plan` oder `chat` in deiner Sitzung abbrechen. |

## Fehlercodes

Bricht caw ab oder endet ein Lauf mit `error`, nennt es zuerst den Grund und danach den Code.

| Code | Exit | Abhilfe |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw <befehl> --help` |
| `config-missing` | 3 | `npx caw init --url <adresse>` |
| `config-invalid` | 3 | Das genannte Feld korrigieren oder die `TODO`-Werte eintragen, dann `doctor` |
| `test-missing`, `test-invalid` | 3 | Testdatei anlegen oder korrigieren, dann `validate` |
| `replay-missing` | 4 | Test mit `record` aufnehmen |
| `replay-stale` | 4 | Ein Schritt hat sich seit der Aufnahme geändert: `record <test>@<schritt>` |
| `step-unknown` | 3 | Eine Schritt-ID aus der Testdatei nehmen (`list <test>`) |
| `env-invalid`, `env-denied` | 3 | Eine Umgebung aus der Config nehmen; Produktion lässt sich nicht aufnehmen |
| `host-blocked` | 3 | `goto` zu einem Host, der kein Host der Anwendung ist: in `allowHosts` eintragen, wenn die Anwendung wirklich dorthin navigiert. In einem Lauf ist dieselbe Sperre ein Fehler des Schritts |
| `env-certificate` | 2 | Dem Zertifikat der Umgebung wird nicht vertraut: bei einer internen Zertifizierungsstelle `environments.<env>.insecureTls: true` setzen |
| `write-protected` | 3 | Aufnehmen und schreibende Tests brauchen `claude` / `writable` an der Umgebung |
| `auth-missing` | 3 | Keine gespeicherte Sitzung, oder sie ist abgelaufen: `caw role login <rolle> --env <env>` (die Meldung nennt ihn) |
| `credentials-missing` | 2 | Die genannten Variablen in `caw/.env` oder in der Umgebung setzen (CI-Secrets); eine neue Rolle vorher mit `role add <rolle>` |
| `login-form-missing`, `login-failed` | 2 | Läuft das Backend? Stimmen Selektoren oder Schritte in `signIn` und die Zugangsdaten? |
| `env-unreachable` | 2 | Umgebung starten (oder `--start` angeben, wenn sie einen `start`-Befehl hat), Adresse prüfen |
| `env-start-failed` | 2 | Der `start` der Umgebung endete mit Fehler: siehe Log-Ende und `.caw/env/<env>-start.log` |
| `env-not-ready` | 2 | `ready` antwortete nicht rechtzeitig unter 500: `ready.timeoutMs` erhöhen oder den `start`-Befehl prüfen |
| `env-reset-failed` | 2 | Der `reset` der Umgebung scheiterte oder dauerte länger als 10 Minuten; kein Test lief. Siehe `.caw/env/<env>-reset.log` |
| `app-not-loaded`, `app-not-settled` | 2 | Seite von Hand öffnen, Konsole ansehen |
| `browser-missing` | 2 | Google Chrome installieren oder `browser` in der Config setzen |
| `claude-missing` | 2 | Claude Code installieren und anmelden, oder `--agent docker` |
| `token-missing` | 2 | `ANTHROPIC_API_KEY` setzen oder `--agent local` nutzen |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Docker mit Linux-Containern starten, oder `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Anmeldung an der Registry und `sandboxImage` prüfen |
| `sandbox-path` | 2 | Ein Projektpfad mit Komma, Anführungszeichen oder Zeilenumbruch (oder einem Doppelpunkt in einem Ordner, den die Sandbox ausblendet) lässt sich nicht sicher einbinden: umbenennen oder `--agent local` nehmen |
| `aborted` | 2 | Du hast das Fenster geschlossen oder Strg+C gedrückt |
| `chat-failed`, `no-session` | 2 | Neu starten |
| `chat-tampered` | 2 | Die getestete Seite hat den Chat-Rahmen neu geladen oder seine Sandbox entfernt; der Lauf endete, damit keine Entscheidung von dort kommt. Such das Skript der Anwendung, das `top.document` anfasst |
