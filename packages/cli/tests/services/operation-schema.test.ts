import { CodeMode, Tool } from "@opencode/codemode";
import { Schema, SchemaRepresentation, Predicate, Effect } from "effect";
import type { JsonSchema } from "effect";
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
import {
  compactJsonSchema,
  compactOutputSchema,
  operationOutputDepth,
} from "../../src/services/operation-schema.ts";
import outputValues from "../fixtures/mcp-output-values.json";

const schemaObject = (
  value: Schema.Json | undefined
): value is { [key: string]: Schema.Json } => Predicate.isObject(value);

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

test("preserves __proto__ schema properties and extension data as own keys", () => {
  const extension = Object.fromEntries([["__proto__", "saved value"]]);
  const schema = {
    ...extension,
    properties: Object.fromEntries([
      ["__proto__", { ...extension, title: "Drop", type: "string" }],
      ["normal", { type: "string" }],
    ]),
    type: "object",
  };
  const result = compactJsonSchema(schema);
  // Exercise the JSON transport as well as the in-memory projection.
  const serialized = JSON.stringify(result);
  expect(JSON.parse(serialized)).toEqual({
    ...schema,
    properties: Object.fromEntries([
      ["__proto__", { ...extension, type: "string" }],
      ["normal", { type: "string" }],
    ]),
  });
  expect(
    Object.getOwnPropertyDescriptor(schema.properties, "__proto__")?.value
  ).toHaveProperty("title", "Drop");
});

const catalogBytes = async (
  catalogTools: NonNullable<Parameters<typeof CodeMode.execute>[0]["tools"]>
) => {
  const searched = await Effect.runPromise(
    CodeMode.execute({
      code: 'return search({query:"",limit:100});',
      tools: catalogTools,
    })
  );
  expect(searched.ok).toBe(true);
  return Buffer.byteLength(JSON.stringify(searched));
};

