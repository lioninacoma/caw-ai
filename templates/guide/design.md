# caw: develop against a target design

A step in a test plan can carry a target design: what its screen should look like once it is built. The person writes it into
the test file (`design: design/order-form.html`), next to `needs:` (locators that must be on the page before the step can be
recorded). Both belong to the person: they are never part of a plan you write, and changing them never makes a step stale.

**What caw judges.** In a run, after a step's check passed, caw renders its `.html` design in a separate headless browser
(no scripts, no network, the step's recorded viewport) and compares the structure with the app's page: the controls (role,
label, flags), the view lines (headings, buttons, links, landmarks, field labels) and per control font-size, font-weight,
color, background-color, border-radius and padding. List rows, free text, numbers and whether a field is filled are data and
do not count. Anything missing or a differing style: the step fails with kind `design` (with `design.fail: []` in the config it
only warns). Controls only in the app are reported but do not fail. The replay goes on; the step is not retried and learns no
effects in that run. A `.png` design is judged by pixels against the step's screen (run tag, remembered values, dates, list
rows, list entries, cards and `visualIgnore` masked): above `visual.designMaxRatio` differing pixels it fails the same way,
with a difference image `agent/step-S<n>-diff.png`. `result.json` holds per judged step `design: { file, verdict, missing,
extra, styleDiffs }` (a `.png` also `ratio` and `diff`). With design tokens in `caw/design` each passed step also gets `lint`
findings (colors off the tokens, spacing off the scale, contrast, clipped text, unnamed controls): warnings unless
`design.fail` has `"lint"`.

**A learned look.** `look: true` on a step (also only the person's: never set or remove it yourself; caw may suggest steps to
the person after `record`) learns that step's look and then fails with kind `visual` when it changes. A look learns when
the step passes in a run outside CI (in CI only with `--learn`) on the environment it was recorded on. Its style lines (per
role and style, how many controls have it; controls inside masked areas such as rows, list entries, cards and `visualIgnore`
do not count) learn in every such run, with a window too: the first stores them, the second confirms them (a count that
differed becomes `×?`), then they are compared. Its pixels learn only in headless runs, per platform, at a fixed viewport (the
recorded one, else 1920 x 1080): the first headless run stores the image, a second one whose image matches confirms it (one
that differs replaces it and starts over), then it is compared. A run with a window compares the styles only
(`pixels: "headless-only"` in `result.json`; a CI run without `--headless` warns about it). Only the person takes a changed
look over ("{{label:run.button.adoptLook}}", which deletes the step's images of every platform). A change only pixels see has
no such button: the failure names the image file `caw/recordings/<test>/<step>.<platform>.png`; only the person deletes it,
the next two headless runs then learn it anew. For screens whose data changes,
only the person freezes the data of the app's reads ("{{label:run.button.freezeData}}" after a passed run with a window, into
`caw/recordings/<test>/fixed-data.json`); headless runs then compare those looks in a separate pass on the frozen answers. You
cannot freeze data and never write that file; when the fixed data no longer fits the backend, say so and leave it to the
person. The person sees the design over the app with `caw open <test>@S<n> --design` (F7
toggles it); a deviation they click there reaches you as an element, as `/element` does.

**Fetch and write a design.**
1. Get the design yourself: a Claude Design artifact (read it with your own tools and save one screen as a self-contained
   `.html` page with inline CSS), or a Figma export (HTML or PNG, tokens as DTCG JSON). caw never fetches anything.
2. Write it with `caw_design` `{action: "put", file: "design/<name>.html", content}`; a PNG goes as `base64`, design tokens as
   `design/<name>tokens.json` (DTCG: every token has `$value`). Never write into `caw/` with your own Edit or Write tools.
3. Link it to a step only when the person asked for exactly that: `caw_design` `{action: "link", test, step, file,
   personAsked: true}`. `{action: "list"}` shows the design files and which steps link them.

**Implement until it is met.** Change the application's code (when the person asked you to), then let the person run the test
(`caw_start` `run`) or run it yourself when they asked. A failed `design` step names what is missing and which styles differ:
build exactly that. The test file stays as it is; there is nothing to fix in the step. When the first pending step's `needs`
are all on the page at the end of a run, caw says it is ready to record: `caw record <test>@S<n>`.
