# Dry Run results are derived from Agent Assessments

> Supersedes the Dry Run result and its report operation in [ADR 0039](./0039-flow-skills-are-learned-from-temporary-teaching-recordings.md).

A Dry Run executes the Flow Skill's numbered procedure as ordered Agent Steps, and the agent judges each against its `Done when:` line with `agent_run_step_assess`. The Dry Run passes only when every Agent Step is assessed `working`, coverage is complete, and the user never took over. Any other ending fails it. There is no Dry Run report operation.

ADR 0039 had the agent report one `passed` or `failed` for the whole flow. That verdict could contradict the evidence behind it, and a failure pointed at no step, so fixing the Flow Skill meant rereading the whole attempt to find where it broke. The Agent Assessments already say everything the report said, and they say which step broke.

A Dry Run is not an Interactive Run. It borrows Agent Steps, Agent Assessments, the Execution Boundary, Takeover, ceilings, and the Run Summary, but it stays a step in learning a drafted Flow Skill rather than a reusable Run of a verified one. Its Domain Scope is the hosts its Teaching Recording visited.

The Dry Run's Trace, video, and Run Summary are Teaching evidence. They live with the Teaching Recording, never under `agent-runs/`, and `open_run` does not reach them. Only the latest Dry Run's evidence is kept, and Cleanup deletes it with the recording. The Workspace shows that Run Summary beside the verify and reject choice, and beside a failed Dry Run. The verification reference keeps the time, the redacted inputs, and the last Agent Step's `Done when:` line with its Assessment explanation as the observable outcome.
