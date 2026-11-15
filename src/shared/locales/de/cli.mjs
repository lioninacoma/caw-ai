// Texts: cli (de). Keys prefixed with "cli.".
export default {
    // bin/caw.mjs and help.mjs: help, one block per command. caw --help shows all blocks, caw <command> --help only its own.
    'cli.help.intro': `caw - Context-Aware Web Testing
End-to-End-Regressionstests für deine Webanwendung: Schritte in Alltagssprache, einmal mit Claude oder per
Vorführung aufgenommen, mit Playwright lokal und in CI ohne KI abgespielt.

Einrichten (im Projektordner, die Anwendung läuft):
  npx caw init --url http://localhost:5173       im Fenster einmal anmelden; schreibt caw.config.json, caw/.env (Testnutzer),
                                                 den Skill und .mcp.json; was TODO bleibt, selbst eintragen
  npx caw doctor                                 bis nichts mehr FEHLT

Befehle:`,
    'cli.help.init': `  init [--url <adresse>]                 Projekt einrichten: sieht die Anwendung an (du meldest dich im Fenster an), schreibt
                                         Config, Skill und .mcp.json; ohne --url fragt es nach der Adresse
      [--explore-only]                   nur die Anwendung ansehen: Vorschläge in caw/.explore.json, keine Config
      [--env <name>]                     Name der Umgebung (Standard: local auf diesem Rechner, sonst der erste Teil
                                         des Hostnamens)
      [--language <kürzel>]              Teamsprache für Pläne und Texte von Claude (Standard: die der Anwendung, gefragt)
      [--login | --no-login]             die Frage nach der Anmeldung vorab beantworten (Skripte)
      [--insecure-tls]                   selbstsignierte Zertifikate annehmen; an der Umgebung gespeichert
      [--allow-http]                     unverschlüsseltes http zu einem anderen Rechner erlauben; an der Umgebung gespeichert
      [--yes]                            ohne Anmeldung und ohne Fragen
      [--from <datei>]                   ein vorhandenes Ergebnis von --explore-only übernehmen
      [--no-mcp]                         ohne Eintrag in .mcp.json
      [--offline]                        ohne die Anwendung anzusehen: Vorlage mit TODO in der Anmeldung (auch ohne
                                         Terminal und --url)`,
    'cli.help.record': `  record <test> [--env <name>]           Testplan aufnehmen oder Aufnahme ersetzen, mit Claude im Chat; nur auf
                                         Umgebungen, auf denen Claude arbeiten darf{here}
  record <test>@<S4>                     Ab S4 bis zum Ende neu aufnehmen: Die Schritte davor laufen ohne Claude, dann folgt
                                         Claude dem alten Plan ab S4, du lenkst im Chat. Ab S4 darf sich der Plan ändern,
                                         die Schritte davor bleiben. @S1 nimmt den ganzen Test auf
      [--role <rolle>]                   Nur beim ersten Mal, nicht mit @<S4>; entfällt, wenn die Config nur eine kennt
      [--read-only]                      Nur beim ersten Mal: Der Test schreibt nicht (writes: false); schreibt er doch,
                                         wird er schreibend
      [--claude-timeout <dauer>]         Zeitlimit für Claude, Standard 60m
      [--max-actions <n>]                Grenze für Aktionen von Claude, sonst maxActions aus der Config, sonst 100
      [--step-timeout <dauer>]           Zeitlimit je Schritt im Prüfdurchlauf, Standard 30s
      [--agent local|docker|session]     wie bei run
      [--start] [--reset]                wie bei run (--reset nur, wenn angegeben)
      [--overlay[=<teile>]]              wie bei run`,
    'cli.help.run': `  run <test> [--env <name>]              Test ohne KI abspielen. Auf Umgebungen, auf denen Claude arbeiten darf{here},
                                         steht der Chat daneben: Scheitert ein Schritt, klärst du ihn dort mit Claude
      [--explain]                        Bei Fehlern oder Warnungen erklärt Claude von sich aus, kostet Token; nur auf
                                         Umgebungen, auf denen Claude arbeiten darf
      [--no-chat]                        Ohne Chat und ohne Claude, wie in CI
      [--headless]                       Ohne Fenster und ohne Chat
      [--learn]                          Fehlende Vergleichswerte und Effekte in caw/recordings/ lernen, in jedem Modus;
                                         ohne die Option ändert ein Lauf von sich aus keine Datei (mit Chat bietet das Ende es an)
      [--start]                          Die Umgebung mit ihrem start-Befehl starten, wenn sie nicht antwortet, am Ende
                                         stoppen; mit --overlay auch die lokalen Code-Server der Teile
      [--reset] | [--no-reset]           Der reset der Umgebung läuft einmal vor dem ersten schreibenden Test; --reset
                                         vor dem ersten Test, --no-reset nie
      [--step-timeout <dauer>]           Zeitlimit je Schritt, Standard 30s
      [--claude-timeout <dauer>]         Zeitlimit für Claude beim Klären und Beheben, Standard 60m
      [--max-actions <n>]                Grenze für Aktionen von Claude beim Beheben, sonst maxActions aus der Config, sonst 100
      [--agent local|docker|session]     Wo Claude arbeitet; Standard aus agent.mode der Config (local). session: deine
                                         Claude-Code-Session übernimmt über ihre caw-Werkzeuge, caw startet keinen Claude
      [--overlay[=<teile>]]              Lokalen Code über die ausgelieferte Umgebung legen. Ohne Wert jeder Teil aus
                                         overlay.parts mit seiner Quelle; build oder dev für diese Quelle; <url> für den
                                         einzigen Teil; oder Teile: --overlay=orders,admin:dev. Nur auf overlay.environments
  run <test> <test> … | --all            Mehrere Tests nacheinander, für CI: ohne Chat, am Ende eine Tabelle, Exit-Code des
      [--env <name>]                     schlimmsten Laufs. --all nimmt jeden Test, der die Umgebung nennt
      [--headless]                       Ohne Fenster
      [--report junit=<datei>]           Ergebnis zusätzlich als JUnit-XML
      [--learn] [--start] [--reset | --no-reset]  wie bei einem Test; start und reset einmal für die ganze Reihe`,
    'cli.help.open': `  open [<test>[@<S4>]] [--env <name>]    Die Anwendung angemeldet öffnen, mit Werkbank und Chat. Ohne Test: navigieren,
                                         ausprobieren, mit Claude entwickeln. Mit <test>: erst abspielen. Mit @<S4>: bis
                                         zum Einstieg in S4 (seine Navigation läuft, Eingaben und Prüfung bleiben offen).
                                         Lernt nichts, schreibt keine Testdatei
      [--role <rolle>]                   Nur ohne Test; nicht nötig, wenn die Config nur eine hat
      [--step-timeout <dauer>]           Zeitlimit je Schritt beim Abspielen, Standard 30s
      [--agent local|docker|session] [--claude-timeout <dauer>] [--max-actions <n>]
      [--start] [--reset]                wie bei run (--reset nur, wenn angegeben)
      [--overlay[=<teile>]]              wie bei run`,
    'cli.help.list': `  list [<test>]                          Tests mit Umgebungen, Stand der Aufnahme (aufgenommen, veraltet, nicht
                                         aufgenommen) und ob sie schreiben; mit <test> je Schritt eine Zeile`,
    'cli.help.validate': '  validate                               Config und Tests offline prüfen, ohne Browser und ohne Claude (CI, Pre-Commit)',
    'cli.help.doctor': `  doctor [--agent local|docker|session]  Node, Chrome, Claude Code (local) bzw. Docker und Token (docker), Testnutzer und
                                         Umgebungen prüfen, jeweils mit nächstem Schritt
      [--env <name>]                     nur Testnutzer und Adresse dieser Umgebung`,
    'cli.help.role': `  role [list] [--json]                   Rollen, ob ein Testnutzer gesetzt ist (nie die Werte), und welche Tests sie nutzen
  role add [<rolle>] [--env <name>]      Im Fenster mit einem Testkonto anmelden und die Rolle benennen; caw schreibt
                                         caw/.env und die Config. „+ Weitere Rolle“ für das nächste Konto
  role remove <rolle>                    Eine Rolle entfernen, die kein Test nutzt, samt ihren Zeilen in caw/.env
  role login <rolle> --env <name>        Bei signIn vom Typ session: einmal von Hand anmelden (etwa SSO), die Sitzung
                                         landet in caw/.auth/<umgebung>/<rolle>.json`,
    'cli.help.theme': `  theme [use <name> | check <name>]      Themes auflisten, eines wählen (gilt für dich, in allen Projekten) oder prüfen:
                                         Schema, Kontrast, Markenbreite, Schriften. Ändern in der Werkbank mit F7`,
    'cli.help.overlay': `  overlay status [--env <name>]          Ist der lokale Code-Server bereit (url of the part)? Ohne Browser, startet nichts:
                                         ready, moved (läuft auf anderem Port), down, wrong-app, stale
      [--part <teil>] [--json]           Nicht nötig, wenn overlay.parts nur einen kennt; --json: der Status als eine JSON-Zeile
  overlay check [--env <name>]           Prüft ohne Token, ob das Overlay alles ersetzt, was es soll: lädt die App
                                         headless mit --overlay, je Teil lokal, ausgeliefert oder nicht geladen
      [--part <teil>] [--role <rolle>]   Nicht nötig, wenn overlay.parts nur einen kennt
      [--apply]                          Vorgeschlagene overlay.assetUrlPattern eintragen und erneut prüfen
      [--start]                          start des Teils ausführen, wenn der Server nicht antwortet, danach beenden
      [--json]                           Ergebnis als eine JSON-Zeile (auch in .caw/overlay-check.json)`,
    'cli.help.skill': `  skill                                  Nur den Skill für Claude Code (und .mcp.json) anlegen oder aktualisieren; danach
                                         richtet Claude Code caw mit dir ein („Richte caw ein“)`,
    'cli.help.version': '  --version                              Version des Pakets',
    'cli.help.here': ' (hier: {names})',
    'cli.help.footer': `--env <name>: ein Name aus environments, etwa local. Entfällt, wenn die Wahl klar ist: die einzige, die passt, oder bei run
außerhalb von CI die einzige, auf der Claude arbeiten darf; Produktion nur, wenn genannt.
Dauern mit Einheit: --step-timeout 30s, --claude-timeout 60m.

caw <befehl> --help für Details.
Exit-Codes: 0 pass, 1 fail, 2 error (Umgebung), 3 abgelehnt (Eingabe), 4 Aufnahme nötig.`,
    'cli.help.agent': `caw agent <befehl>: für Claude während eines Laufs (Sandbox, lokal oder deine Session bei --agent session), steuert den
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
    'cli.synopsis.theme': 'caw theme [use <name> | check <name>]',
    'cli.synopsis.list': 'caw list [<test>]',
    'cli.synopsis.doctor': 'caw doctor [--agent local|docker|session] [--env <name>]',
    'cli.synopsis.role': 'caw role [list [--json] | add [<rolle>] [--env <name>] | remove <rolle> | login <rolle> --env <name>]',
    'cli.synopsis.run': 'caw run <test> [--env <name>]  oder  caw run <test> <test> … | --all [--env <name>]',
    'cli.synopsis.record': 'caw record <test> [--env <name>] [--role <rolle>]  oder  caw record <test>@<S4> [--env <name>]',
    'cli.synopsis.open': 'caw open [--env <name>] [--role <rolle>]  oder  caw open <test>[@<S4>] [--env <name>]',
    'cli.synopsis.overlay': 'caw overlay status|check [--env <name>] [--part <teil>] [--apply] [--start] [--json]',
    'cli.usageLine': 'Aufruf: {synopsis}',
    'cli.errorCode': '(code: {code}, exit {exit})',
    'cli.fromUnreadable': '{from} ist nicht lesbar: {message}',
    'cli.doctorUnknownArg': 'doctor kennt {arg} nicht. Erlaubt: --agent local|docker|session, --env <name>',
    'cli.doctorAgentValue': '--agent erwartet local, docker oder session.',
    'cli.mcpAgentOnly': 'caw agent mcp startet nur für den Agenten eines Laufs.',
    'cli.unknownCommand': 'Unbekannter Befehl: {command}.{suggestion} Siehe caw --help.',
    'cli.movedCommand': 'caw {command} heißt jetzt caw {now}.',
    'cli.unknownAgentCommand': 'Unbekannter Befehl: caw agent {command}.{suggestion} Siehe caw agent --help.',
    'cli.didYouMean': ' Meintest du {name}?',

    // commands.mjs: explore file, config, skill, init
    'cli.notExploreResult': 'Die Datei sieht nicht nach einem Ergebnis von caw init --explore-only aus.',
    'cli.unknownFramework': 'Framework "{framework}" kennt caw-ai nicht ({names}).',
    'cli.initAuthUnknown': 'Anmeldung "{auth}" gibt es bei init nicht (form, session, none).',
    'cli.badRoleName': 'Rolle "{name}": nur Kleinbuchstaben, Ziffern und Bindestrich, mit einem Buchstaben vorn (etwa admin, editor).',
    'cli.mcpInvalid': '.mcp.json ist kein gültiges JSON, den Eintrag für caw-ai bitte von Hand ergänzen (siehe README).',
    'cli.skillCreated': 'Angelegt: {file}',
    'cli.skillCurrent': 'Skill ist aktuell',
    'cli.skillUpdated': 'Aktualisiert: {file}',
    'cli.skillNext': 'Weiter in Claude Code: „Richte caw-ai ein“. Der Skill führt durch explore, init und doctor.',
    'cli.initCreated': 'Angelegt: {files}',
    'cli.initAlready': 'Bereits eingerichtet.',
    'cli.initNeedsUrl': 'Aufruf: npx caw init --url <adresse>. init sieht sich die Anwendung zuerst an; du meldest dich im Fenster an.',
    'cli.initUsesExplore': 'Nutze die Vorschläge aus {file}.',
    'cli.envExampleHead': '# Nach caw/.env kopieren (gitignored) und Testkonten mit wenig Rechten eintragen.\n# Der Agent sieht diese Datei nicht, steuert aber einen angemeldeten Browser: Keine persönlichen Konten verwenden.',
    'cli.initTodo': 'Noch einzutragen in caw.config.json: {keys} (von explore nicht gefunden, siehe notes in caw/.explore.json).',
    'cli.initTodoOffline': 'Noch einzutragen in caw.config.json: {keys}. Die Selektoren findet caw init --explore-only --url <adresse>, sobald die Anwendung läuft.',
    'cli.doctorTodo': ({ keys, count }) => `${keys} ${count > 1 ? 'stehen' : 'steht'} noch auf TODO`,
    'cli.doctorTodoNext': 'In caw.config.json eintragen: path und Feld-Selektoren von der Anmeldeseite, signedInSelector von der Seite nach der Anmeldung. caw init --explore-only --url <adresse> findet sie.',
    'cli.initNext': 'Weiter: caw doctor, dann den ersten Test aufnehmen: caw record <test> --env {target}.',
    'cli.askEnv': 'Name dieser Umgebung',
    'cli.askLanguage': 'Teamsprache (Pläne und Texte von Claude), ein Kürzel wie de, en, fr',
    'cli.initEnvBad': 'Umgebung „{env}“: Kleinbuchstaben, Ziffern und -, mit einem Buchstaben vorn, höchstens 32 Zeichen.',
    'cli.initLanguageBad': 'Teamsprache „{language}“: ein Sprachkürzel wie de, en oder fr.',
    'cli.initNeedsAllowHttp': '{host} ist unverschlüsseltes http und nicht auf diesem Rechner: --allow-http angeben, wenn das wirklich gewollt ist (alles, auch die Anmeldung, geht unverschlüsselt übers Netz).',
    'cli.initProductionLike': 'Die Umgebung {env} sieht nach Produktion aus: mit production: true geschrieben, caw schreibt dort nie und Claude arbeitet dort nicht. Mit --env umbenennen, wenn es keine Produktion ist.',
    'cli.initNextExplore': ' Ohne passende Selektoren erst caw init --explore-only --url <adresse>.',
    'cli.initOfflineFallback': 'Kein Terminal und keine --url: init schreibt die Vorlage, die Anmeldung bleibt TODO. Später: caw init --explore-only --url <adresse>.',
    'cli.contextTemplate': '# Notizen für Claude\n\nWas Claude in jedem Test wissen sollte, aber nicht im Code sieht. Keine personenbezogenen Daten.\n\n- Beispiel: Die Suche merkt sich die letzte Eingabe. Erst „Filter löschen“ klicken.\n',

    // commands.mjs: init dialog
    'cli.askUrl': 'Adresse der lokalen Umgebung',
    'cli.askUrlProtocol': 'Bitte eine Adresse mit http:// oder https://.',
    'cli.askUrlInvalid': 'Das ist keine Adresse, etwa http://localhost:5173.',
    'cli.askRoles': 'Rollen, durch Komma getrennt',
    'cli.askRolesBad': '„{name}“: nur Kleinbuchstaben, Ziffern und Bindestrich, etwa admin, editor.',

    // commands.mjs: auth
    'cli.authUsage': 'Aufruf: caw role login <rolle> --env <umgebung>',
    'cli.authStorageOnly': 'caw role login gibt es nur, wo die Anmeldung vom Typ session ist; auf {target} ist sie {type}.',
    'cli.authRoleUnknown': 'Rolle {role} steht nicht in roles ({roles}).',
    'cli.targetProduction': '{target} ist Produktion.',
    'cli.authSignIn': 'Melde dich im Chrome-Fenster als {role} an. Sobald {selector} erscheint, speichert caw-ai die Sitzung.',
    'cli.authClosed': 'Fenster geschlossen, nichts gespeichert.',
    'cli.authSaved': 'Gespeichert: {file}. Die Datei enthält Anmelde-Cookies und gehört nicht ins Repository.',

    // commands.mjs: validate
    'cli.validateChain': '{file}: {chain}, neu aufnehmen.',
    'cli.validateNotRecorded': '{file}: noch nicht aufgenommen.',
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
    'cli.listNone': 'Noch keine Tests in {dir}. Den ersten nimmt caw record <test> auf.',
    'cli.listHead': 'Test|Umgebungen|Aufnahme|Daten',
    'cli.listRecorded': 'aufgenommen',
    'cli.listStale': 'veraltet ({ids})',
    'cli.listNotRecorded': 'nicht aufgenommen',
    'cli.listInvalid': 'ungültig',
    'cli.listWrites': 'schreibt',
    'cli.listReadOnly': 'liest nur',
    'cli.listStepRecorded': 'aufgenommen',
    'cli.listStepStale': 'veraltet',
    'cli.listStepNotRecorded': 'nicht aufgenommen',
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
    'cli.envWhyNew': 'einzige Umgebung, auf der Claude arbeiten darf',
    'cli.envWhyOnlyClaude': 'die einzige, auf der Claude arbeiten darf',
    'cli.validateNowhere': '{id} läuft nirgends: Keine Umgebung passt (ein schreibender Test braucht eine beschreibbare Umgebung)',
    'cli.noEnvironment': 'keiner Umgebung',
    'cli.verbRecord': 'Aufgenommen wird',
    'cli.agentOnly': '{verb} braucht environments.{environment}.claude: true (zurzeit nur: {environments}).',
    'cli.agentNotInCi': '--agent {agent} geht nicht in CI (Variable CI gesetzt), dort läuft Claude nur in Docker.',
    'cli.sessionAgent': 'Claude arbeitet in deiner Claude-Code-Session: Sage ihr „übernimm den caw-Lauf“. Sie findet ihn über das Tool caw (caw mcp) oder caw <befehl>.',
    'cli.sessionLabel': 'deine Claude-Code-Session',
    'cli.localAgent': 'Claude läuft lokal ohne Docker, nur mit Lesen und dem Browser-Werkzeug (Claude Code {version}). Abgeschottet: agent.mode "docker".',
    'cli.usingDocker': 'Nutze {label}.',
    'cli.tokenMissing': '{hint} Claude in Docker braucht einen API-Schlüssel aus der Claude Console. Ohne Schlüssel --agent local nutzen: Das läuft mit deiner eigenen Claude-Code-Anmeldung.',
    'cli.and': ' und ',
    'cli.draftMissing': 'Für den neuen Test {id} fehlt {missing}. Aufruf: {hint}',
    'cli.choiceShow': 'Selbst vorführen',
    'cli.choiceFollow': 'Claude geht dem Testplan nach',
    'cli.choiceReuse': 'Letzte Vorführung verwenden ({time}, {count} Einträge)',
    'cli.recordAborted': 'Die Aufnahme wurde abgebrochen.',
    'cli.questionNew': 'Wie soll {id} entstehen?',
    'cli.questionRecorded': '{id} ist schon aufgenommen. Die Aufnahme wird erst abgelöst, wenn du am Ende zustimmst. Wie soll die neue entstehen?',
    'cli.questionDescribed': '{id} ist beschrieben, aber noch nicht aufgenommen. Führst du vor, oder geht Claude dem Testplan nach?',
    'cli.demoNote': 'Führe nur Testdaten vor: Deine Eingaben gehen an Claude und landen in der Aufzeichnung. Passwörter werden nie erfasst.',
    'cli.dialogAsks': 'Die App fragt: „{message}“',
    'cli.dialogLeave': 'Die App fragt vor dem Verlassen der Seite: „{message}“',
    'cli.dialogPrompt': 'Die App fragt nach einem Wert: „{message}“. Tipp den Wert hier ein und schick ihn ab, oder wähle OK (behält „{value}“) oder Abbrechen.',
    'cli.dialogOk': 'OK',
    'cli.dialogCancel': 'Abbrechen',
    'cli.demoRecorded': 'Aufgezeichnet: {line}',
    'cli.demoFailure': '{label}. Er steht an dieser Stelle in der Aufnahme.',
    'cli.demoNothingFollow': 'Nichts vorgeführt: Claude geht dem Testplan nach.',
    'cli.demoNothing': 'Noch nichts vorgeführt. Klick dich in der Anwendung durch den Ablauf, dann „Vorführung beenden“.',
    'cli.modeLine': 'Modus auf {env} (Teamsprache {language}): {how}; lernt: {learns}.',
    'cli.modeNoAgent': 'ohne Chat, Claude darf nur auf {environments} arbeiten',
    'cli.modeHeadless': 'ohne Fenster und ohne Chat (--headless)',
    'cli.modeNoChat': 'ohne Chat (--no-chat)',
    'cli.modeCi': 'ohne Chat, weil die Variable CI gesetzt ist',
    'cli.modeChat': 'mit Chat{advice}',
    'cli.modeLearnsNo': 'nein',
    'cli.modeLearnsYes': 'ja (--learn), fehlende Vergleichswerte und Effekte in {file}',
    'cli.modeAdvice': ' und Empfehlungen von Claude (--explain, kostet Token)',
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
    'cli.junitWritten': 'JUnit-Bericht: {file}',
    'cli.stepUnknown': '{test} hat keinen Schritt {step}.{suggestion} {steps}',
    'cli.adviseAgentOnly': '--explain nur auf Umgebungen, auf denen Claude arbeiten darf (hier: {environments}), nicht auf {target}.',
    'cli.ciHandover': '{option} übergibt den Browser an einen Menschen; in CI (Variable CI gesetzt) ist keiner da.',
    'cli.ciNeedsHuman': 'caw {command} braucht einen Menschen im Chat (Vorführung, Plan, Entscheidungen); in CI (Variable CI gesetzt) ist keiner da.',
    'cli.adviseNeedsChat': '--explain braucht den Chat, in CI (Variable CI gesetzt) empfiehlt Claude nicht.',
    'cli.failedHintAgent': '{step} ist gescheitert. Ursache klären: caw run {test} --env {target} im Terminal, der Chat zeigt die Einschätzung und lässt Claude suchen. Nur wenn sich die Anwendung gewollt geändert hat, ab dort neu aufnehmen: caw record {test}@{step} --env {target}',
    'cli.failedHint': '{step} ist gescheitert. Ursache klären im Lauf mit Chat: caw run {test} --env {target}',
    'cli.failedHintNoAgent': '{step} ist gescheitert. Die Ursache klärt ein Lauf mit Chat, auf einer Umgebung, auf der Claude arbeiten darf (hier: {environments}).',
    'cli.untilHint': 'Bis zum Einstieg in den Schritt: caw open {test}@{step} --env {target}',
    'cli.recordExists': 'Den Test {test} gibt es schon, seine Metadaten bleiben. --role und --read-only müssen zur Datei passen oder entfallen.',
    'cli.recordStepUnknown': '{test} hat keinen Schritt {step}.{suggestion} {steps} Einen neuen Schritt trägst du zuerst in {file} ein.',
    'cli.recordFromReason': 'Neu aufnehmen ab {step} ist gewünscht',

    // doctor.mjs
    'cli.doctorNodeOld': 'Node {version} ist zu alt',
    'cli.doctorNodeNext': 'Node {min} oder neuer installieren.',
    'cli.doctorConfigOk': '{file} ist gültig',
    'cli.doctorConfigNextValidate': ({ count }) => (count > 1 ? `caw validate zeigt alle ${count} Befunde.` : 'caw validate zeigt alle Befunde.'),
    'cli.doctorConfigMissing': '{file} fehlt',
    'cli.doctorConfigNextInit': 'caw init legt sie an.',
    'cli.doctorBrowserOk': 'Browser startet ({browser})',
    'cli.doctorBrowserFail': 'Browser startet nicht ({browser}): {error}',
    'cli.doctorBrowserNext': 'Google Chrome installieren (Stable), caw-ai nutzt das Chrome des Systems; oder in der Config browser.channel bzw. browser.executablePath setzen.',
    'cli.doctorSessionOk': 'Deine Claude-Code-Session übernimmt (Eintrag caw-ai in .mcp.json)',
    'cli.doctorSessionMissing': 'Eintrag caw-ai in .mcp.json fehlt',
    'cli.doctorSessionNext': 'caw skill legt ihn an; danach Claude Code im Projekt neu starten.',
    'cli.doctorClaudeOk': 'Claude Code {version} (Claude läuft lokal, ohne Docker)',
    'cli.doctorClaudeMissing': 'Claude Code (claude) ist nicht im PATH',
    'cli.doctorClaudeNext': 'Nur für Läufe mit Claude: Claude Code installieren und einmal anmelden, oder agent.mode "docker".',
    'cli.doctorDockerOk': 'Docker: {label}',
    'cli.doctorDockerNext': 'Nur für record und Claude im Chat nötig: Docker starten (Linux-Container).',
    'cli.doctorTokenOk': 'Zugang für Claude in Docker: {name}',
    'cli.doctorTokenMissing': 'Kein Zugang für Claude in Docker (ANTHROPIC_API_KEY)',
    'cli.doctorTokenNext': 'Nur für Läufe mit Claude in Docker: einen API-Schlüssel aus der Claude Console als ANTHROPIC_API_KEY setzen. Lokal nutzt Claude deine Claude-Code-Anmeldung.',
    'cli.doctorIgnoreOk': '.gitignore schützt Läufe, Zugangsdaten und Sitzungen',
    'cli.doctorIgnoreMissing': '.gitignore fehlt: {lines}',
    'cli.doctorIgnoreNext': 'caw init ergänzt die Einträge.',
    'cli.doctorRoleOk': 'Rolle {name} auf {target}: Testnutzer gesetzt',
    'cli.doctorRoleMissing': ({ name, target, missing, count, file }) => `Rolle ${name} auf ${target}: ${missing} ${count > 1 ? 'fehlen' : 'fehlt'} in ${file}`,
    'cli.doctorRoleNext': 'caw role add <rolle> --env <umgebung> öffnet das Anmeldefenster; in CI die Variablen als Umgebungsvariablen setzen ({file}.example nennt sie).',
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
    'cli.overlayCheck.noPart': 'Kein Teil „{part}“ in overlay.parts. Nimm --part, zur Wahl: {parts}',
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
    'cli.overlayCheck.incompleteApply': 'Unvollständig: {count} Skript(e) kamen vom Server. caw overlay check --apply trägt die Muster ein.',
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
    'cli.doctorOverlayPartNext': 'caw overlay check zeigt das fehlende Muster, --apply trägt es ein.',
    'cli.doctorOverlayNoCheck': '{target}, Teil {app}: Overlay noch nicht geprüft',
    'cli.doctorOverlayNoCheckNext': 'caw overlay check --env {target}',
    'cli.doctorMarkOk': 'OK        ',
    'cli.doctorMarkOptional': 'OPTIONAL  ',
    'cli.doctorMarkMissing': 'FEHLT     ',
    'cli.doctorSummary': ({ ok, blocking, optional }) => `${ok} in Ordnung, ${blocking} ${blocking === 1 ? 'fehlt' : 'fehlen'}, ${optional} optional offen`,
    'cli.doctorReadyFirst': 'Bereit. Nächster Schritt: den ersten Test aufnehmen, caw record <test> --env <umgebung>.',
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
    'cli.exploreForeign': 'Die Anmeldung wollte auf {hosts}; das Tool ließ das nicht zu. Für SSO: signIn vom Typ session, Sitzung einmal mit caw role login speichern; den Anmeldedienst ggf. in allowHosts.',
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
    'cli.exploreCardSaved': '■ GESPEICHERT',
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
    'cli.exploreLoginNotFound': 'Du sagtest, es gibt eine Anmeldung, aber ich habe kein Anmeldeformular gesehen. Prüfe auth in der Config.',
    'cli.yesNoDefaultYes': '[J/n]',
    'cli.yesNoDefaultNo': '[j/N]',
    'cli.exploreUsage': 'Aufruf: caw init --explore-only --url <adresse>, etwa --url http://app.localhost:5173',
    'cli.exploreNeedsTty': 'explore braucht ein Terminal für die Frage nach der Anmeldung. Ohne Terminal: --yes.',
    'cli.exploreUnreachable': '{url} antwortet nicht. Läuft der Dev-Server, stimmt die Adresse?',
    'cli.exploreNext': 'Weiter: npx caw init übernimmt {file}. Was dort TODO bleibt, trägst du in caw.config.json ein.',

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
    'cli.uiMaxActions': 'bis {count} Aktionen',
    'cli.uiLanguage': 'Teamsprache {language}',
    'cli.uiWarnings': '{count} Warnung(en) im Bericht.',
    'cli.uiReport': 'Bericht:',
    'cli.uiMoreFailures': 'und {count} weitere im Bericht',
    'cli.uiWarningsShort': '{count} Warnung(en) im Bericht',
    'cli.uiPassed': '{count} bestanden',
    'cli.uiFailed': '{count} Fehler',
    'cli.uiOpen': '{count} offen',
    'cli.themeHeading': 'Themes',
    'cli.themeOwn': 'eigenes, auf {base}',
    'cli.themeActive': '(aktiv)',
    'cli.themeHint': 'Wählen: caw theme use <name>. Ändern: F7 in der Werkbank.',
    'cli.themeUsed': 'Theme {name} gewählt.',
    'cli.themeUnknown': 'Theme {name} gibt es nicht. Vorhanden: {names}',
    'cli.themeUsage': 'Aufruf: caw theme [use <name> | check <name>]',
    'cli.themeCheck': 'Theme {name} prüfen',
    'cli.themeSchemaOk': 'Schema passt',
    'cli.themeWidth': 'Die Marken sind unterschiedlich breit; Texte dahinter stehen dann nicht untereinander.',
    'cli.themeContrast': 'Kontrast {pair} nur {ratio}:1, unter 4,5:1 schwer lesbar.',
    'cli.themeFontMissing': 'Schrift fehlt: {file}',
    'cli.themeLooksOk': 'Kontrast, Marken und Schriften in Ordnung',
    'cli.roleSynopsis': 'Aufruf: caw role [list [--json] | add [<rolle>] [--env <name>] | remove <rolle> | login <rolle> --env <name>]',
    'cli.roleUnknownArg': 'role kennt {arg} nicht. Erlaubt: --env, --json',
    'cli.testUserMultiline': 'Benutzername oder Passwort enthält einen Zeilenumbruch; caw/.env kann das nicht aufnehmen.',
    'cli.testUserQuotes': 'Das Passwort enthält alle Anführungszeichen; trage es selbst in caw/.env ein.',
    'cli.envFileHead': '# Testnutzer für caw-ai. Nie einchecken.',
    'cli.testUserRoleBad': 'Rolle „{role}“: Kleinbuchstaben, Ziffern und Bindestriche, beginnt mit einem Buchstaben, höchstens 32 Zeichen.',
    'cli.testUserEmpty': 'Im Anmeldeformular wurde kein Benutzername oder Passwort eingegeben.',
    'cli.roleStep': 'Rolle',
    'cli.roleCardLabel': 'ROLLE',
    'cli.roleCardSave': 'Speichern',
    'cli.roleCardMore': '+ Weitere Rolle',
    'cli.roleCardFinish': 'Fertig',
    'cli.roleCardFixed': 'Dieser Lauf braucht die Rolle {role}.',
    'cli.roleCardSignIn': 'Melde dich mit dem Testnutzer für die neue Rolle an.',
    'cli.roleCardRole': 'Angemeldet als {user}. Diesen Testnutzer speichern als Rolle:',
    'cli.roleCardSaved': 'Rolle {role} in caw/.env gespeichert. Weiterer Testnutzer?',
    'cli.roleCardContinue': 'Rolle {role} gespeichert. Der Lauf geht weiter.',
    'cli.roleSaved': 'Rolle {role} gespeichert: {names} in {file}',
    'cli.roleGitignore': '{file} in .gitignore eingetragen.',
    'cli.roleTargetUnknown': 'Unbekannte Umgebung {target}. Bekannt: {environments}',
    'cli.roleTargetMissing': 'Auf welcher Umgebung soll sich das Fenster anmelden? --env <umgebung> ({environments})',
    'cli.roleAuthType': 'Testnutzer mit Passwort nur bei signIn vom Typ form oder basic (auf {target}: {type}). Für session: caw role login <rolle> --env {target}.',
    'cli.roleSignIn': 'Melde dich im Fenster mit dem Testnutzer an ({target}).',
    'cli.roleNoCredentials': 'Angemeldet, aber im Formular wurden kein Benutzername und Passwort gesehen (SSO?). Nichts gespeichert.',
    'cli.roleNeeded': 'Test {test} meldet sich als Rolle {role} an, die noch keinen Testnutzer hat: Melde dich im Fenster damit an.',
    'cli.roleNotSaved': 'Kein Testnutzer für Rolle {role} gespeichert. caw role add {role} --env <umgebung> legt einen an.',
    'cli.exploreRoleStep': 'Im Fenster: Benenne die Rolle für den Testnutzer, mit dem du dich angemeldet hast.',
    'cli.roleUnknown': 'Unbekannte Rolle {role}. Bekannt: {roles}',
    'cli.roleInUse': 'Rolle {role} wird noch genutzt von: {tests}',
    'cli.roleNone': 'Noch keine Rollen. caw role add <rolle> --env <umgebung>',
    'cli.roleStateMissing': 'nicht in der Config',
    'cli.roleStateSet': 'Testnutzer gesetzt',
    'cli.roleStateNoUser': 'kein Testnutzer',
    'cli.roleStateNoPassword': 'kein Passwort nötig',
    'cli.roleStateSession': 'Sitzung gespeichert',
    'cli.roleStateNoSession': 'keine Sitzung',
    'cli.roleAddHint': 'Testnutzer anlegen: caw role add {role} --env {target}',
    'cli.roleLoginHint': 'Sitzung speichern: caw role login {role} --env {target}',
    'cli.roleNothingSaved': 'Nichts gespeichert.',
    'cli.roleNext': 'Gespeichert: {roles}. Tests nutzen sie mit role: <name>.',
    'cli.roleRemoved': 'Rolle {role} aus der Config und {file} entfernt.',
};
