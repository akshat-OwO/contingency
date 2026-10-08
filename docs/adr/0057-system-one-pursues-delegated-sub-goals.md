---
status: proposed
---

# System One pursues delegated sub-goals

Every browser action today costs the external agent a full model turn. A small System One model can choose the next action in about half a second, but it cannot plan or judge. On Mind2Web websites it never saw, Nev-0.8B gets 91% of explicit steps fully right and 34 to 40% of goal-only steps, and it does not reliably confirm that something is gone ([results](../research/nev.md)). Contingency therefore uses System One as a delegated executor. The external agent hands down an ordered list of sub-goals, a Pursuit acts on System One's answers until one does not hold, and control returns to the agent. The agent still owns the plan, recovery, and the Agent Assessment, so [ADR 0044](./0044-agents-own-flow-skill-execution.md) holds.

## Contract

- **Availability.** `agent_browser_pursue` appears in the catalog only when `CONTINGENCY_SYSTEM_ONE_URL` names an endpoint that serves `POST /v1/systemone`, such as Nev on the user's machine, Jev, or Cloudflare's [Clef](https://huggingface.co/Cloudflare/clef). Contingency bundles no model. The URL belongs to the machine, not the Catalog Root, so it is never committed with Flow Skills. Without it the catalog is unchanged and costs nothing under [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md). `CONTINGENCY_SYSTEM_ONE_API_KEY` is sent as a bearer token to a hosted endpoint, and `CONTINGENCY_SYSTEM_ONE_MODEL` names its model, `jev-latest` by default.
- **Opt-in.** The external agent decides when to start a Pursuit and which sub-goals it covers, up to 12. Measured runs showed the agent's turns between sub-goals cost more than System One saved, so one call can carry a whole Flow Skill and returns at the first step that does not end `done`. With the experimental `CONTINGENCY_SYSTEM_ONE_FIRST=true`, the server instructions tell the agent to try a Pursuit for each Flow Skill step before acting itself. Infrastructure still tracks no steps: the agent writes the list and assesses the outcome.
- **Scope.** Pursuits run in Interactive Runs and Dry Runs, never during Teaching. A Dry Run that used Pursuits can pass, because the agent's evidence-backed assessment still decides it.
- **Authority.** Every Pursuit action passes the same Execution Boundary, Domain Scope, Confirmation, and foreground-interception checks as `agent_browser_act`. System One never resolves a Pending Decision, and its confidence never authorizes an action. The agent passes `irreversible: true` to have every mutating action of the Pursuit confirmed. A private Variable entry carries no intent to confirm, so such a Pursuit ends `unsure` when System One chooses one. Any intervention an action returns ends the Pursuit, as it ends `agent_browser_act_sequence`.
- **Disclosure.** Configuring the URL is the user's consent to send each request to it. A request carries the Page's URL, title, visible text, reachable interactive elements, recent actions, and the names of the inputs in scope. What another element covers is left out, as the agent's own text Snapshot gives it no reference. Non-secret input values are sent so System One can match them to fields. A secret Variable is sent by name only. System One chooses the name, and Contingency substitutes the value when it acts.
- **Missing input.** A `needs-input` ending names the Variable System One chose. The agent requests it through the normal Variable path. A Pursuit never prompts the user.
- **Stopping.** Each stop condition maps to one ending:

  | Condition | Ending |
  | --- | --- |
  | Code reads the outcome after the step's first action, or the `done` probability is at least 0.9 before that action or 0.5 after it | `done` |
  | System One answers `BLOCKED`, or an action is intercepted by a foreground element ([ADR 0053](./0053-browser-actions-respect-foreground-interception.md)) | `blocked` |
  | The top answer to the operation, target, or value question is below 0.5; two consecutive actions have effect `none`; System One chooses the same action a third time in a row; an action fails as `detached`, `timeout`, `value_mismatch`, or `length_mismatch`; or the action or time budget runs out | `unsure` |
  | An Execution Boundary pause or a Takeover | `paused` |
  | System One chooses a Variable that has no value yet | `needs-input` |

  Code reads an outcome where it can, because both measured models judge outcomes worst. Text `doneWhen` puts in double quotes must be shown, or no longer shown when `doneWhen` describes something going away; text another element covers does not count. A `doneWhen` that asks for a popup or overlay to be gone holds when nothing covers the Page. Before a step's first action, code can veto `done` but never confirm it, since a search box can show before its city is chosen. When the quoted outcome is present but covered, System One is asked to close what covers it, choosing among the Page's dismissing controls.

  The thresholds are fixed and assume a calibrated endpoint. The 0.5 floor reads the probability of the chosen answer, not the `confidence` an endpoint reports, which rescales that probability against an even split. It means the chosen answer is more likely than every alternative combined; it is revisited with calibration data before this ADR is accepted. The default budget is 8 actions per step and 40 seconds per call. The agent may lower either for one call but not raise it. No new action starts once the time budget is spent. `done` is checked before each action, so a step that already holds takes no action. A request also asks about the next step, so the answer that ends one step can choose the next step's first action.

- **Result.** The tool returns how the last attempted step ended (`done`, `blocked`, `unsure`, `paused`, or `needs-input`), each attempted step's ending, the reason, each action with its effect and System One's confidence, and the final Browser Snapshot. A `blocked` ending from interception carries the intercepting element, and a `paused` ending carries its Pending Decision.
- **Failure.** Only System One itself failing fails the tool call: an unreachable endpoint, an endpoint timeout of ten seconds, or a malformed answer. An endpoint that answers 429, 503, or 529 is retried twice with backoff first. A failed browser action ends the Pursuit instead, as `agent_browser_act_sequence` absorbs it as `stopped.reason: error`, and the result carries the failure reason. An action whose element went stale because the Page moved on is read again once per step before that. Actions already taken remain, and the error lists them, as with `agent_browser_act_sequence`.
- **Replay and duration.** A Pursuit is one blocking call with one operation id under [ADR 0026](./0026-external-agents-control-agent-flows-through-mcp.md). Each action inside it records a derived operation id, and repeating the call's id returns the recorded result without acting again. The time budget keeps a call short enough for clients sized to the 50-second wait clamp of [ADR 0055](./0055-agents-learn-of-session-events-by-waiting.md), allowing for one final action's ten-second actionability wait.
- **Takeover.** When the user takes over, the Pursuit stops before its next action and ends as `paused`.
- **Evidence.** Pursuit actions are ordinary browser actions with their own Action Windows, Trace, and video. The Run Summary marks each one with its Pursuit, step, sub-goal, confidence, and how the step ended, so a reviewer can tell model-chosen actions from the agent's own. The video is unchanged.

## Considered options

- **System One as the whole agent.** Rejected: goal-only accuracy of 34 to 40% is too low to plan a Run.
- **System One as a judge of `Done when:` conditions only.** Rejected: acting is what it does well, and outcome checks such as "the banner is gone" are where it is weakest.
- **Contingency runs each numbered step as a Pursuit.** Rejected: it reintroduces infrastructure-owned steps that ADR 0044 removed. A list the agent writes gets the same speed without that.
- **One sub-goal per call.** Rejected after measurement: on 1mg's manual location flow it took 71 to 75 seconds against 68 for the agent acting alone, because each step still cost an agent turn.
- **Bundling Nev, or supporting only hosted Jev.** Rejected: bundling makes Contingency own a Python and MLX runtime and a large download, and hosted-only rules out local models.
