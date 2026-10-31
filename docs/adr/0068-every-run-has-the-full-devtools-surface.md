---
status: accepted
---

# Every Run has the full browser devtools surface

Source Documents such as QA runbooks ask for checks that need browser devtools: cookie and storage writes, request routing, headers, and evaluation. ADR 0062 refused every Browser Modification in Guided Runs and Dry Runs, so the agent could see the problem but could not carry out the documented check. This amends [ADR 0062](./0062-agents-get-a-devtools-surface-on-the-playwright-runtime.md) so that every Run, whether Interactive, Guided, or Dry, has the same full devtools surface. It also amends [ADR 0065](./0065-guided-runs-learn-flow-skills-from-source-documents.md) to allow Browser Modifications and Pursuits in Guided Runs.

## Authority by activity

This replaces ADR 0062's authority table.

| Activity | Observe | Emulation changes | Cookie and storage writes | Routes, headers, mutating eval | Pursuits |
| --- | --- | --- | --- | --- | --- |
| Interactive Run | Yes | Yes | Yes | Yes | Yes |
| Teaching setup | Yes | Yes | Yes | No | No |
| Guided Run setup | Yes | Yes | Yes | Yes | Yes |
| Guided Run capture | Yes | Yes | Yes | Yes | Yes |
| Dry Run | Yes | Yes | Yes | Yes | Yes |

## Rules

- **Guided Run modifications become required state.** A Browser Modification made in Guided Run setup that is still active at Start, or made during capture, is saved in the learned Flow Skill as required state. It keeps its order and the point in the journey where it was applied.
- **Dry Runs reproduce saved state.** A Dry Run applies the saved modifications at the same points in the journey. If one cannot be applied, the Dry Run cannot pass.
- **Dry Runs have the full devtools surface.** The agent may also make its own Browser Modifications during a Dry Run, with the same authority as in an Interactive Run.
- **The user decides what a pass means.** Unsaved agent-initiated modifications do not cap a Dry Run's Agent Assessment. Workspace flags them, and the user's verification decides whether the Flow Skill is accepted.
- **Every modification is visible.** Run evidence records each modification as saved or agent-initiated. Workspace shows them next to the Agent Assessment, so a pass can be read alongside what was mocked or changed.
- **Pursuits are recorded.** Guided Runs may use Pursuits. Guided Run evidence and the learned Flow Skill mark them as delegated.
- **Mid-capture Emulation changes are modifications.** The Teaching Recording stores the Emulation at Start. A later Emulation change during Guided Run capture is a Browser Modification and is saved as required state like any other.
- **Existing boundaries remain.** Domain Scope and Confirmation apply to every modification and Pursuit. Teaching is not a Run: it stays user-led, and its setup authority does not change.

## Consequences

A Dry Run no longer proves that a Flow Skill works without help. A mocked response can make any outcome pass, so verification now depends on the user reading which modifications were applied. Saved modifications are part of the Flow Skill the user verifies. Agent-initiated ones are not.

## Open questions

- How are saved modifications represented in the Flow Skill: their order, anchor point, and lifetime?
- How does a Pursuit appear in the learned Flow Skill?

## Considered options

- **Keep Guided Runs and Dry Runs free of modifications.** Rejected: the agent cannot carry out documented devtools checks.
- **Allow modifications only during Guided Run setup.** Rejected: QA documents need routing, headers, and evaluation during the journey itself.
- **Refuse new modifications in Dry Runs and only reproduce saved state.** Rejected by the user, who wants the same devtools surface in every Run.
