---
status: accepted
---

# Teaching captures required scans for later Runs

Teaching captures Scan Requirements for later Runs rather than executing scans during the user-led recording. A requirement belongs to a named journey outcome, such as an open cart drawer. The agent identifies when that outcome has been reached, and Contingency tracks whether the required scan occurred. This preserves the agent-owned execution model in [ADR 0044](./0044-agents-own-flow-skill-execution.md) while making a requested scan an obligation rather than an optional suggestion.

Accessibility uses one axe scan of the current Page state without reloading. This design does not introduce accessibility start and stop intervals.

## Authoring and placement

The comment composer has two compact scan buttons beside Attach element. Performance opens the mode popover; Accessibility adds a snapshot scan directly. The `@performance` and `@a11y` shortcuts open the same configuration popover. Ordinary words do not execute scans. Only an explicit selection creates a scan chip. Submitting the comment saves its scan settings alongside its text.

The learning agent infers the scan's journey condition from the Instruction's position, attached element, and recording evidence. It writes that condition into the learned Flow Skill for user review and requests clarification when the evidence is ambiguous.

Performance offers **Page load** and **Interaction timespan**, with explicit mode selection. Page load configuration must distinguish an explicit reload from measurement of an upcoming navigation. A generic performance request does not silently select a mode. Interaction timespans have taught start and stop points.

## Lifecycle and scope

An Interaction timespan that does not reach its taught stop condition ends collection when the Run ends. Its retained Scan Report is marked partial with the reason, and it does not fulfill the Scan Requirement. Flow Skill review flags an unmatched taught start.

Page load configuration offers **Reload at this point** and **Measure the next navigation**. Measuring the next navigation arms collection before the navigation occurs. The reviewed Flow Skill names the expected destination so an unrelated navigation cannot fulfill the requirement.

A complete Dry Run must fulfill every Scan Requirement in the Flow Skill. A deliberately partial Interactive Run applies only the requirements within its requested journey. Later requirements are reported as outside the requested scope and do not extend the task.

## Evidence and results

Scan completion is required, but clean scan findings are not required by default. Journey success and scan findings remain separate conclusions. Thresholds or accessibility rules that affect success require explicit configuration. A crashed or unexecuted scan does not count as completed.

Workspace presents each scan's taught condition, mode, completion status, and findings, with a link to its full report. The agent receives a bounded summary and report reference.

## Measurement and recovery

An Interaction timespan measures the whole elapsed interval, including agent reasoning time. Its report shows duration and identifies it as an agent-driven interaction measurement.

Only one scan may be active per Run, and it belongs to one tab. Flow Skill review flags overlapping requirements. Takeover or loss of the measured tab ends an active measurement as partial. A new tab requires a separate Scan Requirement. Same-tab navigation may continue within a timespan where the engine supports it. Accessibility scans cannot overlap performance collection because scanner work would contaminate the measurement.

Scans preserve the Run's Emulation and authentication without implicit storage reset or extra throttling. Reports record effective settings and engine versions. An explicitly taught reload can still discard transient page state.

Each requirement is fulfilled once per requested execution of its relevant journey. All attempts remain evidence, but revisiting a condition during recovery does not automatically repeat a fulfilled scan. Scanner failures permit bounded retries. Any retry that reloads or navigates must remain valid under the taught requirement.

## First-version scope

The first version produces reports and tracks required scan completion. Configurable pass/fail gates and baseline comparisons are deferred. Accessibility uses a documented ruleset and distinguishes definite violations from results needing human review.

## Durable requirements

Structured Scan Requirements live in the Flow Skill's `references/scans.json`. `SKILL.md` names the file and references each requirement's stable ID at the relevant journey points. The file carries scan modes and journey conditions. Contingency validates it and links scan evidence to its requirements; the agent retains control of its route. Requirements survive Teaching Recording Cleanup without retaining the original comments or captured media.

## Timespan authoring

After a start marker is added, the composer offers **End timespan**, naming the open measurement. The `@performance` shortcut offers the same action. Start and stop share a requirement ID. Teaching shows an **Open timespan** indicator to identify an authored interval, not active measurement. An unmatched start may remain in a draft but blocks Dry Run readiness until repaired.

## Completion enforcement

A missing, failed, or partial applicable scan leaves scan coverage incomplete without replacing the journey's Agent Assessment. Such a Dry Run cannot pass verification. An Interactive Run may end with incomplete scan coverage, which its Run Summary presents prominently.

A scanner failure permits at most one automatic retry. Further attempts require an explicit user request, and retries remain subject to the taught reload and navigation behavior.

## Accessibility defaults

The first version scans the whole current Page with axe's WCAG A and AA rules through version 2.2, plus best-practice rules. Experimental and AAA rules are excluded. Reports distinguish definite violations from needs-review results and disclose frame or content coverage limitations. The attached element informs the journey condition and does not restrict the scan to that element. Rule groups are documented in [axe's rule descriptions](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md).

Scan Reports follow their owning Run's evidence lifecycle, including Cleanup for Dry Run evidence. This design does not change evidence retention or disclosure policy.

The user selected the scan-button prototype and authorized implementation. It introduces a new contract rather than restoring the superseded deterministic Audit Steps in ADR 0005 or navigation toggles in ADR 0008.
