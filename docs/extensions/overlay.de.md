[English](overlay.md) · Deutsch

# Erweiterung: Overlay (lokaler Code auf einer ausgelieferten Umgebung)

Für Anwendungen, die nur innerhalb einer ausgelieferten Umgebung laufen, etwa in einem Portal oder einer Shell, oder mit einem
Backend, das es nur auf Staging gibt. Seite, API, Cookies und Anmeldung bleiben die der Umgebung; nur der Code der App kommt von
deinem Rechner. Ein Dev-Server auf deinem Rechner braucht kein Overlay: Er ist einfach eine Umgebung
(`"local": { "url": "http://localhost:5173" }`).

Die Erweiterung ist nur aktiv, wenn `caw.config.json` einen `overlay`-Block hat. Ohne ihn gibt es `caw overlay` und `--overlay`
nicht (sie verweisen auf diese Seite), und Hilfe, `validate`, `doctor` und die MCP-Werkzeuge erwähnen es nicht. `init` schreibt den
Block nie.

## Config

```json
"overlay": {
  "environments": ["dev"],
  "parts": {
    "orders": { "dir": "apps/orders", "url": "http://localhost:5173/", "start": "npm run dev" },
    "admin":  { "dir": "apps/admin", "build": "dist", "start": "npm run build" }
  },
  "assetUrlPattern": "/static/([^/?#]+\\.js)"
}
```

| Schlüssel | Regel |
|---|---|
| `environments` | Wo `--overlay` erlaubt ist. Sie müssen existieren, dürfen nicht Produktion und kein Dev-Server auf diesem Rechner sein |
| `parts.<teil>` | Einer je eigenständig gebauter App. Namen wie bei Umgebungen; nicht `build` oder `dev` |
| `dir` | Der Ordner des Teils, relativ, ohne `..` |
| `url` | Der lokale Code-Server (Dev-Server, Sencha-Watch). Bei ExtJS standardmäßig `http://localhost:1841/` |
| `build` | Ein Build-Ordner statt eines Servers (nicht bei ExtJS) |
| `start` | Startet oder baut die Quelle; braucht `url` oder `build` (oder ExtJS) |
| `statics` | `[{ name, path }]`: feste Dateien aus deinem Workspace (`path` relativ zu `dir`, darf mit `..` in ein Nachbarpaket führen, nie aus dem Workspace hinaus oder zu einer geheimen Datei) |
| `assetUrlPattern` | RegExp mit Gruppe 1 = Dateiname, oben oder je Teil; `overlay check --apply` schlägt sie vor |

## Auf der Kommandozeile

`--overlay` bei `run`, `record` und `open`. Ohne Wert jeder Teil mit seiner Quelle; sonst eine Komma-Liste: `orders`,
`orders:dev`, `admin:build`, `build`, `dev` oder eine URL, wenn es nur einen Teil gibt (`--overlay http://localhost:5174`). Nicht
genannte Teile bleiben ausgeliefert. Jeder Lauf nennt den Code in seinen ersten Zeilen (`Code: overlay, Dev-Server …`).

`--start` startet, was der Befehl braucht und nicht läuft, und stoppt es danach: zuerst das `start` der Umgebung, dann das `start`
jedes gewählten Teils.

### caw overlay status

```bash
npx caw overlay status --env dev --part orders --json
```

Ist der lokale Code-Server des Teils bereit? Ohne Browser, startet nichts.

| Zustand | Bedeutung | Exit |
|---|---|---|
| `ready` | Der Server antwortet (ExtJS: liefert diese App); ein Build-Ordner oder feste Dateien sind ebenfalls `ready` | 0 |
| `moved` | Die ExtJS-Watch läuft auf `foundUrl` statt `url` (Port belegt); Läufe nehmen sie; `url` anpassen | 0 |
| `down` | Unter `url` antwortet nichts; die Ausgabe nennt `start` und den Ordner des Teils | 2 |
| `wrong-app` | Unter `url` antwortet eine andere App (oder keine Sencha-Watch) | 2 |
| `stale` | Die Watch nennt Dateien in `bootstrap.json`, die sie nicht ausliefert | 2 |
| `static-missing` | Eine Datei aus `statics` fehlt | 2 |
| `not-overlay`, `no-part`, `no-app` | Die Umgebung steht nicht in `overlay.environments`, der Teil ist unbekannt oder hat keine `app.json` (ExtJS) | 3 |
| `static-invalid` | Ein `statics`-Pfad führt aus dem Workspace hinaus oder zu einer geheimen Datei | 3 |

`--json` gibt `{ state, framework, part, partDir, url, foundUrl?, start, statics?, message? }` als einzige Zeile auf stdout aus.

### caw overlay check

```bash
npx caw overlay check --env dev --apply
```

Öffnet die App headless mit `--overlay` (angemeldet, ohne Schritte, ohne Claude) und vergleicht die Skript-Requests der Seite mit
dem, was das Overlay ersetzen soll. Je Teil `local`, `deployed` (ein Mischstand) oder `not loaded`. Für eine Quelle, die vom Server
kam, schlägt es ein `assetUrlPattern` vor; `--apply` schreibt die fehlenden in die Config (geprüft) und prüft noch einmal. Vorher
läuft `overlay status`; gestartet wird nichts außer mit `--start`. Das Ergebnis steht auch in `.caw/overlay-check.json`. Exit 0
vollständig, 2 unvollständig oder Server-Problem, 3 keine Overlay-Umgebung oder kein Teil. `--env` ist standardmäßig die einzige
Overlay-Umgebung, `--part` und `--role` der einzige Teil und die erste Rolle.

## Aus Claude Code

Mit dem Block listet der MCP-Server `caw_overlay` (`status`, `check`, `apply`) und das Guide-Thema `overlay`, und `caw_start` nimmt
`overlay`. caw startet deinen lokalen Code-Server nie aus der Session: Claude fragt dich und startet ihn in seiner eigenen Session,
außer die Regeln deines Projekts sagen etwas anderes.

## Fehlercodes

| Code | Exit | Abhilfe |
|---|---|---|
| `overlay-not-ready` | 2 | Der lokale Code-Server unter `overlay.parts.<part>.url` antwortet nicht, liefert eine andere App, oder der Build fehlt: den `start`-Befehl aus der Meldung im App-Ordner ausführen oder `--start` angeben |
| `overlay-ssr` | 2 | Serverseitig gerenderte Seite: lokalen Code mit dem Dev-Server als Umgebung testen (`--env local`) |
| `overlay-incomplete` | 2 | Teile kamen vom Server statt aus dem lokalen Code (Mischstand): das vorgeschlagene `assetUrlPattern` eintragen oder `overlay check --apply` |
| `overlay-unused` | 2 | Nichts kam aus dem lokalen Code: Passen Build bzw. Dev-Server zur App, erfasst `assetUrlPattern` ihre Requests? |
| `overlay-ambiguous` | 2 | ExtJS: einer App in `app.json` einen eigenen `output.js.path` geben |
| `overlay-stale` | 2 | ExtJS: `bootstrap.json` des Watch nennt Dateien, die er nicht ausliefert. Warten, bis der Watch fertig gebaut hat, oder ihn neu starten |
