# Follow a Source Document

Use a Guided Run to learn a Flow Skill from the user's Source Document.

## Guide the journey

1. Read the user's Source Document. If it contains several journeys, propose a split and have the user choose one.
2. Start with `agent_guided_run_start`, prepare setup, and call `agent_teaching_setup_handoff`. Ask the user to start recording in Workspace.
3. Follow the document. Ask the user when it is unclear or conflicts with the site; their answers and actions take precedence.
4. After the recording stops, read `contingency://prompt/learn-flow`.

Use the user's document for a requested Guided Run. Guided Run modifications become required Flow Skill state, including setup modifications still active at Start. Cookie and header values are saved as Variables.

Preserve the order and journey outcomes of modifications and removals. In the Dry Run, apply saved state in order at its recorded outcomes with the required Variables. Read `contingency://docs/browser-state` for permissions.
