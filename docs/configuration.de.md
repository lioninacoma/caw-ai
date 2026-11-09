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
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  },
  "apps": { "web": { "dir": ".", "startUrl": "/" } }
}
```

Mit Anmeldeformular:

```json
{
  "framework": "react",
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
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

`npx caw-ai init` schreibt dir so eine Config.

## environments

Pflicht. Ein Eintrag je Ort, an dem deine App läuft. Der Name ist das, was du an `--target` übergibst.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "agent": true, "localCode": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Feld | |
|---|---|
| `url` | Origin der App. `https`, oder `http` für `localhost`, `127.0.0.1` und `*.localhost`. |
| `agent` | `true`: Claude darf hier aufnehmen, reparieren und untersuchen. |
| `writable` | `true`: Tests mit `mutates: true` dürfen hier laufen. |
| `localCode` | `true`: App-Code aus deinem Projektordner ausliefern (siehe `assetUrlPattern`). |
| `production` | Pflicht für Namen wie `prod` oder `live`. Eine solche Umgebung kann kein `agent`, `localCode` oder `writable` haben. |
| `urls` | Statt `url`, wenn du `sites` nutzt: `{ "nord": "https://nord.example.com", … }`. |

Was nicht auf `true` steht, ist aus. Gegen `staging` oben läuft also nur Abspielen, und nur lesende Tests.

## auth

Weglassen, wenn deine App keine Anmeldung hat.

| `type` | Für | Felder |
|---|---|---|
| `form` | Anmeldeseite mit Benutzer und Passwort | `path`, `userSelector`, `passwordSelector`, `signedInSelector`, optional `submitSelector` (sonst schickt Enter ab), optional `codeSelector` für einen TOTP-Code als zweiten Faktor |
| `basic` | HTTP Basic Auth | `signedInSelector` (optional) |
| `storageState` | SSO, OAuth, MFA: du meldest dich einmal mit `caw-ai auth` an | `signedInSelector`, optional `path` |
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
"extraAllowedHosts": ["login.example-idp.com"],
"roles": { "user": {} }
```

```bash
npx caw-ai auth user --target dev   # einmal von Hand anmelden, die Sitzung landet in caw/.auth/dev/user.json
```

## roles

Ein Eintrag je Art von Nutzer, als der sich deine Tests anmelden. Ein Test wählt eine mit `role:`.

| `auth.type` | Eintrag der Rolle |
|---|---|
| `form`, `basic` | `{ "loginEnv": "CAW_LOGIN_ADMIN", "passwordEnv": "CAW_PW_ADMIN" }`: Namen der Variablen in `caw/.env`. Optional `totpEnv` für `codeSelector`. |
| `storageState` | `{}`: die Sitzung liegt je Umgebung in `caw/.auth/` |
| keine | `roles` weglassen |

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
| `statics` | Lokaler Code: `[{ "name": "main.js", "path": "dist/main.js" }]` |
| `redirects`, `constants` | Lokaler Code für Sencha-/ExtJS-Apps. |

## Alles Weitere

| Feld | Standard | |
|---|---|---|
| `language` | erkannt | `en` oder `de` für Oberfläche, CLI und Berichte. `CAW_LANG` hat Vorrang. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` oder `extjs`. Bestimmt, wie Ziele gespeichert werden und wann eine Seite als bereit gilt. |
| `agent.sandbox` | `local` | Wo Claude läuft: `local` (Claude Code auf deinem Rechner, nur lesende Werkzeuge) oder `docker`. In der CI immer `docker`. |
| `extraAllowedHosts` | `[]` | Weitere Hosts, die Chrome erreichen darf, etwa Anmeldung oder CDN. Alles andere ist gesperrt. |
| `insecureTls` | `false` | Selbstsignierte Zertifikate annehmen. |
| `browser` | Chrome des Systems | `{ "channel": "msedge" }` oder `{ "executablePath": "/pfad/zu/chromium" }` |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS-Selektoren für Fehlermeldungen ohne ARIA-Rolle. |
| `consoleIgnore` | `[]` | Reguläre Ausdrücke für bekannte, harmlose Konsolenfehler. Eng halten. |
| `foreignCode` | `[]` | Reguläre Ausdrücke für fremde Skripte, etwa `"/vendor/"`. Deren Fehler werden zu Warnungen. |
| `requestKeys` | `[]` | Query-Parameter, die einen Request benennen, etwa `["action"]` bei APIs mit nur einem Endpunkt. |
| `effects.fail` | `["controls", "console"]` | Welche gelernten Wirkungen einen Schritt scheitern lassen, wenn sie sich ändern. `[]` macht alle zu Warnungen. |
| `maxSteps` | `100` | Aktionsbudget für Claude beim Aufnehmen und Reparieren. |
| `readyTimeoutMs` | | Wie lange auf eine ruhige App gewartet wird. |
| `lintCommand` | | Dein Prüfbefehl, etwa `npm run lint`. Claude nennt ihn bei Code-Vorschlägen. |
| `assetUrlPattern` | | Regulärer Ausdruck für Requests, die App-Code laden; Gruppe 1 ist der Dateiname in `statics`/`redirects`/`constants`. |
| `sites` | | Dieselbe App für mehrere Mandanten: `["nord", "sued"]`, dann `urls` je Umgebung. |
| `extends` | | Gemeinsame Vorgaben aus einer Datei, etwa `"./caw/presets/basis.json"`. |
| `sandboxImage` | `node:22-bookworm-slim` | Basis-Image für den Agenten `docker`. Sonst `image` aus `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | Nutzer im Container. |

## caw/caw.md

Normales Markdown, wie eine `CLAUDE.md` für deine Tests. Schreib auf, was Claude nicht im Code sieht, was aber in jedem Test zählt:

```markdown
## Suche
- Die Suche merkt sich die letzte Eingabe über Sitzungen hinweg. Zuerst „Filter löschen“ klicken.
```

Änderungen daran machen keine Aufzeichnung ungültig. Keine personenbezogenen Daten.

## Persönliche Einstellungen

Was du in der Werkbank wählst (Thema, Animationen, eingeklappte Bereiche, der Hinweis auf Token), speichert caw-ai je Nutzer in `prefs.json` unter `CAW_AI_HOME`, Standard `%APPDATA%\caw-ai` oder `~/.config/caw-ai`. Nicht im Projekt.
