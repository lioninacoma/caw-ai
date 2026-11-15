[English](extjs.md) · Deutsch

# Erweiterung: ExtJS

Aktiv, wenn in `caw.config.json` `"framework": "extjs"` steht; `init` schreibt das, wenn es einen Sencha-Workspace
(`workspace.json`) oder eine Abhängigkeit `ext`/`@sencha/*` findet. Sonst braucht es nichts.

Was sie hinzufügt:

- **Locators:** Aufnahmen nutzen Playwright-Locators wie bei jeder App. Eine Komponente ohne stabile Rolle oder Namen (ein Button
  nur mit Symbol) bekommt `locator('extjs=button[itemId="save"]')` oder `extjs=button[text="Speichern"]`, eine
  `Ext.ComponentQuery`, die nur sichtbare, nicht zerstörte Komponenten zählt. Generierte Ids wie `#button-1023` oder
  `#ext-element-12` werden abgelehnt: Sie ändern sich bei jedem Laden. Ein Text mit Komma kommt nie in so eine Abfrage, weil
  ComponentQuery an jedem Komma trennt.
- **Warten:** Eine Seite ist ruhig, wenn `Ext.Ajax` keinen offenen Request hat und kein Store lädt. `wait-ready --for` nimmt eine
  `storeId` oder eine ComponentQuery (`--for orderStore --min-count 1`).
- **Meldungen und Dialoge:** Ext-Messageboxen und Toasts zählen als Seitenmeldungen; ein von einer Messagebox verdecktes Ziel wird
  mit dem Text der Box erklärt.
- **Diagnose:** Stack-Einträge in `ext-*.js` werden übersprungen, um die erste eigene Stelle zu finden; `floats.log` im Laufordner
  listet die Reihenfolge schwebender Fenster mit Zeiten.
- **Overlay:** Mit der [Overlay-Erweiterung](overlay.de.md) ist die Sencha-Watch (`sencha app watch`, standardmäßig
  `http://localhost:1841/`) die Quelle des Teils; `overlay status` prüft, dass sie diese App ausliefert (`app.json`,
  `bootstrap.json`), und findet sie auf einem anderen Port (`moved`); `doctor` zeigt diese Zeilen für ExtJS-Teile.
- **Export:** `caw export` bringt die Engine `extjs=` in `caw-support.mjs` mit, damit exportierte ExtJS-Tests in Playwright laufen.
- **Claude:** Das Guide-Thema `extjs` (Zustand über `Ext.ComponentQuery` lesen, `isVisible()`, Stores) geht an jeden Lauf-Agenten
  und wird von `caw_guide` gelistet.
