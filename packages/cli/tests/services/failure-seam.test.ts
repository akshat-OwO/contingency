import {
  AgentSessionId,
  BrowserRpcError,
  RpcFailures,
} from "@contingency/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Logger, References, Schema } from "effect";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";

import { toSafeRecord } from "../../src/services/diagnostic-log.ts";
import type { SafeRecord } from "../../src/services/diagnostic-log.ts";
import {
  FailureReferences,
  makeFailureReferenceStore,
} from "../../src/services/failure-reference.ts";
import { RpcFailuresLive } from "../../src/services/failure-seam.ts";

const ISSUED = Schema.decodeSync(AgentSessionId)("agent-issued-by-start");
const UNKNOWN = Schema.decodeSync(AgentSessionId)("agent-hunter2-private");

class SessionRpcs extends RpcGroup.make(
  Rpc.make("session.start", {
    error: BrowserRpcError,
    success: Schema.Struct({ session: Schema.Struct({ id: AgentSessionId }) }),
  }),
  Rpc.make("session.crash", {
    error: BrowserRpcError,
    payload: { sessionId: AgentSessionId },
  })
).middleware(RpcFailures) {}

const HandlersLive = SessionRpcs.toLayer({
  "session.crash": () => Effect.die("boom"),
  "session.start": () => Effect.succeed({ session: { id: ISSUED } }),
});

describe("an RPC defect record", () => {
  it.effect(
    "names a session an earlier RPC issued, and never an unknown one",
    () =>
      Effect.gen(function* startThenCrash() {
        const records: SafeRecord[] = [];
        const logger = Logger.make((event) => {
          records.push(toSafeRecord(event, ""));
        });
        yield* Effect.gen(function* calls() {
          const client = yield* RpcTest.makeClient(SessionRpcs);
          yield* client["session.crash"]({ sessionId: UNKNOWN }).pipe(
            Effect.flip
          );
          const { session } = yield* client["session.start"]();
          yield* client["session.crash"]({ sessionId: session.id }).pipe(
            Effect.flip
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(HandlersLive),
          Effect.provide(RpcFailuresLive),
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provideService(FailureReferences, makeFailureReferenceStore())
        );
        const defects = records.filter((record) =>
          JSON.stringify(record).includes("session.crash")
        );
        expect(defects.length).toBe(2);
        for (const record of records) {
          expect(JSON.stringify(record)).not.toContain("hunter2-private");
        }
        expect(JSON.stringify(defects[1])).toContain(ISSUED);
      })
  );
});
