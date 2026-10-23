---
status: accepted
---

# Guided Runs learn Flow Skills from Source Documents

Users arrive with journeys already written down as runbooks, markdown notes, or skills for other tools. Re-demonstrating each one by hand in Teaching wastes that work, but a Flow Skill drafted straight from the document has no demonstrated hosts or Emulation, so its Dry Run would run inside a boundary nobody approved. A Guided Run closes that gap: the external agent follows the user's Source Document in the browser, asks the user when the document is ambiguous or wrong, and lets the user take over. The run produces a Teaching Recording, and learning, Dry Run, verification, and Cleanup then proceed unchanged.

This amends [ADR 0039](./0039-flow-skills-are-learned-from-temporary-teaching-recordings.md), where every Teaching Recording came from user-led Teaching, and extends the setup phase of [ADR 0042](./0042-agent-controlled-teaching-setup.md) to Guided Runs. Teaching itself stays user-led throughout.

## Rules

- **Agent-started, browser first.** Only the external agent starts a Guided Run, over MCP, because only it reads the Source Document. Android follows once its Teaching path exists within its Support Matrix.
- **The Source Document stays the user's.** Contingency never parses, stores, or links it. The Flow Skill records no `source:`; origin lives on the Teaching Recording and is deleted by Cleanup.
- **One journey per run.** Before starting, the agent proposes how to split a multi-journey document, and the user picks one. Shared prerequisites such as login become setup or a prerequisite Flow Skill.
- **Same capture boundary.** Setup, with agent or user control and Setup Variables, stays outside the evidence. Capture starts only when the user presses Start.
- **Actor-marked evidence.** Every recorded action is marked as the agent's or the user's, so the learning agent can tell what the document suggested from what the user demonstrated.
- **Questions become Instructions.** When unsure, the agent asks through Contingency. The question and the user's answer, given in Workspace or relayed by the agent, join the event stream as an Instruction pair. The user may Takeover instead of answering.
- **Demonstration outranks the document.** Where the user's answers or Takeover actions contradict the Source Document, the Flow Skill follows the user.
- **Domain Scope grows by approval.** It starts at the starting host. Each new top-level host pauses as a Pending Decision, and approved hosts become the stamped hosts in the Flow Skill's frontmatter. Confirmation for irreversible actions still applies.
- **No Browser Modifications or Pursuits.** A learned step must be something a user could do, and every agent action should trace to the agent's reading of the document.
- **Checks are confirmed, not inferred.** The agent proposes each check the document asks for, and the user's confirmation creates the same Scan Requirement or Browser Check Teaching would.
- **Partial runs are learnable.** A stopped or stalled Guided Run still finalizes its recording. The mandatory Dry Run, which cannot pass with Takeover, is the gate.

## Considered options

- **Agent-driven Teaching with Takeover.** Rejected: it breaks the rule that Teaching is user-led and that the user owns the demonstration.
- **Draft from the document, then go straight to a Dry Run.** Rejected: the Dry Run would have no demonstrated Domain Scope or Emulation, and any Takeover needed to correct the draft would fail it.
- **Learn from ordinary Run evidence.** Rejected: it needs a second learning pipeline and a second Cleanup for sensitive evidence.
- **Contingency ingests and stores the Source Document.** Rejected: the document may hold credentials, and storing it creates a second, unvalidated authoring artifact.
