[English](configuration.md) · Deutsch

# Konfiguration

caw-ai liest drei Dinge aus deinem Projekt:

| Datei | Was | Committen? |
|---|---|---|
| `caw.config.json` | Umgebungen, Anmeldung, Apps, Rollen | ja |
| `caw/.env` | Zugangsdaten der Testkonten | **nein** (gitignored) |
| `caw/caw.md` | Projektwissen, das Claude in jedem Lauf liest | ja |

Tests liegen in `caw/tests/` und `caw/recordings/`, siehe [Testdateien](test-files.de.md).

## Minimale Config

Eine App auf einem lokalen Dev-Server, ohne Anmeldung:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } }
}
```

Mit Anmeldeformular:

```json
{
  "framework": "react",
  "environments": {
    "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
  },
  "auth": {
    "type": "form",
    "path": "/login",
    "userSelector": "#email",
    "passwordSelector": "#password",
    "signedInSelector": "[data-testid=user-menu]"
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } },
  "roles": {
    "user": { "loginEnv": "CAW_LOGIN_USER", "passwordEnv": "CAW_PW_USER" }
  }
}
```

```bash
# caw/.env
CAW_LOGIN_USER=test-user@example.com
CAW_PW_USER=geheim
```

`caw/.env` wird gelesen wie bei dotenv: `NAME=Wert`, gern in Anführungszeichen; ein Kommentar hinter dem Wert braucht ein Leerzeichen vor `#` (`NAME=Wert # Notiz`). Ein `#` ohne Leerzeichen davor gehört zum Wert; Werte mit ` #` in Anführungszeichen setzen.

`npx caw init` schreibt dir so eine Config, dazu die Rolle mit ihrem Testnutzer: Nach **Fertig** nennst du im Fenster die Rolle, **Speichern** schreibt die Variablen in `caw/.env`. Umgebungsvariablen gleichen Namens gehen vor `caw/.env`, etwa in CI.

## environments

Pflicht. Ein Eintrag je Ort, an dem deine App läuft. Der Name ist das, was du an `--env` übergibst.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "claude": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Feld | |
|---|---|
| `url` | Origin der App. `https`, oder `http` für `localhost`, `127.0.0.1` und `*.localhost`. |
| `claude` | `true`: Claude darf hier aufnehmen, reparieren und untersuchen. |
| `writable` | `true`: Tests mit `mutates: true` dürfen hier laufen. |
| `production` | Pflicht für Namen wie `prod` oder `live`. Eine solche Umgebung kann kein `claude` oder `writable` haben. Ein Lauf dort schickt keine schreibenden Requests: Jeder wird abgebrochen und lässt den Schritt mit `write-blocked` scheitern (`reads` nennt Requests, die nur lesen). Läufe auf anderen Umgebungen erreichen ihren Host nie. |
| `urls` | Statt `url`, wenn du `sites` nutzt: `{ "nord": "https://nord.example.com", … }`. |

Was nicht auf `true` steht, ist aus. Gegen `staging` oben läuft also nur Abspielen, nur lesende Tests, gegen den ausgelieferten Stand.

### Umgebung starten, stoppen und zurücksetzen

Eine Umgebung kann deine eigenen Befehle zum Starten, Stoppen und Zurücksetzen nennen. caw führt sie nur auf Wunsch aus und
nie auf einer `production`-Umgebung.

```json
"ci": {
  "url": "http://localhost:8080", "writable": true,
  "start": "docker compose -f ci/compose.yaml up -d --wait",
  "stop":  "docker compose -f ci/compose.yaml down -v",
  "reset": "docker compose -f ci/compose.yaml exec -T api npm run seed",
  "ready": { "path": "/healthz", "timeoutMs": 120000 }
}
```

| Feld | |
|---|---|
| `start` | Shell-Befehl, der die Umgebung startet. Läuft nur mit `--start`. caw wartet nicht auf sein Ende: Ein Befehl, der sich ablöst (`up -d`), und einer, der weiterläuft (`npm run dev`), funktionieren beide. |
| `stop` | Shell-Befehl, der sie stoppt. Nur zusammen mit `start` und nur, wenn caw die Umgebung gestartet hat. Ein weiterlaufender `start` wird danach samt Kindprozessen beendet. |
| `reset` | Shell-Befehl, der die Daten zurücksetzt. Braucht `writable: true`. `run` führt ihn einmal vor dem ersten schreibenden Test aus, `--reset` vor dem ersten Test, `--no-reset` nie. `record` und `open` nur mit `--reset`. |
| `ready` | Wann die Umgebung als bereit gilt: Ein GET auf `path` (Standard `/`) antwortet unter 500. caw fragt jede Sekunde, `timeoutMs` lang (Standard 60000, 1000 bis 1800000). |

