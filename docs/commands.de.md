[English](commands.md) · Deutsch

# Befehle

Jeder Befehl läuft im Wurzelordner deines Projekts: `npx caw <befehl>` (oder `pnpm exec`, `yarn`). `<env>` ist ein Name aus `environments` in `caw.config.json`, etwa `local`. Mandanten sind eigene Umgebungen (`extends`).

`--env` darf fehlen, wenn die Wahl klar ist: Ein Test, der auf genau eine Umgebung passt, nimmt sie; sonst auf deinem Rechner die einzige seiner Kandidaten, auf der Claude arbeiten darf (bei `record` eines neuen Tests die einzige Umgebung, auf der Claude arbeiten darf). In CI rät caw nie. Das Terminal nennt die Wahl, etwa `Umgebung: local (die einzige, auf der Claude Code arbeiten darf)`. Ist sie nicht eindeutig, bricht der Befehl ab und nennt die Auswahl (Exit 3).

| Befehl | Was er tut | Claude? |
|---|---|---|
| [`init`](#init) | Projekt einrichten: App ansehen, Config und `.mcp.json` schreiben; mit `--explore-only` nur Einstellungen vorschlagen | nein |
| [`doctor`](#doctor) | Rechner, Config, Zugangsdaten und Umgebungen prüfen | nein |
| [`overlay`](extensions/overlay.de.md) | Erweiterung: lokaler Code auf einer ausgelieferten Umgebung (nur mit einem `overlay`-Block) | nein |
| [`validate`](#validate) | Config und Tests offline prüfen | nein |
| [`audit`](#audit) | Auflisten, was die Tests seit einem Branch oder Commit abschwächt, für den PR | nein |
| [`bisect`](#bisect) | Ein Schritt von `git bisect run`: den Commit finden, der einen Test kaputt gemacht hat | nein |
| [`list`](#list) | Tests und Schritte mit Stand der Aufnahme auflisten | nein |
| [`record`](#record) | Einen Test aufnehmen oder seine Aufzeichnung ersetzen, auch ab einem Schritt | ja |
| [`run`](#run) | Einen Test abspielen, oder mehrere für CI | nur auf Wunsch |
| [`open`](#open) | Die App öffnen, mit Werkbank und Chat; mit Test an seinem Ende oder am Einstieg in einen Schritt | nur auf Wunsch |
| [`reproduce`](#reproduce) | Claude stellt einen Fehlerbericht allein nach: Bericht und, wenn nachgestellt, ein Entwurf in `caw/drafts` | ja |
| [`role`](#role) | Rollen und ihre Testnutzer auflisten, hinzufügen oder entfernen; `role login` speichert eine Sitzung (SSO) | nein |
| [`skill`](#skill) | Den Claude-Code-Skill `caw-attach` für deine eigene Session schreiben oder aktualisieren | nein |
| [`export`](#export) | Den aufgenommenen Test als Playwright-Test, der ohne caw läuft | nein |
| [`mcp`](#mcp) | MCP-Server für deine eigene Claude-Code-Sitzung (startet Claude Code, nicht in `--help`) | – |

`npx caw help` zeigt dieselbe Übersicht im Terminal. `npx caw <befehl> --help` (oder `-h`, an beliebiger Stelle) zeigt nur diesen Befehl, `npx caw agent --help` die Befehle für den Agenten. `npx caw --version` zeigt die Version.

Bricht ein Befehl ab, steht im Terminal zuerst der Grund, bei einem ungültigen Aufruf dann die Kurzform des Befehls, zuletzt Code und Exit-Code:

```
✕ create-ticket@s2: Ein Schritt steht als <test>@S<n> hinter dem Test, etwa bestellung@S3.
  Aufruf: caw record <test> [--env <name>] [--role <rolle>]  oder  caw record <test>@<S4> [--env <name>] [--agent local|docker | --attach [<key>]]
  (code: usage, exit 3)
```

Eine Option, die einen Wert braucht, nimmt nie die nächste Option als Wert: `--env --headless` bricht ab mit `--env braucht einen Wert, etwa --env local`.

## init

```bash
npx caw init --url http://localhost:5173
```

Fragt im Terminal, ob die App eine Anmeldung braucht, und öffnet sie dann in Chrome. Mit einem Testkonto anmelden (caw merkt, wenn das Anmeldeformular verschwunden ist), zur Seite gehen, auf der Tests beginnen sollen, und in der Karte „caw explore“ unten rechts im Fenster auf **Fertig** klicken. Die Karte zeigt den Schritt als Badge („2 · Startseite“) und im Startschritt die Seite, die sie nimmt („SEITE /todos“); ein Klick auf ihren Kopf klappt sie ein. caw erkennt Framework, Anmeldeformular und eine Marke für „angemeldet“ und legt an:

- `caw.config.json`
- `caw/.env.example` mit den Variablen für die Zugangsdaten je Rolle
- einen Eintrag `caw` in `.mcp.json` (auf die installierte Kopie, wenn caw in `node_modules` des Projekts oder eines Ordners darüber bis zur Wurzel des Repositorys liegt, sonst `npx caw-ai@<diese Version> mcp`; ein `npx`-Eintrag wird auf die installierte Kopie umgestellt, sobald es eine gibt)
- `caw/tests/` für deine Testpläne und `caw/caw.md` für Notizen, die Claude in jedem Lauf liest
- `.claude/skills/caw-attach/SKILL.md`, der Skill für deine eigene Claude-Code-Session (siehe [`skill`](#skill))
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
| `--no-mcp` | `.mcp.json` nicht anfassen und den Skill nicht schreiben. |
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
npx caw doctor --attach
npx caw doctor --env staging
```

Prüft Node, Chrome, Claude Code (Agent `local`) oder Docker und Token (Agent `docker`) oder mit `--attach` den caw-Eintrag in `.mcp.json`, den deine eigene Session braucht, dann den Skill `caw-attach`, die Config, `TODO`-Werte, die Zugangsdaten je Rolle und ob jede Umgebung antwortet. Jede fehlgeschlagene Prüfung nennt den nächsten Schritt. Bei einer ungültigen Config zeigt es den ersten Befund, `validate` alle. Platzhalter-Adressen (`example.com`, `.test`, `.invalid`) meldet es, ohne sie anzufragen.

Mit der [Overlay-Erweiterung](extensions/overlay.de.md) und ExtJS-Teilen kommen optionale Zeilen zum lokalen Code-Server und zum letzten `overlay check` dazu.

## validate

```bash
npx caw validate
```

Prüft `caw.config.json` und alle Dateien in `caw/tests/` ohne Browser und ohne Claude. Fehler nennen Datei und Zeile, alle auf einmal. Gut für CI und Pre-Commit-Hooks.

Werte in `signIn`, die noch `TODO` sind, lassen die Prüfung scheitern (Exit 3, Code `config-invalid`); jeder sagt, was hineingehört.

Je Test und Umgebung nennt es, welcher Code dort läuft, etwa `smoke (staging): ausgelieferter Stand` oder `smoke (local): Dev-Server localhost:5173, dein aktueller Stand`.

## audit

```bash
npx caw audit origin/main
npx caw audit origin/main --json
```

Kein Test wird unbemerkt schwächer. caw selbst hält eine Prüfung fest, solange ihr erwartetes Ergebnis bleibt, aber ein Chat-Button, ein übernommener Rat oder eine Änderung von Hand kann einen Test trotzdem abschwächen. `audit` vergleicht die Testdaten (`caw/tests`, `caw/recordings`, `caw.config.json`) an der Merge-Base von `<ref>` und `HEAD` mit deinem Arbeitsstand und gibt die Änderungen als Markdown in der Teamsprache aus, fertig für einen PR-Kommentar. Kein Browser, kein Claude; nötig sind `git` im `PATH` und in CI die Geschichte (`fetch-depth: 0`).

**Abgeschwächt** (Exit 1):

- eine Prüfung hat sich geändert, obwohl das erwartete Ergebnis ihres Schritts gleich blieb (zugeordnet über das erwartete Ergebnis wie bei der Aufnahme: ein nur verschobener Schritt ist in Ordnung)
- ein Test oder ein Schritt entfernt; eine Test- oder Aufnahmedatei, die nicht lesbar ist (`validate` sagt, warum)
- der Test läuft auf weniger Umgebungen (`environments`, auch gegenüber dem Standard der Config)
- `retry` neu oder erhöht; `timeoutMs` eines Schritts oder einer Aktion erhöht (über 30 s, wenn es keins gab)
- eine Aktion `optional` gemacht
- `knownMessages` ergänzt
- gelernte Effekte: Zeilen aus einer Liste in `effects.fail` entfernt (Standard `controls`, `console`), neue Konsolenzeilen übernommen oder die gelernten Effekte ganz verworfen (sie werden neu gelernt); nur solange die Aktionen des Schritts gleich bleiben, ein neu aufgenommener Schritt lernt seine Effekte neu
- Config: Einträge in `consoleIgnore`, `foreignCode` oder `reads` ergänzt, `messageSelectors` beobachten weniger, `effects.fail` enger, ein geschützter Schlüssel geändert (Befehle und Schalter der Umgebungen, `lintCommand`, `anonymize`, `sandboxImage`, `sandboxUser`, `browser.executablePath`, `agent.mode`)

**Geändert** (aufgelistet, keine Abschwächung): ein geändertes erwartetes Ergebnis, mit seiner Prüfung; neue Tests und Schritte; das Ziel einer Aktion getauscht, während Aktionen und gelernte Wirkung des Schritts blieben (ein übernommener Vorschlag für ein umbenanntes Element, siehe [Handbuch](guide.de.md#umbenannte-ziele)); für ein Aussehen neu eingefrorene Daten, mit der Art der Speicherung, und ein Aussehen, das nicht mehr auf festen Daten verglichen wird ([feste Daten](test-files.de.md#feste-daten): die Datei auf personenbezogene Daten prüfen). Das erwartete Ergebnis zu ändern ist der Weg, eine Prüfung bewusst zu ändern: Wer den PR prüft, sieht dann beides. **Zur Info:** geänderte Request-Baselines, gelernte Effekte aus Listen, die nur warnen.

Exit `0` nichts abgeschwächt, `1` abgeschwächt, `3` die Ref ist unbekannt, hat keine gemeinsame Geschichte mit `HEAD` (`git-ref`) oder es gibt kein Git (`git-missing`). `--json` gibt `{ ref, base, weakened, findings }` aus, jeder Befund mit `id`, `kind`, `severity` (`weakening`, `listed`, `info`), `test` (`null` für die Config), `step`, `before`, `after` und `text`.

## bisect

```bash
git bisect start <schlecht> <gut>
git bisect run npx -p caw-ai@<version> caw bisect <test> --env <umgebung>
git bisect reset
```

Findet den Commit, der einen Test kaputt gemacht hat. `git bisect run` checkt einen Commit nach dem anderen aus und ruft auf jedem `caw bisect` auf. Dabei wird auch `caw/` ausgecheckt, der Test des alten Commits wäre also ein anderer oder fehlte: Test, Aufzeichnung und `caw.config.json` kommen aus `--tests-from <ref>` (Standard `refs/bisect/bad`, der Commit, den `git bisect start` als schlecht bekam). Dort muss der Test aufgenommen sein; offene Schritte an seinem Ende bleiben wie bei `run` weg.

Auf jedem Commit startet `caw bisect` die Umgebung mit ihrem `start`-Befehl (damit sie den Code dieses Commits ausführt), spielt den Test ohne Fenster und Chat ab und hält die Umgebung wieder an. Es lernt nichts, damit der Arbeitsstand für den nächsten Checkout sauber bleibt, und gelernte Effekte lassen keinen Schritt scheitern: Sie wurden an einer anderen Version der Anwendung gelernt. Pro Commit gibt es eine Zeile aus, z. B. `caw bisect 3f2a1c9: gescheitert bei S3, Einschätzung Fehler der Anwendung, Exit 1 (schlecht)`.

| Exit | Für git bisect | Wann |
|---|---|---|
| `0` | gut | Der Test hat bestanden. |
| `1` | schlecht | Ein Schritt ist gescheitert, und caw schreibt es der Anwendung zu. |
| `125` | überspringen | Ein Schritt scheiterte an Umgebung oder Test oder unklar; die Umgebung startete nicht (z. B. baut der Commit nicht); jeder andere Fehler |
| `128` | bricht ab | Der Aufruf oder Test oder Config an der Ref sind ungültig; der Test ist dort nicht aufgenommen oder wurde nach der Aufnahme geändert; die Umgebung hat kein `start` oder antwortet schon, bevor caw sie startet (das könnte der Build eines beliebigen Commits sein: erst anhalten) |

Ruf caw aus einer festen Installation auf, wie es `npx -p caw-ai@<version>` tut: Das `node_modules` des Projekts ändert sich von Commit zu Commit, und ein alter Commit hat vielleicht kein caw oder eine andere Version. `--step-timeout <dauer>` begrenzt jeden Schritt (Standard 30s). Fehler enden nie mit Exit 2, das `git bisect` als schlecht lesen würde.

## list

```bash
npx caw list
npx caw list create-ticket
```

Ohne Test: je Test eine Zeile mit Zielen, Stand der Aufnahme (`aufgenommen`, `offen (S4, S5)`, `veraltet (S2, S3)`, `nicht aufgenommen`) und ob er Daten schreibt. Mit Test: je Schritt eine Zeile, etwa `S2  Ticket anlegen  (veraltet)` oder `S4  Export  (offen)`. [Offen](test-files.de.md#offene-schritte) ist das nicht aufgenommene Ende nach dem letzten aufgenommenen Schritt. Ohne Browser und ohne Claude.

Entwürfe aus [`reproduce`](#reproduce) in `caw/drafts` folgen in einer eigenen Tabelle, mit `rot bei S3 (Lauf …)`, sobald ein Lauf
belegt hat, dass sie scheitern, solange der Fehler da ist, sonst `aufgenommen, noch nicht rot`; `list <entwurf>` zeigt seine
Schritte wie die eines Tests.

Ohne `caw.config.json` bricht es ab wie jeder andere Befehl (`config-missing`). Einen Testnamen, den es nicht gibt, beantwortet caw mit den bekannten Tests und bei einem Tippfehler mit dem nächstliegenden (`Meintest du create-ticket?`); `record <name>` bietet es nur für einen neuen Test an. Einen unbekannten Schritt mit den Schritten des Tests (`Schritte: S1–S6.`).

## record

```bash
npx caw record create-ticket --env local
```

Nimmt den Testplan aus `caw/tests/create-ticket.yaml` auf, oder legt einen neuen Test an, wenn es die Datei nicht gibt. Ein
Entwurf aus [`reproduce`](#reproduce) (`caw/drafts/<id>.yaml`) wird genauso aufgenommen und bleibt in seiner einen Datei; sein
letzter Schritt muss scheitern, solange der Fehler da ist ([vom Fehler zum belegten Fix](guide.de.md#vom-fehler-zum-belegten-fix)). Chrome öffnet sich mit Werkbank und Chat:

1. Du führst den Ablauf vor, oder Claude geht dem Testplan nach.
2. Claude zeigt einen Plan im Chat. Du gibst ihn frei oder schreibst, was sich ändern soll.
3. Claude geht den Ablauf durch und prüft jeden Schritt.
4. caw spielt die Aufzeichnung ohne Claude ab.
5. Du wählst „Testplan übernehmen“. Erst dann werden Dateien geschrieben.

Nur auf Umgebungen, auf denen Claude arbeiten darf (`"agent": true`). Gibt es nur eine, darf `--env` fehlen.

| Option | |
|---|---|
| `--role <rolle>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine Rolle hat. |
| `--read-only` | Nur beim ersten Aufnehmen: Der Test schreibt keine Daten (`writes: false`); schreibt er beim Aufnehmen doch, wird er `writes: true`. |
| `--overlay` | Nur mit der [Overlay-Erweiterung](extensions/overlay.de.md): lokaler Code über die ausgelieferte Umgebung |
| `--start` | Die Umgebung mit ihrem `start`-Befehl starten, wenn sie nicht antwortet, und am Ende stoppen ([Lebenszyklus](configuration.de.md#umgebung-starten-stoppen-und-zurücksetzen)). Mit `--overlay` auch die lokalen Code-Server der Teile. Ohne die Option startet caw nichts und nennt den Befehl. |
| `--reset` | Vor der Aufnahme den `reset` der Umgebung ausführen. |
| `--agent local\|docker` | Wo caw seinen Agenten startet. Standard: `agent.mode` aus der Config, sonst `local`. |
| `--attach [<key>]` | Stattdessen antwortet deine eigene Claude-Code-Session, ohne zusätzliche Token, nach `/caw-attach` dort (siehe [Leitfaden](guide.de.md#aus-claude-code-steuern)). Ohne `<key>` die einzige zuhörende Session; bei mehreren wählst du eine mit ihrem Schlüssel (`k7f2`) oder dem Anfang ihrer Session-ID. Das Fenster wartet, solange keine zuhört, und meldet „Nicht verbunden“, wenn sie geht. |
| `--agent-timeout <dauer>` | Zeitgrenze für Claude, Standard `60m`. |
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

Spielt die Aufzeichnung ab. Kein Claude, keine Token. Auf Umgebungen, auf denen Claude arbeiten darf (`agent`), steht der Chat neben der App: Schlägt ein Schritt fehl, fragst du Claude dort nach der Ursache oder lässt den Schritt gleich beheben.

Außerhalb von CI lernt jeder Lauf die fehlenden Vergleichswerte und Effekte seiner bestandenen Schritte in `caw/recordings/<test>.yaml`, headless wie im Fenster, wo der Chat sagt, welche Schritte sie bekommen haben. In CI (`CI` gesetzt) ändert ein Lauf keine Datei, außer du gibst `--learn` an. Die erste Zeile nennt Umgebung, Teamsprache und ob der Lauf lernt, etwa `Modus auf local (Teamsprache en): mit Chat; lernt: ja, fehlende Vergleichswerte und Effekte in caw/recordings/create-ticket.yaml.` Am Ende sagt ein Lauf, der gelernt hat, was sich geändert hat, etwa `Geändert: caw/recordings/create-ticket.yaml (Vergleichswerte S2, S5)`, oder `Testdatei unverändert.` Nach einem Fehlschlag nennt er den Grund des gescheiterten Schritts (auch mit `--headless` und in CI) und die nächsten Aufrufe: einen Lauf mit Chat, der die Ursache klärt, und `open <test>@<schritt>` bis zum Einstieg in den gescheiterten Schritt. Den Bericht gibt es zusätzlich als `file://`-Link. In `report.md` stehen Schritte nach dem gescheiterten auf `skipped`, Screenshots verlinken in den Ordner `agent/` des Laufs. `result.json` führt unter `steps` jeden Schritt: seinen Status (`pass`, `fail`, `skipped`), warum er scheiterte (`kind`: `check`, `effect`, `target`, `state`, `external`), seine Zeit in Sekunden, seine Requests und die Effekte seiner Aktionen mit einer Abweichung von den gelernten; auf Produktion ohne die Effekte, da sie sichtbare Namen zeigen.

Ein Test, der mit [offenen Schritten](test-files.de.md#offene-schritte) endet (geschrieben, noch nicht aufgenommen), spielt seine aufgenommenen Schritte ab und besteht ohne sie: Das Terminal endet mit `Offen, noch nicht aufgenommen: S4, S5. Sie liefen nicht. Nimm sie auf: caw record <test>@S4 --env <env>`, `report.md` nennt sie unter den Ergebnissen, `result.json` führt sie unter `pending` und unter `steps` mit `status: "pending"`, die Werkbank zeigt sie als nicht erreicht. Mit `--strict` hält so ein Test, bevor etwas läuft (Exit 4, `replay-pending`). Ein nicht aufgenommener Schritt vor einem aufgenommenen, ein nach der Aufnahme geänderter Schritt und ein Test ohne jede Aufnahme enden wie bisher mit Exit 4.

| Option | |
|---|---|
| `--overlay` | Nur mit der [Overlay-Erweiterung](extensions/overlay.de.md): lokaler Code über die ausgelieferte Umgebung |
| `--start` | Wie bei `record`. |
| `--reset`, `--no-reset` | Der `reset` der Umgebung läuft einmal vor dem ersten schreibenden Test; `--reset` vor dem ersten Test, `--no-reset` nie. |
| `--explain` | Bei Fehlern oder Warnungen erklärt Claude die Ursache ungefragt. Kostet Token. |
| `--no-chat` | Sichtbares Fenster, kein Chat, kein Claude. Wie in der CI. |
| `--headless` | Kein Fenster, kein Chat. In der aufgenommenen Größe (sonst 1920×1080). |
| `--learn` | In CI: fehlende Vergleichswerte und Effekte bestandener Schritte in `caw/recordings/` lernen. Außerhalb von CI tut das jeder Lauf ohnehin. |
| `--promote` | Nur für einen Entwurf in `caw/drafts`: siehe [Einen Entwurf übernehmen](#einen-entwurf-übernehmen). |
| `--strict` | Offene Schritte lassen den Lauf mit Exit 4 scheitern, statt dass er ohne sie besteht, etwa in einer Release-Pipeline. |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt, Standard `30s`. |
| `--agent-timeout <dauer>` | Zeitgrenze für Claude beim Untersuchen und Beheben, Standard `60m`. |
| `--max-actions <n>` | Grenze für Claudes Aktionen beim Beheben. |
| `--agent local\|docker`, `--attach [<key>]` | Wie bei `record`. |

Mit gesetztem `CI` hat `run` keinen Chat und startet nie Claude, wie `--no-chat`. `record` und `open` brauchen einen Menschen und werden in CI abgelehnt (Exit 3), denn niemand übernähme den Browser. Auf Runnern ohne Bildschirm zusätzlich `--headless` angeben oder `xvfb-run` nutzen.

### Einen Entwurf übernehmen

```bash
npx caw run bug-search-finds-nothing --promote --env local
```

Ein Entwurf aus [`reproduce`](#reproduce), der rot aufgenommen wurde (sein Feld `red`) und jetzt besteht, wird ein Test. caw spielt
den Entwurf ab; besteht er, alle anderen Tests auf derselben Umgebung (`run --all`); erst wenn beides grün ist, wandert der Test
nach `caw/tests` und `caw/recordings` (ohne `red`), der Entwurf wird gelöscht, und der Laufordner des Entwurfs bekommt
`fix-report.md`: rot bei welchem Schritt (Lauf, Commit), grün in welchem Lauf, die seit dem roten Commit geänderten Dateien
(`git diff --name-only` plus neue Dateien, ohne `caw/` und `.caw/`) und wie viele andere Tests bestanden haben. Ein Test gleichen
Namens wird nie überschrieben (Exit 3).

Exit-Codes: `0` übernommen, `1` der Entwurf oder ein anderer Test hat nicht bestanden, `4` der Entwurf ist nicht ganz aufgenommen
oder war nie rot. `--promote` nimmt einen Entwurf, nicht mit `--all`, `--report` oder `--retry-env` (Exit 3). Entwürfe gehören nie
zu `--all`.

### Mehrere Tests (CI)

```bash
npx caw run --all --env dev --headless --report junit=out/caw-junit.xml --report summary=out/summary.md --retry-env 1
npx caw run create-ticket close-ticket --env dev
```

Spielt die Tests nacheinander ab, ohne Chat (`--explain` wird abgelehnt). `--all` nimmt jeden Test, der das Ziel nennt. Ohne `--env` gilt das einzige Ziel der Tests. Ein Test, der nicht laufen kann (Aufnahme fehlt, Tippfehler), hält die anderen nicht auf. Am Ende zeigt eine Tabelle je Test `PASS`, `FAIL`, `ERROR`, `AUFNAHME NÖTIG` oder `ABGELEHNT`. Der Exit-Code ist der des schlimmsten Laufs, in dieser Reihenfolge: `2` error > `1` fail > `4` Aufnahme nötig > `3` abgelehnt > `0` pass.

Ein Test mit offenen Schritten besteht und zeigt in der Tabelle `S4–S5 offen` (mit `--strict` ist er `AUFNAHME NÖTIG`).

Ein gescheiterter Schritt endet mit `1`, egal wie caw ihn einschätzt (Anwendung, Umgebung, Test, unklar): Die Einschätzung ist eine Heuristik aus den Belegen des Browsers. Sie gibt den Berichten ihren Typ und entscheidet über `--retry-env`, macht aber nie aus einem Fehlschlag ein Bestanden oder einen Fehler.

`--report <art>=<datei>` schreibt das Ergebnis zusätzlich in eine Datei, je Art einmal, mehrfach für mehrere Arten. Die Datei ist relativ zum Projektordner und muss darin bleiben; ein Pfad außerhalb, auch über einen Link, wird abgelehnt, bevor ein Test läuft. Ein einzelner Test mit `--report` oder `--retry-env` nimmt denselben Weg.

| Art | Inhalt |
|---|---|
| `junit=<datei>` | JUnit-XML. Ein bestandener Test mit offenen Schritten bleibt ein bestandener Testfall und trägt `S4–S5 offen` in `<system-out>`; `<skipped>` würde den ganzen Test als übersprungen zählen, obwohl seine aufgenommenen Schritte liefen. Ein gescheiterter Schritt ist `<failure type="app\|environment\|test\|unclear" message="S3: <grund>">` mit Einschätzung, Befunden und Berichtspfad als Text; alles andere, was nicht bestanden hat, ist `<error type="<fehlercode>">` (etwa `replay-missing`, `browser-closed`). Ein wiederholter Test listet jeden Versuch in `<system-out>`. |
| `summary=<datei>` | Markdown, eine Zeile je Test: Ergebnis, gescheiterter Schritt mit Grund, Einschätzung, erster Befund und Berichtspfad. Gemacht für die Zusammenfassung eines CI-Jobs: `cat out/summary.md >> "$GITHUB_STEP_SUMMARY"`. |
| `json=<datei>` | Für Skripte: `target`, `startedAt`, `exit` und je Test `id`, `status`, `exit`, `failedStep`, `reason`, `side`, `strength`, `findings`, `code` (soweit zutreffend), `steps` (`id`, `status`, `seconds`), `report` und `attempts`. |

`--retry-env <n>` (1 bis 5) lässt einen Test noch einmal laufen, wenn er an der Umgebung gescheitert ist: Exit `2`, oder Exit `1` mit der Einschätzung `environment`. Höchstens `n` weitere Versuche; was die Einschätzung der Anwendung, dem Test oder nichts Klarem zuschreibt, wird nie wiederholt. Es zählt das Ergebnis des letzten Versuchs, jeder Versuch bleibt in den Berichten, und Tabelle, JUnit und Zusammenfassung sagen etwa „bestanden im 2. Versuch (Umgebung)“.

## open

```bash
npx caw open --env dev
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local
```

Öffnet die App mit Werkbank und Chat: navigieren, ausprobieren, mit Claude entwickeln. Lernt nichts und schreibt keine Testdatei.

- **Ohne Test** öffnet es die Startseite der App. Hat die Umgebung eine Formular-Anmeldung, siehst du sie zuerst in der App, als Schritt „Anmelden“ unter Vorbereitung; danach geht caw zur Startseite. Ohne `--env` nimmt es die einzige Umgebung, auf der Claude arbeiten darf.
- **`open <test>`** spielt erst den ganzen Test ab, dann gehört dir das Fenster.
- **`open <test>@S3`** hält am Einstieg in S3: S1 und S2 laufen ganz, von S3 nur die Navigation (`goto`, Klicks, Warten auf die Seite). Seine Eingaben und seine Prüfung bleiben für dich offen; das Terminal meldet `Bereit für S3 …: Navigation ausgeführt, Eingaben offen`. Hat S3 gar keine Eingaben (etwa nur ein Klick auf „Absenden“), läuft von S3 nichts; hat einer seiner Klicks in früheren Läufen Daten geschrieben, hält es vor diesem Klick; ist S3 nicht oder nicht aktuell aufgenommen, läuft davon nichts. Das Terminal nennt den Grund. Ist S3 der erste [offene Schritt](test-files.de.md#offene-schritte), baust du ihn hier; `open <test>@S4` hinter einem offenen S3 wird abgelehnt und nennt S3 (erst aufnehmen), `open <test>` spielt bis zum letzten aufgenommenen Schritt.

Mit Test meldet sich `open` mit der Rolle des Tests an und spielt ohne Claude ab; der Schritt, an dem es hält, wird nicht bewertet. Es läuft der ausgelieferte Stand, außer du gibst `--overlay` an.

| Option | |
|---|---|
| `--role <rolle>` | Nur ohne Test; nicht nötig, wenn die Config nur eine hat. Ein Test bringt seine mit. |
| `--start`, `--reset` | Wie bei `run` (`reset` nur mit `--reset`). |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt beim Abspielen, Standard `30s`. |
| `--design` | Mit `@S3`: spielt bis einschließlich S3 (bei offenem S3: bis zu seinem Einstieg) und legt sein Zielbild in der aufgenommenen Größe über die App, die Abweichungen darunter; F7 zeigt und verbirgt es. Siehe [gegen ein Zielbild entwickeln](guide.de.md#gegen-ein-zielbild-entwickeln). |
| `--agent local\|docker`, `--attach [<key>]`, `--agent-timeout <dauer>`, `--max-actions <n>` | Wie bei `record`. |

Nach der Übergabe öffnet **F1** (oder ⋯ → Öffnen…, `/open` im Chat) in der Werkbank „Öffnen…“: einen beliebigen Test dieser Umgebung, optional mit Schritt. Ohne Schritt läuft der Test bis zum letzten Schritt, mit Schritt landet er an dessen Einstieg, wie `open <test>@<schritt>`. caw beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet sich mit dem Konto der Rolle des Tests neu an und spielt ihn im selben Fenster ab, ohne Claude. Bei Basic-Auth nur Tests der eigenen Rolle.

Scheitert das Herstellen an etwas, das nicht immer kommt (etwa ein Cookie-Banner, der schon weg ist), frag im Chat: Claude kann den Klick optional machen. Was du übernimmst, steht sofort in der Testdatei. Beim Aufnehmen geht das direkt mit `click <ziel> --optional`.

## reproduce

```bash
npx caw reproduce "Nach dem Speichern zeigt die Liste noch den alten Titel." --env local
npx caw reproduce --file fehler.md --from create-ticket@S3 --env local --headless
befehl-der-das-ticket-ausgibt | npx caw reproduce - --env local
```

Claude stellt einen Fehler allein nach, angemeldet mit einer Testrolle: kein Plan zum Freigeben, niemand zum Antworten, keine
Entscheidung. Es liest und bedient die Seite wie ein Mensch und endet mit einem Urteil: nachgestellt, nicht nachgestellt oder
unklar. Im Laufordner liegen dann `report.md` (Urteil, der Fehlerbericht, was Claude beobachtet und erwartet hat, seine Schritte,
die Aktionen im Browser, Screenshots, harte Fehler, gesperrte oder auffällige Requests, ein Hinweis auf die Ursache) und
wenn nachgestellt, `caw/drafts/<id>.yaml`, ein Testentwurf im Format von caw aus Claudes Schritten, mit Claudes Aktionen im
Browser und ihren Locatoren in seinen `notes`. Nichts landet in `caw/tests`: Prüf den Entwurf, nimm ihn mit `caw record <id>` rot
auf, behebe den Fehler, `caw run <id>` zeigt ihn grün, und `caw run <id> --promote` macht ihn zum Test
([vom Fehler zum belegten Fix](guide.de.md#vom-fehler-zum-belegten-fix)).

- **Wo:** nur auf Umgebungen mit `agent`, nie auf Produktion (`reproduce-not-allowed`). Ohne `--env` die einzige solche
  Umgebung, mit `--from` die des Tests.
- **Schreiben:** nur, wo die Umgebung `writable` ist. Sonst bricht caw jeden schreibenden Request ab wie auf Produktion, und
  Claude weiß, dass es nur lesen darf.
- **Nie:** Code-Änderungen, Empfehlungen, Änderungen an Tests oder Config. Der Browser erreicht nur die Hosts des Projekts (wie
  immer, wenn ein Agent im Fenster handeln kann).
- **Die Rolle:** mit `--from` die des Tests, sonst `--role` oder die einzige. Fehlt der Testnutzer, endet es mit `credentials-missing`.

| Option | |
|---|---|
| `"<fehlerbericht>"`, `--file <datei>`, `-` | Der Fehlerbericht: als Argument, aus einer Datei oder von stdin. Genau eins, höchstens 8000 Zeichen. |
| `--from <test>[@<S4>]` | In einem Zustand eines Tests anfangen: dessen Schritte (bis zum Einstieg in S4) laufen vorher ohne Claude. |
| `--role <rolle>` | Ohne `--from`; unnötig, wenn die Config nur eine hat. |
| `--ref <id>` | Eine ID aus einem anderen Werkzeug, etwa ein Ticket (`TCK-1234`): bis zu 64 Buchstaben, Ziffern und `. _ # : / -`, sonst Exit 3. caw schlägt sie nie nach; sie steht in `report.md`, `result.json` (`reproduce.ref`), den Notizen des Entwurfs und in `caw_reproductions`. |
| `--headless` | Ohne Fenster. Mit Fenster zeigt die Werkbank, was Claude tut; du kannst nur zusehen oder beenden (Esc). |
| `--agent local\|docker`, `--attach [<key>]` | Wie bei `record`. Aus deiner eigenen Claude-Code-Session (`caw_start` mit `command: "reproduce"`) ohne zusätzliche Tokens. |

Exit-Codes: `0` nachgestellt, `1` nicht nachgestellt oder unklar, `2` Umgebungsfehler (auch wenn der Ausgangszustand von
`--from` nicht erreicht wurde: `reproduce-state`), `3` ungültige Eingabe.

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

## skill

```bash
npx caw skill                         # schreibt oder aktualisiert .claude/skills/caw-attach/SKILL.md
```

Schreibt den Claude-Code-Skill `caw-attach`, den `init` mit dem MCP-Eintrag ebenfalls schreibt. Er sagt deiner Session, wann
und wie sie sich mit einem caw-Fenster verbindet (`caw_attach`, der Monitor, `caw_start` mit `open`): wenn du mit ihr etwas in
der App ansehen willst, einen Fehler gemeinsam nachstellen lässt oder `/caw-attach` eingibst. Nach einem Update von caw erneut
ausführen. Eine Datei dort, die caw nicht geschrieben hat, bleibt, wie sie ist (Exit 3, `skill-foreign`). `doctor` meldet einen
fehlenden oder veralteten Skill als optional.

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

## mcp

Startet Claude Code über `.mcp.json` (`claude mcp add caw --scope project -- npx caw-ai mcp`). Du rufst es nicht selbst auf. Der Server heißt `caw`; beim Start sagt er Claude, wofür caw da ist und dass es zuerst `caw_guide` liest. Deine Sitzung bekommt diese Tools:

| Tool | | Tokens |
|---|---|---|
| `caw_guide` | Die Anleitung je Thema (`topic`); ohne Thema die Übersicht. `overlay` und `extjs` nur, wenn das Projekt sie nutzt | nein |
| `caw_doctor` | `doctor` als Daten (`agent`, `attach`, `env`) | nein |
| `caw_init` | `mode: explore` (`url`, `login` oder `yes`): das Fenster, wartet und liefert die Vorschläge (`wait: false` startet nur); `mode: write` (`fromExplore`) und `mode: offline` schreiben die Dateien; `env`, `language`, `insecureTls`, `allowHttp`, `roles`, `noMcp` | nein |
| `caw_role` | Rollen als Daten (`list`), eine neue in der Config mit ihren Variablennamen (`add`, `name`; `caw/.env` füllt der Mensch), eine gespeicherte Sitzung (`login`), `remove`; nie Benutzernamen oder Passwörter | nein |
| `caw_config` | Config lesen oder geprüft ändern (`patch`, `dryRun`). Ein Patch, der den `overlay`-Block hinzufügt oder entfernt, ändert die Tool-Liste. Abgelehnt: Befehle (`start`, `stop`, `reset`, `ready`, `lintCommand`, Overlay-`start`), Umgebungs-Schalter, `browser.executablePath`, `sandboxImage`, `sandboxUser`, `agent.mode`; die ändert die Session in der Datei, wo du den Diff siehst | nein |
| `caw_validate` | `validate` als Daten; Entwürfe aus `caw/drafts` unter `drafts` | nein |
| `caw_list` | `list` als Daten; Entwürfe unter `drafts`, jeder mit `red` (`{ step, run, head }` oder `null`) | nein |
| `caw_reproductions` | Die Nachstellungen in `.caw/runs`, die neueste zuerst: `runId`, `date`, `ref`, `status`, `reproduced`, `observed`, `covered`, `draft`, `report`; `refs` (Liste) behält nur diese und nennt Refs ohne Lauf als `missing` (nie gelaufen oder durch `keepRuns` gelöscht), `since` (ISO-Datum) behält neuere Läufe | nein |
| `caw_design` | Zielbilder unter `caw/design`: `put` schreibt `design/<name>.html`, `.png` (base64) oder `<name>tokens.json` (DTCG, jedes Token hat `$value`), nachdem Name, Größe, PNG-Signatur und Abmessungen geprüft sind; `list` liefert die Entwurfsdateien und die Schritte, die sie nennen; `link` setzt oder entfernt `design:` an einem Schritt (mit `personAsked: true`, nur auf Wunsch des Menschen) | nein |
| `caw_overlay` | Nur mit `overlay`-Block: `action: status` (`overlay status` im Prozess, schnell), `check` oder `apply` (`overlay check`, `--apply`; wartet bis zu 3 Minuten); `env`, `part` | nein |
| `caw_attach` | Diese Session verbinden: liefert ihren Schlüssel und den Befehl, den sie mit dem Monitor-Werkzeug startet; jede Chat-Nachricht und jede Aufgabe eines verbundenen Fensters erreicht die Session dann als Zeile. |
| `caw_start` | `run`, `record`, `open` oder `reproduce` mit dieser Session verbunden starten (`--attach=<key>`) (`reproduce`: `bug`, `from`, `role`, `env`, `ref`, `headless`; `test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset` oder `args`; `step` bei `record` und `open`, nur mit `test`; `promote` bei `run` eines Entwurfs). Mit `overlay` prüft es zuerst den lokalen Code-Server: `down`, `wrong-app` oder `stale` liefert `state`, `url`, `start` und `partDir`, statt zu starten; `moved` startet mit `--overlay <foundUrl>`. Nie `--start` zusammen mit `overlay`: Die Session startet den lokalen Code-Server selbst, nachdem sie dich gefragt hat. `start` und `reset` führen die konfigurierten Befehle der Umgebung aus | nur deine Session |
| `caw_status` | Wartet ein Lauf auf die Sitzung? Letzte Zeilen der Ausgabe; Ergebnis und Artefakte des letzten Laufs als Daten. `wait` (bis 120 s) antwortet, sobald der Lauf die Sitzung braucht, endet oder etwas Neues meldet | nein |
| `caw` | Die Agenten-Befehle (`snapshot`, `click`, `plan`, `finish`, …) | im Lauf |
| `caw_selection` | Das Element, das du mit `/element` im Chat der Werkbank gewählt hast | nein |

Ergebnisse kommen als kurzer Text plus `structuredContent` (JSON).

## Agenten-Befehle

`caw agent <befehl>` mit `snapshot`, `click`, `dblclick`, `hover`, `drag`, `dialog`, `fill`, `type`, `press`, `upload`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

Nur über diese Befehle kann Claude den Browser bedienen. Sie sind für den Agenten während `record` und im Chat da; du brauchst sie nicht. `npx caw agent --help` listet ihre Argumente.

## Exit-Codes

| Code | |
|---|---|
| `0` | bestanden |
| `1` | fehlgeschlagen: Ein Schritt tut nicht, was der Test erwartet, egal wie caw ihn einschätzt (Anwendung, Umgebung, Test, unklar); bei `audit`: ein Test wurde abgeschwächt |
| `2` | Fehler: Die Umgebung hat ein Urteil verhindert (Server aus, Anmeldung fehlgeschlagen, Chrome fehlt, …), oder ein unerwarteter interner Fehler (der Stack steht in der Ausgabe) |
| `3` | abgewiesen: Aufruf, Config (auch `TODO`-Werte aus `init`) oder Testdatei ungültig. Es lief nichts. |
| `4` | Aufnahme nötig: Die Aufzeichnung fehlt (`record`), ein Schritt hat sich seit der Aufnahme geändert (`record <test>@<schritt>`) oder `run --strict` traf auf offene Schritte. Es lief nichts. |

## Umgebungsvariablen

| Variable | |
|---|---|
| `CAW_LANG` | `en` oder `de`: deine eigene Sprache für caws Texte (CLI, Werkbank) statt der Teamsprache (`language` in der Config). Claude schreibt Pläne weiter in der Teamsprache. |
| `CAW_AI_HOME` | Ordner für persönliche Einstellungen (`prefs.json`). Standard `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` oder `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API-Schlüssel aus der Claude Console für den Agenten `docker`. `local` nutzt deine Claude-Code-Anmeldung; mit `--attach` arbeitet deine eigene Session. |
| `CAW_AGENT_MODEL`, `CAW_CLAUDE_BUDGET` | Modell und Budget in US-Dollar für Claude-Läufe (`--model`, `--max-budget-usd`); überschreiben `agent.model` und `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Nur Windows: `windows` oder `wsl` legt den Weg zu Docker fest. |
| `CI` | Gesetzt: kein Chat, nur Agent `docker`; `record` und `open` werden abgelehnt. |
| `CAW_URL__<ENV>` | Eine andere Adresse für eine Umgebung in diesem Prozess, etwa eine PR-Vorschau; wird nie in die Konfiguration geschrieben. Siehe [Konfiguration](configuration.de.md#url-für-pr-vorschauen). |
| `NO_COLOR`, `FORCE_COLOR` | Farben im Terminal aus oder an. |
| `MCP_TOOL_TIMEOUT` | In der Umgebung von Claude Code: erhöhen, wenn `plan` oder `chat` in deiner Sitzung abbrechen. |

## Fehlercodes

Bricht caw ab oder endet ein Lauf mit `error`, nennt es zuerst den Grund und danach den Code.

| Code | Exit | Abhilfe |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw <befehl> --help` |
| `reproduce-not-allowed` | 3 | `reproduce` nur auf einer Umgebung mit `agent`, nie auf Produktion |
| `reproduce-state` | 2 | Der Ausgangszustand von `--from` wurde nicht erreicht: den Test mit `run` laufen lassen und erst reparieren |
| `config-missing` | 3 | `npx caw init --url <adresse>` |
| `config-invalid` | 3 | Das genannte Feld korrigieren oder die `TODO`-Werte eintragen, dann `doctor` |
| `url-override` | 3 | Eine Variable `CAW_URL__<ENV>` nennt keine Umgebung, eine Produktions- oder Agent-Umgebung, einen Produktionshost oder keinen gültigen Origin: korrigieren oder entfernen |
| `test-missing`, `test-invalid` | 3 | Testdatei anlegen oder korrigieren, dann `validate` |
| `replay-missing` | 4 | Test mit `record` aufnehmen |
| `replay-stale` | 4 | Ein Schritt hat sich seit der Aufnahme geändert: `record <test>@<schritt>` |
| `replay-pending` | 4 | `run --strict` und der Test endet mit offenen Schritten: `record <test>@<erster offener Schritt>` |
| `step-unknown` | 3 | Eine Schritt-ID aus der Testdatei nehmen (`list <test>`) |
| `env-invalid`, `env-denied` | 3 | Eine Umgebung aus der Config nehmen; Produktion lässt sich nicht aufnehmen |
| `host-blocked` | 3 | `goto` zu einem Host, der kein Host der Anwendung ist: in `allowHosts` eintragen, wenn die Anwendung wirklich dorthin navigiert. In einem Lauf ist dieselbe Sperre ein Fehler des Schritts |
| `env-certificate` | 2 | Dem Zertifikat der Umgebung wird nicht vertraut: bei einer internen Zertifizierungsstelle `environments.<env>.insecureTls: true` setzen |
| `write-protected` | 3 | Aufnehmen und schreibende Tests brauchen `agent` / `writable` an der Umgebung |
| `git-missing`, `git-ref` | 3 | `audit`: Git installieren, im Repository aufrufen, eine Ref nennen, die Git kennt; in CI die Geschichte holen (`fetch-depth: 0`) |
| `skill-foreign` | 3 | `caw skill`: `.claude/skills/caw-attach/SKILL.md` gibt es, nicht von caw geschrieben |
| `auth-missing` | 3 | Keine gespeicherte Sitzung, oder sie ist abgelaufen: `caw role login <rolle> --env <env>` (die Meldung nennt ihn) |
| `credentials-missing` | 3 | Die genannten Variablen in `caw/.env` oder in der Umgebung setzen (CI-Secrets); eine neue Rolle vorher mit `role add <rolle>` |
| `login-form-missing`, `login-failed` | 2 | Läuft das Backend? Stimmen Selektoren oder Schritte in `signIn` und die Zugangsdaten? |
| `env-unreachable` | 2 | Umgebung starten (oder `--start` angeben, wenn sie einen `start`-Befehl hat), Adresse prüfen |
| `browser-sandbox` | 2 | Die Sandbox von Chrome startet nicht (Linux als root, manche Container): den Rechner richten oder bewusst `browser.noSandbox: true` setzen |
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
