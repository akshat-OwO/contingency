---
status: accepted
---

# Agents own Flow Skill execution

Flow Skills keep their written procedures, but infrastructure stops enforcing ordered Agent Steps. The agent interprets stopping points against the instructions and observed browser state. This lets a user request part of one Flow Skill and then use another without encoding that journey as a fixed execution sequence.

An Interactive Run starts from a user-requested task with optional Flow Skills. It can use multiple Flow Skills in the same browser context. Switching Flow Skills preserves the current page, tabs, authentication, and other browser state. The user may change the task during the Run, and the changed instruction is recorded without resetting the browser.

Infrastructure stores no active Agent Step, step assessments, or step coverage for new Runs. Package validation still checks the numbered procedure and its `Done when:` lines. The external agent owns its plan and progress in the conversation. Browser evidence and task results remain infrastructure responsibilities.

The Run Summary assesses the user's requested task and records evidence-backed findings. Completing each referenced Flow Skill is not required when the task intentionally uses only part of it. Recording a failure keeps the browser open so the agent can investigate, retry, or continue. The agent explicitly completes the Run when its work ends. User closure and process exit also end it.

The requested task defines the agent's authority to explore and recover. Pursuing an unrelated task requires user authorization. Confirmation remains required for each irreversible or high-impact action attempt. The Run's Domain Scope includes the declared hosts of the Flow Skills the user requests, including skills requested later. When no skill supplies a scope, the starting host establishes it. Visiting an unrelated host still requires intervention. Removing Agent Steps therefore also reopens their role in action authority in [ADR 0027](./0027-agent-authority-has-a-user-approved-execution-boundary.md).

The starting Emulation remains in effect throughout the composed Run, even when another Flow Skill was taught under a different Emulation. Future Suite members retain their isolated contexts under [ADR 0031](./0031-suite-setup-seeds-isolated-member-contexts.md). A composed Interactive Run deliberately shares state, while a Suite checks its members independently.

Dry Runs give the agent the same freedom to explore, recover, and take another route. Verification still requires demonstrating the Flow Skill's intended outcome through a complete Dry Run. An intentionally partial execution does not qualify the Flow Skill for verification.

The agent explicitly assesses the Dry Run's outcome with an explanation and supporting browser evidence. Infrastructure validates the report rather than deriving success from numbered steps. A Dry Run with user Takeover cannot pass. A passing report still requires user verification before Cleanup. This accepts an agent-reported outcome, which [ADR 0041](./0041-dry-run-results-are-derived-from-agent-assessments.md) rejected, to give the agent freedom over its route while retaining evidence and user review.

Inputs are requested when needed, rather than requiring every declared input at startup. Values remain scoped to their Flow Skill so equally named inputs in different skills can differ. Secret handling remains in effect. A Dry Run uses fresh inputs when needed rather than inheriting demonstrated values.

Historical Run Summaries retain their original step assessments and remain readable. New Runs use task results. Existing evidence is not rewritten to imply execution under the new contract.

Existing evidence capture, Run Summary video, secret input handling, redaction, and confirmation before transmitting sensitive video remain in effect. Agent Assessments remain model judgments and do not produce automatic alerts. This decision changes execution ownership rather than evidence retention or disclosure.

This decision supersedes the ordered assessment contract in ADR 0041 and the assessment-triggered termination contract in [ADR 0043](./0043-agent-runs-have-no-wall-clock-ceiling.md). It replaces active-Step authority in ADR 0027 with requested-task authority. It retains fresh-context Dry Runs, saved Teaching Emulation, user verification, and Cleanup from [ADR 0039](./0039-flow-skills-are-learned-from-temporary-teaching-recordings.md), and the absence of wall-clock ceilings from ADR 0043.

## Implementation status

Issue #320 records the accepted design and its ordered delivery phases. Issue #321 defines version 3 task Run contracts and storage alongside explicit version 2 legacy summaries. The existing runtime continues to produce step-based Runs during integration. Task lifecycle and tools, authority and assessment validation, Workspace presentation, and end-to-end proof remain in #322 through #325. The connected execution path must ship together.

Version 3 stores the original requested task, append-only changed instructions, zero or multiple referenced Flow Skills, skill-scoped input and Variable identities, task assessment and findings, starting Emulation, and browser evidence. Live state carries a running or ended lifecycle. A persisted summary records the execution ending separately from its nullable Agent Assessment: completion, user closure, process exit, crash, or interruption never supplies a missing task judgment. Findings do not terminate a Run.

Version 2 remains the historical ordered-step representation, including assessment counts, coverage, optional ceilings, `timed-out` outcomes and Steps, video, Trace, and evidence references. Decoding and writing it never converts it to a task execution. Session and runtime compatibility remains until the later phases consume version 3. Dry Run summaries accept both versions while retaining their Teaching Recording ownership and Cleanup lifecycle.
