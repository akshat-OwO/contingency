# Agent-controlled Runs have no wall-clock ceiling

> Supersedes the Step and Run ceilings in [ADR 0029](./0029-contingency-owns-the-sole-runner.md) and the ceilings a Dry Run borrows in [ADR 0041](./0041-dry-run-results-are-derived-from-agent-assessments.md).

An Interactive Run and a Dry Run have no Agent Step ceiling and no Run ceiling. A Run ends only when its last Agent Step is assessed, when an Agent Assessment other than `working` stops the ordered Steps, on `agent_run_complete`, when the user closes the session, or when the process that owns it exits. Nothing ends a Run for being slow.

The ceilings measured wall clock, so they counted the agent's own thinking as well as the browser's work. An agent that read a long snapshot, reasoned about a popup, or waited for the user to supply a runtime Variable such as an OTP spent its Step budget while the page did nothing wrong, and the user had to press an extend button to keep a careful agent from being cut off. A `timed-out` outcome said nothing about whether the site works. It only penalized a slow or careful agent.

Per-action timeouts stay. `wait_for_text.timeoutMs` and Playwright's action and navigation timeouts bound a single browser call, not the agent's thinking, and [ADR 0021](./0021-timeouts-are-set-not-inherited.md) still governs how they are set.

Each live Run records when the agent last called a tool on its session. Workspace reads it to say how long the agent has been idle once that passes ten minutes. The notice is read-only: it does not pause, end, or change the Run, and it is hidden while the user holds the browser, because then the agent is waiting on the user.

A Run Summary persisted while Runs had ceilings keeps its `ceilings` block and any `timed-out` outcome or Step, and it still opens. New Runs never produce `timed-out`. A Catalog Root's `agentRunCeilings` policy is no longer read.
