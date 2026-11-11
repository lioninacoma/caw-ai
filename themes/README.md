# Themes

A theme is a folder with a `theme.json`. The six built-in themes live here; your own live next to your preferences:

```
%APPDATA%\caw-ai\themes\<name>\theme.json      Windows
~/.config/caw-ai/themes/<name>/theme.json       Linux, macOS
```

| Theme | Look |
|---|---|
| `nacht` | Colourful, the workbench colours. Default. |
| `bernstein` | Single colour amber monitor. Status by glyph and brightness. |
| `phosphor` | Single colour green monitor. Status by glyph and brightness. |
| `kachel` | Tiled windows like tmux: flush, tab and status bar, monospace only. |
| `plakat` | Bright and loud: signal yellow, thick borders, steps as tiles, one big number. |
| `cockpit` | Instrument panel: a round gauge, warning lamps for the steps, round controls. |

## Change it in the UI

Press **F7** in the workbench. Pick a theme, change colours, glyphs, the raven or the CRT look, and see it live. Editing a built-in theme saves a copy under a new name. Your choice is stored in `prefs.json`, so it is yours alone, across all projects.

```sh
caw-ai theme                 # list themes, mark the active one
caw-ai theme use phosphor    # switch
```

## Write one by hand

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

A custom theme names a built-in `base` and lists only what differs. Everything missing or broken falls back to the base.

| Key | What it sets |
|---|---|
| `colors` | 13 base colours: `screen pane frame text muted accent ok warn fail info claude human heart`, `#rrggbb` only. Lines, surfaces and shadows are mixed from them. |
| `mono` | single colour look: failures inverted, stronger scanlines |
| `crt` | scanlines, vignette, glow on headings and text |
| `fonts` | `display` (headings, marks, keys) and `text`. `builtin:<file>` or `fonts/<file>.woff2` in the package |
| `marks` | status marks, all the same width. `{spinner}` is the current spinner frame |
| `spinner` `bullets` `tree` `rule` `legend` `box` `progress` | glyphs for workbench, explore card and terminal |
| `prompt` | chat prompts `claude>` and `you>` |
| `raven` | ASCII logo (`{eye}`, `{beak}`), blinking, hearts on click |
| `css` | optional stylesheet in the package for a full redesign of workbench, chat and explore card |

Text values may be given per language: `{ "de": "[FEHLER]", "en": "[ FAIL ]" }`.

`theme.css` is only read from disk. The page under test can pick a theme name and save values that pass the schema, never CSS or files.

Check a theme before sharing it:

```sh
caw-ai theme check hafen     # schema, contrast, mark widths, fonts
```

To share a theme, copy its folder.

## Team default

`theme` in `caw.config.json` sets a default for everyone in the project: a built-in `base` and optionally `colors` (the 13 base colours). A personal choice in `prefs.json` wins.

```json
"theme": { "base": "phosphor", "colors": { "accent": "#ffd166" } }
```
