# caw: develop against a target design

A step in a test plan can carry a target design: what its screen should look like once it is built. The person writes it into
the test file (`design: design/order-form.html`), next to `needs:` (locators that must be on the page before the step can be
recorded). Both belong to the person: they are never part of a plan you write, and changing them never makes a step stale.

**What caw judges.** In a run, after a step's check passed, caw renders its `.html` design in a separate headless browser
(no scripts, no network, the step's recorded viewport) and compares it with the app's page. Met means: it looks like the
design, except data. Compared are the controls (role, label, flags) and view lines (headings, buttons, links, landmarks); the
static texts (headings, labels, paragraphs); the looks (per control font-size, font-weight, color, background-color,
border-radius, padding and first font-family; per text first font-family, font-size, font-weight, font-style and color; per
block with a background, border or shadow those); and the layout from neighbour to neighbour in document order: relation
(below, above, right of, left of, inside), gap, indent in the block, sizes of controls, blocks and images, within 1 px.
**Data** (the same rule in design and app) keeps its place and font but not its text: lists and tables with their rows,
elements marked `data-caw-data`, field values and `<output>`, a text equal to a field's value, and texts with a digit, the
run tag or a remembered value. A sample text without a digit that is data in the app (a name, a status) needs
`data-caw-data` in the design and in the app. Anything missing, a changed text, a differing style or layout: the step fails
with kind `design` (with `design.fail: []` in the config it only warns). Controls only in the app are reported but do not
fail. The replay goes on; the step is not retried and learns no effects in that run. `result.json` holds per judged step
`design: { file, verdict, missing, extra, styleDiffs, layoutDiffs, textDiffs }`; the lines read like
`gap button "Save" → block "Note": 19px → 43px`, `block "Note": below button "Save" → above button "Save"`,
`heading "Note": font-family Georgia → Arial`, `text: heading "Note" → "Notes"`.

**A learned look.** `look: true` on a step (also only the person's: never set or remove it yourself; caw may suggest steps to
the person after `record`) learns that step's look and then fails with kind `visual` when it changes. A look learns when
the step passes in a run outside CI (in CI only with `--learn`) on the environment it was recorded on. Its style lines (per
role and style, how many controls have it; controls inside rows, list entries, cards and `visualIgnore` areas
do not count) learn in every such run, in a window and headless alike: the first stores them, the second confirms them (a
count that differed becomes `×?`), then they are compared. Only the person takes a changed look over
("{{label:run.button.adoptLook}}"). The person compares the app with the design with `caw open <test>@S<n> --design` (from
your session `caw_start` `{command: "open", test, step, design: true}`), or from the card of a design not met with
"{{label:run.button.openDesign}}": a page over the workbench (F7 opens and closes it, Esc closes it) with app and design side
by side, overlaid or only their differences, and the deviations as numbered cards that mark their element in both images. It
is computed anew after a reload or a restored state. Its "{{label:run.button.buildDesign}}" asks the person in the chat, as
the card of a design not met does (`design.unmet`, option `ask`); on yes you get the task with the deviations as a message.

**Fetch and write a design.**
1. Get the design yourself: one artboard of a Claude Design artifact as a static page ("Take a draft from a Design artifact"
   below), or a Figma export as HTML. caw never fetches anything.
2. Write it with `caw_design` `{action: "put", file: "design/<name>.html", content}`. Never write into `caw/` with your own Edit or Write tools.
   A design a step already links is what that step is judged against: replace it only when the person asked for it, with
   `personAsked: true`; without it `put` refuses and names the steps.
3. Link it to a step only when the person asked for exactly that: `caw_design` `{action: "link", test, step, file,
   personAsked: true}`. `{action: "list"}` shows the design files and which steps link them.

**Implement until it is met.** Change the application's code (when the person asked you to), then let the person run the test
(`caw_start` `run`) or run it yourself when they asked. A failed `design` step names what is missing and which styles differ:
build exactly that. The test file stays as it is; there is nothing to fix in the step. When the first pending step's `needs`
are all on the page at the end of a run, caw says it is ready to record: `caw record <test>@S<n> --env <env>`.

**A pending step's design.** A pending step is not judged after its check (it has none yet). Instead, a run that ends healthy
at the pending tail judges the first pending step's design at that step's entry, the state the run ended in: `result.json`
and `caw_status` (`result.pendingDesign`: `step`, `file`, `verdict`, `missing`, `textDiffs`, `styleDiffs`, `layoutDiffs`,
`extra`), the terminal and the chat ("Target design of S4 at its entry: …"). It fails nothing and changes no exit code; once
the step is recorded, it is judged after its check like any other. The entry is the screen before the step's own actions: a
design of their result (an opened dialog, a saved message) can only be met there as far as it shows the same screen.

## Take a draft from a Design artifact

A Claude Design artifact is a canvas: `project/canvas.json` lists its artboards (`boards`: file, `w`×`h`, `title`), and each
artboard `project/<name>.dc.html` is a template for the canvas runtime: markup in `<x-dc>` with `{{holes}}`, `<sc-if>` and
`<sc-for>`, a `<helmet>` with styles and font links, and a `<script type="text/x-dc" data-dc-script>` whose `renderVals()`
fills the holes from the props declared in `data-props`. caw renders a design without scripts and network, so `put` refuses
an artboard; write it as a static page:

1. Read it with your Artifact tool: `{action: "read", url, paths: ["project/canvas.json", "project/<name>.dc.html"]}`. The
   artboard is the one the person names (by its title, or `#artboard-<name>` in the link); unsure which, ask.
2. Choose the props that show the target screen: the person's words, else the `default`s in `data-props`; review aids
   (numbered marks, switches that show a deviation) off. Read `renderVals()` and work out what it returns for them; nothing of
   the artifact is run.
3. Write the page: `<!doctype html>`, `<html lang>` and `<title>` as in the artboard; `<head>` with `<meta charset="utf-8">` and
   the content of `<helmet>`; `<body>` with the markup inside `<x-dc>` (without `<helmet>`), in which every `{{path}}` becomes
   its value (HTML-escaped, in attributes too), every `<sc-if value="{{x}}">` its content when `x` is true and nothing
   otherwise, every `<sc-for list="{{items}}" as="item">` its content once per item (`{{item.x}}`, `{{$index}}`), and every
   `<dc-import name="Card" …>` the sibling `Card.dc.html` converted the same way with those props. Leave out
   `<script src="./support.js">` and the `data-dc-script` script. Everything else stays exactly as it is: inline styles, texts,
   whitespace. The page made this way is judged exactly like the artboard rendered by its runtime (measured: no deviation).
4. `put` it, as above. A `{{hole}}`, `<x-dc>` or `<sc-if>` left over is refused with the reason.

**Not in the app's style.** Before you build, put the draft's fonts, colors, sizes and frame next to the app's CSS. A draft that
only approximates the app (its own fonts, its own paddings, a fixed-size artboard with its own background) is met only once
the app takes over all of it: measured on a note draft in its own fonts against an app that implements the note exactly,
43 style and 20 layout deviations (`heading "Note": font-family Fraunces → Iowan Old Style`, `select "Move to": padding 8px
10px → 9px 12px`, `indent block "D" → link "← All todos": 22px → -317px`), none of them the note. Then tell the person what
differs and let them choose, for example: (a) the draft is redone in the app's style and only the new part is built
(recommended when they want the new part, not a new look), (b) the app is built to the draft, its look changes on this
screen, (c) they change the draft themselves.

**Drafting in the app's style.** When you draft a screen (in a Design artifact or directly as the page), or tell the person what
to ask for in theirs:
- Read the app's CSS and take it over as it is: the custom properties (`:root` in `<helmet><style>`, used as `var(--x)`), font
  stacks, sizes in the app's units, paddings, radii, colors. Use the app's fonts, no web font the app does not load.
- Draw the screen as the app shows it: the same page container (max width, margins), the same frame around the new part
  (header line, back link, card), as a page (`"expand": "fill"` in `canvas.json`), not as a fixed-size board with its own
  background. Its width is the width the test is recorded at (`viewport` in `caw/recordings/<test>.yaml`).
- Data as data: a sample with a digit (number, date, ID) is data by itself, a text equal to a field's value too; a value the
  app shows in an `<output>` is an `<output>` in the draft (as plain text, `When: Tomorrow` became `text: "When: Tomorrow" →
  "When:"`); a sample text without a digit that is data in the app (a name, a status) gets `data-caw-data` in the draft and in
  the app.
- No review aids on the screen (numbered marks, notes): they become texts and blocks of the design.

**Fonts.** The design renders offline: a font it loads from the network (Google Fonts) does not load, the page falls back. The
comparison reads the font's name, not its glyphs, so the name still counts; text widths change (measured on the draft above:
a heading 333 → 312 px, buttons below 1 px, no deviation). If the app loads web fonts of its own and the deviations name
widths or gaps of texts and controls, embed the app's font files in the design as `@font-face` with a `data:` URL: they load
offline (the file stays below 2 MB).

