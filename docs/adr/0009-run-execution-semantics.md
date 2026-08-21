# Run execution semantics

A **Run** validates before it opens a browser, aborts and retries on Step failure, classifies why it failed, and persists a self-contained artifact on every path that reaches an outcome — completed or failed, first attempt or last. A Run cancelled before it reaches one writes no Run record; what it did produce still says which Run produced it, so nothing on disk is unattributable. The consequences below give the reasoning. These rules apply to headless CLI Runs and, later, to Audit View, because [ADR 0002](./0002-cli-is-the-sole-runner.md) gives both one engine.

## Preflight

Structural invariants belong to the `Flow` schema — a document with `performance: true` on a non-navigating Step is malformed wherever it is read. Invocation-dependent checks belong to a Runner preflight pass that runs before any browser opens and reports every problem at once: unsupplied Variables, unwritable output paths. Create View must be able to save a Flow whose Variables are not set on the authoring machine, so environment checks cannot live in the schema.

Preflight fails closed. A Flow that declares a Variable with no supplied value never starts, rather than typing an empty string into a login form and surfacing an unresolvable selector eight Steps later.

## Failure and retry

A failed Step aborts the attempt. The Runner creates a fresh session and retries, `--retry` times, default 3. The Run artifact always records the attempt count and each attempt's failure — a Flow that fails half the time must never report a silent green.

Failures are classified: `siteError` for navigation and HTTP-level failure, `flowError` for a selector that stays unresolvable across retries. The distinction routes to different people — a stale selector is authoring debt, a failing navigation is the signal Contingency exists to catch — and collapsing them into one Alert channel makes the channel ignorable.

Pre-steps are exempt. Their job is clearing interference that may not be present, so a Pre-step whose action fails is skipped, not fatal; the real Step fails on its own if the interference genuinely blocked it. Every Pre-step evaluation is recorded regardless of outcome.

A Run holds a process-wide semaphore (one Run at a time; concurrent Runs contend for CPU and corrupt Core Web Vitals for both) and a total wall-clock ceiling, default 5 minutes, since per-Step timeouts do not bound a long Flow under retry.

## The artifact

One directory per Run under the state directory, keyed by a stable `flowId` rather than the user-editable `Flow.title`. It embeds the full Flow JSON plus a content hash, so a Run is independently interpretable when uploaded to a bucket or attached to a Handoff without its Flow file, and so Baseline comparison can cheaply detect that the Flow changed underneath it. Large by-products — the Lighthouse raw report, video segments — sit beside `run.json` rather than inside it, so Audit View can load a Run summary fast.

Failed Runs are ineligible as a Baseline.

Findings never affect the exit code: `0` means the Run completed, `1` means it did not. Every site has pre-existing accessibility violations, so failing a build on Finding count makes the build red on day one and the check gets disabled. The thing that should break a build is a Regression.

## Consequences

- Whether video was captured is recorded in the Run, because capture overhead perturbs the metrics and a recorded Run may not be comparable to an unrecorded Baseline.
- Finding identity — the key that matches a Finding to its counterpart in a Baseline — is deliberately deferred with Regressions. Runs written before that scheme exists may not be retroactively comparable.
- A single-use runtime secret such as a 2FA code cannot survive a retry. Preflight warns on that combination and suggests `--retry 0` rather than refusing or staying silent.
- **An interrupted Run writes no `run.json`, deliberately.** A Run that was cancelled neither completed nor failed, and `RunOutcome` offers only those two. Recording it as either would be a lie the rest of the system acts on: `runIsBaselineEligible` keys on the outcome, so a half-finished Run would either anchor comparisons it has no business anchoring, or report a failure the site never caused.
- The weaker guarantee an interrupted Run does keep is **attribution, not self-containment**. A video manifest names the Run it belongs to and accounts for each attempt's recording ([ADR 0010](./0010-run-video-is-unredacted.md)), so a stray `.webm` can always be traced and explained. It carries neither the Flow nor the Steps executed, and is not a substitute for a Run record.
- Inspecting interrupted Runs, if that is ever wanted, needs a third `RunOutcome` and the Baseline rules updated to match — a protocol change with its own tests, not a partial record wearing one of the existing two.
