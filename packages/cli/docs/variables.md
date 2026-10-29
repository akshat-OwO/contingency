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
    description: The test account password.
---
```

Refer to an input in the procedure as `{{order}}`. Saving refuses a Flow Skill that uses a placeholder it does not declare.

## Runtime values

A Variable's `runtime` property controls whether its value is requested when needed. Input names have the same behavior in uppercase or lowercase. Contingency accepts an older `secret: true` declaration, ignores it, and omits it when writing the skill or protocol output.

Values are plain text in Teaching Timelines, MCP responses, Run Summaries, run.json, traces, and logs. Use test accounts for journeys. A saved Flow Skill stores `{{NAME}}` references rather than the demonstrated values.

## Supply values

Pass a value at Run startup, or request a declared Variable with `agent_variable_request`. The user can supply or refuse it in Workspace. Enter it by name with `agent_variable_enter`. Request it again with `replace: true` to replace a value.

For a Dry Run, pass each input's value at startup or omit the value to request it in Workspace. Supplied startup values remain fixed for that Dry Run.

A Setup Variable is an ordinary Variable requested by name and purpose during agent-held Teaching setup. It lasts until handoff and does not become a learned skill input.

## During Teaching

Enter named Variables through Workspace while recording. The Timeline shows the value and Variable name. Learning replaces demonstrated Variable values with their references in the saved Flow Skill.
