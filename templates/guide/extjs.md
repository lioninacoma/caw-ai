# caw: ExtJS applications

Applies when `framework` is `extjs` (in `task` and in the config).

- **Waiting:** `wait-ready --for` takes a `storeId` or a ComponentQuery, e.g. `--for orderStore --min-count 1` or
  `--for "grid#orders"`. Without `--for`, waiting does not see stores without a `storeId`.
- **Reading state:** `eval` through `Ext.ComponentQuery.query('...')`, e.g.
  `Ext.ComponentQuery.query('grid#orders')[0].getStore().getCount()`. Check visibility with `isVisible()`; fragments of closed
  windows can stay in the DOM. Read single values, never whole components (not serialisable). ViewModel data and stores can be
  read the same way; never change them.
- **Targets:** snapshot references work as everywhere. A component without a stable role or name (an icon-only button) gets a
  locator `locator('extjs=button[itemId="save"]')` or `extjs=button[text="Save"]`, a ComponentQuery evaluated by caw. Never use
  generated ids such as `#button-1023` or `#ext-element-12`: they change on every load. A text or title with a comma never goes
  into such a query, because ComponentQuery splits at every comma.
- **Floating windows:** message boxes and floating panels cover the page. If an action fails because its target is covered by
  a message box, the action before did not close it; look at the message first (topic `cause`). `floats.log` in the run folder
  lists the order of floating windows with timings.