test("output types preserve decision fields within a bounded catalog growth ratio", async () => {
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
  const makeTools = (withOutput: boolean) =>
    Object.fromEntries(
      toolkits.flatMap((toolkit) =>
        Object.entries(toolkit.tools).map(([name, tool]) => {
          // SAFETY: Effect generates JSON Schema documents for both sides.
          const input = compactJsonSchema(
            EffectTool.getJsonSchema(tool) as Schema.Json,
            true
          ) as Tool.JsonSchema;
          // SAFETY: Effect generates a JSON Schema document for the encoded success.
          const output = withOutput
            ? (compactOutputSchema(
                EffectTool.getJsonSchemaFromSchema(
                  Schema.toEncoded(tool.successSchema)
                ) as Schema.Json,
                operationOutputDepth(name)
              ) as Tool.JsonSchema)
            : {};
          return [
            name,
            Tool.make({
              description: EffectTool.getDescription(tool) ?? name,
              execute: () => Effect.succeed(null),
              input,
              output,
            }),
          ];
        })
      )
    );
  const tools = makeTools(true);
  const untyped = makeTools(false);
  const optional = new Set([
    ...Object.keys(OnboardingTools.tools),
    ...Object.keys(PursuitTools.tools),
  ]);
  const withoutOptional = <Value>(entries: Record<string, Value>) =>
    Object.fromEntries(
      Object.entries(entries).filter(([name]) => !optional.has(name))
    );
  // Result types may grow the catalog by at most 45% over the same catalog
  // without them, for every toolkit and for the default (no optional) catalog.
  const ratio = async (
    typed: typeof tools,
    plain: typeof tools
  ): Promise<number> => {
    const [typedBytes, plainBytes] = await Promise.all([
      catalogBytes(typed),
      catalogBytes(plain),
    ]);
    return typedBytes / plainBytes;
  };
  expect(await ratio(tools, untyped)).toBeLessThanOrEqual(1.45);
  expect(
    await ratio(withoutOptional(tools), withoutOptional(untyped))
  ).toBeLessThanOrEqual(1.45);
  const result = await Effect.runPromise(
    CodeMode.execute({ code: 'return search({query:"",limit:100});', tools })
  );
  expect(result.ok).toBe(true);
  const rendered = JSON.stringify(result);

  expect(rendered).not.toContain("agent_browser_act(): Promise<unknown>");

  if (!result.ok) {
    throw new Error("Search failed");
  }
  const catalog = Schema.decodeUnknownSync(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({ path: Schema.String, signature: Schema.String })
      ),
    })
  )(result.value);
  for (const item of catalog.items) {
    expect(item.signature.split("): Promise<")[1]).not.toContain("/**");
  }
  const signature = (name: string) =>
    catalog.items.find((item) => item.path === `tools.${name}`)?.signature;
  const returnBytes = (name: string) =>
    Buffer.byteLength(signature(name)?.split("): Promise<")[1] ?? "");
  // Generous per-operation bounds catch a lost depth limit or input echo.
  expect(returnBytes("agent_browser_act")).toBeLessThan(3000);
  expect(returnBytes("agent_session_get")).toBeLessThan(2000);
  // Effect's non-finite number encoding must keep rendering as `number`.
  for (const name of [
    "agent_browser_screenshot",
    "agent_teaching_keyframe_get",
  ]) {
    expect(signature(name)?.split("): Promise<")[1]).toMatch(
      /\bbytes\??: number,/u
    );
  }
  for (const item of catalog.items) {
    expect(item.signature.split("): Promise<")[1]).not.toMatch(
      /"(?:-?Infinity|NaN)"/u
    );
  }
  expect(signature("agent_browser_act")).toContain("snapshot: {");
  expect(signature("agent_browser_act")).toContain("snapshotId: string");
  expect(signature("agent_browser_act")).toContain("text?: string | null");
  for (const key of [
    "entry: {",
    "id: string",
    "at: string",
    "effect?:",
    "dispatched?: boolean",
    'kind: "none"',
    'kind: "observed"',
    'outcome: "completed" | "failed" | "interrupted" | "refused"',
    "coverage?:",
    "settle?:",
  ]) {
    expect(signature("agent_browser_act")).toContain(key);
  }
  expect(signature("agent_session_get")).toContain(
    "eventCursor?: string | null"
  );
  expect(signature("agent_session_get")).not.toContain(
    "[key: string]: unknown"
  );
  expect(signature("agent_session_get")).toContain(
    'activity: "teaching" | "run"'
  );
  expect(signature("agent_session_get")).not.toContain(
    '"teaching" | "run" | "teaching"'
  );
  expect(signature("agent_browser_act")).toContain("action: unknown");
  // Compare every declared session key, including alternatives and references,
  // against CodeMode's public renderer, rather than maintaining an allowlist.
  // SAFETY: Effect emits an object JSON Schema document.
  const sessionSchema = EffectTool.getJsonSchemaFromSchema(
    Schema.toEncoded(AgentSessionTools.tools.agent_session_get.successSchema)
  ) as { [key: string]: Schema.Json };
  const declaredKeys = (value: Schema.Json | undefined): string[] => {
    if (!schemaObject(value)) {
      return [];
    }
    if (Predicate.isString(value.$ref)) {
      const name = value.$ref.split("/").at(-1);
      return name === undefined
        ? []
        : declaredKeys(
            schemaObject(sessionSchema.$defs)
              ? sessionSchema.$defs[name]
              : undefined
          );
    }
    return [
      ...Object.keys(schemaObject(value.properties) ? value.properties : {}),
      ...[value.anyOf, value.oneOf].flatMap((members) =>
        Array.isArray(members) ? members.flatMap(declaredKeys) : []
      ),
    ];
  };
  // SAFETY: Effect emits a JSON Schema document.
  for (const key of new Set(declaredKeys(sessionSchema as Schema.Json))) {
    expect(signature("agent_session_get")).toMatch(
      new RegExp(`\\b${key}\\??:`, "u")
    );
  }
  for (const name of [
    "agent_browser_act",
    "agent_browser_snapshot",
    "agent_session_get",
    "agent_session_start",
  ]) {
    expect(signature(name)).toContain("): Promise<{");
    expect(signature(name)?.split("): Promise<")[1]).not.toMatch(
      /@(?:min|max|pattern|integer)/u
    );
  }
});

