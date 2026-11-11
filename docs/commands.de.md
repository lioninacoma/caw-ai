[English](commands.md) · Deutsch

# Befehle

Jeder Befehl läuft im Wurzelordner deines Projekts: `npx caw-ai <befehl>` (oder `pnpm exec`, `yarn`). `<env>` ist ein Name aus `environments` in `caw.config.json`, etwa `local`. Mit Mandanten (`sites`) heißt es `mandant/env`, etwa `nord/dev`.

`--target` darf fehlen, wenn die Wahl klar ist: `run`, `record` und `fix` nehmen dann das einzige Ziel des Tests (bei `record` und `fix` das einzige davon, auf dem Claude arbeiten darf; bei `record` eines neuen Tests die einzige Umgebung, auf der Claude arbeiten darf). Das Terminal nennt die Wahl, etwa `› Ziel: local (einziges Ziel von create-ticket)`. Ist sie nicht eindeutig, bricht der Befehl ab und nennt die Auswahl: `--target fehlt: local, dev`.

| Befehl | Was er tut | Claude? |
|---|---|---|
| [`init`](#init) | Projekt einrichten: App ansehen, Config, Skill und `.mcp.json` schreiben | nein |
| [`explore`](#explore) | App ansehen und Einstellungen vorschlagen, sonst nichts schreiben | nein |
| [`skill`](#skill) | Skill für Claude Code und `.mcp.json` anlegen oder aktualisieren | nein |
| [`doctor`](#doctor) | Rechner, Config, Zugangsdaten und Umgebungen prüfen | nein |
| [`overlay check`](#overlay-check) | Prüfen, ob `--overlay` alles ersetzt, was es soll | nein |
| [`validate`](#validate) | Config und Tests offline prüfen | nein |
| [`list`](#list) | Tests und Schritte mit Stand der Aufnahme auflisten | nein |
| [`record`](#record) | Einen Test aufnehmen oder seine Aufzeichnung ersetzen | ja |
| [`run`](#run) | Einen Test abspielen, oder mehrere für CI | nur auf Wunsch |
| [`fix`](#fix) | Einen Schritt neu aufnehmen | ja |
| [`open`](#open) | Die App angemeldet öffnen, mit Werkbank und Chat, ohne Test | nur auf Wunsch |
| [`auth`](#auth) | Von Hand anmelden und die Sitzung speichern (SSO) | nein |
| [`mcp`](#mcp) | MCP-Server für deine eigene Claude-Code-Sitzung | – |

`npx caw-ai help` zeigt dieselbe Übersicht im Terminal. `npx caw-ai <befehl> --help` (oder `-h`, an beliebiger Stelle) zeigt nur diesen Befehl, `npx caw-ai help agent` die Befehle für den Agenten. `npx caw-ai --version` zeigt die Version.

Bricht ein Befehl ab, steht im Terminal zuerst der Grund, bei einem ungültigen Aufruf dann die Kurzform des Befehls, zuletzt Code und Exit-Code:

```
✗ fix erwartet einen Schritt wie S4.
  Aufruf: caw-ai fix <test> <S4> [--target <umgebung>]
  (code: usage, exit 3)
```

Eine Option, die einen Wert braucht, nimmt nie die nächste Option als Wert: `--target --headless` bricht ab mit `--target braucht einen Wert, etwa --target local`.

## init

```bash
npx caw-ai init --url http://localhost:5173
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
| `--from <datei>` | Ein vorhandenes Ergebnis von `explore` nehmen, statt die App zu öffnen. Gibt es `caw/.explore.json`, nimmt `init` es von selbst. |
| `--no-mcp` | `.mcp.json` nicht anfassen. |
| `--offline` | Die App nicht öffnen: die Vorlage schreiben, die Anmeldung bleibt `TODO`. Ohne Terminal und ohne `--url` macht `init` das von selbst. |
| `--insecure-tls` | Selbstsignierte Zertifikate annehmen (nur lokale Umgebungen). |

## explore

```bash
npx caw-ai explore --url http://localhost:5173
```

Wie `init`, schreibt aber nur Vorschläge nach `caw/.explore.json`: Framework, Anmeldeart und Selektoren, Marke für angemeldet, Startseite, Meldungen und Konsolenrauschen. Jeder Vorschlag hat `confidence: certain` oder `likely`. Die Datei übernimmt später `init --from`.

Optionen: `--yes`, `--insecure-tls` (wie bei `init`); `--login` oder `--no-login` beantworten die Frage nach der Anmeldung für Skripte.

Mit Anmeldung fragt die Karte danach nach der Rolle des benutzten Kontos und speichert es als Testnutzer (siehe [role](#role)); `init` übernimmt die Rollen von dort.

## skill

```bash
npx caw-ai skill
```

Legt `.claude/skills/caw-ai/SKILL.md` und den Eintrag in `.mcp.json` an oder bringt sie auf den neuen Stand. Nach jedem Update von caw-ai ausführen. Danach in Claude Code „Richte caw-ai ein“ sagen, und es führt dich durch `init` und `doctor`.

## doctor

```bash
npx caw-ai doctor
npx caw-ai doctor --agent docker
```

Prüft Node, Chrome, Claude Code (Agent `local`) oder Docker und Token (Agent `docker`), die Config, `TODO`-Werte, die Zugangsdaten je Rolle und ob jede Umgebung antwortet. Jede fehlgeschlagene Prüfung nennt den nächsten Schritt. Bei einer ungültigen Config zeigt es den ersten Befund, `validate` alle. Platzhalter-Adressen (`example.com`, `.test`, `.invalid`) meldet es, ohne sie anzufragen.

Bei ExtJS und einer Umgebung mit `overlay: true` kommen je App optionale Zeilen dazu: `bootstrap.json` vorhanden und aktuell, der Sencha-Watch läuft, und je Teil (App, Paket) das Ergebnis des letzten `overlay check` mit Alter, sonst der Hinweis, einen zu starten. doctor startet den Watch nie.

## overlay check

```bash
npx caw-ai overlay check
npx caw-ai overlay check --target dev --apply
npx caw-ai overlay check --json
```

Öffnet die App headless mit `--overlay` (angemeldet, ohne Schritte, ohne Claude) und vergleicht die Skript-Requests der Seite mit dem, was das Overlay ersetzen soll. Bei ExtJS sind das die App und jedes eigene Paket aus `bootstrap.json`, `x.js` und `x-debug.js` zählen als ein Teil. Je Teil steht `lokal`, `ausgeliefert` oder `nicht geladen` (vielleicht erst später).

Ein Teil `ausgeliefert` heißt Mischstand: Die Seite lief teils mit deinem Code, teils mit dem des Servers. Die Skript-URLs werden über den Dateinamen erkannt, unabhängig von `assetUrlPattern`; so findet die Prüfung auch Quellen, die die Config nicht kennt. Für jede schlägt sie ein Muster vor:

```
✓ aekwl-theme-material: lokal
! AllgemeineVorgangsbearbeitungAntragstellung: ausgeliefert
› https://dev.example.com/o/FormProxyServlet?url=inubitrepository:///Root/ (5 Skript(e)): assetUrlPattern "[?&]url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)"
```

`--apply` trägt die vorgeschlagenen Muster in `assetUrlPattern` in `caw.config.json` ein (nur fehlende; ein einzelner Text wird zur Liste), prüft die Datei vor dem Schreiben und prüft danach noch einmal. Eine Quelle ohne sicheres Muster wird als solche gemeldet; dann trägst du eins von Hand ein.

Vor dem Browser prüft es die Voraussetzungen: Die Umgebung erlaubt das Overlay, der App-Ordner hat `app.json`, `bootstrap.json` ist aktuell und der Watch läuft. Ohne Watch hört es mit dem Befehl auf (`sencha app watch` im App-Ordner) und startet ihn nie selbst, außer die App hat `overlay.devCommand`.

`--target` ist ohne Angabe die einzige Umgebung mit `overlay: true`, `--app` und `--role` die einzige App und die erste Rolle. Das Ergebnis steht immer in `.caw/overlay-check.json` (`at`, `target`, `app`, `state`, `parts`, `missed`, `notLoaded`, `suggestions`, `unresolved`, nach `--apply` auch `applied`). `--json` gibt es als einzige Zeile auf stdout aus. Exit 0 vollständig, 2 unvollständig oder Watch-Problem, 3 keine Overlay-Umgebung oder keine App.

## validate

```bash
npx caw-ai validate
```

Prüft `caw.config.json` und alle Dateien in `caw/tests/` ohne Browser und ohne Claude. Fehler nennen Datei und Zeile, alle auf einmal. Gut für CI und Pre-Commit-Hooks.

Werte in `auth`, die noch `TODO` sind, lassen die Prüfung scheitern (Exit 3, Code `config-invalid`); jeder sagt, was hineingehört. Config-Felder aus 0.1.0 (`agent` und `localCode` an einer Umgebung, `statics`, `redirects` und `constants` an einer App) nennen ihren neuen Platz, siehe [Upgrade](upgrading.md).

Je Test und Ziel nennt es, welcher Code dort läuft und wo `--overlay` ginge, etwa `smoke (staging): ausgelieferter Stand` oder `smoke (dev): ausgelieferter Stand; mit --overlay: Overlay, Build dist`. Hinweise, an denen die Prüfung nicht scheitert: Einstellungen ohne Wirkung, etwa eine App mit `overlay`, während keine Umgebung es erlaubt (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)).

## list

```bash
npx caw-ai list
npx caw-ai list create-ticket
```

Ohne Test: je Test eine Zeile mit Zielen, Stand der Aufnahme (`aufgenommen`, `veraltet (S2, S3)`, `nicht aufgenommen`) und ob er Daten schreibt. Mit Test: je Schritt eine Zeile, etwa `S2  Ticket anlegen  (veraltet)`. Ohne Browser und ohne Claude.

Ohne `caw.config.json` bricht es ab wie jeder andere Befehl (`config-missing`). Einen Testnamen, den es nicht gibt, beantwortet caw-ai mit den bekannten Tests und bei einem Tippfehler mit dem nächstliegenden (`Meintest du create-ticket?`); `record <name>` bietet es nur für einen neuen Test an. Einen unbekannten Schritt mit den Schritten des Tests (`Schritte: S1–S6.`).

## record

```bash
npx caw-ai record create-ticket --target local
```

Nimmt den Testplan aus `caw/tests/create-ticket.yaml` auf, oder legt einen neuen Test an, wenn es die Datei nicht gibt. Chrome öffnet sich mit Werkbank und Chat:

1. Du führst den Ablauf vor, oder Claude geht dem Testplan nach.
2. Claude zeigt einen Plan im Chat. Du gibst ihn frei oder schreibst, was sich ändern soll.
3. Claude geht den Ablauf durch und prüft jeden Schritt.
4. caw-ai spielt die Aufzeichnung ohne Claude ab.
5. Du wählst „Testplan übernehmen“. Erst dann werden Dateien geschrieben.

Nur auf Umgebungen, auf denen Claude arbeiten darf (`"claude": true`). Gibt es nur eine, darf `--target` fehlen.

| Option | |
|---|---|
| `--role <rolle>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine Rolle hat. |
| `--app <app>` | Nur beim ersten Aufnehmen. Unnötig, wenn die Config nur eine App hat. |
| `--also <app>` | Nur beim ersten Aufnehmen: Der Ablauf geht in einer weiteren App des Projekts weiter. |
| `--read-only` | Nur beim ersten Aufnehmen: Der Test schreibt keine Daten (`mutates: false`). |
| `--overlay [build\|dev\|<url>]` | Lokalen Code über die ausgelieferte Umgebung legen, siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). |
| `--agent local\|docker\|session` | Wo Claude läuft. Standard: `agent.sandbox` aus der Config, sonst `local`. |
| `--timeout <minuten>` | Zeitgrenze für Claude, Standard 60. |
| `--max-steps <n>` | Grenze für Claudes Browser-Aktionen, Standard `maxSteps` oder 100. |
| `--step-timeout <sekunden>` | Zeitgrenze je Schritt im Prüflauf, Standard 30. |

## run

```bash
npx caw-ai run create-ticket --target local
```

Spielt die Aufzeichnung ab. Kein Claude, keine Token. Auf Umgebungen, auf denen Claude arbeiten darf (`claude`), steht der Chat neben der App: Schlägt ein Schritt fehl, fragst du Claude dort nach der Ursache oder lässt den Schritt gleich beheben.

Mit Chat lernt der Lauf fehlende Vergleichswerte in `caw/recordings/<test>.yaml`. Am Ende sagt er, was sich geändert hat, etwa `Geändert: caw/recordings/create-ticket.yaml (Vergleichswerte S2, S5)`, oder `Testdatei unverändert.` Nach einem Fehlschlag nennt er den Grund des gescheiterten Schritts (auch mit `--headless` und in CI) und die nächsten Aufrufe: einen Lauf mit Chat, der die Ursache klärt, und `--until` bis zum Schritt vor dem Fehler. Den Bericht gibt es zusätzlich als `file://`-Link. In `report.md` stehen Schritte nach dem gescheiterten auf `skipped`, Screenshots verlinken in den Ordner `agent/` des Laufs.

| Option | |
|---|---|
| `--until <S4>` | Nach S4 anhalten, das Fenster bleibt offen. Schließt `--handover` ein. Läuft wie jeder Lauf mit dem ausgelieferten Stand, außer du gibst `--overlay` an. |
| `--overlay [build\|dev\|<url>]` | Lokalen Code über die ausgelieferte Umgebung legen: der Build-Ordner, der Dev-Server oder der Dev-Server unter `<url>`; ohne Wert die eine konfigurierte Quelle. Nur auf Umgebungen mit `"overlay": true`. Ohne die Option läuft immer der ausgelieferte Stand. Siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). |
| `--handover` | Fenster nach dem Lauf offen lassen. |
| `--advise` | Bei Fehlern oder Warnungen erklärt Claude die Ursache ungefragt. Kostet Token. |
| `--no-chat` | Sichtbares Fenster, kein Chat, kein Claude. Wie in der CI. |
| `--headless` | Kein Fenster, kein Chat. 1920×1080. |
| `--no-learn` | Mit Chat, aber ohne gelernte Vergleichswerte: Die Testdatei ändert sich nur, wenn du im Chat etwas übernimmst. |
| `--step-timeout <sekunden>` | Zeitgrenze je Schritt, Standard 30. |
| `--timeout <minuten>` | Zeitgrenze für Claude beim Untersuchen und Beheben, Standard 60. |
| `--max-steps <n>` | Grenze für Claudes Aktionen beim Beheben. |
| `--agent local\|docker\|session` | Wie bei `record`. |

Mit gesetztem `CI` hat `run` keinen Chat und startet nie Claude, wie `--no-chat`; `--until` und `--handover` werden abgelehnt (Exit 3), denn niemand übernähme den Browser. `record`, `fix` und `open` brauchen einen Menschen und werden in CI ebenfalls abgelehnt. Auf Runnern ohne Bildschirm zusätzlich `--headless` angeben oder `xvfb-run` nutzen.

### Mehrere Tests (CI)

```bash
npx caw-ai run --all --target dev --headless --report junit=caw-junit.xml
npx caw-ai run create-ticket close-ticket --target dev
```

Spielt die Tests nacheinander ab, ohne Chat (`--advise`, `--handover` und `--until` werden abgelehnt). `--all` nimmt jeden Test, der das Ziel nennt. Ohne `--target` gilt das einzige Ziel der Tests. Ein Test, der nicht laufen kann (Aufnahme fehlt, Tippfehler), hält die anderen nicht auf. Am Ende zeigt eine Tabelle je Test `PASS`, `FAIL`, `ERROR`, `AUFNAHME NÖTIG` oder `ABGELEHNT`. Der Exit-Code ist der des schlimmsten Laufs, in dieser Reihenfolge: `2` error > `1` fail > `4` Aufnahme nötig > `3` abgelehnt > `0` pass.

`--report junit=<datei>` schreibt die Tabelle zusätzlich als JUnit-XML (relativ zum Projektordner): `fail` als `<failure>`, alles andere, was nicht bestanden hat, als `<error>`.

## fix

```bash
npx caw-ai fix create-ticket S2 --target local
```

Nimmt genau einen Schritt neu auf. Für einen Schritt, dessen Text du von Hand geändert hast, oder einen neuen Schritt am Ende. Die Schritte davor laufen ohne Claude. Die übrigen Schritte bleiben unverändert. Optionen: `--agent`, `--overlay`, `--timeout`, `--max-steps`, `--step-timeout`.

## open

```bash
npx caw-ai open --target dev --overlay
```

Öffnet die App angemeldet, mit Werkbank und Chat, ohne Test: navigieren, ausprobieren, mit Claude entwickeln. Wie `run --until` ohne Schritte davor. Lernt nichts und schreibt keine Testdatei. Ohne `--target` nimmt es die einzige Umgebung, auf der Claude arbeiten darf.

| Option | |
|---|---|
| `--role <rolle>`, `--app <app>` | Nicht nötig, wenn die Config nur eine hat. |
| `--overlay [build\|dev\|<url>]` | Wie bei `run`. |
| `--agent local\|docker\|session`, `--timeout <minuten>`, `--max-steps <n>` | Wie bei `record`. |

Nach der Übergabe wählt **F1** in der Werkbank einen Zustand: einen beliebigen Test dieser Umgebung (und optional den Schritt, bis zu dem er läuft). caw-ai beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet sich mit dem Konto der Rolle des Tests neu an und spielt ihn im selben Fenster ab, ohne Claude. Bei Basic-Auth nur Tests der eigenen Rolle.

Scheitert das Herstellen an etwas, das nicht immer kommt (etwa ein Cookie-Banner, der schon weg ist), frag im Chat: Claude kann den Klick optional machen. Was du übernimmst, steht sofort in der Testdatei. Beim Aufnehmen geht das direkt mit `click <ziel> --optional`.

## auth

```bash
npx caw-ai auth user --target dev
```

Für `auth.type: storageState` (SSO, OAuth, MFA). Öffnet Chrome auf der Anmeldung. Du meldest dich von Hand an. Sobald `signedInSelector` erscheint, speichert caw-ai Cookies und Storage in `caw/.auth/<env>/<rolle>.json`. Erneut ausführen, wenn die Sitzung abläuft.

## role

```bash
npx caw-ai role                          # Rollen, ob ein Testnutzer gesetzt ist (nie die Werte), Tests je Rolle
npx caw-ai role add sb --target dev      # Fenster auf der Anmeldeseite: anmelden, Rolle speichern
npx caw-ai role remove sb                # nur wenn kein Test sie nutzt
```

Eine Rolle ist ein Testnutzer. `role add` öffnet die Anmeldeseite der Umgebung. Du meldest dich mit dem Testkonto an; die Karte nennt die Rolle (vorbelegt, änderbar), und **Speichern** schreibt Benutzername und Passwort in `caw/.env`, die Rolle mit ihren Variablennamen in `caw.config.json` und `caw/.env` in `.gitignore`. **+ Weitere Rolle** meldet ab und nimmt das nächste Konto. Die Werte gehen von der Seite direkt in die Datei: nicht zu Claude, nicht ins Terminal, nicht in `caw/.explore.json`.

`explore` und `init` enden genauso: Nach **Fertig** fragt die Karte nach der Rolle des Kontos, mit dem du dich angemeldet hast. Braucht `record`, `run` oder `open` eine Rolle ohne Testnutzer, öffnet sich zuerst das Fenster, und nach **Speichern** geht der Lauf weiter; in CI und mit `--headless` endet er mit `credentials-missing`. Bei `auth.type: storageState` gilt `auth`.

## theme

```bash
npx caw-ai theme                 # Themes auflisten, aktives markiert
npx caw-ai theme use phosphor    # eines wählen
npx caw-ai theme check mein-theme  # Schema, Kontrast, Markenbreite, Schriften
```

Das Theme gehört dir, steht in `prefs.json` und gilt in allen Projekten. Eingebaut: `nacht` (Standard), `bernstein`, `phosphor`. Farben, Zeichen, Rabe und CRT-Look änderst du mit F7 in der Werkbank; eigene Themes sind Ordner neben `prefs.json`. Details: [themes/README.de.md](../themes/README.de.md).

## mcp

Startet Claude Code über `.mcp.json`. Du rufst es nicht selbst auf. Deine Sitzung bekommt diese Tools:

| Tool | | Tokens |
|---|---|---|
| `caw_doctor` | `doctor` als Daten | nein |
| `caw_init` | `init` ohne Rückfragen (`offline`, `fromExplore`, `roles`, `noMcp`) | nein |
| `caw_explore` | `explore` im Hintergrund starten (`login` oder `yes`) | nein |
| `caw_role` | Rollen als Daten (`list`), das Anmeldefenster für eine neue (`add`, `name`, `target`), `remove`; nie Benutzernamen oder Passwörter | nein |
| `caw_config` | Config lesen oder geprüft ändern (`patch`, `dryRun`) | nein |
| `caw_validate` | `validate` als Daten | nein |
| `caw_list` | `list` als Daten | nein |
| `caw_overlay_check` | `overlay check` (`target`, `app`, `apply`), wartet auf das Ergebnis | nein |
| `caw_start` | `run`, `record`, `fix` oder `open` mit `--agent session` starten (`test`, `target`, `step`, `until`, `overlay`, `headless` oder `args`) | nur deine Session |
| `caw_status` | Wartet ein Lauf auf die Sitzung? Letzte Zeilen der Ausgabe; Ergebnis und Artefakte des letzten Laufs als Daten | nein |
| `caw` | Die Agenten-Befehle (`snapshot`, `click`, `plan`, `finish`, …) | im Lauf |
| `caw_selection` | Das Element, das du mit dem Fadenkreuz in der Werkbank gewählt hast | nein |

Ergebnisse kommen als kurzer Text plus `structuredContent` (JSON).

## Agenten-Befehle

`snapshot`, `click`, `fill`, `type`, `press`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

Nur über diese Befehle kann Claude den Browser bedienen. Sie sind für den Agenten während `record` und `fix` da; du brauchst sie nicht. `npx caw-ai help agent` listet ihre Argumente.

## Exit-Codes

| Code | |
|---|---|
| `0` | bestanden |
| `1` | fehlgeschlagen: Die App tut nicht, was der Test erwartet |
| `2` | Fehler: Die Umgebung hat ein Urteil verhindert (Server aus, Anmeldung fehlgeschlagen, Chrome fehlt, …), oder ein unerwarteter interner Fehler (der Stack steht in der Ausgabe) |
| `3` | abgewiesen: Aufruf, Config (auch `TODO`-Werte aus `init`) oder Testdatei ungültig. Es lief nichts. |
| `4` | Aufnahme nötig: Die Aufzeichnung fehlt (`record`) oder ein Schritt hat sich seit der Aufnahme geändert (`fix`). Es lief nichts. |

## Umgebungsvariablen

| Variable | |
|---|---|
| `CAW_LANG` | `en` oder `de`. Hat Vorrang vor `language` in der Config. |
| `CAW_AI_HOME` | Ordner für persönliche Einstellungen (`prefs.json`). Standard `%APPDATA%\caw-ai` oder `~/.config/caw-ai`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token für den Agenten `docker`. Erzeugen mit `claude setup-token`. |
| `CAW_DOCKER` | Nur Windows: `windows` oder `wsl` legt den Weg zu Docker fest. |
| `CI` | Gesetzt: kein Chat, nur Agent `docker`; `record`, `fix`, `open`, `--until` und `--handover` werden abgelehnt. |
| `NO_COLOR`, `FORCE_COLOR` | Farben im Terminal aus oder an. |
| `MCP_TOOL_TIMEOUT` | In der Umgebung von Claude Code: erhöhen, wenn `plan` oder `chat` in deiner Sitzung abbrechen. |

## Fehlercodes

Bricht caw-ai ab oder endet ein Lauf mit `error`, nennt es zuerst den Grund und danach den Code.

| Code | Exit | Abhilfe |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw-ai <befehl> --help` |
| `config-missing` | 3 | `npx caw-ai init --url <adresse>` |
| `config-invalid` | 3 | Das genannte Feld korrigieren oder die `TODO`-Werte eintragen, dann `doctor` |
| `test-missing`, `test-invalid` | 3 | Testdatei anlegen oder korrigieren, dann `validate` |
| `replay-missing` | 4 | Test mit `record` aufnehmen |
| `replay-stale` | 4 | Ein Schritt hat sich seit der Aufnahme geändert: `fix <test> <schritt>` |
| `step-unknown` | 3 | Eine Schritt-ID aus der Testdatei nehmen (`list <test>`) |
| `target-invalid`, `target-denied` | 3 | Eine Umgebung aus der Config nehmen; Produktion lässt sich nicht aufnehmen |
| `write-protected` | 3 | Aufnehmen und schreibende Tests brauchen `claude` / `writable` an der Umgebung |
| `auth-missing` | 3 | Datei unter `caw/.auth/` löschen und `auth` erneut ausführen |
| `credentials-missing` | 2 | `caw/.env` nach `caw/.env.example` füllen |
| `login-form-missing`, `login-failed` | 2 | Läuft das Backend? Stimmen die Selektoren in `auth` und die Zugangsdaten? |
| `target-unreachable`, `unreachable` | 2 | Dev-Server starten, Adresse prüfen |
| `app-not-loaded`, `app-not-settled` | 2 | Seite von Hand öffnen, Konsole ansehen |
| `browser-missing` | 2 | Google Chrome installieren oder `browser` in der Config setzen |
| `overlay-not-ready` | 2 | Dev-Server starten oder bauen, oder `devCommand` / `buildCommand` an der App eintragen; die Meldung nennt den Befehl |
| `overlay-ssr` | 2 | Serverseitig gerenderte Seite: lokalen Code mit dem Dev-Server als Umgebung testen (`--target local`) |
| `overlay-incomplete` | 2 | Teile kamen vom Server statt aus dem lokalen Code (Mischstand): das vorgeschlagene `assetUrlPattern` eintragen oder `overlay check --apply` |
| `overlay-unused` | 2 | Nichts kam aus dem lokalen Code: Passen Build bzw. Dev-Server zur App, erfasst `assetUrlPattern` ihre Requests? |
| `overlay-ambiguous` | 2 | ExtJS: einer App in `app.json` einen eigenen `output.js.path` geben |
| `watch-missing`, `watch-stale` | 2 | Den Sencha-Watch starten (`sencha app watch`) oder `devCommand` eintragen |
| `claude-missing` | 2 | Claude Code installieren und anmelden, oder `--agent docker` |
| `token-missing` | 2 | `CLAUDE_CODE_OAUTH_TOKEN` setzen |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Docker mit Linux-Containern starten, oder `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Anmeldung an der Registry und `sandboxImage` prüfen |
| `aborted` | 2 | Du hast das Fenster geschlossen oder Strg+C gedrückt |
| `chat-failed`, `no-session` | 2 | Neu starten |
