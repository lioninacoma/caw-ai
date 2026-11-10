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

`npx caw-ai init` schreibt dir so eine Config.

## environments

Pflicht. Ein Eintrag je Ort, an dem deine App läuft. Der Name ist das, was du an `--target` übergibst.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "claude": true, "localCode": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Feld | |
|---|---|
| `url` | Origin der App. `https`, oder `http` für `localhost`, `127.0.0.1` und `*.localhost`. |
| `claude` | `true`: Claude darf hier aufnehmen, reparieren und untersuchen. Früher `agent`; das gilt weiter, `validate` weist darauf hin. |
| `writable` | `true`: Tests mit `mutates: true` dürfen hier laufen. |
| `localCode` | `true`: deinen lokalen Build in diese entfernte Umgebung einspielen. Braucht `localBuild` (oder Einträge) an der App; für einen Dev-Server auf deinem Rechner unnötig. Siehe [Lokalen Code testen](#lokalen-code-testen). |
| `production` | Pflicht für Namen wie `prod` oder `live`. Eine solche Umgebung kann kein `claude`, `localCode` oder `writable` haben. |
| `urls` | Statt `url`, wenn du `sites` nutzt: `{ "nord": "https://nord.example.com", … }`. |

Was nicht auf `true` steht, ist aus. Gegen `staging` oben läuft also nur Abspielen, nur lesende Tests, gegen den ausgelieferten Stand.

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
| `localBuild` | Lokaler Code: der Build-Ordner relativ zum Projekt, z. B. `"dist"` oder `"dist/app/browser"`. Funktioniert mit normalen Builds mit Hash (Vite, Angular CLI, webpack). Siehe [Lokalen Code testen](#lokalen-code-testen). |
| `statics` | Lokaler Code, einzelne Dateien: `[{ "name": "main.js", "path": "dist/main.js" }]` |
| `redirects`, `constants` | Lokaler Code für Sencha-/ExtJS-Apps. |

## Lokalen Code testen

Welchen Code ein Lauf testet, entscheidet eine Stelle, und jeder Lauf nennt es in seinen ersten Zeilen, auch in CI:

```
Code: lokaler Build (dist, gebaut 14:02, vor 3 min)
Code: ausgelieferter Stand (Umgebung staging hat kein localCode)
```

Was du einträgst, hängt davon ab, wo deine App läuft:

| Aufbau | Was eintragen |
|---|---|
| Dev-Server auf deinem Rechner (`http://localhost:5173`: Vite, `ng serve`, webpack-Dev-Server) | Nichts. Der Dev-Server liefert deinen Code schon aus; `localCode` bewirkt dort nichts. |
| Entfernte Umgebung (dev, test) und ein normaler Build mit Hashes (Vite, Angular CLI, webpack) | `"localCode": true` an der Umgebung, `"localBuild": "dist"` an der App: der Ordner, in den dein Build oder Build-Watch schreibt. |
| Entfernte Umgebung, die App lädt gebaute Dateien unter festen Namen | `"localCode": true`, `statics` an der App und `assetUrlPattern`. |
| ExtJS / Sencha | `"localCode": true`, `redirects` und/oder `constants` an der App und `assetUrlPattern`; der Sencha-Watch läuft. |

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":   { "url": "https://dev.example.com", "claude": true, "localCode": true, "writable": true }
},
"apps": { "web": { "dir": ".", "startUrl": "/", "localBuild": "dist" } }
```

**Welcher Code läuft.** Die erste Regel, die passt, gilt:

1. `--code local` oder `--code deployed` bei `run`, `fix` oder `record`. `--code local` auf einer Umgebung ohne `localCode` oder für eine App ohne lokalen Code wird abgelehnt (Exit 3), die Meldung nennt den fehlenden Schlüssel.
2. `--until`: Ein Zustand für die Entwicklung nimmt den lokalen Build, wo Umgebung und App einen haben, auch bei `code: deployed` im Test.
3. `code: deployed` im Test ([Testdateien](test-files.de.md)).
4. Sonst der lokale Build, wenn die Umgebung `localCode` hat und die App des Tests (oder eine aus `also`) `localBuild`, `statics`, `redirects` oder `constants`. Wenn nicht, der ausgelieferte Stand, und die Zeile `Code:` sagt, warum.

Bei ExtJS: Läuft kein Sencha-Watch, nimmt der Lauf den ausgelieferten Stand und sagt das; mit `--code local` warnt er und nimmt trotzdem den lokalen Code.

**Veralteter Build.** Vor einem Lauf mit `localBuild` vergleicht caw-ai die jüngste Datei im Build-Ordner mit der jüngsten Datei unter `dir` der App. Nicht mit: `node_modules`, der Build-Ordner, Ordner mit Punkt (`.angular`, `.next`, …), übliche Build-Ordner (`dist`, `build`, `out`, `coverage`), `caw/` und Markdown-Dateien; angesehen werden höchstens 5000 Dateien. Hast du nach dem letzten Build Code geändert, warnt der Lauf und läuft weiter:

```
Der lokale Build (dist) ist älter als deine letzte Änderung (src/x.tsx, vor 12 min). Läuft der Build-Watch? Sonst --code deployed.
```

**`validate`** nennt den Code je Test und Ziel, etwa `smoke (dev): lokaler Build aus dist`, und weist auf Einstellungen ohne Wirkung hin: eine Umgebung mit `localCode`, während keine App lokalen Code hat, eine App mit `localBuild`, während keine Umgebung `localCode` hat, und einen Test mit `code: deployed`, dessen App inzwischen lokalen Code hat.

**Wie der lokale Build in die App kommt.** Auf Umgebungen mit `localCode` beantwortet Chrome bestimmte Requests aus dem Projektordner statt vom Server:

- **`localBuild`:** Gebaut wird wie immer, mit Hash. Ein Request auf eine Datei, die im Ordner liegt, bekommt diese Datei; ein Request auf eine Datei des deployten Builds, etwa `assets/index-Bx81.js` aus dem deployten `index.html`, bekommt die lokale Datei, die sich nur im Hash unterscheidet (`assets/index-Q7f2.js`). Alles, was der lokale Einstieg nachlädt, auch Lazy-Chunks, trägt lokale Namen und kommt ebenfalls aus dem Ordner. Seiten (`index.html`, Routen) kommen immer vom Server, damit bleiben seine Konfiguration, `<base href>` und CSP. JS, CSS, Quellkarten, Schriften und Bilder gehen mit ihrem Typ raus. Ohne `assetUrlPattern` ist der Name der Pfad unterhalb der Umgebungs-URL. Im Ordner muss vor dem Lauf ein Build liegen, sonst endet er mit `watch-missing`. Nicht für serverseitig gerenderte Apps (Next.js, Nuxt): Deren Server schreibt die deployten Dateinamen in jede Seite. Service Worker sind im Testbrowser gesperrt, ein gecachter deployter Build verdeckt den lokalen also nie.
- **`statics`:** eine Datei, `{ "name": "main.js", "path": "dist/main.js" }`, mit etwa `"assetUrlPattern": "/static/js/([^?#]+)"` (die erste Gruppe ist der Name). Jede Datei, die sich ändert, muss genannt sein; eine nicht genannte kommt vom Server. Die Datei muss vor dem Lauf existieren, sonst endet er mit `watch-missing`.
- **`redirects`, `constants`:** Sencha/ExtJS, siehe [Leitfaden](guide.de.md#wie-der-lokale-code-in-die-anwendung-kommt).

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
| `assetUrlPattern` | | Regulärer Ausdruck für Requests, die App-Code laden; Gruppe 1 ist der Dateiname in `statics`/`redirects`/`constants` oder der Pfad in `localBuild`. Ohne ihn nimmt `localBuild` den Pfad unterhalb der Umgebungs-URL. |
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