Die Befehle laufen im Projektordner mit der Shell deiner Plattform (`cmd.exe` unter Windows, sonst `/bin/sh`), mit
`CAW_ENV` und `CAW_ENV_URL`. Ihre Ausgabe steht in `.caw/env/<env>-start.log`, `-stop.log` und `-reset.log`.

- Antwortet die Umgebung schon, nutzt `--start` sie und startet und stoppt nichts.
- Ein `start`, der vorher mit Fehler endet, scheitert mit `env-start-failed`. Einer, der nie bereit wird, mit `env-not-ready`.
  In beiden Fällen stoppt caw, was es gestartet hat.
- Ein scheiternder `reset` (oder einer, der länger als 10 Minuten dauert) scheitert mit `env-reset-failed`, und kein Test läuft.
- Ohne `--start` scheitert eine Umgebung, die nicht antwortet, mit `env-unreachable`; ist `start` gesetzt, nennt die Meldung
  `--start`.
- Die Variable `CI` ändert daran nichts: `--start` ist immer ausdrücklich.

## auth

Weglassen, wenn deine App keine Anmeldung hat.

| `type` | Für | Felder |
|---|---|---|
| `form` | Anmeldeseite mit Benutzer und Passwort | `path`, `userSelector`, `passwordSelector`, `signedInSelector`, optional `submitSelector` (sonst schickt Enter ab), optional `codeSelector` für einen TOTP-Code als zweiten Faktor |
| `basic` | HTTP Basic Auth | `signedInSelector` (optional) |
| `storageState` | SSO, OAuth, MFA: du meldest dich einmal mit `caw role login` an | `signedInSelector`, optional `path` |
| `none` | Keine Anmeldung (wie `auth` weglassen) | – |

`signedInSelector` ist ein CSS-Selektor, den es nur im angemeldeten Zustand gibt. Verschwindet er während eines Laufs, meldet caw-ai eine verlorene Anmeldung.

Zweiter Faktor (TOTP): `codeSelector` auf das Feld für den Einmalcode setzen und der Rolle ein `totpEnv` mit dem Base32-Geheimnis des Kontos geben. caw-ai trägt den aktuellen Code ein (RFC 6238, SHA-1, 30 s, 6 Stellen). Lehnt die App den Code ab, weil sich das Konto im selben 30-s-Fenster schon angemeldet hat (das Codefeld bleibt, `signedInSelector` erscheint nicht binnen 10 s), wartet caw-ai auf das nächste Fenster und versucht es genau einmal neu.

```json
"auth": { "type": "form", "path": "/login", "userSelector": "#user", "passwordSelector": "#password",
          "codeSelector": "#otp", "signedInSelector": "[data-testid=user-menu]" },
"roles": { "user": { "loginEnv": "CAW_LOGIN_USER", "passwordEnv": "CAW_PW_USER", "totpEnv": "CAW_TOTP_USER" } }
```

Beispiel mit SSO:

```json
"auth": { "type": "storageState", "signedInSelector": "app-user-menu" },
"allowHosts": ["login.example-idp.com"],
"roles": { "user": {} }
```

```bash
npx caw role login user --env dev   # einmal von Hand anmelden, die Sitzung landet in caw/.auth/dev/user.json
```

## roles

Ein Eintrag je Art von Nutzer, als der sich deine Tests anmelden. Ein Test wählt eine mit `role:`.

| `auth.type` | Eintrag der Rolle |
|---|---|
| `form`, `basic` | `{ "loginEnv": "CAW_LOGIN_ADMIN", "passwordEnv": "CAW_PW_ADMIN" }`: Namen der Variablen in `caw/.env`. Optional `totpEnv` für `codeSelector`. |
| `storageState` | `{}`: die Sitzung liegt je Umgebung in `caw/.auth/` |
| keine | `roles` weglassen |

