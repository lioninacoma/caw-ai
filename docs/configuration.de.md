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
  "dev":     { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Feld | |
|---|---|
| `url` | Origin der App. `https`, oder `http` für `localhost`, `127.0.0.1` und `*.localhost`. |
| `claude` | `true`: Claude darf hier aufnehmen, reparieren und untersuchen. |
| `writable` | `true`: Tests mit `mutates: true` dürfen hier laufen. |
| `overlay` | `true`: `--overlay` darf deinen lokalen Code über diese ausgelieferte Umgebung legen. Das erlaubt es nur und schaltet nichts ein. Für einen Dev-Server auf deinem Rechner unnötig. Siehe [Lokalen Code testen](#lokalen-code-testen). |
| `production` | Pflicht für Namen wie `prod` oder `live`. Eine solche Umgebung kann kein `claude`, `overlay` oder `writable` haben. |
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
| `overlay` | Woher `--overlay` den lokalen Code der App nimmt: Build-Ordner, Dev-Server, die Befehle für beide, feste Dateien. Siehe [Lokalen Code testen](#lokalen-code-testen). |

## Lokalen Code testen

caw-ai kennt zwei Modi:

- **E2E** (Standard, CI, nightly, jedes einfache `run`): immer der ausgelieferte Code der Umgebung, auch mit `--until`.
- **Entwicklung:** dein lokaler Code, nur mit `--overlay`. Nichts schaltet still darauf um.

Jeder Lauf nennt den Code in seinen ersten Zeilen, auch in CI:

```
Code: ausgelieferter Stand
Code: Dev-Server localhost:5173, dein aktueller Stand
Code: Overlay, Build dist, gebaut 14:02, vor 3 min
Code: Overlay, Dev-Server http://localhost:5173
```

### Dein Dev-Server als Umgebung

Gegen deinen lokalen Dev-Server testest du ohne Option. Der Dev-Server ist eine Umgebung wie jede andere:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true }
}
```

`--target local` testet dann, was in deinem Editor steht (Vite, `ng serve`, webpack-Dev-Server, Next.js, Nuxt). `--overlay` wird dort abgelehnt (Exit 3): Es ist für ausgelieferte Umgebungen.

### `--overlay`: lokaler Code über einer ausgelieferten Umgebung

Für Apps, die nur in einer ausgelieferten Umgebung funktionieren, etwa in einem Portal oder einer Shell, oder mit einem Backend, das es nur auf Staging gibt. Seite, API, Cookies und Anmeldung bleiben die der Umgebung; nur der Code der App kommt von deinem Rechner.

Dafür braucht die Umgebung `"overlay": true` und die App eine Quelle:

```json
"environments": {
  "dev": { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true }
},
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "overlay": {
      "build": "dist",
      "dev": "http://localhost:5173",
      "buildCommand": "npm run build",
      "devCommand": "npm run dev -- --port 5173 --strictPort",
      "statics": [{ "name": "Fx/Static.js", "path": "static.js" }]
    }
  }
}
```

| Feld in `overlay` | |
|---|---|
| `build` | Build-Ordner relativ zum Projekt, z. B. `"dist"` oder `"dist/app/browser"`. |
| `dev` | Adresse des Dev-Servers, z. B. `"http://localhost:5173"`. |
| `buildCommand` | Einmaliger Build, etwa `"npm run build"`, kein `--watch`. Braucht `build`. |
| `devCommand` | Startet den Dev-Server, etwa `"npm run dev -- --port 5173 --strictPort"`. Braucht `dev`. |
| `statics` | Feste Namen, bei jedem Laden frisch von der Platte: `name` ist der Name im Request, `path` die Datei relativ zum App-Ordner. Für jedes Framework und jede Quelle. |
| `assetUrlPattern` | Weitere Muster nur für diese App, zusätzlich zum `assetUrlPattern` oben: für eine App, deren Dateien von anderswo kommen. Text oder Liste. |

Unbekannte Felder sind ein Fehler. Von `build` und `dev` reicht eins.

| Aufruf | Quelle |
|---|---|
| `--overlay` | Die eine konfigurierte Quelle. Hat die App `build` und `dev`, bricht der Aufruf ab (Exit 3) und lässt dich wählen. |
| `--overlay build` | Der Build-Ordner. |
| `--overlay dev` | Der Dev-Server. |
| `--overlay http://localhost:5174` | Der Dev-Server unter dieser Adresse. Geht vor der Config, braucht kein `overlay` an der App. Nur für einen Test mit einer App (mit `also` Exit 3), nicht bei ExtJS (Exit 3). |

