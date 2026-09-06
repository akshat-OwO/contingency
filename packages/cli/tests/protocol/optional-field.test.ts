import { optionalNullable } from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

const Struct = Schema.Struct({
  optional: optionalNullable(Schema.String),
  required: Schema.String,
});

const decode = Schema.decodeUnknownSync(Struct);
const encode = Schema.encodeUnknownSync(Struct);

test("the published schema offers the value and null, and nothing else", () => {
  const document = Schema.toJsonSchemaDocument(Struct) as unknown as {
    readonly schema: {
      readonly properties: Record<string, { readonly anyOf?: unknown }>;
      readonly required: readonly string[];
    };
  };
  expect(document.schema.properties.optional?.anyOf).toEqual([
    { type: "string" },
    { type: "null" },
  ]);
  expect(document.schema.required).toEqual(["required"]);
});

test("null and an absent key both decode to not provided", () => {
  expect(decode({ optional: null, required: "r" })).toEqual({
    optional: undefined,
    required: "r",
  });
  expect(decode({ required: "r" })).toEqual({ required: "r" });
  expect(decode({ optional: "value", required: "r" })).toEqual({
    optional: "value",
    required: "r",
  });
  expect(() => decode({ optional: 1, required: "r" })).toThrow();
});

// A value carrying an explicit `undefined` must encode the way
// `Schema.optional` encoded it — the key is dropped, never written as `null`.
test("encoding drops an undefined field rather than failing on it", () => {
  expect(encode({ optional: undefined, required: "r" })).toEqual({
    required: "r",
  });
  expect(encode({ required: "r" })).toEqual({ required: "r" });
  expect(encode({ optional: "value", required: "r" })).toEqual({
    optional: "value",
    required: "r",
  });
});
