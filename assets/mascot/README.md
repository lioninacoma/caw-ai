# Maskottchen-Pipeline

Aus dem Krähen-Rig in Blender werden das Spritesheet der Werkbank (`assets/raven-sheet.png`) und seine Clip-Tabelle
(`src/host/raven-clips.mjs`):

```
crow.blend ──(Blender headless: export.py + animate.py)──▶ out/mascot.glb, out/probe.glb ──(Pixor)──▶ out/pixor.png + .json, out/probe.png
           ──(clean.mjs: Pixel-Art-Regeln)──▶ out/clips.png ──(sheet.mjs: eine Zeile je Clip)──▶ out/sheet.png + out/clips.json
           ──(Aseprite: fixes.lua + fixes.aseprite)──▶ out/final.png ──(--install)──▶ raven-sheet.png, favicon-32.png, src/host/raven-clips.mjs
```

Die Werkbank spielt jeden Clip mit allen Frames und Zeiten ab, so wie er animiert ist.

Nichts davon kommt ins npm-Paket, `tools/` steht nicht in `files`.

## Voraussetzungen

- **Blender** 5.2 oder neuer. Gefunden wird `BLENDER=<Pfad>`, sonst die neueste Version unter `C:\Program Files\Blender Foundation`, sonst `blender` im PATH.
- **Pixor** 2.4 (`pxr`), gefunden über `PXR=<Pfad>`, sonst `pxr` im PATH. Pixor ist pro Person lizenziert und darf weder ins Repo noch in CI. Deshalb wird nur das fertige PNG committet.
- **Aseprite** 1.3 für die Handkorrekturen, gefunden über `ASEPRITE=<Pfad>`, sonst die übliche Installation bzw. `aseprite`. Ohne Aseprite und ohne `fixes.aseprite` ist das Ergebnis das gerenderte Sheet.

## Benutzen

```bash
npm run mascot                # Vorschau nach assets/mascot/out/
npm run mascot -- --watch     # baut neu, sobald crow.blend, fixes.aseprite, mascot.json, animate.py oder export.py sich ändern
npm run mascot -- --install   # schreibt assets/raven-sheet.png, assets/favicon-32.png und src/host/raven-clips.mjs
npm run mascot -- --import X  # übernimmt ein von Hand bereinigtes final.png (X) als Korrekturen nach fixes.aseprite
npm run mascot -- --look P    # übernimmt Licht, Lichttöne und Kamerawinkel aus einem Pixor-Projekt (P)
npm run mascot -- --size 48   # Variante mit 48-px-Zellen nach out/size-48/ (mascot.json bleibt)
```

In `out/` liegen danach:

| Datei | Inhalt |
|---|---|
| `final.png` | das Sheet mit Korrekturen, wie es die Werkbank bekommt: eine Zeile je Clip, Zellen zu `cell` px (16) |
| `clips.json` | die Clip-Tabelle dazu: je Clip die Frames als `[Spalte, Zeile, ms]` |
| `final-x6.png` | das Sheet, 6-fach vergrößert zum Anschauen |
| `gif/<clip>.gif` | jeder Clip genau so, wie die Werkbank ihn abspielt (`final.png` nach `clips.json`), 4-fach |
| `sheet.png` | das Sheet ohne Korrekturen |
| `clips.png` | alle Pixor-Frames nach der Bereinigung |
| `pixor.png`, `pixor.json`, `probe.png` | Pixors Rohausgabe; die Sonde mit offenem Auge |
| `mascot.pixor` | derselbe Render als Projekt für die Pixor-App |

Die Ausgabe nennt die Actions, was die Bereinigung geändert hat, die Frames je Clip und wie viele Pixel von Hand korrigiert wurden.

`--install` schreibt `assets/raven-sheet.png`, `assets/favicon-32.png` und `src/host/raven-clips.mjs` zusammen und ersetzt damit den ursprünglichen Raben in der Werkbank, aber nur, wenn alle Clips da sind, `credits` in `mascot.json` vollständig ist und `NOTICE.md` die Urheberin oder den Urheber nennt. Das Modell steht unter CC BY.