`--overlay` gibt es bei `run`, `record`, `fix` und `open`. Abgelehnt wird es (Exit 3) mit Grund auf einer Umgebung ohne `"overlay": true`, auf einer Umgebung, die selbst ein Dev-Server auf deinem Rechner ist, und für eine App ohne Quelle. Apps aus `also` nehmen ihre eigene Quelle; ohne eine bleiben sie ausgeliefert.

**caw startet und baut selbst**, wie `webServer` bei Playwright. Bevor Chrome startet:

- **Dev-Server** antwortet nicht: Mit `devCommand` startet caw ihn im App-Ordner und wartet bis zu 60 s. Die Ausgabe steht in `.caw/<app>-dev-server.log`. Am Ende des Laufs beendet caw den ganzen Prozessbaum; bei `open` und `--until`, wenn du das Fenster schließt.
- **Build** fehlt oder ist älter als die jüngste Quelldatei der App: Mit `buildCommand` baut caw einmal im App-Ordner (Ausgabe in `.caw/<app>-build.log`) und prüft erneut. Nicht als Quelle zählen: `node_modules`, der Build-Ordner, Ordner mit Punkt, übliche Build-Ordner (`dist`, `build`, `out`, `coverage`, …), `caw/`, Markdown-Dateien und `caw.config.json`; angesehen werden höchstens 5000 Dateien.
- Sonst endet der Lauf mit Exit 2, dem Grund und dem Befehl, der es behebt.

caw nennt jede Aktion, etwa `Der Dev-Server http://localhost:5173 läuft nicht, starte npm run dev -- --port 5173 --strictPort …`. Die Quelle wechselt nie: Ein gescheiterter Build weicht nicht auf den Dev-Server oder den ausgelieferten Stand aus.

**Wie der lokale Code in die Seite kommt:**

- **Seiten:** Jede HTML-Seite der App kommt vom Server. caw tauscht darin die Code-Tags der App gegen die der lokalen Seite: bei `build` die Seite im Build-Ordner mit den meisten Treffern, bei `dev` das HTML des Dev-Servers unter demselben Pfad. Die neuen Tags stehen an der Stelle der alten und tragen die CSP-Nonce der Seite; `integrity` fällt weg. Inline-Skripte, Projektkopien (etwa `public/env.js`: Die Umgebung setzt sie, sie bleibt vom Server) und Skripte fremder Origins bleiben. Kein Tausch auf Seiten ohne Tags der App (Anmeldeseite), auf serverseitig gerenderten Seiten und wenn der Build einen anderen Basispfad hat (eine Warnung sagt es); dann kommen nur einzelne Requests aus dem lokalen Code.
- **Requests bei `build`:** die Datei selbst oder die mit gleichem Namen bis auf den Hash. Ein Hash ist `name[-.]hash.endung` mit 6 bis 64 Zeichen aus `[A-Za-z0-9_-]`, darunter eine Ziffer oder ein Großbuchstabe. Seine Länge darf sich ändern (`assets/index-Bx81.js` → `assets/index-Q7f2kL9a.js`), und ein fester Name und einer mit Hash gelten als dieselbe Datei (`main.js` ↔ `main-A1B2C3D4.js`).
- **Requests bei `dev`:** Code-Requests (Skripte, Stile, Schriften, Bilder, Module) gehen an den Dev-Server. Sein HMR-WebSocket wird durchgereicht, Hot Reload geht also auch in der ausgelieferten Seite.
- **`statics`** werden zuerst beantwortet, bei jeder Quelle.
- Alles Lokale geht mit `cache-control: no-store` raus; Service Worker sind im Testbrowser gesperrt. Der Name eines Requests ist sein Pfad unterhalb der Umgebungs-URL oder Gruppe 1 von `assetUrlPattern`.

