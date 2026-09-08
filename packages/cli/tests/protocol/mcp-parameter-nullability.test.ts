import { Exit, Schema } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";
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
const isStruct = (
  schema: Schema.Top
): schema is Schema.Struct<Schema.Struct.Fields> => "fields" in schema;

const verifyToolkit = <Tools extends Record<string, Tool.Any>>(
  name: string,
  toolkit: Toolkit.Toolkit<Tools>
) => {
  test(`${name} tools accept null for every parameter published as nullable`, () => {
    const tools = Object.entries(toolkit.tools);
    expect(tools.length).toBeGreaterThan(0);

    const refused: string[] = [];
    for (const [toolName, tool] of tools) {
      if (!isStruct(tool.parametersSchema)) {
        continue;
      }
      const { fields } = tool.parametersSchema;
      for (const [key, field] of Object.entries(fields)) {
        const document = Schema.toJsonSchemaDocument(field);
        if (!advertisesNull(document.schema)) {
          continue;
        }
        const synchronousField = Schema.make<
          Schema.Codec<unknown, unknown, never, never>
        >(field.ast);
        const decoded = Schema.decodeUnknownExit(synchronousField)(null);
        if (Exit.isFailure(decoded)) {
          refused.push(`${toolName}.${key}`);
        }
      }
    }
    expect(refused).toEqual([]);
  });
};

verifyToolkit("agent flow", AgentFlowTools);
verifyToolkit("agent run", AgentRunTools);
verifyToolkit("agent session", AgentSessionTools);
