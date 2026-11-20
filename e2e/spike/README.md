# Baseline-learning spike

Decides by data how caw should learn request baselines and step effects. Not shipped (outside `files` in package.json;
`scripts/pack-check.mjs` rejects `e2e/`).

| File | What it is |
| --- | --- |
| `app.mjs` | Todo app (from examples/errand). Host `a.localhost` is the recording environment (empty list, no third-party script), `b.localhost` a shared one (foreign rows, a third-party widget, twice the latency), `cdn.localhost` serves the widget. `POST /test/profile` sets the seeded noise and one injected regression. |
| `project.mjs` | caw config with environments a and b, and the test `spike-errand` with a hand-written recording (recordedOn a, no baselines, no effects). |
| `capture.mjs` | Runs the test headless through `caw run` and appends one JSON line per run: `steps[]` of result.json, results, failures, diagnosis, profile, environment and the row titles. |
| `methods.mjs` | M0 (today, using the real effects.mjs and diagnose.mjs functions), M1, M2, M3, M4, M5 and the modifier V. |
| `simulate.mjs` | Bootstrap sequences over the capture, every metric, the decision rule, a Markdown report. |

Unit tests: `test/spike-methods.test.mjs`, `test/spike-simulate.test.mjs`, `test/spike-app.test.mjs` (synthetic data from
`test/spike-fixtures.mjs`, plain HTTP, no browser). They run in `npm test` and take a few seconds.

## Run

Capture needs Chrome (as every headless caw run) and the loopback port 18320. It runs serially; nothing else should use
the browser while it runs.

```
node e2e/spike/capture.mjs
```

Default plan: 150 healthy runs on each of a and b, 30 runs per regression kind on a (10 kinds), interleaved per environment:
600 runs; at an estimated 10 to 15 s each (not measured: this package was built without browser runs) roughly 2 to 2.5 hours. Progress and the time left are printed per run; caw's own
output goes to `e2e/spike/work/capture.log`. The JSONL goes to `e2e/spike/data/capture.jsonl` (appended: delete it for a
fresh capture). Flags:

- `--healthy N`, `--regressions N`, `--kinds control-removed,view-text,...` (default all), `--envs a,b`
- `--regression-envs a,b` also injects regressions on b: needed for the detection row of the cross-environment table
  (adds 300 runs)
- `--mode live` runs outside CI, so the product learns as today and the recording changes: a check of the offline M0
  against the product (each line then says whether the run changed the recording)
- `--out file`, `--seed N`, `--port N`

Then:

```
node e2e/spike/simulate.mjs
```

Reads `e2e/spike/data/capture.jsonl`, writes `e2e/spike/data/report.md` (and prints it). 500 sequences of 30 runs per mode
and method, creep sequences of 100 runs: about 1.5 to 2 minutes. Flags: `--in`, `--out`, `--sequences`, `--length`,
`--seed`, `--creep-length`, `--methods M0,M1,...`.

## What the simulation does

- A sequence draws healthy runs of a with replacement; at a random run (10 to 24) one regression kind starts and stays.
  Every method sees the same sequences.
- dev mode: every run judges, then learns (as a run outside CI). ci mode: 10 dev runs learn first, then the sequence never
  learns (CI without `--learn`).
- Check, target and hard failures come from the captured run (the product decides them, whatever was learned); effect
  failures, warnings and slow flags are recomputed per method.
- Detection counts at the step the fault is injected in (`REGRESSION_STEP` in app.mjs); a warning elsewhere is noise.
- Churn renders what a method keeps through the product's `renderRecordings` and counts changed lines.
- Cross-environment: learned on a (10 dev runs), judged on b under today's rule and options (a) compare only where
  learned, (b) learn per environment, (c) `effects.fail: []` on other environments.
- Diagnosis: the product's `diagnose()` with the method's baseline and deviation, against the injected fault's side.

## Decision rule (fixed before the data, `RULE` in simulate.mjs)

A method passes if in dev and in ci mode it has at most 1 effect false failure per 100 healthy runs, detects at least 95%
of control-disabled, control-removed and console-error within one run (fail or warn), and writes the recording at most
once per 20 runs in dev mode from run 10 on. The winner is then confirmed with 50 real runs (plan P2).

## Known limits

- result.json keeps view lines without their indentation, so V is simulated with the app's row titles as an oracle. In the
  product it is a filter on the ARIA tree (`viewLinesWithoutRows` in methods.mjs).
- Raw runs never learn, so replay's re-measuring of controls that would fail (replay.mjs `controlsFail`) never happens in
  the capture; a capture in `--mode live` shows whether that matters.
- Retries and warm-up steps of the product are not modelled: the spike test has no retry.