test("output projection resolves references, strips validation, and elides deep objects", () => {
  expect(
    compactOutputSchema({
      $defs: {
        Item: {
          properties: {
            child: { properties: { deep: { type: "string" } }, type: "object" },
            name: { description: "Name", maxLength: 10, type: "string" },
          },
          type: "object",
        },
      },
      properties: { item: { $ref: "#/$defs/Item" } },
      type: "object",
    })
  ).toEqual({
    properties: {
      item: {
        properties: {
          child: {},
          name: { type: "string" },
        },
        type: "object",
      },
    },
    type: "object",
  });
});

test("published output schemas decode real MCP results including trimmed action and Snapshot shapes", () => {
  // Captured through agent_code_execute against the isolated ecommerce fixture.
  // Decode both the encoded success and the exact schema given to CodeMode.
  for (const [name, values] of Object.entries(outputValues)) {
    const tool = Object.entries(AgentSessionTools.tools).find(
      ([operation]) => operation === name
    )?.[1];
    if (tool === undefined) {
      throw new Error(name);
    }
    const encoded = Schema.toEncoded(tool.successSchema);
    // SAFETY: Effect generates JSON Schema; compaction retains schema keywords.
    const published = compactOutputSchema(
      EffectTool.getJsonSchemaFromSchema(encoded) as Schema.Json,
      operationOutputDepth(name)
    ) as JsonSchema.JsonSchema;
    // SAFETY: importing these generated JSON Schemas uses only built-in codecs,
    // with no decoding services. The importer returns Top for arbitrary revivers.
    const imported = SchemaRepresentation.fromJsonSchemaDocument({
      definitions: {},
      dialect: "draft-2020-12",
      schema: published,
    }) as Schema.Decoder<unknown>;
    for (const value of values) {
      expect(
        () => Schema.decodeUnknownSync(encoded)(value),
        name
      ).not.toThrow();
      expect(Schema.decodeUnknownSync(imported)(value), name).toEqual(value);
    }
  }
  const [action] = outputValues.agent_browser_act;
  expect(action).not.toHaveProperty("url");
  expect(action?.entry).not.toHaveProperty("actor");
  expect(action?.entry).not.toHaveProperty("description");
  expect(action?.entry).not.toHaveProperty("dispatched");
  expect(action?.snapshot).not.toHaveProperty("capturedAt");
  expect(action?.snapshot).not.toHaveProperty("nodes");
  expect(action?.snapshot).not.toHaveProperty("coverage");
  expect(action?.snapshot).not.toHaveProperty("settle");
});

test("raw CodeMode output schemas render encoded types without decoding or dropping result fields", async () => {
  const success = Schema.Struct({ count: Schema.NumberFromString });
  // SAFETY: Effect generates the encoded JSON Schema document.
  const output = compactOutputSchema(
    EffectTool.getJsonSchemaFromSchema(Schema.toEncoded(success)) as Schema.Json
  ) as Tool.JsonSchema;
  const tools = {
    encoded: Tool.make({
      description: "Encoded result",
      execute: () => Effect.succeed({ count: "42", extra: "retained" }),
      input: {},
      output,
    }),
  };
  const search = await Effect.runPromise(
    CodeMode.execute({ code: 'return search({query:"encoded"})', tools })
  );
  expect(JSON.stringify(search)).toContain("count: string");
  const result = await Effect.runPromise(
    CodeMode.execute({ code: "return await tools.encoded({})", tools })
  );
  expect(result).toMatchObject({
    ok: true,
    value: { count: "42", extra: "retained" },
  });
});

test("output compaction terminates recursive references and preserves own __proto__ keys", () => {
  const schema = {
    $defs: {
      Recursive: {
        properties: { child: { $ref: "#/$defs/Recursive" } },
        type: "object",
      },
    },
    properties: Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["recursive", { $ref: "#/$defs/Recursive" }],
    ]),
    type: "object",
  };
  const output = compactOutputSchema(schema);
  // Prove the transport retains own data keys as well as the in-memory schema.
  const serialized = JSON.stringify(output);
  expect(JSON.parse(serialized)).toEqual({
    properties: Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["recursive", { properties: { child: {} }, type: "object" }],
    ]),
    type: "object",
  });
});