## Write a test for a design

When the person asks you to write a test for a design ("write a test for this design", a Claude Design artifact, a Figma
export), that request is their consent to link the design to the step that ends on its screen (`personAsked: true`) and to
build that screen in the application's code. Ask them only for what a gate requires: a `human` decision (topic `session`),
restarting their dev server, test users.

1. **The design:** fetch it and write it with `caw_design` `put` (above); an artboard of a Design artifact as a static page
   ("Take a draft from a Design artifact"). Not in the app's style: tell the person before you build (same section). One
   test per design.
2. **The reach:** plan the steps that lead to the screen's entry and already work in the app (topic `tests`; one test,
   written into `caw/tests/<test>.yaml` as the plan so far, without `design:` and `needs:`). Check it with `caw_validate`,
   then record it without a window: `caw_start` `{command: "record", test, headless: true}`; you are the agent and follow the
   plan unchanged (topic `session`, 7.). caw adopts it when nothing the test checks changes. If even the first step needs
   the new screen, build what it needs first (step 4), then record.
3. **The design's step:** add the step(s) that do what the design shows at the end of the test (next free number; they stay
   pending), the last one ending on the designed screen, and link the design to it: `caw_design` `{action: "link", test,
   step, file, personAsked: true}`. `caw_validate` again.
4. **Build until met:** change the application's code. If the dev server must restart to serve the change, ask the person
   to restart it (with `start` in the config, `caw_start` with `start: true` does it). Then `caw_start` `{command: "run",
   test, headless: true}`, `caw_status` with `wait` until it ends, and read `result.pendingDesign`: build exactly what
   `missing`, `textDiffs`, `styleDiffs` and `layoutDiffs` name (data never counts, topic above). Repeat until `verdict` is
   `met`. To look at it together, `caw_start` `{command: "open", test, step, design: true}` shows the design over the app.
5. **Record the whole test:** `caw_start` `{command: "record", test, headless: true}` (re-recording from a step is refused
   without a window). The check run after it judges the design after the step's check; not met there, build and record again.
   A decision that needs the person waits for their consent through `caw_decide`, or they answer in the window.
6. **Prove it:** `caw_start` `{command: "run", test, headless: true, strict: true}`. Report "green, design met" only when the
   run passed with nothing pending and the step's `design` in `result.json` (`steps`) has `verdict: "met"` with `missing`,
   `textDiffs`, `styleDiffs` and `layoutDiffs` all empty; name the run and its report as evidence. Not met: back to 4 (the
   recording stays, unless the steps changed).
