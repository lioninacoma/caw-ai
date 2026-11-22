// Texts: cli (de). Keys prefixed with "cli.".
export default {
    // bin/caw.mjs and help.mjs: help, one block per command. caw --help shows all blocks, caw <command> --help only its own.
    'cli.help.intro': `caw - Context-Aware Web Testing
End-to-End-Regressionstests für deine Webanwendung: Schritte in Alltagssprache, einmal mit {agent} oder per
Vorführung aufgenommen, mit Playwright lokal und in CI ohne KI abgespielt.

Einrichten (im Projektordner, die Anwendung läuft):
  npx caw init --url http://localhost:5173       im Fenster einmal anmelden; schreibt caw.config.json, caw/.env.example
                                                 und .mcp.json; caw/.env und was TODO bleibt, selbst eintragen
  npx caw doctor                                 bis nichts mehr FEHLT

Befehle:`,
    'cli.help.init': `  init [--url <adresse>]                 Projekt einrichten: sieht die Anwendung an (du meldest dich im Fenster an), schreibt
                                         Config und .mcp.json; ohne --url fragt es nach der Adresse
      [--explore-only]                   nur die Anwendung ansehen: Vorschläge in caw/.explore.json, keine Config
      [--env <name>]                     Name der Umgebung (Standard: local auf diesem Rechner, sonst der erste Teil
                                         des Hostnamens)
      [--language <kürzel>]              Teamsprache für Pläne und Texte von {agent} (Standard: die der Anwendung, gefragt)
      [--login | --no-login]             die Frage nach der Anmeldung vorab beantworten (Skripte)
      [--insecure-tls]                   selbstsignierte Zertifikate annehmen; an der Umgebung gespeichert
      [--allow-http]                     unverschlüsseltes http zu einem anderen Rechner erlauben; an der Umgebung gespeichert
      [--yes]                            ohne Anmeldung und ohne Fragen
      [--from <datei>]                   ein vorhandenes Ergebnis von --explore-only übernehmen
      [--no-mcp]                         ohne Eintrag in .mcp.json
      [--offline]                        ohne die Anwendung anzusehen: Vorlage mit TODO in der Anmeldung (auch ohne
                                         Terminal und --url)`,
    'cli.help.record': `  record <test> [--env <name>]           Testplan aufnehmen oder Aufnahme ersetzen, mit {agent} im Chat; nur auf
                                         Umgebungen, auf denen {agent} arbeiten darf{here}
  record <test>@<S4>                     Ab S4 bis zum Ende neu aufnehmen: Die Schritte davor laufen ohne {agent}, dann folgt
                                         {agent} dem alten Plan ab S4, du lenkst im Chat. Ab S4 darf sich der Plan ändern,
                                         die Schritte davor bleiben. @S1 nimmt den ganzen Test auf
      [--role <rolle>]                   Nur beim ersten Mal, nicht mit @<S4>; entfällt, wenn die Config nur eine kennt
      [--read-only]                      Nur beim ersten Mal: Der Test schreibt nicht (writes: false); schreibt er doch,
                                         wird er schreibend
      [--headless]                       Ohne Fenster, für einen Test mit Plan, nicht mit @<S4>: {agent} folgt dem Plan,
                                         caw nimmt nur, was nichts an den Prüfungen ändert; alles andere hält mit Exit 5
                                         an und schreibt nichts
      [--agent-timeout <dauer>]          Zeitlimit für {agent}, Standard 60m
      [--max-actions <n>]                Grenze für Aktionen von {agent}, sonst maxActions aus der Config, sonst 100
      [--step-timeout <dauer>]           Zeitlimit je Schritt im Prüfdurchlauf, Standard 30s
      [--agent local|docker]             wie bei run
      [--attach [<key>]]                 wie bei run
      [--start] [--reset]                wie bei run (--reset nur, wenn angegeben)
      [--overlay[=<teile>]]              wie bei run`,
    'cli.help.run': `  run <test> [--env <name>]              Test ohne KI abspielen. Auf Umgebungen, auf denen {agent} arbeiten darf{here},
                                         steht der Chat daneben: Scheitert ein Schritt, klärst du ihn dort mit {agent}
      [--explain]                        Bei Fehlern oder Warnungen erklärt {agent} von sich aus, kostet Token; nur auf
                                         Umgebungen, auf denen {agent} arbeiten darf
      [--no-chat]                        Ohne Chat und ohne {agent}, wie in CI
      [--headless]                       Ohne Fenster und ohne Chat
      [--learn]                          In CI: fehlende Vergleichswerte und Effekte in caw/recordings/ lernen (außerhalb
                                         von CI tut das jeder Lauf)
      [--strict]                         Offene Schritte (der nicht aufgenommene Rest) lassen den Lauf mit Exit 4
                                         scheitern, statt dass er ohne sie besteht
      [--promote]                        Ein Entwurf aus caw/drafts: Besteht er und auch run --all auf derselben
                                         Umgebung, wandert er nach caw/tests, und der Laufordner bekommt fix-report.md
      [--start]                          Die Umgebung mit ihrem start-Befehl starten, wenn sie nicht antwortet, am Ende
                                         stoppen; mit --overlay auch die lokalen Code-Server der Teile
      [--reset] | [--no-reset]           Der reset der Umgebung läuft einmal vor dem ersten schreibenden Test; --reset
                                         vor dem ersten Test, --no-reset nie
      [--step-timeout <dauer>]           Zeitlimit je Schritt, Standard 30s
      [--agent-timeout <dauer>]          Zeitlimit für {agent} beim Klären und Beheben, Standard 60m
      [--max-actions <n>]                Grenze für Aktionen von {agent} beim Beheben, sonst maxActions aus der Config, sonst 100
      [--agent local|docker]             Wo caw {agent} startet; Standard aus agent.mode der Config (local)
      [--attach [<key>]]                 Stattdessen antwortet deine eigene {agentDash}-Session (nach /caw-attach
                                         dort), ohne zusätzliche Token; <key> wählt eine von mehreren zuhörenden Sessions
      [--overlay[=<teile>]]              Lokalen Code über die ausgelieferte Umgebung legen. Ohne Wert jeder Teil aus
                                         overlay.parts mit seiner Quelle; build oder dev für diese Quelle; <url> für den
                                         einzigen Teil; oder Teile: --overlay=orders,admin:dev. Nur auf overlay.environments
  run <test> <test> … | --all            Mehrere Tests nacheinander, für CI: ohne Chat, am Ende eine Tabelle, Exit-Code des
      [--env <name>]                     schlimmsten Laufs. --all nimmt jeden Test, der die Umgebung nennt
      [--headless]                       Ohne Fenster
      [--report <art>=<datei>]           Ergebnis zusätzlich schreiben: junit (XML), summary (Markdown) oder json;
                                         mehrfach, etwa --report junit=out/junit.xml --report summary=out/summary.md
      [--retry-env <n>]                  Einen Test bis zu n-mal neu laufen lassen, solange er an der Umgebung scheitert
      [--learn] [--strict] [--start] [--reset | --no-reset]  wie bei einem Test; start und reset einmal für die ganze Reihe`,
    'cli.help.open': `  open [<test>[@<S4>]] [--env <name>]    Die Anwendung öffnen, mit Werkbank und Chat. Ohne Test: navigieren,
                                         ausprobieren, mit {agent} entwickeln. Mit <test>: erst abspielen. Mit @<S4>: bis
                                         zum Einstieg in S4 (seine Navigation läuft, Eingaben und Prüfung bleiben offen).
                                         Lernt nichts, schreibt keine Testdatei
      [--design]                         Mit @<S4>: bis einschließlich S4, sein Zielbild neben der App (F7)
      [--role <rolle>]                   Nur ohne Test; nicht nötig, wenn die Config nur eine hat
      [--step-timeout <dauer>]           Zeitlimit je Schritt beim Abspielen, Standard 30s
      [--agent local|docker] [--attach [<key>]] [--agent-timeout <dauer>] [--max-actions <n>]
      [--start] [--reset]                wie bei run (--reset nur, wenn angegeben)
      [--overlay[=<teile>]]              wie bei run`,
    'cli.help.reproduce': `  reproduce "<fehlerbericht>" [--env <name>]  {agent} stellt einen Fehler allein nach, angemeldet mit einer
                                         Testrolle: kein Plan zum Freigeben, keine Entscheidungen. Schreibt einen
                                         Bericht in den Laufordner und einen nachgestellten Fehler als Entwurf nach
                                         caw/drafts, nie nach caw/tests. Nur wo {agent} arbeiten darf{here}, nie auf
                                         Produktion; nur lesend, außer die Umgebung ist writable; keine
                                         Code-Änderungen. Exit 0 nachgestellt, 1 nicht nachgestellt oder unklar
      [--file <datei>] | -               Den Fehlerbericht aus einer Datei oder von stdin
      [--from <test>[@<S4>]]             In einem Zustand eines Tests anfangen: dessen Schritte bis zum Einstieg in
                                         S4, ohne {agent}
      [--role <rolle>]                   Ohne --from; unnötig, wenn die Config nur eine hat
      [--ref <id>]                       Eine ID aus einem anderen Werkzeug (ein Ticket), steht in Bericht, Ergebnis
                                         und Entwurf; caw schlägt sie nie nach
      [--headless]                       Ohne Fenster
      [--agent local|docker] [--attach [<key>]]`,
    'cli.help.list': `  list [<test>]                          Tests mit Umgebungen, Stand der Aufnahme (aufgenommen, veraltet, nicht
                                         aufgenommen) und ob sie schreiben; mit <test> je Schritt eine Zeile`,
    'cli.help.validate': '  validate                               Config und Tests offline prüfen, ohne Browser und ohne {agent} (CI, Pre-Commit)',
    'cli.help.doctor': `  doctor [--agent local|docker]          Node, Chrome, {agent} (local) bzw. Docker und Token (docker), Testnutzer und
                                         Umgebungen prüfen, jeweils mit nächstem Schritt
      [--attach]                         stattdessen: was deine eigene {agentDash}-Session braucht (caw in .mcp.json)
      [--env <name>]                     nur Testnutzer und Adresse dieser Umgebung`,
    'cli.help.skill': `  skill                                  Den {agentDash}-Skill caw-attach schreiben oder aktualisieren
                                         (.claude/skills/caw-attach): Er sagt deiner Session, wann und wie sie mit dir in
                                         einem caw-Fenster arbeitet. Einchecken.`,
    'cli.help.role': `  role [list] [--json]                   Rollen, ob ein Testnutzer gesetzt ist (nie die Werte), und welche Tests sie nutzen
  role add <rolle>                       Die Rolle in die Config und ihre Variablennamen in caw/.env.example eintragen;
                                         den Testnutzer trägst du von Hand in caw/.env (oder CI-Secrets) ein
  role remove <rolle>                    Eine Rolle entfernen, die kein Test nutzt; caw/.env bleibt, ihre Zeilen dort werden genannt
  role login <rolle> --env <name>        Bei signIn vom Typ session: einmal von Hand anmelden (etwa SSO), die Sitzung
                                         landet in caw/.auth/<umgebung>/<rolle>.json`,
    'cli.help.export': `  export <test> [--env <name>]           Den aufgenommenen Test als Playwright-Test, der ohne caw läuft (@playwright/test):
      [--out <ordner>]                   <test>.spec.mjs, caw-support.mjs und playwright.config.mjs, in caw/export/playwright`,
    'cli.help.overlay': `  overlay status [--env <name>]          Ist der lokale Code-Server bereit (url des Teils)? Ohne Browser, startet nichts:
                                         ready, moved (läuft auf anderem Port), down, wrong-app, stale
      [--part <teil>] [--json]           Nicht nötig, wenn overlay.parts nur einen kennt; --json: der Status als eine JSON-Zeile
  overlay check [--env <name>]           Prüft ohne Token, ob das Overlay alles ersetzt, was es soll: lädt die App
                                         headless mit --overlay, je Teil lokal, ausgeliefert oder nicht geladen
      [--part <teil>] [--role <rolle>]   Nicht nötig, wenn overlay.parts nur einen kennt
      [--apply]                          Vorgeschlagene overlay.assetUrlPattern eintragen und erneut prüfen
      [--start]                          start des Teils ausführen, wenn der Server nicht antwortet, danach beenden
      [--json]                           Ergebnis als eine JSON-Zeile (auch in .caw/overlay-check.json)`,
    'cli.help.overlayStartClause': '; mit --overlay auch die lokalen Code-Server der Teile',
    'cli.help.version': '  --version                              Version des Pakets',
    'cli.help.here': ' (hier: {names})',
    'cli.help.footer': `--env <name>: ein Name aus environments, etwa local. Entfällt, wenn die Wahl klar ist: die einzige, die passt, oder bei run
außerhalb von CI die einzige, auf der {agent} arbeiten darf; Produktion nur, wenn genannt.
Dauern mit Einheit: --step-timeout 30s, --agent-timeout 60m.

caw <befehl> --help für Details.
Exit-Codes: 0 pass, 1 fail, 2 error (Umgebung), 3 abgelehnt (Eingabe), 4 Aufnahme nötig.`,
    'cli.help.agent': `caw agent <befehl>: für {agent} während eines Laufs (Sandbox, lokal oder deine Session bei --attach), steuert den
Browser:
  task                                   Auftrag des offenen Laufs anzeigen
  snapshot                               Seitenstruktur mit Referenzen (e1, e2, ...)
  url                                    Aktuelle URL
  click <ziel> [--optional]              Ziel: Referenz, Locator-Code oder CSS-Selektor; --optional: fehlt es, nichts tun
  dblclick <ziel>                        Doppelklick, z. B. eine Tabellenzeile, die per Doppelklick öffnet
  upload <ziel> <datei>...               Dateien aus caw/fixtures (fixtures/brief.pdf) in ein Dateifeld oder die Auswahl
                                         hinter seinem Knopf
  fill <ziel> <text>                     Feld setzen; Auswahlliste: die Option mit diesem Wert oder Text
  type <ziel> <text>                     Zeichenweise tippen
  press <taste>                          Taste drücken, z. B. Enter
  eval <ausdruck>                        JavaScript in der Seite auswerten
  check <S1> <ausdruck>                  Schritt prüfen: Der Ausdruck muss genau true liefern
  screenshot <name.png>                  Screenshot im Agent-Ordner ablegen
  goto <url>                             Zu einem erlaubten Host navigieren
  reload                                 Seite neu laden
  wait-ready [--for <selektor>] [--min-count <n>] [--timeout <dauer>]
                                         Warten, bis die Seite ruhig ist, auf Wunsch bis genug Einträge da sind
  console                                Neue harte Konsolenfehler abholen
  network                                Letzte Requests der Anwendung mit Ausgang und Dauer, ohne Parameterwerte
  plan --file <plan.yaml>                Ablaufplan im Chat vorlegen, wartet auf Freigabe oder Anpassung
  ask-operator "<was fehlt>"             Den Menschen fragen oder um Vorführung bitten, die Schritte kommen in den Test
  remember <name> <ausdruck>             Wert merken, den erst der Lauf erzeugt, z. B. eine Bestellnummer
  chat                                   Nachrichten lesen, wartet während einer Pause und im Gespräch auf den Menschen
  say <text>                             Dem Menschen schreiben, wartet nicht auf Antwort
  recording                              Bisher aufgezeichnete Schritte nummeriert anzeigen
  finish --file <result.json>            Urteil einreichen; aufgezeichnet wird nur mit "omit"
  advise --file <advice.json>            Empfehlungen einreichen, auch beim Beheben; der Mensch entscheidet je Karte`,
    // The synopsis per command, shown below a usage error.
    'cli.synopsis.init': 'caw init [--url <adresse>] [--env <name>] [--language <kürzel>] [--explore-only] [--login | --no-login] [--yes] [--from <datei>] [--offline] [--insecure-tls] [--allow-http] [--no-mcp]',
    'cli.synopsis.export': 'caw export <test> [--env <name>] [--out <ordner>]',
    'cli.synopsis.reproduce': 'caw reproduce "<fehlerbericht>" | --file <datei> | -  [--env <name>] [--role <rolle>] [--from <test>[@<S4>]] [--ref <id>] [--headless] [--agent local|docker] [--attach [<key>]]',
    'cli.reproduceOneSource': 'Den Fehlerbericht entweder als Argument, mit --file oder mit - von stdin, nicht mehrfach.',
    'cli.reproduceBugMissing': 'Welchen Fehler? {caw} reproduce "Nach dem Speichern zeigt die Liste den Eintrag nicht" (oder --file <datei>, oder - für stdin).',
    'cli.reproduceBugLong': 'Der Fehlerbericht ist länger als {max} Zeichen. Kürze ihn auf das, was passiert und was du erwartest.',
    'cli.reproduceBugControl': 'Der Fehlerbericht enthält Steuerzeichen.',
    'cli.reproduceFileMissing': '{file} gibt es nicht oder ist keine Datei.',
    'cli.reproduceNotAllowed': 'caw reproduce läuft nur auf Umgebungen, auf denen {agent} arbeiten darf (agent: true), nie auf Produktion. {target} ist keine solche. Erlaubt: {environments}',
    'cli.reproduceRoles': 'Mehrere Rollen in der Config: --role <rolle> wählt eine ({roles}), oder --from <test> nimmt die Rolle des Tests.',
    'cli.reproduceStart': 'Fehler nachstellen auf {env} als {role} ({writes}).',
    'cli.reproduceWrites': 'Schreiben erlaubt',
    'cli.reproduceReadOnly': 'nur lesend: caw bricht jeden schreibenden Request ab',
    'cli.reproduceVerdict.yes': 'Nachgestellt.',
    'cli.reproduceVerdict.no': 'Nicht nachgestellt.',
    'cli.reproduceVerdict.unclear': 'Unklar, ob der Fehler auftritt.',
    'cli.reproduceRef': '--ref {ref} ist keine Referenz: bis zu 64 Buchstaben, Ziffern und . _ # : / -, z. B. --ref TCK-1234.',
    'cli.reproduceDraft': 'Entwurf eines Tests: {file}. Prüfe ihn, dann nimm ihn rot auf: {record}',
    'cli.synopsis.list': 'caw list [<test>]',
    'cli.synopsis.doctor': 'caw doctor [--agent local|docker | --attach] [--env <name>]',
    'cli.synopsis.skill': 'caw skill',
    'cli.synopsis.role': 'caw role [list [--json] | add <rolle> | remove <rolle> | login <rolle> --env <name>]',
    'cli.synopsis.run': 'caw run <test> [--env <name>]  oder  caw run <test> <test> … | --all [--env <name>] [--agent local|docker | --attach [<key>]]  oder  caw run <draft> --promote [--env <name>]',
    'cli.synopsis.record': 'caw record <test> [--env <name>] [--role <rolle>] [--headless]  oder  caw record <test>@<S4> [--env <name>] [--agent local|docker | --attach [<key>]]',
    'cli.synopsis.open': 'caw open [--env <name>] [--role <rolle>]  oder  caw open <test>[@<S4>] [--design] [--env <name>] [--agent local|docker | --attach [<key>]]',
    'cli.synopsis.overlay': 'caw overlay status|check [--env <name>] [--part <teil>] [--apply] [--start] [--json]',
    'cli.usageLine': 'Aufruf: {synopsis}',
    'cli.errorCode': '(code: {code}, exit {exit})',
    'cli.reportOutside': '--report {kind}={file} muss eine Datei im Projekt nennen.',
    'cli.fromOutside': '{from} liegt nicht im Projekt.',
    'cli.fromMissing': 'nicht gefunden',
    'cli.fromNotJson': 'kein Explore-Ergebnis (JSON)',
    'cli.fromUnreadable': '{from} ist nicht lesbar: {message}',
    'cli.doctorUnknownArg': 'doctor kennt {arg} nicht. Erlaubt: --agent local|docker, --attach, --env <name>',
    'cli.doctorAgentValue': '--agent erwartet local oder docker; für deine eigene Session: --attach.',
    'cli.mcpAgentOnly': 'caw agent mcp startet nur für den Agenten eines Laufs.',
    'cli.unknownCommand': 'Unbekannter Befehl: {command}.{suggestion} Siehe caw --help.',
    'cli.export.usage': 'caw export nimmt einen Test: caw export <test> [--env <name>] [--out <ordner>].',
    'cli.export.unknownArg': 'caw export kennt {arg} nicht.',
    'cli.export.notRecorded': '{test} ist nicht vollständig aufgenommen ({steps}): erst aufnehmen, dann exportieren.',
    'cli.export.stale': '{test} hat veraltete Schritte ({steps}): ab dort mit {caw} record {test}@{from} neu aufnehmen, dann exportieren.',
    'cli.export.todo': 'Die Anmeldung ist noch TODO ({keys}): erst eintragen, dann exportieren.',
    'cli.export.foreignFile': '{file} stammt nicht von caw export: wegräumen oder ein anderes --out wählen.',
    'cli.export.done': '{test} für {env} exportiert: {files}.',
    'cli.export.configKept': '{file} gibt es schon, sie bleibt, wie sie ist.',
    'cli.export.next': 'Mit Playwright ausführen: npm i -D @playwright/test, dann npx playwright test -c {dir} (Bericht: npx playwright show-report {dir}/playwright-report). Testnutzer wie bei caw (CAW_<ROLLE>_USER …), CAW_BASE_URL für eine andere Adresse.',
    'cli.overlayCommandInactive': 'caw overlay ist eine Erweiterung und hier nicht aktiv: Sie braucht einen overlay-Block in caw.config.json. Siehe https://github.com/lioninacoma/caw-ai/blob/main/docs/extensions/overlay.de.md',
    'cli.overlayFlagInactive': '--overlay ist eine Erweiterung und hier nicht aktiv: Sie braucht einen overlay-Block in caw.config.json. Siehe https://github.com/lioninacoma/caw-ai/blob/main/docs/extensions/overlay.de.md',
    'cli.skillCreated': 'Skill geschrieben: {file}. Einchecken; deine {agentDash}-Session nutzt ihn ab dem nächsten Start (oder /reload-plugins).',
    'cli.skillUpdated': 'Skill aktualisiert: {file}.',
    'cli.skillCurrent': 'Skill ist aktuell: {file}.',
    'cli.skillForeign': '{file} gibt es schon, nicht von caw geschrieben; die Datei bleibt, wie sie ist. Verschiebe sie, dann {caw} skill erneut.',
    'cli.unknownAgentCommand': 'Unbekannter Befehl: caw agent {command}.{suggestion} Siehe caw agent --help.',
    'cli.didYouMean': ' Meintest du {name}?',

    // commands.mjs: explore file, config, init
    'cli.notExploreResult': 'Die Datei sieht nicht nach einem Ergebnis von caw init --explore-only aus.',
    'cli.unknownFramework': 'Framework "{framework}" kennt caw nicht ({names}).',
    'cli.initAuthUnknown': 'Anmeldung "{auth}" gibt es bei init nicht (form, session, none).',
    'cli.badRoleName': 'Rolle "{name}": nur Kleinbuchstaben, Ziffern und Bindestrich, mit einem Buchstaben vorn (etwa admin, editor).',
    'cli.mcpInvalid': '.mcp.json ist kein gültiges JSON, den Eintrag für caw bitte von Hand ergänzen (siehe README).',
    'cli.mcpUpdated': '.mcp.json: Der Eintrag caw startet jetzt die installierte Kopie statt npx. {agent} im Projekt neu starten.',
    'cli.initCreated': 'Angelegt: {files}',
    'cli.initAlready': 'Bereits eingerichtet.',
    'cli.initNeedsUrl': 'Aufruf: {caw} init --url <adresse>. init sieht sich die Anwendung zuerst an; du meldest dich im Fenster an.',
    'cli.initUsesExplore': 'Nutze die Vorschläge aus {file}.',
    'cli.envExampleHead': '# Nach caw/.env kopieren (gitignored) und Testkonten mit wenig Rechten eintragen.\n# Der Agent sieht diese Datei nicht, steuert aber einen angemeldeten Browser: Keine persönlichen Konten verwenden.',
    'cli.initTodo': 'Noch einzutragen in caw.config.json: {keys} (von explore nicht gefunden, siehe notes in caw/.explore.json).',
    'cli.initTodoOffline': 'Noch einzutragen in caw.config.json: {keys}. Die Selektoren findet {caw} init --explore-only --url <adresse>, sobald die Anwendung läuft.',
    'cli.doctorTodo': ({ keys, count }) => `${keys} ${count > 1 ? 'stehen' : 'steht'} noch auf TODO`,
    'cli.doctorTodoNext': 'In caw.config.json eintragen: path und Feld-Selektoren von der Anmeldeseite, signedInSelector von der Seite nach der Anmeldung. {caw} init --explore-only --url <adresse> findet sie.',
    'cli.initNext': 'Weiter: {caw} doctor, dann den ersten Test aufnehmen: {caw} record <test> --env {target}.',
    'cli.askEnv': 'Name dieser Umgebung',
    'cli.askLanguage': 'Teamsprache (Pläne und Texte von {agent}), ein Kürzel wie de, en, fr',
    'cli.initEnvBad': 'Umgebung "{env}": Kleinbuchstaben, Ziffern und -, mit einem Buchstaben vorn, höchstens 32 Zeichen.',
    'cli.initLanguageBad': 'Teamsprache "{language}": ein Sprachkürzel wie de, en oder fr.',
    'cli.initNeedsAllowHttp': '{host} ist unverschlüsseltes http und nicht auf diesem Rechner: --allow-http angeben, wenn das wirklich gewollt ist (alles, auch die Anmeldung, geht unverschlüsselt übers Netz).',
    'cli.initProductionLike': 'Die Umgebung {env} sieht nach Produktion aus: mit production: true geschrieben, caw schreibt dort nie und {agent} arbeitet dort nicht. Mit --env umbenennen, wenn es keine Produktion ist.',
    'cli.initNextExplore': ' Ohne passende Selektoren erst {caw} init --explore-only --url <adresse>.',
    'cli.initOfflineFallback': 'Kein Terminal und keine --url: init schreibt die Vorlage, die Anmeldung bleibt TODO. Später: {caw} init --explore-only --url <adresse>.',
    'cli.contextTemplate': '# Notizen für {agent}\n\nWas {agent} in jedem Test wissen sollte, aber nicht im Code sieht. Keine personenbezogenen Daten.\n\n- Beispiel: Die Suche merkt sich die letzte Eingabe. Erst „Filter löschen“ klicken.\n',

    // commands.mjs: init dialog
    'cli.askUrl': 'Adresse der lokalen Umgebung',
    'cli.askUrlProtocol': 'Bitte eine Adresse mit http:// oder https://.',
    'cli.askUrlInvalid': 'Das ist keine Adresse, etwa http://localhost:5173.',
    'cli.askRoles': 'Rollen, durch Komma getrennt',
    'cli.askRolesBad': '"{name}": nur Kleinbuchstaben, Ziffern und Bindestrich, etwa admin, editor.',

    // commands.mjs: auth
    'cli.authUsage': 'Aufruf: {caw} role login <rolle> --env <umgebung>',
    'cli.authStorageOnly': 'caw role login gibt es nur, wo die Anmeldung vom Typ session ist; auf {target} ist sie {type}.',
    'cli.authRoleUnknown': 'Rolle {role} steht nicht in roles ({roles}).',
    'cli.targetProduction': '{target} ist Produktion.',
    'cli.authSignIn': 'Melde dich im Chrome-Fenster als {role} an. Sobald {selector} erscheint, speichert caw die Sitzung.',
    'cli.authClosed': 'Fenster geschlossen, nichts gespeichert.',
    'cli.authSaved': 'Gespeichert: {file}. Die Datei enthält Anmelde-Cookies und gehört nicht ins Repository.',
    'cli.authIgnored': '{dir} in .gitignore eingetragen: Gespeicherte Sitzungen gehören nicht ins Repository.',

    // commands.mjs: validate
    'cli.validateChain': '{file}: {chain}, neu aufnehmen.',
    'cli.validateNotRecorded': '{file}: noch nicht aufgenommen.',
    'cli.validatePending': '{file}: {ids} offen, noch nicht aufgenommen (run besteht ohne sie, --strict nicht).',
    'cli.validateOk': '{config} und {count} Test(s) sind gültig.',
    'cli.validateCode': '{id} ({target}): {code}',
    'cli.validateCodeOverlay': '{id} ({target}): {code}; mit --overlay: {overlay}',
    'cli.validateCodeOverlayChoose': '{id} ({target}): {code}; mit --overlay build bzw. dev: {overlay}',
    'cli.validateTodo': '{key} ist noch TODO: {what}',
    'cli.validateTodo.path': 'trage den Pfad der Anmeldeseite ein, etwa "/login"',
    'cli.validateTodo.userSelector': 'trage den CSS-Selektor des Benutzerfelds ein',
    'cli.validateTodo.passwordSelector': 'trage den CSS-Selektor des Passwortfelds ein',
    'cli.validateTodo.submitSelector': 'trage den CSS-Selektor des Anmeldeknopfs ein oder lass das Feld weg (dann sendet Enter)',
    'cli.validateTodo.codeSelector': 'trage den CSS-Selektor des Felds für den Einmalcode ein',
    'cli.validateTodo.signedInSelector': 'trage einen CSS-Selektor ein, den es nur angemeldet gibt, etwa das Benutzermenü',

    // commands.mjs: list
    'cli.listNone': 'Noch keine Tests in {dir}. Den ersten nimmt {caw} record <test> auf.',
    'cli.listHead': 'Test|Umgebungen|Aufnahme|Daten',
    'cli.listRecorded': 'aufgenommen',
    'cli.listStale': 'veraltet ({ids})',
    'cli.listNotRecorded': 'nicht aufgenommen',
    'cli.listPending': 'offen ({ids})',
    'cli.listInvalid': 'ungültig',
    'cli.listWrites': 'schreibt',
    'cli.listReadOnly': 'liest nur',
    'cli.listStepRecorded': 'aufgenommen',
    'cli.listStepStale': 'veraltet',
    'cli.listStepNotRecorded': 'nicht aufgenommen',
    'cli.listStepPending': 'offen',
    'cli.listTestHead': '{test}: Start {start}, Rolle {role}, Umgebungen {environments}, {writes}',
    'cli.knownTests': 'Bekannte Tests: {tests}.',
    'cli.noTests': 'In caw/tests gibt es noch keine Tests.',
    'cli.knownSteps': 'Schritte: {steps}.',

    // commands.mjs: sandbox, run, record, open
    'cli.imageBuilding': 'Baue das Sandbox-Image (nur beim ersten Lauf und nach Tool-Änderungen) ...',
    'cli.imageBuildFailed': 'Das Sandbox-Image ließ sich nicht bauen (Exit {code}). Fehlt der Registry-Login für {image}?',
    'cli.testMissing': 'Test nicht gefunden: {file}. {known} Neu aufnehmen: {hint}',
    'cli.testMissingNear': 'Test nicht gefunden: {file}. Meintest du {name}? {known} Einen neuen Test unter diesem Namen nimmt auf: {hint}',
    'cli.envChosen': 'Umgebung: {env} ({why})',
    'cli.envWhyTest': 'einzige Umgebung von {test}',
    'cli.envWhyTests': 'einzige Umgebung der Tests',
    'cli.envWhyNew': 'einzige Umgebung, auf der {agent} arbeiten darf',
    'cli.envWhyOnlyClaude': 'die einzige, auf der {agent} arbeiten darf',
    'cli.validateNowhere': '{id} läuft nirgends: Keine Umgebung passt (ein schreibender Test braucht eine beschreibbare Umgebung)',
    'cli.noEnvironment': 'keiner Umgebung',
    'cli.verbRecord': 'Aufgenommen wird',
    'cli.verbReproduce': 'Nachgestellt wird',
    'cli.agentOnly': '{verb} braucht environments.{environment}.agent: true (zurzeit nur: {environments}).',
    'cli.agentNotInCi': '--agent {agent} geht nicht in CI (Variable CI gesetzt), dort läuft {agent} nur in Docker.',
    'cli.attachUsage': 'caw attach --watch <key> ist für den Monitor deiner Session nach caw_attach; der Schlüssel hat vier Zeichen, etwa k7f2.',
    'cli.attachListening': 'caw: listening as {key}. Each line below is something a caw window wants from you.',
    'cli.attachGone': 'caw: listener {key} is gone (its session ended). Call caw_attach again to listen.',
    'cli.sessionAgent': 'Deine eigene {agentDash}-Session antwortet (--attach): Sie hört von diesem Fenster nach /caw-attach dort.',
    'cli.sessionLabel': 'deine {agentDash}-Session',
    'cli.localAgent': '{agent} läuft lokal ohne Docker, nur mit Lesen und dem Browser-Werkzeug ({agent} {version}). Abgeschottet: agent.mode "docker".',
    'cli.usingDocker': 'Nutze {label}.',
    'cli.tokenMissing': '{hint} {agent} in Docker braucht einen API-Schlüssel aus der Claude Console. Ohne Schlüssel --agent local nutzen: Das läuft mit deiner eigenen {agentDash}-Anmeldung.',
    'cli.and': ' und ',
    'cli.draftMissing': 'Für den neuen Test {id} fehlt {missing}. Aufruf: {hint}',
    'cli.choiceShow': 'Selbst vorführen',
    'cli.choiceDescribe': 'Beschreiben, {agent} nimmt auf',
    'cli.describeNoted': '{id} notiert (Seite {path}). Beschreib weiter oder „{button}“.',
    'cli.describeNothing': 'Noch nichts beschrieben. Schreib, was der Test tun soll, dann „An {agent} übergeben“.',
    'cli.choiceFollow': '{agent} geht dem Testplan nach',
    'cli.choiceReuse': 'Letzte Vorführung verwenden ({time}, {count} Einträge)',
    'cli.recordAborted': 'Die Aufnahme wurde abgebrochen.',
    'cli.questionNew': 'Wie soll {id} entstehen?',
    'cli.questionRecorded': 'Wie soll die neue Aufnahme von {id} entstehen?',
    'cli.questionRecordedWhy': '{id} ist schon aufgenommen. Die Aufnahme wird erst abgelöst, wenn du am Ende zustimmst.',
    'cli.questionDescribed': 'Führst du {id} vor, oder geht {agent} dem Testplan nach?',
    'cli.questionDescribedWhy': '{id} ist beschrieben, aber noch nicht aufgenommen.',
    'cli.demoNote': 'Führe nur Testdaten vor: Deine Eingaben gehen an {agent} und landen in der Aufzeichnung. Passwörter werden nie erfasst.',
    'cli.dialogAsks': 'Die App fragt',
    'cli.dialogSays': 'Die App meldet',
    'cli.dialogLeave': 'Die App fragt vor dem Verlassen der Seite',
    'cli.dialogValue': 'Die App fragt nach einem Wert',
    'cli.dialogPrompt': 'Tipp den Wert hier ein und schick ihn ab, oder wähle OK (behält "{value}") oder Abbrechen.',
    'cli.dialogQuoted': '„{message}“',
    'cli.dialogOk': 'OK',
    'cli.dialogCancel': 'Abbrechen',
    'cli.demoRecorded': 'Aufgezeichnet: {line}',
    'cli.demoFailure': '{label}. Er steht an dieser Stelle in der Aufnahme.',
    'cli.demoNothingFollow': 'Nichts vorgeführt: {agent} geht dem Testplan nach.',
    'cli.demoNothing': 'Noch nichts vorgeführt. Klick dich in der Anwendung durch den Ablauf, dann „Vorführung beenden“.',
    'cli.modeLine': 'Modus auf {env} (Teamsprache {language}): {how}; lernt: {learns}.',
    'cli.modeNoAgent': 'ohne Chat, {agent} darf nur auf {environments} arbeiten',
    'cli.modeHeadless': 'ohne Fenster und ohne Chat (--headless)',
    'cli.modeNoChat': 'ohne Chat (--no-chat)',
    'cli.modeCi': 'ohne Chat, weil die Variable CI gesetzt ist',
    'cli.modeChat': 'mit Chat{advice}',
    'cli.modeLearnsNo': 'nein',
    'cli.modeLearnsYes': 'ja, fehlende Vergleichswerte und Effekte in {file}',
    'cli.modeAdvice': ' und Empfehlungen von {agent} (--explain, kostet Token)',
    'cli.changed': 'Geändert: {files}',
    'cli.changedWhat': '{file} ({what})',
    'cli.changedBaselines': 'Vergleichswerte {ids}',
    'cli.changedEffects': 'Wirkung {ids}',
    'cli.changedSteps': 'Schritte {ids}',
    'cli.changedPlan': 'Testplan',
    'cli.unchanged': 'Testdatei unverändert.',
    'cli.batchStart': '{count} Test(s) auf {target}, nacheinander und ohne Chat{headless}.',
    'cli.batchWindow': ' (ohne Fenster mit --headless)',
    'cli.batchNone': 'Kein Test läuft auf {target}.',
    'cli.batchHeading': ({ count, target }) => `Ergebnis: ${count} ${count === 1 ? 'Test' : 'Tests'} auf ${target}`,
    'cli.batchStatus.pass': 'PASS',
    'cli.batchStatus.fail': 'FAIL',
    'cli.batchStatus.error': 'ERROR',
    'cli.batchStatus.rejected': 'ABGELEHNT',
    'cli.batchStatus.needsRecording': 'AUFNAHME NÖTIG',
    'cli.batchAt': 'bei {step}',
    'cli.batchPending': '{steps} offen',
    'cli.junitWritten': 'JUnit-Bericht: {file}',
    'cli.stepUnknown': '{test} hat keinen Schritt {step}.{suggestion} {steps}',
    'cli.adviseAgentOnly': '--explain nur auf Umgebungen, auf denen {agent} arbeiten darf (hier: {environments}), nicht auf {target}.',
    'cli.ciHandover': '{option} übergibt den Browser an einen Menschen; in CI (Variable CI gesetzt) ist keiner da.',
    'cli.ciNeedsHuman': 'caw {command} braucht einen Menschen im Chat (Vorführung, Plan, Entscheidungen); in CI (Variable CI gesetzt) ist keiner da.',
    'cli.adviseNeedsChat': '--explain braucht den Chat, in CI (Variable CI gesetzt) empfiehlt {agent} nicht.',
    'cli.failedHintAgent': '{step} ist gescheitert. Ursache klären: {caw} run {test} --env {target} im Terminal, der Chat zeigt die Einschätzung und lässt {agent} suchen. Nur wenn sich die Anwendung gewollt geändert hat, ab dort neu aufnehmen: {caw} record {test}@{step} --env {target}',
    'cli.failedHint': '{step} ist gescheitert. Ursache klären im Lauf mit Chat: {caw} run {test} --env {target}',
    'cli.failedHintNoAgent': '{step} ist gescheitert. Die Ursache klärt ein Lauf mit Chat, auf einer Umgebung, auf der {agent} arbeiten darf (hier: {environments}).',
    'cli.untilHint': 'Bis zum Einstieg in den Schritt: {caw} open {test}@{step} --env {target}',
    'cli.pendingSteps': ({ ids, count, test, step, target }) => (count === 1
        ? `Offen, noch nicht aufgenommen: ${ids}. Er lief nicht. Nimm ihn auf: {caw} record ${test}@${step} --env ${target}`
        : `Offen, noch nicht aufgenommen: ${ids}. Sie liefen nicht. Nimm sie auf: {caw} record ${test}@${step} --env ${target}`),
    'cli.recordExists': 'Den Test {test} gibt es schon, seine Metadaten bleiben. --role und --read-only müssen zur Datei passen oder entfallen.',
    'cli.recordHeadless': '{test} auf {env} ohne Fenster aufnehmen: {agent} folgt dem Testplan; caw nimmt nur, was nichts an den Prüfungen ändert (den unveränderten Plan, die Übernahme desselben Plans, den roten Nachweis eines Entwurfs). Alles andere hält den Lauf an, schreibt nichts und endet mit Exit 5.',
    'cli.recordHeadlessPlan': 'record --headless braucht einen Test mit Plan: {file} hat keinen. Ohne Fenster zeigt und beschreibt niemand einen neuen Test; nimm ihn mit Fenster auf: {caw} record {test}.',
    'cli.recordHeadlessStep': 'record --headless nimmt den ganzen Test auf, nicht ab einem Schritt: Niemand würde die Neuaufnahme lenken. Lass @<schritt> weg oder nimm mit Fenster auf.',
    'cli.recordHeadlessOpen': 'Über {id} entscheidet ein Mensch (Optionen: {options}); nichts wurde geschrieben. Siehe {report}, dann mit Fenster aufnehmen:',
    'cli.recordStepUnknown': '{test} hat keinen Schritt {step}.{suggestion} {steps} Einen neuen Schritt trägst du zuerst in {file} ein.',
    'cli.recordFromReason': 'Neu aufnehmen ab {step} ist gewünscht',

    // doctor.mjs
    'cli.doctorNodeOld': 'Node {version} ist zu alt',
    'cli.doctorNodeNext': 'Node {min} oder neuer installieren.',
    'cli.doctorConfigOk': '{file} ist gültig',
    'cli.doctorConfigNextValidate': ({ count }) => (count > 1 ? `{caw} validate zeigt alle ${count} Befunde.` : '{caw} validate zeigt alle Befunde.'),
    'cli.doctorConfigMissing': '{file} fehlt',
    'cli.doctorConfigNextInit': '{caw} init legt sie an.',
    'cli.doctorBrowserOk': 'Browser startet ({browser})',
    'cli.doctorBrowserFail': 'Browser startet nicht ({browser}): {error}',
    'cli.doctorBrowserNext': 'Google Chrome installieren (Stable), caw nutzt das Chrome des Systems; oder in der Config browser.channel bzw. browser.executablePath setzen.',
    'cli.doctorPersonalOk': 'Persönliche Notizen für {agent}: {path} ({lines} Zeilen), gelten in jedem Projekt vor caw/caw.md',
    'cli.doctorPersonalNone': 'Keine persönlichen Notizen für {agent} (optional: {path})',
    'cli.doctorSkillMissing': 'Kein Skill caw-attach für deine {agentDash}-Session ({file})',
    'cli.doctorSkillOld': 'Der Skill caw-attach ist älter als dieses caw ({file})',
    'cli.doctorSkillNext': '{caw} skill schreibt ihn; danach einchecken.',
    'cli.doctorSkillOk': 'Skill caw-attach für deine {agentDash}-Session ({file})',
    'cli.doctorSkillForeign': '{file} gibt es, aber nicht von caw; caw lässt die Datei, wie sie ist',
    'cli.doctorSessionOk': 'Deine {agentDash}-Session übernimmt (Eintrag caw in .mcp.json)',
    'cli.doctorSessionMissing': 'Eintrag caw in .mcp.json fehlt',
    'cli.doctorSessionNpx': 'Der Eintrag caw in .mcp.json startet caw über npx, obwohl caw im Projekt installiert ist',
    'cli.doctorSessionNpxNext': '{caw} init stellt ihn auf die installierte Kopie um; danach {agent} im Projekt neu starten.',
    'cli.doctorSessionNext': 'claude mcp add caw --scope project -- npx caw-ai mcp (oder {caw} init) legt ihn an; danach {agent} im Projekt neu starten.',
    'cli.doctorClaudeOk': '{agent} {version} ({agent} läuft lokal, ohne Docker)',
    'cli.doctorClaudeMissing': '{agent} (claude) ist nicht im PATH',
    'cli.doctorClaudeNext': 'Nur für Läufe mit {agent}: {agent} installieren und einmal anmelden, oder agent.mode "docker".',
    'cli.doctorDockerOk': 'Docker: {label}',
    'cli.doctorDockerNext': 'Nur für record und {agent} im Chat nötig: Docker starten (Linux-Container).',
    'cli.doctorTokenOk': 'Zugang für {agent} in Docker: {name}',
    'cli.doctorTokenMissing': 'Kein Zugang für {agent} in Docker (ANTHROPIC_API_KEY)',
    'cli.doctorTokenNext': 'Nur für Läufe mit {agent} in Docker: einen API-Schlüssel aus der Claude Console als ANTHROPIC_API_KEY setzen. Lokal nutzt {agent} deine {agentDash}-Anmeldung.',
    'cli.doctorIgnoreOk': '.gitignore schützt Läufe, Zugangsdaten und Sitzungen',
    'cli.doctorIgnoreMissing': '.gitignore fehlt: {lines}',
    'cli.doctorIgnoreNext': '{caw} init ergänzt die Einträge.',
    'cli.doctorRoleOk': 'Rolle {name} auf {target}: Testnutzer gesetzt',
    'cli.doctorRoleMissing': ({ name, target, missing, count, file }) => `Rolle ${name} auf ${target}: ${missing} ${count > 1 ? 'fehlen' : 'fehlt'} in ${file}`,
    'cli.doctorRoleNext': 'Die Variablen von Hand in {file} eintragen ({file}.example nennt sie), in CI als Umgebungsvariablen setzen.',
    'cli.doctorGateOk': 'Gate auf {target}: Zugang gesetzt',
    'cli.doctorGateMissing': ({ target, missing, count, file }) => `Gate auf ${target}: ${missing} ${count > 1 ? 'fehlen' : 'fehlt'} in ${file}`,
    'cli.doctorGateNext': 'Trage den Zugang des Basic-Gates in {file} ein (in CI als Umgebungsvariablen).',
    'cli.doctorEnvUnknown': '{file}: {names} gehören zu keiner Rolle und nicht zum Gate (Tippfehler?)',
    'cli.doctorEnvUnknownNext': 'Die Namen sind CAW_<ROLLE>_USER, CAW_<ROLLE>_PASSWORD, CAW_<ROLLE>_TOTP, wahlweise mit __<UMGEBUNG>; Rollen: {roles}',
    'cli.doctorSessionSaved': 'Rolle {name} auf {target}: Sitzung gespeichert',
    'cli.doctorSessionNone': 'Rolle {name} auf {target}: keine Sitzung',
    'cli.doctorReachOk': '{target}: {url} antwortet',
    'cli.doctorReachFail': '{target}: {url} antwortet nicht',
    'cli.doctorReachNext': 'VPN, Dev-Server oder Adresse in environments prüfen.',
    'cli.doctorReachPlaceholder': '{target}: {url} ist ein Platzhalter',
    'cli.doctorReachPlaceholderNext': 'Die echte Adresse in environments eintragen oder die Umgebung entfernen.',
    // overlay-check.mjs
    'cli.overlayCheck.usage': 'overlay kennt status und check, nicht "{sub}".',
    'cli.overlayCheck.unknownArg': 'overlay {sub} kennt {arg} nicht. Erlaubt: {allowed}',
    'cli.overlayCheck.target': 'Welche Umgebung? Nimm --env, zur Wahl: {choices}',
    'cli.overlayCheck.noPart': 'Kein Teil "{part}" in overlay.parts. Nimm --part, zur Wahl: {parts}',
    'cli.overlayCheck.noAppJson': 'Teil {app}: In {dir} liegt keine app.json. Stimmt overlay.parts.{app}.dir?',
    'cli.overlayCheck.noExpected': 'Für {framework} gibt es keine erwartete Liste: Die Prüfung entfällt.',
    'cli.overlayCheck.noDiagnosis': 'Die Sitzung lieferte keine Diagnose des Overlays.',
    'cli.overlayCheck.head': 'Overlay-Prüfung auf {target}, Teil {part}',
    'cli.overlayCheck.part.local': '{label}: lokal',
    'cli.overlayCheck.part.deployed': '{label}: ausgeliefert',
    'cli.overlayCheck.part.not-loaded': '{label}: nicht geladen (vielleicht erst später)',
    'cli.overlayCheck.suggestion': '{source} ({count} Skript(e)): overlay.assetUrlPattern {pattern}',
    'cli.overlayCheck.unresolved': '{source}: kein passendes Muster gefunden, etwa {urls}',
    'cli.overlayCheck.applied': '{count} Muster in overlay.assetUrlPattern eingetragen und erneut geprüft',
    'cli.overlayCheck.command': 'Befehl: {command} (in {dir})',
    'cli.overlayCheck.complete': 'Vollständig: Alles Erwartete kam lokal.',
    'cli.overlayStatus.static.ok': 'static {name}: {path}',
    'cli.overlayStatus.static.missing': 'static {name}: {path} fehlt',
    'cli.overlayStatus.static.outside': 'static {name}: {path} führt aus dem Workspace {boundary} heraus',
    'cli.overlayStatus.static.secret': 'static {name}: {path} ist eine geheime Datei, wird nie ausgeliefert',
    'cli.overlayCheck.static.local': 'static {name}: lokal ({path})',
    'cli.overlayCheck.static.deployed': 'static {name}: kam vom Server; das Asset-Muster ergibt diesen Namen nicht',
    'cli.overlayCheck.static.not-loaded': 'static {name}: von der Seite nicht geladen',
    'cli.overlayCheck.incomplete': 'Unvollständig: {count} Skript(e) kamen vom Server.',
    'cli.overlayCheck.incompleteApply': 'Unvollständig: {count} Skript(e) kamen vom Server. {caw} overlay check --apply trägt die Muster ein.',
    'cli.overlayStatus.ready': 'Lokaler Code für {app} ist bereit: {url}',
    'cli.overlayStatus.readyNoServer': 'Lokaler Code für {app} ist bereit (kein Server nötig)',
    'cli.overlayStatus.moved': 'Der lokale Code-Server von {app} läuft unter {found}, nicht unter {url}. caw nimmt ihn; trage {found} in overlay.parts.{app}.url ein.',
    'cli.doctorOverlayBootstrap': '{target}, Teil {app}: bootstrap.json passt',
    'cli.doctorOverlayBootstrapBad': '{target}, Teil {app}: {problem}',
    'cli.doctorOverlayServerOk': '{target}, Teil {app}: lokaler Code unter {url} liefert {app}',
    'cli.doctorOverlayServerMoved': '{target}, Teil {app}: lokaler Code läuft unter {found}, nicht unter {url}',
    'cli.doctorOverlayServerMovedNext': 'Trage {found} in overlay.parts.{app}.url ein.',
    'cli.doctorOverlayServerDown': '{target}, Teil {app}: lokaler Code unter {url} antwortet nicht',
    'cli.doctorOverlayServerBad': '{target}, Teil {app}: lokaler Code unter {url}: {problem}',
    'cli.doctorOverlayStartNext': 'Starte {start} in {dir}; caw startet ihn nur mit --start.',
    'cli.doctorOverlayStartUnknown': 'Trage den Startbefehl in overlay.parts.{app}.start ein.',
    'cli.doctorOverlayPart': '{target}, Teil {app}: {label} {status} (geprüft {ago})',
    'cli.doctorOverlayStatus.local': 'lokal',
    'cli.doctorOverlayStatus.deployed': 'ausgeliefert',
    'cli.doctorOverlayStatus.not-loaded': 'nicht geladen',
    'cli.doctorOverlayPartNext': '{caw} overlay check zeigt das fehlende Muster, --apply trägt es ein.',
    'cli.doctorOverlayNoCheck': '{target}, Teil {app}: Overlay noch nicht geprüft',
    'cli.doctorOverlayNoCheckNext': '{caw} overlay check --env {target}',
    'cli.doctorMarkOk': 'OK        ',
    'cli.doctorMarkInfo': 'INFO      ',
    'cli.doctorMarkOptional': 'OPTIONAL  ',
    'cli.doctorMarkMissing': 'FEHLT     ',
    'cli.doctorSummary': ({ ok, blocking, optional }) => `${ok} in Ordnung, ${blocking} ${blocking === 1 ? 'fehlt' : 'fehlen'}, ${optional} optional offen`,
    'cli.doctorReadyFirst': 'Bereit. Nächster Schritt: den ersten Test aufnehmen, {caw} record <test> --env <umgebung>.',
    'cli.doctorReady': 'Bereit für caw run.',
    'cli.doctorFixFirst': '{summary}. Erst die mit FEHLT beheben.',

    // explore.mjs
    'cli.exploreWhyState': 'Zustand an html/body, für jedes Konto gleich',
    'cli.exploreWhyLogout': 'Abmelden gibt es nur angemeldet',
    'cli.exploreWhyAccount': 'Benutzer- oder Kontobereich, erst nach der Anmeldung da',
    'cli.exploreWhyLandmark': 'benannte Navigation, auf jeder Seite der angemeldeten Anwendung',
    'cli.exploreWhyFresh': 'erst nach der Anmeldung da',
    'cli.exploreHttp': '{host} ohne https: Die Config erlaubt http nur auf dem eigenen Rechner (localhost, 127.0.0.1, *.localhost). Nimm die https-Adresse.',
    'cli.exploreWhyRuntime': 'zur Laufzeit erkannt',
    'cli.exploreWhyNeutral': 'kein Framework erkannt, neutraler Adapter',
    'cli.exploreWhyPackage': 'aus der package.json',
    'cli.exploreMismatch': 'Laufzeit zeigt {runtime}, die package.json {detected}.',
    'cli.exploreReads': 'Schreibende Requests gesehen: {requests}. Liest einer davon nur (etwa eine Suche per POST), trage ihn in caw.config.json unter reads ein; sonst gelten Tests, die ihn nutzen, als schreibend.',
    'cli.exploreForeign': 'Die Anmeldung ging auf {hosts}, aber keine Seite dort hatte Felder für Benutzername und Passwort, die caw füllen kann. Für SSO: signIn vom Typ session, Sitzung einmal mit {caw} role login speichern; {hosts} kommt in allowHosts.',
    'cli.exploreIdpSteps': 'Die Anmeldung läuft auf {hosts}: Schritte füllen dort Benutzername und Passwort, und {hosts} kommt in allowHosts. Prüfe die Schritte vor dem ersten Lauf.',
    'cli.exploreNoFieldSelector': 'Für Name oder Passwort fand sich kein eindeutiger Selektor; eine data-testid an den Feldern hilft.',
    'cli.exploreNoSignedIn': 'Nach der Anmeldung kam kein neues Element mit stabilem Selektor dazu; signedInSelector bitte von Hand setzen.',
    'cli.exploreNoLogin': 'Kein Anmeldeformular gesehen. Braucht die Anwendung doch eine Anmeldung, explore erneut starten und dabei anmelden.',
    'cli.exploreConsole': 'Konsolenfehler traten schon beim Öffnen auf. Nur übernehmen, was bekanntes Rauschen ist, sonst verdeckt es Fehler.',
    'cli.exploreAskLogin': 'Braucht die Anwendung eine Anmeldung?',
    'cli.exploreOpening': 'Chrome öffnet {host}',
    'cli.exploreOpened': 'Chrome offen auf {host}',
    'cli.exploreStepSignIn': 'Anmelden',
    'cli.exploreSignIn': 'Melde dich im Chrome-Fenster mit einem Testkonto an.',
    'cli.exploreWaitingSignIn': 'Warte auf die Anmeldung',
    'cli.exploreSignedInDone': 'Angemeldet',
    'cli.exploreSignInSkipped': 'Anmeldung übersprungen',
    'cli.exploreStepStart': 'Startseite',
    'cli.exploreGoStart': 'Geh zur Seite, auf der Tests beginnen sollen, und klick unten rechts auf „Fertig“.',
    'cli.exploreWaitingDone': 'Warte auf „Fertig“ im Fenster',
    'cli.exploreStartChosen': 'Startseite gewählt',
    'cli.exploreCardWait': 'Seite lädt',
    'cli.exploreCardSignIn': 'Melde dich mit einem Testkonto an. Ich merke selbst, wann du drin bist.',
    'cli.exploreCardStart': 'Geh zur Seite, auf der Tests beginnen sollen.',
    'cli.exploreCardReading': 'Ich lese die Seite',
    'cli.exploreCardDone': 'Gespeichert. Das Fenster schließt gleich.',
    'cli.exploreCardPage': 'SEITE',
    'cli.exploreCardSaved': 'Gespeichert',
    'cli.exploreDoneButton': 'Fertig',
    'cli.exploreClosed': 'Fenster geschlossen, abgebrochen',
    'cli.exploreReading': 'Lese die Seite zweimal (nur Stabiles zählt)',
    'cli.exploreRead': 'Seite gelesen',
    'cli.exploreStepResult': 'Ergebnis',
    'cli.exploreFoundFramework': 'Framework: {framework}',
    'cli.exploreFoundNoLogin': 'Keine Anmeldung',
    'cli.exploreFoundLogin': 'Anmeldung: {type}',
    'cli.exploreFoundSignedIn': 'Angemeldet erkennbar an {selector} ({why})',
    'cli.exploreFoundStart': 'Startseite: {path}',
    'cli.exploreSavedTo': 'Gespeichert in {file}',
    'cli.exploreLoginNotFound': 'Du sagtest, es gibt eine Anmeldung, aber ich habe kein Anmeldeformular gesehen. Prüfe signIn in der Config.',
    'cli.yesNoDefaultYes': '[J/n]',
    'cli.yesNoDefaultNo': '[j/N]',
    'cli.exploreUsage': 'Aufruf: {caw} init --explore-only --url <adresse>, etwa --url http://app.localhost:5173',
    'cli.exploreNeedsTty': 'explore braucht ein Terminal für die Frage nach der Anmeldung. Ohne Terminal: --yes.',
    'cli.exploreUnreachable': '{url} antwortet nicht. Läuft der Dev-Server, stimmt die Adresse?',
    'cli.exploreNext': 'Weiter: {caw} init übernimmt {file}. Was dort TODO bleibt, trägst du in caw.config.json ein.',

    // ui.mjs
    'cli.uiOn': 'auf',
    'cli.uiLocal': 'lokaler Build',
    'cli.uiDeployed': 'ausgelieferter Stand',
    'cli.uiCode': 'Code: {code}',
    'cli.code.deployed': 'ausgelieferter Stand',
    'cli.code.devServer': 'Dev-Server {host}, dein aktueller Stand',
    'cli.code.overlay': 'Overlay, {details}',
    'cli.code.build': 'Build {dir}',
    'cli.code.built': 'Build {dir}, gebaut {time}, {ago}',
    'cli.code.dev': 'Dev-Server {url}',
    'cli.code.watch': 'Sencha-Watch {url}',
    'cli.code.files': '{count} feste Datei(en) aus statics',
    'cli.code.withStatics': '{text}, dazu {count} aus statics',
    'cli.code.ofPart': '{text} (Teil {part})',
    'cli.code.skipped': 'Teil {part} ausgeliefert (keine Quelle)',
    'cli.code.agoNow': 'gerade eben',
    'cli.code.agoMinutes': 'vor {count} min',
    'cli.code.agoHours': 'vor {count} h',
    'cli.code.agoDays': 'vor {count} Tagen',
    'cli.uiMaxActions': 'bis {count} Browser-Aktionen',
    'cli.uiLanguage': 'Teamsprache {language}',
    'cli.uiWarnings': '{count} Warnung(en) im Bericht.',
    'cli.uiReport': 'Bericht:',
    'cli.uiMoreFailures': 'und {count} weitere im Bericht',
    'cli.uiAs': 'als',
    'cli.uiRun': 'Lauf',
    'cli.uiNotReached': 'nicht erreicht',
    'cli.uiStatus.pass': 'Bestanden.',
    'cli.uiStatus.fail': 'Fehlgeschlagen.',
    'cli.uiReplayedTo': 'Bis {step} abgespielt, um sein Zielbild zu zeigen; weder der Test noch das Zielbild wird hier bewertet.',
    'cli.uiStatus.error': 'Fehler.',
    'cli.uiStepsPassed': ({ passed, total }) => `${passed} von ${total} ${total === 1 ? 'Schritt' : 'Schritten'} bestanden.`,
    'cli.uiWarningCount': ({ count }) => `${count} ${count === 1 ? 'Warnung' : 'Warnungen'}`,
    'cli.uiReportLabel': 'Bericht',
    'cli.uiNextLabel': 'Weiter',
    'cli.roleSynopsis': 'Aufruf: {caw} role [list [--json] | add <rolle> | remove <rolle> | login <rolle> --env <name>]',
    'cli.roleUnknownArg': 'role kennt {arg} nicht. Erlaubt: --env, --json',
    'cli.envFileHead': '# Testnutzer für caw. Nie einchecken.',
    'cli.testUserRoleBad': 'Rolle "{role}": Kleinbuchstaben, Ziffern und Bindestriche, beginnt mit einem Buchstaben, höchstens 32 Zeichen.',
    'cli.roleGitignore': '{file} in .gitignore eingetragen.',
    'cli.roleUnknown': 'Unbekannte Rolle {role}. Bekannt: {roles}',
    'cli.roleInUse': 'Rolle {role} wird noch genutzt von: {tests}',
    'cli.roleNone': 'Noch keine Rollen. {caw} role add <rolle>',
    'cli.roleStateMissing': 'nicht in der Config',
    'cli.roleStateSet': 'Testnutzer gesetzt',
    'cli.roleStateNoUser': 'kein Testnutzer',
    'cli.roleStateNoPassword': 'kein Passwort nötig',
    'cli.roleStateSession': 'Sitzung gespeichert',
    'cli.roleStateNoSession': 'keine Sitzung',
    'cli.roleAddHint': 'Rolle anlegen: {caw} role add {role}',
    'cli.roleLoginHint': 'Sitzung speichern: {caw} role login {role} --env {target}',
    'cli.roleRemoved': 'Rolle {role} aus der Config entfernt.',
    'cli.roleLeftInEnv': 'In {file} stehen noch {names}; lösch die Zeilen selbst, wenn du sie nicht mehr brauchst.',
    'cli.roleFillIn': 'Trag den Testnutzer selbst in {file} ein (oder als CI-Secrets): {names}. caw fragt nie nach den Werten; die Namen stehen auch in caw/.env.example.',
    'cli.roleKnown': 'Rolle {role} steht schon in der Config.',
    'cli.roleAdded': 'Rolle {role} in der Config angelegt.',
    'cli.roleFillHint': 'Testnutzer für {role} auf {target}: {names} selbst in caw/.env eintragen (oder als CI-Secrets).',
    // audit.mjs und git.mjs: caw audit <ref>
    'cli.help.audit': `  audit <ref> [--json]                   Was sich an den Tests geändert hat, seit der Branch von <ref> abging (z. B.
                                         origin/main): nennt jede Abschwächung (Prüfung geändert, obwohl das erwartete
                                         Ergebnis blieb, Test oder Schritt entfernt, Wiederholungen, Wartezeiten,
                                         ignorierte Fehler …) als Markdown für den PR.
                                         Exit 0 nichts abgeschwächt, 1 abgeschwächt, 3 unbekannte Ref oder kein Git`,
    'cli.synopsis.audit': 'caw audit <ref> [--json]',
    'cli.audit.refMissing': 'Nenn den Branch oder Commit zum Vergleich, z. B. {caw} audit origin/main.',
    'cli.audit.unknownArg': 'Unbekanntes Argument für audit: {arg}',
    'cli.audit.gitMissing': 'git wurde nicht gefunden. caw audit braucht Git im PATH.',
    'cli.audit.notRepository': '{root} liegt in keinem Git-Repository; caw audit vergleicht Commits.',
    'cli.audit.badRef': 'Git kennt {ref} nicht. In CI hol es vorher, z. B. git fetch origin main (mit fetch-depth: 0).',
    'cli.audit.noBase': '{ref} und HEAD haben keine gemeinsame Geschichte. In CI hol die ganze Geschichte (fetch-depth: 0).',
    'cli.audit.title': 'caw audit: Tests im Vergleich mit {ref} (Merge-Base {base})',
    'cli.audit.unchanged': 'Kein Test, keine Aufnahme und keine Config geändert.',
    'cli.audit.ok': 'Nichts abgeschwächt.',
    'cli.audit.weakened': ({ count }) => (count === 1
        ? '1 Änderung lässt einen Test bestehen, der vorher fehlgeschlagen wäre. Prüf, ob das gewollt ist; eine Prüfung änderst du bewusst, indem du das erwartete Ergebnis des Schritts änderst.'
        : `${count} Änderungen lassen Tests bestehen, die vorher fehlgeschlagen wären. Prüf, ob das gewollt ist; eine Prüfung änderst du bewusst, indem du das erwartete Ergebnis des Schritts änderst.`),
    'cli.audit.section.weakening': 'Abgeschwächt',
    'cli.audit.section.listed': 'Geändert',
    'cli.audit.section.info': 'Zur Info',
    'cli.audit.decided': 'Außerhalb des Fensters entschieden',
    'cli.audit.decided.intro': 'Antworten in den Läufen dieses Rechners seit der Merge-Basis, die etwas geändert haben, gegeben von caw selbst (auto: ein Lauf ohne Fenster), von der Session oder vom Menschen in der Session (elicitation). Zur Information; sie ändern oben nichts.',
    'cli.audit.decided.item': '{decision}: {option} ({by}), Lauf {run}',
    'cli.audit.decided.known': '; erste Aufnahme, ab jetzt bekannt: {list}',
    'cli.audit.before': 'vorher',
    'cli.audit.after': 'jetzt',
    'cli.audit.kind.test-removed': 'Der Test wurde entfernt.',
    'cli.audit.kind.test-added': 'Neuer Test.',
    'cli.audit.kind.unreadable': '{path} ist nicht lesbar und wurde nicht verglichen; {caw} validate zeigt, warum.',
    'cli.audit.kind.step-removed': '{step} wurde entfernt: „{expect}“ prüft nichts mehr.',
    'cli.audit.kind.step-added': 'Neuer Schritt {step}: „{expect}“.',
    'cli.audit.kind.check-changed': 'Die Prüfung von {step} hat sich geändert, obwohl das erwartete Ergebnis „{expect}“ gleich blieb.',
    'cli.audit.kind.expect-changed': 'Das erwartete Ergebnis von {step} wurde von „{was}“ zu „{expect}“.',
    'cli.audit.kind.expect-changed-check': 'Das erwartete Ergebnis von {step} wurde von „{was}“ zu „{expect}“, und mit ihm die Prüfung.',
    'cli.audit.kind.environments-narrowed': 'Der Test läuft nicht mehr auf {list}.',
    'cli.audit.kind.known-messages-added': 'Jetzt als bekannt akzeptierte Meldungen: {list}.',
    'cli.audit.kind.known-messages-baseline': 'Erste Aufnahme; ihre Basis, ab jetzt bekannt: {list}.',
    'cli.audit.kind.retry-added': '{step} wird jetzt wiederholt, bis zu {times}-mal.',
    'cli.audit.kind.retry-raised': '{step} wird bis zu {times}-mal statt {was}-mal wiederholt.',
    'cli.audit.kind.timeout-raised': 'Die Prüfung von {step} wartet bis zu {now} statt {was}.',
    'cli.audit.kind.action-timeout-raised': 'Aktion {number} von {step} ({action}) wartet bis zu {now} statt {was}.',
    'cli.audit.kind.action-optional': 'Aktion {number} von {step} ({action}) ist jetzt optional: fehlt ihr Ziel, geht der Schritt weiter.',
    'cli.audit.kind.effects-forgotten': 'Die gelernten Effekte von {step} wurden verworfen: bis sie neu gelernt sind, lässt eine anders reagierende Seite den Schritt nicht fehlschlagen.',
    'cli.audit.kind.effects-removed': 'Gelernte Effekte von {step} wurden von Hand entfernt (caw entfernt gelernte Zeilen nie), diese Änderungen fallen nicht mehr auf: {lines}.',
    'cli.audit.kind.effects-replaced': 'Gelernte Effekte von {step} wurden neu gelernt, wie nach „Neue Wirkung übernehmen“: aus {was} wurde {now}.',
    'cli.audit.kind.effects-accepted': 'Konsolenfehler von {step} sind jetzt gelernt und lassen ihn nicht mehr fehlschlagen: {lines}.',
    'cli.audit.kind.baselines-changed': 'Die Request-Baselines von {step} haben sich geändert.',
    'cli.audit.kind.config-console-ignore': 'consoleIgnore ignoriert mehr Konsolenfehler: {list}.',
    'cli.audit.kind.config-foreign-code': 'foreignCode macht Fehler weiterer Skripte zu Warnungen: {list}.',
    'cli.audit.kind.config-reads': 'reads zählt mehr Requests als lesend (sie gehen auch auf Produktion durch): {list}.',
    'cli.audit.kind.config-message-selectors': 'messageSelectors beobachtet nicht mehr: {list}.',
    'cli.audit.kind.config-effects-fail': 'effects.fail lässt einen Schritt nicht mehr fehlschlagen bei: {list}.',
    'cli.audit.kind.config-guarded': 'Geschützte Einstellungen geändert (Befehle, die caw ausführt, was wo laufen darf): {list}.',
    'cli.audit.kind.config-visual-ignore': 'visualIgnore lässt weitere Bereiche aus jedem Look heraus: {list}.',
    'cli.audit.kind.config-ready-ignore': 'readyIgnore wartet nicht mehr darauf, dass weitere Bereiche ruhig werden: {list}.',
    'cli.audit.kind.config-design-fail': 'design.fail lässt einen Schritt nicht mehr fehlschlagen bei: {list}.',
    'cli.audit.kind.action-removed': 'Aktion {number} von {step} ({action}) wurde entfernt: der Schritt führt sie nicht mehr aus.',
    'cli.audit.kind.design-removed': '{step} wird nicht mehr an seinem Zieldesign {file} gemessen.',
    'cli.audit.kind.design-changed': '{step} wird an einem anderen Zieldesign gemessen: {was} → {now}.',
    'cli.audit.kind.design-file-changed': 'Das Zieldesign {file} von {step} wurde geändert oder entfernt: der Schritt wird ab jetzt an etwas anderem gemessen.',
    'cli.audit.kind.look-forgotten': 'Der gelernte Look von {step} wurde verworfen, look: true bleibt: bis er neu gelernt ist, scheitert ein anders aussehender Schritt nicht.',
    'cli.summaryWritten': 'Zusammenfassung: {file}',
    'cli.jsonWritten': 'JSON-Bericht: {file}',
    'cli.modeUrl': 'Adresse aus {variable}: {url}.',
    'cli.retryEnv': '{test}: Versuch {attempt} scheiterte an der Umgebung, er läuft noch einmal.',
    'cli.retriedPass': 'bestanden im {attempt}. Versuch (Umgebung)',
    'cli.retriedOther': 'im {attempt}. Versuch, davor an der Umgebung gescheitert',
    'cli.attemptLine': 'Versuch {attempt}: {status}{why}',
    'cli.summary.heading': 'caw: {count} Test(s) auf {target}, Exit {exit}',
    'cli.summary.columns': 'Ergebnis | Test | Gescheiterter Schritt | Einschätzung | Befund | Bericht',
    'cli.summary.notes': 'Warnungen und Lernstand (sie ändern kein Ergebnis)',
    'cli.reportWarning': 'Warnung: {text}',
    'cli.reportWarningAt': 'Warnung {step}: {text}',
    'cli.reportLearning': 'Effekte noch im Lernen: {steps}.',
    'cli.reportLearnsNot': 'Dieser Lauf hat nichts gelernt (CI ohne --learn).',
    // bisect.mjs: caw bisect <test> --env <name> für git bisect run
    'cli.help.bisect': `  bisect <test> --env <name>             Ein Schritt von git bisect run: startet die Umgebung mit ihrem Startbefehl und
                                         spielt den Test so, wie er in --tests-from steht, ohne Fenster, ohne Chat und
                                         ohne Lernen
      [--tests-from <ref>]               Woher Test, Aufnahme und caw.config.json kommen, Standard refs/bisect/bad
      [--step-timeout <dauer>]           Zeitlimit pro Schritt, Standard 30s
                                         Exit 0 gut, 1 schlecht (ein Schritt scheiterte an der Anwendung), 125
                                         überspringen (Umgebung, Test, unklar, Fehler), 128 bricht git bisect ab
                                         (Aufruf, Test oder Umgebung nicht brauchbar)`,
    'cli.synopsis.bisect': 'caw bisect <test> --env <name> [--tests-from <ref>] [--step-timeout <dauer>]',
    'cli.bisect.envMissing': 'Nenn die Umgebung: {caw} bisect <test> --env <name>. Ihr Startbefehl baut jeden Commit neu.',
    'cli.bisect.noBisect': '{ref} gibt es nicht: Ruf caw bisect aus git bisect run auf (nach git bisect start <schlecht> <gut>) oder nenn mit --tests-from <ref> den Commit mit den Tests, die gelten sollen.',
    'cli.bisect.missingAtRef': '{path} fehlt im Commit von --tests-from.',
    'cli.bisect.noStart': '{env} hat keinen Startbefehl: caw bisect startet die Umgebung auf jedem Commit, damit sie den Code dieses Commits ausführt. Trag environments.{env}.start in caw.config.json ein.',
    'cli.bisect.alreadyRunning': '{env} antwortet unter {url}, bevor caw sie gestartet hat: Das könnte der Build eines beliebigen Commits sein. Halt sie an und starte git bisect run neu.',
    'cli.bisect.line': 'caw bisect {commit}: {result}, Einschätzung {side}, Exit {exit} ({meaning})',
    'cli.bisect.result.pass': 'bestanden',
    'cli.bisect.result.failed': 'gescheitert',
    'cli.bisect.result.failedAt': 'gescheitert bei {step}',
    'cli.bisect.result.error': 'kein Urteil ({code})',
    'cli.bisect.result.notRun': 'nicht gelaufen ({code})',
    'cli.bisect.meaning.good': 'gut',
    'cli.bisect.meaning.bad': 'schlecht',
    'cli.bisect.meaning.skip': 'übersprungen',
    'cli.bisect.meaning.abort': 'git bisect bricht ab',
    'cli.audit.kind.locator-changed': 'Aktion {number} von {step} nutzt ein anderes Element, ihre Prüfung blieb: {was} → {now}.',
    'cli.listDrafts': 'Entwürfe in {dir} (nicht in run --all, bis sie übernommen sind):',
    'cli.listDraftRed': 'rot bei {step} (Lauf {run})',
    'cli.listDraftNotRed': 'aufgenommen, noch nicht rot',
    'cli.validateDrafts': '{count} Entwurf/Entwürfe in {dir} ebenfalls geprüft.',
    'cli.draftGreen': 'Der Entwurf besteht jetzt, auch {step}: Der Fehler ist behoben. Übernimm ihn, sobald auch die anderen Tests bestehen: {caw} run {test} --promote --env {target}',
    'cli.promoteNoDraft': 'Es gibt keinen Entwurf {test} in {dir}. --promote übernimmt einen Entwurf aus caw reproduce nach caw/tests.',
    'cli.promoteExists': '{file} gibt es schon. Benenne den Entwurf oder den Test um; --promote überschreibt nie einen Test.',
    'cli.promoteNotRecorded': '{test} ist nicht ganz aufgenommen: Nimm ihn erst mit {caw} record {test} auf. Nichts übernommen.',
    'cli.promoteNotRed': '{test} war noch nie rot: Ohne den roten Lauf ist nicht belegt, dass der Test den Fehler fängt. Nimm ihn auf, solange der Fehler da ist: {caw} record {test}. Nichts übernommen.',
    'cli.promoteDraftFailed': '{test} besteht noch nicht ({step} ist der Schritt, der den Fehler fängt). Nichts übernommen.',
    'cli.promoteOthersFailed': 'Nicht alle anderen Tests auf {target} haben bestanden. {test} bleibt ein Entwurf, bis sie es tun.',
    'cli.promoted': '{test} übernommen: {files}. Fix-Bericht: {report}',
    'cli.fixReport.title': 'Fix-Bericht: {test}',
    'cli.fixReport.red': 'Rot bei {step}: Lauf {run}, Commit {head}',
    'cli.fixReport.green': 'Grün: Lauf {run}',
    'cli.fixReport.others': '{count} andere(r) Test(s) auf {target} grün',
    'cli.fixReport.changed': 'Geänderte Dateien seit {head} (ohne caw/ und .caw/)',
    'cli.fixReport.changedNone': 'Keine.',
    'cli.fixReport.changedUnknown': 'Unbekannt: Zum roten Lauf ist kein Commit vermerkt, oder git konnte es nicht sagen.',
    'cli.changedLooks': 'Aussehen {ids}',
    'cli.audit.kind.look-adopted': 'Für {step} wurde am {day} ein neuer Look übernommen: seine Stile gelten ab jetzt.',
    'cli.audit.kind.look-on': '{step} lernt und vergleicht jetzt sein Aussehen (look: true).',
    'cli.audit.kind.look-off': '{step} vergleicht sein gelerntes Aussehen nicht mehr (look: true entfernt): Sieht der Schritt anders aus, scheitert er nicht mehr.',
};
