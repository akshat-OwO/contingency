---
status: accepted
---

# Guided Runs use browser devtools

A Guided Run can need browser devtools to follow a Source Document. This amends [ADR 0062](./0062-agents-get-a-devtools-surface-on-the-playwright-runtime.md) to permit modifications during Guided Runs and reproduce learned modifications in their Dry Runs. It also amends [ADR 0065](./0065-guided-runs-learn-flow-skills-from-source-documents.md) to permit Browser Modifications and Pursuits.

## Authority by activity

This extends ADR 0062's authority table. Pursuits remain unavailable during Teaching.

| Activity | Observe | Emulation changes | Cookie and storage writes | Routes, headers, mutating eval | Pursuits |
| --- | --- | --- | --- | --- | --- |
| Interactive Run | Yes | Yes | Yes | Yes | Yes |
| Teaching setup | Yes | Yes | Yes | No | No |
| Guided Run setup | Yes | Yes | Yes | Yes | Yes |
| Guided Run capture | Yes | No | Open | Yes | Yes |
| Dry Run | Yes | No; uses saved Emulation | No | Reproduces only saved Guided-Run-learned modifications; refuses agent-initiated modifications | Yes |

## Rules

- **Setup stays outside capture.** Guided Run setup has the full Interactive Run set of devtools capabilities before the user presses Start. Setup activity remains outside the Teaching Recording.
- **Capture saves required state.** Routes, headers, and mutating eval used during Guided Run capture are recorded and saved as required state in the learned Flow Skill. Its Dry Run reproduces that state and records evidence of the modifications. Workspace shows the saved modifications and their Dry Run evidence.
- **The Dry Run exception is scoped.** A Dry Run reproduces only modifications saved from a Guided Run. It still refuses agent-initiated Browser Modifications. A mock can make an outcome pass, so a passing Dry Run must be read with the saved modifications and their evidence visible in Workspace.
- **Pursuits are learned.** A Guided Run may use Pursuits. Guided Run evidence and the learned Flow Skill record them with actor markers. Pursuit actions remain subject to the Execution Boundary and Confirmation.
- **Existing boundaries remain.** Emulation is fixed during capture. Domain Scope and Confirmation continue to apply, including Confirmation for each mutating eval attempt. Teaching and ordinary Dry Run authority otherwise remain unchanged.

## Open questions

- How are required modifications represented in Flow Skill frontmatter or body, including their order and lifetime?
- How does a Dry Run apply saved modifications, handle failures, and enforce Confirmation for mutating eval?
- How does a Pursuit and its actor marker appear in the learned Flow Skill?
- How does Workspace present saved modifications and their Dry Run evidence?
- What happens to a modification made during setup that remains active at Start?
- Are direct cookie and storage writes allowed during capture? Mutating eval can already write them, so refusing them alone would not hold.

## Considered options

- **Keep Guided Runs free of modifications and Pursuits.** Rejected. This prevents a Guided Run from using capabilities needed to follow some Source Documents.
- **Allow arbitrary modifications in Dry Runs.** Rejected. A mock can make an outcome pass. The exception is limited to saved Guided Run state and visible evidence.
- **Allow capture modifications without reproducing them.** Rejected. The learned Flow Skill would omit required state from the journey it learned.
