---
status: proposed
---

# System One pursues delegated sub-goals

Every browser action today costs the external agent a full model turn. A small System One model can choose the next action in about half a second, but it cannot plan or judge. On Mind2Web websites it never saw, Nev-0.8B gets 91% of explicit steps fully right and 34 to 40% of goal-only steps, and it does not reliably confirm that something is gone ([results](../research/nev.md)). Contingency therefore uses System One as a delegated executor. The external agent hands down one sub-goal, a Pursuit acts on System One's answers until it ends, and control returns to the agent. The agent still owns the plan, recovery, and the Agent Assessment, so [ADR 0044](./0044-agents-own-flow-skill-execution.md) holds.

## Contract

- **Availability.** `agent_browser_pursue` appears in the catalog only when `CONTINGENCY_SYSTEM_ONE_URL` names an endpoint that serves `POST /v1/systemone`, such as Nev on the user's machine, Jev, or Cloudflare's [Clef](https://huggingface.co/Cloudflare/clef). Contingency bundles no model. The URL belongs to the machine, not the Catalog Root, so it is never committed with Flow Skills. Without it the catalog is unchanged and costs nothing under [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md).
- **Opt-in.** The external agent decides when to start a Pursuit. With the experimental `CONTINGENCY_SYSTEM_ONE_FIRST=true`, the server instructions tell the agent to try a Pursuit for each Flow Skill step before acting itself. Infrastructure still tracks no steps.
- **Scope.** Pursuits run in Interactive Runs and Dry Runs, never during Teaching. A Dry Run that used Pursuits can pass, because the agent's evidence-backed assessment still decides it.
- **Authority.** Every Pursuit action passes the same Execution Boundary, Domain Scope, Confirmation, and foreground-interception checks as `agent_browser_act`. System One never resolves a Pending Decision, and its confidence never authorizes an action. Any intervention an action returns ends the Pursuit, as it ends `agent_browser_act_sequence`.
- **Disclosure.** Configuring the URL is the user's consent to send each request to it. A request carries the Page's URL, title, visible text, interactive elements, recent actions, and the names of the inputs in scope. Non-secret input values are sent so System One can match them to fields. A secret Variable is sent by name only. System One chooses the name, and Contingency substitutes the value when it acts.
- **Missing input.** A `needs-input` ending names the Variable System One chose. The agent requests it through the normal Variable path. A Pursuit never prompts the user.
- **Stopping.** Each stop condition maps to one ending:

  | Condition | Ending |
  | --- | --- |
  | `done` probability of at least 0.9 before the Pursuit's first action, or 0.5 after it | `done` |
  | System One answers `BLOCKED`, or an action is intercepted by a foreground element ([ADR 0053](./0053-browser-actions-respect-foreground-interception.md)) | `blocked` |
  | The top answer to the operation, target, or value question is below 0.5; two consecutive actions have effect `none`; an action fails as `detached`, `timeout`, `value_mismatch`, or `length_mismatch`; or the action or time budget runs out | `unsure` |
  | An Execution Boundary pause or a Takeover | `paused` |
  | System One chooses a Variable that has no value yet | `needs-input` |

  The thresholds are fixed and assume a calibrated endpoint. The 0.5 floor means the chosen answer is more likely than every alternative combined; it is revisited with calibration data before this ADR is accepted. The default budget is 8 actions and 40 seconds. The agent may lower either for one call but not raise it. No new action starts once the time budget is spent. `done` is checked before each action, so a Pursuit whose sub-goal already holds takes no action.

- **Result.** The tool returns how the Pursuit ended (`done`, `blocked`, `unsure`, `paused`, or `needs-input`), the reason, each action with its effect and System One's confidence, and the final Browser Snapshot. A `blocked` ending from interception carries the intercepting element, and a `paused` ending carries its Pending Decision.
- **Failure.** Only System One itself failing fails the tool call: an unreachable endpoint, an endpoint timeout, or a malformed answer. A failed browser action ends the Pursuit instead, as `agent_browser_act_sequence` absorbs it as `stopped.reason: error`, and the result carries the failure reason. Actions already taken remain, and the error lists them, as with `agent_browser_act_sequence`.
- **Replay and duration.** A Pursuit is one blocking call with one operation id under [ADR 0026](./0026-external-agents-control-agent-flows-through-mcp.md). Each action inside it records a derived operation id, and repeating the call's id returns the recorded result without acting again. The time budget keeps a call short enough for clients sized to the 50-second wait clamp of [ADR 0055](./0055-agents-learn-of-session-events-by-waiting.md), allowing for one final action's ten-second actionability wait.
- **Takeover.** When the user takes over, the Pursuit stops before its next action and ends as `paused`.
- **Evidence.** Pursuit actions are ordinary browser actions with their own Action Windows, Trace, and video. The Run Summary marks each one with its Pursuit, sub-goal, confidence, and how the Pursuit ended, so a reviewer can tell model-chosen actions from the agent's own. The video is unchanged.

## Considered options

- **System One as the whole agent.** Rejected: goal-only accuracy of 34 to 40% is too low to plan a Run.
- **System One as a judge of `Done when:` conditions only.** Rejected: acting is what it does well, and outcome checks such as "the banner is gone" are where it is weakest.
- **Contingency runs each numbered step as a Pursuit.** Rejected for now: it reintroduces infrastructure-owned steps that ADR 0044 removed. If the experimental flag shows that agents ignore the instruction, a later ADR can revisit this with data.
- **Bundling Nev, or supporting only hosted Jev.** Rejected: bundling makes Contingency own a Python and MLX runtime and a large download, and hosted-only rules out local models.
