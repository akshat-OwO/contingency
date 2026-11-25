import { Effect, Layer, Tracer } from "effect";

import { makeShareSafeTracer } from "../../src/services/share-safe-tracer.ts";

export interface RecordedSpan {
  readonly name: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly attributes: ReadonlyMap<string, unknown>;
}

/**
 * The production share-safe tracer, recording each span it starts so a test
 * can read names, parents, and attributes after the allowlist.
 */
export const makeRecordingTracer = (home: string) => {
  const spans: RecordedSpan[] = [];
  const layer = Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* wrapTracer() {
      const base = makeShareSafeTracer(yield* Effect.tracer, home);
      return Tracer.make({
        context: base.context,
        span: (options) => {
          const span = base.span(options);
          spans.push({
            attributes: span.attributes,
            name: span.name,
            parentSpanId:
              options.parent?._tag === "Some"
                ? options.parent.value.spanId
                : undefined,
            spanId: span.spanId,
          });
          return span;
        },
      });
    })
  );
  /** Whether `span` runs inside `ancestor`, at any depth. */
  const within = (span: RecordedSpan, ancestor: RecordedSpan | undefined) => {
    const byId = new Map(spans.map((each) => [each.spanId, each]));
    let parent = span.parentSpanId;
    while (parent !== undefined) {
      if (parent === ancestor?.spanId) {
        return true;
      }
      parent = byId.get(parent)?.parentSpanId;
    }
    return false;
  };
  return { layer, spans, within };
};
