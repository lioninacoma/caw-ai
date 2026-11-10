# Framework-Matrix

Testprojekte, mit denen geprüft wird, ob caw-ai mit den großen Frameworks funktioniert: lokal am Dev-Server, deployt als Produktions-Build und mit lokalem Code, mit laufendem Build-Watch und ohne. Claude wird nie gestartet. Die Aufzeichnungen schreibt `projekt.mjs` von Hand, so wie `record` sie schreiben würde; `caw-ai run` spielt sie ab.

| Projekt | Framework | caw-ai-Adapter |
|---|---|---|
| `react-vite` | React 19, Vite 8, React Router 7 | `react` |
| `react-webpack` | dieselben Quellen wie `react-vite`, gebaut mit webpack 5 (klassische Skripte, Chunks per JSONP, `[contenthash]` hinter einem Punkt); in der Matrix heißt es `webpack` | `react` |
| `vue-vite` | Vue 3.5, Vite 8, Vue Router 4 | `vue` |
| `angular` | Angular 21, zoneless (Standard) und Konfiguration `zone` mit Zone.js und Testability | `angular` |
| `next` | Next.js 16, App Router (SSR, `hydrateRoot(document)`) | `react` |
| `nuxt` | Nuxt 4.4 (SSR) | `vue` |

Alle zeigen dieselbe Oberfläche: Anmeldung, Ticketliste mit Ladeanzeige, Dialog „Neues Ticket“, lazy geladene Route „Info“ und einen Knopf, der einen Fehler in `explode.ts` wirft. `shared/api.mjs` ist das gemeinsame Backend, `shared/serve.mjs` liefert Builds über HTTPS auf `<name>.localhost` aus.

## Szenarien

| Szenario | Umgebung |
|---|---|
| `dev` | Dev-Server mit HMR auf `http://localhost:<port>` |
| `deployt` | Produktions-Build hinter HTTPS (`https://<name>.localhost:844x`, `insecureTls`) |
| `lokaler-build-mit-watch` | Deployter Build „deployed“ mit Hash, dazu `localBuild` aus einem laufenden `vite build --watch` bzw. `ng build --watch` („local“), ebenfalls mit Hash (react, webpack, vue, angular, angular-zone). Der Angular-Produktionsbuild hat `subresourceIntegrity`: Der lokale Code kommt nur an, weil caw-ai die `integrity`-Attribute aus dem deployten HTML nimmt. |
| `lokaler-build-ohne-watch` | wie oben, aber ohne lokalen Build: erwartet ist `watch-missing` (Exit 2) |
| `lokaler-code-mit-watch` | nur react: `statics` mit festen Dateinamen (`FIXED_NAMES=1`) |
| `lokaler-code-ohne-watch` | nur react: wie oben ohne lokalen Build, erwartet Exit 2 |

Je Szenario laufen zwei Tests: `smoke` muss bestehen; `fehler` muss als Fehler der Anwendung scheitern, die Quelle `explode.ts` steht in der Spalte `quelle`. `smoke` legt ein Ticket an und prüft die Build-Kennung (S1), öffnet Info und prüft die Kennung dort noch einmal, denn Info ist ein lazy Chunk (S2). Bei react und webpack bedient S3 zusätzlich ein Feld in einem iframe (`frame` im Ziel) und eine Web Component mit offenem Shadow Root.

## Ausführen

```bash
cd e2e/frameworks
for d in react-vite react-webpack vue-vite angular next nuxt; do (cd $d && npm install); done
node matrix.mjs            # alles, etwa 10 Minuten
node matrix.mjs nuxt       # nur Szenarien, deren Name "nuxt" enthält
```

Braucht Node 22.12+ und Chrome. Ergebnisse, Logs der Server und je Lauf Ausgabe und `report.md` landen in `ergebnis/`, die Zusammenfassung in `ergebnis/matrix.json`.
