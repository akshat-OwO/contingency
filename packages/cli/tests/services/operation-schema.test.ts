import { CodeMode, Tool } from "@opencode/codemode";
import type { Schema } from "effect";
import { Predicate, Effect } from "effect";
import { Tool as EffectTool } from "effect/ai";
import { expect, test } from "vitest";

import { AgentRunTools } from "../../src/services/mcp-agent-run.ts";
import { AgentSessionTools } from "../../src/services/mcp-agent-session.ts";
import { BrowserDevtoolsTools } from "../../src/services/mcp-browser-devtools.ts";
import { AgentCatalogTools } from "../../src/services/mcp-catalog.ts";
import { DeviceWorkspaceTools } from "../../src/services/mcp-device-workspace.ts";
import { DocsTools } from "../../src/services/mcp-docs.ts";
import { OnboardingTools } from "../../src/services/mcp-onboarding.ts";
import { PursuitTools } from "../../src/services/mcp-pursuit.ts";
import { TeachingRecordingTools } from "../../src/services/mcp-teaching-recording.ts";
import { compactJsonSchema } from "../../src/services/operation-schema.ts";

const run = (input: Tool.JsonSchema, code: string) =>
  Effect.runPromise(
    CodeMode.execute({
      code,
      tools: {
        act: Tool.make({
          description: "Act",
          execute: (value) => Effect.succeed(value),
          input,
          output: {},
        }),
      },
    })
  );
test("drops redundant annotations while retaining actionable constraints and references", () => {
  const schema = {
    $defs: {
      Label: {
        description: "Label",
        examples: ["x"],
        identifier: "Label",
        maxLength: 30,
        pattern: "^[a-z]+$",
        title: "Label",
        type: "string",
      },
    },
    $id: "https://example.test/schema",
    properties: {
      code: { description: "Must match ^x+$", pattern: "^x+$", type: "string" },
      count: { maximum: 5, minimum: 1, type: "integer" },
      data: {
        default: { identifier: "keep", title: "keep" },
        enum: [{ title: "keep" }],
      },
      items: { items: { enum: ["a", "b"] }, maxItems: 2, type: "array" },
      label: { $ref: "#/$defs/Label", description: "label" },
      text: {
        description: "Non-empty text",
        maxLength: 100,
        minLength: 1,
        type: "string",
      },
    },
    required: ["label"],
    type: "object",
  };
  const result = compactJsonSchema(schema);
  expect(result).toEqual({
    ...schema,
    $defs: { Label: { maxLength: 30, pattern: "^[a-z]+$", type: "string" } },
    properties: {
      ...schema.properties,
      code: { description: "Must match ^x+$", type: "string" },
      label: { $ref: "#/$defs/Label" },
      text: { description: "Non-empty text", maxLength: 100, type: "string" },
    },
  });
  expect(compactJsonSchema(result)).toEqual(result);
  expect(schema.properties.text.minLength).toBe(1);
  expect(compactJsonSchema(true)).toBe(true);
  expect(
    compactJsonSchema({
      anyOf: [{ $ref: "#/definitions/X" }, { type: "null" }],
      definitions: { X: { description: "X", type: "string" } },
    })
  ).toEqual({
    anyOf: [{ $ref: "#/definitions/X" }, { type: "null" }],
    definitions: { X: { type: "string" } },
  });
});

test("public CodeMode search renders smaller signatures and accepts the same parameters", async () => {
  const schema = {
    properties: {
      label: {
        description: "label",
        maxLength: 30,
        pattern: "^[a-z]+$",
        type: "string",
      },
    },
    required: ["label"],
    type: "object",
  };
  const before = await run(schema, 'return search({ query: "" })');
  // SAFETY: this fixture is an object JSON Schema and compaction retains its structure.
  const compact = compactJsonSchema(schema) as Tool.JsonSchema;
  const after = await run(compact, 'return search({ query: "" })');
  expect(after.ok).toBe(true);
  expect(JSON.stringify(after)).toContain("@maxLength 30");
  expect(JSON.stringify(after)).toContain("@pattern ^[a-z]+$");
  expect(JSON.stringify(after).length).toBeLessThan(
    JSON.stringify(before).length
  );
  const called = await run(compact, 'return await tools.act({ label: "abc" })');
  expect(called.ok).toBe(true);
});

