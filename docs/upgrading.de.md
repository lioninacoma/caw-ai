[English](upgrading.md) · Deutsch

# Upgrade von 0.1.0

Das nächste Release ändert Config-Schlüssel, Exit-Codes und Dateinamen. Eine Kompatibilitätsschicht gibt es nicht: Alte Schlüssel werden abgewiesen, `validate` und `doctor` sagen, wohin sie gewandert sind. Arbeite die Liste ab und führe danach `npx caw-ai validate` aus.

## 1. Node

Node 22.4 oder neuer.

## 2. `caw.config.json`

### Umgebungen: `agent` → `claude`, `localCode` → `overlay`

Vorher:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "agent": true, "writable": true },
  "dev":   { "url": "https://dev.example.com", "agent": true, "localCode": true, "writable": true }
}
```

Nachher:

```json
"environments": {
  "local": { "url": "http://localhost:5173", "claude": true, "writable": true },
  "dev":   { "url": "https://dev.example.com", "claude": true, "overlay": true, "writable": true }
}
```

`localCode: true` schaltete von selbst auf lokalen Code um. `overlay: true` erlaubt ihn nur: Gib `--overlay` an `run`, `record`, `fix` oder `open` mit, wenn du deinen lokalen Code willst. Ohne die Option testet jeder Lauf, auch `run --until`, den ausgelieferten Stand. Ein Dev-Server auf deinem Rechner (`local` oben) braucht keins von beiden; er ist eine eigene Umgebung.

`agent.sandbox` oben in der Config bleibt, wie es ist.

### Apps: `statics`, `redirects`, `constants` → `overlay`

Vorher:

```json
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "statics": [{ "name": "main.js", "path": "dist/main.js" }]
  }
}
```

Nachher, mit Build-Ordner:

```json
"apps": {
  "web": {
    "dir": ".",
    "startUrl": "/",
    "overlay": {
      "build": "dist",
      "buildCommand": "npm run build"
    }
  }
}
```

Oder mit Dev-Server:

```json
"overlay": {
  "dev": "http://localhost:5173",
  "devCommand": "npm run dev -- --port 5173 --strictPort"
}
```

Dateien mit festem Namen, die nicht zum Build gehören, bleiben als `overlay.statics`: `"overlay": { "statics": [{ "name": "Fx/Static.js", "path": "static.js" }] }`.

**ExtJS:** `redirects` und `constants` haben keinen Ersatz. Mit `"framework": "extjs"` ist der Sencha-Watch die Quelle; caw-ai liest die Build-Namen von App und Paketen aus `app.json`, `.sencha/app/*.properties` und `bootstrap.json`. Lösche beide Schlüssel. Behalte vorhandene `statics` unter `overlay` und setze `"devCommand": "sencha app watch"`, wenn caw-ai den Watch starten soll.

**`assetUrlPattern`:** Gruppe 1 nennt jetzt einen Eintrag aus `overlay.statics`, einen Pfad in `overlay.build` oder den Build-Namen einer ExtJS-App oder eines Pakets.

Details: [Lokalen Code testen](configuration.de.md#lokalen-code-testen).

## 3. Testdateien

`caw/tests/<test>.yaml` enthält nur noch die Beschreibung. Ein `recording`-Block in einem Schritt oder eine `knownMessages`-Liste dort ist jetzt ein Fehler (`test-invalid`); 0.1.0 las solche Einzeldateien noch und teilte sie beim nächsten Schreiben auf.

- Noch auf 0.1.0: Führe für diese Tests vor dem Upgrade einmal `fix` oder `record` aus; beim Schreiben zieht die Aufzeichnung nach `caw/recordings/<test>.yaml`.
- Schon aktualisiert: Verschiebe `recording` jedes Schritts und die `knownMessages`-Liste von Hand nach `caw/recordings/<test>.yaml`, oder lösche sie und nimm mit `record` neu auf.

## 4. Exit-Codes in CI-Skripten

| Situation | 0.1.0 | jetzt |
|---|---|---|
| Aufzeichnung fehlt oder ist veraltet (`replay-missing`, `replay-stale`) | `3` | `4` |
| Unerwarteter interner Fehler | `1` | `2` |
| Sitzungsdatei fehlt (`auth-missing`), `TODO`-Selektoren der Anmeldung bei `run` | `2` | `3` |
| `record`, `fix`, `open`, `run --until`, `run --handover` mit gesetztem `CI` | wartete auf einen Menschen | `3` |

`1` heißt jetzt immer: Die App hat den Test nicht bestanden. Ein Skript, das `3` als „muss aufgenommen werden“ las, prüft `4`. Bei mehreren Tests (`run a b c`, `run --all`) gilt der schlechteste Exit-Code: `2` > `1` > `4` > `3` > `0`. Siehe [Exit-Codes](commands.de.md#exit-codes).

## 5. Dateien in `.caw/`

Skripte, die Lauf-Ordner lesen, brauchen die neuen Namen:

| 0.1.0 | jetzt |
|---|---|
| `agent/claude-gespraech.log` | `agent/claude-talk.log` |
| `agent/claude-empfehlung.log` | `agent/claude-advice.log` |
| `test-entwurf.yaml` | `test-draft.yaml` |
| `report-testlauf.md` | `report-test-run.md` |
| `vorfuehrung.json` | `demonstration.json` |
| `punkt-N.png` | `point-N.png` |
| `fehler.json` | `failures.json` |
| `netzwerk.json` | `network.json` |
| `fehler-schritt-N.png` | `failure-step-N.png` |
| `agent/anleitung.md` | `agent/instructions.md` |
| `.caw/auswahl.json` | `.caw/selection.json` |
| Lauf-Ordner `…-vorfuehrung` | `…-demonstration` |

`result.json`, `report.md` und `trace.zip` behalten ihre Namen. Alte Lauf-Ordner werden nicht umbenannt; lösche `.caw/runs/`, wenn du sie nicht brauchst.

## 6. Claude-Code-Skill

Der Skill hat sich mit den Befehlen geändert. Aktualisiere die installierte Kopie und den Eintrag in `.mcp.json`:

```bash
npx caw-ai skill
```

Mit dem Agenten `docker` wird das Image beim nächsten Lauf neu gebaut; es installiert Claude Code jetzt fest auf Hauptversion 2.

## 7. Persönliche Einstellungen

Das helle Theme und die Einstellung `fed` gibt es nicht mehr. Ein `"theme": "light"` oder `"dark"` in `prefs.json` fällt auf `nacht` zurück. Wähle ein Theme mit `npx caw-ai theme use <name>` (`nacht`, `bernstein`, `phosphor`).

## 8. Prüfen

```bash
npx caw-ai validate   # Config und Tests, offline
npx caw-ai list       # Aufzeichnungsstand je Test
npx caw-ai doctor     # Rechner, Zugangsdaten, Umgebungen
```

`validate` nennt jeden alten Schlüssel und wohin er gewandert ist, etwa „environments.dev.agent heißt seit 0.3.0 claude“, und jeden Schlüssel, den es nicht kennt.
