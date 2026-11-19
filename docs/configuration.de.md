[English](configuration.md) · Deutsch

# Konfiguration

caw liest drei Dinge aus deinem Projekt:

| Datei | Was | Einchecken? |
|---|---|---|
| `caw.config.json` | Umgebungen, Anmeldung, Rollen | ja |
| `caw/.env` | Zugangsdaten der Testnutzer | **nein** (gitignored) |
| `caw/caw.md` | Projektnotizen, die Claude in jedem Lauf liest | ja |

Tests liegen in `caw/tests/` und `caw/recordings/`, siehe [Testdateien](test-files.de.md).

`caw.config.json` und die Aufnahmen sind ausführbare Konfiguration: Die Config nennt Shell-Befehle, die caw ausführt (`start`,
`stop`, `reset`, `lintCommand`, das `start` eines Overlay-Teils), und den Browser, den es startet, und die Schritte `check` und
`remember` einer Aufnahme führen ihren Code in der Seite aus. Prüf Änderungen daran wie Code, egal wer sie gemacht hat.

## Minimale Config

Eine App auf einem lokalen Dev-Server, ohne Anmeldung:

```json
{
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  }
}
```

Mit Anmeldeformular:

```json
{
  "framework": "react",
  "start": "/",
  "environments": {
    "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
  },
  "signIn": {
    "type": "form",
    "path": "/login",
    "userSelector": "#email",
    "passwordSelector": "#password",
    "signedInSelector": "[data-testid=user-menu]"
  },
  "roles": { "user": {} }
}
```

```bash
# caw/.env
CAW_USER_USER=test-user@example.com
CAW_USER_PASSWORD=geheim
```