`MASCOT_BLEND=<Pfad>` probiert eine andere .blend aus, ohne `mascot.json` zu ändern.

## Animationen

Die Clips entstehen in `animate.py` als Abweichungen von der Grundpose des Modells (`EsqueletoAction`). Ein Beispiel ist der Kopf, der um einige Grad nickt, während der Schwanz gegenhält. `export.py` erzeugt beim Export jeden Clip, den es in der .blend noch nicht gibt. Gespeichert wird die .blend dabei nicht.

**Von Hand animieren:** Leg in Blender eine Action am Armature `Crow_rig` mit dem Namen des Clips an (`idle`, `fly`, `peck` …) und setz den **Fake User** (Schild-Symbol). Sie ersetzt dann den Clip aus `animate.py`.

- `frame` in `mascot.json` zählt ab dem ersten Key der Action, bei 24 fps.
- Pixor tastet bis **vor** das Ende eines Clips ab. Der letzte Key wird also kein Frame; bei einem Loop gleicht er dem ersten.
- Damit es nicht steif wirkt: vor jeder Bewegung ausholen, den Schwanz gegen den Körper arbeiten lassen, das Atmen aus Brust und Körper holen. Den Kopf wie bei Vögeln ruckartig in eine neue Lage bringen und dort halten. Langsames Drehen lässt das Pixel-Auge springen.
- Pixor rendert höchstens `render` px (24) und lässt beim Einpassen Rand. `sheet.mjs` schneidet daraus ohne Skalieren `cell` px (16) aus, jeder Pixel bleibt 1:1. Der Build sucht die größte Render-Größe, bei der alle Frames in die Zelle passen; die Ausgabe nennt sie.
- Die sitzenden Clips teilen sich einen Zuschnitt, damit beim Wechsel nichts springt. Clips in `free` (Flug und Winken) bekommen ihren eigenen und nutzen den Platz, den die anderen frei lassen, so wird der Vogel insgesamt größer. Waagrecht werden sie für sich zentriert, senkrecht rücken sie nur so weit hoch, wie sie müssen: Das Winken bleibt auf dem Boden stehen. Wie weit so ein Clip in seiner Zelle versetzt ist, steht als `shift` in der Clip-Tabelle; die Werkbank schiebt ihn um genau so viel zurück.
- Unten steht das tiefste Pixel der gemeinsamen Clips; tiefer als die Füße beim Sitzen reicht etwa der Sprung bei joy. Die Füße stehen darum ein paar Pixel über dem Zellboden. Wie viele, steht als `feet` in der Clip-Tabelle, und die Werkbank setzt den Raben genau auf die Füße.
- `--size N` baut eine Variante mit N px großen Zellen nach `out/size-N/`, etwa `--size 48`. Render-Größe, Augenstempel, Lichtpunkt und Filtergrenzen skaliert der Build mit. Bei 16 px ist das Auge ein einzelner heller Pixel.
- Bei 16 px ist ein Pixel etwa 0,25 m. Kleinere Bewegungen sieht man nicht.
- **Timing wie im Zeichentrick:** Gerendert wird mit 24 fps, die meisten Clips laufen aber **auf Zweien** (`twos` in `mascot.json`, gut 12 fps): Jede zweite Zeichnung steht doppelt so lang. Auf Einsen verschiebt bei 16 px fast jeder Frame nur einzelne Pixel, das wirkt zittrig. Auf Einsen bleiben schnelle Aktionen (`fly`, `peck`) und `blink`, dessen Timing schon aus Haltepunkten besteht (zu 42 ms, zu 125 ms, auf). Easing entsteht in Pixel-Art über die Dauer der Frames: lange Haltepunkte an den Schlüsselposen, kurze Zwischenframes.
- Einmalige Clips enden auf ihrem letzten Key (Schlusspose), Loops davor, weil ihr letzter Key ihr Anfang ist (`loop()` in `animate.py`).
- Atmen (`idle`): Die Ruhepose, und für etwa 0,4 s rückt alles über den Füßen genau 1 px hoch (`bob`), Auge und Schnabel mit. Ausgeatmet etwa 0,6 s, eine Sekunde je Atemzug wie Madelines Idle in Celeste.
- Pixor passt alle gebrauchten Clips **gemeinsam** ein: Weit ausgebreitete Flügel machen die Krähe überall kleiner. Alle Zellen werden gleich verschoben, damit nichts springt (`baseline` hebt die Füße zusätzlich an).
- Gerendert wird schräg von der Seite (`--sides 300`, leicht zur Kamera gedreht), Schnabel nach links. Die Werkbank spiegelt den Raben je nach Flugrichtung selbst.
- Den Umriss zeichnet der Build selbst (`outline` in `mascot.json`, `outlineFrames` in `clean.mjs`), nicht Pixor: Jedes leere Pixel neben dem Vogel (4er-Nachbarschaft) wird `color`. Neben dem Schnabel nimmt er die dunklere Schnabelfarbe aus `by` (Selout), damit der Schnabel nicht in Schwarz verschwindet. 1-px-Lücken zwischen Pixeln in `bridge`-Farben (die Zehen) werden vorher geschlossen, sonst wird der Fuß ein Kamm. Pixors eigener Umriss (`--outer`) ist aus, er schloss sich nicht um Schnabel und Füße.

