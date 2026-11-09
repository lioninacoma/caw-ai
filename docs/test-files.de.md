[English](test-files.md) · Deutsch

# Testdateien

Jeder Test hat zwei YAML-Dateien:

| Datei | Schreibt | Committen? |
|---|---|---|
| `caw/tests/<id>.yaml` | du: was der Test tut, in normaler Sprache | ja |
| `caw/recordings/<id>.yaml` | caw-ai: wie er abgespielt wird | ja, vorher ansehen |

Du schreibst den Testplan, `record` schreibt die Aufzeichnung. Von Hand trägst du dort nur die [Ergänzungen](#von-hand-ergänzen) ein, die Claude nicht aufnimmt.

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
| `id` | ja | Wie der Dateiname. |
| `app` | ja | App, in der der Test startet. |
| `role` | mit Login | Rolle aus der Config. |
| `targets` | ja | Umgebungen, auf denen der Test laufen darf. |
| `mutates` | ja | `true`, wenn er schreibt. Solche Tests laufen nur auf `writable`-Umgebungen. |
| `also` | nein | Weitere Apps, durch die der Ablauf geht, z. B. `[admin]`. Auch deren lokaler Code wird ausgeliefert. |
| `source` | nein | `watch`: lokalen Code nutzen, wo die Umgebung es erlaubt. |
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
npx caw-ai run create-ticket --target local       # Exit 3: S2 geändert, nennt den fix-Befehl
npx caw-ai fix create-ticket S2 --target local    # nur S2 neu aufnehmen
```

`notes`, Metadaten, `retry` und `caw/caw.md` gehen nicht in den Hash ein. Einen Schritt am Ende ergänzt du per Schreiben und `fix`. Schritte löschen oder umsortieren braucht ein neues `record`.

## Aufzeichnung

Schreiben `record` und `fix`. Ansehen ja, ändern nur für die [Ergänzungen von Hand](#von-hand-ergänzen). Ein Auszug:

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
    actions:
      - click: {role: button, name: New ticket}
        path: /tickets
      - wait-ready: {}
      - fill: {role: textbox, name: Title, inside: {role: dialog, name: New ticket}}
        value: Printer offline {{runTag}}
        path: /tickets
      - type: {role: combobox, name: Customer, inside: {role: dialog, name: New ticket}}
        value: Acme
        path: /tickets
      - type: {role: combobox, name: Priority, inside: {role: dialog, name: New ticket}}
        value: High
        path: /tickets
      - click: {role: button, name: Create ticket, inside: {role: dialog, name: New ticket}}
        path: /tickets
      - wait-ready: {}
      - remember: {name: ticketnr, code: "(document.querySelector('[role=status]').textContent.match(/#(\d+)/)||[])[1]"}
    check: "(()=>{const s=document.querySelector('[role=status]');if(!s||!/^Ticket #\d+ created$/.test(s.textContent.trim()))return false;const n=s.textContent.match(/#(\d+)/)[1];return n==='{{ticketnr}}' && [...document.querySelectorAll('table[aria-label=\"Tickets\"] tbody tr')].some(r=>r.cells[0].textContent.trim()===n && r.cells[1].textContent.trim()==='Printer offline {{runTag}}');})()"
    network:
      - {name: GET /api/customers, status: 200, ms: 54, params: []}
      - {name: POST /api/tickets, status: 201, ms: 269, params: [json.customer, json.description, json.priority, json.title]}
      - {name: GET /api/tickets, status: 200, ms: 274, params: [q]}
    effects:
      runs: 1
      actions:
        - action: 4
          controls:
            - + select "Customer" required,filled
            - + button "Create ticket"
            - '- select "Customer" required,empty'
            - '- button "Create ticket" disabled'
```

| Feld | |
|---|---|
| `actions` | Was zu tun ist, mit Zielen so, wie ein Mensch sie findet: Rolle und Name, Beschriftung, `data-testid`, der Dialog drumherum. Nie generierte Klassennamen. |
| `path` | Die Seite, auf der die Aktion aufgenommen wurde. Fehlt ein Ziel, sagt der Lauf, dass er auf einer anderen Seite ist. |
| `check` | Ein JavaScript-Ausdruck, der `true` liefern muss. Er läuft in der angemeldeten Seite, also vor dem Commit lesen. |
| `remember` | Liest einen Wert, den der Lauf erzeugt, hier die Ticketnummer. Spätere Schritte nutzen ihn als `{{ticketnr}}`. |
| `network` | Requests je Schritt aus einem gesunden Lauf. Damit trennt caw-ai App-Fehler von Umgebungsproblemen. |
| `effects` | Was jede Aktion an der Seite geändert hat, gelernt aus gesunden Läufen (`runs` zählt sie). Eine Abweichung lässt den Schritt scheitern oder erscheint als Warnung. |
| `knownMessages` | Meldungen, die beim Aufnehmen sichtbar waren und keine Fehler sind. |

## Von Hand ergänzen

Diese Angaben nimmt Claude nicht auf; du trägst sie selbst in `caw/recordings/<id>.yaml` ein. `validate` prüft sie. Nimmt Claude den Schritt neu auf, ersetzt das seine Aktionen: `upload` und `download` danach wieder eintragen; `secret` an einem `remember` bleibt erhalten.

| Angabe | Bedeutung |
|---|---|
| `- upload: {role: button, name: Dateien wählen}`<br>`  files: [fixtures/brief.pdf]` | Setzt Dateien in ein Dateifeld. Ist das Ziel das Feld selbst (`role: textbox` mit seiner Beschriftung), bekommt es die Dateien direkt; ist es ein Knopf vor einem versteckten Feld, öffnet sein Klick die Dateiauswahl, und die bekommt sie. Pfade gelten relativ zum Ordner `caw`, nie absolut und nie darüber hinaus; fehlt eine Datei, bricht der Schritt vor dem Klick ab |
| `- download: {role: button, name: Exportieren}`<br>`  file: "^akte-.*\\.zip$"` | Der Klick muss im Zeitlimit des Schritts einen Download starten, sein Dateiname muss zum regulären Ausdruck in `file` passen, und die Datei darf nicht leer sein. Sonst scheitert der Schritt wie eine nicht erfüllte Prüfung, ohne zweiten Klick. Das Tool löscht die Datei gleich danach |
| `- remember: {name: davPassword, code: "...", secret: true}` | Wie `remember`, aber der Wert steht ab dann als `••••` im Terminal, in der Werkbank, in `result.json`, `report.md` und allem, was Claude bekommt, wie das Passwort der Rolle. Der Lauf selbst arbeitet mit dem echten Wert |
| `name: {pattern: "^Prüfen( \\d+)?$"}` | In einem Ziel, auch unter `inside`: ein regulärer Ausdruck statt des genauen Namens, für einen mitlaufenden Zähler oder einen wechselnden Teil. Das Muster sieht den ganzen Namen. Ein fester Name über 80 Zeichen ist auf der Seite leer und trifft nie; `validate` weist ihn ab und schlägt ein Muster für seinen Anfang vor |
| `knownMessages:`<br>`  - {pattern: "^Prüfsumme \\S+ kopiert$"}` | Neben festen Texten: ein Muster für eine Meldung mit wechselndem Inhalt, etwa einer Prüfsumme oder Uhrzeit. Wie feste Texte sieht es die Meldung mit Ziffern als `#`, immer ganz; nur der Bericht kürzt lange Meldungen. Eine neue Aufnahme behält Muster und ergänzt keinen festen Text, den ein Muster schon deckt |

Eine Prüfung kann die Zwischenablage lesen: Der Browser hat `clipboard-read` und `clipboard-write` für den Origin der Umgebung, etwa `check: navigator.clipboard.readText().then((text) => text.startsWith('sha256:'))` (ein Ausdruck, der ein Promise liefert, wird abgewartet).

## Platzhalter

| Platzhalter | Wird ersetzt durch |
|---|---|
| `{{runTag}}` | Einen Wert, eindeutig je Lauf, z. B. `CAW-20261109091543` |
| `{{runTagLower}}` | Dasselbe kleingeschrieben, für URLs |
| `{{today}}`, `{{today+7}}`, `{{todayIso-1}}` | Datumswerte relativ zum Tag des Laufs |
| `{{ticketnr}}` | Einen Wert, den der Lauf per `remember` gelesen hat |

Claude setzt sie beim Aufnehmen ein. Im Testplan brauchst du nur `{{runTag}}`.