**Prüfungen nach dem ersten Laden:**

| Befund | Folge |
|---|---|
| Serverseitig gerenderte Seite (Next.js, Nuxt, SvelteKit, Angular SSR) | Exit 2 (`overlay-ssr`). Lokalen Code testest du dort mit dem Dev-Server als Umgebung (`--target local`). |
| Erwartete Teile kamen vom Server (ExtJS: App oder eigenes Paket) | Exit 2 (`overlay-incomplete`): ein Mischstand. Die Meldung nennt die Teile, bis zu fünf URLs und das `assetUrlPattern`, das sie abfängt. `caw-ai overlay check --apply` trägt es ein. |
| Nichts kam aus dem lokalen Code | Exit 2 (`overlay-unused`). |
| Erwartete Teile nie angefragt | Hinweis „Nicht geladen“: vielleicht lädt die App sie erst später. |
| Skripte aus dem lokalen Asset-Ordner kamen vom Server | Warnung „Mischstand“: neu bauen oder prüfen, ob der Build zur ausgelieferten Version passt. |
| Build mit anderem Basispfad | Warnung, kein Tausch der Seite. |

`report.md` nennt, was geschah: `Overlay: dist; 14 Datei(en) lokal, 2 Skript(e)/Stylesheet(s) vom Server; Seite getauscht: ja`.