const isSchemaObject = (
  value: Schema.Json
): value is { [key: string]: Schema.Json } => Predicate.isObject(value);

const stringSchemas = (
  schema: Schema.Json,
  path = "$"
): Map<string, Record<string, Schema.Json>> => {
  const strings = new Map<string, Record<string, Schema.Json>>();
  const visit = (value: Schema.Json, field: string) => {
    if (!isSchemaObject(value)) {
      return;
    }
    if (value.type === "string") {
      strings.set(field, value);
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "properties",
          "patternProperties",
          "$defs",
          "definitions",
          "dependentSchemas",
        ].includes(key) &&
        isSchemaObject(child)
      ) {
        for (const [name, item] of Object.entries(child)) {
          visit(item, `${field}.${key}.${name}`);
        }
      } else if (
        [
          "items",
          "prefixItems",
          "additionalProperties",
          "allOf",
          "anyOf",
          "oneOf",
          "not",
          "contains",
          "propertyNames",
          "if",
          "then",
          "else",
        ].includes(key)
      ) {
        if (Array.isArray(child)) {
          for (const [index, item] of child.entries()) {
            visit(item, `${field}.${key}.${index}`);
          }
        } else {
          visit(child, `${field}.${key}`);
        }
      }
    }
  };
  visit(schema, path);
  return strings;
};

test("every server operation preserves the documented string bounds in rendered signatures", () => {
  // Includes optional onboarding and System One operations, even when disabled.
  const toolkits = [
    DocsTools,
    AgentSessionTools,
    BrowserDevtoolsTools,
    DeviceWorkspaceTools,
    AgentCatalogTools,
    AgentRunTools,
    TeachingRecordingTools,
    OnboardingTools,
    PursuitTools,
  ];
  let strings = 0;
  for (const toolkit of toolkits) {
    for (const [operation, tool] of Object.entries(toolkit.tools)) {
      // SAFETY: Effect generates a JSON Schema document.
      const original = EffectTool.getJsonSchema(tool) as Schema.Json;
      const before = stringSchemas(original);
      const after = stringSchemas(compactJsonSchema(original, true));
      expect([...after.keys()], operation).toEqual([...before.keys()]);
      for (const [field, schema] of before) {
        const rendered = after.get(field);
        if (rendered === undefined) {
          throw new Error(field);
        }
        expect(
          rendered.minLength ??
            (schema.enum === undefined && schema.const === undefined ? 1 : 0),
          `${operation}${field}`
        ).toBe(schema.minLength ?? 0);
        expect(rendered.maxLength, `${operation}${field}`).toBe(
          schema.maxLength
        );
        strings += 1;
      }
      expect(EffectTool.getJsonSchema(tool), operation).toEqual(original);
    }
  }
  expect(strings).toBeGreaterThan(100);
});

interface StringBoundsFixture {
  type: "string";
  minLength?: number;
  maxLength?: number;
}

test("elides only minimum 1 and explicitly renders empty-string exceptions", () => {
  for (const minLength of [undefined, 0, 1, 2]) {
    for (const maxLength of [undefined, 2048, 5000]) {
      const schema: StringBoundsFixture = { type: "string" };
      const expected: StringBoundsFixture = { type: "string" };
      if (minLength !== undefined) {
        schema.minLength = minLength;
      }
      if (minLength !== 1) {
        expected.minLength = minLength ?? 0;
      }
      if (maxLength !== undefined) {
        schema.maxLength = maxLength;
        expected.maxLength = maxLength;
      }
      expect(compactJsonSchema({ ...schema }, true)).toEqual(expected);
    }
  }
});