`npx caw init` schreibt dir so eine Config. Mit `--explore-only` sieht es sich die App zuerst an, und du meldest dich einmal
an; danach schlägt es die Anmeldung vor (siehe [init](commands.de.md#init)). Die Testnutzer trägst du selbst in `caw/.env` ein; caw schreibt sie nie.

## environments

Pflicht. Ein Eintrag je Ort, an dem deine App läuft. Der Name ist das, was du bei `--env` angibst: Kleinbuchstaben, Ziffern
und `-`, beginnend mit einem Buchstaben, höchstens 32 Zeichen.

```json
"environments": {
  "local":   { "url": "http://localhost:5173", "agent": true, "writable": true },
  "dev":     { "url": "https://dev.example.com", "agent": true, "writable": true },
  "staging": { "url": "https://staging.example.com" },
  "prod":    { "url": "https://example.com", "production": true }
}
```

| Feld | |
|---|---|
| `url` | Origin der App. `https`, oder `http` für diesen Rechner (`localhost`, `127.0.0.1`, `*.localhost`). |
| `agent` | `true`: Claude darf hier aufnehmen, beheben und untersuchen. |
| `writable` | `true`: Tests mit `writes: true` dürfen hier laufen. |
| `production` | Pflicht für Namen, die nach Produktion aussehen (`prod`, `live`, `prod-eu` …). So eine Umgebung kann kein `agent` oder `writable` haben. Ein Lauf dort sendet keine schreibenden Requests, an keinen Host: Jeder Request, der kein GET, HEAD, OPTIONS, keine GraphQL-Query und kein `reads`-Muster ist, wird abgebrochen und lässt den Schritt mit `write-blocked` scheitern, auch ein Formular-Post ins oberste Fenster. Anmelde-Requests gehen nur durch, solange caw selbst anmeldet; ein Token-Refresh, den die App später schickt, schreibt, außer `reads` nennt ihn. Nicht abgedeckt: Nachrichten, die die App über einen offenen WebSocket schickt (auch lesende Apps schicken welche, etwa Keep-alives und Abonnements). Läufe auf anderen Umgebungen erreichen ihren Host nie. Ein Name, der nur so aussieht, sagt `"production": false`. |
| `insecureTls` | `true`: ein selbstsigniertes Zertifikat auf dieser Umgebung akzeptieren. |
| `allowHttp` | `true`: `http` auf einem Host erlauben, der nicht dieser Rechner ist (ein Intranet ohne TLS). |
| `allowHosts` | Weitere Hosts, auf die Seiten hier navigieren dürfen, etwa der Anmeldedienst; ergänzt `allowHosts` der obersten Ebene. |
| `thirdPartyHosts` | Weitere Hosts, die der Browser hier erreichen darf, solange Claude dabei ist; ergänzt `thirdPartyHosts` der obersten Ebene. |
| `signIn` | Eine Anmeldung nur für diese Umgebung; ersetzt das `signIn` der obersten Ebene als Ganzes. Siehe [signIn](#signin). |
| `gate` | `{ "type": "basic" }`: ein HTTP-Basic-Tor vor der App (häufig auf Staging), mit eigenem Konto `CAW_GATE_USER` / `CAW_GATE_PASSWORD`. Nicht zusammen mit `signIn.type: basic`. |
| `start`, `stop`, `reset`, `ready` | Deine Befehle für diese Umgebung, siehe [unten](#umgebung-starten-stoppen-und-zurücksetzen). |
| `extends` | Eine andere Umgebung, deren Felder diese übernimmt; ihre eigenen Felder ersetzen sie (Listen und Objekte als Ganzes). `production` wird nie übernommen. Praktisch für Mandanten: `"south": { "extends": "north", "url": "https://south.example.com" }`. |

Was nicht auf `true` steht, ist aus. Ein Lauf gegen `staging` oben spielt nur ab, nur lesende Tests, gegen den ausgelieferten
Stand.

Welche Umgebung ein Befehl nimmt: die, die du mit `--env` nennst. Ohne läuft ein Test, der auf genau einer Umgebung laufen
kann, dort; auf deinem Rechner wird die einzige Umgebung mit `agent: true` unter seinen Kandidaten genommen; in CI rät caw nie
und nennt die Kandidaten (Exit 3).

### Umgebung starten, stoppen und zurücksetzen

Eine Umgebung kann eigene Befehle zum Starten, Stoppen und Zurücksetzen nennen. caw führt sie nie auf einer
`production`-Umgebung aus. `start` läuft nur mit `--start` (`caw_start` mit `start`), `stop` nur nach einem `start` von caw.
`reset` läuft mit `--reset` vor dem ersten Test und in `run` von selbst einmal vor dem ersten schreibenden Test, außer mit
`--no-reset`.

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
| `start` | Shell-Befehl, der die Umgebung startet. Läuft nur mit `--start`. caw wartet nicht auf sein Ende: ein Befehl, der sich löst (`up -d`), und einer, der weiterläuft (`npm run dev`), gehen beide. |
| `stop` | Shell-Befehl, der sie stoppt. Nur zusammen mit `start`, und nur wenn caw die Umgebung gestartet hat. Ein weiterlaufendes `start` wird dann samt Kindprozessen beendet. |
| `reset` | Shell-Befehl, der die Daten zurücksetzt. Braucht `writable: true`. `run` führt ihn einmal vor dem ersten schreibenden Test aus, `--reset` vor dem ersten Test, `--no-reset` nie. `record` und `open` nur mit `--reset`. |
| `ready` | Wann die Umgebung als bereit gilt: ein GET auf `path` (Standard `/`) antwortet unter 500. caw fragt jede Sekunde, `timeoutMs` lang (Standard 60000, 1000 bis 1800000). |

Die Befehle laufen im Projektordner mit der Shell deiner Plattform (`cmd.exe` unter Windows, sonst `/bin/sh`), mit gesetztem
`CAW_ENV` und `CAW_ENV_URL`. Ihre Ausgabe geht nach `.caw/env/<env>-start.log`, `-stop.log` und `-reset.log`.

- Antwortet die Umgebung schon, nutzt `--start` sie und startet und stoppt nichts.
- Ein `start`, das mit einem Fehler endet, scheitert mit `env-start-failed`. Eines, das nie bereit wird, mit `env-not-ready`.
  In beiden Fällen stoppt caw, was es gestartet hat.
- Ein scheiterndes `reset` (oder eines, das länger als 10 Minuten braucht) scheitert mit `env-reset-failed`, und kein Test
  läuft.
- Ohne `--start` scheitert eine Umgebung, die nicht antwortet, mit `env-unreachable`; die Meldung nennt `--start`, wenn
  `start` gesetzt ist.
- Die Variable `CI` ändert nichts daran: `--start` ist immer ausdrücklich.

## signIn

Lass es weg, wenn deine App keine Anmeldung hat. Setze es auf oberster Ebene oder je Umgebung
(`environments.<env>.signIn`), etwa keine Anmeldung auf `local` und ein Identitätsanbieter auf `staging`.

| `type` | Für | Felder |
|---|---|---|
| `form` | Eine Anmeldeseite mit Benutzername und Passwort | `path`, `signedInSelector`, und entweder `userSelector` + `passwordSelector` (optional `submitSelector`, sonst schickt Enter ab; optional `codeSelector` für einen Einmalcode) oder `steps` |
| `basic` | HTTP Basic | `signedInSelector` (optional) |
| `session` | SSO, OAuth, MFA, die sich nicht automatisieren lassen: du meldest dich einmal mit `caw role login` an, caw nutzt die gespeicherte Sitzung | `signedInSelector`, optional `path` (Standard `/`) |
| `none` | Keine Anmeldung (wie `signIn` weglassen) | – |

- `path` ist ein Pfad der App, beginnend mit `/`. Die Anmeldung beginnt bei `<url><path>`; diese Seite darf zu einem
  Identitätsanbieter weiterleiten. Es ist nie die Adresse des Anbieters.
- `signedInSelector` gibt es nur angemeldet, auf der App. Verschwindet er während eines Laufs, meldet caw eine verlorene
  Anmeldung.
- Selektoren sind Playwright-Selektoren: standardmäßig CSS, auch `text=` und `role=`.

### Anmeldeschritte

Für einen Identitätsanbieter (Keycloak, Entra ID, Okta …), Identifier-first-Seiten oder zusätzliche Abfragen. Jeder Schritt
hat genau ein Verb, 1 bis 20 Schritte, mindestens einer füllt aus dem Testnutzer:

```json
"signIn": {
  "type": "form",
  "path": "/login",
  "signedInSelector": "[data-testid=user-menu]",
  "steps": [
    { "fill": "#username", "with": "user" },
    { "click": "#next" },
    { "waitFor": "#password" },
    { "fill": "#password", "with": "password" },
    { "click": "#sign-in" },
    { "fill": "#otp", "with": "totp" },
    { "press": "Enter", "on": "#otp" },
    { "click": "text=Angemeldet bleiben", "optional": true }
  ]
},
"allowHosts": ["login.example-idp.com"]
```

| Schritt | |
|---|---|
| `{ "fill": "<selektor>", "with": "user" \| "password" \| "totp" }` | Benutzername, Passwort oder aktueller Einmalcode der Rolle |
| `{ "fill": "<selektor>", "value": "<text>" }` | Ein fester Text, der kein Geheimnis ist, etwa ein Mandant oder eine Domäne |
| `{ "click": "<selektor>" }` | Klicken |
| `{ "press": "<taste>", "on": "<selektor>" }` | Eine Taste drücken, auf `on` oder auf dem fokussierten Element |
| `{ "waitFor": "<selektor>" }` | Warten, bis das Element sichtbar ist |
| `"optional": true` | Den Schritt überspringen, wenn sein Element nicht binnen 3 s sichtbar ist („Angemeldet bleiben?“) |
| `"timeoutMs"` | Wie lange ein Schritt auf sein Element wartet, Standard 30000 |

Die Schritte laufen der Reihe nach ab `<url><path>`, auf der jeweils aktuellen Seite; der Host des Anbieters muss in
`allowHosts` stehen. Nach dem letzten Schritt wartet caw bis zu 30 s auf `signedInSelector`. `init --explore-only` schlägt
die Schritte vor, wenn du dich dort bei einem Anbieter anmeldest.

### Einmalcodes

Gib der Rolle ein TOTP-Geheimnis (`CAW_<ROLLE>_TOTP`, Base32 wie im `otpauth://`-Link) und nutze `codeSelector` oder einen
Schritt mit `with: "totp"`. caw trägt den aktuellen Code ein (RFC 6238, SHA-1, 30 s, 6 Ziffern). Lehnt die App ihn ab, weil
sich das Konto im selben 30-s-Fenster schon angemeldet hat, wartet caw auf das nächste Fenster und versucht es noch einmal.
Passwörter und Codes sind in Trace, Logs und Berichten maskiert.

### Gespeicherte Sitzung

```json
"signIn": { "type": "session", "signedInSelector": "[data-testid=user-menu]" },
"allowHosts": ["login.example-idp.com"]
```

```bash
npx caw role login user --env dev   # einmal von Hand anmelden; die Sitzung landet in caw/.auth/dev/user.json
```

`caw/.auth/` ist gitignored. Ohne die Datei stoppt ein Lauf mit `auth-missing` und nennt diesen Befehl; ist die Sitzung
abgelaufen, nennt er ihn ebenso. In CI legst du die Datei vor dem Lauf aus einem Secret dort ab.

## roles

Ein Eintrag je Art von Nutzer, als der sich deine Tests anmelden. Eine Rolle ist ein leeres Objekt; Tests wählen eine mit
`role:`. Namen folgen den Regeln für Umgebungsnamen; `gate` ist reserviert.

```json
"roles": { "clerk": {}, "admin": {} }
```

Die Zugangsdaten folgen einer Namenskonvention, nie der Config:

```bash
# caw/.env
CAW_CLERK_USER=clerk@example.com
CAW_CLERK_PASSWORD=geheim
CAW_CLERK_TOTP=JBSWY3DPEHPK3PXP        # nur für Einmalcodes
CAW_CLERK_USER__STAGING=qa.clerk       # ein anderes Konto auf staging
CAW_CLERK_PASSWORD__STAGING=geheim2
```

- Die Endung `__<ENV>` (Umgebungsname in Großbuchstaben, `-` als `_`) ist das Konto für diese Umgebung. Ein Satz gilt als
  Ganzes: Gibt es eine Variable des Satzes mit Endung, mischt caw nie die ohne Endung hinein.
- Variablen des Prozesses (CI) gewinnen gegen `caw/.env`.
- `caw/.env` wird wie dotenv gelesen: `KEY=wert`, optional in Anführungszeichen; ein Kommentar nach dem Wert braucht ein
  Leerzeichen vor `#`.

Eine Rolle legst du mit `npx caw role add <rolle>` an: Sie kommt in die Config, ihre Variablennamen nach `caw/.env.example`; die
Werte trägst du selbst in `caw/.env` ein, caw fragt nie danach. Siehe [role](commands.de.md#role). Nimm Testkonten mit möglichst wenig
Rechten: Claude bedient einen Browser, der als dieser Nutzer angemeldet ist.

## Lokalen Code testen

caw kennt zwei Modi:

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
  "local": { "url": "http://localhost:5173", "agent": true, "writable": true }
}
```

`--env local` testet dann, was in deinem Editor steht (Vite, `ng serve`, webpack-Dev-Server, Next.js, Nuxt).

### Lokaler Code auf einer ausgelieferten Umgebung

Für Anwendungen, die nur in einer ausgelieferten Umgebung laufen (Portal, Shell, Backend nur auf Staging), legt die [Overlay-Erweiterung](extensions/overlay.de.md) deinen lokalen Code über die Umgebung. Sie ist nur mit einem `overlay`-Block in der Config aktiv.

## Alles Weitere

| Feld | Standard | |
|---|---|---|
| `language` | von init erkannt | Die Teamsprache, ein Code wie `en`, `de` oder `fr`: Claude schreibt Pläne, Schrittnamen und `report.md` darin. caws eigene Texte (CLI, Werkbank) nutzen sie auch, wenn sie `en` oder `de` ist, damit ein Projekt eine Sprache spricht; `CAW_LANG` setzt deine eigene. Sonst folgen sie deinem System. |
| `framework` | `web` | `web`, `react`, `vue`, `angular` oder [`extjs`](extensions/extjs.de.md). Entscheidet, wann eine Seite als bereit gilt und was ein Fehlerbericht nennt. |
| `start` | `/` | Pfad, an dem Tests beginnen; ein Test kann sein eigenes `start` setzen. |
| `source` | `.` | Wo der Quellcode der App liegt, relativ zum Projekt, oder `false`, wenn er nicht in diesem Repository ist (dann gibt Claude keine Code-Empfehlungen). |
| `agent.mode` | `local` | Wo Claude läuft: `local` (Claude Code auf deinem Rechner, nur lesende Werkzeuge), `docker` (isoliert) oder `session` (deine eigene Claude-Code-Sitzung). In CI immer `docker`. |
| `agent.model` | Standard von Claude Code | Modell für Claude, als `--model` übergeben, z. B. `haiku` oder `sonnet`. `CAW_AGENT_MODEL` ersetzt es für einen Lauf. |
| `agent.maxBudgetUsd` | keins | Stoppt einen Claude-Lauf bei diesen geschätzten Kosten in US-Dollar (`--max-budget-usd`). `CAW_AGENT_BUDGET` ersetzt es. |
| `maxActions` | `100` | Aktionsbudget von Claude beim Aufnehmen und Beheben. |
| `allowHosts` | `[]` | Weitere Hosts, auf die Seiten navigieren dürfen, etwa ein Anmeldedienst; auch je Umgebung. Seiten navigieren nur zu den Hosts der Umgebungen und diesen (Links, Formular-Posts, Popups, Weiterleitungen, `goto`); alles andere scheitert mit `host-blocked`. Ohne Claude dürfen Skripte, Styles, Schriften, Bilder, XHR/fetch, WebSockets und iframes zu jedem Host. Produktionshosts anderer Umgebungen bleiben für jeden Request unerreichbar. Hosts werden nach Namen verglichen (Groß-/Kleinschreibung und ein Punkt am Ende zählen nicht); ein Host, der über seine IP-Adresse erreicht wird, wird nicht erkannt. |
| `thirdPartyHosts` | `[]` | Hosts anderer Anbieter, die die App braucht, solange Claude dabei ist (record, ein Lauf mit Chat, `open`), z. B. `["fonts.example-cdn.com"]`; auch je Umgebung. Dann geht jeder Request des Browsers (Seiten, Skripte, XHR/fetch, WebSockets, Beacons, iframes) nur an die Umgebungen, `allowHosts` und diese; alles andere wird abgebrochen und im Lauf als Warnung mit diesem Schlüssel genannt. Ein Produktionshost bleibt auch hier gesperrt. Ohne Claude bewirkt die Liste nichts. |
| `browser` | System-Chrome | `{ "channel": "msedge" }` (`chrome`, `chrome-beta`, `chrome-dev`, `msedge`, `msedge-beta`, `msedge-dev`) oder `{ "executablePath": "/pfad/zu/chromium" }` (ein absoluter Pfad auf diesem Rechner; keine Netzwerkfreigabe, kein `\\?\`- oder `/proc`-Pfad) |
| `browser.noSandbox` | `false` | `true` startet Chrome ohne seine Sandbox. Unsicher: Eine Seite, die den Renderer von Chrome bricht, läuft dann mit deinen Rechten. Nur für Rechner, auf denen die Sandbox nicht starten kann (Linux als root, manche Container); caw hält dort mit `browser-sandbox` an, statt von selbst ohne Sandbox weiterzumachen. |
| `browser.locale`, `browser.timezone`, `browser.viewport` | wie aufgenommen | Sprache, Zeitzone und Größe des Testbrowsers, z. B. `"de-DE"`, `"Europe/Berlin"`, `{ "width": 1280, "height": 800 }`. Ohne sie nutzt eine Wiedergabe die mit der Aufnahme gespeicherten Werte, und eine Aufnahme die des Rechners. |
| `messageSelectors` | `[role=alert]`, `[role=alertdialog]` | CSS-Selektoren für Fehlermeldungen ohne ARIA-Rolle. |
| `consoleIgnore` | `[]` | RegExps für bekannte, harmlose Konsolenfehler. Halte sie eng. |
| `foreignCode` | `[]` | RegExps für Fremdskripte, z. B. `"/vendor/"`. Ihre Fehler werden Warnungen. |
| `requestKeys` | `[]` | Parameter, die einen Request benennen, für APIs mit einem Endpunkt: Query-Parameter wie `["action"]` oder JSON-Felder der obersten Ebene als `json.<key>`, z. B. `["json.method"]` für JSON-RPC. Ein GraphQL-Request heißt auch ohne das nach seiner Operation: `POST /graphql mutation CloseTicket`. |
| `reads` | `[]` | Requests, die nur lesen, obwohl sie kein GET sind, z. B. `["POST /api/search"]`. Ein Muster ist eine Methode (oder `*`) und ein Pfad, dann optional Schlüssel- und GraphQL-Teile: `*` passt innerhalb eines Pfadsegments (in den anderen Teilen auf beliebige Zeichen), `**` auf alles. `"POST /api/*/query"`, `"POST /api/proxy op=load*"`, `"POST /graphql mutation TrackView"`, `"* /api/telemetry/**"`. Ein Muster, das mit dem Pfad endet, passt nie auf einen GraphQL-Request. Nur auf oberster Ebene: Es ist in jeder Umgebung dieselbe App. |
| `effects.fail` | `["controls", "console"]` | Welche gelernten Effekte einen Schritt scheitern lassen, wenn sie sich ändern. `[]` macht alle zu Warnungen. |
| `readyTimeoutMs` | | Wie lange auf eine ruhige App gewartet wird. |
| `readyIgnore` | `[]` | CSS-Selektoren von Bereichen, die sich von selbst ändern, z. B. `["#ticker", ".clock", "footer [role=progressbar]"]`. Ihre DOM-Änderungen und Fortschrittsanzeigen zählen beim Warten auf eine ruhige Seite nicht. Spinner ohne Größe, versteckt oder außerhalb des Viewports zählen nie. Wird eine Seite nie ruhig, sagt der Lauf das und nennt `readyIgnore`. |
| `lintCommand` | | Dein Prüfbefehl, z. B. `npm run lint`. Claude nennt ihn in Code-Empfehlungen. |
| `sandboxImage` | `node:22-bookworm-slim` | Basis-Image für den `docker`-Agenten. Sonst `image` aus `.devcontainer/devcontainer.json`. |
| `sandboxUser` | `node` | Nutzer im Container. |
| `overlay` | | Schaltet die [Overlay-Erweiterung](extensions/overlay.de.md) ein. |

Jedes andere Feld meldet caw als unbekannt (`Unbekanntes Feld: …`). Das gilt auch für `theme`: Die Werkbank hat ein Aussehen in einem hellen und einem dunklen Modus, den du für dich wählst (siehe [Persönliche Einstellungen](#persönliche-einstellungen)).

## caw/caw.md

Schlichtes Markdown, wie eine `CLAUDE.md` für deine Tests. Schreib auf, was Claude im Code nicht sieht, was aber in jedem Test zählt:

```markdown
## Suche
- Die Suche behält die letzte Eingabe über Sitzungen hinweg. Zuerst "Filter löschen" klicken.
```

Eine Änderung macht nie eine Aufnahme ungültig. Keine personenbezogenen Daten.

### Deine eigene caw.md

Neben `prefs.json` (siehe unten) hält eine `caw.md` deine persönlichen Notizen für Claude, gleich in jedem Projekt: wie du Befunde
berichtet haben willst, worauf immer geschaut werden soll, Begriffe, die du verwendest. Claude liest sie in jedem Lauf, in dem es
arbeitet (Aufnahme, Chat, `--explain`, Entwickeln, `reproduce`, deine eigene Session als Agent; in Docker als Text in der Aufgabe),
vor der `caw/caw.md` des Projekts, die bei Widersprüchen gilt. Sie kommt nie in einen Test, eine Aufzeichnung oder ins Projekt. Der
Bericht vermerkt, dass sie gelesen wurde (Pfad und Zeilenzahl, nicht der Inhalt), und `caw doctor` zeigt, ob es eine gibt.

Beide Dateien können aus einem Lauf wachsen: Claudes Empfehlung kann eine Zeile für eine der beiden vorschlagen. Die Karte nennt
die Datei (Projekt, über git geteilt, oder persönlich, mit Pfad), und erst dein Klick auf „Übernehmen“ schreibt sie. Sonst wird so
nie etwas außerhalb des Projekts geschrieben.

## Persönliche Einstellungen

Werkbank-Einstellungen und deine Sprache liegen je Nutzer in `prefs.json` unter `CAW_AI_HOME`, standardmäßig
`%APPDATA%\caw-ai` oder `~/.config/caw-ai`. Nicht im Projekt. Deine eigene `caw.md` (siehe oben) liegt im selben Ordner.

| Schlüssel | Werte | |
|---|---|---|
| `mode` | `system` (Standard), `light`, `dark` | Hell oder dunkel für Werkbank, Chat, Berichtsseite und die Karte „caw explore“. `system` folgt deinem Betriebssystem. |
| `animations` | `on` (Standard), `off` | `off` hält Spinner, pulsierende Punkte und den blinkenden Cursor an (F10). |
| `steps`, `chat` | `open` (Standard), `closed` | Ob Schrittliste und Chat offen sind, wenn ein Lauf beginnt (F4, F6). |
| `tokenNotice` | `on` (Standard), `off` | `off` überspringt den Hinweis, bevor Claude Token verbraucht. Gesetzt von „Nicht mehr fragen“; entfernst du den Eintrag, kommt der Hinweis wieder. |
| `language` | `de`, `en` | Deine Sprache für caws eigene Texte. `CAW_LANG` gewinnt. |

Die Einstellungsseite der Werkbank (Strg+,) setzt `mode`, `animations`, `steps` und `chat` und zeigt den Rest nur lesend:
Die Seite teilt ihren Ursprung mit der getesteten Anwendung und darf darum nur ändern, wie die Werkbank aussieht.
Unbekannte Schlüssel und Werte ignoriert caw.
