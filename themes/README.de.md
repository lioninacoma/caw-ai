# Themes

Ein Theme ist ein Ordner mit einer `theme.json`. Die sechs eingebauten liegen hier, eigene neben den persönlichen Einstellungen:

```
%APPDATA%\caw-ai\themes\<name>\theme.json      Windows
~/.config/caw-ai/themes/<name>/theme.json       Linux, macOS
```

| Theme | Aussehen |
|---|---|
| `nacht` | Bunt, Farben der Werkbank. Standard. |
| `bernstein` | Einfarbig, Bernstein-Monitor. Status über Zeichen und Helligkeit. |
| `phosphor` | Einfarbig, grüner Monitor. Status über Zeichen und Helligkeit. |
| `kachel` | Kachelfenster wie tmux: bündig, Tab- und Statusleiste, nur Monospace. |
| `plakat` | Hell und laut: Signalgelb, dicke Ränder, Schritte als Kacheln, große Zahl. |
| `cockpit` | Instrumentenbrett: Rundinstrument, Warnleuchten für die Schritte, runde Bedienelemente. |

## In der Oberfläche ändern

**F7** in der Werkbank. Theme wählen, Farben, Zeichen, Rabe oder CRT-Look ändern, alles sofort sichtbar. Wer ein eingebautes Theme ändert, speichert eine Kopie unter neuem Namen. Die Wahl steht in `prefs.json`, gilt also nur für dich, in allen Projekten.

```sh
caw-ai theme                 # Themes auflisten, aktives markiert
caw-ai theme use phosphor    # wechseln
```

## Von Hand schreiben

```json
{
  "$schema": "https://github.com/lioninacoma/caw-ai/themes/theme.schema.json",
  "themeApi": 1,
  "name": "hafen",
  "base": "nacht",
  "colors": { "frame": "#3f8f8a", "accent": "#ffd166" },
  "marks": { "ok": "[ PASS ]" }
}
```

Ein eigenes Theme nennt ein eingebautes als `base` und listet nur, was abweicht. Was fehlt oder kaputt ist, kommt aus `base`.

| Schlüssel | Was er setzt |
|---|---|
| `colors` | 13 Grundfarben: `screen pane frame text muted accent ok warn fail info claude human heart`, nur `#rrggbb`. Linien, Flächen und Schatten werden daraus gemischt. |
| `mono` | einfarbiger Look: Fehler invertiert, kräftigere Rasterzeilen |
| `crt` | Rasterzeilen, Vignette, Leuchten auf Überschriften und Text |
| `fonts` | `display` (Überschriften, Marken, Tasten) und `text`. `builtin:<datei>` oder `fonts/<datei>.woff2` im Paket |
| `marks` | Statusmarken, alle gleich breit. `{spinner}` ist das aktuelle Bild des Spinners |
| `spinner` `bullets` `tree` `rule` `legend` `box` `progress` | Zeichen für Werkbank, Explore-Karte und Terminal |
| `prompt` | Chat-Prompts `claude>` und `du>` |
| `raven` | ASCII-Logo (`{eye}`, `{beak}`), Blinzeln, Herzen beim Klick |
| `css` | optionales Stylesheet im Paket für ein komplettes Redesign von Werkbank, Chat und Explore-Karte |

Texte gehen auch je Sprache: `{ "de": "[FEHLER]", "en": "[ FAIL ]" }`.

`theme.css` wird nur von der Platte gelesen. Die getestete Seite kann einen Theme-Namen wählen und Werte speichern, die das Schema bestehen, nie CSS oder Dateien.

Vor dem Weitergeben prüfen:

```sh
caw-ai theme check hafen     # Schema, Kontrast, Markenbreite, Schriften
```

Weitergeben heißt: Ordner kopieren.

## Vorgabe fürs Team

`theme` in `caw.config.json` legt eine Vorgabe für alle im Projekt fest: ein eingebautes `base` und optional `colors` (die 13 Grundfarben). Eine eigene Wahl in `prefs.json` geht vor.

```json
"theme": { "base": "phosphor", "colors": { "accent": "#ffd166" } }
```
