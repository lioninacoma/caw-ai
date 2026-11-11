[English](README.md) · Deutsch

# caw-ai

[![CI](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/lioninacoma/caw-ai/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/caw-ai)](https://www.npmjs.com/package/caw-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **caw** – **c**onstrained **a**gentic **w**ebtester
>
> Integrationstests für Web-Apps, in normaler Sprache geschrieben. Claude nimmt jeden Test einmal auf, abgespielt wird ohne KI.
>
> *Constrained*, weil der Agent Grenzen hat: Claude steuert den Browser nur über einen festen Satz Befehle, erreicht nur die Hosts aus deiner Config, sieht nie deine Zugangsdaten, und jede Aufnahme endet mit einem Plan, den du freigibst.

<img src="docs/media/demo.webp" width="720" alt="caw-ai nimmt einen Test des Errand-Beispiels auf: Claude legt den Testplan vor, arbeitet ihn in der App ab und beantwortet eine Frage im Chat; danach spielt caw-ai die Aufnahme ohne KI ab und der Plan wird übernommen">

Jeder Schritt beschreibt eine Aktion und das erwartete Ergebnis:

```yaml
# caw/tests/first-errand.yaml
steps:
  - id: S1
    name: Todo anlegen
    do: Lege das Todo "Feed the raven {{runTag}}" mit dem Tag "#home" an.
    expect: Eine Bestätigung nennt die Nummer des neuen Todos, und es steht oben in der Liste.
```

Einmal aufnehmen, dann abspielen:

```bash
npx caw-ai record first-errand --target local   # Claude führt die Schritte in Chrome aus, du gibst das Ergebnis frei
npx caw-ai run first-errand --target local      # spielt die Aufzeichnung ab, ohne Claude
```

## Funktionsweise

- Tests sind YAML-Dateien mit Schritten in normaler Sprache. Beim Aufnehmen führt Claude jeden Schritt in Chrome aus und speichert die Ziele über Rolle, Beschriftung und Text, nicht als CSS-Selektoren.
- Das Abspielen nutzt nur die Aufzeichnung. Es ist deterministisch und verbraucht keine Token, lokal wie in der CI.
- Schlägt ein Schritt fehl, zeigt der Chat neben der App die Ursache. `fix` nimmt nur diesen Schritt neu auf.
- Nach einem Lauf gehört dir das Fenster: F1 stellt den Zustand jedes Tests in einer frischen Sitzung her, und Claude im Chat kann die Seite bedienen, ein eingefügtes Bugticket nachstellen und die Korrektur im Code vorschlagen.
- Fehler werden als Test, Anwendung oder Umgebung eingeordnet, anhand von Requests, Konsolenausgaben und den Änderungen an der Seite bei der Aufnahme.
- Claude steuert den Browser über einen festen Satz Befehle, erreicht nur die konfigurierten Hosts und bekommt keine Zugangsdaten.
- Unterstützt: reine Web-Apps, React, Vue, Angular und ExtJS.

## Voraussetzungen

- Node 22+ und Google Chrome unter Windows oder Linux (macOS ungetestet)
- [Claude Code](https://claude.com/claude-code), nur zum Aufnehmen und Reparieren
- Docker, nur wenn Claude im Container laufen soll (`--agent docker`)

## Installation

```bash
npm i -D caw-ai
```

## Verwendung

App starten, dann:

```bash
npx caw-ai init --url http://localhost:5173   # öffnet die App; einmal anmelden, Enter drücken
cp caw/.env.example caw/.env                  # Testkonto eintragen
npx caw-ai doctor                             # listet auf, was noch fehlt
```

Einen Test in `caw/tests/smoke.yaml` beschreiben:

```yaml
id: smoke
app: web
role: tester
targets: [local]
mutates: false
steps:
  - id: S1
    name: Dashboard öffnen
    do: Öffne "Dashboard" in der Navigation.
    expect: Das Dashboard ist sichtbar.
```

Einmal aufnehmen, ab dann abspielen:

```bash
npx caw-ai record smoke --target local
npx caw-ai run smoke --target local
```

[`examples/errand`](examples/errand) ist eine kleine Todo-App mit Anmeldung und aufgenommenem Test, den du sofort abspielen kannst; siehe [`examples`](examples).

### Häufige Befehle

| Aufgabe | Befehl |
|---|---|
| Einen Test laufen lassen | `caw-ai run <test> --target local` |
| Wie in der CI laufen lassen | `caw-ai run <test> --target local --headless` |
| Einen neuen Test aufnehmen | `caw-ai record <test> --target local` |
| Einen geänderten Schritt aktualisieren | `caw-ai fix <test> S3 --target local` |
| Die App in einen Zustand bringen und dort weiterentwickeln | `caw-ai run <test> --target local --until S3` |
| Die App angemeldet öffnen, ohne Test | `caw-ai open --target local` |
| Lokalen Code in einer ausgelieferten Umgebung testen | `caw-ai run <test> --target dev --overlay` |
| Fehler sofort von Claude erklären lassen | `caw-ai run <test> --target local --advise` |
| Config und Tests prüfen | `caw-ai validate` |
| Theme wählen (ändern mit F7 in der Werkbank) | `caw-ai theme use phosphor` |

Exit-Codes: `0` bestanden, `1` fehlgeschlagen, `2` Fehler der Umgebung, `3` Eingabe abgewiesen, `4` Aufnahme nötig. Alle Befehle und Optionen: [docs/commands.de.md](docs/commands.de.md).

### In der CI

```yaml
- run: npx caw-ai validate
- run: npx caw-ai run smoke --target staging --headless
```

Mit gesetztem `CI` gibt es keinen Chat, und Claude wird nicht gestartet. Lokal aufnehmen und reparieren, Dateien committen, in der CI abspielen.

### Aus Claude Code

`init` legt auch einen Skill und einen MCP-Server an. Dann in Claude Code:

```
/caw-ai nimm einen Test fürs Anlegen eines Tickets auf
/caw-ai bring mich zur Detailseite des Tickets, ich will am Statusfeld arbeiten
```

## Nach dem Lauf

Das Fenster bleibt offen, angemeldet, im Zustand, den der Test erreicht hat. Von dort aus:

### Zustand herstellen

F1 listet jeden Test der Umgebung, für jede Rolle. Test und Schritt wählen; caw-ai meldet sich frisch mit dem Konto der Rolle an und spielt bis dorthin ab.

<img src="docs/media/states.webp" width="720" alt="Der F1-Dialog „Zustand wählen“ zeigt den Test first-errand mit den Schritten S1 bis S4">

### Entwickeln

Ein Element in der App wählen und danach fragen. Claude liest deinen Quellcode und antwortet mit Datei und Zeile. Gegen deinen Dev-Server oder mit `--overlay` dein lokaler Code über einer deployten Umgebung; F5 lädt deine Änderung.

<img src="docs/media/develop.webp" width="720" alt="Ein Element ist in der App gewählt; Claude erklärt im Chat mit server.mjs:134, warum „Add todo“ gesperrt ist">

### Bug mit Claude beheben

Ein Bugticket in den Chat einfügen. Claude stellt es im erreichten Zustand nach, nennt die Ursache und schlägt die Korrektur als Änderung an deinem Code vor; „Änderung übernehmen“ schreibt sie.

<img src="docs/media/bugfix.webp" width="720" alt="Claude stellt einen Fehler in der Suche nach und schlägt eine Änderung an server.mjs mit dem Knopf „Apply change“ vor">

### Themes

Drei eingebaute Themes oder ein eigenes: F7 öffnet den Editor für Farben, Glyphen, den Raben und den CRT-Look.

<img src="docs/media/themes.webp" width="720" alt="Dieselbe Werkbank in den Themes nacht, bernstein und phosphor">

## Konfiguration

`caw.config.json` enthält Umgebungen, Anmeldung und Rollen. `init` schreibt sie für dich:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "auth": { "type": "form", "path": "/login", "userSelector": "#email", "passwordSelector": "#password",
            "signedInSelector": "[data-testid=user-menu]" },
  "apps": { "web": { "dir": ".", "startUrl": "/" } },
  "roles": { "tester": { "loginEnv": "CAW_LOGIN_TESTER", "passwordEnv": "CAW_PW_TESTER" } }
}
```

Die Anmeldung kann ein Formular sein (optional mit TOTP), HTTP Basic oder eine gespeicherte Sitzung für SSO. Siehe [docs/configuration.de.md](docs/configuration.de.md).

## FAQ

**Kostet jeder Lauf Token?**
Nein. Nur `record`, `fix` und Fragen an Claude im Chat. Bevor Claude startet, fragt der Chat einmal pro Lauf nach; den Hinweis kannst du abschalten.

**Sieht Claude meine Passwörter?**
Nein. caw-ai meldet sich selbst an, bevor Claude startet. Claude kann `caw/.env` nicht lesen und steuert den Browser nur über feste Befehle. Trotzdem Testkonten verwenden: Claude handelt als dieser Nutzer.

**Was passiert, wenn sich die Oberfläche ändert?**
Der Schritt schlägt fehl, und der Chat sagt dir, warum. War die Änderung gewollt, nimmt „Schritt beheben“ diesen Schritt neu auf; der Rest des Tests bleibt, wie er ist.

**Meine App hat keine Anmeldung.**
Lass `auth` und `roles` in der Config weg. `init` macht das von selbst, wenn es kein Anmeldeformular findet.

**Ist das Playwright?**
caw-ai steuert dein installiertes Chrome über Playwright. Playwright-Code schreibst du nicht.

## Doku

- [Befehle](docs/commands.de.md): alle Befehle und Optionen, Exit- und Fehlercodes
- [Konfiguration](docs/configuration.de.md): `caw.config.json`, Anmeldearten, `caw/.env`, `caw/caw.md`
- [Testdateien](docs/test-files.de.md): Testplan, Aufzeichnung, Platzhalter
- [Handbuch](docs/guide.de.md): Agenten, Werkbank, Chat, Einschätzung von Fehlern, Sandbox
- [Themes](themes/README.de.md): eingebaute Themes, eigene Theme-Pakete, `caw-ai theme`

## Mitmachen

Issues und Pull Requests sind willkommen, siehe [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Schriften und Grafiken: [NOTICE.md](NOTICE.md).
