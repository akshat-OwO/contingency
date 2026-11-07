import { Predicate } from "effect";
import type { Schema } from "effect";

const isSchemaObject = (
  value: Schema.Json
): value is { [key: string]: Schema.Json } => Predicate.isObject(value);

const maps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const children = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
]);
const noise = new Set(["title", "examples", "identifier"]);
const normalized = (value: string) =>
  value.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

const redundantDescription = (
  key: string,
  description: string | undefined,
  name: string | undefined
) =>
  key === "description" &&
  description !== undefined &&
  name !== undefined &&
  normalized(description) === normalized(name);

const freeString = (value: Record<string, Schema.Json>) =>
  value.type === "string" &&
  value.enum === undefined &&
  value.const === undefined;

const omitMinimum = (
  value: Record<string, Schema.Json>,
  description: string | undefined,
  elide: boolean
) =>
  elide
    ? freeString(value) && value.minLength === 1
    : value.minLength === 1 &&
      description !== undefined &&
      /\bnon[ -]?empty\b/iu.test(description);

const initialProjection = (
  value: Record<string, Schema.Json>,
  elide: boolean
): Record<string, Schema.Json> =>
  elide && freeString(value) && value.minLength === undefined
    ? { minLength: 0 }
    : {};

/** Render-only projection. Never use this document to validate operation inputs.
 * Traverse schema keywords only: defaults, enums and extension data are values.
 * Keep IDs because they can establish the base URI of relative references.
 */
export const compactJsonSchema = (
  schema: Schema.Json,
  elideStringMinimum = false
): Schema.Json => {
  const visit = (value: Schema.Json, name?: string): Schema.Json => {
    if (!isSchemaObject(value)) {
      return value;
    }
    // The minimum projection runs once on original validation schemas.
    const result = initialProjection(value, elideStringMinimum);
    const description = Predicate.isString(value.description)
      ? value.description
      : undefined;
    for (const [key, child] of Object.entries(value)) {
      if (noise.has(key) || redundantDescription(key, description, name)) {
        continue;
      }
      // Only literal repetition proves that removing a pattern loses no information.
      if (
        key === "pattern" &&
        Predicate.isString(child) &&
        description?.includes(child)
      ) {
        continue;
      }
      if (
        key === "minLength" &&
        omitMinimum(value, description, elideStringMinimum)
      ) {
        continue;
      }
      if (maps.has(key) && isSchemaObject(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([field, item]) => [
            field,
            visit(item, field),
          ])
        );
      } else if (children.has(key)) {
        result[key] = Array.isArray(child)
          ? child.map((item) => visit(item))
          : visit(child);
      } else {
        result[key] = child;
      }
    }
    return result;
  };
  return visit(schema);
};
