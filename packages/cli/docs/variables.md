# Variables

A Variable is a named input a Flow Skill needs when it runs, such as an order number or a password. A Variable belongs to the Flow Skill that declares it. It is not a [Setting](./settings.md): no `config.json` holds a Variable value.

## Declare inputs

Declare every input in the `inputs` list of the Flow Skill's `SKILL.md` frontmatter. Each entry is a bare name or a mapping with an optional description:

```yaml
---
name: start-a-return
description: Start a return for one order and confirm the return names it.
inputs:
  - reason
  - name: order
    description: An order number from Your orders, such as RH-1042.
  - name: DEMO_PASSWORD
    description: Private. The account password. The user supplies it in Workspace.
---
```

Refer to an input in the procedure as `{{order}}`. Saving refuses a Flow Skill that uses a placeholder it does not declare.

## Secret and runtime

Each Variable has two independent properties:

- **`secret`**: Contingency redacts the value. It never enters the conversation, the Teaching Timeline, or Run artifacts. The user types it in the Workspace, and the agent enters it into the page by name without seeing it.
- **`runtime`**: The value is asked for when the Run needs it, not fixed when the Run starts.

A one-time passcode is both secret and runtime. A target environment URL is neither.

In an Interactive Run, the input's name decides which kind it is. An input named in uppercase letters, digits, and underscores, such as `DEMO_PASSWORD`, is private: both secret and runtime. Any other name, such as `order`, is an ordinary input that is neither. In a Dry Run, the agent marks each private input with `secret: true` when it starts the Dry Run.

## Supply values

- **Ordinary inputs.** The agent passes the value when it starts the Run. For a Dry Run, these values are fixed at startup; change them by starting a fresh Dry Run. In an Interactive Run, the agent changes them with `agent_run_update`.
- **Private inputs.** The agent requests the Variable by its uppercase name with `agent_variable_request`. The user supplies or refuses the value in the Workspace. The agent then types it with `agent_variable_enter`. To ask for a fresh value, such as a new passcode, the agent requests it again with `replace: true`.
- **Setup Variables.** During agent-held Teaching setup, the agent can request a private value by name and purpose before any Flow Skill exists. The value lasts until setup hands off to the user.

The Variable name the agent uses is the input name in uppercase, with underscores kept: `password` becomes `PASSWORD`.

## During Teaching

When you type into a password field while recording, the Teaching Recording keeps a Variable reference such as `DEMO_PASSWORD` in place of the value. The learning agent declares that name under `inputs`.