Eine Rolle fügst du mit `npx caw role add <rolle> --env <env>` hinzu: im Fenster mit dem Testkonto anmelden, Rolle benennen, **Speichern**. caw-ai schreibt den Eintrag oben, die Werte in `caw/.env` und `caw/.env` in `.gitignore`. Ohne Fenster (CI) setzt du die Variablen in der Umgebung. Siehe [role](commands.de.md#role).

Nimm Testkonten mit so wenig Rechten wie möglich. Claude steuert einen Browser, der als dieser Nutzer angemeldet ist.

## apps

Pflicht. Meist eine App; Monorepos können mehrere nennen.

```json
"apps": {
  "web":   { "dir": "apps/web", "startUrl": "/" },
  "admin": { "dir": "apps/admin", "startUrl": "/admin" }
}
```

| Feld | |
|---|---|
| `dir` | App-Ordner relativ zum Projekt, `.` für eine einzelne App. |
| `startUrl` | Pfad, an dem Tests beginnen. Nur für Apps, in denen ein Test startet. |

## Lokalen Code testen

caw-ai kennt zwei Modi:

- **E2E** (Standard, CI, nightly, jedes einfache `run`): immer der ausgelieferte Code der Umgebung, auch mit `open <test>`.
- **Entwicklung:** dein lokaler Code, vom Dev-Server als Umgebung oder mit der [Overlay-Erweiterung](extensions/overlay.de.md). Nichts schaltet still darauf um.

Jeder Lauf nennt den Code in seinen ersten Zeilen, auch in CI:

```
Code: ausgelieferter Stand
Code: Dev-Server localhost:5173, dein aktueller Stand
```

### Dein Dev-Server als Umgebung

Gegen deinen lokalen Dev-Server testest du ohne Option. Der Dev-Server ist eine Umgebung wie jede andere:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
}
```

`--env local` testet dann, was in deinem Editor steht (Vite, `ng serve`, webpack-Dev-Server, Next.js, Nuxt).

### Lokaler Code auf einer ausgelieferten Umgebung

Für Anwendungen, die nur in einer ausgelieferten Umgebung laufen (Portal, Shell, Backend nur auf Staging), legt die [Overlay-Erweiterung](extensions/overlay.de.md) deinen lokalen Code über die Umgebung. Sie ist nur mit einem `overlay`-Block in der Config aktiv.

## Alles Weitere

| Feld | Standard | |
|---|---|---|
| `language` | erkannt | `en` oder `de` für Oberfläche, CLI und Berichte. `CAW_LANG` hat Vorrang. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` oder `extjs`. Bestimmt, wie Ziele gespeichert werden und wann eine Seite als bereit gilt. |
| `agent.mode` | `local` | Wo Claude läuft: `local` (Claude Code auf deinem Rechner, nur lesende Werkzeuge) oder `docker`. In der CI immer `docker`. |
| `agent.model` | Standard von Claude Code | Modell für Claude, weitergegeben als `--model`, z. B. `haiku` oder `sonnet`. `CAW_CLAUDE_MODEL` überschreibt es für einen Lauf. |
| `agent.maxBudgetUsd` | keins | Beendet einen Claude-Lauf bei diesen geschätzten Kosten in US-Dollar (`--max-budget-usd`). `CAW_CLAUDE_BUDGET` überschreibt es. |
| `allowHosts` | `[]` | Weitere Hosts, zu denen Seiten navigieren dürfen, etwa ein Anmeldedienst; auch pro Umgebung als `environments.<env>.allowHosts`. Seiten navigieren nur zu den Hosts der Umgebungen und zu diesen (Links, Formular-Posts, Popups, Weiterleitungen, `goto`); alles andere scheitert mit `host-blocked`. Skripte, Styles, Fonts, Bilder, XHR/fetch, WebSockets und iframes dürfen jeden Host erreichen. Produktions-Hosts anderer Umgebungen bleiben für jeden Request unerreichbar. |
| `insecureTls` | `false` | Selbstsignierte Zertifikate annehmen. |
| `browser` | Chrome des Systems | `{ "channel": "msedge" }` oder `{ "executablePath": "/pfad/zu/chromium" }` |
| `browser.locale`, `browser.timezone` | wie aufgezeichnet | Sprache und Zeitzone des Testbrowsers, z. B. `"de-DE"` und `"Europe/Berlin"`. Ohne sie nimmt eine Wiedergabe die Werte, die mit der Aufzeichnung gespeichert sind, eine Aufnahme die des Rechners. Datum, Zahlen und Übersetzungen sehen dann auf jedem Rechner und CI-Runner gleich aus. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS-Selektoren für Fehlermeldungen ohne ARIA-Rolle. |
| `consoleIgnore` | `[]` | Reguläre Ausdrücke für bekannte, harmlose Konsolenfehler. Eng halten. |
| `foreignCode` | `[]` | Reguläre Ausdrücke für fremde Skripte, etwa `"/vendor/"`. Deren Fehler werden zu Warnungen. |
| `requestKeys` | `[]` | Parameter, die einen Request benennen, bei APIs mit nur einem Endpunkt: Query-Parameter wie `["action"]` oder Felder der obersten Ebene eines JSON-Bodys als `json.<key>`, etwa `["json.method"]` bei JSON-RPC. Einen GraphQL-Request benennt seine Operation ohne diesen Schlüssel: `POST /graphql mutation CloseTicket`. |
| `reads` | `[]` | Requests, die nur lesen, obwohl sie kein GET sind, etwa `["POST /api/search"]`. Ein Muster ist eine Methode (oder `*`) und ein Pfad, danach optional Schlüssel- und GraphQL-Teile: `*` passt innerhalb eines Pfadsegments (in den anderen Teilen auf beliebige Zeichen), `**` auf alles. `"POST /api/*/query"`, `"POST /api/proxy op=load*"`, `"POST /graphql mutation TrackView"`, `"* /api/telemetry/**"`. Ein Muster, das mit dem Pfad endet, passt nie auf einen GraphQL-Request. Nur auf oberster Ebene: Es ist in jeder Umgebung dieselbe Anwendung. |
| `effects.fail` | `["controls", "console"]` | Welche gelernten Wirkungen einen Schritt scheitern lassen, wenn sie sich ändern. `[]` macht alle zu Warnungen. |
| `maxSteps` | `100` | Aktionsbudget für Claude beim Aufnehmen und Reparieren. |
| `readyTimeoutMs` | | Wie lange auf eine ruhige App gewartet wird. |
| `readyIgnore` | `[]` | CSS-Selektoren von Bereichen, die sich von selbst ändern, z. B. `["#ticker", ".clock", "footer [role=progressbar]"]`. Ihre DOM-Änderungen und Fortschrittsanzeigen zählen beim Warten auf eine ruhige Seite nicht. Spinner ohne Größe, versteckt oder außerhalb des sichtbaren Bereichs zählen nie. Wird eine Seite nie ruhig, sagt der Bericht das einmal je Schritt. |
| `lintCommand` | | Dein Prüfbefehl, etwa `npm run lint`. Claude nennt ihn bei Code-Vorschlägen. |
| `sites` | | Dieselbe App für mehrere Mandanten: `["nord", "sued"]`, dann `urls` je Umgebung. |
| `extends` | | Gemeinsame Vorgaben aus einer Datei, etwa `"./caw/basis.json"`. |
| `sandboxImage` | `node:22-bookworm-slim` | Basis-Image für den Agenten `docker`. Sonst `image` aus `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | Nutzer im Container. |
| `theme` | | Vorgabe fürs Team in der Werkbank: `{ "base": "phosphor", "colors": { … } }`. Eine eigene Wahl in `prefs.json` geht vor. Siehe [Themes](../themes/README.de.md#vorgabe-fürs-team). |

## caw/caw.md

Normales Markdown, wie eine `CLAUDE.md` für deine Tests. Schreib auf, was Claude nicht im Code sieht, was aber in jedem Test zählt:

```markdown
## Suche
- Die Suche merkt sich die letzte Eingabe über Sitzungen hinweg. Zuerst „Filter löschen“ klicken.
```

Änderungen daran machen keine Aufzeichnung ungültig. Keine personenbezogenen Daten.

## Persönliche Einstellungen

Was du in der Werkbank wählst (Thema, Animationen, eingeklappte Bereiche, der Hinweis auf Token), speichert caw-ai je Nutzer in `prefs.json` unter `CAW_AI_HOME`, Standard `%APPDATA%\caw-ai` oder `~/.config/caw-ai`. Nicht im Projekt.