## In der Pixor-App ausprobieren

Öffne `out/mascot.pixor` in der Pixor-App (`pixor.exe` neben `pxr.exe`). Dort siehst du die Krähe mit allen Clips und kannst Licht, Lichttöne, Kamera und Farben live ändern. Die App zeigt Pixors Rohbild, ohne die Bereinigung aus `clean.mjs` (Augenstempel, Lichtpunkt, Boiling-Filter).

Gefällt dir etwas, speichere das Projekt unter einem eigenen Namen (nicht in `out/`, das überschreibt jeder Build) und übernimm es:

```bash
npm run mascot -- --look C:/Pfad/krähe.pixor
```

Übernommen werden Licht (`--light`), Lichttöne (`--bands`) und Kamerawinkel (`--pitch`). Andere Änderungen, etwa an Farbrampen, trägst du in `mascot.json` ein oder schickst mir das Projekt.

## Pixel-Art-Regeln (clean.mjs)

Pixor rastert jeden Frame für sich. Was genau an einer Schwelle liegt (dünne Beine, kurze Innenlinien, Glanz), springt dann
von Frame zu Frame. `clean.mjs` räumt das vor dem Sheet auf, eingestellt über `clean` in `mascot.json`:

- **Alpha** nur 0 oder 255.
- **Keine verwaisten Pixel:** Ein Pixel ohne deckenden Nachbarn (auch diagonal) fällt weg.
- **Keine Farbinseln (Flicken):** Bis zu `island` Pixel einer Farbe mitten in einer anderen Fläche nehmen die Farbe ihrer Umgebung an. Das Auge bleibt und wächst nicht.
- **Kein Boiling:** Ein Fleck aus bis zu `blob` Pixeln, der nur in einem Frame anders ist als davor und danach, bekommt deren Wert. Clips in `loops` laufen dabei im Kreis.
- **Auge als fester Stempel** (nach dem Boiling-Filter): Pixor zeichnet das Auge je nach Kopfhaltung verschieden groß, und mit der dunklen Linie zum Schnabel verschmilzt es zu einem Balken, der wächst und schrumpft. Darum sitzt an der Mitte des Auges immer derselbe Stempel aus `eyeSize` × `eyeSize` Pixeln mit einem Glanzpunkt oben vorn (bei 16 px ein einzelner heller Pixel), und ringsum wird alles, was dunkler als `dim` ist, zur Kopffarbe (die häufigste der `halo`-Farben dort). Springt das Auge nur für einen Frame um 1 px, bleibt es stehen.
- **Fester Lichtpunkt** (`crown`, optional): `width` Pixel in `color` oben auf dem Scheitel, ab `dx` Spalten rechts der Augenmitte. Bei 16 px ist er aus: Zwei Pixel über dem Auge liest er sich als zweites Auge.
- **Geschlossenes Auge als Strich:** Eine zweite Ausgabe (`probe`, mit `MASCOT_EYES=open` exportiert) zeigt, wo das Auge wäre. Fehlt es im Render, kommt an dieselbe Stelle ein Strich in der Farbe `lid`.
- **Feste Füße** (`plant`): In den sitzenden Clips aus `plant.clips` bewegen sich die Füße nicht, Pixor rastert sie aber jeden Frame anders (Zehen mal 1, mal 3 px, wechselnde Grautöne, beim Atmen 1 px seitlich). Jede Zeile, die in allen Frames nur Fuß (`plant.colors`), Umriss oder leer ist, bekommt in allen Frames ihre häufigste Fassung. Das läuft nach dem Umriss, damit auch dessen Zeile unter den Zehen mitzieht.
- **Fester Schnabel** (`beak`): Beim Atmen hebt sich der Kopf um Bruchteile eines Pixels, Pixor rastert die Schnabelspitze dann jedes Mal anders und daneben blitzt ein dunkles Pixel. In den Clips aus `beak.clips`, in denen sich der Kopf nicht dreht, bekommt jedes Pixel im Rahmen um den Schnabel (1 px Rand vor dem Auge, darüber auch der Scheitel), gemessen vom gestempelten Auge, den Wert aus den meisten Frames. Der Schnabel wandert so als starres Stück mit dem Kopf. Clips mit geschlossenen Augen haben keinen Bezugspunkt und bleiben, wie sie sind.
- **Offener Schnabel als Stempel** (`mouth`): Pixor rastert einen offenen Schnabel bei 16 px als Klumpen, weiter geöffnet verschwindet der Unterschnabel hinter dem Kopf. In `mouth.clips` (caw, joy) gilt ein Frame als offen, wenn er Unterschnabel zeigt. Dann ersetzt `pattern`, gemessen vom Auge (`W`), den gerenderten Schnabel: `Y` Oberschnabel, `m` Rachen, `y` Unterschnabel, `h` Kopf, damit der Schnabel auch bei geneigtem Kopf am Kopf sitzt. Ober- und Unterschnabel haben die Maße des geschlossenen Schnabels (2 px breit, gleiche Lage zum Auge), nur der Unterkiefer sinkt: Ein größerer Stempel schnappte beim Öffnen nach vorn und ließ den Schnabel wachsen.
- **Wippen um ein Pixel** (`bob`): Statt den Körper in Blender zu heben (er liegt oft auf einer Pixelgrenze und springt dann schräg, oder die Beine werden dünn und lösen sich vom Bauch), rückt der Build alles über den Füßen um genau 1 px hoch und verdoppelt die Bein-Zeile. `up` sind die Frames der Quelle, in denen der Körper oben ist; `rest` macht alle Frames aus einem (idle besteht nur aus der Ruhepose).
- **Flacher Flügel beim Winken** (`recolor`): Dreht sich der Flügel durchs Licht, wandert sein Schatten jeden Frame anders über ihn. In `wave` bekommt der Flügel darum nur den hellen Ton; Umriss und dunklerer Körper setzen ihn ab.
- **Haltepunkte:** Gleiche Frames hintereinander werden einer, der länger steht (`sheet.mjs`).