**ExtJS:** Mit `"framework": "extjs"` kommt der lokale Code vom Sencha-Watch. Die App braucht keinen Eintrag `overlay`, optional `statics` und `devCommand` (etwa `"sencha app watch"`, dann startet caw den Watch). `build`, `dev` und `buildCommand` sind dort Fehler; nimm `--overlay` oder `--overlay dev`. Einzelheiten: [Leitfaden](guide.de.md#wie-der-lokale-code-in-die-anwendung-kommt).

**Mehrere Quellen für Skripte.** Eine Seite kann ihren Code von mehr als einer Stelle laden. caw benennt jeden Request über den Pfad unterhalb der Umgebungs-URL und über jedes `assetUrlPattern`; der erste Name, den eine Quelle kennt, gilt. `assetUrlPattern` ist ein Text oder eine Liste, ein Muster je Quelle, Gruppe 1 der Dateiname. Ein Portal wie bei FA214 lädt das Theme über einen normalen Pfad (deckt der Standard ab) und App und Pakete über ein Proxy-Servlet:

```json
"assetUrlPattern": [
  "[?&]url=inubitrepository:///Root/(?:[^&#]*/)?([^/&#]+\\.js)(?:[&#]|$)",
  "^https://cdn\\.example\\.com/js/(?:[^?#]*/)?([^/?#]+\\.js)"
]
```

Von Hand schreiben musst du sie nicht: `npx caw-ai overlay check` lädt die App einmal, zeigt je Teil, ob er lokal oder ausgeliefert kam, und schlägt je fehlender Quelle ein Muster vor; `--apply` trägt sie ein. Das Overlay für ExtJS ist eingerichtet, wenn `overlay check` vollständig meldet. caw startet den Sencha-Watch nie selbst, außer die App hat `devCommand`.

**`validate`** nennt den Code je Test und Ziel und wo `--overlay` ginge:

```
smoke (local): Dev-Server localhost:5173, dein aktueller Stand
smoke (dev): ausgelieferter Stand; mit --overlay: Overlay, Build dist
smoke (dev): ausgelieferter Stand; mit --overlay build bzw. dev: Overlay, Build dist | Overlay, Dev-Server http://localhost:5173
```

Dazu weist es auf eine App mit `overlay` hin, während keine Umgebung `"overlay": true` hat.

## Alles Weitere

| Feld | Standard | |
|---|---|---|
| `language` | erkannt | `en` oder `de` für Oberfläche, CLI und Berichte. `CAW_LANG` hat Vorrang. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` oder `extjs`. Bestimmt, wie Ziele gespeichert werden und wann eine Seite als bereit gilt. |
| `agent.sandbox` | `local` | Wo Claude läuft: `local` (Claude Code auf deinem Rechner, nur lesende Werkzeuge) oder `docker`. In der CI immer `docker`. |
| `extraAllowedHosts` | `[]` | Weitere Hosts, die Chrome erreichen darf, etwa Anmeldung oder CDN. Alles andere ist gesperrt. |
| `insecureTls` | `false` | Selbstsignierte Zertifikate annehmen. |
| `browser` | Chrome des Systems | `{ "channel": "msedge" }` oder `{ "executablePath": "/pfad/zu/chromium" }` |
| `browser.locale`, `browser.timezone` | wie aufgezeichnet | Sprache und Zeitzone des Testbrowsers, z. B. `"de-DE"` und `"Europe/Berlin"`. Ohne sie nimmt eine Wiedergabe die Werte, die mit der Aufzeichnung gespeichert sind, eine Aufnahme (oder eine ältere Aufzeichnung) die des Rechners. Datum, Zahlen und Übersetzungen sehen dann auf jedem Rechner und CI-Runner gleich aus. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS-Selektoren für Fehlermeldungen ohne ARIA-Rolle. |
| `consoleIgnore` | `[]` | Reguläre Ausdrücke für bekannte, harmlose Konsolenfehler. Eng halten. |
| `foreignCode` | `[]` | Reguläre Ausdrücke für fremde Skripte, etwa `"/vendor/"`. Deren Fehler werden zu Warnungen. |
| `requestKeys` | `[]` | Query-Parameter, die einen Request benennen, etwa `["action"]` bei APIs mit nur einem Endpunkt. |
| `effects.fail` | `["controls", "console"]` | Welche gelernten Wirkungen einen Schritt scheitern lassen, wenn sie sich ändern. `[]` macht alle zu Warnungen. |
| `maxSteps` | `100` | Aktionsbudget für Claude beim Aufnehmen und Reparieren. |
| `readyTimeoutMs` | | Wie lange auf eine ruhige App gewartet wird. |
| `readyIgnore` | `[]` | CSS-Selektoren von Bereichen, die sich von selbst ändern, z. B. `["#ticker", ".clock", "footer [role=progressbar]"]`. Ihre DOM-Änderungen und Fortschrittsanzeigen zählen beim Warten auf eine ruhige Seite nicht. Spinner ohne Größe, versteckt oder außerhalb des sichtbaren Bereichs zählen nie. Wird eine Seite nie ruhig, sagt der Bericht das einmal je Schritt. |
| `lintCommand` | | Dein Prüfbefehl, etwa `npm run lint`. Claude nennt ihn bei Code-Vorschlägen. |
| `assetUrlPattern` | | Regulärer Ausdruck oder eine Liste davon (einer je Quelle) für Requests, die App-Code laden; Gruppe 1 ist der Name für `overlay.statics`, der Pfad in `overlay.build` oder der Build-Name einer ExtJS-App oder eines Pakets. Gilt mit `--overlay` zusätzlich zum Pfad unterhalb der Umgebungs-URL. Fehlende schlägt `caw-ai overlay check` vor. |
| `sites` | | Dieselbe App für mehrere Mandanten: `["nord", "sued"]`, dann `urls` je Umgebung. |
| `extends` | | Gemeinsame Vorgaben aus einer Datei, etwa `"./caw/basis.json"`. |
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
