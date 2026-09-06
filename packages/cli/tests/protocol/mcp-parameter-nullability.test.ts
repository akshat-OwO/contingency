import { Schema } from "effect";
import { expect, test } from "vitest";

import { AgentFlowTools } from "../../src/services/mcp-agent-flow.ts";
import { AgentRunTools } from "../../src/services/mcp-agent-run.ts";
import { AgentSessionTools } from "../../src/services/mcp-agent-session.ts";

interface JsonSchema {
  readonly anyOf?: readonly JsonSchema[];
  readonly type?: string;
}

/** Whether the published property itself offers `null` as a value. */
const advertisesNull = (property: JsonSchema): boolean =>
  property.type === "null" ||
  (property.anyOf?.some((member) => member.type === "null") ?? false);

/**
 * Every field an MCP tool publishes as accepting `null` must decode `null`.
 * `Schema.optional` renders its `undefined` branch as a `null` branch in the
 * published JSON Schema while the validator refuses `null`, so an agent that
 * trusts the advertised contract is refused (issue #129).
 */
const toolkits = [
  ["agent flow", AgentFlowTools],
  ["agent run", AgentRunTools],
  ["agent session", AgentSessionTools],
] as const;

for (const [name, toolkit] of toolkits) {
  test(`${name} tools accept null for every parameter published as nullable`, () => {
    const tools = Object.entries(
      (toolkit as unknown as { readonly tools: Record<string, unknown> }).tools
    );
    expect(tools.length).toBeGreaterThan(0);

    const refused: string[] = [];
    for (const [toolName, tool] of tools) {
      const parameters = (tool as { readonly parametersSchema: Schema.Top })
        .parametersSchema;
      const { fields } = parameters as unknown as {
        readonly fields?: Record<string, Schema.Top>;
      };
      if (fields === undefined) {
        continue;
      }
      for (const [key, field] of Object.entries(fields)) {
        const isolated = Schema.Struct({
          [key]: field,
        }) as unknown as Schema.Codec<Record<string, unknown>>;
        const document = Schema.toJsonSchemaDocument(isolated) as {
          readonly schema: { readonly properties?: Record<string, JsonSchema> };
        };
        const property = document.schema.properties?.[key];
        if (property === undefined || !advertisesNull(property)) {
          continue;
        }
        try {
          Schema.decodeUnknownSync(isolated)({ [key]: null });
        } catch {
          refused.push(`${toolName}.${key}`);
        }
      }
    }
    expect(refused).toEqual([]);
  });
}