Die Füße aller `idle`-Frames stehen innerhalb der Zelle.

Der Look: **dunkle Silhouette** (fast schwarzes Gefieder, Flügel blaugrau abgesetzt, damit man ihn vor dem Körper sieht), **gelber Schnabel** mit eigenem Material `beak` (export.py trennt ihn von den Füßen: das Objekt `beak` und die Flächen des Körpers an den Schnabel-Bones, sonst wird der Unterschnabel beim Öffnen grau). Ober- und Unterschnabel haben feste Töne statt Licht (`beak` hell, `beaklow` dunkler, Material am Bone `Beak c2`): Die Lichtkante auf dem kleinen Schnabel sprang jeden Frame und ließ ihn blitzen, **Selout innen** (`--inner selout1`), **keine Glanzlinien** (`--convex none`) und **zwei Lichttöne** (`--bands 2`, Licht von vorne oben). Pixor berechnet Linien und Lichtkanten in jedem Frame neu aus der 3D-Form. Bei Sprite-Größe kippen kurze Linien und die Lichtkante auf dem kleinen Schnabel bei jeder Bewegung, dann wandern Striche neben dem Schnabel oder auf dem Flügel. Die Lichtkante auf Kopf und Körper ist groß genug, um ruhig mitzuwandern. Den Schatten direkt am Auge nimmt der Augenrand weg.

