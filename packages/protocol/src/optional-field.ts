import { Schema, SchemaGetter } from "effect";

/**
 * An optional field whose published JSON Schema tells the truth.
 *
 * `Schema.optional` is `optionalKey(UndefinedOr(S))`, and the JSON Schema
 * emitted for an MCP tool's parameters renders that `undefined` branch as
 * `{ "type": "null" }`. A client that trusts the advertised contract and sends
 * `null` is then refused with `Expected string | undefined` — a type the schema
 * never showed it (issue #129).
 *
 * The encoded side is `NullOr`, so the published schema offers exactly the two
 * branches it honours and no duplicate `null`: the value, or `null`. `null` and
 * an absent key both decode to `undefined`, which is what the advertised `null`
 * branch promises: "not provided". Encoding never emits `null`; an absent field
 * stays absent.
 *
 * Wire input never carries `undefined`, so the encoded side does not accept it:
 * an in-process caller omits the key rather than passing an explicit
 * `undefined`.
 */
export const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.NullOr(schema).pipe(
      Schema.decodeTo(Schema.UndefinedOr(schema), {
        decode: SchemaGetter.transform(
          (value: S["Type"] | null) => value ?? undefined
        ),
        encode: SchemaGetter.transform(
          (value: S["Type"] | undefined) => value ?? undefined
        ),
      })
    )
  );
