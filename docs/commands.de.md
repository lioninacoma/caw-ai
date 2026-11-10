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
| [`validate`](#validate) | Config und Tests offline prüfen | nein |
| [`list`](#list) | Tests und Schritte mit Stand der Aufnahme auflisten | nein |
| [`record`](#record) | Einen Test aufnehmen oder seine Aufzeichnung ersetzen | ja |
| [`run`](#run) | Einen Test abspielen, oder mehrere für CI | nur auf Wunsch |
| [`fix`](#fix) | Einen Schritt neu aufnehmen | ja |
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

Öffnet die App in Chrome. Einmal anmelden, dann Enter drücken. caw-ai erkennt Framework, Anmeldeformular und eine Marke für „angemeldet“ und legt an:

- `caw.config.json`
- `caw/.env.example` mit den Variablen für die Zugangsdaten je Rolle
- `.claude/skills/caw-ai/SKILL.md` und einen Eintrag `caw-ai` in `.mcp.json`
- `caw/tests/` für deine Testpläne und `caw/caw.md` für Notizen, die Claude in jedem Lauf liest
- Einträge in `.gitignore` für `caw/.env`, `.caw/` und `caw/.auth/`

Was es nicht erkennen konnte, steht auf `TODO`. `doctor` und `validate` weisen dich darauf hin. Vorhandene Dateien bleiben unberührt.

| Option | |
|---|---|
| `--url <adresse>` | Adresse der App. Ohne fragt `init` nach. |
| `--yes` | Nicht aufs Anmelden warten, nichts fragen. Gut für Apps ohne Anmeldung. |
| `--from <datei>` | Ein vorhandenes Ergebnis von `explore` nehmen, statt die App zu öffnen. Gibt es `caw/.explore.json`, nimmt `init` es von selbst. |
| `--no-mcp` | `.mcp.json` nicht anfassen. |
| `--offline` | Die App nicht öffnen: die Vorlage schreiben, die Anmeldung bleibt `TODO`. Ohne Terminal und ohne `--url` macht `init` das von selbst. |
| `--insecure-tls` | Selbstsignierte Zertifikate annehmen (nur lokale Umgebungen). |

## explore

```bash
npx caw-ai explore --url http://localhost:5173
```

Wie `init`, schreibt aber nur Vorschläge nach `caw/.explore.json`: Framework, Anmeldeart und Selektoren, Marke für angemeldet, Startseite, Meldungen und Konsolenrauschen. Jeder Vorschlag hat `confidence: certain` oder `likely`. Die Datei übernimmt später `init --from`.

Optionen: `--yes`, `--insecure-tls` (wie bei `init`).

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

Prüft Node, Chrome, Claude Code (Agent `local`) oder Docker und Token (Agent `docker`), die Config, `TODO`-Werte, die Zugangsdaten je Rolle und ob jede Umgebung antwortet. Jede fehlgeschlagene Prüfung nennt den nächsten Schritt.

## validate

```bash
npx caw-ai validate
```

Prüft `caw.config.json` und alle Dateien in `caw/tests/` ohne Browser und ohne Claude. Fehler nennen Datei und Zeile. Gut für CI und Pre-Commit-Hooks.

Je Test und Ziel nennt es, welcher Code dort läuft, etwa `smoke (dev): lokaler Build aus dist` oder `smoke (staging): ausgelieferter Stand (Umgebung staging hat kein localCode)`. Hinweise, an denen die Prüfung nicht scheitert: Werte in `auth`, die noch `TODO` sind, alte Namen wie `agent` oder `source` und Einstellungen ohne Wirkung (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)).

## list

```bash
npx caw-ai list
npx caw-ai list create-ticket
```

Ohne Test: je Test eine Zeile mit Zielen, Stand der Aufnahme (`aufgenommen`, `veraltet (S2, S3)`, `nicht aufgenommen`) und ob er Daten schreibt. Mit Test: je Schritt eine Zeile, etwa `S2  Ticket anlegen  (veraltet)`. Ohne Browser und ohne Claude.

Einen Testnamen, den es nicht gibt, beantwortet caw-ai mit den bekannten Tests und bei einem Tippfehler mit dem nächstliegenden (`Meintest du create-ticket?`). Einen unbekannten Schritt mit den Schritten des Tests (`Schritte: S1–S6.`).

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
| `--code local\|deployed` | Welcher Code läuft, siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). Mit `deployed` behält ein neuer Test `code: deployed`. |
| `--agent local\|docker\|session` | Wo Claude läuft. Standard: `agent.sandbox` aus der Config, sonst `local`. |
| `--timeout <minuten>` | Zeitgrenze für Claude, Standard 60. |
| `--max-steps <n>` | Grenze für Claudes Browser-Aktionen, Standard `maxSteps` oder 100. |
| `--step-timeout <sekunden>` | Zeitgrenze je Schritt im Prüflauf, Standard 30. |

## run

```bash
npx caw-ai run create-ticket --target local
```

Spielt die Aufzeichnung ab. Kein Claude, keine Token. Auf Umgebungen, auf denen Claude arbeiten darf (`claude`), steht der Chat neben der App: Schlägt ein Schritt fehl, fragst du Claude dort nach der Ursache oder lässt den Schritt gleich beheben.

Mit Chat lernt der Lauf fehlende Vergleichswerte in `caw/recordings/<test>.yaml`. Am Ende sagt er, was sich geändert hat, etwa `Geändert: caw/recordings/create-ticket.yaml (Vergleichswerte S2, S5)`, oder `Testdatei unverändert.` Nach einem Fehlschlag nennt er die nächsten Aufrufe: einen Lauf mit Chat, der die Ursache klärt, und `--until` bis zum Schritt vor dem Fehler. Den Bericht gibt es zusätzlich als `file://`-Link.

| Option | |
|---|---|
| `--until <S4>` | Nach S4 anhalten, das Fenster bleibt offen. Schließt `--handover` ein; mit lokalem Build, wenn die Umgebung ihn erlaubt. |
| `--code local\|deployed` | Welcher Code läuft: der lokale Build oder der ausgelieferte Stand. Standard: `code` im Test und die Config, siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen). `local` auf einer Umgebung ohne `localCode` wird abgelehnt (Exit 3). |
| `--handover` | Fenster nach dem Lauf offen lassen. |
| `--advise` | Bei Fehlern oder Warnungen erklärt Claude die Ursache ungefragt. Kostet Token. |
| `--no-chat` | Sichtbares Fenster, kein Chat, kein Claude. Wie in der CI. |
| `--headless` | Kein Fenster, kein Chat. 1920×1080. |
| `--no-learn` | Mit Chat, aber ohne gelernte Vergleichswerte: Die Testdatei ändert sich nur, wenn du im Chat etwas übernimmst. |
| `--step-timeout <sekunden>` | Zeitgrenze je Schritt, Standard 30. |
| `--timeout <minuten>` | Zeitgrenze für Claude beim Untersuchen und Beheben, Standard 60. |
| `--max-steps <n>` | Grenze für Claudes Aktionen beim Beheben. |
| `--agent local\|docker\|session` | Wie bei `record`. |

Mit gesetztem `CI` hat `run` keinen Chat und startet nie Claude, wie `--no-chat`; `--until` und `--handover` werden abgelehnt (Exit 3), denn niemand übernähme den Browser. `record` und `fix` brauchen einen Menschen und werden in CI ebenfalls abgelehnt. Auf Runnern ohne Bildschirm zusätzlich `--headless` angeben oder `xvfb-run` nutzen.

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

Nimmt genau einen Schritt neu auf. Für einen Schritt, dessen Text du von Hand geändert hast, oder einen neuen Schritt am Ende. Die Schritte davor laufen ohne Claude. Die übrigen Schritte bleiben unverändert. Optionen: `--agent`, `--code`, `--timeout`, `--max-steps`, `--step-timeout`.

## auth

```bash
npx caw-ai auth user --target dev
```

Für `auth.type: storageState` (SSO, OAuth, MFA). Öffnet Chrome auf der Anmeldung. Du meldest dich von Hand an. Sobald `signedInSelector` erscheint, speichert caw-ai Cookies und Storage in `caw/.auth/<env>/<rolle>.json`. Erneut ausführen, wenn die Sitzung abläuft.

## mcp

Startet Claude Code über `.mcp.json`. Du rufst es nicht selbst auf. Deine Sitzung bekommt diese Tools:

| Tool | |
|---|---|
| `caw_start` | `run`, `record` oder `fix` mit `--agent session` starten |
| `caw_status` | Wartet ein Lauf auf die Sitzung? Letzte Zeilen der Ausgabe |
| `caw` | Die Agenten-Befehle (`snapshot`, `click`, `plan`, `finish`, …) |
| `caw_selection` | Das Element, das du mit dem Fadenkreuz in der Werkbank gewählt hast |

## Agenten-Befehle

`snapshot`, `click`, `fill`, `type`, `press`, `eval`, `check`, `goto`, `reload`, `wait-ready`, `console`, `network`, `screenshot`, `remember`, `plan`, `ask-operator`, `chat`, `say`, `recording`, `finish`, `advise`, `task`, `url`.

Nur über diese Befehle kann Claude den Browser bedienen. Sie sind für den Agenten während `record` und `fix` da; du brauchst sie nicht. `npx caw-ai help agent` listet ihre Argumente.

## Exit-Codes

| Code | |
|---|---|
| `0` | bestanden |
| `1` | fehlgeschlagen: Die App tut nicht, was der Test erwartet |
| `2` | Fehler: Die Umgebung hat ein Urteil verhindert (Server aus, Anmeldung fehlgeschlagen, Chrome fehlt, …), oder ein unerwarteter interner Fehler (der Stack steht in der Ausgabe) |
| `3` | abgewiesen: Aufruf, Config oder Testdatei ungültig. Es lief nichts. |
| `4` | Aufnahme nötig: Die Aufzeichnung fehlt (`record`) oder ein Schritt hat sich seit der Aufnahme geändert (`fix`). Es lief nichts. |

## Umgebungsvariablen

| Variable | |
|---|---|
| `CAW_LANG` | `en` oder `de`. Hat Vorrang vor `language` in der Config. |
| `CAW_AI_HOME` | Ordner für persönliche Einstellungen (`prefs.json`). Standard `%APPDATA%\caw-ai` oder `~/.config/caw-ai`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token für den Agenten `docker`. Erzeugen mit `claude setup-token`. |
| `CAW_DOCKER` | Nur Windows: `windows` oder `wsl` legt den Weg zu Docker fest. |
| `CI` | Gesetzt: kein Chat, nur Agent `docker`; `record`, `fix`, `--until` und `--handover` werden abgelehnt. |
| `NO_COLOR`, `FORCE_COLOR` | Farben im Terminal aus oder an. |
| `MCP_TOOL_TIMEOUT` | In der Umgebung von Claude Code: erhöhen, wenn `plan` oder `chat` in deiner Sitzung abbrechen. |

## Fehlercodes

Bricht caw-ai ab, nennt es zuerst den Grund und danach den Code.

| Code | Exit | Abhilfe |
|---|---|---|
| `usage`, `unknown-command` | 3 | `npx caw-ai <befehl> --help` |
| `config-missing` | 3 | `npx caw-ai init --url <adresse>` |
| `config-invalid` | 3 | Das genannte Feld korrigieren, dann `doctor` |
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
| `watch-missing`, `watch-stale`, `local-code` | 2 | Den Watch deines Frameworks starten |
| `claude-missing` | 2 | Claude Code installieren und anmelden, oder `--agent docker` |
| `token-missing` | 2 | `CLAUDE_CODE_OAUTH_TOKEN` setzen |
| `docker-missing`, `docker-not-running`, `docker-wrong-mode` | 2 | Docker mit Linux-Containern starten, oder `--agent local` |
| `image-build-failed`, `devcontainer-unsupported` | 2 | Anmeldung an der Registry und `sandboxImage` prüfen |
| `aborted` | 2 | Du hast das Fenster geschlossen oder Strg+C gedrückt |
| `chat-failed`, `no-session` | 2 | Neu starten |
