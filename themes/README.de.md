# Themes

Ein Theme ist ein Ordner mit einer `theme.json`. Die vier eingebauten liegen hier, eigene neben den persönlichen Einstellungen:

```
%APPDATA%\caw-ai\themes\<name>\theme.json      Windows
~/.config/caw-ai/themes/<name>/theme.json       Linux, macOS
```

Jedes eingebaute Theme hat einen dunklen und einen hellen Modus. Eigene dürfen einen oder beide haben; ein fehlender Modus ist ausgegraut.

| Theme | Aussehen |
|---|---|
| `studio` | Ruhige Karten mit runden Ecken, Status als Badges, Tasten als Tastenkappen. Standard. |
| `terminal` | Retro-Terminal: Pixelschrift für Überschriften, Rahmen aus Linienzeichen, Rasterzeilen im dunklen Modus. |
| `raster` | Schweizer Stil: harte Linien, keine Rundungen, Kopfzeilen als volle Balken, ein kräftiges Blau. |
| `glas` | Mattierte, halbtransparente Fenster über sanften Farbflächen. |

## Wählen

**F7** in der Werkbank. Oben zwischen **Dunkel** und **Hell** wechseln und ein Theme wählen; Werkbank und Chat wechseln sofort. Ein Modus, den das Theme nicht hat, ist ausgegraut. Der Dialog wählt nur: Ein eigenes Theme ist ein Ordner, den du schreibst (unten), und erscheint beim nächsten Öffnen des Dialogs. Die Wahl steht in `prefs.json`, gilt also nur für dich, in allen Projekten.

```sh
caw theme                 # Themes auflisten, aktives und Modus markiert
caw theme use raster      # Theme wechseln
caw theme mode light      # hell oder dunkel
```

Auch die Terminal-Ausgabe nimmt Marken und Farben aus dem Theme, seine dunklen Farben, falls es welche hat: Den Hintergrund deines Terminals kennt caw nicht.

## Von Hand schreiben

```json
{
  "$schema": "https://github.com/lioninacoma/caw-ai/themes/theme.schema.json",
  "themeApi": 1,
  "name": "hafen",
  "base": "studio",
  "colors": { "frame": "#3f8f8a", "accent": "#ffd166" },
  "light": { "colors": { "accent": "#8a5a00" } },
  "marks": { "ok": "[ PASS ]" }
}
```

Ein eigenes Theme nennt ein eingebautes als `base` und listet nur, was abweicht. Was fehlt oder kaputt ist, kommt aus `base`, auch der helle Modus.

| Schlüssel | Was er setzt |
|---|---|
| `colors` | 13 Grundfarben: `screen pane frame text muted accent ok warn fail info claude human heart`, nur `#rrggbb`. Linien, Flächen und Schatten werden daraus gemischt. |
| `crt` | Rasterzeilen, Vignette, Leuchten auf Überschriften und Text |
| `scheme` | der Modus von `colors` und `crt`: `dark` (Standard) oder `light` |
| `light` / `dark` | der andere Modus, in derselben Datei: `colors` und `crt`, die die obersten ersetzen. Optional; ohne ihn hat das Theme einen Modus. |
| `mono` | einfarbiger Look: Fehler invertiert, kräftigere Rasterzeilen |
| `fonts` | `display` (Überschriften, Marken, Tasten) und `text`. `builtin:<datei>` oder `fonts/<datei>.woff2` im Paket |
| `marks` | Statusmarken, alle gleich breit. `{spinner}` ist das aktuelle Bild des Spinners |
| `spinner` `bullets` `tree` `rule` `legend` `box` `progress` | Zeichen für Werkbank, Explore-Karte und Terminal |
| `prompt` | Chat-Prompts, etwa `Claude` und `Du` |
| `raven` | ASCII-Logo (`{eye}`, `{beak}`), Blinzeln, Herzen beim Klick |
| `css` | optionales Stylesheet im Paket für ein komplettes Redesign von Werkbank, Chat und Explore-Karte |

Texte gehen auch je Sprache: `{ "de": "[FEHLER]", "en": "[ FAIL ]" }`.

Die Seiten tragen `data-scheme="dark"` oder `data-scheme="light"` am `<html>`, eine `theme.css` kann einen Modus also eigens gestalten: `:root[data-scheme=light]{ … }`.

caw liest Themes nur, es schreibt nie eines. Die getestete Seite kann höchstens ein Theme oder den Modus wählen, nie ein Theme ändern.

Vor dem Weitergeben prüfen:

```sh
caw theme check hafen     # Schema, Kontrast in beiden Modi, Markenbreite, Schriften
```

Weitergeben heißt: Ordner kopieren.

## Vorgabe fürs Team

`theme` in `caw.config.json` legt eine Vorgabe für alle im Projekt fest: ein eingebautes `base` und optional `colors` (die 13 Grundfarben seines obersten Modus). Eine eigene Wahl in `prefs.json` geht vor.

```json
"theme": { "base": "raster", "colors": { "accent": "#ffd166" } }
```
