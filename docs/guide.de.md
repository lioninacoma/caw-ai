[English](guide.md) · Deutsch

# Handbuch

Wie caw im Einzelnen arbeitet. Zum Nachschlagen: [Befehle](commands.de.md), [Konfiguration](configuration.de.md) und [Testdateien](test-files.de.md).

**Kapitel:**

1. [Wie caw einen Schritt beurteilt](#wie-caw-einen-schritt-beurteilt)
2. [Erwartungen und Zielbilder](#erwartungen-und-zielbilder)
3. [Tests in normaler Sprache: einmal aufnehmen, ohne KI abspielen](#tests-in-normaler-sprache-einmal-aufnehmen-ohne-ki-abspielen)
4. [Einordnen und reparieren](#einordnen-und-reparieren)
5. [In CI](#in-ci)
6. [Einen Fehler nachstellen: `reproduce`](#einen-fehler-nachstellen-reproduce)
7. [Jeden Zustand erreichen und entwickeln](#jeden-zustand-erreichen-und-entwickeln)
8. [Der Rahmen des Agenten](#der-rahmen-des-agenten)
9. [Visuelle Prüfungen](#visuelle-prüfungen)
10. [Produktion überwachen](#produktion-überwachen)
11. [Aus Claude Code steuern](#aus-claude-code-steuern)
12. [Export nach Playwright](#export-nach-playwright)
13. [Weiteres](#weiteres)
14. [Anhang: Werkbank, Konsole und Berichtsseite](#anhang-werkbank-konsole-und-berichtsseite)

## Wie caw einen Schritt beurteilt

Ein Test ist eine Liste von Schritten in normaler Sprache. Jeder Schritt sagt, was zu tun ist und was danach stimmen soll. caw beurteilt jeden Schritt nach denselben Regeln, ohne KI, in jedem Lauf.

### Ein Schritt und sein Hash

Ein Schritt hat eine `id`, einen `name`, was zu tun ist (`do`), ein erwartetes Ergebnis (`expect`) und wahlweise einen Hinweis (`note`). Seine Aufzeichnung hält einen Hash über `name`, `do`, `expect` und `note`. Änderst du eines davon, ist dieser Schritt veraltet: `run` hört mit Exit 4 auf und nennt `caw record <test>@<schritt>`. Alles andere liegt außerhalb des Hashs: `retry`, `design`, `needs`, `look`, die `notes` des Tests, `role`, `writes`, `environments`, `start` und `caw/caw.md`. Sie zu ändern macht nie einen Schritt veraltet ([Testdateien](test-files.de.md#was-eine-aufzeichnung-ungültig-macht)).

### Eine Erwartung, eine Prüfung

Jeder Schritt hat ein erwartetes Ergebnis, und seine Aufzeichnung hat eine Prüfung dafür: einen Ausdruck, der am Ende des Schritts auf der Seite stimmen muss. Gespeichert wird eine Aufzeichnung nur, wenn jeder Schritt eine bestandene Prüfung hat und danach keine Aktion mehr folgt. Auch andere Befunde können einen Schritt scheitern lassen: harte Fehler, gelernte Wirkungen, ein Zielbild, ein Aussehen. Keiner davon macht aus einer gescheiterten Prüfung ein Bestehen.

Die Regel für Prüfungen: **Solange das erwartete Ergebnis eines Schritts gleich bleibt, bleibt auch seine Prüfung gleich.** Das gilt, wenn ein Schritt behoben wird, wenn ein Test ab einem Schritt neu aufgenommen wird und wenn ein ganzer Test neu aufgenommen wird, auch wenn der Schritt an eine andere Stelle gerückt ist. Bringt ein Agent für ein unverändertes erwartetes Ergebnis eine neue Prüfung, wird sein Abschluss abgelehnt. Nur `name`, `do` oder `note` umzuformulieren behält die Prüfung. Um eine Prüfung bewusst zu ändern, änderst du das erwartete Ergebnis: Die Entscheidung zeigt es, und [`caw audit`](#kein-test-wird-unbemerkt-schwächer-audit) listet es.

### Wer was ändern darf

| Wer | Was | Wie |
|---|---|---|
| Du | Den Testplan: Schritte mit `name`, `do`, `expect`, `note` und `retry`, die `notes` des Tests, `role`, `writes` und `environments`. Nur du schreibst `design`, `needs` und `look`. | Von Hand in `caw/tests`, oder indem du einen Plan freigibst, eine Aufzeichnung übernimmst, eine Empfehlung annimmst oder auf „Neue Wirkung übernehmen“, „Neuen Look übernehmen“ oder „… verwenden“ klickst |
| Der Agent | Die Aufzeichnung des freigegebenen Plans: je Schritt seine Aktionen und eine Prüfung. Er schlägt Pläne und Empfehlungen vor; du entscheidest. | Nur über die festen Befehle von caw. Ein Plan mit `design`, `needs` oder `look` wird abgelehnt, ebenso eine neue Prüfung für ein unverändertes erwartetes Ergebnis |
| caw | Was es aus gesunden Läufen lernt: Vergleichswerte der Requests, Wirkungen je Aktion und Aussehen (`look: true`). Dazu der Hash, Laufkennung und Daten als Platzhalter und der Rot-Beleg eines Entwurfs. | Ohne KI, in der Aufzeichnungsdatei. Gelerntes überschreibt nie deinen Plan |

### Wirkungen und Vergleichswerte

Nach jeder Aktion misst caw ihre Wirkung: den Zustand der Bedienelemente, die beantworteten Requests, die Form der JSON-Antworten und Konsolenmeldungen. Es lernt die Wirkungen über die ersten fünf gesunden Läufe, behält nur, was in allen gleich war, und friert sie dann ein: Kein Lauf ändert sie mehr, nur „Neue Wirkung übernehmen“ oder das Löschen von `effects`. Je Schritt hält es außerdem Vergleichswerte der Requests: Name, Dauer und Parameternamen, nie Werte.

Wirkungen und Vergleichswerte lernt caw nur auf der Umgebung, auf der der Test aufgenommen wurde (`recordedOn`), in Läufen außerhalb von CI (in CI nur mit `--learn`), und vergleicht sie auf jeder Umgebung. Ein Aussehen (`look: true`) lernt es genauso: seine Stilzeilen über zwei bestandene Läufe, sein Bild über zwei passende headless Läufe ([Visuelle Regression](#visuelle-regression)). Einzelheiten: [Wirkung je Aktion](#wirkung-je-aktion).

### Die Einschätzung: Anwendung, Umgebung, Test oder unklar

Scheitert ein Schritt, nennt caw die Seite, die wahrscheinlich schuld ist, aus dem, was der Browser gesehen hat: die Requests gegen die Vergleichswerte, harte Fehler, eine verlorene Anmeldung, abweichende Wirkungen. Die Seite ist `app` (die Anwendung), `environment` (ein langsamer oder fehlender Server, eine verlorene Anmeldung), `test` (ein fehlendes Ziel auf einer sonst unauffälligen Seite) oder `unclear`. Das ist eine Heuristik: Sie gibt den Berichten ihren Typ und entscheidet über einen neuen Versuch mit `--retry-env`. Aus einem Scheitern macht sie nie ein Bestehen, und ein gescheiterter Schritt endet mit Exit 1, was sie auch sagt. Einzelheiten: [Einschätzung](#einschätzung-test-anwendung-oder-umgebung).

### Wenn sich die Oberfläche ändert

- **Gewollte Änderung, gleiche Erwartung**, etwa ein umbenannter Knopf: Behebe den Schritt („Schritt beheben“ im Chat oder `caw record <test>@S3`). Die Prüfung bleibt, wie sie ist; der Agent sucht nur den neuen Weg. Für ein umbenanntes Ziel schlägt caw das neue vielleicht schon mit Beleg vor („… verwenden“, [Umbenannte Ziele](#umbenannte-ziele)). Ein geändertes Aussehen übernimmst du mit „Neuen Look übernehmen“, eine geänderte Wirkung mit „Neue Wirkung übernehmen“.
- **Gewollte Änderung des Verhaltens:** Ändere das `expect` des Schritts selbst. Der Schritt ist dann veraltet, der Agent nimmt eine neue Prüfung dafür auf, und `caw audit` listet die Änderung.
- **Die Einschätzung zeigt auf die Anwendung:** Kläre die Ursache, bevor du etwas änderst. Ein angepasster Test würde den Fehler nur verdecken. Deshalb ist „Ursache von Claude Code untersuchen lassen“ dann der Hauptknopf, und „Schritt beheben“ steht an zweiter Stelle, mit diesem Hinweis.

## Erwartungen und Zielbilder

Der Testplan kann vor dem Bildschirm da sein. Du schreibst, was ein Schritt tun soll und was danach stimmen soll; caw sagt dir, was noch fehlt.

### Offene Schritte

Schritte, die du ans Ende eines Tests schreibst, ohne sie schon aufzunehmen, sind offen. `run` spielt die aufgenommenen Schritte ab und besteht. Terminal, `report.md`, `result.json` und `list` (`pending (S4, S5)`) nennen die offenen, und `run --all` zählt den Test als bestanden. `run --strict` endet mit Exit 4, solange etwas offen ist. `open <test>@S4` mit S4 als erstem offenem Schritt übergibt dir das Fenster an seinem Einstieg. Nur das Ende zählt: Ein nicht aufgenommener Schritt vor einem aufgenommenen, ein nach der Aufnahme geänderter Schritt und ein Test ganz ohne Aufzeichnung enden weiter mit Exit 4. Einzelheiten: [Testdateien](test-files.de.md#offene-schritte).

### Gegen ein Zielbild entwickeln

Der Testplan kann die Vorgabe sein, bevor es den Bildschirm gibt. Schreib die nächsten Schritte ans Ende des Tests (sie bleiben [offen](test-files.de.md#offene-schritte)) und gib einem Schritt den Bildschirm, auf dem er enden soll: `design: design/order-form.html`, dazu `needs:` mit den Locatoren, die da sein müssen, bevor er aufgenommen werden kann. Der Entwurf kommt meist aus einem Claude-Design-Artefakt oder einem Figma-Export: Bitte deine Claude-Code-Session, ihn zu holen; sie schreibt ihn mit `caw_design` nach `caw/design` und hängt ihn an den Schritt, wenn du darum bittest. caw selbst holt nie etwas.

Jeder Lauf beurteilt den Entwurf dann ohne KI, nachdem die Prüfung des Schritts bestanden hat: Bedienelemente, Überschriften, Beschriftungen und einige Stile je Bedienelement des gerenderten Entwurfs gegen die Seite der App ([Einzelheiten](test-files.de.md#zielbild)). Ist er nicht erfüllt, scheitert der Schritt mit kind `design`, und der Chat bietet an, ihn von deiner verbundenen Session umsetzen zu lassen oder zu schließen, nie den Schritt zu beheben: Der Test stimmt, der Bildschirm ist noch nicht gebaut. Sind alle `needs` des ersten offenen Schritts auf der Seite, meldet der Lauf, dass er bereit zum Aufnehmen ist: `caw record <test>@S4`.

Ein `.png`-Entwurf wird nach Pixeln gegen den Bildschirm des Schritts beurteilt, Lauf-Kennung, gemerkte Werte, Datumsangaben, Listenzeilen, Listeneinträge, Karten und `visualIgnore` maskiert ([Einzelheiten](test-files.de.md#zielbild)). Um zu sehen, wo der Bildschirm abweicht, öffne den Schritt mit dem Entwurf darüber:

```bash
caw open <test>@S4 --design --env local
```

Das spielt bis einschließlich S4 (bei offenem S4: bis zu seinem Einstieg) und legt den Entwurf halb durchsichtig in der aufgenommenen Größe über die App; **F7** zeigt und verbirgt ihn, auch über ein Neuladen hinweg. Darunter stehen die Abweichungen: fehlende Bedienelemente, abweichende Stile, der Anteil abweichender Pixel und mit Design-Tokens die Lint-Befunde. Ein Befund mit Element gibt es beim Klick an deine verbundene Session weiter, wie `/element`, und du kannst sagen: „Bring das hier in Ordnung.“

Mit Design-Tokens in `caw/design` prüft jeder Lauf außerdem jeden erreichten Zustand: Farben, die kein Token sind, Abstände außerhalb der Skala, Kontrast unter WCAG AA, abgeschnittenen Text und unbenannte Bedienelemente, als Warnungen, außer `design.fail` enthält `"lint"` ([Token-Lint](test-files.de.md#token-lint)).

## Tests in normaler Sprache: einmal aufnehmen, ohne KI abspielen

Ein Test ist ein Plan in normaler Sprache. Du gehst ihn einmal im Browser durch, oder der Agent tut es; caw speichert, was getan wurde, und spielt es ab dann ohne KI ab, lokal und in CI.

### Drei Wege

| Befehl | Was passiert | KI und Chat | Umgebung |
|---|---|---|---|
| `record <test> --env <umgebung>` | Testplan neu aufnehmen oder ablösen | immer | nur Umgebungen mit `agent` |
| `run <test> --env <umgebung>` | Testlauf nach Plan | Chat auf Umgebungen mit `agent` von Anfang an daneben; der Agent erst nach deiner Nachricht, deinem Klick auf „Ursache von Claude Code untersuchen lassen“ oder „Schritt beheben“, oder mit `--explain` | alle |
| `record <test>@S4 --env <umgebung>` | Ab S4 bis zum Ende neu aufnehmen. S1 bis S3 laufen ohne den Agenten, dann folgt der Agent dem alten Plan ab S4; einen Prüflauf vorher gibt es nicht, die Ursache klärst du also mit `run` | immer | nur Umgebungen mit `agent` |

`open --env <umgebung>` öffnet die Anwendung angemeldet, mit Werkbank und Chat, aber ohne Test, siehe [Befehle](commands.de.md#open). `open <test>` spielt vorher einen Test ab, `open <test>@S4` hält am Einstieg in S4 an, siehe [Zustand herstellen und übernehmen](#zustand-herstellen-und-übernehmen).

`<umgebung>` ist ein Name aus `environments`, etwa `local`. Mandanten sind eigene Umgebungen (`extends`).

**Testplan** heißt: eine YAML-Datei je Test unter `caw/tests/<test>.yaml`. Sie enthält die Testschritte; ihre Aufzeichnung steht in `caw/recordings/<test>.yaml`, siehe [Testdateien](test-files.de.md).

```bash
# Neuer Test: vorführen, Plan freigeben, am Ende übernehmen
# (--role entfällt, wenn caw.config.json nur eine Rolle kennt)
caw record bestellung --env local --role kunde

# Testen, ohne KI
caw run bestellung --env local

# Testen, bei Fehlern oder Warnungen empfiehlt der Agent im Chat (kostet Token)
caw run bestellung --env local --explain

# Testen ohne Chat wie in CI, mit oder ohne sichtbares Fenster
caw run bestellung --env local --no-chat
caw run bestellung --env local --headless

# Bis zum Einstieg in S4 (S1 bis S3 ausgeführt, seine Eingaben offen) und dort am lokalen Code weiterarbeiten
caw open bestellung@S4 --env local

# Ab S4 bis zum Ende neu aufnehmen
caw record bestellung@S4 --env local
```

In Claude Code reicht ein Satz: „bring mich dahin, wo der Warenkorb gefüllt ist“. Die Session sucht Test und Schritt und startet `open`. Passt nichts, schlägt sie `record` vor.

### Testplan aufnehmen: `record`

Die Rolle nennst du nur beim ersten Mal; das Tool schreibt `role` und `writes` (`true`, außer mit `--read-only`), nie `environments`. Bei einer Neuaufnahme bleiben sie erhalten. Claude Code bzw. Docker, Token und Image werden vorab geprüft, damit deine Vorführung nicht umsonst ist.

1. **Start.** Chrome und der Chat gehen auf, du bist angemeldet. Bei einem neuen Test fragt der Chat: „Selbst vorführen“ oder „Beschreiben, Claude Code nimmt auf“. Beim Beschreiben schreibst du in den Chat, was der Test tun soll; du kannst dabei zu der Seite gehen, um die es in einem Satz geht, und jede Nachricht behält die Seite, auf der sie entstand; der Chat bestätigt sie mit ihrer Nummer (H1, H2 …), wie die Freigabekarte sie zeigt. Klicks werden nicht aufgenommen, „An Claude Code übergeben“ beendet es, und der Agent findet den Weg selbst. Bei einem bestehenden Test fragt der Chat: selbst vorführen oder der Agent geht dem Testplan nach.
2. **Ablaufplan.** Der Agent legt den Entwurf als Karte im Chat vor: je Testschritt ID, Titel, Aktion und ein erwartetes Ergebnis, dazu Hinweise mit Annahmen und offenen Fragen. Der Plan ist die spätere Testdatei ohne Aufzeichnung, YAML mit `notes` und `steps`. Metadaten oder Aufzeichnungen, die der Agent dort einträgt, wirft das Tool weg. Du gibst frei oder schreibst, was anders sein soll, und der Agent legt eine neue Fassung vor. Bis zur Freigabe weist der Host jede Aktion in der Anwendung als `plan-required` ab, Lesen geht.
3. **Ausführen.** Der Agent geht den Weg in einem frischen Browser. Du kannst pausieren, schreiben, Elemente markieren und klicken. Ändert sich der Weg grundlegend, legt der Agent eine neue Fassung vor. Alle Aktionen seit der letzten Prüfung gehören zum nächsten Schritt des Plans, deshalb muss der Agent in dieser Reihenfolge prüfen (`step-order`).
4. **Bereinigen.** Der Agent geht von sich aus die Aktionen durch und nennt im Chat, was wegfällt, ohne dass du freigeben musst. Screenshots und das erste von zwei `fill` aufs selbe Feld streicht das Tool selbst.
5. **Prüflauf.** Das Tool spielt die Aufzeichnung ohne den Agenten ab, im Chat daneben siehst du den Fortschritt. Scheitert ein Schritt, bietet der Chat an, ihn zu beheben, auch im noch nicht übernommenen Entwurf.
6. **Ablösen.** Der Chat zeigt eine Karte „Prüflauf bestanden“ mit dem, was übernommen würde; Warnungen und über die Position gewählte Aktionen lassen sich aufklappen. Dazu „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“, das ein zweiter Klick bestätigt. Erst dann wird die Testdatei geschrieben. Schritte, deren Bildschirm keine Daten vom Server und keine Listen zeigte, stehen dort mit einem Kästchen, keines angehakt: Hake die an, die wirklich feste Daten zeigen, und das Übernehmen gibt ihnen `look: true` ([visuelle Regression](#visuelle-regression)). Besteht der Prüflauf nicht, bleibt der alte Testplan unberührt, Plan (`plan.yaml`) und Entwurf (`test-draft.yaml`) liegen im Lauf-Ordner. Committet wird nichts automatisch.

**Testdaten:** Läufe mit `writes: true` hinterlassen Daten: je einen Datensatz vom Agenten und vom Prüflauf, je Beheben bis zu zwei weitere. Auch was der Agent gestrichen hat, ist in der Anwendung passiert.

#### Was in der Aufzeichnung steht

- **Was aufgezeichnet wird:** Erfolgreiche `click`, `fill`, `type`, `press`, `goto`, `reload`, `wait-ready`, `remember` und `check`. Fehlversuche, `eval` und `snapshot` fehlen.
- **Vollständigkeit:** Gespeichert wird nur, wenn jeder Schritt ein bestandenes `check` hat und danach keine Aktion mehr folgt. Sonst nennt die Ausgabe, was fehlt, und der Lauf endet mit `fail`.
- **Stabile Ziele:** Statt Referenzen speichert die Datei, wie ein Mensch das Element findet, als Playwright-Locator: Rolle und vollständiger Name, Beschriftung oder Text, eingegrenzt auf den Dialog oder die Zeile darum, z. B. `getByRole('dialog', { name: 'Neue Bestellung' }).getByRole('button', { name: 'Senden', exact: true })`; für ExtJS-Komponenten ohne Rolle auch `locator('extjs=…')` ([ExtJS](extensions/extjs.de.md)). Listeneinträge hängen damit am Text; ändern sich die Daten, scheitert der Schritt.
- **Umwege:** Der Agent nennt beim Einreichen, was nicht zum Weg gehört (`"omit": [12, "14-16"]`). Sind alle Schritte bestanden, ist `omit` Pflicht, auch leer, und die Ablehnung zeigt dem Agenten die ganze Aktionsliste. Prüfungen und `remember` lassen sich nicht streichen. Der Bericht listet alles Gestrichene. Übersieht der Agent einen Umweg, bleibt er drin. Der Prüflauf beweist, dass der Weg läuft, nicht dass er der kürzeste ist: Prüfe die Datei vor dem Commit, denn ihre Ausdrücke laufen später ohne den Agenten in der angemeldeten Seite.
- **Laufkennung:** Jeder Lauf hat eine eigene `runTag`, z. B. `CAW-20261105185233`. Der Agent schreibt sie in Freitexte, an denen sich ein Datensatz wiedererkennen lässt. Die Aufzeichnung speichert `{{runTag}}`, und jedes Abspielen setzt seinen Wert ein. So findet ein Lauf seinen eigenen Datensatz statt den eines früheren. Bildet die Anwendung aus dem Namen eine Adresse in Kleinbuchstaben (`/akten/akte-caw-20261105185233`), steht dort `{{runTagLower}}`.
- **Daten relativ zu heute:** Ein Datum höchstens 60 Tage vor oder nach dem Aufnahmetag (im Format der Browsersprache oder `JJJJ-MM-TT`) speichert die Aufzeichnung als `{{date}}`, `{{date+7}}` bzw. `{{isoDate-1}}`; `{{date}}` schreibt das Datum, wie die Sprache es schreibt (`de-DE` 23.11.2026, `en-US` 11/23/2026). Das Abspielen setzt das Datum seines Tages ein, so scheitert ein Test nicht am nächsten Tag an „Datum liegt in der Vergangenheit“. Daten weiter weg bleiben fest.
- **Werte aus dem Lauf:** Eine Bestellnummer gibt es bei jedem Lauf neu. Der Agent liest sie mit `remember bestellnr "<ausdruck>"`, die Aufzeichnung speichert danach `{{bestellnr}}` samt Ausdruck, und das Abspielen liest den Wert neu aus der Seite. Einen leeren Wert weist der Befehl ab.
- **Projektkontext über Tests hinweg:** `caw/caw.md` ist für die Tests, was CLAUDE.md für Claude Code ist: relevante Infos zum Projekt und Eigenheiten der Anwendungen. Du hältst sie von Hand und checkst sie ein, etwa „die Suche merkt sich die letzte Eingabe“. Der Agent bekommt sie in jedem Lauf, in dem er arbeitet. Die Datei zählt nicht zum Schritt-Hash, eine Änderung entwertet also keine Aufzeichnung. Betrifft eine Notiz den Weg, nimm neu auf. Nur Verhalten, keine personenbezogenen Daten.

**Grenzen:**

- **Der Agent kann beim Suchen schreiben.** Eine Schreibsperre gibt es bewusst nicht: In vielen Anwendungen hängen Abschicken und Folgeschritte voneinander ab, und lesende und schreibende Requests sehen auf HTTP-Ebene oft gleich aus. Stattdessen gilt: Aufnahme nur auf Umgebungen mit `agent` und nur mit Testkonten, die Leitfaden-Regel „nur eigene Datensätze“, die Freigabe des Plans, das Schrittbudget, und der Bericht listet unter „Schreibende Aufrufe“ jeden schreibenden Request an die Hosts der Anwendung, mit Namen und ohne Parameterwerte. Lesend ist ein Request mit GET, HEAD oder OPTIONS, eine GraphQL-Query oder einer, auf den ein Muster aus `reads` passt; An- und Abmelden, Sitzung und Token (Pfade, die auf login, logout, session, token, auth, refresh, csrf u. Ä. enden) zählen nicht; alles andere schreibt. Requests an Anmeldedienste aus `allowHosts` und an fremde Hosts (Analytics, CDNs) machen einen Test nie schreibend.
- **Schrittbudget:** `--max-actions` (sonst `maxActions` aus der Config, sonst 100) zählt `click`, `fill`, `type`, `press`, `goto` und `reload` des Agenten, auch gescheiterte. Was du selbst vorführst, zählt nicht.
- **Der Agent reagiert nicht sofort:** `claude -p` läuft ohne Eingabe, Nachricht und Pause greifen vor der nächsten Aktion. „Abbrechen“ wirkt sofort.

### Testlauf: `run`

Spielt die Aufzeichnung ohne Modell, Docker und Token ab. Auf Umgebungen mit `agent` steht der Chat von Anfang an neben dem Fenster, außer in CI (Variable `CI` gesetzt), mit `--no-chat` oder `--headless`. Die erste Zeile im Terminal nennt den Modus und ob der Lauf Vergleichswerte lernt (jeder Lauf außerhalb von CI, in CI nur mit `--learn`), die letzte, was sich an den Dateien des Tests geändert hat. Der Chat: Er zeigt jede Aktion (`S3 · 4/12 click …`) samt neuer Versuche, die Eingabe ist gesperrt. Besteht der Lauf, meldet der Chat das samt Warnungen und wartet nicht; er schließt mit dem Lauf oder bleibt bei [`open <test>`](#zustand-herstellen-und-übernehmen) neben dem übergebenen Fenster. Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben). Fehlt die Aufzeichnung ganz, endet es mit Exit 4 und nennt `record`. Ist ein Schritt veraltet, endet es mit Exit 4 und nennt `record <test>@<schritt>`, um ab diesem Schritt neu aufzunehmen.

- **Warten:** Es gibt keine festen Pausen. Ein Schritt wartet, bis sein Ziel sichtbar und nicht überdeckt ist. Das deckt Lademasken, Overlays und Dialoge in Dialogen ab, denn nur der oberste Dialog ist klickbar. `check` wiederholt die Prüfung, bis sie stimmt oder das Zeitlimit abläuft.
- **Zeitlimits:** Standard sind 30 Sekunden je Schritt, änderbar mit `--step-timeout` (etwa `--step-timeout 45s`) oder von Hand je Aktion mit `timeoutMs` und je Prüfung mit `recording.timeoutMs` in der Testdatei. Klärt oder behebt der Agent aus dem Lauf heraus, gelten `--agent-timeout <dauer>` (Standard 60m) und `--max-actions <n>` wie bei `record`.
- **Fehler:** Scheitert ein Schritt, nennt der Bericht den Testschritt samt Aktion und verweist auf einen Screenshot. Aufräumschritte wie „Abbrechen“ laufen dann nicht mehr, ein angelegter Datensatz kann offen bleiben.
- **Fehlschläge:** Konsolenfehler, Skriptfehler, fehlgeschlagene Requests und HTTP-Status ab 500 beenden das Abspielen beim nächsten Schritt. Ebenso sichtbare Dialoge, Fehlermeldungen und Meldungen aus `messageSelectors`, die bei der Aufnahme nicht vorkamen, wobei Zahlen im Text nicht zählen. Beim Adapter `web` gilt ein Statushinweis (`role=status`, `aria-live=polite`, etwa ein Erfolgs-Toast) nicht als Fehlschlag: Er kommt je nach Tempo oder nicht, unbekannt steht er einmal als Warnung im Bericht. Ein Dialog mit Eingabefeldern ist Bedienung, keine Meldung. Dazu verlorene Anmeldung, eine nicht geladene Anwendung (bei `extjs`: kein ExtJS auf der Seite), eine stehen gebliebene Lademaske (`aria-busy`, bei `extjs` die Lademaske), eine andere Seite als aufgezeichnet und jedes nicht erfüllte `check`.
- **Beheben:** Scheitert ein Schritt, siehe [Einen Schritt beheben](#einen-schritt-beheben).
- **Ohne Chat:** `--no-chat` spielt im sichtbaren Fenster ab wie in CI, ohne Chat und ohne den Agenten: Bericht, Screenshot, Hinweis auf einen Lauf mit Chat zur Ursache (`record <test>@<schritt>` nur bei gewollter Änderung), Exit-Code. `--headless` ebenso, aber ohne Fenster, in der aufgenommenen Größe (sonst 1920×1080). Beide gehen nicht mit `--explain` (Exit 3). Ob eine Anwendung den Headless-Modus annimmt, zeigt erst der Lauf; sonst bleibt `--no-chat`.
- **Grenzen:** Abgespielt wird nur, was aufgezeichnet wurde. Der Blick des Agenten auf Auffälliges fehlt, und auch hier gelten Schreibschutz und Host-Sperre. Toasts, die zwischen zwei Schritten wieder verschwinden, sieht das Abspielen nicht.

### Ablauf eines Laufs

Ein Lauf mit dem Agenten, also beim Aufnehmen und Beheben, macht Folgendes:

1. **Abweisen, was nicht laufen darf:** Config, Testdatei, Ziel und Schreibschutz werden geprüft. Beim Agenten `local` dazu, ob Claude Code da ist.
2. **Image** (nur `docker`): Einmal bauen, aus dem Image des Projekts plus dem Agenten und dem Container-Teil des Tools. Neu gebaut wird nur nach Änderungen daran.
3. **Öffnen:** Chrome starten, anmelden, Seite öffnen und warten, bis die App geladen ist (mit der [Overlay-Erweiterung](extensions/overlay.de.md) auch den lokalen Code prüfen). Fehler hier ergeben `error`, ohne dass Tokens anfallen.
4. **Den Agenten starten:** Bei `local` startet `claude -p` auf deinem Rechner mit den gesperrten Werkzeugen (siehe [Sandbox-Grenzen](#sandbox-grenzen)), bei `session` wartet der Lauf auf deine Session. Bei `docker` startet der Container (`docker run --rm`): Firewall setzen, danach gibt der Container alle Rechte ab. Ist die Sandbox nicht nachweislich dicht, läuft der Agent nicht.
5. **Testen:** `claude -p` arbeitet den Plan ab, jeder Browserbefehl geht als Datei über den Kanal an den Host. Das Urteil prüft der Host.
6. **Abschließen:** Mit dem Urteil endet der Agent sofort (Prozess bzw. Container). Bericht, Trace und `floats.log` (Klicks und, bei `extjs`, die Reihenfolge der schwebenden Fenster mit Zeiten, ohne Inhalte) liegen unter `.caw/runs/<lauf>/`. Der Trace (`trace.zip`) enthält Seiteninhalte, Requests und Cookies des Testkontos; gib ihn nicht weiter. Bei `signIn.type: basic` zeichnet er keine Snapshots auf, damit das Passwort aus dem Authorization-Header nicht darin landet. Eine erneute Anmeldung im Lauf (Zustand herstellen) unterbricht den Trace: Der Teil davor bleibt als `trace-1.zip`, `trace-2.zip` …, und in keinem steht ein Anmeldeformular oder -Request; Screenshots und `claude.log` unter `agent/`. Das Log entsteht laufend und zeigt Text und Befehle des Agenten mit den Sekunden seit dem Start; dieselben Zeilen laufen im Terminal mit. Eine Schlusszusammenfassung nach dem Urteil fehlt darin. Im Terminal ist die Ausgabe farbig, die Datei bleibt ohne Farbcodes; `NO_COLOR=1` schaltet Farben ab. Chrome verschwindet ebenfalls.

Exit-Codes: `0` pass, `1` fail, `2` error (die Umgebung ist schuld), `3` Eingabe abgelehnt, `4` Aufnahme nötig (`record`).

#### Fehlercodes

Alle Fehlercodes mit Abhilfe: [Befehle › Fehlercodes](commands.de.md#fehlercodes).

## Einordnen und reparieren

Scheitert ein Schritt, ordnet caw den Fehler ohne KI ein; der Agent erklärt ihn auf Wunsch, nimmt einen Schritt neu auf oder schlägt eine Code-Änderung vor.

### Einschätzung: Test, Anwendung oder Umgebung

Scheitert ein Schritt, ordnet das Tool den Fehler ein, ohne den Agenten und ohne Token. Es nutzt nur, was jeder Browser liefert, unabhängig von Framework und Umgebung:

- **Requests** der Anwendung (`xhr`/`fetch`) mit Name, Status, Dauer und Ausgang: beantwortet, HTTP-Fehler, abgebrochen, fehlgeschlagen. Der Name ist Methode und Pfad, bei GraphQL dazu Typ und Name der Operation; Parameterwerte stehen nie darin, außer für die Parameter aus `requestKeys`. Ein Abbruch durch einen Seitenwechsel zählt nicht. Dazu kommen die **Namen der Parameter** ohne Werte, aus der Query, aus Formular-Bodys (`application/x-www-form-urlencoded`) und von der obersten Ebene von JSON-Bodys (als `json.<key>`).
- **Harte Fehler** des Laufs: Skriptfehler, Konsolenfehler, HTTP-Status.
- **Der Vergleich aus der Aufnahme:** `recording.network` hält je Schritt fest, welche Requests bei der Aufnahme beantwortet wurden und wie lange sie dauerten und mit welchen Parameternamen (`params`).

| Befund | Einschätzung |
|---|---|
| Request bricht ohne Seitenwechsel früh ab (unter 1 s oder einem Fünftel der Dauer bei der Aufnahme), HTTP ab 500, Skriptfehler | Anwendung, eindeutig |
| Ein Request, der scheitert, schickt andere Parameternamen als bei der Aufnahme („fehlt jetzt `a`, neu `b`“) | Anwendung, eindeutig |
| HTTP 4xx, Konsolenfehler, ein Request der Aufnahme kommt nicht mehr, andere Parameternamen bei beantwortetem Request | Anwendung, wahrscheinlich |
| Anmeldung verloren | Umgebung, eindeutig |
| Request deutlich langsamer als bei der Aufnahme (über 5 s und dreimal so lang), Netzfehler, später Abbruch | Umgebung, wahrscheinlich |
| Ziel fehlt bei sonst unauffälliger Seite | Test oder Testdaten, wahrscheinlich |

Der stärkste Befund entscheidet, die übrigen stehen darunter. Ohne auffällige Belege bleibt es „unklar“. Die Einschätzung steht im Chat, als Abschnitt „Einschätzung“ in `report.md` samt Tabelle der Requests neben denen der Aufnahme, in `result.json` und im Auftrag an den Agenten (`diagnosis`, `evidence`). Der Agent liest dort zuerst und kann mit `network` die letzten Requests abrufen.

Ohne `recording.network` sagt der Bericht das. Der Vergleich entsteht nie beim Aufnehmen oder Beheben: Unter der Steuerung des Agenten laufen auch Fehlklicks und Umwege, die aus der Aufzeichnung gestrichen werden, ihre Requests gehörten nicht zum Schritt. Er entsteht ohne den Agenten und Token durch den nächsten `run` außerhalb von CI (in CI durch `run --learn`), aus der bereinigten Aufzeichnung: Jeder bestandene Schritt ohne Vergleich bekommt ihn dann aus diesem Lauf, wenn er auf derselben Umgebung aufgenommen wurde. Ebenso die Wirkung je Aktion. Der Chat und das Terminal nennen die Schritte, nur dieses Feld ändert sich in der Datei, der Hash bleibt unberührt. Vorhandene Werte überschreibt ein `run` nie, außer sie stammen aus der Zeit vor den Parameternamen (Einträge ohne `params`). Sonst ändert ein Lauf keine Datei.

#### Wirkung je Aktion

Jede Aktion (Klick, Eingabe, Taste) hat eine Wirkung auf der Seite. Das Tool misst sie nach jeder Aktion, sobald die Seite ruhig ist, und hält sie in `recording.effects` fest. Die Wirkung ist der Unterschied zwischen vorher und nachher, ohne Werte:

| Liste | Inhalt | Beispiel |
|---|---|---|
| `controls` | Zustand der sichtbaren Bedienelemente: gesperrt, Pflicht, nur lesbar, ungültig, angehakt, aufgeklappt, gewählt, leer/gefüllt. Elemente in Listen- und Tabellenzeilen zählen nicht, denn das sind Daten, oft auch fremde. Von einer Liste zählt nur, ob sie Zeilen hat. | `+ input "Lieferadresse*" empty`, `+ list "Bestellungen" rows` |
| `requests` | beantwortete Requests der Aktion mit Status | `GET /api/orders 200` |
| `responses` | Form der JSON-Antworten (Schlüsselpfade als Kurz-Hash) und fachliche Fehlerzeichen wie `success=false` | `GET /… form 3fa2c… success=true` |
| `console` | Meldungen der Konsole | `error: Bestellung laden fehlgeschlagen` |

Zahlen werden zu `#`, damit Bestellnummern und Daten nicht stören.

**Lernen:** Ein bestandener `run` außerhalb von CI (in CI `run --learn`) trägt die Wirkung ein. Die ersten fünf gesunden Läufe gleichen sich ab. Erhalten bleibt nur, was in allen gleich war; die Konsole sammelt alles, was vorkam. Danach gilt die Wirkung als gelernt (`runs: 5`) und ist eingefroren: Kein Lauf ändert sie mehr, nur **„Neue Wirkung übernehmen“** oder das Löschen von `effects`. Fünf Läufe, weil in zweien eine schwankende Zeile zu oft beide Male zufällig da ist und gelernt wird, als wäre sie stabil. Ein neu aufgenommener Schritt lernt neu. Der Text der Seite (ihr ARIA-Baum) wird nicht verglichen: Überschriften, Knopfnamen und Optionen dort kommen meist aus Daten, und die ändern sich zwischen Läufen.

**Vergleich:**
- Fehlt beim Abspielen etwas aus der gelernten Wirkung, ist das eine Abweichung, ebenso eine neue Konsolenmeldung.
- Scheitert ein Schritt, nennt die Einschätzung die erste abweichende Aktion bis zu diesem Schritt (Anwendung, wahrscheinlich) und was stattdessen geschah. Der Agent bekommt sie als `evidence.effect`.
- Ist die Prüfung erfüllt, entscheidet die Art der Abweichung. Weicht eine gelernte Wirkung in einer Liste aus `effects.fail` der Config ab, **scheitert der Schritt** (Einschätzung: Anwendung, wahrscheinlich; auch ein anderer Datenstand als beim Lernen kann das erklären, etwa eine Liste, die damals leer war). Standard ist `["controls", "console"]`: der Zustand der Bedienelemente und neue Konsolenmeldungen. Diese Signale waren in gesunden Läufen völlig stabil. Abweichungen in `requests` und `responses` bleiben Warnungen im Bericht; so fällt Drift auf, bevor eine Prüfung reißt. Mit `"effects": { "fail": [] }` bleiben alle Abweichungen Warnungen.
- **Wiederholungen (`retry`)** verändern die Anwendung, etwa wird ein Eintrag ein zweites Mal geöffnet und damit gesperrt. Deshalb gilt nach dem ersten neuen Versuch im Lauf: Schritte, die nur als Vorlauf erneut laufen (bei `retry.from`), werden weder verglichen noch gelernt; spätere Schritte warnen nur noch, nur der wiederholte Schritt selbst scheitert weiter an seiner Wirkung. Weicht er zweimal gleich ab (gemessen an den Listen aus `effects.fail`), gibt es keinen weiteren Versuch.
- Ein Schritt mit gelernter Abweichung lernt nicht, damit kein Fehler aus dem Vergleich verschwindet: Eine Warnung bleibt in jedem Lauf, bis die Wirkung übernommen ist, auch eine außerhalb von `effects.fail`, etwa ein Request, der nicht mehr kommt. Soll eine geänderte Wirkung gelten, im Chat **„Neue Wirkung übernehmen“** wählen. Der Knopf erscheint, wenn nur die Wirkung abweicht und die Prüfung erfüllt ist. Er löscht `effects` dieses Schritts aus der Datei, ohne den Agenten und ohne Tokens; die nächsten fünf gesunden Läufe lernen sie neu. Ohne Chat geht dasselbe, indem man `effects` aus der Datei löscht.

#### Umbenannte Ziele

Findet ein Klick oder eine Eingabe sein Element nicht mehr, weil die Oberfläche es umbenannt hat (Knopf „Speichern“ heißt jetzt „Sichern“), und steht genau ein ähnliches Element da, probiert caw dieses, ohne den Agenten und ohne Tokens, und beweist es: nur bei Klick, Doppelklick, fill oder type, deren Wirkung gelernt ist und nicht schreibt. caw führt die Aktion auf dem Kandidaten aus, während es jeden schreibenden Request abbricht, und behält ihn nur, wenn die gelernte Wirkung wieder eintritt, nichts schreiben wollte und die unveränderte Prüfung des Schritts besteht. Der Schritt scheitert trotzdem (Art `target`), der Lauf geht weiter, weil die Prüfung hält, und der Schritt trägt in `result.json` einen `proposal` (`step`, `action`, `from`, `to`, `evidence`); `report.md` führt ihn unter „Vorgeschlagene Ziele“. Im Chat ändert **„Sichern“ verwenden** nur das Ziel dieser Aktion in der Aufnahme (Hash, Beschreibung und gelernte Wirkung bleiben) und lässt den Test neu laufen. In CI gibt es nur den Abschnitt im Bericht. `caw audit` führt so eine Änderung auf, sie ist keine Abschwächung.

### Empfehlungen zu Fehlern und Warnungen

Ohne Fix-Parameter kostet nichts Token, solange du nicht schreibst oder klickst: Ein `run` zeigt bei einem gescheiterten Schritt im Chat den Grund, die harten Fehler und die Warnungen. Der Agent empfiehlt von sich aus nur hier, und im Gespräch, wenn du danach fragst:

| Lauf | Wann |
|---|---|
| `run` und „Ursache von Claude Code untersuchen lassen“ | Ein Schritt ist gescheitert, du klickst den Knopf im Chat. Lautet die Einschätzung „Anwendung“, ist er der Hauptknopf, sonst steht er neben „Schritt beheben“. Danach wie mit `--explain`: Karten, bei übernommener Änderung an der Anwendung „Erneut testen“ |
| `run … --explain` | Ohne Klick: Ein Schritt scheitert, ein harter Fehler tritt auf oder es gibt Warnungen, auch in einem bestandenen Lauf. Für Läufe, deren Ergebnis du dir erst später ansiehst. Nur auf Umgebungen mit `agent` und mit Chat (nicht in CI), sonst Exit 3 |
| `record <test>@<S4>` und „Schritt beheben“ | Fehler oder Warnungen beim Neuaufnehmen oder Beheben und im Prüflauf danach |
| `record` | erst, wenn du im Prüflauf „Schritt beheben“ wählst |

Der Agent arbeitet im Browser des gescheiterten Laufs, der Zustand ist also noch da. Er darf nur lesen (`snapshot`, `eval`, `console`, `network`, `screenshot`, `url`), alles andere lehnt der Host mit `advise-only` ab. Den Quellcode liest er wie immer schreibgeschützt und sucht dort nach der Ursache, egal mit welchem Framework. Sein Log steht in `agent/claude-advice.log`.

Jede Empfehlung nennt ihren Beleg (`evidence`), etwa einen Request, einen harten Fehler oder eine Fundstelle im Code; ohne lehnt der Host sie ab. Im Chat erscheint jede als Karte, eine nach der anderen:

- **Test:** Titel, Begründung, Beleg und das Geänderte als Vorher und Nachher, dazu „Übernehmen“ und „Verwerfen“. Möglich sind `name`, `do`, `expect`, `note` und `retry` eines vorhandenen Schritts, die `notes` des Testfalls, ein Eintrag in `caw/caw.md` und ein Muster in `consoleIgnore` oder `foreignCode`. Spricht die Einschätzung eindeutig für einen Fehler der Anwendung, markiert die Karte die Empfehlung als Widerspruch dazu.
- **Anwendung:** Titel, Begründung, Beleg und ein fertiger Prompt für eine Claude-Code-Sitzung bei dir, mit „Prompt kopieren“ und „Weiter“. Bringt der Agent konkrete Änderungen mit (`edits`: Datei, gesuchte Stelle, Ersatz, Grund), prüft der Host sie gegen den echten Code: Pfad relativ zum Projekt, nicht unter `caw/`, `.caw/` oder `.claude/`, nicht in `node_modules/` oder `.git` in beliebiger Tiefe, keine Geheimnis-, Build-, CI- oder Agenten-Anweisungsdatei (`package.json`, Lock-Dateien, Dockerfiles, `.github/`, `.circleci/`, `Jenkinsfile`, `CLAUDE.md`, `AGENTS.md`, `.cursor/` …), die Stelle genau einmal in der Datei. Die Karte zeigt Datei, Zeile und den Unterschied. „Änderung übernehmen“ schreibt sie in die Dateien, Zeilenenden bleiben; hat sich die Stelle inzwischen geändert, schreibt es nichts. Der Agent selbst ändert Anwendungscode nie.

Was Übernehmen bewirkt:

- **Nur `retry`:** wirkt sofort, ohne neue Aufnahme, denn `retry` zählt nicht zum Hash.
- **Geänderter Text** in `name`, `do`, `expect` oder `note`: Der Schritt ist danach veraltet, und der Chat bietet „Schritt beheben“ an.
- **`caw.md` und Config:** werden sofort geschrieben, die Config gilt ab dem nächsten Lauf.
- **Testdatei:** Im `run` steht die Änderung sofort in der Datei. Bei `record` und „Schritt beheben“ kommt sie in den Entwurf und gilt erst mit „Testplan übernehmen“.
- **Änderung am Code:** steht sofort in der Datei. Prüfe sie mit dem Lint des Projekts und einem neuen `run`.

Der Abschnitt „Empfehlungen“ in `report.md` nennt jede Empfehlung mit Beleg und deiner Entscheidung, bei einer Anwendungsempfehlung samt Prompt und Änderungen als Diff. Committet wird nie.

### Einen Schritt beheben

Scheitert ein Schritt in `run` oder im Prüflauf von `record`, hält das Abspielen an, und der Browser bleibt im Zustand des Fehlers. Der Chat nennt „S4 ist gescheitert: <Grund>“ samt harten Fehlern und Warnungen und schaltet die Eingabe frei (Zustand „Fehler klären“), dazu „Schritt beheben“ und „Lauf beenden“. Darunter steht die [Einschätzung](#einschätzung-test-anwendung-oder-umgebung) des Tools mit ihren Befunden. Spricht sie für einen Fehler der Anwendung, ist „Schritt beheben“ nur noch der zweite Knopf, mit dem Hinweis, dass ein angepasster Test den Fehler nur verdecken würde. Das gibt es nur auf Umgebungen mit `agent`; in CI, mit `--no-chat`/`--headless` und auf den anderen Umgebungen bleibt es beim Exit-Code und beim Bericht.

- **Fragen:** Erst deine Nachricht startet den Agenten, im selben Browser und nur lesend wie bei den [Empfehlungen](#empfehlungen-zu-fehlern-und-warnungen). Er antwortet im Chat, nennt Ursache, Datei und Zeile und kann Empfehlungskarten geben. Jede weitere Nachricht geht ins selbe Gespräch, bis du einen Knopf drückst. Das Log steht in `agent/claude-talk.log`. Ohne Nachricht und ohne Klick fallen keine Token an.
- **Im selben Browser beheben:** Ist vom gescheiterten Schritt noch nichts ausgeführt, scheiterte also seine erste Aktion ohne harten Fehler von außen, behebt der Agent ihn direkt dort, ohne Vorlauf. Der Bericht des Testlaufs bleibt als `report-test-run.md` erhalten. Sonst, etwa nach einer halben Aktionsfolge oder einer nicht erfüllten Prüfung, geht es wie unten mit Vorlauf in einem frischen Browser. Der Chat sagt vorher, welcher Weg es wird.

`record <test>@S4 --env <umgebung>` nimmt ab S4 bis zum Ende neu auf, etwa nach einer gewollten Änderung der Anwendung oder für einen von Hand geänderten oder neu eingetragenen Schritt. Die Schritte vor S4 müssen aktuell sein; ab S4 dürfen Schritte veraltet oder noch gar nicht aufgenommen sein. Einen Prüflauf vorher und eine Vorführung gibt es nicht: S1 bis S3 laufen ohne den Agenten, dann folgt der Agent dem alten Plan ab S4, du lenkst im Chat, und der Agent sucht keine Ursache. Ab S4 darf der Agent Schritte ergänzen, entfernen, umbenennen oder umstellen; die Schritte davor bleiben, wie sie sind. Legt der Agent den Plan ab S4 unverändert vor, gilt er ohne Freigabe: Der Chat sagt das, und du kannst trotzdem schreiben, wenn sich etwas ändern soll. Die Karte zum Freigeben erscheint nur, wenn sich etwas ändert, beim Beheben eines Fehlers ebenso. `@S1` ist dasselbe wie `record <test>`. Nimmst du einen ganzen Test neu auf, behält ein Schritt mit gleichem Erwartungssatz ebenso seine Prüfung, auch wenn er an eine andere Stelle gerückt ist; ein geänderter Erwartungssatz steht bei der Entscheidung. `--role` und `--read-only` gehen nicht zusammen mit einem Schritt (Exit 3): Der Test behält seine Metadaten. Genau einen Schritt behebst du nur mit „Schritt beheben“ im Chat eines Laufs.

Im Chat erscheint als Nachricht nur, was der Agent dir mit `say` sagt. Seine übrigen Notizen stehen eingeklappt bei den Aktionen. Brichst du ab, steht im Bericht „Von dir abgebrochen.“

1. **Vorbereiten:** In einem frischen Browser laufen S1 bis S3 ohne den Agenten, der Chat zeigt den Fortschritt. Scheitert schon davor ein Schritt, wird dieser angeboten. Beim Beheben im selben Browser entfällt das.
2. **Ursache, dann Plan:** Der Agent bekommt nur diesen Schritt (bei `record <test>@S4` alle Schritte ab S4, ohne Ursachensuche): Text, bisherige Aktionen, Prüfung, Grund, Einschätzung samt Requests, dazu `caw.md` und die bisher gelesenen `remember`-Werte. Zuerst klärt er die Ursache, auch im Quellcode, und sagt sie im Chat. Liegt es an der Anwendung, ändert er den Test nicht, sondern gibt eine Empfehlung mit konkreter Änderung am Code und meldet `fail`. Sonst legt er nur diesen Schritt als Karte vor. Ein geändertes Ergebnis ist dort markiert, erscheint bei der Entscheidung und steht im Bericht.
3. **Ausführen:** Der Agent führt den Schritt aus und bereinigt ihn. Bleibt das Ergebnis gleich, muss auch die Prüfung gleich bleiben, sonst lehnt `finish` ab. Fällt ein `remember`-Wert weg, den ein späterer Schritt braucht, ebenso.
4. **Prüflauf:** Der ganze Test läuft ohne den Agenten in einem frischen Browser, bis vor einen womöglich noch veralteten Schritt. Scheitert ein anderer Schritt, kommt wieder das Angebot. Besteht er: „Testplan übernehmen (N Schritte)“ oder „Entwurf verwerfen“.

Nur die behobenen Schritte ändern sich in der Datei, Kommentare und alle anderen Schritte bleiben Zeichen für Zeichen gleich. Bei `record <test>@S4` bleiben die Schritte vor S4 gleich, Schritte, die nicht mehr im Plan stehen, fallen weg, und die Schritte ab S4 verlieren ihre Vergleichswerte der Requests und ihre Wirkungen; der nächste `run` außerhalb von CI lernt sie neu. Neue Meldungen, die der Agent dabei sieht, zählen danach als bekannt; die Entscheidung nennt sie, damit kein Fehler der Anwendung unbemerkt durchrutscht.

- **Testdaten:** Ein Beheben kostet bis zu zwei Durchläufe, schreibende Schritte davor legen entsprechend Daten an. Token fallen nur für diesen Schritt an, bei `record <test>@S4` für alle Schritte ab S4. Scheitert ein Schritt nach dem Absenden, bleibt der Datensatz offen, das Abspielen räumt nicht auf.
- **Ohne den Agenten:** Fehlt Claude Code (`local`) bzw. Docker oder Token (`docker`), nennt der Chat den Grund, der Lauf bleibt `fail`.
- **Entwurf verwerfen:** Der Testplan bleibt unverändert, nach einer Rückfrage („Wirklich verwerfen?“). Ein zuvor gescheiterter `run` endet mit `fail`.
- **Einfügen, Löschen, Umsortieren:** Mit `record <test>@S4` darf der Agent den Plan ab S4 ändern, denn spätere Schritte können auf früheren aufbauen. Einen Schritt, den du von Hand einträgst, nimmst du ebenso auf: `record <test>@<seine id>`.

## In CI

In CI braucht caw keine KI und keine Token. Mit gesetztem `CI` spielt `run` ohne Chat und ohne Agent ab, `open` lehnt ab (Exit 3), und ein Lauf lernt Vergleichswerte und Wirkungen nur mit `--learn`. Die Berichte tragen die Einschätzung von caw, neue Versuche wiederholen nur, was die Umgebung kaputt gemacht hat, `bisect` findet den Commit, der einen Test gebrochen hat, und `audit` zeigt im PR, ob ein Test schwächer geworden ist. Alle Schalter: [Befehle › Mehrere Tests (CI)](commands.de.md#mehrere-tests-ci).

```yaml
- run: npx caw run --all --env preview --headless --retry-env 1 --report junit=out/caw.xml --report summary=out/summary.md
  env:
    CAW_URL__PREVIEW: ${{ steps.deploy.outputs.url }}
- run: cat out/summary.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

### Berichte

`--report` lässt sich mehrfach angeben: `junit=<datei>` für dein CI, `summary=<datei>` eine Markdown-Zeile je Test für die Job-Zusammenfassung (`$GITHUB_STEP_SUMMARY`), `json=<datei>` dasselbe für Skripte. Die Pfade müssen im Projektordner bleiben; jeder Lauf ersetzt die Dateien.

**JUnit:** ein `<testcase>` je Test. Ein gescheiterter Schritt ist `<failure type="app|environment|test|unclear" message="S3: <grund>">`, mit Einschätzung, Befunden und Berichtspfad als Text. Alles andere, was nicht bestanden hat, ist `<error type="<code>">` mit dem Fehlercode, etwa `env-unreachable`, `auth-missing` oder `replay-stale`. Ein offener Schritt steht als Hinweis in `<system-out>`. Ein Monitor leitet Alarme nach `type` weiter.

**JSON:** `target`, `startedAt`, `exit` und je Test `id`, `status` (`pass`, `fail`, `error`, `rejected`, `needs-recording`), `exit`, `failedStep`, `reason`, `side` (`app`, `environment`, `test`, `unclear`), `strength`, `findings`, `code`, `steps`, `report` und `attempts`, jeweils soweit zutreffend. Zum Beispiel:

```bash
jq -r '.tests[] | select(.status != "pass") | "\(.id) \(.status) \(.side // .code) \(.failedStep // "")"' out/caw.json
```

Die Einschätzung ist eine Heuristik aus dem, was der Browser belegt. Sie gibt den Berichten ihren Typ und entscheidet über eine Wiederholung; aus einem Fehlschlag macht sie nie ein Bestanden.

### Wiederholungen

`--retry-env <n>` (1 bis 5) startet einen Test sofort noch einmal, wenn er mit Exit `2` endete, oder mit Exit `1` und der Einschätzung `environment`. Höchstens `n` weitere Versuche. Was die Einschätzung der Anwendung, dem Test oder nichts Klarem zuschreibt, wird nie wiederholt, ebenso wenig Exit `3` oder `4`. Es zählt der letzte Versuch. Jeder Versuch bleibt mit seinem eigenen Berichtspfad in den Berichten: JUnit listet sie in `<system-out>`, das JSON unter `attempts`, und Tabelle, JUnit und Zusammenfassung sagen etwa „bestanden im 2. Versuch (Umgebung)“.

### PR-Vorschauen

`CAW_URL__<ENV>` lenkt eine Umgebung für einen Prozess auf eine andere Adresse, etwa eine PR-Vorschau (`CAW_URL__PREVIEW`). Die erste Zeile des Laufs nennt sie; in die Config wird sie nie geschrieben. Für Produktion, für Umgebungen mit `agent` und für einen Produktions-Host lehnt caw sie ab (`url-override`, Exit 3). Einzelheiten: [Konfiguration](configuration.de.md#url-für-pr-vorschauen).

### Den Commit finden, der einen Test gebrochen hat: `bisect`

`caw bisect <test> --env <umgebung>` ist ein Schritt von `git bisect run`. Auf jedem Commit startet es die Umgebung mit ihrem `start`-Befehl, spielt den Test headless ohne Chat und ohne Lernen ab und gibt eine Zeile aus. Exit `0` ist gut, `1` schlecht (ein Schritt ist an der Anwendung gescheitert), `125` überspringen (Umgebung, Test, unklar, jeder andere Fehler), `128` hält das Bisect an. Test, Aufzeichnung und `caw.config.json` kommen von einer festen Ref (`--tests-from`, Standard `refs/bisect/bad`), weil bisect auch `caw/` auscheckt. Starte caw aus einer festen Installation:

```bash
git bisect start <bad> <good>
git bisect run npx -p caw-ai@<version> caw bisect <test> --env <umgebung>
git bisect reset
```

Einzelheiten: [Befehle › bisect](commands.de.md#bisect).

### Kein Test wird unbemerkt schwächer: `audit`

Eine Prüfung gehört zu ihrem erwarteten Ergebnis: Solange das erwartete Ergebnis bleibt, hält caw die Prüfung fest, auch wenn ein Schritt repariert oder neu aufgenommen wird. Menschen können einen Test trotzdem abschwächen, mit einem Button im Chat, einem übernommenen Rat oder von Hand. `caw audit <ref>` listet jede solche Änderung, seit der Branch von `<ref>` abging, als Markdown in der Teamsprache; eine Prüfung änderst du bewusst, indem du das erwartete Ergebnis des Schritts änderst, und wer den PR prüft, sieht beides.

#### In einem PR

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx caw validate
- run: npx caw audit origin/${{ github.base_ref }} > audit.md
- run: gh pr comment ${{ github.event.pull_request.number }} --body-file audit.md
  if: always()
  env:
    GH_TOKEN: ${{ github.token }}
```

Der Schritt schlägt fehl (Exit 1), wenn ein Test schwächer wurde; der Kommentar sagt, welcher und wie, etwa „Die Prüfung von S2 hat sich geändert, obwohl das erwartete Ergebnis „Eine Bestellung steht in der Liste.“ gleich blieb.“ mit der Prüfung vorher und jetzt. Was zählt: [Befehle](commands.de.md#audit).

## Einen Fehler nachstellen: `reproduce`

Der Agent geht ein Fehlerticket selbstständig durch und berichtet, ob es sich nachstellen lässt.

`caw reproduce "<fehlerbericht>"` gibt dem Agenten einen Fehlerbericht und einen angemeldeten Browser, sonst nichts zu tun: kein Plan
zum Freigeben, keine Rückfragen, keine Entscheidungen (siehe [Befehle](commands.de.md#reproduce)). Mit `--from <test>@S3` führen
zuerst die Schritte eines Tests in den Zustand, in dem der Fehler auftritt. Der Agent liest den Bericht, geht ihn nach, urteilt nach
Belegen (Screenshot, Konsole, Netzwerk) und endet mit `yes`, `no` oder `unclear`, den Schritten in Klartext und, wenn er den
Quelltext gelesen hat, einem Hinweis auf die Ursache mit Datei und Zeile.

Was der Agent dabei darf und was nicht:

- Nur auf Umgebungen mit `agent`, nie auf Produktion; der Browser erreicht nur die Hosts des Projekts.
- Schreiben nur, wo die Umgebung `writable` ist; sonst wird jeder schreibende Request abgebrochen und im Bericht genannt.
- Kein Plan, kein `check`, keine Frage an dich, keine Empfehlung und keine Code-Änderung: Diese Befehle werden abgelehnt.
- Nichts landet in `caw/tests`: Der Bericht bleibt im Laufordner. Nur ein nachgestellter Fehler (`yes`) hinterlässt einen
  Entwurf in `caw/drafts/<id>.yaml`, Plan und später seine Aufzeichnung in einer Datei. Seine Erwartungen beschreiben das
  richtige Verhalten. Sein letzter Schritt ist der rote: Einmal aufgenommen, wird seine Prüfung ausgewertet und hält nicht,
  solange der Fehler da ist, und hält, sobald er behoben ist. Nur das zählt als rot; ein Scheitern an anderer Stelle (ein
  früherer Schritt, eine Prüfung, die geworfen hat) belegt nichts über den Fehler. Seine `notes` listen, was der Agent im Browser
  getan hat, mit Locatoren, als Orientierung für die Aufnahme. Entwürfe gehören nicht zu
  `run --all`; `list` zeigt sie getrennt.

Aus deiner Claude-Code-Session bittest du darum („stell diesen Fehler nach: …“): Die Session startet `caw_start` mit
`command: "reproduce"`, ist selbst der Agent ohne zusätzliche Tokens und bekommt Urteil, Bericht und Entwurf über `caw_status`.

### Vom Fehler zum belegten Fix

Der Entwurf macht aus dem Fehler einen Test, der den Fix belegt: vorher rot, danach grün, alle anderen Tests weiter grün.

1. **Rot:** `caw record <id>` nimmt den Entwurf auf. Sein letzter Schritt ist der, der scheitern muss: Der Agent prüft dort das
   richtige Verhalten, und die Prüfung antwortet „nein“, solange der Fehler da ist. caw behält genau diese scheiternde Prüfung,
   sofern sie ausgewertet wurde (eine Prüfung, die geworfen hat, belegt nichts). Der Prüflauf ohne den Agenten zeigt dann „S3 rot wie
   erwartet: der Test fängt den Fehler“, wenn alle Schritte davor bestanden und S3 an seiner Prüfung scheiterte; Speichern
   behält den Entwurf mit `red: {step, run, head}` (der Lauf und der damals ausgecheckte Commit). Besteht S3, fängt der Entwurf
   den Fehler nicht, und die Entscheidung sagt das.
2. **Fix:** Du behebst den Fehler, von Hand oder mit deiner verbundenen Claude-Code-Session; jede Änderung braucht deine
   Zustimmung. caws eigener Agent ändert nie Code.
3. **Grün:** `caw run <id>` spielt dieselbe Aufzeichnung ohne KI ab. Noch rot, sagt der Chat „S3 noch rot: der Fehler ist noch
   da“ und bietet nichts an, was am Test zu beheben wäre; grün, nennt das Terminal den nächsten Befehl.
4. **Übernehmen:** `caw run <id> --promote` spielt den Entwurf ab und, wenn er besteht, `run --all` auf derselben Umgebung. Erst
   wenn beides grün ist, wandert der Test nach `caw/tests` und `caw/recordings`, der Entwurf wird gelöscht, und der Laufordner
   des Entwurfs bekommt `fix-report.md`: rot bei welchem Schritt (Lauf, Commit), grün in welchem Lauf, die seit dem roten Commit
   geänderten Dateien (versionierte Dateien, committet oder nicht, im ganzen Repository; neue Dateien nur im Projektordner; ohne
   `caw/` und `.caw/`) und wie viele andere Tests bestanden haben.
   Exit 0 übernommen, 1 nicht grün, 4 nicht aufgenommen oder nie rot.

**Geführt in der Werkbank.** Mit Fenster führt der Chat in einem Prozess durch diese Schritte, jeden in einem neuen Fenster,
und der bisherige Chat läuft mit; „Später“ auf jeder Karte beendet den Lauf dort, und das Terminal nennt weiter den nächsten
Befehl. Eine Leiste über jeder Karte zeigt die Phasen Nachgestellt › Rot › Beheben › Grün › Übernommen: erledigte mit Haken,
die aktuelle hervorgehoben.

- `caw reproduce` nachgestellt: Die Karte bietet **Rot aufnehmen**, die Aufnahme des Entwurfs wie mit `caw record <id>`.
- Rot gespeichert: Die Karte **Jetzt den Fehler beheben** listet den roten Schritt, sein erwartetes Ergebnis, seine Prüfung und,
  wenn bekannt, die Ursache, die das Nachstellen vermutet hat (aus dem Laufordner des Nachstellens, den `keepRuns` behält, solange der Entwurf da ist; der Agent, der ihn aufnimmt, findet sie auch am Anfang der `notes` des Entwurfs, die der aufgenommene Plan umschreiben darf). **Vom Agenten beheben lassen**
  lässt den Agenten den Fix empfehlen, mit jeder Art Agent (lokal, Docker, deine verbundene Session): Seine Codeänderungen kommen
  als Karten, die du einzeln übernimmst („Änderung übernehmen“); caws eigener Agent schreibt nie Code. Liegt die Ursache außerhalb
  des Projekts (ein anderes Repository, ein Dienst, die Umgebung), sagt seine Karte wo, es gibt nichts zu übernehmen, und **Ich
  behebe es dort** wartet wie **Ich behebe selbst**, bis du **Erneut testen** klickst.
- Noch rot: erneut beheben lassen, erneut testen oder den Lauf beenden. Grün: **S3 grün: der Fehler ist behoben**, und
  **Übernehmen** übernimmt den Entwurf wie `--promote`, während das Fenster wartet; der Chat nennt den Fix-Bericht. Ist ein
  anderer Test rot, sagt die Karte das, und der Entwurf bleibt.
- `caw record <id>` und `caw run <id>` mit Fenster steigen an ihrem Schritt ein. Headless, `--no-chat` und CI laufen wie bisher.

Aus deiner Session sind das `caw_start` mit `command: "record"`, `"run"` und `"run"` mit `promote: true`. Deine Session muss
nicht mitzählen: `caw_status` (zum Nachstellen und zu jedem Lauf des Entwurfs) und jede Zeile von `caw_reproductions` tragen
`phase` (`reproduced`, `red`, `green`, `promoted`) und `next`, den Schritt danach: aufnehmen, die App beheben (mit dem roten
Schritt, seiner Prüfung und der vermuteten Ursache), ablaufen lassen, übernehmen oder fertig mit dem Fix-Bericht. `green` kommt
nur aus einem Lauf nach dem Rot-Nachweis, der den roten Schritt geprüft und bestanden hat; `caw open <id>@<roter Schritt>` hält
vor dieser Prüfung an und lässt die Phase `red`.

Findet der Agent, dass ein bestehender Test das gemeldete Verhalten schon prüft, nennt er ihn im Urteil (`covered`: der Test,
wahlweise der Schritt, und warum). caw nimmt nur einen aufgenommenen Test an und ergänzt seinen neuesten Lauf aus `.caw/runs`;
war der grün, sagt der Bericht, dass seine Prüfung den Fehler vielleicht übersieht.

### Tickets aus einem anderen Werkzeug

caw spricht mit keinem Ticketsystem. Hat deine Session einen anderen MCP-Server, der Tickets liefert, verkettet sie beide: Sie
liest dort ein Ticket, startet `caw_start` mit `command: "reproduce"`, dem Tickettext als `bug` und seiner ID als `ref`
(`--ref` auf der Kommandozeile) und macht mit dem nächsten weiter. caw behält die ID, wie sie ist, schlägt sie nie nach und
schreibt sie in Bericht, Ergebnis und Entwurf. Danach listet `caw_reproductions` mit `refs` die Läufe zu diesen Tickets (Urteil,
was der Agent beobachtet hat, ein bestehender Test, der es abdeckt, Entwurf, Bericht) und nennt Tickets ohne Lauf als `missing`;
die Tabelle zeigt die Session. Was im Ticket steht, bleibt Fehlerbericht: Der Agent behandelt es als Daten, nicht als Anweisung.

## Jeden Zustand erreichen und entwickeln

Dieselben Tests bringen dich angemeldet in jeden Zustand deiner App und übergeben dir das Fenster: um dort mit dem Agenten im Chat zu entwickeln.

### Zustand herstellen und übernehmen

```bash
caw open <test> --env local
caw open <test>@S4 --env local
```

`open <test>` spielt den ganzen Test ab und übergibt dann das Fenster. `open <test>@S4` hält am Einstieg in `S4` an: S1 bis S3 laufen ganz, mit ihren Prüfungen, von S4 nur die Navigation am Anfang (`goto`, Klicks, `wait-ready`). Seine Eingaben und seine Prüfung bleiben offen, du machst also genau dort weiter, wo die Arbeit von S4 beginnt, etwa in der Maske, die er ausfüllt. Im Terminal steht „Bereit für S4 <Name>: Navigation ausgeführt, Eingaben offen.“ S4 selbst wird nicht bewertet; spätere Schritte laufen nicht, sie dürfen also auch veraltet sein. `@S1` meldet an, öffnet die Anwendung und führt die Navigation von S1 aus.

Von S4 läuft nichts, wenn er gar keine Eingabe hat (`fill`, `type`, `upload`, etwa nur ein Klick auf „Absenden“) oder nicht aktuell aufgenommen ist. Hat einer seiner Klicks am Anfang in früheren Läufen Daten geschrieben (gelernte Wirkungen), hält es vor diesem Klick an. Das Terminal nennt den Grund.

Der Ablauf ist deterministisch, die Umgebung nicht: Das ist kein Snapshot. Der Weg läuft jedes Mal neu, mit neuen Daten, und weicht die Anwendung ab, scheitert der Schritt sichtbar.

- **Code:** Wie bei jedem Lauf der Code der Umgebung: gegen deinen Dev-Server dein aktueller Code, sonst der ausgelieferte Stand. Die Zeile `Code:` sagt, welcher (siehe [Lokalen Code testen](configuration.de.md#lokalen-code-testen)). Änderungen siehst du mit F5, der Maskenzustand ist danach weg. Um wieder hinzukommen, startest du den Befehl neu.
- **Weg scheitert:** Du klärst den Fehler im Chat und kannst den Schritt beheben lassen. Schließt du ihn, geht das Fenster trotzdem an dich, der Bericht nennt den Fehler. Der Exit-Code bleibt das Urteil.
- **Keine Aufzeichnung:** Exit 4, erst aufnehmen. Das gilt für die Schritte vor S4; S4 selbst darf veraltet sein.
- **Lernt nichts:** Anders als `run` lernt `open` keine Vergleichswerte und keine Wirkungen.
- **Nicht in CI:** Mit gesetztem `CI` endet `open` mit Exit 3; niemand ist da, der das Fenster übernimmt.
- **Zustand nach Reload:** Ob eine Ansicht nach F5 im selben Zustand bleibt, hängt von der Anwendung ab.

### Im hergestellten Zustand entwickeln

Mit Chat bleibt der Chat nach der Übergabe offen (Zustand „Entwickeln“). Seine erste Karte, „So geht es weiter“, sagt, was das Fenster bietet:

Die Werkbank bleibt, wie sie ist, mit Schritten und Chat; F8 zeigt nur die Anwendung (**Nur Anwendung**) und behält das auch beim Neuladen. Das Browserfenster bleibt, wie es ist. Die Anwendung füllt jetzt die ganze Fläche; die aufgenommene Größe gilt nur, solange caw abspielt, auch beim Herstellen eines Zustands.

- **Fragen:** Du fragst den Agenten im Chat, gern zu einem Element, das du mit `/element` in der App gewählt hast. Der Agent liest den Quellcode und antwortet. Code ändert er nie selbst, er schlägt geprüfte Änderungen vor: „Änderung übernehmen“ schreibt sie in deinen Projektordner, „Prompt kopieren“ gibt sie dir für deine eigene Session.
- **Den Agenten bedienen lassen:** Auf deine Bitte klickt der Agent, füllt aus, drückt Tasten, navigiert oder lädt neu, etwa „klick den gewählten Button“. Vor allem, was Daten speichert oder löscht, fragt er nach.
- **Bug untersuchen:** Füge ein Bugticket in den Chat ein. Der Agent stellt es im hergestellten Zustand nach, sieht sich Konsole, Requests, Werte der Komponenten und den Quellcode an, nennt die Ursache mit Datei und Zeile und schlägt die Korrektur als Änderung vor, die du per Klick übernimmst. Danach neu laden oder den Zustand neu herstellen, und der Agent prüft, ob der Bug weg ist.
- **Neu laden** (F5): lädt die aktuelle Seite ohne Cache neu, damit deine Änderung sofort da ist. Chat und Schritte bleiben; der Test ist schon vorbei, sein Ergebnis ändert sich nicht.
- **Neu öffnen** (im Chat): beginnt eine neue Sitzung (Cookies und Speicher der Seite gelöscht), meldet neu an und spielt die Aufzeichnung bis zur selben Stelle ab (bei `@S4` bis zum Einstieg in S4), mit neuen Testdaten, also genau wie jeder andere Lauf.
- **Öffnen… (F1):** ein beliebiger Test dieser Umgebung, jeder Rolle, optional mit einem Schritt. Bevor caw dein Fenster ersetzt, bestätigst du im Chat, etwa mit „S2 öffnen“. Dann spielt caw den Test im selben Fenster mit dem Konto der Rolle des Tests ab: ohne Schritt den ganzen Test, mit Schritt bis zu dessen Einstieg, wie bei `open <test>@<schritt>`. Scheitert das Herstellen, weiß der Agent im Chat warum; er kann den Test auch anpassen, etwa einen Klick auf einen Cookie-Banner optional machen, und die Änderung steht sofort in der Testdatei.
- **Element wählen:** Mit `/element` im Chat klickst du in der Anwendung auf ein Element, auch auf einen ausgegrauten Knopf oder einen in einem Dialog; ein Ring mit Beschriftung zeigt, was der Klick wählt (der Klick löst dort nichts aus, Esc bricht ab). Es hängt an deiner nächsten Frage im Chat, und caw legt es mit Beschriftung, Komponente bzw. Quelle, Seite und Requests für deine Claude-Code-Session ab, abrufbar mit `caw_selection`.
- **Ende:** „Lauf beenden“ oder Fenster schließen.

### Übernehmen und weiterentwickeln

`caw open <test>` spielt den Test ab und lässt das Fenster nach dem Urteil offen:

- **Weiterklicken:** Du machst in derselben Seite und im selben Maskenzustand weiter, auch mit ungespeicherten Eingaben und DevTools.
- **Weiterentwickeln:** Gegen deinen Dev-Server als Umgebung lädt F5 deinen aktuellen Code. Mit der [Overlay-Erweiterung](extensions/overlay.de.md) bleibt der lokale Code, bis du das Fenster schließt. Einen automatischen Reload gibt es nicht, außer dem Hot Reload des Dev-Servers.
- **Zustand:** F5 verliert, was nur im Browser stand, etwa offene Dialoge und ungespeicherte Eingaben. Zurück dorthin bringt dich „Zustand neu herstellen“ im Chat oder ein neuer Testlauf.
- **Ende:** Fenster schließen beendet den Lauf. Der Exit-Code bleibt das Urteil.
- **Tastatur im Chat:** Strg+↵ (Cmd+↵) löst die Hauptaktion aus, solange das Eingabefeld leer ist, etwa „Plan freigeben“ oder „Vorführung beenden“; der Knopf zeigt dazu `Strg ↵`. Alt+↵ schickt einen Prüfpunkt, während du vorführst. Esc schließt zuerst ein offenes Menü und leert dann das Eingabefeld, wenn du darin tippst. Sonst fragt Esc den Abbruch an („Wirklich abbrechen? (Esc)“ und „Nein“), erst ein zweites Esc innerhalb von 4 Sekunden bestätigt ihn. Neue Auswahlknöpfe bekommen den Fokus, außer du tippst gerade.
- **Du bist dran:** Wartet der Chat auf dich (Plan, Entscheidung, Fehler klären), steht „DU BIST DRAN“ über der Anwendung, und das Terminal meldet einmal „Wartet im Chrome-Fenster auf dich: …“.
- **Aufnahme, Wiedergabe, Pause:** Ein Chip oben rechts in der Werkbank zeigt, was der Lauf tut: „REC“, solange der Agent aufnimmt oder repariert, „PLAY“, solange caw abspielt (run, Prüflauf, Zustand herstellen), „PAUSE“, solange ein solcher Lauf pausiert (F9). Läuft nichts (nach dem Lauf, nach der Übergabe, nach dem Abbruch), gibt es keinen Chip.
- **Nach dem Lauf:** Das Ergebnis steht als letzte Zeile im Chat, etwa „Gespeichert: caw/tests/bestellung.yaml“. Darunter sagt die Abschlusskarte „Lauf bestanden“ oder „Lauf gescheitert“ (bei `reproduce` das Urteil, mit Beobachtet, Erwartet und Ursache), zählt die Schritte und zeigt den Befehl für einen neuen Lauf, mit einem Knopf zum Kopieren. Ihre Hauptaktion ist „Fenster schließen“, daneben „Bericht öffnen“. „Bericht öffnen“ öffnet die [Berichtsseite](#die-berichtsseite) in einem neuen Tab. Das Fenster bleibt noch 15 Sekunden offen, „Fenster schließen“ zählt herunter, und schließt sich dann selbst; ein Klick ins Eingabefeld des Chats hält den Countdown endgültig an („Bleibt offen“). Über der Karte nennt ein Hinweis die Schritte, deren Vergleichswerte dieser Lauf gespeichert hat. Öffnet sich gleich ein neues Fenster (für den Agenten oder den Prüflauf), sagen Chat und Terminal das vorher.

Eigene Tabs kannst du jederzeit öffnen, auch während des Laufs: Gesteuert wird nur der Anwendungs-Tab samt Popups, und nur deren Fehler zählen. Klickst du dagegen im Anwendungs-Tab, während ein Lauf arbeitet, beeinflusst du den Test.

Du bleibst im Fenster hinter derselben Host-Sperre und bist als Testnutzer angemeldet. Dialoge wie `alert()` schließt Playwright automatisch, sie bleiben also nicht stehen. Das Profil ist frisch und wird am Ende gelöscht. Bleibt es etwa nach einem Abbruch liegen, entfernt es der nächste Lauf, sofern dessen Prozess nicht mehr läuft.

## Der Rahmen des Agenten

Testkonten bleiben in deiner `caw/.env`, Produktion wird nur gelesen, und der Agent erreicht die Anwendung nur über den Browser und feste Befehle.

### Sandbox-Grenzen

**Lokal (Agent `local`):**

- **Werkzeuge:** Claude Code startet mit `--tools Read,Grep,Glob`, `--permission-mode dontAsk` und `--strict-mcp-config`: keine Shell, kein Schreiben, kein Web, nur das caw-Tool als MCP-Server. Hooks sind abgeschaltet. `--tools` legt die Liste fest, eigene Einstellungen schalten keine weiteren Werkzeuge frei.
- **Reichweite:** Freigegeben ist nur `Read(./**)`, `Grep(./**)` und `Glob(./**)`, also der Projektordner; alles andere lehnt `dontAsk` ab, auch `~/.ssh` oder die Anmeldung von Claude Code (geprüft mit Claude Code 2.1.319). Deine eigenen und die Claude-Code-Einstellungen des Projekts werden nicht geladen (`--setting-sources ""`), ihre `allow`-Regeln erweitern das also nicht; aus `~/.claude/settings.json` kommen nur die Verbindungseinstellungen mit (`env`, `apiKeyHelper`, `model`, AWS-Helfer). Screenshots im Agent-Ordner unter `.caw/` kann der Agent lokal nicht ansehen.
- **Dateien:** `.env*`, `.git`, `.claude`, `.worktrees`, `.caw`, `caw/.auth` sowie typische Schlüsseldateien (`.npmrc`, `*.pem`, `id_rsa*` …) sind per `permissions.deny` gesperrt. Das ist eine Sperre von Claude Code, kein Dateisystem-Schutz wie im Container: Wer stärkere Garantien braucht, nimmt `docker`.
- **Netz:** Der Agent selbst hat kein Web-Werkzeug. Die Anwendung erreicht er nur über den Browser mit dessen Sperre.

**Session (Agent `session`):** Es gelten die Rechte deiner eigenen Claude-Code-Session. caw gibt ihr nur die Befehle für den Browser dazu.

**Container (Agent `docker`):**

- **Dateien:** Der Projektordner ist read-only eingebunden, im Container immer unter dem Linux-Pfad (`C:\x` als `/mnt/c/x`). Beschreibbar sind nur der Agent-Ordner des Laufs und das Innere des Containers. `.git`, `.claude`, `.worktrees`, `.caw` und alle `.env`-Dateien sind ausgeblendet, auch `caw/.env`. Andere Geheimnisse im Projektordner sieht der Agent.
- **Netz:** Default deny für IPv4 und IPv6. Erlaubt sind Loopback und HTTPS zur Anthropic-API. Deren Adressen löst die Firewall beim Start auf und trägt sie in `/etc/hosts` ein; danach ist auch DNS gesperrt, samt Dockers eingebautem Resolver, damit sich keine Daten in DNS-Namen hinaustragen lassen. Ändern sich die Adressen der API während eines Laufs, hilft ein neuer Lauf. Die Anwendung ist aus dem Container nicht erreichbar.
- **Rechte:** Der Container startet nur für die Firewall als root und läuft danach als Sandbox-Benutzer (`sandboxUser`) ohne Capabilities, mit `no-new-privileges`. Es gibt keine veröffentlichten Ports und keinen Docker-Socket.
- **Token:** Es kommt zur Laufzeit als Umgebungsvariable und liegt nicht im Image.

**Chrome (auf dem Host, außerhalb der Docker-Firewall):**

- **Steuerung:** Der Agent bekommt nie CDP. Es gibt nur die festen Befehle aus `caw agent --help`, als Dateien im Agent-Ordner. Navigation per `goto` geht nur zu erlaubten Hosts.
- **Netz:** Die Docker-Firewall deckt nur den Container des Agenten ab, nicht dieses Chrome. Seiten navigieren nur zu den Hosts aus `environments` und `allowHosts` (eine Request-Route; eine Weiterleitung auf einen anderen Host lässt die Aktion ebenfalls scheitern). Solange ein Agent im Fenster handeln kann (record, ein Lauf mit Chat, `open`), geht jeder Request nur an diese Hosts und `thirdPartyHosts`: fetch, XHR, WebSockets, Beacons, iframes, Skripte und Weiterleitungen. Jeden anderen Namen kann Chrome nicht einmal auflösen (`--host-resolver-rules` mit `MAP * ~NOTFOUND` und einer Ausnahme je erlaubtem Host), das stoppt auch DNS-Abfragen und Verbindungen, die keine Route sieht; eine Request-Route und eine WebSocket-Route brechen die Requests vorher ab und nennen jeden gesperrten Host als Warnung im Lauf, mit dem Schlüssel, der ihn freigibt. Sonst dürfen Unterressourcen und iframes jeden Host erreichen und stehen im Bericht als fremde Hosts. Produktions-Hosts anderer Umgebungen sind in jedem Lauf für jeden Request-Typ nicht auflösbar, auch mit Punkt am Ende. Dazu `--no-proxy-server`, damit die Resolver-Regeln greifen, und eine WebRTC-Sperre.
- **Sandbox:** Chrome läuft immer in seiner eigenen Sandbox. Wo sie nicht starten kann (Linux als root, manche Container), hält caw mit `browser-sandbox` an; `browser.noSandbox: true` schaltet sie bewusst ab (unsicher).
- **Werkbank:** Das Dokument des obersten Fensters beantwortet das Tool selbst, unter der Adresse der Anwendung. Die Anwendung teilt sich damit den Origin mit der Werkbank und kann deren Seite verändern; Entscheidungen fallen nur im Chat, und dessen Dokument erreicht sie nicht (eigener, opaker Origin). Sie kann die Sandbox des Chat-iframes entfernen oder ihn neu laden; dann schreibt das Tool den Chat nicht hinein und der Lauf endet mit `chat-tampered`. Von den Dokumenten der Anwendung verlieren nur die des Anwendungs-iframes selbst `X-Frame-Options` und `frame-ancestors`, und den Anwendungsrahmen kennt das Tool an seiner Identität, nicht an seinem Namen. Ein POST ins oberste Fenster schickt das Tool einmal über den Browser-Kontext (gleiche Cookies, gleiche Host-Sperre) ab.
- **Grenze der Sperre:** Sie kennt Hostnamen, keine Ports oder Adressen. Andere Dienste auf einem erlaubten Host sind aus der Seite erreichbar, und ein Produktions-Host, der über seine IP-Adresse (oder einen anderen Namen für dieselbe Adresse) erreicht wird, ist nicht gesperrt.
- **Einsicht:** `eval` läuft in der angemeldeten Seite. Der Agent sieht und kann also alles, was der Testnutzer in der Anwendung sieht und kann. Deshalb nur Testkonten mit wenig Rechten verwenden.
- **Backend:** Die Sperre endet am Host der Anwendung. Requests über einen Proxy der Anwendung gehen durch, und wohin er weiterleitet, entscheidet der Server. Die eigentliche Grenze sind die Rechte des Testkontos.
- **`writes: false`:** Ein neuer Test ist schreibend, außer `record … --read-only`. Schreibt ein lesender Test bei der Aufnahme doch, wird er beim Übernehmen schreibend. Das Tool prüft das Feld vor dem Start gegen `environments.<umgebung>.writable`. Im Lauf verhindert nur die Anweisung des Leitfadens das Schreiben, technisch blockiert ist es nicht (auf `production`-Umgebungen sind schreibende Requests an jeden Host gesperrt, Formular-Posts ins oberste Fenster eingeschlossen; Nachrichten über einen offenen WebSocket nicht, denn auch lesende Apps schicken welche).
- **Firmenrichtlinien:** Eine zentral erzwungene Chrome-Richtlinie (z. B. ein Proxy) kann die Sperre aushebeln. Prüfe das auf dem Rechner, auf dem die Tests laufen (`chrome://policy`).

**Urteil:** Bericht und `result.json` schreibt nur der Host, außerhalb des Agent-Ordners. Als Screenshot zählt nur, was der Host selbst aufgenommen hat.

## Visuelle Prüfungen

Zwei Arten visueller Prüfung, beide ohne KI. Ein [Zielbild](#gegen-ein-zielbild-entwickeln) sagt, was ein Bildschirm werden soll. `look: true` hält einen gebauten Bildschirm so, wie er ist.

### Visuelle Regression

`look: true` an einem Schritt in der Testdatei lässt caw das Aussehen dieses Schritts lernen: seine Stilzeilen über zwei bestandene Läufe, auch im Fenster, sein Bild über zwei passende headless Läufe ([Details](test-files.de.md#visuelle-regression)). Ein späterer Lauf, in dem sich Stile oder Pixel geändert haben, lässt den Schritt mit kind `visual` scheitern. `look` schreibst nur du, wie `design` und `needs`; es liegt außerhalb des Hashs.

- **Nur feste Daten:** Setze es nur an Schritten, deren Bildschirm feste Daten zeigt, etwa einen Zustand, den der Test selbst herstellt. Daten, die sich ändern, machen es unruhig.
- **Vorschlag nach der Aufnahme:** Nach `caw record` schlägt der Prüflauf solche Schritte in seiner Karte „Prüflauf bestanden“ vor. Er beurteilt, woher ihr Text kommt: Werte aus den Antworten des Servers, Zeilen, Listeneinträge, Karten, Datumsangaben. Keiner ist angehakt, denn sicher ist caw nicht. Angehakte Schritte bekommen beim Übernehmen `look: true`.
- **Maskiert:** Laufkennung, gemerkte Werte, Datumsangaben in Ziffern, Listen- und Tabellenzeilen, Listeneinträge und Karten. `visualIgnore` in der Config deckt den Rest ab. Die Bedienelemente in maskierten Bereichen zählen auch in den Style-Zeilen nicht, ein Listeneintrag mehr ändert also nichts.
- **Pixel nur headless:** Pixel lernen und vergleichen nur headless Läufe (`--headless`, ein fester Viewport: der aufgenommene, sonst 1920 × 1080). Ein Lauf im Fenster vergleicht nur die Stile. Auch ein CI-Lauf ohne `--headless` hat ein Fenster und warnt: Ergänze `--headless`.
- **Gewollte Änderung:** **Neuen Look übernehmen** im Chat übernimmt das neue Aussehen aller geänderten Schritte auf einmal; ihre Bilder aller Plattformen werden gelöscht, die nächsten headless Läufe lernen sie neu. Eine Änderung, die nur die Pixel sehen, bietet kein Übernehmen an, denn das Fenster sieht nichts: Der gescheiterte headless Lauf nennt die Bilddatei des Schritts; lösche sie, und die nächsten zwei headless Läufe lernen sie neu. `caw audit` listet das, und `look: true` an einem Schritt mit gelerntem Aussehen zu entfernen zählt als Schwächung.
- **Grenzen:** Das Bild gilt je Plattform (Schriften rendern unter Windows und Linux verschieden), und die Schwellen sind Startwerte, bis sie gemessen sind ([Einzelheiten](test-files.de.md#visuelle-regression)).

### Feste Daten

Für einen Bildschirm, dessen Daten sich laufend ändern (ein Portal), friert **Daten einfrieren** in der Karte eines bestandenen Laufs mit Fenster die JSON-Antworten der Lesezugriffe der App für die Aussehens-Schritte ein. Du wählst, wie sie gespeichert werden: anonymisiert, verschleiert oder lesbar, nachdem du bestätigt hast, dass du den Datenschutz geprüft hast. Du prüfst sie, bevor etwas geschrieben wird. Sind sie eingefroren, fragt ein bestandener Lauf mit Fenster nicht mehr: Ein Hinweis sagt, dass die Aussehen die eingefrorenen Daten nutzen, und die Karte kommt erst wieder, wenn die Antworten des Backends nicht mehr passen.

Headless Läufe vergleichen diese Aussehen dann in einem eigenen Durchlauf auf den eingefrorenen Antworten, Schreibzugriffe angehalten. Prüfungen, Wirkungen und Requests des Laufs laufen weiter gegen das echte Backend. Hat eine echte Antwort eine andere Struktur, warnt caw, dass die eingefrorenen Daten nicht mehr zum Backend passen. In CI wird nie etwas eingefroren ([Einzelheiten](test-files.de.md#feste-daten)).

## Produktion überwachen

Ein Monitor ist ein `run` lesender Tests gegen Produktion, der nach Zeitplan läuft. Er braucht weder Agent noch Token: caw schreibt das Ergebnis, dein Scheduler oder dein CI schlägt Alarm. Berichte, Wiederholungen und alles Weitere zu CI: [In CI](#in-ci).

### Rezept

```bash
npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json
```

- **Welche Tests:** `--all --env prod` nimmt jeden Test, der `prod` unter `environments` nennt. Ohne dieses Feld läuft ein Test überall außer auf Produktion. Trag die Umgebung also in jeden Test ein, den der Monitor fahren soll ([Testdateien](test-files.de.md#testplan)). Das geht nur bei lesenden Tests: Ein Test mit `writes: true`, der eine Produktionsumgebung nennt, ist ungültig.
- **Ohne Fenster:** `--headless`. Eine Produktionsumgebung hat kein `agent`, Chat und Agent gibt es dort ohnehin nicht.
- **Wiederholen:** `--retry-env 1` gibt einem Test einen weiteren Versuch, wenn die Umgebung schuld ist ([Wiederholungen](#wiederholungen)).
- **Berichte:** `junit=` für dein CI oder Alarmierungswerkzeug, `json=` für Skripte. In GitHub Actions zusätzlich `summary=` für die Job-Zusammenfassung ([Berichte](#berichte)). Sie sind die Alarmquelle des Monitors.
- **Offene Schritte:** Ein Test mit noch nicht aufgenommenen Schritten besteht ohne sie. Mit `--strict` wird daraus Exit `4`.

GitHub Actions, alle 15 Minuten, mit dem Konto aus den Secrets des Repositorys:

```yaml
on:
  schedule:
    - cron: '*/15 * * * *'
jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json --report summary=out/summary.md
        env:
          CAW_CLERK_USER__PROD: ${{ secrets.CAW_CLERK_USER__PROD }}
          CAW_CLERK_PASSWORD__PROD: ${{ secrets.CAW_CLERK_PASSWORD__PROD }}
      - run: cat out/summary.md >> "$GITHUB_STEP_SUMMARY"
        if: always() && hashFiles('out/summary.md') != ''
```

Auf einem eigenen Rechner, `alert.sh` steht für deine Alarmierung:

```bash
*/15 * * * * cd /srv/shop && npx caw run --all --env prod --headless --retry-env 1 --report junit=out/caw.xml --report json=out/caw.json >> out/monitor.log 2>&1 || ./alert.sh $?
```

### Exit-Codes

| Exit | Bedeutet | Der Monitor |
|---|---|---|
| `0` | alle Tests bestanden | bleibt still |
| `1` | ein Schritt ist gescheitert: Die App tat nicht, was der Test erwartet | schlägt Alarm; die Berichte sagen, ob es nach Anwendung, Umgebung, Test oder unklar aussieht |
| `2` | Umgebung: kein Urteil (Server aus, Anmeldung fehlgeschlagen, Chrome fehlt, ein interner Fehler) | meldet Produktion als nicht erreichbar, oder schlägt erst nach mehreren Läufen in Folge Alarm |
| `3` | abgewiesen, es lief nichts: Der Monitor selbst ist kaputt (Config, Testdatei, ein fehlendes Secret `credentials-missing`, `auth-missing`, der Aufruf) | sagt es dem, der den Monitor pflegt |
| `4` | der Test braucht Pflege: Aufzeichnung fehlt (`replay-missing`), ein Schritt hat sich seit der Aufnahme geändert (`replay-stale`), offene Schritte mit `--strict` (`replay-pending`) | sagt es dem, der die Tests pflegt |

Bei mehreren Tests gilt der schlimmste Exit-Code: `2` vor `1` vor `4` vor `3` vor `0`. Ein Test, der an der Umgebung endete, verdeckt also im Exit-Code den gescheiterten Schritt eines anderen; jedes einzelne Ergebnis steht in den Berichten. Hält caw schon vor dem ersten Test an (ungültige Config, unbekannte Umgebung, ein Berichtspfad außerhalb des Projekts), endet es mit `3` und schreibt keinen Bericht. Ein fehlender Bericht zählt also wie `3`. Alle Codes: [Befehle › Fehlercodes](commands.de.md#fehlercodes).

### Was auf Produktion anders ist

- **In der Config markiert:** `"production": true` an der Umgebung. Ein Name, der nach Produktion aussieht (`prod`, `live`, `prod-eu` …), muss `true` oder `false` angeben; bei `prod`, `production`, `prd`, `live` und ähnlichen muss es `true` sein. Sonst ist die Config ungültig (Exit `3`).
- **Kein Agent, kein Schreiben:** Eine Produktionsumgebung kann weder `agent` noch `writable` haben, auch kein `start`, `stop`, `reset` oder `ready`. `record`, `reproduce`, der Chat und `--explain` laufen dort also nicht; aufgenommen wird ein Test auf einer anderen Umgebung. `role login`, das Overlay und eine Adresse aus `CAW_URL__<ENV>` (`url-override`, Exit `3`) weist caw für sie ab, und `doctor` spricht sie nie an.
- **Schreiben gesperrt:** Jeder Request, der nicht liest, wird abgebrochen und lässt den Schritt mit `write-blocked` scheitern ([Konfiguration › environments](configuration.de.md#environments)).
- **Für andere Läufe unerreichbar:** Ein Lauf auf einer anderen Umgebung kann den Produktions-Host nicht auflösen.
- **Weniger in `result.json`:** Die Schritte haben auf Produktion keine Wirkungszeilen, denn die nennen, was auf der Seite sichtbar ist.
- **Lernen:** Vergleiche, Wirkungen und gelerntes Aussehen lernt caw nur auf der Umgebung, auf der ein Test aufgenommen wurde (`recordedOn` in der Aufzeichnung); verglichen wird auf jeder Umgebung. Ein Lauf auf Produktion lernt nichts und ändert keine Testdatei. Wirkungen (Bedienelemente, Requests, Antworten, Konsole) entstehen aus fünf gesunden Läufen und bleiben dann fest. Produktion hat andere Daten als die Umgebung der Aufnahme, eine Wirkung kann dort also abweichen, etwa eine Liste, die beim Lernen leer war. Was einen Schritt scheitern lässt und was nur warnt, steht unter [Wirkung je Aktion](#wirkung-je-aktion).

### Grenzen

- **WebSocket:** Requests, Vergleiche, Wirkungen und Einschätzung sehen die Requests der App, keine Nachrichten über einen WebSocket. Gesperrt sind diese Nachrichten auf Produktion auch nicht. Ein kaputtes Live-Update fällt nur auf, wenn eine Prüfung oder die Bedienelemente es bemerken.
- **Zugang per IP-Adresse:** caw kennt keine Proxy-Einstellung: Chrome startet mit `--no-proxy-server`, damit die Host-Sperre hält. Der Rechner des Monitors muss Produktion direkt erreichen. Lässt Produktion nur bestimmte Adressen zu, lass den Monitor auf einem Rechner mit bekannter Adresse laufen und gib diese frei.
- **Ein eigenes Konto für den Monitor:** Melde dich mit einem Konto an, das nur für den Monitor da ist und nicht mehr Rechte hat, als die Tests brauchen, nie mit einem persönlichen. Die Zugangsdaten kommen wie gewohnt ([Konfiguration › roles](configuration.de.md#roles)): `CAW_<ROLE>_USER__PROD`, `CAW_<ROLE>_PASSWORD__PROD` und für Einmalcodes `CAW_<ROLE>_TOTP__PROD`, als CI-Secrets oder in `caw/.env` auf dem Rechner des Monitors. `caw role login` weist Produktion ab, eine gespeicherte Sitzung (`signIn.type: session`) kann caw dort also nicht anlegen; ohne die Datei hält ein Lauf mit `auth-missing` an (Exit `3`). Ein Monitor auf Produktion meldet sich nur per Formular oder Basic-Anmeldung an (`signIn.type: form` oder `basic`).
- **Aufbewahrung:** Jeder Testlauf und jeder Versuch hinterlässt einen Ordner in `.caw/runs/`. `keepRuns` (Standard 30) zählt jeden Testlauf, nicht jeden Monitorlauf: Es behält die neuesten und löscht ältere, wenn ein Lauf startet. Bei zehn Tests sind das drei Monitorläufe. Ein Monitor sollte `keepRuns` also hochsetzen oder seinen JSON-Bericht selbst archivieren; `0` behält jeden Lauf und füllt die Platte.
- **Personenbezogene Daten in Artefakten:** Produktion zeigt echte Daten. caw ersetzt das Passwort der Rolle, Einmalcodes, mit `secret: true` markierte Werte und HTTP-Basic-Zugangsdaten durch `••••`, in `report.md`, `result.json` und im Trace. Request-Namen enthalten keine Parameterwerte (außer `requestKeys`), und auf Produktion fehlen in `result.json` die Wirkungszeilen. Nicht maskiert: Screenshots (der Fehlerbildschirm, `visual.screenshots`), der Trace (`trace.zip` mit Seiteninhalten, Requests und den Cookies des Kontos) und Texte, die die App gezeigt hat. Die landen in Gründen, Befunden, Meldungen und Konsolenzeilen in `report.md`, `result.json` und den Berichten JUnit, JSON und Zusammenfassung. Lass `.caw/runs` auf dem Rechner des Monitors, lade keine Laufordner als CI-Artefakte hoch, und behandle die Berichte als Daten, die aus der Seite zitieren können.

## Aus Claude Code steuern

Der Agent läuft als dein eigenes Claude Code, in einer Docker-Sandbox oder als deine Claude-Code-Session. In deiner Session ist caw ein Satz MCP-Werkzeuge: einrichten, aufnehmen, abspielen, nachstellen, einen Zustand öffnen.

### Agent: lokal, Docker oder deine Session

Wo der Agent läuft, wenn ein Lauf es braucht, legt `agent.mode` in der Config fest (`local`, `docker` oder `session`, Standard `local`). `--agent local|docker` überschreibt das für einen Lauf; `--attach [<key>]` lässt deine eigene Claude-Code-Session dafür arbeiten. In CI (`CI` gesetzt) gilt immer `docker`, andere Werte brechen ab.

| Agent | Wie der Agent läuft | Gut für |
|---|---|---|
| `local` | `claude -p` auf deinem Rechner, mit deiner Anmeldung. Nur die Werkzeuge `Read`, `Grep`, `Glob` und das caw-Tool, keine Shell, kein Schreiben, kein Web, keine Hooks, keine anderen MCP-Server. | den Alltag am eigenen Rechner |
| `docker` | `claude` im Container mit Firewall, nur mit API-Schlüssel (`ANTHROPIC_API_KEY`) | wer den Agenten nicht auf dem eigenen System haben will |
| `session` | Kein eigener Agenten-Prozess. Deine offene Claude-Code-Session übernimmt die Rolle über den MCP-Server `caw mcp`. | Aufnehmen, Beheben und Entwickeln in der gewohnten IDE-Session |

In allen drei Fällen ist der Browser die eigentliche Grenze: Der Agent sieht die Anwendung nur über die festen Befehle, Navigation nur zu erlaubten Hosts (siehe [Sandbox-Grenzen](#sandbox-grenzen)).

```json
"caw:shop:smoke": "caw run shop-smoke --env local",
"caw:shop:smoke:record": "caw record shop-smoke --env local",
"caw:shop:smoke:rerecord-docker": "caw record shop-smoke@S2 --env local --agent docker"
```

In CI (`CI` gesetzt) läuft `run` ohne Chat und ohne den Agenten; `agent.mode` greift dort nur, falls ein Lauf doch den Agent braucht, und dann immer mit `docker`.

**Persönliche Einstellungen:** Was du in der Werkbank für dich festlegst, merkt sich caw je Nutzer in `prefs.json` unter `CAW_AI_HOME`, sonst `%APPDATA%\caw-ai` (Windows) bzw. `~/.config/caw-ai`: „Animationen aus“ (F10: kein Spinner, keine pulsierenden Punkte, kein blinkender Cursor), eingeklappte Schritte oder Chat und der Modus (`system`, `light` oder `dark`; `system` folgt deinem Betriebssystem und ist der Standard). Du änderst sie auf der [Einstellungsseite](#einstellungen) (Strg+,). Im selben Ordner hält deine eigene `caw.md` Notizen für den Agenten in jedem Projekt, gelesen vor der `caw/caw.md` des Projekts ([Konfiguration](configuration.de.md#deine-eigene-cawmd)).

**Hinweis auf Token:** Bevor der Agent arbeitet (aufnehmen, beheben, Ursache untersuchen, Fragen im Chat, `--explain`), fragt der Chat einmal je Lauf: „Weiter“, „Nicht mehr fragen“ oder eine Ablehnung, die sagt, was sie bewirkt: „Ohne Claude Code weiter“ (Ursache untersuchen, Fragen im Chat) oder „Lauf abbrechen“ (aufnehmen, beheben). „Nicht mehr fragen“ setzt `"tokenNotice": "off"` in `prefs.json`; löschst du den Eintrag, kommt der Hinweis wieder. Mit `--attach` (oder `agent.mode: session`) gibt es den Hinweis nicht: Deine Session läuft ohnehin.

**Ausprobieren** ohne eigenes Projekt: [`examples/errand`](../examples/errand) im Repository, eine kleine App mit Anmeldung und einem Test.

#### Aus deiner Claude-Code-Session

Melde caw einmal als MCP-Server des Projekts an:

```bash
claude mcp add caw --scope project -- npx caw-ai mcp
```

Unter Windows (nicht WSL) braucht `npx` einen Wrapper: `claude mcp add caw --scope project -- cmd /c npx caw-ai mcp`. Ist caw im
Projekt installiert (`npm i -D caw-ai`), stellt `init` den Eintrag auf die installierte Kopie um
(`node node_modules/caw-ai/bin/caw.mjs mcp`); danach Claude Code neu starten. Deine Session hat dann diese Werkzeuge:

| Werkzeug | Zweck | Tokens |
|---|---|---|
| `caw_guide` | Wie man mit caw arbeitet, je Thema (`setup`, `tests`, `run`, `session`, `config` …); ohne Thema die Übersicht | nein |
| `caw_init` | `mode: explore` öffnet dir die App zum Anmelden und liefert die Vorschläge; `mode: write` schreibt daraus die Config; `mode: offline` die Vorlage mit TODO | nein |
| `caw_config` | `{ read: true }`: Config wie geschrieben und wirksam, mit Prüfung; `{ patch, dryRun }`: geprüfte Änderung, ein ungültiges Ergebnis wird nicht geschrieben. Befehle (`start`, `stop`, `reset`, `ready`, `lintCommand`, Overlay-`start`), die Umgebungs-Schalter (`production`, `agent`, `writable`, `allowHttp`, `insecureTls`), `browser.executablePath`, `sandboxImage`, `sandboxUser` und `agent.mode` lehnt es ab: Die ändert die Session in der Datei, wo Claude Code dir den Diff zeigt | nein |
| `caw_role` | `list` Rollen und ob ein Testnutzer gesetzt ist; `add` trägt eine Rolle in die Config ein und nennt ihre Variablen, `caw/.env` füllst du selbst; `login` speichert eine Sitzung (SSO); `remove` | nein |
| `caw_attach` | verbindet diese Session mit caw-Fenstern: liefert ihren Schlüssel und den Befehl, den sie mit ihrem Monitor-Werkzeug startet; Chat-Nachrichten und Aufgaben eines verbundenen Fensters erreichen die Session dann als Zeilen | nein |
| `caw_doctor`, `caw_validate`, `caw_list` | `doctor`, `validate` und `list` als Daten | nein |
| `caw_reproductions` | die Nachstellungen in `.caw/runs` mit Urteil, `ref`, abdeckendem Test, Entwurf und Bericht; `refs` nennt die ohne Lauf als `missing`, `since` filtert nach Datum | nein |
| `caw_design` | Zielbilder unter `caw/design`: schreiben (`put`), auflisten, auf Wunsch des Menschen an einen Schritt hängen | nein |
| `caw_start` | startet `run`, `record`, `open` oder `reproduce` mit deiner Session als Agent: Felder `test`, `env`, `step`, `overlay`, `headless`, `learn`, `promote`, `start`, `reset`; bei `reproduce` `bug`, `from`, `role`, `ref` (oder `args`) | nur deine Session |
| `caw_status` | ob ein Lauf auf die Session wartet und welche Guide-Themen gelten, die letzten Zeilen der Ausgabe und der letzte Lauf: Ergebnis, letzter Schritt, Artefakte | nein |
| `caw` | die Befehle des Agenten (`snapshot`, `click`, `plan`, `finish` …) für den wartenden Lauf | im Lauf |
| `caw_selection` | das Element, das du beim Entwickeln im Chat der Werkbank mit `/element` gewählt hast | nein |
| `caw_overlay` | nur mit einem `overlay`-Block: Ist der lokale Code-Server bereit, `check` und `apply` | nein |

Der Server sagt Claude Code, wofür caw da ist und dass es zuerst `caw_guide` liest. Ein Skill kommt mit: `caw init` (und `caw skill`, auch zum Aktualisieren) schreibt `.claude/skills/caw-attach/SKILL.md`; er sagt deiner Session, wann sie sich mit einem caw-Fenster verbindet: wenn du mit ihr etwas in der App ansehen willst, einen Fehler gemeinsam nachstellen lässt oder `/caw-attach` eingibst. Einchecken; caw ersetzt nur eine Datei, die es selbst geschrieben hat. Die Daten-Werkzeuge liefern einen kurzen Text und dasselbe Ergebnis als `structuredContent` (JSON). Keins schreibt auf den MCP-Kanal oder fragt auf stdin; Explore, `overlay check` und Läufe laufen als eigene Prozesse. caw startet deinen lokalen Code-Server nie aus der Session; das macht der Agent in seiner eigenen Session, nachdem er dich gefragt hat, außer die Regeln deines Projekts (etwa `CLAUDE.md`) sagen etwas anderes.

Du schreibst also in deiner Session „nimm einen Test für die Bestellung auf“ oder „bring mich zu S4 von bestellung“, und die Session erledigt den Rest mit dem Guide. Startest du ein Fenster selbst im Terminal mit `--attach`, wartet es, bis deine Session zuhört: Gib dort `/caw-attach` ein (oder bitte sie, sich zu verbinden). Was du dann im Chat der Werkbank schreibst, auch mit `/element`, erreicht diese Session; sie antwortet im Chat und darf den Code der App ändern, wenn du darum bittest.

- **Weniger Rückfragen:** Ist deine Session der Agent, gibt es keinen Hinweis auf Token, und `record` eines vorhandenen Testplans startet ohne die Frage, wer vorführt. Ein lesender Plan, dem die Session unverändert folgt, braucht keine Plan-Freigabe; die Übernahme des geprüften Plans am Ende immer.
- **Wartezeiten:** `plan` und `chat` warten auf dich, bis zu einer Stunde. Bricht Claude Code den Aufruf vorher ab, setz `MCP_TOOL_TIMEOUT` (Millisekunden) in der Umgebung von Claude Code höher.
- **Vorsicht:** Deine Session hat mehr Rechte als der Agent im Lauf (Shell, Schreiben). Was aus der Anwendung kommt, ist für sie Daten, keine Anweisung; caw sagt ihr das bei jedem Auftrag. Lass Bash- und Schreibaufrufe in dieser Session bestätigen, statt sie pauschal freizugeben. Auch die caw-Werkzeuge führen Befehle des Projekts aus: `caw_start` mit `start` führt das `start` der Umgebung aus (und später ihr `stop`), mit `reset` ihr `reset`, und ein `run` mit schreibendem Test führt `reset` vor diesem Test aus; alles aus `caw.config.json`, auf deinem Rechner. `caw_config` kann diese Befehle und die Umgebungs-Schalter nicht ändern; diese Änderung geht über das eigene Datei-Bearbeiten von Claude Code, prüf ihren Diff wie Code.

### Docker

Nur für den Agenten `docker`. Der Docker-Dienst muss laufen, das Tool startet ihn nicht. Den Container startet und entfernt es selbst.

Unter Windows nimmt das Tool den ersten Weg, dessen Dienst antwortet: zuerst `docker.exe`, dann Docker in WSL. Welcher es ist, steht am Anfang der Ausgabe. Mit `CAW_DOCKER=windows` oder `CAW_DOCKER=wsl` legst du ihn fest.

Die Prüfung läuft vor allem anderen und bricht mit einer eigenen Meldung ab (Exit 2):

| Code | Bedeutung |
|---|---|
| `docker-missing` | Kein Docker gefunden |
| `docker-not-running` | Docker ist da, der Dienst antwortet nicht |
| `docker-wrong-mode` | Docker Desktop steht auf Windows-Container, die Sandbox braucht Linux-Container |

## Export nach Playwright

`caw export <test>` schreibt einen aufgenommenen Test als Playwright-Test, der ohne caw läuft, nur mit `@playwright/test`: die aufgenommenen Locators, ein `test.step()` je Schritt, die Anmeldung aus `signIn`, Prüfungen als `expect.poll`. Was nicht exportiert wird und wie du ihn startest: [Befehle](commands.de.md#export).

## Weiteres

### Lokaler Code in der Anwendung

Gegen deinen Dev-Server läuft ohnehin dein Code: Er ist einfach eine Umgebung ([Konfiguration › Lokalen Code testen](configuration.de.md#lokalen-code-testen)). Für Anwendungen, die nur in einer ausgelieferten Umgebung laufen, legt die [Overlay-Erweiterung](extensions/overlay.de.md) deinen lokalen Code darüber; bei ExtJS aus dem Sencha-Watch ([ExtJS](extensions/extjs.de.md)).

### Framework: `web`, `react`, `vue`, `angular` oder `extjs`

Fast alles im Tool kennt kein Framework: Snapshot, Klicks, Konsole, Requests, Einschätzung, Chat. Was davon abhängt, steckt in einem Adapter, gewählt mit `framework` in der Config. Ein Projekt hat genau einen; die Testdatei nennt ihn nicht. `react`, `vue` und `angular` sind `web` mit drei Zusätzen: Sie erkennen, wann das Framework die Anwendung eingehängt hat, nennen zu jedem Ziel die Komponente (nur als Hinweis für den Agenten und den Bericht) und überspringen Framework-Dateien im Stack.

| | `web` (Standard) | `react` / `vue` / `angular` | `extjs` |
|---|---|---|---|
| Ziel speichern | Ein Playwright-Locator: Rolle und vollständiger zugänglicher Name (`aria-label`, Beschriftung, Text), `data-testid`, eingegrenzt auf den benannten Dialog, das Formular oder die Zeile darum. Nie Feldwerte. Offene Shadow Roots zählen (geschlossene sind nicht erreichbar); ein iframe der Anwendung über `contentFrame()` | wie `web`, dazu `component` als Hinweis: die Komponenten von außen nach innen, z. B. `GroupsScreen › Button`; bei Vue auch `source`, die SFC-Datei. Nur im Dev-Build, für das Wiederfinden ohne Belang | wie `web`; eine Komponente ohne Rolle oder Namen als `locator('extjs=…')` (`Ext.ComponentQuery`) |
| Bereit | Dokument geladen, kein Request der Seite offen (länger als 10 s offene wie Long-Polling zählen nicht), nichts mit `aria-busy`, kein unbestimmter Fortschritt (`role=progressbar` ohne `aria-valuenow`), DOM seit 150 ms still | wie `web`, dazu eingehängt: React-Root-Container, Vue `data-v-app`, Angular `[ng-version]`; Angular zusätzlich stabil laut Zone.js, wenn die App Testability anbietet (bei `bootstrapApplication` nur mit `provideProtractorTestingSupport()`) | Kein `Ext.Ajax`-Request offen, kein Store lädt |
| `wait-ready --for` | CSS-Selektor, `--min-count` zählt sichtbare Treffer | wie `web` | `storeId` oder ComponentQuery, zählt Datensätze |
| Meldungen | modale Dialoge ohne Eingabefelder, `role=alert`, `role=alertdialog`, oder `messageSelectors`; `role=status` (Toasts, Snackbars) nur als Hinweis | wie `web` | modale Dialoge, `messageSelectors`, dazu ExtJS-Dialoge und Toasts |
| Stack-Herkunft | oberster Eintrag | oberster außerhalb von `react-dom`, `@vue/*`, `@angular/*`, `zone.js` | oberster Eintrag außerhalb von `ext-*.js` |

Für alle gilt:

- **Quellkarten:** Ein Skriptfehler zeigt auf den Quellcode, wenn die Anwendung Quellkarten ausliefert (Vite im Dev-Modus immer, Builds mit `sourcemap`): `src/screens/GroupsScreen.tsx:190:15` statt `index-3f9a.js:1:48211`. Geladen wird nur vom Origin des Skripts und nur von Hosts der Sperre.
- **Routenwechsel:** Bricht ein Single-Page-Router beim Wechsel der Route offene Requests ab (bis 1 s davor oder 0,5 s danach), gilt das nicht als Fehler der Anwendung, ebenso wenig wie ein Abbruch durch einen Seitenwechsel.
- **Verdeckte Ziele:** Ist ein Ziel nicht klickbar, sagt das Tool, warum: es fehlt, es ist unsichtbar, oder ein Dialog liegt darüber, samt seiner Meldung.
- **Virtualisierte Listen:** Fehlt eine Zeile, rollt die Suche die Liste weiter, bis sie auftaucht.

Für `web` und die SPA-Adapter hilft eine zugängliche Oberfläche: Knöpfe mit Text oder `aria-label`, Felder mit `<label>`, Dialoge mit Titel. Wo das fehlt, macht `data-testid` ein Ziel eindeutig. Sonst bleibt der Index unter gleichen Treffern, und der bricht, sobald sich die Reihenfolge ändert. Erzeugte Klassen und ids (`_ngcontent-…`, CSS-Module-Hashes, `:r1:` aus `useId`) nutzt kein Adapter.

**Dev-Server statt Bundle:** Eine gebündelte Anwendung (Vite, Angular CLI, webpack) testest du lokal direkt gegen ihren Dev-Server, etwa `http://localhost:5173`; das Backend erreicht sie über den Proxy des Dev-Servers, auch ein entferntes. `http` ist nur auf dem eigenen Rechner erlaubt: `localhost`, `127.0.0.1` oder ein Name unter `.localhost` (etwa `app.localhost`, wenn mehrere Anwendungen getrennte Cookies brauchen). Chrome erreicht diese Namen immer über `127.0.0.1`; lauscht der Dev-Server nur auf `::1`, starte ihn mit `--host 127.0.0.1`.

## Anhang: Werkbank, Konsole und Berichtsseite

Was du siehst und drückst, wenn ein Lauf ein Fenster hat, und was er im Terminal ausgibt.

### Die Werkbank

Mit Chat läuft alles auf einer Seite, wie bei Cypress:

- **Oben:** das caw-Logo, dann `/ Projekt / Test` und ein Badge mit dem, was der Lauf tut („Claude Code nimmt auf“, „Prüflauf“, „Entwickeln“); der ganze Satz („Claude Code nimmt morning-errand auf“) steht in seinem Tooltip. Rechts die Fakten in Mono (Umgebung und Rolle nur, wenn das Projekt mehrere hat, eine Produktionsumgebung immer, dein lokaler Build nur unter einem Overlay), eine Status-Pille mit Punkt und Wort („Claude Code arbeitet“, „Du bist dran“, „S3 gescheitert“, „Alle bestanden“), der Chip REC/PLAY/PAUSE und das Menü ⋯.
- **Links:** die Schritte mit ihrem Zustand (läuft, bestanden, gescheitert, nicht erreicht) und ihrer Dauer. Nach der Übergabe bietet ein Schritt, der sich öffnen lässt, „Öffnen bis S3“ an, wenn du auf ihn zeigst (wie F1).
- **Mitte:** die Anwendung in einem iframe, darüber ihre Adresse; auf einer Produktions- oder nur lesenden Umgebung trägt die Adresse ein Badge. Darunter die Zähler, etwa „12 Requests · 1 Konsole“: Ein Klick darauf (oder F2, F3) öffnet Requests (Name, Ausgang, Dauer) und Konsole (Fehler und Warnungen) in einer Schublade. Bei einem Konsolenfehler geht sie von selbst auf; Esc (oder „Esc schließt“ in der Schublade) schließt sie.
- **Rechts:** der Chat mit dem Agenten.
- **Menü ⋯** (auch Strg+K): jede Funktion mit ihrer Taste, in zwei Gruppen. Lauf: Pause (F9), Anwendung neu laden (F5), Lauf abbrechen (Esc) und nach der Übergabe Öffnen… (F1). Ansicht: Requests (F2), Konsole (F3), Schritte ausblenden (F4), Chat ausblenden (F6), Nur Anwendung (F8). Darunter Animationen aus (F10), Einstellungen (Strg+,) und Tastenkürzel (?). Die Pfeiltasten bewegen, Enter wählt, Esc schließt. Die Tasten wirken auch, wenn der Fokus im Chat liegt.
- **Einklappen:** Ein Klick auf den Titel „Schritte“ oder „Chat“ (oder F4, F6) klappt den Bereich zu einer schmalen Leiste ein. Braucht der Chat dich, klappt er von selbst auf.
- **Nur Anwendung:** F8 zeigt nur die Anwendung, mit einer Zeile darüber und „Zurück zur Werkbank F8“. **Chat** in dieser Zeile (Strg+J, auch mit dem Fokus in der Anwendung) blendet denselben Chat schwebend unten rechts über der Anwendung ein, 380 × 520; Esc, Strg+J oder × blenden ihn wieder aus. Ein Punkt an Chat sagt, dass der Agent geschrieben hat, während er ausgeblendet war. Eine Entscheidung oder das Laufende blendet ihn von selbst ein, damit der Countdown zum Schließen nie ungesehen abläuft. Die Zeile nennt auch, wer antwortet, wenn deine Session verbunden ist („Claude Code verbunden · k7f2“). Das Fenster merkt sich die Wahl, bis es schließt; ein neuer Lauf beginnt mit ausgeblendetem Chat.
- **Neu laden:** F5 (auch Strg+R, in der Anwendung und im Chat, ⋯ → Anwendung neu laden oder `/reload` im Chat) lädt nach der Übergabe die aktuelle Seite ohne Cache neu; Chat und Schritte bleiben. Solange der Test läuft, auch während „Neu öffnen“ oder F1 einen Zustand herstellt, ist das gesperrt und der Menüeintrag ausgegraut: Ein Neuladen würde den Zustand für die folgenden Schritte verfälschen. Lädt jemand die ganze Werkbank über den Browser neu, baut caw sie wieder auf; lief gerade der Test, bricht er ohne Ergebnis ab.

### Einstellungen

Strg+, (oder ⋯ → Einstellungen, `/settings` im Chat) macht aus der Werkbank ihre Einstellungsseite; Esc oder „Zurück zum Lauf“ führt zurück. Die Seite gehört dir, gilt für jedes Projekt und nennt die `prefs.json`, in die sie speichert. Sie ändert nur, wie die Werkbank aussieht; alles andere zeigt sie nur lesend:

- **Allgemein:** Erscheinungsbild System, Hell oder Dunkel, sofort in Werkbank und Chat (System folgt deinem Betriebssystem, bis du Hell oder Dunkel wählst); Animationen (F10); die Sprache mit ihrer Herkunft (`CAW_LANG`, `prefs.json`, `caw.config.json` oder das System), nur lesend. Aufteilung: ob Schrittliste (F4) und Chat (F6) offen sind, wenn ein Lauf beginnt.
- **Agent:** „Fragen, bevor Claude Code Token verbraucht“, nur lesend: „Nicht mehr fragen“ im Hinweis schaltet es aus, `tokenNotice` aus `prefs.json` zu entfernen bringt ihn zurück. Die Werkbank kann es nicht ändern, weil sie ihren Ursprung mit der getesteten Anwendung teilt. Mit einem Agenten der Agent dieses Laufs (aus `--agent` oder der Config).
- **Notizen für Claude Code:** deine eigene `caw.md` und die `caw/caw.md` des Projekts, jede mit Pfad und Zahl der Zeilen, nie mit ihrem Inhalt; „Pfad kopieren“ kopiert deinen.
- **Tastatur:** die Tasten unten.
- **Dieser Lauf**, nur lesend: Projekt, Umgebung mit ihren Schaltern (Agent erlaubt, beschreibbar, Produktion), Rolle, Code und Version.

Hell und dunkel: Werkbank, Chat, Berichtsseite und die Karte „caw explore“ folgen deinem System, solange du keinen Modus festlegst; die Wahl steht als `mode` in `prefs.json` (`system`, `light` oder `dark`).

### Tastatur

| Taste | Was sie tut |
|---|---|
| F1 | Öffnen… einen Test oder Schritt (nach der Übergabe) |
| F2, F3 | Requests, Konsole |
| F4, F6 | Schritte, Chat ein- oder ausklappen |
| F5 | Die Anwendung ohne Cache neu laden (nach der Übergabe) |
| F7 | Zielbild über der App ein und aus (`open … --design`) |
| F8 | Nur Anwendung und zurück |
| Strg+J | In Nur Anwendung: Chat über der Anwendung ein- oder ausblenden |
| F9 | Den Agenten anhalten oder weitermachen lassen |
| F10 | Animationen aus oder an |
| Esc | Schließt das offene Menü, den Dialog, die Einstellungen oder die Schublade, bricht das Wählen eines Elements ab; sonst fragt es den Abbruch des Laufs an, ein zweites Esc innerhalb von 4 Sekunden bestätigt |
| Strg+K | Das Menü ⋯ |
| Strg+, | Einstellungen |
| ? | Tastenkürzel (nicht beim Tippen) |
| Strg+↵ | Chat: die Hauptaktion, solange das Eingabefeld leer ist (Cmd+↵ auf dem Mac) |
| Alt+↵ | Chat: schickt deinen Text als Prüfpunkt, während du vorführst |
| / | Chat: die Befehle, am Anfang des Eingabefelds |

F11 und F12 bleiben bei Chrome. Die DevTools-Konsole beginnt in der Werkbank, nicht in der App; Rechtsklick → Untersuchen in der App stellt sie auf den App-Frame. In der Werkbank und im App-Frame hält `caw` Werkzeuge bereit (`caw.help()` listet sie):

| | |
|---|---|
| `caw.app` | Das Fenster der App: `caw.app.fetch('/api/…')`, `caw.app.document.title` |
| `caw.info` | Projekt, Test, laufender Schritt, Modus, Lauf-Ordner, Umgebung, URL, Rolle, Framework, Version. Nur Namen, nie Passwörter |
| `caw.requests()`, `caw.console()` | Die Listen hinter den Zählern in der Fußzeile |
| `caw.locator(el)` | Der Locator, den caw für ein Element aufnehmen würde, etwa `await caw.locator($0)` nach Untersuchen |
| `caw.ready()` | Die Bereit-Prüfung des Frameworks und die offenen Requests, jetzt |

Die App teilt ihren Ursprung mit der Werkbank und kann `caw` ebenfalls lesen; deshalb steht darin nichts Geheimes, und nichts davon ändert den Lauf.

Die Werkbank liegt unter der Adresse der Anwendung selbst, auf ihrem Origin. Viele Anwendungen greifen auf das oberste Fenster zu (`top.Ext`, `parent.config`, `top.location.href`), weil sie sich im Portal dafür halten. In der Werkbank geht das genauso:

- **Gleicher Origin:** Der Browser blockt solche Zugriffe nicht.
- **Globale Namen:** Die Werkbank reicht globale Namen der Anwendung durch, die sie selbst nicht hat. `top.Ext` ist also das `Ext` der Anwendung.
- **Adresse:** Die Adresse der Werkbank folgt der Anwendung, `top.location.href` stimmt.
- **Navigation:** Lenkt die Anwendung das oberste Fenster um (`top.location = …`, Formular mit `target="_top"`, auch per POST), landet die Seite in der Anwendung, und die Werkbank bleibt. Ein laufender Test geht weiter; nur dein Neuladen (F5, Knopf des Browsers) macht ihn ungültig.

Ausgeliefert wird die Werkbank vom Tool: Abgefangen wird nur das Dokument des obersten Fensters, kein anderer Request. Damit sich die Anwendung einbetten lässt, entfernt der Testbrowser bei den Dokumenten ihrer Hosts `X-Frame-Options` und `frame-ancestors` aus der CSP, nur in diesem Browser.

Der Chat liegt in einem abgeschotteten iframe mit eigenem Origin (`sandbox` ohne `allow-same-origin`). Die Anwendung erreicht weder sein DOM noch kann sie dort als Mensch entscheiden. Weil sie den Origin der Werkbank teilt, kann sie die Sandbox des iframes entfernen oder ihn neu laden; das Tool schreibt den Chat nur in ein Dokument mit opakem Origin und prüft das in einem Skript, das die Seite nicht anfassen kann. Wurde der Chat-Rahmen neu geladen oder hat er seine Sandbox verloren, endet der Lauf mit `chat-tampered`. Meldungen von Werkbank und Chat zählen nie als Fehler der Anwendung.

**Mit Chat immer die Werkbank.** Ohne Chat (`--no-chat`, CI, `--headless`) läuft die Anwendung allein im eigenen Fenster.

**Grenzen:**

- iframes innerhalb der Anwendung, deren Host nicht freigeschaltet ist, bleiben leer.
- Was eine Seite nur oben im Fenster tut (`window.top`-Prüfungen, Frame-Busting per Skript), kann im iframe anders laufen. Solche Prüfungen gehören in der Testumgebung abgeschaltet.
- Die Werkbank liefert caw selbst aus, deshalb hält Chrome sie für eine öffentliche Seite, und seine Prüfung auf private Netze (Local Network Access) würde die Anwendung im Intranet oder auf diesem Rechner sperren. Der Testbrowser erteilt diese Berechtigung nur dem Origin der Anwendung.

### Der Chat

In der Werkbank rechts, auch in einem Testlauf ohne den Agenten. Der Verlauf wandert über die Werkbänke von Vorführung, Agent und Prüflauf mit. Dort läuft auch das Log des Agenten mit: Text als Nachricht, Befehle als aufklappbare Aktionen. Das Fenster ist die einzige Quelle für Anweisungen, die Seite der Anwendung erreicht den Chat nicht. Die Mitschrift liegt als `chat.log` im Lauf-Ordner.

- **Dein Kontext auf der Freigabekarte:** Jede Nachricht, die du beim Vorführen oder Beschreiben geschrieben hast, steht mit einer Markierung (✎) auf der Karte, zusammen mit dem, was der Agent daraus gemacht hat: Hinweis eines Schritts, seine Wiederholung, Notizen des Tests oder „nur für diese Aufnahme“. Der Agent muss jede davon zuordnen; ein Plan, der eine auslässt, wird abgelehnt.
- **Vorführen:** Klicks, Doppelklicks, Feldänderungen, aus `caw/fixtures` gewählte Dateien und die Tasten Enter, Tab, Escape und die Pfeiltasten werden mitgeschnitten (Pfeile nicht in einer nativen Auswahlliste, deren Wahl als Feldänderung ankommt). Eine Nachricht gibt dem Agenten Kontext an dieser Stelle des Wegs. Alt+↵ (oder `/checkpoint` vor dem Text) schickt sie stattdessen als Prüfpunkt: einen künftigen Schritt mit Screenshot an dieser Stelle; tippe dafür zuerst, was zu sehen sein soll. „Vorführung beenden“, die Hauptaktion über dem Eingabefeld, beendet die Vorführung. Solange sie läuft, steht über der Anwendung „● AUFNAHME – deine Klicks zählen“. Passwortfelder verlassen die Seite nie. Alle anderen Eingaben gehen an den Agenten und landen in der Aufzeichnung, führe also nur Testdaten vor.
- **Nachricht schreiben:** Der Agent liest sie vor der nächsten Aktion, denn solange lehnt das Tool jeden Browserbefehl ab. Denkt der Agent gerade, dauert das etwas.
- **Pause:** Solange der Agent arbeitet, steht „Pause F9“ in der Statuszeile über dem Eingabefeld (auch F9 oder `/pause`). Der Agent hält vor der nächsten Aktion an, die Status-Pille zeigt es. Danach kannst du schreiben und in der Anwendung klicken, bis du „Weiter“ drückst. Deine Klicks kommen in den Test, darum erst klicken, wenn „Pausiert“ dasteht.
- **Hauptaktion:** Das, was als Nächstes zu tun ist („Fertig“, „Plan freigeben“, „Vorführung beenden“, „An Claude Code übergeben“, „Weiter“), steht in voller Breite über dem Eingabefeld; Strg+↵ löst es aus, solange das Feld leer ist.
- **Befehle:** `/` am Anfang des Eingabefelds öffnet die Befehle: `/element`, `/checkpoint`, `/pause`, `/open`, `/requests`, `/console`, `/reload`, `/app`, `/settings`, `/keys`, `/cancel`, jeder mit seiner Taste. Pfeiltasten und Enter wählen, Tab ergänzt, Esc schließt; ein Befehl, der gerade nicht geht, ist ausgegraut. `/open`, `/requests`, `/console`, `/app`, `/settings` und `/keys` öffnen diese Ansicht in der Werkbank, wie ihre Tasten.
- **Karten:** Plan, Rückfrage, Empfehlung (bei einer Code-Änderung mit dem Unterschied), Fehler, Entscheidung und der Hinweis auf Token kommen als Karten. Jede Karte hat eine Hauptaktion; eine weitere Wahl steht daneben, mehr liegen hinter „Mehr“.
- **Element markieren:** In Vorführung, Plan, Pause, Rückfrage und beim Fehler klären wählt `/element` das Bauteil, auf das du dich beziehst: Ein Ring mit Beschriftung (Rolle und Name, etwa `button "Add todo" in dialog "New todo"`) zeigt, was ein Klick wählen würde, und ein Band oben in der Anwendung sagt, dass der Klick dort nichts auslöst und Esc abbricht. Der Klick kommt nicht in die Aufzeichnung. Das Element erscheint als Chip über dem Eingabefeld (× entfernt es) und hängt an deiner nächsten Nachricht; der Agent bekommt seine Beschreibung.
- **Rückfragen:** Der Agent fragt per `ask-operator`. Deine Antwort oder „Fertig“ gibt den Lauf frei.
- **Schritt zurück:** Eine Rückspultaste gibt es nicht. Sag dem Agenten, was falsch war: Er geht zum passenden Zustand und streicht den Umweg mit `omit`. Abgeschicktes bleibt in der Anwendung, dann hilft nur ein neuer Lauf.
- **Abbrechen:** Esc (oder `/cancel`, ⋯ → Lauf abbrechen) fragt „Wirklich abbrechen? (Esc)“; ein zweites Esc oder ein Klick darauf innerhalb von 4 Sekunden bestätigt und beendet alles sofort mit `error`. Den Chat zu schließen wirkt genauso, ohne ihn gibt es weder Freigabe noch Entscheidung.

Die Zeit für den Menschen zählt zum Limit des Agenten, darum ist der Standard hier 60 Minuten (`--agent-timeout 60m`).

### Konsolenausgabe

Im Terminal liest sich ein Lauf wie die Werkbank: der Kopf mit der Version, der Modus fett, was caw gerade tut, dann die Linie „Run“ mit einer Zeile je Schritt und seiner Dauer, der Grund unter einem gescheiterten Schritt, die Zusammenfassung, der Bericht und was als Nächstes zu tun ist (hier ein englischer Lauf):

```
● caw · Context-Aware Web Testing · <version>
  › Mode on local (team language en): no window and no chat (--headless); learns: no.
Replay without Claude Code · first-errand on local as user · team language en
Code: dev server localhost:4874, your current version

  › Opening Chrome and signing in ...
  › Replaying the recording (19 steps, recorded on local) ...
    ›  1/19 click button "New todo" +0.0s
    …

Run ────────────────────────────────────────────────
  ✓ S1  Add a todo     4.0s
  ✓ S2  Find it        1.5s
  ✕ S3  Tick it off   32.1s
      └ Not met after 30 s: …
  ○ S4  Plan it      not reached

Failed. 2 of 4 steps passed. · 39.9s
report  .caw/runs/<run>/report.md
        file:///…/report.md
next    S3 failed. Find the cause: caw run first-errand --env local in the terminal, …
        Up to the entry of the step: caw open first-errand@S3 --env local
```

Die Zeichen sind ✓ bestanden, ✕ gescheitert, ! Warnung und ○ nicht erreicht. In Dateien und Pipes bleiben es schlichte Zeilen mit `[caw]` davor, mit `Report:` vor dem Pfad des Berichts. `NO_COLOR` schaltet die Farben ab, `FORCE_COLOR` erzwingt sie.

### Die Berichtsseite

„Bericht öffnen“ auf der Abschlusskarte öffnet `report.md` als Seite in einem neuen Tab desselben Browsers, in deinem hellen oder dunklen Modus. Oben Logo, „Bericht“ und der Pfad; dann der Titel mit einem Badge (bestanden, gescheitert, Fehler oder das Urteil einer Nachstellung), die Zeilen darunter, Kacheln für bestanden, fehlgeschlagen, nicht erreicht und schreibende Aufrufe, und die Schritte mit ihren Badges. Harte Fehler und Warnungen sind Listen mit Symbolen, schreibende Aufrufe stehen in Mono, und Screenshots, auf die der Bericht verweist, erscheinen als Vorschaubilder. Nur lesende Läufe, Gründe und Hinweise sind Banner. Die Seite zeigt nur, was in `report.md` steht; die Datei selbst bleibt unverändert.
