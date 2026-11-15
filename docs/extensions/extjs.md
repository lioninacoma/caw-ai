English · [Deutsch](extjs.de.md)

# Extension: ExtJS

Active when `caw.config.json` says `"framework": "extjs"`; `init` writes it when it finds a Sencha workspace (`workspace.json`) or
an `ext`/`@sencha/*` dependency. Nothing else is needed.

What it adds:

- **Locators:** recordings use Playwright locators like any app. A component without a stable role or name (an icon-only button)
  gets `locator('extjs=button[itemId="save"]')` or `extjs=button[text="Save"]`, an `Ext.ComponentQuery` that counts only
  components that are visible and not destroyed. Generated ids such as `#button-1023` or `#ext-element-12` are refused: they change
  on every load. A text with a comma never goes into such a query, because ComponentQuery splits at every comma.
- **Waiting:** a page is quiet when `Ext.Ajax` has no open request and no store is loading. `wait-ready --for` takes a `storeId`
  or a ComponentQuery (`--for orderStore --min-count 1`).
- **Messages and dialogs:** Ext message boxes and toasts count as page messages; a target covered by a message box is explained
  with the box's text.
- **Diagnosis:** stack frames in `ext-*.js` are skipped to find the first own location; `floats.log` in the run folder lists the
  order of floating windows with timings.
- **Overlay:** with the [overlay extension](overlay.md) the Sencha watch (`sencha app watch`, default `http://localhost:1841/`)
  is the part's source; `overlay status` checks that it serves this app (`app.json`, `bootstrap.json`) and finds it on another
  port (`moved`); `doctor` shows these lines for ExtJS parts.
- **Export:** `caw export` brings the `extjs=` engine along in `caw-support.mjs`, so exported ExtJS tests run in Playwright.
- **Claude:** the guide topic `extjs` (read state through `Ext.ComponentQuery`, `isVisible()`, stores) goes to every run agent and
  is listed by `caw_guide`.
