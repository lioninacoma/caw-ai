[English](commands.md) · Deutsch

# Befehle

Jeder Befehl läuft im Wurzelordner deines Projekts: `npx caw <befehl>` (oder `pnpm exec`, `yarn`). `<env>` ist ein Name aus `environments` in `caw.config.json`, etwa `local`. Mit Mandanten (`sites`) heißt es `mandant/env`, etwa `nord/dev`.

`--env` darf fehlen, wenn die Wahl klar ist: `run`, `record` und `open <test>` nehmen dann das einzige Ziel des Tests (bei `record` das einzige davon, auf dem Claude arbeiten darf; bei `record` eines neuen Tests die einzige Umgebung, auf der Claude arbeiten darf). Das Terminal nennt die Wahl, etwa `› Ziel: local (einziges Ziel von create-ticket)`. Ist sie nicht eindeutig, bricht der Befehl ab und nennt die Auswahl: `--env fehlt: local, dev`.

| Befehl | Was er tut | Claude? |
|---|---|---|
| [`init`](#init) | Projekt einrichten: App ansehen, Config, Skill und `.mcp.json` schreiben; mit `--explore-only` nur Einstellungen vorschlagen | nein |
| [`skill`](#skill) | Skill für Claude Code und `.mcp.json` anlegen oder aktualisieren | nein |
| [`doctor`](#doctor) | Rechner, Config, Zugangsdaten und Umgebungen prüfen | nein |
| [`overlay status`](#overlay-status) | Ist der lokale Code-Server für `--overlay` bereit? | nein |
| [`overlay check`](#overlay-check) | Prüfen, ob `--overlay` alles ersetzt, was es soll | nein |
| [`validate`](#validate) | Config und Tests offline prüfen | nein |
| [`list`](#list) | Tests und Schritte mit Stand der Aufnahme auflisten | nein |
| [`record`](#record) | Einen Test aufnehmen oder seine Aufzeichnung ersetzen, auch ab einem Schritt | ja |
| [`run`](#run) | Einen Test abspielen, oder mehrere für CI | nur auf Wunsch |
| [`open`](#open) | Die App angemeldet öffnen, mit Werkbank und Chat; mit Test an seinem Ende oder am Einstieg in einen Schritt | nur auf Wunsch |
| [`role`](#role) | Rollen und ihre Testnutzer auflisten, hinzufügen oder entfernen; `role login` speichert eine Sitzung (SSO) | nein |
| [`theme`](#theme) | Themes der Werkbank auflisten, wählen oder prüfen | nein |
| [`mcp`](#mcp) | MCP-Server für deine eigene Claude-Code-Sitzung (startet Claude Code, nicht in `--help`) | – |

`npx caw help` zeigt dieselbe Übersicht im Terminal. `npx caw <befehl> --help` (oder `-h`, an beliebiger Stelle) zeigt nur diesen Befehl, `npx caw agent --help` die Befehle für den Agenten. `npx caw --version` zeigt die Version.

Bricht ein Befehl ab, steht im Terminal zuerst der Grund, bei einem ungültigen Aufruf dann die Kurzform des Befehls, zuletzt Code und Exit-Code:

```
✗ create-ticket@s2: Ein Schritt steht als <test>@S<n> hinter dem Test, etwa bestellung@S3.
  Aufruf: caw record <test> [--env <umgebung>] [--role <rolle>] [--app <app>]  oder  caw record <test>@<S4> [--env <umgebung>]
  (code: usage, exit 3)
```

Eine Option, die einen Wert braucht, nimmt nie die nächste Option als Wert: `--env --headless` bricht ab mit `--env braucht einen Wert, etwa --env local`.

## init

```bash
npx caw init --url http://localhost:5173
```

Fragt im Terminal, ob die App eine Anmeldung braucht, und öffnet sie dann in Chrome. Mit einem Testkonto anmelden (caw-ai merkt, wenn das Anmeldeformular verschwunden ist), zur Seite gehen, auf der Tests beginnen sollen, und in der Karte unten rechts im Fenster auf **Fertig** klicken. caw-ai erkennt Framework, Anmeldeformular und eine Marke für „angemeldet“ und legt an:

- `caw.config.json`
- `caw/.env.example` mit den Variablen für die Zugangsdaten je Rolle
- `.claude/skills/caw-ai/SKILL.md` und einen Eintrag `caw-ai` in `.mcp.json`
- `caw/tests/` für deine Testpläne und `caw/caw.md` für Notizen, die Claude in jedem Lauf liest
- Einträge in `.gitignore` für `caw/.env`, `.caw/` und `caw/.auth/`

Was es nicht erkennen konnte, steht auf `TODO`. `doctor` listet es auf, `validate` scheitert mit Exit 3, bis es eingetragen ist. Vorhandene Dateien bleiben unberührt.

| Option | |
|---|---|
| `--url <adresse>` | Adresse der App. Ohne fragt `init` nach. |
| `--yes` | Nicht aufs Anmelden warten, nichts fragen. Gut für Apps ohne Anmeldung. Mit Anmeldung meldet sich niemand an: `signedInSelector` bleibt `TODO`, `startUrl` bleibt `/` (oder der Pfad aus `--url`). |
| `--from <datei>` | Ein vorhandenes Ergebnis von `--explore-only` nehmen, statt die App zu öffnen. Gibt es `caw/.explore.json`, nimmt `init` es von selbst. |
| `--no-mcp` | `.mcp.json` nicht anfassen. |
| `--offline` | Die App nicht öffnen: die Vorlage schreiben, die Anmeldung bleibt `TODO`. Ohne Terminal und ohne `--url` macht `init` das von selbst. |
| `--insecure-tls` | Selbstsignierte Zertifikate annehmen (nur lokale Umgebungen). |

### Nur ansehen: `--explore-only`

```bash
npx caw init --explore-only --url http://localhost:5173
```

Sieht die App an wie `init`, schreibt aber nur Vorschläge nach `caw/.explore.json`: Framework, Anmeldeart und Selektoren, Marke für angemeldet, Startseite, Meldungen und Konsolenrauschen. Jeder Vorschlag hat `confidence: certain` oder `likely`. Die Datei übernimmt später `init --from`.

Dazu: `--yes`, `--insecure-tls` (wie bei `init`); `--login` oder `--no-login` beantworten die Frage nach der Anmeldung für Skripte.

Mit Anmeldung fragt die Karte danach nach der Rolle des benutzten Kontos und speichert es als Testnutzer (siehe [role](#role)); `init` übernimmt die Rollen von dort.

## skill

```bash
npx caw skill
```

Legt `.claude/skills/caw-ai/SKILL.md` und den Eintrag in `.mcp.json` an oder bringt sie auf den neuen Stand. Nach jedem Update von caw-ai ausführen. Danach in Claude Code „Richte caw-ai ein“ sagen, und es führt dich durch `init` und `doctor`.

## doctor

```bash
npx caw doctor
npx caw doctor --agent docker
```

Prüft Node, Chrome, Claude Code (Agent `local`) oder Docker und Token (Agent `docker`), die Config, `TODO`-Werte, die Zugangsdaten je Rolle und ob jede Umgebung antwortet. Jede fehlgeschlagene Prüfung nennt den nächsten Schritt. Bei einer ungültigen Config zeigt es den ersten Befund, `validate` alle. Platzhalter-Adressen (`example.com`, `.test`, `.invalid`) meldet es, ohne sie anzufragen.

Bei ExtJS und einer Umgebung mit `overlay: true` kommen je App optionale Zeilen dazu: `bootstrap.json` vorhanden und aktuell, der lokale Code-Server (`lokaler Code unter http://localhost:1841/ liefert <app>`, `antwortet nicht` mit dem `start`-Befehl oder `läuft unter <gefunden>`, wenn der Watch einen anderen Port genommen hat), und je Teil (App, Paket) das Ergebnis des letzten `overlay check` mit Alter, sonst der Hinweis, einen zu starten. doctor startet nie etwas.

## overlay status

```bash
npx caw overlay status
npx caw overlay status --env dev --app web --json
```

Ist der lokale Code-Server der App bereit für `--overlay`? Ohne Browser, ohne Anmeldung, startet nichts. Es fragt `overlay.url` an; bei ExtJS prüft es, dass der Server der Watch *dieser* App ist (Name aus `app.json`, `bootstrap.json` mit Ladereihenfolge), und sucht sonst den Watch der App auf einem anderen Port.

| Zustand | Bedeutung | Exit |
|---|---|---|
| `ready` | Der Server antwortet (ExtJS: liefert diese App). Ein Build-Ordner oder feste Dateien brauchen keinen Server und sind ebenfalls `ready`. | 0 |
| `moved` | Der ExtJS-Watch läuft unter `foundUrl` statt unter `url` (Port war belegt). Läufe nutzen ihn; trage `url` nach. | 0 |
| `down` | Unter `url` antwortet nichts. Die Ausgabe nennt `start` und den App-Ordner. | 2 |
| `wrong-app` | Unter `url` antwortet eine andere App (oder kein Sencha-Watch). | 2 |
| `stale` | Der Watch nennt in `bootstrap.json` Dateien, die er nicht ausliefert. | 2 |
| `not-overlay`, `no-app` | Die Umgebung hat kein `"overlay": true`, oder die App ist unbekannt bzw. hat kein `app.json`. | 3 |
| `static-missing` | Eine Datei aus `overlay.statics` fehlt. | 2 |
| `static-invalid` | Ein Pfad in `overlay.statics` führt aus dem Workspace heraus oder zu einer geheimen Datei. | 3 |

`--json` gibt `{ state, framework, app, appDir, url, foundUrl?, start, statics?, message? }` als einzige Zeile auf stdout aus; `statics` nennt jeden Eintrag mit `name`, `path` und `state` (`ok`, `missing`, `outside`, `secret`).

## overlay check

```bash
npx caw overlay check
npx caw overlay check --env dev --apply
npx caw overlay check --json
```

Öffnet die App headless mit `--overlay` (angemeldet, ohne Schritte, ohne Claude) und vergleicht die Skript-Requests der Seite mit dem, was das Overlay ersetzen soll. Bei ExtJS sind das die App und jedes eigene Paket aus `bootstrap.json`, `x.js` und `x-debug.js` zählen als ein Teil. Je Teil steht `lokal`, `ausgeliefert` oder `nicht geladen` (vielleicht erst später).

Ein Teil `ausgeliefert` heißt Mischstand: Die Seite lief teils mit deinem Code, teils mit dem des Servers. Die Skript-URLs werden über den Dateinamen erkannt, unabhängig von `assetUrlPattern`; so findet die Prüfung auch Quellen, die die Config nicht kennt. Für jede schlägt sie ein Muster vor:

```
✓ shop-theme: lokal
! OrderEntry: ausgeliefert
› https://dev.example.com/o/FormProxyServlet?url=repository:///Root/ (5 Skript(e)): assetUrlPattern "[?&]url=repository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)"
```

`--apply` trägt die vorgeschlagenen Muster in `assetUrlPattern` in `caw.config.json` ein (nur fehlende; ein einzelner Text wird zur Liste), prüft die Datei vor dem Schreiben und prüft danach noch einmal. Eine Quelle ohne sicheres Muster wird als solche gemeldet; dann trägst du eins von Hand ein.

Vor dem Browser läuft `overlay status`. Ist der Server nicht bereit, hört es mit diesem Zustand, der Adresse und dem `start`-Befehl auf und startet nichts. Mit `--start` führt es `start` in diesem Fall im App-Ordner aus und beendet ihn danach (CI).

`--env` ist ohne Angabe die einzige Umgebung mit `overlay: true`, `--app` und `--role` die einzige App und die erste Rolle. Das Ergebnis steht immer in `.caw/overlay-check.json` (`at`, `target`, `app`, `state`, `url`, `start`, `parts`, `missed`, `notLoaded`, `suggestions`, `unresolved`, mit `overlay.statics` auch `statics` mit `status` `local`, `deployed` oder `not-loaded` je Eintrag, nach `--apply` auch `applied`). Ein static vom Server macht die Prüfung `incomplete`. `--json` gibt es als einzige Zeile auf stdout aus. Exit 0 vollständig, 2 unvollständig oder Server-Problem (`down`, `wrong-app`, `stale`), 3 keine Overlay-Umgebung oder keine App.

## validate

```bash
npx caw validate
```

Prüft `caw.config.json` und alle Dateien in `caw/tests/` ohne Browser und ohne Claude. Fehler nennen Datei und Zeile, alle auf einmal. Gut für CI und Pre-Commit-Hooks.

Werte in `auth`, die noch `TODO` sind, lassen die Prüfung scheitern (Exit 3, Code `config-invalid`); jeder sagt, was hineingehört.

Je Test und Ziel nennt es, welcher Code dort läuft und wo `--overlay` ginge, etwa `smoke (staging): ausgelieferter Stand` oder `smoke (dev): ausgelieferter Stand; mit --overlay: Overlay, Build dist`. Hinweise, an denen die Prüfung nicht scheitert: Einstellungen ohne Wirkung, etwa eine App mit `overlay`, während keine Umgebung es erlaubt (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)).

## list

```bash
npx caw list
npx caw list create-ticket
```

Ohne Test: je Test eine Zeile mit Zielen, Stand der Aufnahme (`aufgenommen`, `veraltet (S2, S3)`, `nicht aufgenommen`) und ob er Daten schreibt. Mit Test: je Schritt eine Zeile, etwa `S2  Ticket anlegen  (veraltet)`. Ohne Browser und ohne Claude.

Ohne `caw.config.json` bricht es ab wie jeder andere Befehl (`config-missing`). Einen Testnamen, den es nicht gibt, beantwortet caw-ai mit den bekannten Tests und bei einem Tippfehler mit dem nächstliegenden (`Meintest du create-ticket?`); `record <name>` bietet es nur für einen neuen Test an. Einen unbekannten Schritt mit den Schritten des Tests (`Schritte: S1–S6.`).

## record

```bash
npx caw record create-ticket --env local
```

Nimmt den Testplan aus `caw/tests/create-ticket.yaml` auf, oder legt einen neuen Test an, wenn es die Datei nicht gibt. Chrome öffnet sich mit Werkbank und Chat:

1. Du führst den Ablauf vor, oder Claude geht dem Testplan nach.
2. Claude zeigt einen Plan im Chat. Du gibst ihn frei oder schreibst, was sich ändern soll.
3. Claude geht den Ablauf durch und prüft jeden Schritt.
4. caw-ai spielt die Aufzeichnung ohne Claude ab.
5. Du wählst „Testplan übernehmen“. Erst dann werden Dateien geschrieben.

Nur auf Umgebungen, auf denen Claude arbeiten darf (`"claude": true`). Gibt es nur eine, darf `--env` fehlen.

| Option | |
|---|---|
| `--role <rolle>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine Rolle hat. |
| `--app <app>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine App hat. |
| `--also <app>` | Nur beim ersten Aufnehmen: Der Ablauf geht in einer weiteren App des Projekts weiter. |
| `--read-only` | Nur beim ersten Aufnehmen: Der Test schreibt keine Daten (`mutates: false`). |
| `--overlay [build\|dev\|<url>]` | Lokalen Code über die ausgelieferte Umgebung legen, siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). |
| `--start` | Die Umgebung mit ihrem `start`-Befehl starten, wenn sie nicht antwortet, und am Ende stoppen ([Lebenszyklus](configuration.de.md#umgebung-starten-stoppen-und-zurücksetzen)). Mit `--overlay` auch die lokalen Code-Server der Teile. Ohne die Option startet caw nichts und nennt den Befehl. |
| `--reset` | Vor der Aufnahme den `reset` der Umgebung ausführen. |
| `--agent local\|docker\|session` | Wo Claude läuft. Standard: `agent.mode` aus der Config, sonst `local`. |
| `--claude-timeout <dauer>` | Zeitgrenze für Claude, Standard `60m`. |
| `--max-actions <n>` | Grenze für Claudes Browser-Aktionen, Standard `maxSteps` oder 100. |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt im Prüflauf, Standard `30s`. |

### Ab einem Schritt

```bash
npx caw record create-ticket@S3 --env local
```

Nimmt den Test ab S3 bis zum Ende neu auf. Für eine gewollte Änderung der Anwendung ab dort, nachdem du den Text eines Schritts von Hand geändert hast, oder für neue Schritte am Ende. S1 und S2 laufen ohne Claude, dann folgt Claude dem alten Plan ab S3, du lenkst im Chat; eine Vorführung gibt es nicht. Ab S3 darf sich der Plan ändern: Claude kann Schritte ergänzen, entfernen, umbenennen oder umstellen. Die Schritte vor S3 und ihre Aufzeichnungen bleiben genau, wie sie sind; Schritte, die nicht mehr im Plan stehen, fallen beim Übernehmen weg. Vergleichswerte und Netzwerk-Wirkungen ab S3 lernt der nächste gesunde Lauf neu. `@S1` nimmt den ganzen Test auf, wie `record create-ticket`.

Einen Prüflauf vorher gibt es nicht: Scheitert ein Schritt an einem Fehler der Anwendung, klärst du die Ursache stattdessen mit `run`. Nur den einen gescheiterten Schritt reparierst du mit „Schritt beheben“ im Chat eines Laufs. `--role`, `--app`, `--also` und `--read-only` gelten hier nicht (Exit 3): Der Test behält seine Metadaten.

## run

```bash
npx caw run create-ticket --env local
```

Spielt die Aufzeichnung ab. Kein Claude, keine Token. Auf Umgebungen, auf denen Claude arbeiten darf (`claude`), steht der Chat neben der App: Schlägt ein Schritt fehl, fragst du Claude dort nach der Ursache oder lässt den Schritt gleich beheben.

Ein Lauf ändert von sich aus keine Datei. Mit `--learn` lernt er fehlende Vergleichswerte und Effekte in `caw/recordings/<test>.yaml`, in jedem Modus, auch in CI; mit Chat bietet ein bestandener Lauf, der lernen könnte, stattdessen „Baselines lernen“ auf seiner Abschlusskarte an, und nur dieser Klick schreibt. Die erste Zeile nennt Umgebung, Teamsprache und ob der Lauf lernt, etwa `Modus auf local (Teamsprache en): mit Chat; lernt: nein.` Am Ende sagt ein Lauf, der gelernt hat, was sich geändert hat, etwa `Geändert: caw/recordings/create-ticket.yaml (Vergleichswerte S2, S5)`, oder `Testdatei unverändert.` Nach einem Fehlschlag nennt er den Grund des gescheiterten Schritts (auch mit `--headless` und in CI) und die nächsten Aufrufe: einen Lauf mit Chat, der die Ursache klärt, und `open <test>@<schritt>` bis zum Einstieg in den gescheiterten Schritt. Den Bericht gibt es zusätzlich als `file://`-Link. In `report.md` stehen Schritte nach dem gescheiterten auf `skipped`, Screenshots verlinken in den Ordner `agent/` des Laufs.

| Option | |
|---|---|
| `--overlay [build\|dev\|<url>]` | Lokalen Code über die ausgelieferte Umgebung legen: der Build-Ordner, der lokale Code-Server unter `overlay.url` (Dev-Server, Sencha-Watch) oder der Server unter `<url>`; ohne Wert die eine konfigurierte Quelle. Nur auf Umgebungen mit `"overlay": true`. Ohne die Option läuft immer der ausgelieferte Stand. Siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). |
| `--start` | Wie bei `record`. |
| `--reset`, `--no-reset` | Der `reset` der Umgebung läuft einmal vor dem ersten schreibenden Test; `--reset` vor dem ersten Test, `--no-reset` nie. |
| `--explain` | Bei Fehlern oder Warnungen erklärt Claude die Ursache ungefragt. Kostet Token. |
| `--no-chat` | Sichtbares Fenster, kein Chat, kein Claude. Wie in der CI. |
| `--headless` | Kein Fenster, kein Chat. 1920×1080. |
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

`--report junit=<datei>` schreibt die Tabelle zusätzlich als JUnit-XML (relativ zum Projektordner): `fail` als `<failure>`, alles andere, was nicht bestanden hat, als `<error>`.

## open

```bash
npx caw open --env dev --overlay
npx caw open create-ticket --env local
npx caw open create-ticket@S3 --env local --overlay
```

Öffnet die App angemeldet, mit Werkbank und Chat: navigieren, ausprobieren, mit Claude entwickeln. Lernt nichts und schreibt keine Testdatei.

- **Ohne Test** öffnet es die Startseite der App. Ohne `--env` nimmt es die einzige Umgebung, auf der Claude arbeiten darf.
- **`open <test>`** spielt erst den ganzen Test ab, dann gehört dir das Fenster.
- **`open <test>@S3`** hält am Einstieg in S3: S1 und S2 laufen ganz, von S3 nur die Navigation (`goto`, Klicks, Warten auf die Seite). Seine Eingaben und seine Prüfung bleiben für dich offen; das Terminal meldet `Bereit für S3 …: Navigation ausgeführt, Eingaben offen`. Hat S3 gar keine Eingaben (etwa nur ein Klick auf „Absenden“), läuft von S3 nichts; hat einer seiner Klicks in früheren Läufen Daten geschrieben, hält es vor diesem Klick; ist S3 nicht oder nicht aktuell aufgenommen, läuft davon nichts. Das Terminal nennt den Grund.

Mit Test meldet sich `open` mit der Rolle des Tests an und spielt ohne Claude ab; der Schritt, an dem es hält, wird nicht bewertet. Es läuft der ausgelieferte Stand, außer du gibst `--overlay` an.

| Option | |
|---|---|
| `--role <rolle>`, `--app <app>` | Nur ohne Test; nicht nötig, wenn die Config nur eine hat. Ein Test bringt beides mit. |
| `--overlay [build\|dev\|<url>]`, `--start`, `--reset` | Wie bei `run` (`reset` nur mit `--reset`). |
| `--step-timeout <dauer>` | Zeitgrenze je Schritt beim Abspielen, Standard `30s`. |
| `--agent local\|docker\|session`, `--claude-timeout <dauer>`, `--max-actions <n>` | Wie bei `record`. |

Nach der Übergabe öffnet **F1** in der Werkbank „Öffnen…“: einen beliebigen Test dieser Umgebung, optional mit Schritt. Ohne Schritt läuft der Test bis zum letzten Schritt, mit Schritt landet er an dessen Einstieg, wie `open <test>@<schritt>`. caw-ai beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet sich mit dem Konto der Rolle des Tests neu an und spielt ihn im selben Fenster ab, ohne Claude. Bei Basic-Auth nur Tests der eigenen Rolle.

Scheitert das Herstellen an etwas, das nicht immer kommt (etwa ein Cookie-Banner, der schon weg ist), frag im Chat: Claude kann den Klick optional machen. Was du übernimmst, steht sofort in der Testdatei. Beim Aufnehmen geht das direkt mit `click <ziel> --optional`.

## role

```bash
npx caw role                          # Rollen, ob ein Testnutzer gesetzt ist (nie die Werte), Tests je Rolle
npx caw role list --json              # dasselbe als eine JSON-Zeile
npx caw role add sb --env dev      # Fenster auf der Anmeldeseite: anmelden, Rolle speichern
npx caw role remove sb                # nur wenn kein Test sie nutzt; entfernt auch ihre Zeilen in caw/.env
npx caw role login sb --env dev       # auth.type storageState: von Hand anmelden, Sitzung speichern
```

Eine Rolle ist ein Testnutzer. `role add` öffnet die Anmeldeseite der Umgebung. Du meldest dich mit dem Testkonto an; die Karte nennt die Rolle (vorbelegt, änderbar), und **Speichern** schreibt Benutzername und Passwort in `caw/.env`, die Rolle mit ihren Variablennamen in `caw.config.json` und `caw/.env` in `.gitignore`. **+ Weitere Rolle** meldet ab und nimmt das nächste Konto. Die Werte gehen von der Seite direkt in die Datei: nicht zu Claude, nicht ins Terminal, nicht in `caw/.explore.json`.

`init` (auch mit `--explore-only`) endet genauso: Nach **Fertig** fragt die Karte nach der Rolle des Kontos, mit dem du dich angemeldet hast. Braucht `record`, `run` oder `open` eine Rolle ohne Testnutzer, öffnet sich zuerst das Fenster, und nach **Speichern** geht der Lauf weiter; in CI und mit `--headless` endet er mit `credentials-missing`. Bei `auth.type: storageState` gilt `role login`.

`role login` ist für `auth.type: storageState` (SSO, OAuth, MFA). Es öffnet Chrome auf der Anmeldung, du meldest dich von Hand an. Sobald `signedInSelector` erscheint, speichert caw-ai Cookies und Storage in `caw/.auth/<env>/<rolle>.json`. Erneut ausführen, wenn die Sitzung abläuft.

## theme

```bash
npx caw theme                 # Themes auflisten, aktives markiert
npx caw theme use phosphor    # eines wählen
npx caw theme check mein-theme  # Schema, Kontrast, Markenbreite, Schriften
```

Das Theme gehört dir, steht in `prefs.json` und gilt in allen Projekten. Eingebaut: `nacht` (Standard), `bernstein`, `phosphor`, `kachel`, `cockpit`. Farben, Zeichen, Rabe und CRT-Look änderst du mit F7 in der Werkbank; eigene Themes sind Ordner neben `prefs.json`. Details: [themes/README.de.md](../themes/README.de.md).

## mcp

Startet Claude Code über `.mcp.json`. Du rufst es nicht selbst auf. Deine Sitzung bekommt diese Tools:

| Tool | | Tokens |
|---|---|---|
| `caw_doctor` | `doctor` als Daten | nein |
| `caw_init` | `init` ohne Rückfragen (`offline`, `fromExplore`, `roles`, `noMcp`) | nein |
| `caw_explore` | `explore` ausführen (`login` oder `yes`) und auf das Fenster warten; liefert Vorschläge und gespeicherte Rollen (`wait: false` startet nur) | nein |
| `caw_role` | Rollen als Daten (`list`), das Anmeldefenster für eine neue (`add`, `name`, `target`; wartet und liefert die gespeicherten Rollen), `remove`; nie Benutzernamen oder Passwörter | nein |
| `caw_config` | Config lesen oder geprüft ändern (`patch`, `dryRun`) | nein |
| `caw_validate` | `validate` als Daten | nein |
| `caw_list` | `list` als Daten | nein |
| `caw_overlay` | `action: status` (`overlay status` im Prozess, schnell), `check` oder `apply` (`overlay check`, `--apply`; wartet bis zu 3 Minuten); `target`, `app` | nein |
| `caw_start` | `run`, `record` oder `open` mit `--agent session` starten (`test`, `env`, `step`, `overlay`, `headless`, `learn`, `start`, `reset` oder `args`; `step` bei `record` und `open`, nur mit `test`). Mit `overlay` prüft es zuerst den lokalen Code-Server: `down`, `wrong-app` oder `stale` liefert `state`, `url`, `start` und `appDir`, statt zu starten; `moved` startet mit `--overlay <foundUrl>`. Nie `--start` zusammen mit `overlay`: Die Session startet den lokalen Code-Server selbst, nachdem sie dich gefragt hat. `start` und `reset` führen die konfigurierten Befehle der Umgebung aus | nur deine Session |
| `caw_status` | Wartet ein Lauf auf die Sitzung? Letzte Zeilen der Ausgabe; Ergebnis und Artefakte des letzten Laufs als Daten. `wait` (bis 120 s) antwortet, sobald der Lauf die Sitzung braucht, endet oder etwas Neues meldet | nein |
| `caw` | Die Agenten-Befehle (`snapshot`, `click`, `plan`, `finish`, …) | im Lauf |
| `caw_selection` | Das Element, das du mit dem Fadenkreuz in der Werkbank gewählt hast | nein |

Ergebnisse kommen als kurzer Text plus `structuredContent` (JSON).

## Agenten-Befehle

`caw agent <befehl>` mit `snapshot`, `click`, `dblclick`, `fill`, `type`, `press`, `upload`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

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
| `CAW_LANG` | `en` oder `de`. Hat Vorrang vor `language` in der Config. |
| `CAW_AI_HOME` | Ordner für persönliche Einstellungen (`prefs.json`). Standard `%APPDATA%\caw-ai`, `$XDG_CONFIG_HOME/caw-ai` oder `~/.config/caw-ai`. |
| `ANTHROPIC_API_KEY` | API-Schlüssel aus der Claude Console für den Agenten `docker`. `local` und `session` nutzen deine Claude-Code-Anmeldung. |
| `CAW_CLAUDE_MODEL`, `CAW_CLAUDE_BUDGET` | Modell und Budget in US-Dollar für Claude-Läufe (`--model`, `--max-budget-usd`); überschreiben `agent.model` und `agent.maxBudgetUsd`. |
| `CAW_DOCKER` | Nur Windows: `windows` oder `wsl` legt den Weg zu Docker fest. |
| `CI` | Gesetzt: kein Chat, nur Agent `docker`; `record` und `open` werden abgelehnt. |
| `NO_COLOR`, `FORCE_COLOR` | Farben im Terminal aus oder an. |
| `MCP_TOOL_TIMEOUT` | In der Umgebung von Claude Code: erhöhen, wenn `plan` oder `chat` in deiner Sitzung abbrechen. |

## Fehlercodes

Bricht caw-ai ab oder endet ein Lauf mit `error`, nennt es zuerst den Grund und danach den Code.

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
| `auth-missing` | 3 | Datei unter `caw/.auth/` löschen und `auth` erneut ausführen |
| `credentials-missing` | 2 | `role add <rolle> --env <env>` (im Fenster anmelden), oder die Variablen in der Umgebung oder in `caw/.env` setzen (CI) |
| `login-form-missing`, `login-failed` | 2 | Läuft das Backend? Stimmen die Selektoren in `auth` und die Zugangsdaten? |
| `env-unreachable` | 2 | Umgebung starten (oder `--start` angeben, wenn sie einen `start`-Befehl hat), Adresse prüfen |
| `env-start-failed` | 2 | Der `start` der Umgebung endete mit Fehler: siehe Log-Ende und `.caw/env/<env>-start.log` |
| `env-not-ready` | 2 | `ready` antwortete nicht rechtzeitig unter 500: `ready.timeoutMs` erhöhen oder den `start`-Befehl prüfen |
| `env-reset-failed` | 2 | Der `reset` der Umgebung scheiterte oder dauerte länger als 10 Minuten; kein Test lief. Siehe `.caw/env/<env>-reset.log` |
| `app-not-loaded`, `app-not-settled` | 2 | Seite von Hand öffnen, Konsole ansehen |
| `browser-missing` | 2 | Google Chrome installieren oder `browser` in der Config setzen |
| `overlay-not-ready` | 2 | Der lokale Code-Server unter `overlay.url` antwortet nicht, liefert eine andere App, oder der Build fehlt: den `start`-Befehl aus der Meldung im App-Ordner ausführen oder `--start` angeben |
| `overlay-ssr` | 2 | Serverseitig gerenderte Seite: lokalen Code mit dem Dev-Server als Umgebung testen (`--env local`) |
| `overlay-incomplete` | 2 | Teile kamen vom Server statt aus dem lokalen Code (Mischstand): das vorgeschlagene `assetUrlPattern` eintragen oder `overlay check --apply` |
| `overlay-unused` | 2 | Nichts kam aus dem lokalen Code: Passen Build bzw. Dev-Server zur App, erfasst `assetUrlPattern` ihre Requests? |
| `overlay-ambiguous` | 2 | ExtJS: einer App in `app.json` einen eigenen `output.js.path` geben |
| `overlay-stale` | 2 | ExtJS: `bootstrap.json` des Watch nennt Dateien, die er nicht ausliefert. Warten, bis der Watch fertig gebaut hat, oder ihn neu starten |
| `claude-missing` | 2 | Claude Code installieren und anmelden, oder `--agent docker` |
| `token-missing` | 2 | `ANTHROPIC_API_KEY` setzen oder `--agent local` nutzen |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Docker mit Linux-Containern starten, oder `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Anmeldung an der Registry und `sandboxImage` prüfen |
| `aborted` | 2 | Du hast das Fenster geschlossen oder Strg+C gedrückt |
| `chat-failed`, `no-session` | 2 | Neu starten |
