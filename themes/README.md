# Themes

A theme is a folder with a `theme.json`. The four built-in themes live here; your own live next to your preferences:

```
%APPDATA%\caw-ai\themes\<name>\theme.json      Windows
~/.config/caw-ai/themes/<name>/theme.json       Linux, macOS
```

Every built-in theme has a dark and a light mode. Your own may have one or both; a mode a theme lacks is greyed out.

| Theme | Look |
|---|---|
| `studio` | Calm cards with rounded corners, state as badges, keys as keycaps. Default. |
| `terminal` | Retro terminal: pixel type for headings, box-drawing frames, scanlines in the dark mode. |
| `raster` | Swiss style: hard rules, no radius, solid header bars, one strong blue. |
| `glas` | Frosted, translucent panes over soft colour fields. |

## Change it in the UI

Press **F7** in the workbench. Switch between **Dark** and **Light** at the top, pick a theme, change colours, glyphs, the raven or the CRT look, and see it live. Editing a built-in theme saves a copy under a new name; colours you change in the light mode go to that mode only. Your choice is stored in `prefs.json`, so it is yours alone, across all projects.

```sh
caw theme                 # list themes, mark the active one and the mode
caw theme use raster      # switch the theme
caw theme mode light      # light or dark
```

The terminal output takes marks and colours from the theme too, its dark colours if it has them: caw cannot know your terminal's background.

## Write one by hand

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

A custom theme names a built-in `base` and lists only what differs. Everything missing or broken falls back to the base, the light mode included.

| Key | What it sets |
|---|---|
| `colors` | 13 base colours: `screen pane frame text muted accent ok warn fail info claude human heart`, `#rrggbb` only. Lines, surfaces and shadows are mixed from them. |
| `crt` | scanlines, vignette, glow on headings and text |
| `scheme` | the mode of `colors` and `crt`: `dark` (default) or `light` |
| `light` / `dark` | the other mode, in the same file: `colors` and `crt` that replace the top-level ones. Optional; without it the theme has one mode. |
| `mono` | single colour look: failures inverted, stronger scanlines |
| `fonts` | `display` (headings, marks, keys) and `text`. `builtin:<file>` or `fonts/<file>.woff2` in the package |
| `marks` | status marks, all the same width. `{spinner}` is the current spinner frame |
| `spinner` `bullets` `tree` `rule` `legend` `box` `progress` | glyphs for workbench, explore card and terminal |
| `prompt` | chat prompts, e.g. `Claude` and `You` |
| `raven` | ASCII logo (`{eye}`, `{beak}`), blinking, hearts on click |
| `css` | optional stylesheet in the package for a full redesign of workbench, chat and explore card |

Text values may be given per language: `{ "de": "[FEHLER]", "en": "[ FAIL ]" }`.

The pages carry `data-scheme="dark"` or `data-scheme="light"` on `<html>`, so a `theme.css` can style a mode on its own: `:root[data-scheme=light]{ … }`.

`theme.css` is only read from disk. The page under test can pick a theme name and save values that pass the schema, never CSS or files.

Check a theme before sharing it:

```sh
caw theme check hafen     # schema, contrast in both modes, mark widths, fonts
```

To share a theme, copy its folder.

## Team default

`theme` in `caw.config.json` sets a default for everyone in the project: a built-in `base` and optionally `colors` (the 13 base colours of its top-level mode). A personal choice in `prefs.json` wins.

```json
"theme": { "base": "raster", "colors": { "accent": "#ffd166" } }
```