Licht entlang aller Kanten (Pillow Shading) haben wir probiert und verworfen. Es sieht aufgeblasen aus statt beleuchtet.

## Korrigieren in Aseprite

Öffne `fixes.aseprite`. Das Raster steht auf `cell` px, also eine Zelle je Kachel. Die Datei legt der erste Build an. Solange sie leer ist, wächst sie mit dem Sheet mit. Sie hat drei Ebenen:

| Ebene | Wofür |
|---|---|
| `render` | das gerenderte Sheet, gesperrt; jeder Build ersetzt es |
| `erase` | jedes Pixel hier (Farbe egal, halb durchsichtig angezeigt) löscht das Pixel im Render |
| `fix` | wird über den Render gemalt |

Speichern genügt, `--watch` baut dann neu.

Du kannst auch direkt eine Kopie von `out/final.png` bereinigen und sie mit `--import` übernehmen. Alles, was sich vom Render unterscheidet, landet dann in `fix` (geänderte oder neue Pixel) und `erase` (entfernte Pixel). Die bisherigen Korrekturen werden dabei ersetzt, denn das bereinigte PNG enthält sie schon. Die Korrekturen sitzen fest im Raster. Verschiebt sich die Krähe in einer Zelle, weil Animation oder Look geändert wurden, prüf die Korrekturen dieser Zelle.

## Welcher Clip wofür

`clips` in `mascot.json` legt die Zeilen fest. `idle` muss zuerst kommen, denn Logo und „Animationen aus“ zeigen die Zelle oben links. Clips in `loops` sollten mit dem Bild enden, mit dem sie beginnen.

| Clip | In der Werkbank (`src/host/workbench.mjs`) |
|---|---|
| `idle` | Sitzen, im Kreis; erster Frame auch Logo, „Animationen aus“ und Umschauen |
| `fly` | Flug im Kreis; erster und letzter Frame beim Hüpfen |
| `peck` | Picken und Füttern, im Kreis; erster Frame auch Landen und Hüpfen |
| `blink`, `caw`, `puff`, `joy`, `sigh` | einmal, die Handlung dauert so lang wie der Clip |
| `doze`, `wave`, `nod` | im Kreis, solange die Handlung dauert |
| `sad` | letzter Frame, solange etwas gescheitert ist |

## Was export.py am Modell ändert

Nur für den Export, die .blend wird nicht gespeichert:

- Exportiert werden nur die Meshes mit Armature-Modifier und ihr Armature, ohne Kamera, Lichter, Boden und Bone-Shapes.
- Diffuse- und Glossy-Shader kennt glTF nicht, sie würden weiß. Sie werden zu Principled mit derselben Farbe.
- `body` und `beak` hängen nicht am Armature. Für das Skinning werden sie ihm untergeordnet.
- Die Flügel (Flächen an den `wing.*`-Bones) bekommen ein eigenes Material `wing`, das Pixor heller einfärbt. Sonst verschwinden sie im Körper.
- Gewinkt wird mit dem nahen Flügel. Von der Seite hebt ihn nur die Drehung um X (`twist` in `wing()`), `flap` schwenkt ihn zur Kamera und ist kaum zu sehen. Oben steht er hochkant (`sweep`), damit er nicht wie ein Paddel wirkt.
- Jedes Auge hängt an einem eigenen Bone (`eye.L`, `eye.R`), denn das Modell hat keine Lider. Zum Blinzeln zieht `animate.py` das Auge in den Kopf zurück. Pixor zeichnet jedes sichtbare Auge in Mindestgröße, ein gestauchtes Auge sähe also aus wie ein offenes.

Den Look stellt `pixor` in `mascot.json` ein: Seite, Licht, Linien, Farbrampen je Material (Gefieder, Flügel, Schnabel und Füße, Rachen) und die Augen. `pxr help render` listet alle Optionen.
