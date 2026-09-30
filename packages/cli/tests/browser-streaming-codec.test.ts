import {
  BrowserStreamEvent,
  BrowserStreamId,
  FrameSequence,
} from "@contingency/protocol";
import { it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { RpcSerialization } from "effect/rpc";

const frame = {
  data: Uint8Array.from({ length: 100_000 }, (_, index) => index % 256),
  metadata: {
    deviceHeight: 480,
    deviceWidth: 640,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    timestamp: 1,
  },
  seq: FrameSequence.make(1),
  streamId: BrowserStreamId.make("codec-test"),
  type: "frame" as const,
};
const chunkSchema = Schema.Struct({
  _tag: Schema.Literal("Chunk"),
  values: Schema.Unknown,
});
const valuesSchema = Schema.NonEmptyArray(BrowserStreamEvent);

it.effect(
  "keeps image bytes exact across binary and legacy JSON RPC chunks",
  () =>
    Effect.gen(function* roundTripImages() {
      const binary = yield* RpcSerialization.RpcSerialization;
      const encodeChunk = (
        serialization: RpcSerialization.RpcSerialization["Service"]
      ) => {
        const codec = serialization.codecFor(valuesSchema);
        const values = Schema.encodeSync(codec)([frame]);
        const parser = serialization.makeUnsafe();
        const wire = parser.encode({ _tag: "Chunk", requestId: "1", values });
        if (wire === undefined) {
          throw new Error("The frame was not encoded.");
        }
        const [envelope] = parser.decode(wire);
        const chunk = Schema.decodeUnknownSync(chunkSchema)(envelope);
        expect(Schema.decodeUnknownSync(codec)(chunk.values)).toEqual([frame]);
        return { envelope, wire };
      };
      const json = encodeChunk(RpcSerialization.json);
      const rawJson = Schema.decodeUnknownSync(
        Schema.Struct({
          values: Schema.NonEmptyArray(Schema.Struct({ data: Schema.String })),
        })
      )(json.envelope);
      expect(rawJson.values[0].data).toBe(
        Buffer.from(frame.data).toString("base64")
      );
      const encoded = encodeChunk(binary);
      expect(Buffer.byteLength(encoded.wire)).toBeLessThan(
        Buffer.byteLength(json.wire) * 0.77
      );
      // A WebSocket frame may arrive in pieces at the RPC parser boundary.
      const bytes = Schema.decodeUnknownSync(Schema.Uint8Array)(encoded.wire);
      const parser = binary.makeUnsafe();
      expect(parser.decode(bytes.subarray(0, 13))).toEqual([]);
      const [joined] = parser.decode(bytes.subarray(13));
      const chunk = Schema.decodeUnknownSync(chunkSchema)(joined);
      expect(
        Schema.decodeUnknownSync(binary.codecFor(valuesSchema))(chunk.values)
      ).toEqual([frame]);
    }).pipe(Effect.provide(RpcSerialization.layerSchemaBinary()))
);
