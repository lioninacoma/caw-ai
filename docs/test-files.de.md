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

Schritte, die du ans Ende schreibst und noch nicht aufnimmst, sind **offen**: der Teil des Tests, der noch entsteht, etwa während du die Funktion entwickelst, die sie beschreiben. Es sind die nicht aufgenommenen Schritte nach dem letzten aufgenommenen. Hat der erste von ihnen ein [Zielbild](#zielbild), beurteilt ein Lauf, der vor ihm gesund endet, diesen Entwurf an seinem Einstieg und nennt das Urteil (`pendingDesign` in `result.json`: `step`, `file`, `verdict` und die Abweichungen); das lässt nichts scheitern.

```bash
npx caw run create-ticket --env local          # S1–S3 laufen, Exit 0, „Offen, noch nicht aufgenommen: S4, S5“
npx caw open create-ticket@S4 --env local      # S1–S3 laufen, am Einstieg in S4 gehört dir das Fenster
npx caw record create-ticket@S4 --env local    # aufnehmen, sobald die Anwendung es kann
npx caw run create-ticket --env local --strict # Exit 4, solange etwas offen ist
```

`run` spielt die aufgenommenen Schritte ab und besteht ohne die offenen; `list` zeigt `offen (S4, S5)`, `report.md` und `result.json` (`pending` und `status: "pending"` unter `steps`) nennen sie, die Werkbank zeigt sie als nicht erreicht. Nur das Ende zählt: ein nicht aufgenommener Schritt vor einem aufgenommenen, ein nach der Aufnahme geänderter Schritt und ein Test ohne jede Aufnahme enden weiter mit Exit 4, damit das Ändern eines Schritttexts nie still seine Prüfung aus CI nimmt.

Hat der erste offene Schritt `needs`, prüft ein Lauf, der gesund endet, sie auf der Seite (je etwa 2 s): Sind alle da, meldet er „S4 ist bereit zum Aufnehmen: caw record create-ticket@S4 --env local“, sonst nennt er die fehlenden. `result.json` führt sie unter `needs`.

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

Nachdem die Prüfung des Schritts bestanden hat, rendert caw den `.html`-Entwurf in einem eigenen headless Browser ohne Skripte und Netz, im aufgenommenen Viewport des Schritts, und vergleicht ihn mit der Seite der App. Ist der Entwurf erfüllt, sieht der Schritt aus wie der Entwurf, bis auf Daten:

- **Struktur:** Bedienelemente (Rolle, Beschriftung, Merkmale) und Ansichtszeilen (Überschriften, Buttons, Links, Bereiche).
- **Feste Texte:** Überschriften, Beschriftungen, Absätze und andere Texte, die keine Daten sind. Ein anderer Text an derselben Stelle heißt `Text: heading "Note" → "Notes"`, ein fehlender Text steht unter Fehlt.
- **Aussehen:** je Bedienelement `font-size`, `font-weight`, `color`, `background-color`, `border-radius`, `padding` und seine erste `font-family`; je Text seine erste `font-family`, `font-size`, `font-weight`, `font-style` und `color`; je Block (ein Element mit Hintergrund, Rahmen oder Schatten: Karten, Abschnitte, Chips, Trenner) sein `background`, sein Rahmen, `border-radius` und ob er einen `shadow` hat.
- **Layout:** die Elemente in Dokumentreihenfolge (Bedienelemente, Texte, Blöcke, Bilder, Datenbereiche). Für jedes Nachbarpaar muss die Lage aus dem Entwurf gelten (unter, über, rechts von, links von, in) mit demselben Abstand; ein Element unter seinem Nachbarn behält seinen Einzug in seinem Block; Bedienelemente behalten Breite und Höhe (eine Auswahlliste nur die Höhe: ihre Breite folgt ihren Optionen), Blöcke ohne Daten ihre Breite, Bilder beides. Zeilen lauten `Abstand button "Save" → block "Note": 19px → 43px`, `block "Note": unter button "Save" → über button "Save"`, `textarea "Note": height 79px → 72px`. Lagen werden von Nachbar zu Nachbar verglichen, nie absolut: Ein Titel, der auf zwei Zeilen umbricht, schiebt alles darunter, ändert aber keinen Abstand. Innerhalb von 1 CSS-Pixel gilt ein Abstand, Einzug oder Maß als gleich; derselbe Entwurf und derselbe App-Zustand neu gerendert wichen um höchstens 0,01 px ab, der Entwurf und eine App, die ihn genau umsetzt, um 0,01 px.

Fehlt etwas, ändert sich ein Text oder weichen Stil oder Layout ab, scheitert der Schritt mit kind `design`; Bedienelemente, die nur die App hat, werden genannt, lassen aber nichts scheitern (ein Entwurf lässt den Rahmen der App meist weg). Das Abspielen geht weiter, der Schritt wird nicht wiederholt und lernt in diesem Lauf keine Wirkungen. Mit `design.fail: []` in der Config warnt er nur.

#### Was Daten sind

Dieselbe Regel gilt im Entwurf und in der App. Daten behalten ihren Platz im Layout und ihre Schrift, ihr Text wird aber nicht verglichen:

- ein **Bereich**: eine Liste oder Tabelle mit ihren Zeilen und Einträgen (`ul`, `ol`, `table`, `li`, `tr` und die Rollen `list`, `grid`, `table`, `listbox`, `tree`, `row`, `listitem`, `option`, …) und jedes Element mit `data-caw-data` (im Entwurf, in der App oder in beiden). Er zählt als ein Element; nichts darin wird verglichen, auch nicht seine Bedienelemente;
- ein **Wert**: was ein Feld enthält, ein `<output>` und ein Text, der der Wert eines Felds auf derselben Seite ist (eine gespeicherte Notiz über ihrem Feld);
- ein Text mit einer **Ziffer** (Zahlen, IDs, Daten, Zähler, ein Titel mit `{{runTag}}`) oder mit einem Wert, den der Lauf gemerkt hat, oder seinem Run-Tag; eine so benannte Überschrift oder ein so benannter Link fällt auch aus den Ansichtszeilen.

Ein Beispieltext im Entwurf, der in der App Daten ist, aber keine Ziffer hat (ein Name, ein Status): im Entwurf und in der App mit `data-caw-data` markieren.

`result.json` führt je beurteiltem Schritt `design: { file, verdict, missing, extra, styleDiffs, layoutDiffs, textDiffs }` unter `steps`. Mit `visual.screenshots` bekommt außerdem jeder bestandene Schritt `screenshot` (`step-S3.png` im Ordner `agent`, der Bildschirm des Schritts im aufgenommenen Viewport), mit `look: true` `visual`: `verdict` (`learning`, `same` oder `changed`) und die geänderten Style-Zeilen als `styles`.

### Visuelle Regression

Ein Schritt mit `look: true` in der Testdatei lernt, wie er aussieht, wie die [Wirkungen](#aufzeichnung): seine Style-Zeilen. `look` setzen nur Menschen, von Hand oder mit einem Haken im Chat (unten); der Plan des Agenten darf es nicht enthalten, caw behält es, wenn es den Schritt neu schreibt, und es macht einen Schritt nie veraltet. Eine Style-Zeile ist eine Rolle und ein Stil (dieselben Stile wie beim Zielbild) mit der Zahl der Bedienelemente, die ihn haben, `button ×3: font-size 13px, font-weight 400, color #ffffff, …`; Namen bleiben weg, sie tragen Daten. Das Aussehen lernt, wenn der Schritt in einem Lauf außerhalb von CI auf der Umgebung seiner Aufnahme besteht; in CI nur mit `--learn`. Die Style-Zeilen lernt jeder solche Lauf, im Fenster wie headless: Der erste speichert sie, der zweite bestätigt sie (`runs: 2`); eine Zahl, die dazwischen abweicht, wird `×?` (jede Zahl stimmt).

Das Aussehen gehört zu seiner Grundlage, dem Aufnahmezeitpunkt des Schritts davor und dem Inhalt der Entwurfsdatei des Schritts: Ein früherer Schritt neu aufgenommen oder ein neuer Entwurf, und es wird neu gelernt. Ist es gelernt, vergleicht jeder Lauf: Eine Rolle und ein Stil, die weniger oder mehr Bedienelemente haben als gelernt oder die es nicht gab (`1 button weniger mit …`), lassen den Schritt mit kind `visual` scheitern, ohne das Abspielen anzuhalten (`design.fail` ohne `"visual"` warnt nur). Ein umbenannter Button behält Rolle und Stil: Sein Aussehen bleibt gleich. Stimmt der neue Look, übernimmt **Neuen Look übernehmen** im Chat die Stile aller Schritte, deren Aussehen sich in diesem Lauf geändert hat, auf einmal und vermerkt den Tag. `caw audit` nennt die Übernahme (`look-adopted`); `look: true` an einem Schritt mit gelerntem Aussehen zu entfernen, ist eine Abschwächung (`look-off`).

Visuelle Regression ist für Schritte gedacht, deren Bildschirm feste Daten zeigt: ein Zustand, den der Test selbst herstellt, Fixtures, eine Seite ohne Datensätze anderer. Daten, die sich ändern, machen sie unruhig. Die Style-Zeilen lassen die Bedienelemente in Tabellen- und Grid-Zeilen (nicht Kopfzeilen), Optionen und Baumeinträgen, Listeneinträgen (`li`, `listitem`, nicht in Navigation, Menüs, Tab-Listen und Werkzeugleisten), Karten (`article`) und in dem weg, was `visualIgnore` aus der Config findet; eine Liste, deren Zahl an Einträgen sich ändert, behält also ihr Aussehen.

Nach `caw record` schlägt der Prüflauf ohne KI Schritte für `look: true` vor. Für jeden bestandenen Schritt sieht er, woher der sichtbare Text kommt: Ein Text, der einen Wert aus einer JSON-Antwort auf einen der Lesezugriffe des Laufs enthält (eine Zeichenkette oder eine Zahl als Text, mindestens drei Zeichen, Groß-/Kleinschreibung und Leerzeichen egal; auch der Inhalt von Textfeldern), heißt: Der Schritt zeigt Daten vom Server; Zeilen, Listeneinträge, Karten, Datumsangaben in Ziffern, gemerkte Werte oder die Lauf-Kennung auf dem Bildschirm heißen: Daten, die sich ändern. Ein Schritt, der beides nicht trifft und noch kein `look` hat, steht in der Karte „Prüflauf bestanden“ mit einem Kästchen, keines angehakt: Diese Schritte zeigen keine Daten vom Server und keine Listen, sicher ist das nicht. Angehakte Schritte bekommen `look: true` in `caw/tests/<test>.yaml`, wenn du den Testplan übernimmst, als Änderung dieser einen Zeile (Kommentare und Format bleiben); Verwerfen schreibt nichts. Die Werte werden nur im Speicher verglichen und kommen in keine Datei, keinen Bericht, kein `result.json` und kein Log. Ohne Chat-Fenster (CI, `--no-chat`, `--headless`), beim Beheben eines Schritts und beim Neuaufnehmen ab einem Schritt wird nichts gemessen.

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
| `visual` | Das gelernte Aussehen des Schritts ([visuelle Regression](#visuelle-regression)): `runs`, `styles` (Zeilen), `basis` und `adopted` (der Tag, an dem jemand es übernommen hat). |
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
