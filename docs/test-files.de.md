[English](test-files.md) · Deutsch

# Testdateien

Jeder Test hat zwei YAML-Dateien:

| Datei | Schreibt | Committen? |
|---|---|---|
| `caw/tests/<id>.yaml` | du: was der Test tut, in normaler Sprache | ja |
| `caw/recordings/<id>.yaml` | caw-ai: wie er abgespielt wird | ja, vorher ansehen |

Du schreibst den Testplan, `record` schreibt die Aufzeichnung. Von Hand trägst du dort nur die [Ergänzungen](#von-hand-ergänzen) ein, die Claude nicht aufnimmt. `recording` und `knownMessages` gehören nur in die Aufzeichnung; im Testplan lehnt `validate` sie ab.

## Testplan

```yaml
# caw/tests/create-ticket.yaml
id: create-ticket
app: web              # ein Name aus apps in caw.config.json
role: user            # ein Name aus roles (ohne Login weglassen)
targets: [local]      # Umgebungen, auf denen der Test laufen darf
mutates: true         # true, wenn der Test Daten anlegt oder ändert
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

Testpläne kannst du in jeder Sprache schreiben, Claude liest sie so wie ein Tester.

| Feld | Pflicht | |
|---|---|---|
| `id` | nein | Standard ist der Dateiname; steht sie da, muss sie ihm entsprechen. |
| `app` | wenn die Config mehrere Apps hat | App, in der der Test startet. Standard ist die einzige App der Config. |
| `role` | mit Login, wenn die Config mehrere Rollen hat | Rolle aus der Config. Standard ist die einzige Rolle. |
| `targets` | nein | Umgebungen, auf denen der Test laufen darf. Standard sind alle Umgebungen außer Produktion. |
| `mutates` | ja | `true`, wenn er Daten anlegt oder ändert; solche Tests laufen nur auf Umgebungen mit `writable: true`. `false`, wenn er nur liest. |
| `also` | nein | Weitere Apps, durch die der Ablauf geht, z. B. `[admin]`. Mit `--overlay` kommt auch deren lokaler Code mit, wenn sie eine Quelle hat. |
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

Tipps:

- Eine Aktion und ein Ergebnis je Schritt: „Liste öffnen“ / „Die Liste ist sichtbar“.
- Schreib `do` und `expect` so, wie ein Tester es sagen würde. Claude macht daraus Ziele und Prüfungen.
- Setz `{{runTag}}` in Namen, die du anlegst. Jeder Lauf bekommt einen eigenen Wert, so findet ein Lauf seinen eigenen Datensatz und nicht den von gestern.

## Was eine Aufzeichnung ungültig macht

Jeder Schritt hat einen Hash über `name`, `do`, `expect` und `note`. Änderst du eins davon, ist nur dieser Schritt veraltet:

```bash
npx caw-ai run create-ticket --target local       # Exit 4: S2 geändert, nennt den record-Befehl
npx caw-ai record create-ticket@S2 --target local # ab S2 bis zum Ende neu aufnehmen, S1 bleibt
```

`notes`, Metadaten, `retry` und `caw/caw.md` gehen nicht in den Hash ein. Einen Schritt am Ende schreibst du in die Datei und nimmst den Test ab diesem Schritt auf (`record <test>@S7`). Ab dem genannten Schritt darf Claude auch Schritte löschen, umbenennen oder umstellen; die Schritte davor bleiben unberührt.

## Aufzeichnung

Schreiben `record` und „Schritt beheben“ im Chat eines Laufs. Ansehen ja, ändern nur für die [Ergänzungen von Hand](#von-hand-ergänzen). Ein Auszug:

```yaml
# caw/recordings/create-ticket.yaml
# Written by caw-ai, belongs to caw/tests/create-ticket.yaml. Delete by hand if needed, never edit.

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
| `path` | Die Seite, auf der die Aktion aufgenommen wurde. Fehlt ein Ziel, sagt der Lauf, dass er auf einer anderen Seite ist. |
| `locale`, `timezone` | Sprache und Zeitzone des Aufnahme-Browsers; die Wiedergabe nimmt sie, sofern die Config nicht `browser.locale`/`browser.timezone` setzt. |
| `check` | Ein JavaScript-Ausdruck, der `true` liefern muss. Er läuft in der angemeldeten Seite, also vor dem Commit lesen. |
| `remember` | Liest einen Wert, den der Lauf erzeugt, hier die Ticketnummer. Spätere Schritte nutzen ihn als `{{ticketnr}}`. |
| `network` | Requests je Schritt aus einem gesunden Lauf. Damit trennt caw-ai App-Fehler von Umgebungsproblemen. |
| `effects` | Was jede Aktion an der Seite geändert hat, gelernt aus gesunden Läufen (`runs` zählt sie). Eine Abweichung lässt den Schritt scheitern oder erscheint als Warnung. |
| `knownMessages` | Meldungen, die beim Aufnehmen sichtbar waren und keine Fehler sind. |

Bei der Wiedergabe muss ein Locator genau ein Element finden, das sichtbar und nicht verdeckt ist. Zwei Treffer duldet sie zwei Sekunden lang, etwa während ein Dialog schließt und der nächste mit demselben Knopf aufgeht; danach scheitert der Schritt und nennt beide. Ein Locator, der nach Position wählt (`nth()`, `first()`), wird nach der Aufnahme zum Prüfen aufgelistet.

## Von Hand ergänzen

`download` und `secret` nimmt Claude nicht auf; du trägst sie selbst in `caw/recordings/<id>.yaml` ein. `validate` prüft sie. Nimmt Claude den Schritt neu auf, ersetzt das seine Aktionen: `download` danach wieder eintragen; `secret` an einem `remember` bleibt erhalten.

`upload` wird aufgezeichnet, aber nur mit Dateien aus `caw/fixtures`: Beim Vorführen vergleicht caw die gewählte Datei per Name, Größe und SHA-256 mit den Dateien dort. Passt sie, wird der Klick, der die Dateiauswahl geöffnet hat, zum `upload`; eine Datei von anderswo nennt der Chat, sie wird nicht aufgezeichnet und nichts wird kopiert. Leg Testdateien ohne personenbezogene Daten in `caw/fixtures` ab und wähle sie von dort. Claude lädt mit `upload <ziel> fixtures/<datei>` hoch, ebenfalls nur von dort.

| Angabe | Bedeutung |
|---|---|
| `- upload: "getByRole('button', { name: 'Dateien wählen', exact: true })"`<br>`  files: [fixtures/brief.pdf]` | Setzt Dateien in ein Dateifeld. Ist das Ziel das Feld selbst (etwa `getByLabel('Anhang')`), bekommt es die Dateien direkt; ist es ein Knopf vor einem versteckten Feld, öffnet sein Klick die Dateiauswahl, und die bekommt sie. Pfade gelten relativ zum Ordner `caw`, nie absolut und nie darüber hinaus; fehlt eine Datei, bricht der Schritt vor dem Klick ab |
| `- download: "getByRole('button', { name: 'Exportieren', exact: true })"`<br>`  file: "^akte-.*\\.zip$"` | Der Klick muss im Zeitlimit des Schritts einen Download starten, sein Dateiname muss zum regulären Ausdruck in `file` passen, und die Datei darf nicht leer sein. Sonst scheitert der Schritt wie eine nicht erfüllte Prüfung, ohne zweiten Klick. Das Tool löscht die Datei gleich danach |
| `- remember: {name: davPassword, code: "...", secret: true}` | Wie `remember`, aber der Wert steht ab dann als `••••` im Terminal, in der Werkbank, in `result.json`, `report.md` und allem, was Claude bekommt, wie das Passwort der Rolle. Der Lauf selbst arbeitet mit dem echten Wert |
| `getByRole('button', { name: /^Prüfen( \\d+)?$/ })` | Ein regulärer Ausdruck statt des genauen Namens, für einen mitlaufenden Zähler oder einen wechselnden Teil |
| `knownMessages:`<br>`  - {pattern: "^Prüfsumme \\S+ kopiert$"}` | Neben festen Texten: ein Muster für eine Meldung mit wechselndem Inhalt, etwa einer Prüfsumme oder Uhrzeit. Wie feste Texte sieht es die Meldung mit Ziffern als `#`, immer ganz; nur der Bericht kürzt lange Meldungen. Eine neue Aufnahme behält Muster und ergänzt keinen festen Text, den ein Muster schon deckt |

Eine Prüfung kann die Zwischenablage lesen: Der Browser hat `clipboard-read` und `clipboard-write` für den Origin der Umgebung, etwa `check: navigator.clipboard.readText().then((text) => text.startsWith('sha256:'))` (ein Ausdruck, der ein Promise liefert, wird abgewartet).

## Platzhalter

| Platzhalter | Wird ersetzt durch |
|---|---|
| `{{runTag}}` | Einen Wert, eindeutig je Lauf, z. B. `CAW-20261109091543` |
| `{{runTagLower}}` | Dasselbe kleingeschrieben, für URLs |
| `{{today}}`, `{{today+7}}`, `{{todayIso-1}}` | Datumswerte relativ zum Tag des Laufs |
| `{{ticketnr}}` | Einen Wert, den der Lauf per `remember` gelesen hat |

Claude setzt sie beim Aufnehmen ein. Im Testplan brauchst du nur `{{runTag}}`. In einem Locator füllt caw sie je Text ein: Ein Wert mit Anführungszeichen bleibt ein Text, ein Wert in einem regulären Ausdruck wird maskiert.
