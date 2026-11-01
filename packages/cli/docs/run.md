# Run Flow Skills

Run a requested task and report its outcome with evidence.

## Run

1. Start an Interactive Run with `agent_run_start`. When the user requests skills, use only verified Flow Skills. Skip this step when a tool already started the Run, such as an Example or a Dry Run.
2. Carry out the task and report the outcome and evidence with `agent_run_assess`.
3. Call `agent_run_complete` to finish the Run.

## Use System One

When `process.systemOne.available` is true, try `agent_browser_pursue` in an Interactive Run, Guided Run, or Dry Run. Never use Pursuits in Teaching.

Run a Flow Skill's preconditions first. Pass all remaining numbered steps in one call, with each step's text as `goal` and its Done when: line as `doneWhen`. Quote in `doneWhen` the text the Page shows once the step holds.

Do not merge steps or rephrase them as a bare task. You own the plan and assessment. A Guided Run's learned Flow Skill marks Pursuits as delegated; a later agent may do that work itself.

A configured remote endpoint has unknown reachability until used. A Local System One may need to warm up.
