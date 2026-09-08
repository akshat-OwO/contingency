# MCP tool parameters reject excess properties

Every MCP tool refuses a call whose parameters carry a property its schema does not declare. The refusal names the path to the offending key, no handler runs, and nothing is written, so a rejected call performs no browser action, stores no artifact, and consumes no operation id; the agent may retry the corrected payload under the same id.

The rule is uniform across the catalog, session, and Interactive Run tools rather than special-cased for one field. It exists because a silently stripped key teaches an agent nothing: a step proposal that supplies its own `evidence` was accepted while Contingency derived the Evidence Slice from the demonstrated span anyway, so the agent read success where [ADR 0025](0025-agent-flow-is-compiled-from-a-demonstration.md) promises refusal. Deriving every Evidence Slice from the demonstration remains the real guarantee; the refusal is what makes the guarantee legible.

Each tool's published JSON Schema already declares `additionalProperties: false`. Effect decodes tool parameters with the default parse options, which strip undeclared keys before any Contingency code runs, and `onExcessProperty` is a decode-time option rather than something a schema can carry. Strictness is therefore introduced once, in front of every tool's decode, and the published schemas are unchanged: this only makes the runtime honour what they already say. The accepted cost is that a client sending a forward-compatible extra key is now refused where it previously succeeded.

## Considered Options

- **Take the draft as an opaque parameter and decode it strictly in the handler**: rejected because it removes the published JSON Schema for the most structured tool, which MCP clients rely on.
- **Declare a poison `evidence` field on the step**: rejected because it pollutes the public schema to catch one key and generalises to nothing.
- **Accept the silent strip and reword the criterion**: rejected because a confused agent that keeps sending `evidence` never learns it is pointless, and the compiler's other refusals all return a diagnostic.
