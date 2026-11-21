[English](test-files.md) · Deutsch

# Testdateien

Jeder Test hat zwei YAML-Dateien:

| Datei | Schreibt | Committen? |
|---|---|---|
| `caw/tests/<id>.yaml` | du: was der Test tut, in normaler Sprache | ja |
| `caw/recordings/<id>.yaml` | caw: wie er abgespielt wird | ja, vorher ansehen |
| `caw/drafts/<id>.yaml` | `reproduce`: ein [Entwurf](#entwürfe), Plan und Aufzeichnung in einer Datei | ja, bis er übernommen ist |

Du schreibst den Testplan, `record` schreibt die Aufzeichnung. Von Hand trägst du dort nur die [Ergänzungen](#von-hand-ergänzen) ein, die der Agent nicht aufnimmt. `recording` und `knownMessages` gehören nur in die Aufzeichnung; im Testplan lehnt `validate` sie ab.

## Testplan

```yaml
# caw/tests/create-ticket.yaml
id: create-ticket
role: user            # ein Name aus roles (ohne Anmeldung weglassen)
writes: true          # true, wenn der Test Daten anlegt oder ändert
notes: |
  A support agent takes a call: they log a ticket for a customer and start working on it.

steps:
  - id: S1
    name: Open the ticket list
    do: Open "Tickets" in the navigation.
    expect: The ticket list is visible.
  - id: S2
    name: Create a ticket
    do: Create a new ticket "Printer offline {{runTag}}" for customer "Acme Corp" with priority "High".
    expect: A confirmation shows the number of the new ticket.
  - id: S3
    name: Find the ticket
    do: Search the list for "{{runTag}}".
    expect: Exactly one ticket is listed, with priority "High" and status "Open".
  - id: S4
    name: Start working on it
    do: Open the ticket and change its status to "In progress".
    expect: The ticket shows the status "In progress".
```

Testpläne kannst du in jeder Sprache schreiben, der Agent liest sie so wie ein Tester.

| Feld | Pflicht | |
|---|---|---|
| `id` | nein | Standard ist der Dateiname; steht sie da, muss sie ihm entsprechen. |
| `role` | mit Anmeldung, wenn die Config mehrere Rollen hat | Rolle aus der Config. Standard ist die einzige Rolle. |
| `writes` | ja | `true`, wenn er Daten anlegt oder ändert; solche Tests laufen nur auf Umgebungen mit `writable: true`. `false`, wenn er nur liest. Ein Test, der beim Aufnehmen einen schreibenden Request sendet, wird `true`. |
| `environments` | nein | Umgebungen, auf denen der Test laufen darf. Standard sind alle Umgebungen außer Produktion, für einen schreibenden Test nur die beschreibbaren. `record` setzt es nie. |
| `start` | nein | Pfad, an dem dieser Test beginnt, statt `start` aus der Config. |
| `notes` | nein | Kontext für den ganzen Test. |
| `steps` | ja | Siehe unten. |

Je Schritt:

| Feld | Pflicht | |
|---|---|---|
| `id` | ja | `S1`, `S2`, … Nie umnummerieren; neue Schritte bekommen die nächste freie Nummer. |
| `name` | ja | Kurzer Titel. |
| `do` | ja | Eine Aktion, in normaler Sprache. `""` für einen reinen Prüfschritt. |
| `expect` | ja | Genau ein prüfbares Ergebnis. |
| `note` | nein | Kontext nur für diesen Schritt. |
| `retry` | nein | `{ times: 2, waitMs: 15000, from: S1 }`: neu laden und wiederholen, wenn der Schritt aus bekanntem Grund scheitert, etwa ein kaltes Backend. Nicht für Schritte, die Daten absenden. |
| `design` | nein | Schreibt nur ein Mensch: das Zielbild des Schritts, eine Datei unter `caw/design` relativ zum caw-Ordner (`design/order-form.html`), siehe [Zielbild](#zielbild). |
| `needs` | nein | Schreibt nur ein Mensch: Locatoren, die auf der Seite sein müssen, bevor ein offener Schritt aufgenommen werden kann, etwa `['getByRole("button", { name: "Save" })']`. |
| `look` | nein | Schreibt nur ein Mensch, von Hand oder mit einem Haken an einem Schritt, den der Prüflauf nach einer Aufnahme vorschlägt: `true` lernt das Aussehen des Schritts und vergleicht spätere Läufe damit ([visuelle Regression](#visuelle-regression)). Nur für Schritte, deren Bildschirm feste Daten zeigt. |

Tipps:

- Eine Aktion und ein Ergebnis je Schritt: „Liste öffnen“ / „Die Liste ist sichtbar“.
- Schreib `do` und `expect` so, wie ein Tester es sagen würde. Der Agent macht daraus Ziele und Prüfungen.
- Setz `{{runTag}}` in Namen, die du anlegst. Jeder Lauf bekommt einen eigenen Wert, so findet ein Lauf seinen eigenen Datensatz und nicht den von gestern.

## Was eine Aufzeichnung ungültig macht

Jeder Schritt hat einen Hash über `name`, `do`, `expect` und `note`. Änderst du eins davon, ist nur dieser Schritt veraltet:

```bash
npx caw run create-ticket --env local       # Exit 4: S2 geändert, nennt den record-Befehl
npx caw record create-ticket@S2 --env local # ab S2 bis zum Ende neu aufnehmen, S1 bleibt
```

`notes`, `role`, `writes`, `environments`, `start`, `retry`, `design`, `needs`, `look` und `caw/caw.md` gehen nicht in den Hash ein. Einen Schritt am Ende schreibst du in die Datei und nimmst den Test ab diesem Schritt auf (`record <test>@S7`). Ab dem genannten Schritt darf der Agent auch Schritte löschen, umbenennen oder umstellen; die Schritte davor bleiben unberührt.

## Offene Schritte

Schritte, die du ans Ende schreibst und noch nicht aufnimmst, sind **offen**: der Teil des Tests, der noch entsteht, etwa während du die Funktion entwickelst, die sie beschreiben. Es sind die nicht aufgenommenen Schritte nach dem letzten aufgenommenen.

```bash
npx caw run create-ticket --env local          # S1–S3 laufen, Exit 0, „Offen, noch nicht aufgenommen: S4, S5“
npx caw open create-ticket@S4 --env local      # S1–S3 laufen, am Einstieg in S4 gehört dir das Fenster
npx caw record create-ticket@S4 --env local    # aufnehmen, sobald die Anwendung es kann
npx caw run create-ticket --env local --strict # Exit 4, solange etwas offen ist
```

`run` spielt die aufgenommenen Schritte ab und besteht ohne die offenen; `list` zeigt `offen (S4, S5)`, `report.md` und `result.json` (`pending` und `status: "pending"` unter `steps`) nennen sie, die Werkbank zeigt sie als nicht erreicht. Nur das Ende zählt: ein nicht aufgenommener Schritt vor einem aufgenommenen, ein nach der Aufnahme geänderter Schritt und ein Test ohne jede Aufnahme enden weiter mit Exit 4, damit das Ändern eines Schritttexts nie still seine Prüfung aus CI nimmt.

Hat der erste offene Schritt `needs`, prüft ein Lauf, der gesund endet, sie auf der Seite (je etwa 2 s): Sind alle da, meldet er „S4 ist bereit zum Aufnehmen: caw record create-ticket@S4“, sonst nennt er die fehlenden. `result.json` führt sie unter `needs`.

## Entwürfe

`caw reproduce` schreibt einen nachgestellten Fehler als Entwurf nach `caw/drafts/<id>.yaml`: dieselben Felder wie ein Testplan,
und nach der Aufnahme je Schritt seine `recording` und `knownMessages` in derselben Datei. Entwürfe gehören nicht zu
`run --all`; `list`, `validate`, `caw_list` und `caw_validate` zeigen sie getrennt. `record`, `run` und `open` nehmen einen
Entwurf über seine ID wie einen Test; ein Test gleicher ID in `caw/tests` hat Vorrang.

Sein letzter Schritt ist der, der scheitern muss, solange der Fehler da ist. Hat ein Lauf das gezeigt (alle Schritte davor
bestanden, seine Prüfung wurde ausgewertet und ist gescheitert), trägt der Entwurf den Nachweis:

```yaml
red: { step: S3, run: 2026-11-21T09-12-03-417Z-bug-search-finds-nothing, head: "2314150" }
```

`step` ist der rote Schritt, `run` der Lauf, der ihn gezeigt hat, `head` der damals ausgecheckte Commit (fehlt außerhalb von
git). Nur Entwürfe dürfen `red` tragen; in `caw/tests` lehnt `validate` es ab. Eine neue Aufnahme des Entwurfs lässt es fallen.
`run <id> --promote` übernimmt einen grünen Entwurf ohne `red` nach `caw/tests` und `caw/recordings`
([Befehle](commands.de.md#einen-entwurf-übernehmen)).

## Zielbild

Ein Schritt kann den Bildschirm nennen, auf dem er enden soll: `design: design/order-form.html`. `design` und `needs` schreiben nur Menschen in die Testdatei (oder lassen ihre Claude-Code-Session einen Entwurf mit `caw_design` verknüpfen, wenn sie darum bitten); der Plan des Agenten darf sie nicht enthalten, und wenn caw einen Schritt neu schreibt (beheben, neu aufnehmen), bleiben sie erhalten.

Nachdem die Prüfung des Schritts bestanden hat, rendert caw den `.html`-Entwurf in einem eigenen headless Browser ohne Skripte und Netz, im aufgenommenen Viewport des Schritts, und vergleicht seine Struktur mit der Seite der App: Bedienelemente (Rolle, Beschriftung, Merkmale), Ansichtszeilen (Überschriften, Buttons, Links, Bereiche) und je Bedienelement `font-size`, `font-weight`, `color`, `background-color`, `border-radius` und `padding`. Listenzeilen, freier Text, Zahlen und ob ein Feld gefüllt ist, sind Daten und bleiben außen vor. Fehlt etwas oder weicht ein Stil ab, scheitert der Schritt mit kind `design`; Bedienelemente, die nur die App hat, werden genannt, lassen aber nichts scheitern. Das Abspielen geht weiter, der Schritt wird nicht wiederholt und lernt in diesem Lauf keine Wirkungen. Mit `design.fail: []` in der Config warnt er nur. Ein `.png`-Entwurf wird nach Pixeln beurteilt: caw nimmt den Bildschirm des Schritts im aufgenommenen Viewport auf (in CSS-Pixeln, auch dann unskaliert, wenn die Werkbank die App verkleinert), maskiert, was sich von Lauf zu Lauf ändert (Lauf-Kennung, gemerkte Werte, Datumsangaben in Ziffern, Listenzeilen, Listeneinträge, Karten und `visualIgnore` aus der Config), skaliert einen @2x-Export auf die Breite des Bildschirms und vergleicht, wo beide Pixel haben. Ein Pixel weicht ab, wenn ein Farbkanal um mehr als `visual.tolerance` abweicht; weichen mehr als `visual.designMaxRatio` der Pixel ab, scheitert der Schritt mit kind `design`, und das Differenzbild (`step-S3-diff.png`: rot weicht ab, blau ist maskiert) liegt im Ordner `agent` des Laufs.

`result.json` führt je beurteiltem Schritt `design: { file, verdict, missing, extra, styleDiffs }` (ein `.png` auch `ratio` und `diff`) unter `steps`. Mit `visual.screenshots` bekommt außerdem jeder bestandene Schritt `screenshot` (`step-S3.png` im Ordner `agent`), mit Design-Tokens `lint`, mit `look: true` `visual`: `verdict` (`learning`, `same` oder `changed`), für Pixel `ratio` und `diff`, die geänderten Style-Zeilen als `styles` und in einem Lauf mit Fenster `pixels: "headless-only"` (er hat keine Pixel verglichen); ein Aussehen auf [festen Daten](#feste-daten) auch `fixed` (`served`, `outdated`, `look-pass`, `headless-only` oder `unreached`).

### Token-Lint

Liegen in `caw/design` Design-Tokens (`tokens.json` oder `<name>.tokens.json`, DTCG), prüft jeder Lauf jeden Zustand, den ein bestandener Schritt erreicht: Farben, die kein Token sind (CIE-ΔE über 3 zum nächsten, den der Befund nennt), Innen- und Außenabstände und Lücken außerhalb der Abstandsskala (Dimension-Tokens in einer Gruppe `spacing`, `space` oder `gap`: weder ein Token noch ein Vielfaches ihres größten gemeinsamen Teilers; ohne solche Tokens wird der Abstand nicht geprüft), Text unter WCAG-AA-Kontrast (4,5:1, großer Text 3:1), Text, den seine Box abschneidet, und Bedienelemente ohne zugänglichen Namen. Eine falsche Farbe auf vielen Elementen ist ein Befund. Befunde sind Warnungen; mit `"lint"` in `design.fail` lassen sie den Schritt mit kind `design` scheitern. `result.json` führt sie je Schritt unter `lint`.

### Visuelle Regression

Ein Schritt mit `look: true` in der Testdatei lernt, wie er aussieht, wie die [Wirkungen](#aufzeichnung): seine Style-Zeilen und ein Bild je Plattform. `look` setzen nur Menschen, von Hand oder mit einem Haken im Chat (unten); der Plan des Agenten darf es nicht enthalten, caw behält es, wenn es den Schritt neu schreibt, und es macht einen Schritt nie veraltet. Eine Style-Zeile ist eine Rolle und ein Stil (dieselben Stile wie beim Zielbild) mit der Zahl der Bedienelemente, die ihn haben, `button ×3: font-size 13px, font-weight 400, color #ffffff, …`; Namen bleiben weg, sie tragen Daten. Das Aussehen lernt, wenn der Schritt in einem Lauf außerhalb von CI auf der Umgebung seiner Aufnahme besteht; in CI nur mit `--learn`. Die Style-Zeilen lernt jeder solche Lauf, auch im Fenster: Der erste speichert sie, der zweite bestätigt sie (`runs: 2`); eine Zahl, die dazwischen abweicht, wird `×?` (jede Zahl stimmt). Das Bild lernen nur headless Läufe, je Plattform: Der erste speichert es, ein zweiter, dessen Bild passt, bestätigt es (`images: {<plattform>: 2}`), ein abweichendes Bild beginnt von vorn.

Pixel werden nur in headless Läufen (`--headless`) gelernt und verglichen: Dort steht der Viewport fest, der aufgenommene, sonst 1920 × 1080. Ein Lauf mit Fenster (die Werkbank oder ein Lauf ohne `--headless`) vergleicht nur die Style-Zeilen und lässt das Bild, wie es ist; `result.json` sagt das mit `pixels: "headless-only"`. Auch ein CI-Lauf ohne `--headless` öffnet ein Fenster: Hat er einen Schritt mit `look: true` gespielt, warnt er einmal, dass Pixel nur headless verglichen werden und `--headless` fehlt. Das Aussehen gehört zu seiner Grundlage, dem Aufnahmezeitpunkt des Schritts davor und dem Inhalt der Entwurfsdatei des Schritts: Ein früherer Schritt neu aufgenommen oder ein neuer Entwurf, und es wird neu gelernt. Ist es gelernt, vergleicht jeder Lauf: Eine Rolle und ein Stil, die weniger oder mehr Bedienelemente haben als gelernt oder die es nicht gab (`1 button weniger mit …`), oder mehr als `visual.maxRatio` abweichende Pixel (das Differenzbild ist `step-S3-look-diff.png`) lassen den Schritt mit kind `visual` scheitern, ohne das Abspielen anzuhalten (`design.fail` ohne `"visual"` warnt nur). Ein umbenannter Button behält Rolle und Stil: Nur seine Pixel zeigen es. Stimmt der neue Look, übernimmt **Neuen Look übernehmen** im Chat die Stile aller Schritte, deren Aussehen sich in diesem Lauf geändert hat, auf einmal und vermerkt den Tag; ihre Bilder aller Plattformen werden gelöscht, die nächsten zwei headless Läufe lernen sie neu. Eine Änderung, die nur die Pixel sehen (die Stile sind gleich), lässt headless Läufe scheitern, ein Lauf im Fenster sieht aber nichts und bietet kein Übernehmen an: Der Befund nennt dann die Bilddatei, `caw/recordings/<test>/<step>.<platform>.png`. Stimmt der neue Look, lösche sie, und die nächsten zwei headless Läufe lernen das Bild neu (in CI nur mit `--learn`). `caw audit` nennt die Übernahme (`look-adopted`); `look: true` an einem Schritt mit gelerntem Aussehen zu entfernen, ist eine Abschwächung (`look-off`).

Visuelle Regression ist für Schritte gedacht, deren Bildschirm feste Daten zeigt: ein Zustand, den der Test selbst herstellt, Fixtures, eine Seite ohne Datensätze anderer. Daten, die sich ändern, machen sie unruhig. Ohnehin aus den Pixeln maskiert: Lauf-Kennung, gemerkte Werte, Datumsangaben in Ziffern, Tabellen- und Grid-Zeilen (nicht Kopfzeilen), Optionen und Baumeinträge, Listeneinträge (`li`, `listitem`, nicht in Navigation, Menüs, Tab-Listen und Werkzeugleisten) und Karten (`article`); `visualIgnore` aus der Config deckt den Rest ab. Die Style-Zeilen lassen die Bedienelemente in diesen maskierten Bereichen weg (Zeilen, Listeneinträge, Karten, `visualIgnore`; die Einträge von Navigation, Menüs, Tab-Listen und Werkzeugleisten zählen), eine Liste, deren Zahl an Einträgen sich ändert, behält also ihr Aussehen. Für einen Bildschirm, dessen Daten sich ändern, friert [feste Daten](#feste-daten) sie ein.

Nach `caw record` schlägt der Prüflauf ohne KI Schritte für `look: true` vor. Für jeden bestandenen Schritt sieht er, woher der sichtbare Text kommt: Ein Text, der einen Wert aus einer JSON-Antwort auf einen der Lesezugriffe des Laufs enthält (eine Zeichenkette oder eine Zahl als Text, mindestens drei Zeichen, Groß-/Kleinschreibung und Leerzeichen egal; auch der Inhalt von Textfeldern), heißt: Der Schritt zeigt Daten vom Server; Masken wie oben (Zeilen, Listeneinträge, Karten, Datumsangaben, gemerkte Werte, die Lauf-Kennung) heißen: Daten, die sich ändern. Ein Schritt, der beides nicht trifft und noch kein `look` hat, steht in der Karte „Prüflauf bestanden“ mit einem Kästchen, keines angehakt: Diese Schritte zeigen keine Daten vom Server und keine Listen, sicher ist das nicht. Angehakte Schritte bekommen `look: true` in `caw/tests/<test>.yaml`, wenn du den Testplan übernimmst, als Änderung dieser einen Zeile (Kommentare und Format bleiben); Verwerfen schreibt nichts. Die Werte werden nur im Speicher verglichen und kommen in keine Datei, keinen Bericht, kein `result.json` und kein Log. Ohne Chat-Fenster (CI, `--no-chat`, `--headless`), beim Beheben eines Schritts und beim Neuaufnehmen ab einem Schritt wird nichts gemessen.

#### Feste Daten

Die Daten eines Portals ändern sich laufend, also ändert sich auch ein Aussehen darauf. caw kann die Daten für das Aussehen einfrieren: die JSON-Antworten der Lesezugriffe der App aus einem Lauf, die die App in späteren headless Läufen wieder bekommt, damit das Aussehen auf denselben Daten verglichen wird.

**Einfrieren** ist der Klick einer Person, nie der des Agenten, und nie in CI (dort könnte niemand bestätigen, was gespeichert wird). Nach einem bestandenen Lauf mit Chat-Fenster, dessen Schritte mit `look: true` bestanden haben, bietet die Karte **Daten einfrieren** an. Die nächste Karte sagt, was gespeichert wird: die JSON-Antworten der Lesezugriffe bis zum letzten Aussehens-Schritt, in `caw/recordings/<test>/fixed-data.json`, im Repository neben der Aufzeichnung; dass sie personenbezogene Daten enthalten können; und dass du den Datenschutz prüfst, caw weist nur darauf hin. Du wählst, wie sie gespeichert werden:

- **Anonymisieren**: mit dem Befehl aus `anonymize.command` in der Config, falls es einen gibt (er bekommt die Antworten als JSON auf stdin und schreibt sie als JSON auf stdout zurück; die Daten gehen nur an diesen Befehl, nie an eine KI-Sitzung). Sonst ersetzt caw sie selbst, *im Zweifel ersetzt*: Jeder Text wird ersetzt, derselbe Wert innerhalb eines Einfrierens gleich. Nach Muster E-Mails, IBANs, Telefonnummern (Ziffern ersetzt, Format bleibt) und Datumsangaben (um eine feste Zahl an Tagen verschoben, ihre Reihenfolge bleibt); nach Schlüsselname Namen, Straßen, Orte, Postleitzahlen und Geburtsdaten; jeder andere Text wird neutraler Text gleicher Länge (Groß-/Kleinschreibung, Leerzeichen und Satzzeichen bleiben). IDs (Schlüssel wie `id`, `customerId`, UUIDs), Zahlen, Wahrheitswerte, `null` und alle Schlüssel bleiben, ebenso die Werte aus `anonymize.keep`, etwa Währungscodes oder Zustände, die die App auswertet (`["EUR", "OPEN"]`). Eine Anonymisierung, die die Struktur einer Antwort ändert, wird abgelehnt.
- **Verschleiern**: nicht lesbar gespeichert und erst beim Ausliefern entschlüsselt. Das schützt nur davor, die Daten versehentlich zu lesen (in einem Diff, einer Suche); es ist kein Schutz.
- **Lesbar speichern**: nur nach einer zweiten Karte, auf der du bestätigst, dass du den Datenschutz für diese Daten geprüft hast.

Danach zeigt der Chat die Daten so, wie die App sie bekommt, zur Prüfung; erst **Daten speichern** schreibt die Datei und vermerkt die Aussehens-Schritte in der Aufzeichnung (`fixed: { mode, frozen }`). Ohne Wahl oder mit **Nichts speichern** wird nichts gespeichert. Die Wahl kommt in den Bericht des Laufs (`fixedData` in `result.json`: wie gespeichert und ob du bestätigt hast; nie die Daten), und `caw audit` listet neu eingefrorene Daten mit der Art der Speicherung (`fixed-data-frozen`) und einen Aussehens-Schritt, der nicht mehr auf festen Daten verglichen wird (`fixed-data-removed`). Später erneut einfrieren ersetzt die Datei; das Aussehen lernt auf den neuen Daten neu (der Inhalt der Daten gehört zu seiner Basis). Um keine festen Daten mehr zu nutzen, lösche die Datei und die Zeile `fixed` des Schritts in der Aufzeichnung.

**Der Aussehens-Durchlauf.** Ein headless Lauf eines Tests mit festen Daten läuft zuerst ganz normal: Seine Prüfungen, Wirkungen und Requests sehen immer das echte Backend, und das Aussehen der Schritte auf festen Daten bleibt dort außen vor (`visual: { verdict: "skipped", fixed: "look-pass" }`). Danach geht er zurück zur Startseite und spielt die Schritte noch einmal bis zum letzten Aussehens-Schritt auf festen Daten, die Lesezugriffe der App bekommen die eingefrorenen Antworten, jeder Schreibzugriff wird angehalten. In diesem Durchlauf zählt nur das Aussehen dieser Schritte; seine Prüfungen, Wirkungen, Requests und Fehler beurteilen nichts. Ihr Ergebnis geht in den Lauf ein wie jedes Aussehen (`fixed: "served"`): Lernen, ein geändertes Aussehen, Neuen Look übernehmen. Ein Lauf mit Fenster vergleicht das Aussehen dieser Schritte nicht (`fixed: "headless-only"`); kommt der Durchlauf nicht bis zu einem Schritt, sagt er das als Warnung, und das Aussehen gilt als nicht verglichen (`fixed: "unreached"`).

**Änderungen am Backend zählen weiter.** Während eine eingefrorene Antwort ausgeliefert wird, geht der echte Request trotzdem hinaus, und seine Antwort wird nur nach ihrer Form mit der eingefrorenen verglichen: die Felder, ihre Art (Text, Zahl, wahr/falsch, Objekt, Liste) und der Status. Andere Werte sind der Zweck. Ein Feld weg oder neu, eine andere Art, ein Fehlerstatus oder kein JSON mehr ist eine Warnung *die festen Daten passen nicht mehr zum Backend* mit dem, was abweicht, und die Aussehens-Schritte bekommen `fixed: "outdated"`; bitte neu einfrieren. `null` passt zu jeder Art, eine leere Liste zu jeder Liste, und ein Feld, das nur manche Listeneinträge haben, darf fehlen. Mit `"fixedData"` in `design.fail` lassen veraltete Daten die Aussehens-Schritte stattdessen scheitern (Art `visual`).

**Grenzen.** Eingefroren wird nur JSON, das als Antwort auf einen Request der App kommt (`fetch`, `XMLHttpRequest`, an die Hosts der App), und nur Lesezugriffe (GET, eine GraphQL-Query, was `reads` nennt); Content-Types `application/json` und die `+json`-Typen, also auch GraphQL- und JSON:API-Antworten (ein GraphQL-Request wird über seine Operation zugeordnet, dann über die Reihenfolge). Vom Server gerendertes HTML, Skripte, Bilder, Text, Event-Streams und WebSocket-Nachrichten bleiben live, ebenso Requests, die ein Service Worker selbst beantwortet. Antworten werden über Methode, Pfad, Query und Body zugeordnet, sonst über den Request-Namen in der Reihenfolge, in der sie kamen; ein Request, der öfter kommt als eingefroren, bekommt die letzte Antwort noch einmal, einer ohne eingefrorene Antwort geht ans Backend. Ein Lauf hält höchstens 500 Antworten und 20 MB zum Einfrieren im Speicher, keine in CI, keine in einem Lauf ohne Chat-Fenster.

## Aufzeichnung

Schreiben `record` und „Schritt beheben“ im Chat eines Laufs. Ansehen ja, ändern nur für die [Ergänzungen von Hand](#von-hand-ergänzen). Ein Auszug:

```yaml
# caw/recordings/create-ticket.yaml
# Written by caw, belongs to caw/tests/create-ticket.yaml. Delete by hand if needed, never edit.

test: create-ticket
steps:
  - id: S2
    hash: 23b43d5acb2796dd
    after: S1
    recordedOn: local
    recordedAt: 2026-11-09T09:31:28.406Z
    locale: en-US
    timezone: Europe/Berlin
    actions:
      - {click: "getByRole('button', { name: 'New ticket', exact: true })", path: /tickets}
      - {wait-ready: {}}
      - {fill: "getByRole('dialog', { name: 'New ticket' }).getByRole('textbox', { name: 'Title', exact: true })", value: "Printer offline {{runTag}}", path: /tickets}
      - {fill: "getByRole('combobox', { name: 'Priority', exact: true })", value: high, path: /tickets}
      - {click: "getByRole('button', { name: 'Create ticket', exact: true })", path: /tickets}
      - {wait-ready: {}}
      - {remember: {name: ticketnr, code: "(document.querySelector('[role=status]').textContent.match(/#(\\d+)/)||[])[1]"}}
      - {click: "getByRole('row').filter({ hasText: 'Printer offline {{runTag}}' }).getByRole('link', { name: 'Open', exact: true })", path: /tickets}
    check: "document.querySelector('h1')?.textContent === 'Ticket #{{ticketnr}}'"
    network:
      - {name: POST /api/tickets, status: 201, ms: 269, params: [json.customer, json.priority, json.title]}
      - {name: GET /api/tickets, status: 200, ms: 274, params: [q]}
    effects:
      runs: 1
      actions:
        - action: 5
          controls:
            - + button "Create ticket"
            - '- button "Create ticket" disabled'
```

| Feld | |
|---|---|
| `actions` | Was zu tun ist. `dblclick` ist ein Doppelklick, etwa auf eine Tabellenzeile, die nur so öffnet; einen vorgeführten Doppelklick zeichnet caw als einen auf. Das Ziel von `click`, `dblclick`, `fill`, `type`, `upload` und `download` ist ein Playwright-Locator, geschrieben, wie Playwright ihn ausgibt, ohne `page.`: Rolle und voller Name mit `exact: true`, Beschriftung, Text, `data-testid`, die Zeile oder der Dialog drumherum, `contentFrame()` für ein iframe. caw liest ihn, führt ihn aber nie als Code aus; `validate` weist alles andere ab, ebenso Snapshot-Referenzen (`aria-ref=`), `:nth-child` und bei ExtJS generierte IDs wie `#button-1023`. ExtJS-Komponenten findet auch `locator('extjs=button[text="Speichern"]')` (`Ext.ComponentQuery`); ein Text oder Titel mit Komma kommt nie in eine solche Abfrage, weil ComponentQuery an jedem Komma trennt. |
| `hover`, `dragTo` | `hover` bewegt den Zeiger über sein Ziel, etwa ein Menü, das sich beim Überfahren öffnet. `dragTo` zieht sein Ziel auf den Locator in `to`, etwa eine Karte auf eine Spalte. |
| `dialog` | Die Antwort auf einen nativen Dialog (`alert`, `confirm`, `prompt`, `beforeunload`), den die Aktion öffnet: `{type, accept, value?, message?}`. `value` ist der Text für einen bestätigten `prompt` (Platzhalter erlaubt); `message` ist der Dialogtext bei der Aufnahme, Ziffern als `#`. Das Abspielen antwortet genauso. Einen Dialog, den niemand aufgezeichnet hat, schließt es und nennt ihn als Warnung `dialog-unexpected`; kommt ein aufgezeichneter nicht, gibt es die Warnung `dialog-missing`. Beim Vorführen zeigt der Chat den Dialog mit OK und Abbrechen; der Agent antwortet mit `caw agent dialog accept|dismiss`. |
| `path` | Die Seite, auf der die Aktion aufgenommen wurde. Fehlt ein Ziel, sagt der Lauf, dass er auf einer anderen Seite ist. |
| `locale`, `timezone`, `viewport` | Sprache, Zeitzone und Größe der App-Ansicht beim Aufnehmen; die Wiedergabe nimmt sie, sofern die Config nicht `browser.locale`/`browser.timezone`/`browser.viewport` setzt. Headless öffnet die Wiedergabe in dieser Größe; in der Werkbank bekommt der App-Rahmen genau diese Größe, verkleinert, wenn das Fenster kleiner ist. |
| `check` | Ein JavaScript-Ausdruck, der `true` liefern muss. Er läuft in der angemeldeten Seite, also vor dem Commit lesen. |
| `remember` | Liest einen Wert, den der Lauf erzeugt, hier die Ticketnummer. Sein `code` läuft wie `check` in der angemeldeten Seite, also vor dem Commit lesen. Spätere Schritte nutzen ihn als `{{ticketnr}}`. Jeder nicht leere Wert; einer mit weniger als vier Zeichen (eine Id wie `7`) wird nur in eingetippten Werten, URLs, Zeichenketten von Prüfungen und Zieltexten ersetzt, die genau dieser Wert sind. |
| `network` | Requests je Schritt aus einem gesunden Lauf. Damit trennt caw App-Fehler von Umgebungsproblemen. |
| `effects` | Was jede Aktion an der Seite geändert hat, gelernt aus den ersten fünf gesunden Läufen (`runs` zählt sie), danach eingefroren. Eine Abweichung lässt den Schritt scheitern oder erscheint als Warnung. |
| `visual` | Das gelernte Aussehen des Schritts ([visuelle Regression](#visuelle-regression)): `styles` (Zeilen), `images` (Läufe je Plattform; das PNG ist `caw/recordings/<test>/<schritt>.<plattform>.png`, committe es mit der Aufzeichnung), `basis` und `adopted` (der Tag, an dem jemand es übernommen hat). |
| `fixed` | Das Aussehen wird auf [festen Daten](#feste-daten) verglichen: `mode` (`anonymized`, `obfuscated` oder `plain`) und `frozen` (der Tag, an dem jemand sie eingefroren hat). Die Daten sind `caw/recordings/<test>/fixed-data.json`; committe sie nach der Prüfung mit der Aufzeichnung. |
| `knownMessages` | Meldungen, die beim Aufnehmen sichtbar waren und keine Fehler sind. |

Bei der Wiedergabe muss ein Locator genau ein Element finden, das sichtbar und nicht verdeckt ist. Zwei Treffer duldet sie zwei Sekunden lang, etwa während ein Dialog schließt und der nächste mit demselben Knopf aufgeht; danach scheitert der Schritt und nennt beide. Ein Locator, der nach Position wählt (`nth()`, `first()`), wird nach der Aufnahme zum Prüfen aufgelistet.

## Von Hand ergänzen

`download` und `secret` nimmt der Agent nicht auf; du trägst sie selbst in `caw/recordings/<id>.yaml` ein. `validate` prüft sie. Nimmt der Agent den Schritt neu auf, ersetzt das seine Aktionen: `download` danach wieder eintragen; `secret` an einem `remember` bleibt erhalten.

`upload` wird aufgezeichnet, aber nur mit Dateien aus `caw/fixtures`: Beim Vorführen vergleicht caw die gewählte Datei per Name, Größe und SHA-256 mit den Dateien dort. Passt sie, wird der Klick, der die Dateiauswahl geöffnet hat, zum `upload`; eine Datei von anderswo nennt der Chat, sie wird nicht aufgezeichnet und nichts wird kopiert. Leg Testdateien ohne personenbezogene Daten in `caw/fixtures` ab und wähle sie von dort. Der Agent lädt mit `upload <ziel> fixtures/<datei>` hoch, ebenfalls nur von dort.

| Angabe | Bedeutung |
|---|---|
| `- upload: "getByRole('button', { name: 'Dateien wählen', exact: true })"`<br>`  files: [fixtures/brief.pdf]` | Setzt Dateien in ein Dateifeld. Ist das Ziel das Feld selbst (etwa `getByLabel('Anhang')`), bekommt es die Dateien direkt; ist es ein Knopf vor einem versteckten Feld, öffnet sein Klick die Dateiauswahl, und die bekommt sie. Pfade gelten relativ zum Ordner `caw` und beginnen mit `fixtures/`; nie absolut, nie außerhalb von `caw/fixtures`, nie ein Link heraus; fehlt eine Datei, bricht der Schritt vor dem Klick ab |
| `- download: "getByRole('button', { name: 'Exportieren', exact: true })"`<br>`  file: "^akte-.*\\.zip$"` | Der Klick muss im Zeitlimit des Schritts einen Download starten, sein Dateiname muss zum regulären Ausdruck in `file` passen, und die Datei darf nicht leer sein. Sonst scheitert der Schritt wie eine nicht erfüllte Prüfung, ohne zweiten Klick. Das Tool löscht die Datei gleich danach |
| `- remember: {name: davPassword, code: "...", secret: true}` | Wie `remember`, aber der Wert steht ab dann als `••••` im Terminal, in der Werkbank, in `result.json`, `report.md` und allem, was der Agent bekommt, wie das Passwort der Rolle. Der Lauf selbst arbeitet mit dem echten Wert |
| `getByRole('button', { name: /^Prüfen( \\d+)?$/ })` | Ein regulärer Ausdruck statt des genauen Namens, für einen mitlaufenden Zähler oder einen wechselnden Teil |
| `knownMessages:`<br>`  - {pattern: "^Prüfsumme \\S+ kopiert$"}` | Neben festen Texten: ein Muster für eine Meldung mit wechselndem Inhalt, etwa einer Prüfsumme oder Uhrzeit. Wie feste Texte sieht es die Meldung mit Ziffern als `#`, immer ganz; nur der Bericht kürzt lange Meldungen. Eine neue Aufnahme behält Muster und ergänzt keinen festen Text, den ein Muster schon deckt |

Eine Prüfung kann die Zwischenablage lesen: Solange eine Prüfung, ein `remember` oder das `eval` des Agenten läuft, hat der Browser `clipboard-read` für den Origin der Umgebung, sonst nur `clipboard-write` (so kann die getestete Seite deine Zwischenablage nicht nach Belieben lesen), etwa `check: navigator.clipboard.readText().then((text) => text.startsWith('sha256:'))` (ein Ausdruck, der ein Promise liefert, wird abgewartet).

## Platzhalter

| Platzhalter | Wird ersetzt durch |
|---|---|
| `{{runTag}}` | Einen Wert, eindeutig je Lauf, z. B. `CAW-20261109091543` |
| `{{runTagLower}}` | Dasselbe kleingeschrieben, für URLs |
| `{{date}}`, `{{date+7}}`, `{{isoDate-1}}` | Datumswerte relativ zum Tag des Laufs: `{{date}}` im Format der Browsersprache (`de-DE` 23.11.2026, `en-US` 11/23/2026, `en-GB` 23/11/2026), `{{isoDate}}` als 2026-11-23. Beim Aufnehmen wird ein Datum höchstens 60 Tage vom Aufnahmetag im Format der Sprache oder ISO zu einem davon; ein Datum in der Reihenfolge einer anderen Sprache bleibt, wie es ist |
| `{{ticketnr}}` | Einen Wert, den der Lauf per `remember` gelesen hat |

Der Agent setzt sie beim Aufnehmen ein. Im Testplan brauchst du nur `{{runTag}}`. In einem Locator füllt caw sie je Text ein: Ein Wert mit Anführungszeichen bleibt ein Text, ein Wert in einem regulären Ausdruck wird maskiert.
