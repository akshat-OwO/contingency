---
status: proposed
---

# System One pursues delegated sub-goals

Every browser action today costs the external agent a full model turn. A small System One model can choose the next action in about half a second, but it cannot plan or judge. On Mind2Web websites it never saw, Nev-0.8B gets 91% of explicit steps fully right and 34 to 40% of goal-only steps, and it does not reliably confirm that something is gone ([results](../research/nev.md)). Contingency therefore uses System One as a delegated executor. The external agent hands down one sub-goal, a Pursuit acts on System One's answers until it ends, and control returns to the agent. The agent still owns the plan, recovery, and the Agent Assessment, so [ADR 0044](./0044-agents-own-flow-skill-execution.md) holds.

## Contract

- **Availability.** `agent_browser_pursue` appears in the catalog only when `CONTINGENCY_SYSTEM_ONE_URL` names an endpoint that serves `POST /v1/systemone`, such as Nev on the user's machine, Jev, or Clef. Contingency bundles no model. The URL belongs to the machine, not the Catalog Root, so it is never committed with Flow Skills. Without it the catalog is unchanged and costs nothing under [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md).
- **Opt-in.** The external agent decides when to start a Pursuit. With the experimental `CONTINGENCY_SYSTEM_ONE_FIRST=true`, the server instructions tell the agent to try a Pursuit for each Flow Skill step before acting itself. Infrastructure still tracks no steps.
- **Scope.** Pursuits run in Interactive Runs and Dry Runs, never during Teaching. A Dry Run that used Pursuits can pass, because the agent's evidence-backed assessment still decides it.
- **Authority.** Every Pursuit action passes the same Execution Boundary, Domain Scope, and Confirmation checks as `agent_browser_act`. A pause ends the Pursuit and returns its Pending Decision to the agent. System One never resolves a decision, and its confidence never authorizes an action.
- **Disclosure.** Configuring the URL is the user's consent to send each request to it. A request carries the Page's URL, title, visible text, interactive elements, recent actions, and the names of the inputs in scope. Non-secret input values are sent so System One can match them to fields. A secret Variable is sent by name only. System One chooses the name, and Contingency substitutes the value when it acts.
- **Missing input.** When System One chooses a Variable that has no value yet, the Pursuit ends as `needs-input` and names it. The agent requests it through the normal Variable path. A Pursuit never prompts the user.
- **Stopping.** A Pursuit ends when System One reports the sub-goal done, at a `done` probability of 0.9 before the Pursuit's first action and 0.5 after it. It also ends on a `BLOCKED` operation, on a top answer below the confidence floor, on two consecutive actions with effect `none`, at an Execution Boundary pause, or when its action budget runs out. The thresholds are fixed. The default budget is 8 actions, and the agent may lower it for one call but not raise it.
- **Result.** The tool returns how the Pursuit ended (`done`, `blocked`, `unsure`, `paused`, or `needs-input`), the reason, each action with its effect and System One's confidence, and the final Browser Snapshot. A pause also carries its Pending Decision.
- **Failure.** An unreachable endpoint, a timeout, or a malformed answer fails the tool call rather than ending the Pursuit. Actions already taken remain, and the error lists them, as with `agent_browser_act_sequence`.
- **Takeover.** A Pursuit is one blocking call. When the user takes over, it stops before its next action and ends as `paused`.
- **Evidence.** Pursuit actions are ordinary browser actions with their own Action Windows, Trace, and video. The Run Summary marks each one with its Pursuit, sub-goal, confidence, and how the Pursuit ended, so a reviewer can tell model-chosen actions from the agent's own. The video is unchanged.

## Considered options

- **System One as the whole agent.** Rejected: goal-only accuracy of 34 to 40% is too low to plan a Run.
- **System One as a judge of `Done when:` conditions only.** Rejected: acting is what it does well, and outcome checks such as "the banner is gone" are where it is weakest.
- **Contingency runs each numbered step as a Pursuit.** Rejected for now: it reintroduces infrastructure-owned steps that ADR 0044 removed. If the experimental flag shows that agents ignore the instruction, a later ADR can revisit this with data.
- **Bundling Nev, or supporting only hosted Jev.** Rejected: bundling makes Contingency own a Python and MLX runtime and a large download, and hosted-only rules out local models.
