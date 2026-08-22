import { Schema } from "effect";

export const Viewport = Schema.Struct({
  deviceScaleFactor: Schema.Finite.check(
    Schema.isBetween({ maximum: 4, minimum: 0.25 })
  ),
  height: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 })),
  width: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 })),
});
export type Viewport = typeof Viewport.Type;
