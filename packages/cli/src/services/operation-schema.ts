import { Predicate } from "effect";
import type { Schema } from "effect";

const isSchemaObject = (
  value: Schema.Json | undefined
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
      let projected = child;
      if (maps.has(key) && isSchemaObject(child)) {
        projected = Object.fromEntries(
          Object.entries(child).map(([field, item]) => [
            field,
            visit(item, field),
          ])
        );
      } else if (children.has(key)) {
        projected = Array.isArray(child)
          ? child.map((item) => visit(item))
          : visit(child);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: projected,
        writable: true,
      });
    }
    return result;
  };
  return visit(schema);
};

const outputNoise = new Set([
  "$defs",
  "definitions",
  "description",
  "default",
  "deprecated",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const uniqueSchemas = (schemas: readonly Schema.Json[]) => [
  ...new Map(
    schemas.map((schema) => [JSON.stringify(schema), schema])
  ).values(),
];

const literals = (value: Schema.Json | undefined): readonly Schema.Json[] => {
  if (!isSchemaObject(value)) {
    return [];
  }
  if (value.const !== undefined) {
    return [value.const];
  }
  return Array.isArray(value.enum) ? value.enum : [];
};

/** A union with no other keywords contributes its members to its parent. */
const flattenAlternatives = (
  members: readonly Schema.Json[]
): readonly Schema.Json[] =>
  members.flatMap((member) => {
    if (!isSchemaObject(member)) {
      return [member];
    }
    const keys = Object.keys(member);
    const nested = member.anyOf ?? member.oneOf;
    return keys.length === 1 && Array.isArray(nested)
      ? flattenAlternatives(nested)
      : [member];
  });

const numberSentinels = new Set<Schema.Json>(["NaN", "Infinity", "-Infinity"]);

/** Effect encodes a non-finite-capable number as `number` plus a string enum
 * of these sentinels; CodeMode renders that pair as `number` only while the
 * enum keeps its string type, so fold the sentinel before literal merging. */
const isNumberSentinel = (member: Schema.Json): boolean =>
  isSchemaObject(member) &&
  member.type === "string" &&
  Array.isArray(member.enum) &&
  member.enum.length > 0 &&
  member.enum.every((value) => numberSentinels.has(value));

const withoutNumberSentinels = (
  members: readonly Schema.Json[]
): readonly Schema.Json[] =>
  members.some((member) => isSchemaObject(member) && member.type === "number")
    ? members.filter((member) => !isNumberSentinel(member))
    : members;

/** Literal alternatives can overlap after full/compact envelopes merge, and
 * nested optional unions repeat `null` as both a type and a literal. */
const outputAlternatives = (members: readonly Schema.Json[]): Schema.Json[] => {
  const values: Schema.Json[] = [];
  const others: Schema.Json[] = [];
  for (const member of withoutNumberSentinels(flattenAlternatives(members))) {
    const items =
      isSchemaObject(member) &&
      member.type === "null" &&
      Object.keys(member).length === 1
        ? [null]
        : literals(member);
    if (
      items.length > 0 &&
      items.every((item) => !Predicate.isObjectOrArray(item))
    ) {
      values.push(...items);
    } else {
      others.push(member);
    }
  }
  const unique = uniqueSchemas(values);
  return uniqueSchemas([
    ...others,
    ...(unique.length === 0
      ? []
      : [
          unique.length === 1 ? { const: unique[0] ?? null } : { enum: unique },
        ]),
  ]);
};

/** Merge only object alternatives without a shared required literal discriminant.
 * This widens correlations in untagged envelopes, such as full/compact sessions.
 * Preserve their actual additional-properties policy rather than inventing one. */
const mergeOutputObjects = (
  members: readonly Schema.Json[]
): Schema.Json | undefined => {
  if (
    !members.every(
      (member) =>
        isSchemaObject(member) &&
        member.type === "object" &&
        isSchemaObject(member.properties)
    )
  ) {
    return undefined;
  }
  if (members.length < 2) {
    return undefined;
  }
  const objects = members.filter(isSchemaObject);
  const [first] = objects;
  if (first === undefined || !isSchemaObject(first.properties)) {
    return undefined;
  }
  for (const key of Object.keys(first.properties)) {
    const tags = objects.map((member) =>
      Array.isArray(member.required) &&
      member.required.includes(key) &&
      isSchemaObject(member.properties)
        ? literals(member.properties[key])
        : []
    );
    if (
      tags.every((values) => values.length > 0) &&
      tags.every((values, index) =>
        tags
          .slice(index + 1)
          .every((other) => values.every((value) => !other.includes(value)))
      )
    ) {
      return undefined;
    }
  }
  if (
    objects.some(
      (member) =>
        JSON.stringify(member.additionalProperties) !==
        JSON.stringify(first.additionalProperties)
    )
  ) {
    return undefined;
  }
  const fields = new Map<string, Schema.Json[]>();
  for (const member of objects) {
    if (isSchemaObject(member.properties)) {
      for (const [key, value] of Object.entries(member.properties)) {
        fields.set(key, [...(fields.get(key) ?? []), value]);
      }
    }
  }
  const result = {
    properties: Object.fromEntries(
      [...fields].map(([key, values]) => {
        const alternatives = outputAlternatives(
          values.flatMap((value) =>
            isSchemaObject(value) && Array.isArray(value.anyOf)
              ? value.anyOf
              : [value]
          )
        );
        return [
          key,
          alternatives.length === 1
            ? (alternatives[0] ?? {})
            : { anyOf: alternatives },
        ];
      })
    ),
    required: [...fields.keys()].filter((key) =>
      objects.every(
        (member) =>
          Array.isArray(member.required) && member.required.includes(key)
      )
    ),
    type: "object",
  };
  return first.additionalProperties === undefined
    ? result
    : { ...result, additionalProperties: first.additionalProperties };
};

/** Render-only output projection. Property nesting, not union branches, spends
 * the depth budget. Resolve local references before elision so definitions
 * cannot bypass the budget. Validation belongs to the original success schema.
 */
export const compactOutputSchema = (
  schema: Schema.Json,
  maxDepth = 2
): Schema.Json => {
  const root = isSchemaObject(schema) ? schema : {};
  const definitions = root.$defs ?? root.definitions;
  // Union and reference handling keep the budget independent of schema layout.
  // oxlint-disable-next-line complexity
  const visit = (
    value: Schema.Json,
    depth: number,
    seen: ReadonlySet<string>
  ): Schema.Json => {
    if (!isSchemaObject(value)) {
      return value;
    }
    if (Predicate.isString(value.$ref)) {
      const name = value.$ref
        .replace(/^#\/(?:\$defs|definitions)\//u, "")
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (
        !isSchemaObject(definitions) ||
        !Object.hasOwn(definitions, name) ||
        definitions[name] === undefined ||
        seen.has(name)
      ) {
        return {};
      }
      const definition = definitions[name] ?? {};
      // The boundary repeats the caller's browser/device action, including eval
      // scripts and upload paths. Keep its identity and decision fields instead.
      const projected =
        name === "AgentExecutionBoundary" &&
        isSchemaObject(definition) &&
        isSchemaObject(definition.properties)
          ? {
              ...definition,
              properties: { ...definition.properties, action: {} },
            }
          : definition;
      return visit(projected, depth, new Set([...seen, name]));
    }
    if (
      depth >= maxDepth &&
      (value.properties !== undefined || value.items !== undefined)
    ) {
      return {};
    }
    const result: Record<string, Schema.Json> = {};
    for (const [key, child] of Object.entries(value)) {
      if (outputNoise.has(key)) {
        continue;
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
      if (maps.has(key) && isSchemaObject(child)) {
        result[key] = Object.fromEntries(
          Object.entries(child).map(([name, item]) => [
            name,
            visit(item, depth + 1, seen),
          ])
        );
      } else if (children.has(key)) {
        const next =
          key === "items" || key === "additionalProperties" ? depth + 1 : depth;
        result[key] = Array.isArray(child)
          ? child.map((item) => visit(item, next, seen))
          : visit(child, next, seen);
      } else if (key === "enum" && Array.isArray(child)) {
        result[key] = uniqueSchemas(child);
      } else {
        result[key] = key === "type" && child === "integer" ? "number" : child;
      }
    }
    for (const key of ["anyOf", "oneOf"]) {
      const members = result[key];
      if (Array.isArray(members)) {
        const alternatives = outputAlternatives(members);
        if (alternatives.length === 1) {
          return alternatives[0] ?? {};
        }
        const merged = mergeOutputObjects(alternatives);
        if (merged !== undefined) {
          return merged;
        }
        result[key] = alternatives;
      }
    }
    return result;
  };
  return visit(compactJsonSchema(schema), 0, new Set());
};

/** Spend detail on action receipts and observations. Other operations retain
 * their entire root envelope, with nested values elided to bound repetition. */
export const operationOutputDepth = (name: string): number => {
  if (name === "agent_browser_act") {
    return 3;
  }
  return name === "agent_browser_snapshot" ? 2 : 1;
};