const variant = (kind: string) => ({
  additionalProperties: false,
  properties: { kind: { const: kind }, value: { type: "string" } },
  required: ["kind", "value"],
  type: "object",
});

test("retains wide nested keys, optionality and literal discriminated unions", async () => {
  const output = compactOutputSchema({
    additionalProperties: false,
    properties: {
      deep: {
        properties: {
          nested: { properties: { child: { type: "object" } }, type: "object" },
        },
        type: "object",
      },
      result: { anyOf: [variant("yes"), variant("no")] },
      wide: {
        additionalProperties: false,
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [
            `field${index}`,
            { type: "string" },
          ])
        ),
        required: ["field0"],
        type: "object",
      },
    },
    required: ["wide", "result"],
    type: "object",
  });
  // SAFETY: the projection emits a JSON Schema document for CodeMode.
  const result = await Effect.runPromise(
    CodeMode.execute({
      code: 'return search({query:"inspect"});',
      tools: {
        inspect: Tool.make({
          description: "Inspect",
          execute: () => Effect.succeed(null),
          input: {},
          output: output as Tool.JsonSchema,
        }),
      },
    })
  );
  const rendered = JSON.stringify(result);
  for (let index = 0; index < 8; index += 1) {
    expect(rendered).toContain(
      `field${index}${index === 0 ? "" : "?"}: string`
    );
  }
  expect(rendered).toContain(JSON.stringify('kind: "yes"').slice(1, -1));
  expect(rendered).toContain(JSON.stringify('kind: "no"').slice(1, -1));
  expect(rendered).not.toContain("[key: string]");
  expect(rendered).toContain("nested?: unknown");
});

test("deduplicates overlapping enum and const alternatives after merging envelopes", () => {
  const activity = {
    anyOf: [{ enum: ["teaching", "run", "run"] }, { const: "teaching" }],
  };
  expect(
    compactOutputSchema({
      anyOf: [
        { properties: { activity }, required: ["activity"], type: "object" },
        {
          properties: { activity: { enum: ["run", "teaching"] } },
          required: ["activity"],
          type: "object",
        },
      ],
    })
  ).toEqual({
    properties: { activity: { enum: ["teaching", "run"] } },
    required: ["activity"],
    type: "object",
  });
  expect(
    compactOutputSchema({
      anyOf: [{ const: "same" }, { enum: ["same", "same"] }],
    })
  ).toEqual({ const: "same" });
});

test("collapses number sentinels without typing mixed literal enums", () => {
  const sentinel = { enum: ["NaN", "Infinity", "-Infinity"], type: "string" };
  expect(
    compactOutputSchema({ anyOf: [{ type: "number" }, sentinel] })
  ).toEqual({ type: "number" });
  expect(
    compactOutputSchema({
      anyOf: [{ type: "number" }, sentinel, { type: "null" }],
    })
  ).toEqual({ anyOf: [{ type: "number" }, { const: null }] });
  expect(
    compactOutputSchema({
      anyOf: [{ type: "null" }, { enum: ["a"], type: "string" }],
    })
  ).toEqual({ enum: [null, "a"] });
});

test("flattens nested unions so null and literals render once", () => {
  expect(
    compactOutputSchema({
      anyOf: [
        { anyOf: [{ type: "string" }, { type: "null" }] },
        { type: "null" },
        { enum: ["a", null] },
      ],
    })
  ).toEqual({ anyOf: [{ type: "string" }, { enum: [null, "a"] }] });
});

test("elides boundary input echoes at every output depth without changing the source schema", () => {
  const boundary = {
    properties: {
      action: {
        properties: { ref: { type: "string" }, type: { const: "click" } },
        type: "object",
      },
      id: { type: "string" },
    },
    type: "object",
  };
  const schema = {
    $defs: { AgentExecutionBoundary: boundary },
    properties: { intervention: { $ref: "#/$defs/AgentExecutionBoundary" } },
    type: "object",
  };
  for (const depth of [2, 3, 4]) {
    expect(compactOutputSchema(schema, depth)).toEqual({
      properties: {
        intervention: {
          properties: { action: {}, id: { type: "string" } },
          type: "object",
        },
      },
      type: "object",
    });
  }
  expect(boundary.properties.action.properties).toHaveProperty("ref");
});
