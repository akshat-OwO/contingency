import { Effect, Effectable, Schema } from "effect";
import type { Toolkit, Tool } from "effect/unstable/ai";
import { AiError } from "effect/unstable/ai";

/**
 * Effect decodes a tool's parameters with the default parse options, which
 * strip keys the schema never declared. An agent that supplies its own
 * `evidence` for an Agent Step is therefore told the save succeeded while the
 * key is silently dropped, unlike the compiler's other refusals
 * ([ADR 0025](../../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 * Every tool refuses an undeclared property instead
 * ([ADR 0036](../../../../docs/adr/0036-mcp-tool-parameters-reject-excess-properties.md)).
 * `onExcessProperty` is a decode-time option rather than something a schema can
 * carry, so strictness is introduced here, once, in front of every tool's
 * decode: the published JSON Schema already says `additionalProperties: false`,
 * and this is what makes the runtime honour it.
 */
const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the boundary that parses an MCP client's payload; its input is unknown by definition.
type Decoder = (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>;

const decoders = <Tools extends Record<string, Tool.Any>>(
  tools: Tools
): ReadonlyMap<string, Decoder> => {
  const output = new Map<string, Decoder>();
  for (const [name, tool] of Object.entries(tools)) {
    if (Schema.isSchema(tool.parametersSchema)) {
      // SAFETY: `isSchema` established that the parameters are a codec, and the
      // decoder is only ever applied to the payload of the tool it was built
      // for; its decoded output is discarded.
      output.set(
        name,
        Schema.decodeUnknownEffect(
          tool.parametersSchema as Schema.Codec<unknown, unknown>,
          strictParseOptions
        ) as Decoder
      );
    }
  }
  return output;
};

/**
 * Refuses a tool call whose parameters carry a property the schema does not
 * declare. The refusal names the path to the offending key and reaches the MCP
 * client the same way any other rejected parameter does; no handler runs, so a
 * rejected call performs no browser action, writes nothing, and consumes no
 * operation id.
 */
export const withStrictParameters = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): Toolkit.Toolkit<Tools> => {
  const decode = decoders(toolkit.tools);

  const rejectExcess = (
    name: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- These are the raw parameters this refusal exists to parse.
    params: unknown
  ): Effect.Effect<void, AiError.AiError> => {
    const decodeParameters = decode.get(name);
    if (decodeParameters === undefined) {
      return Effect.void;
    }
    return decodeParameters(params).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        AiError.make({
          method: `${name}.handle`,
          module: "Toolkit",
          reason: new AiError.ToolParameterValidationError({
            description: cause.message,
            toolName: name,
            toolParams: params,
          }),
        })
      )
    );
  };

  // The tools themselves are reused unchanged, so every published JSON Schema
  // stays byte-for-byte what it was; only the decode in front of the handler
  // becomes strict.
  // SAFETY: the wrapped `handle` forwards exactly what the built toolkit's own
  // `handle` accepts; the name and parameters are widened only because this
  // wrapper is generic over the toolkit's tools.
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- `Effect.map` is not an array method.
  const strict = Effect.map(toolkit, (built) => ({
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The parameters are parsed by `rejectExcess` and again by the toolkit's own decode.
    handle: ((name: string, params: unknown, toolCallId?: string) =>
      Effect.flatMap(rejectExcess(name, params), () =>
        built.handle(name as keyof Tools, params as never, toolCallId)
      )) as Toolkit.WithHandler<Tools>["handle"],
    tools: built.tools,
  }));

  // SAFETY: a toolkit is a callable object carrying its tools plus the Effect
  // primitive that builds their handlers. Copying the original's properties and
  // overriding only that primitive keeps the rest of the contract — `tools`,
  // `of`, `toHandlers`, `toLayer` — exactly as Effect built it.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- `Object.assign` cannot express that the merged object is still a toolkit.
  return Object.assign(
    () => {
      // A toolkit is a callable object; the call itself is never used.
    },
    toolkit,
    Effectable.Prototype<
      Effect.Effect<Toolkit.WithHandler<Tools>, never, Tool.HandlersFor<Tools>>
    >({
      evaluate: () => strict,
      label: "StrictToolkit",
    })
  ) as unknown as Toolkit.Toolkit<Tools>;
};
