// Texte: cli (de). Schluessel mit Praefix "cli.".
export default {
    // bin/caw-ai.mjs
    'cli.usage': `caw-ai - KI-gesteuerte Integrationstests für Webanwendungen (Constrained Agentic Webtester)

Erste Schritte (im Projektordner, die Anwendung läuft):
  1. npx caw-ai init --url http://localhost:5173      im Fenster anmelden, Enter: legt caw.config.json, caw/.env.example und
                                                      den Skill an; was TODO bleibt, selbst eintragen
  2. caw/.env.example nach caw/.env kopieren und Zugangsdaten eines Testkontos eintragen
  3. npx caw-ai doctor                                bis nichts mehr FEHLT
  4. Einen Test beschreiben (siehe Testplan), dann record <test> --target local, danach run <test> --target local

Testplan caw/tests/<test>.yaml (je Schritt eine Aktion und genau ein prüfbares Ergebnis):
  id: akten-liste
  app: web                 # ein Name aus apps in caw.config.json
  role: admin              # ein Name aus roles
  targets: [local]         # Umgebungen aus environments
  mutates: false           # true, wenn der Test Daten anlegt oder ändert
  steps:
    - id: S1
      name: Liste offen
      do: Öffne in der Navigation „Alle Akten“.
      expect: Die Liste „Alle Akten“ ist sichtbar.
  Die Aufzeichnung schreibt record nach caw/recordings/, von Hand bearbeitet wird nur der Testplan.

Auf dem Host (im Projektordner):
  skill                                  Nur den Skill für Claude Code (und .mcp.json) anlegen oder aktualisieren; danach
                                         richtet Claude Code caw-ai mit dir ein („Richte caw-ai ein“)
  explore --url <adresse>                Anwendung einmal öffnen, du meldest dich an; schlägt Framework, Anmeldung, Marke
                                         für angemeldet, Startseite und Meldungen vor (caw/.explore.json), schreibt keine Config
      [--yes]                            ohne Anmeldung und ohne Rückfrage, nur die Seite ansehen
      [--insecure-tls]                   selbstsignierte Zertifikate annehmen (nur lokale Umgebungen)
  init [--url <adresse>]                 Einrichten: sieht die Anwendung an (du meldest dich im Fenster an), legt Config,
                                         Skill und .mcp.json an; ohne --url fragt es nach der Adresse
      [--yes]                            ohne Anmeldung und ohne Fragen
      [--from <datei>]                   ein vorhandenes Ergebnis von explore übernehmen
      [--no-mcp]                         ohne Eintrag in .mcp.json
  validate                               Config und Tests prüfen, ohne Browser und ohne Claude
  doctor [--agent local|docker|session]  Node, Chrome, Claude Code (local) bzw. Docker und Token (docker), Zugangsdaten und
                                         Umgebungen prüfen, mit nächstem Schritt
  auth <rolle> --target <umgebung>       Bei auth.type storageState: einmal von Hand anmelden (etwa SSO), die Sitzung
                                         landet in caw/.auth/<umgebung>/<rolle>.json
  --version                              Version des Pakets
  mcp                                    Werkzeuge für deine Claude-Code-Session (in .mcp.json eintragen): Läufe starten,
                                         als Agent arbeiten (--agent session), gewähltes Element lesen
  run <test> --target <umgebung>         Testlauf nach Plan, ohne Claude. Mit agent steht der Chat daneben: Scheitert ein Schritt,
                                         klärst du ihn dort mit Claude und lässt ihn beheben
      [--until <S4>]                     Bis zu diesem Schritt fahren und das Fenster übergeben, mit lokalem Code, wo erlaubt
      [--handover]                       Danach das Chrome-Fenster dem Menschen überlassen
      [--advise]                         Bei Fehlern oder Warnungen gibt Claude von sich aus Empfehlungen, kostet Token, nur mit agent
      [--no-chat]                        Ohne Chat und ohne Claude, wie in CI
      [--headless]                       Ohne Fenster und ohne Chat
      [--step-timeout <sekunden>]        Zeitlimit je Schritt, Standard 30
      [--timeout <minuten>]              Zeitlimit für Claude beim Klären und Beheben, Standard 60
      [--max-steps <n>]                  Grenze für Aktionen von Claude beim Beheben, sonst maxSteps aus der Config, sonst 100
      [--agent local|docker|session]     Wo Claude arbeitet; Standard aus agent.sandbox der Config (local). session: deine
                                         Claude-Code-Session übernimmt über caw-ai mcp, caw startet keinen Claude
  record <test> --target <umgebung>      Testplan aufnehmen oder ablösen, immer mit Chat, nur mit agent
      [--role <rolle> --app <app>]       Nur beim ersten Mal; entfällt, wenn die Config nur eine kennt
      [--also <app>]                     Nur beim ersten Mal: Der Weg führt in eine weitere App des Projekts
      [--read-only]                      Nur beim ersten Mal: Der Test schreibt nicht (mutates: false); schreibt er doch, wird er schreibend
      [--timeout <minuten>]              Zeitlimit für Claude, Standard 60
      [--agent local|docker|session]     wie bei run
      [--max-steps <n>]                  Grenze für Aktionen von Claude, sonst maxSteps aus der Config, sonst 100
      [--step-timeout <sekunden>]        Zeitlimit je Schritt im Prüfdurchlauf, Standard 30
  fix <test> <S4> --target <umgebung>    Genau diesen Schritt ändern, immer mit Chat, nur mit agent
      [--timeout <minuten>] [--max-steps <n>] [--step-timeout <sekunden>] [--agent local|docker|session]

Für den Agenten (Sandbox, lokal oder deine Session bei --agent session), steuert den Browser:
  task                                   Auftrag des offenen Laufs anzeigen
  snapshot                               Seitenstruktur mit Referenzen (e1, e2, ...)
  url                                    Aktuelle URL
  click <ziel>                           Ziel: Referenz oder Selektor
  fill <ziel> <text>                     Feld setzen
  type <ziel> <text>                     Zeichenweise tippen
  press <taste>                          Taste drücken, z. B. Enter
  eval <ausdruck>                        JavaScript in der Seite auswerten
  check <S1> <ausdruck>                  Schritt prüfen: Der Ausdruck muss genau true liefern
  screenshot <name.png>                  Screenshot im Agent-Ordner ablegen
  goto <url>                             Zu einem erlaubten Host navigieren
  reload                                 Seite neu laden
  wait-ready [--store <id>] [--min-count <n>] [--timeout <ms>]
  console                                Neue harte Konsolenfehler abholen
  network                                Letzte Requests der Anwendung mit Ausgang und Dauer, ohne Parameterwerte
  plan --file <plan.yaml>                Ablaufplan im Chat vorlegen, wartet auf Freigabe oder Anpassung
  ask-operator "<was fehlt>"             Den Menschen fragen oder um Vorführung bitten, die Schritte kommen in den Test
  remember <name> <ausdruck>             Wert merken, den erst der Lauf erzeugt, z. B. eine Bestellnummer
  chat                                   Nachrichten lesen, wartet während einer Pause und im Gespräch auf den Menschen
  say <text>                             Dem Menschen schreiben, wartet nicht auf Antwort
  recording                              Bisher aufgezeichnete Schritte nummeriert anzeigen
  finish --file <ergebnis.json>          Urteil einreichen; aufgezeichnet wird nur mit "omit"
  advise --file <empfehlung.json>        Empfehlungen einreichen, auch beim Beheben; der Mensch entscheidet je Karte

<umgebung>: ein Name aus environments, etwa local; mit sites mandant/umgebung, etwa nord/dev. "Mit agent" heißt: auf Umgebungen
mit "agent": true.

Exit-Codes: 0 pass, 1 fail, 2 error (Umgebung), 3 Eingabe abgelehnt.`,
    'cli.fromUnreadable': '{from} ist nicht lesbar: {message}',
    'cli.doctorUnknownArg': 'doctor kennt {arg} nicht. Erlaubt: --agent local|docker|session',
    'cli.doctorAgentValue': '--agent erwartet local, docker oder session.',
    'cli.mcpAgentOnly': 'mcp-agent startet nur für den Agenten eines Laufs.',
    'cli.unknownCommand': 'Unbekannter Befehl: {command}',

    // commands.mjs: explore-Datei, Config, Skill, init
    'cli.notExploreResult': 'Die Datei sieht nicht nach einem Ergebnis von caw-ai explore aus.',
    'cli.unknownFramework': 'Framework "{framework}" kennt caw-ai nicht ({names}).',
    'cli.initAuthUnknown': 'Anmeldung "{auth}" gibt es bei init nicht (form, storageState, none).',
    'cli.badRoleName': 'Rolle "{name}": nur Kleinbuchstaben, Ziffern und Bindestrich, mit einem Buchstaben vorn (etwa admin, editor).',
    'cli.mcpInvalid': '.mcp.json ist kein gültiges JSON, den Eintrag für caw-ai bitte von Hand ergänzen (siehe README).',
    'cli.skillCreated': 'Angelegt: {file}',
    'cli.skillCurrent': 'Skill ist aktuell',
    'cli.skillUpdated': 'Aktualisiert: {file}',
    'cli.skillNext': 'Weiter in Claude Code: „Richte caw-ai ein“. Der Skill führt durch explore, init und doctor.',
    'cli.initCreated': 'Angelegt: {files}',
    'cli.initAlready': 'Bereits eingerichtet.',
    'cli.initNeedsUrl': 'Aufruf: npx caw-ai init --url <adresse>. init sieht sich die Anwendung zuerst an; du meldest dich im Fenster an.',
    'cli.initUsesExplore': 'Nutze die Vorschläge aus {file}.',
    'cli.envExampleHead': '# Nach caw/.env kopieren (gitignored) und Testkonten mit wenig Rechten eintragen.\n# Der Agent sieht diese Datei nicht, steuert aber einen angemeldeten Browser: Keine persönlichen Konten verwenden.',
    'cli.initTodo': 'Noch einzutragen in caw.config.json: {keys} (explore fand sie nicht, siehe notes in caw/.explore.json).',
    'cli.doctorTodo': '{keys} steht noch auf TODO',
    'cli.doctorTodoNext': 'In caw.config.json den Selektor eintragen, etwa aus dem Quellcode der Anmeldeseite.',
    'cli.initNext': 'Weiter: caw-ai doctor, dann den ersten Test aufnehmen: caw-ai record <test> --target {target}. Ohne passende Selektoren erst caw-ai explore --url <adresse>.',

    // commands.mjs: Dialog von init
    'cli.askUrl': 'Adresse der lokalen Umgebung',
    'cli.askUrlProtocol': 'Bitte eine Adresse mit http:// oder https://.',
    'cli.askUrlInvalid': 'Das ist keine Adresse, etwa http://localhost:5173.',
    'cli.askRoles': 'Rollen, durch Komma getrennt',
    'cli.askRolesBad': '„{name}“: nur Kleinbuchstaben, Ziffern und Bindestrich, etwa admin, editor.',

    // commands.mjs: auth
    'cli.authUsage': 'Aufruf: caw-ai auth <rolle> --target <umgebung>',
    'cli.authStorageOnly': 'caw-ai auth gibt es nur mit auth.type storageState; hier ist es {type}.',
    'cli.authNeedsSelector': 'caw-ai auth braucht auth.signedInSelector: Daran erkennt es, dass die Anmeldung fertig ist.',
    'cli.authRoleUnknown': 'Rolle {role} steht nicht in roles ({roles}).',
    'cli.targetProduction': '{target} ist Produktion.',
    'cli.authSignIn': 'Melde dich im Chrome-Fenster als {role} an. Sobald {selector} erscheint, speichert caw-ai die Sitzung.',
    'cli.authClosed': 'Fenster geschlossen, nichts gespeichert.',
    'cli.authSaved': 'Gespeichert: {file}. Die Datei enthält Anmelde-Cookies und gehört nicht ins Repository.',

    // commands.mjs: validate
    'cli.validateChain': '{file}: {chain}, neu aufnehmen.',
    'cli.validateNotRecorded': '{file}: noch nicht aufgenommen.',
    'cli.validateOk': '{config} und {count} Test(s) sind gültig.',

    // commands.mjs: Sandbox, Lauf, Aufnahme, Beheben
    'cli.imageBuilding': 'Baue das Sandbox-Image (nur beim ersten Lauf und nach Tool-Änderungen) ...',
    'cli.imageBuildFailed': 'Das Sandbox-Image ließ sich nicht bauen (Exit {code}). Fehlt der Registry-Login für {image}?',
    'cli.noWatch': 'Kein {label} aktiv: Getestet wird der deployte Stand, ohne lokalen Code.',
    'cli.testMissing': 'Test nicht gefunden: {file}. Neu aufnehmen: {hint}',
    'cli.noEnvironment': 'keiner Umgebung',
    'cli.verbRecord': 'Aufgenommen wird',
    'cli.verbFix': 'Behoben wird',
    'cli.agentOnly': '{verb} nur auf {environments}, nicht auf {target}.',
    'cli.agentNotInCi': '--agent {agent} geht nicht in CI (Variable CI gesetzt), dort läuft Claude nur in Docker.',
    'cli.sessionAgent': 'Claude arbeitet in deiner Claude-Code-Session: Sage ihr „übernimm den caw-Lauf“. Sie findet ihn über das Tool caw (caw-ai mcp) oder caw-ai <befehl>.',
    'cli.sessionLabel': 'deine Claude-Code-Session',
    'cli.localAgent': 'Claude läuft lokal ohne Docker, nur mit Lesen und dem Browser-Werkzeug (Claude Code {version}). Abgeschottet: agent.sandbox "docker".',
    'cli.usingDocker': 'Nutze {label}.',
    'cli.tokenMissing': '{hint} Erzeugen z. B. mit claude setup-token.',
    'cli.and': ' und ',
    'cli.draftMissing': 'Für den neuen Test {id} fehlt {missing}. Aufruf: {hint}',
    'cli.unknownApp': 'Unbekannte App: {name}',
    'cli.choiceShow': 'Selbst vorführen',
    'cli.choiceFollow': 'Claude geht dem Testplan nach',
    'cli.choiceReuse': 'Letzte Vorführung verwenden ({time}, {count} Einträge)',
    'cli.recordAborted': 'Die Aufnahme wurde abgebrochen.',
    'cli.questionNew': 'Wie soll {id} entstehen?',
    'cli.questionRecorded': '{id} ist schon aufgenommen. Die Aufnahme wird erst abgelöst, wenn du am Ende zustimmst. Wie soll die neue entstehen?',
    'cli.questionDescribed': '{id} ist beschrieben, aber noch nicht aufgenommen. Führst du vor, oder geht Claude dem Testplan nach?',
    'cli.demoNote': 'Führe nur Testdaten vor: Deine Eingaben gehen an Claude und landen in der Aufzeichnung. Passwörter werden nie erfasst.',
    'cli.demoRecorded': 'Aufgezeichnet: {line}',
    'cli.demoFailure': '{label}. Er steht an dieser Stelle in der Aufnahme.',
    'cli.demoNothingFollow': 'Nichts vorgeführt: Claude geht dem Testplan nach.',
    'cli.demoNothing': 'Noch nichts vorgeführt. Klick dich in der Anwendung durch den Ablauf, dann „Fertig“.',
    'cli.modeNoAgent': 'Modus: ohne Chat, Claude läuft nur auf {environments}. Die Testdatei bleibt unverändert.',
    'cli.modeHeadless': 'Modus: ohne Fenster und ohne Chat (--headless). Die Testdatei bleibt unverändert.',
    'cli.modeNoChat': 'Modus: ohne Chat (--no-chat). Die Testdatei bleibt unverändert.',
    'cli.modeCi': 'Modus: ohne Chat, weil die Variable CI gesetzt ist. Die Testdatei bleibt unverändert.',
    'cli.modeChat': 'Modus: mit Chat{advice}. Fehlende Vergleichswerte lernt der Lauf in {dir}.',
    'cli.modeAdvice': ' und Empfehlungen von Claude (--advise, kostet Token)',
    'cli.stepUnknown': '{test} hat keinen Schritt {step}.',
    'cli.adviseAgentOnly': '--advise nur auf {environments}, nicht auf {target}.',
    'cli.ciHandover': '{option} übergibt den Browser an einen Menschen; in CI (Variable CI gesetzt) ist keiner da.',
    'cli.ciNeedsHuman': 'caw-ai {command} braucht einen Menschen im Chat (Vorführung, Plan, Entscheidungen); in CI (Variable CI gesetzt) ist keiner da.',
    'cli.adviseNeedsChat': '--advise braucht den Chat, in CI (Variable CI gesetzt) empfiehlt Claude nicht.',
    'cli.failedHintAgent': '{step} ist gescheitert. Ursache klären: caw-ai run {test} --target {target} im Terminal, der Chat zeigt die Einschätzung und lässt Claude suchen. Nur wenn sich die Anwendung gewollt geändert hat: caw-ai fix {test} {step} --target {target}',
    'cli.failedHint': '{step} ist gescheitert. Die Ursache klärt ein Lauf mit Chat auf {environments}.',
    'cli.recordExists': 'Den Test {test} gibt es schon, seine Metadaten bleiben. --role, --app, --also und --read-only müssen zur Datei passen oder entfallen.',
    'cli.fixStepUnknown': '{test} hat keinen Schritt {step}. Einen neuen Schritt trägst du zuerst in {file} ein.',
    'cli.fixReplayFirst': 'Spiele zuerst bis {step} ab. Scheitert der Schritt, klärt der Chat die Ursache statt einer neuen Aufnahme.',
    'cli.fixPassed': '{step} besteht. Claude nimmt ihn jetzt neu auf.',

    // doctor.mjs
    'cli.doctorNodeOld': 'Node {version} ist zu alt',
    'cli.doctorNodeNext': 'Node {min} oder neuer installieren.',
    'cli.doctorConfigOk': '{file} ist gültig',
    'cli.doctorConfigNextValidate': 'caw-ai validate zeigt alle Befunde.',
    'cli.doctorConfigMissing': '{file} fehlt',
    'cli.doctorConfigNextInit': 'caw-ai init legt sie an.',
    'cli.doctorBrowserOk': 'Browser startet ({browser})',
    'cli.doctorBrowserFail': 'Browser startet nicht ({browser}): {error}',
    'cli.doctorBrowserNext': 'Google Chrome installieren (Stable), caw-ai nutzt das Chrome des Systems; oder in der Config browser.channel bzw. browser.executablePath setzen.',
    'cli.doctorSessionOk': 'Deine Claude-Code-Session übernimmt (Eintrag caw-ai in .mcp.json)',
    'cli.doctorSessionMissing': 'Eintrag caw-ai in .mcp.json fehlt',
    'cli.doctorSessionNext': 'caw-ai skill legt ihn an; danach Claude Code im Projekt neu starten.',
    'cli.doctorClaudeOk': 'Claude Code {version} (Claude läuft lokal, ohne Docker)',
    'cli.doctorClaudeMissing': 'Claude Code (claude) ist nicht im PATH',
    'cli.doctorClaudeNext': 'Nur für Läufe mit Claude: Claude Code installieren und einmal anmelden, oder agent.sandbox "docker".',
    'cli.doctorDockerOk': 'Docker: {label}',
    'cli.doctorDockerNext': 'Nur für record, fix und Claude im Chat nötig: Docker starten (Linux-Container).',
    'cli.doctorTokenOk': 'CLAUDE_CODE_OAUTH_TOKEN ist gesetzt',
    'cli.doctorTokenMissing': 'CLAUDE_CODE_OAUTH_TOKEN fehlt',
    'cli.doctorTokenNext': 'Nur für Läufe mit Claude in Docker: ein Token mit "claude setup-token" erzeugen und als Umgebungsvariable setzen.',
    'cli.doctorIgnoreOk': '.gitignore schützt Läufe, Zugangsdaten und Sitzungen',
    'cli.doctorIgnoreMissing': '.gitignore fehlt: {lines}',
    'cli.doctorIgnoreNext': 'caw-ai init ergänzt die Einträge.',
    'cli.doctorRoleOk': 'Rolle {name}: Zugangsdaten gesetzt',
    'cli.doctorRoleMissing': ({ name, missing, count, file }) => `Rolle ${name}: ${missing} ${count > 1 ? 'fehlen' : 'fehlt'} in ${file}`,
    'cli.doctorRoleNext': 'Als Umgebungsvariable setzen (CI) oder {file}.example nach {file} kopieren und ein Testkonto eintragen.',
    'cli.doctorSessionSaved': 'Rolle {name} auf {target}: Sitzung gespeichert',
    'cli.doctorSessionNone': 'Rolle {name} auf {target}: keine Sitzung',
    'cli.doctorReachOk': '{target}: {url} antwortet',
    'cli.doctorReachFail': '{target}: {url} antwortet nicht',
    'cli.doctorReachNext': 'VPN, Dev-Server oder Adresse in environments prüfen.',
    'cli.doctorMarkOk': 'OK        ',
    'cli.doctorMarkOptional': 'OPTIONAL  ',
    'cli.doctorMarkMissing': 'FEHLT     ',
    'cli.doctorSummary': ({ ok, blocking, optional }) => `${ok} in Ordnung, ${blocking} ${blocking === 1 ? 'fehlt' : 'fehlen'}, ${optional} optional offen`,
    'cli.doctorReadyFirst': 'Bereit. Nächster Schritt: den ersten Test aufnehmen, caw-ai record <test> --target <umgebung>.',
    'cli.doctorReady': 'Bereit für caw-ai run.',
    'cli.doctorFixFirst': '{summary}. Erst die mit FEHLT beheben.',

    // explore.mjs
    'cli.exploreWhyLogout': 'Abmelden gibt es nur angemeldet',
    'cli.exploreWhyAccount': 'Benutzer- oder Kontobereich, erst nach der Anmeldung da',
    'cli.exploreWhyLandmark': 'benannte Navigation, auf jeder Seite der angemeldeten Anwendung',
    'cli.exploreWhyFresh': 'erst nach der Anmeldung da',
    'cli.exploreHttp': '{host} ohne https: Die Config erlaubt http nur auf dem eigenen Rechner (localhost, 127.0.0.1, *.localhost). Nimm die https-Adresse.',
    'cli.exploreWhyRuntime': 'zur Laufzeit erkannt',
    'cli.exploreWhyNeutral': 'kein Framework erkannt, neutraler Adapter',
    'cli.exploreWhyPackage': 'aus der package.json',
    'cli.exploreMismatch': 'Laufzeit zeigt {runtime}, die package.json {detected}.',
    'cli.exploreForeign': 'Die Anmeldung wollte auf {hosts}; das Tool ließ das nicht zu. Für SSO: auth.type storageState, Sitzung einmal mit caw-ai auth speichern; den Anmeldedienst ggf. in extraAllowedHosts.',
    'cli.exploreNoFieldSelector': 'Für Name oder Passwort fand sich kein eindeutiger Selektor; eine data-testid an den Feldern hilft.',
    'cli.exploreNoSignedIn': 'Nach der Anmeldung kam kein neues Element mit stabilem Selektor dazu; signedInSelector bitte von Hand setzen.',
    'cli.exploreNoLogin': 'Kein Anmeldeformular gesehen. Braucht die Anwendung doch eine Anmeldung, explore erneut starten und dabei anmelden.',
    'cli.exploreConsole': 'Konsolenfehler traten schon beim Öffnen auf. Nur übernehmen, was bekanntes Rauschen ist, sonst verdeckt es Fehler.',
    'cli.exploreUsage': 'Aufruf: caw-ai explore --url <adresse>, etwa --url http://app.localhost:5173',
    'cli.exploreNeedsTty': 'explore braucht ein Terminal: Du meldest dich im Fenster an und bestätigst hier. Ohne Anmeldung: --yes.',
    'cli.exploreUnreachable': '{url} antwortet nicht. Läuft der Dev-Server, stimmt die Adresse?',
    'cli.exploreSignIn': 'Im Fenster: Melde dich mit einem Testkonto an, falls die Anwendung das verlangt, und geh zur Startseite der Anwendung.',
    'cli.explorePressEnter': 'Danach hier Enter drücken: ',
    'cli.exploreSaved': 'Vorschläge in {file}: Framework {framework}, Anmeldung {auth}{signedIn}.',
    'cli.exploreSignedIn': ', angemeldet erkennbar an {selector}',
    'cli.exploreNext': 'Weiter: npx caw-ai init übernimmt {file}. Was dort TODO bleibt, trägst du in caw.config.json ein.',

    // ui.mjs
    'cli.uiOn': 'auf',
    'cli.uiLocal': 'lokaler Stand',
    'cli.uiDeployed': 'Stand der Adresse',
    'cli.uiMaxSteps': 'bis {count} Schritte',
    'cli.uiWarnings': '{count} Warnung(en) im Bericht.',
    'cli.uiReport': 'Bericht:',
    'cli.uiMoreFailures': 'und {count} weitere im Bericht',
    'cli.uiWarningsShort': '! {count} Warnung(en) im Bericht',
};
