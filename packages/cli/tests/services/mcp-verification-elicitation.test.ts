import { AgentSessionId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { McpSchema } from "effect/ai";

import { makeVerificationElicitation } from "../../src/services/mcp-verification-elicitation.ts";

it.live.each([undefined, "http://127.0.0.1:1234/?session=teaching"])(
  "offers review without deciding and includes the live Teaching URL when present (%s)",
  (teachingViewUrl) =>
    Effect.gen(function* verificationOffer() {
      const offer = makeVerificationElicitation();
      const offered = yield* Deferred.make<McpSchema.ElicitRequestURLParams>();
      let calls = 0;
      const capabilities = { elicitation: { url: {} } };
      const clientInfo = { name: "test", version: "1" };
      const client = McpSchema.McpServerClient.of({
        clientCapabilities: capabilities,
        clientId: 1,
        clientInfo,
        getClient: Effect.succeed({
          createMessage: () => Effect.die("Unexpected sampling"),
          elicit: (request) =>
            Effect.gen(function* answerOffer() {
              if (request.mode !== "url") {
                return yield* Effect.die("Expected URL mode");
              }
              calls += 1;
              yield* Deferred.succeed(offered, request);
              return { action: "decline" as const };
            }),
          listRoots: () => Effect.die("Unexpected roots"),
        }),
        initializePayload: {
          capabilities,
          clientInfo,
          protocolVersion: "2025-11-25",
        },
        protocolVersion: "2025-11-25",
      });
      const id = AgentSessionId.make("agent-offer-test");
      yield* offer(
        id,
        "http://127.0.0.1:1234/?recording=offer-test",
        teachingViewUrl
      ).pipe(Effect.provideService(McpSchema.McpServerClient, client));
      const request = yield* Deferred.await(offered);
      expect(request.mode).toBe("url");
      expect(request.url).toContain("recording=offer-test");
      expect(request.message).toContain(
        "tell your agent whether to verify or reject"
      );
      expect(request.message).toContain(
        "Opening or dismissing this prompt does not decide."
      );
      if (teachingViewUrl === undefined) {
        expect(request.message).not.toContain("live Teaching Workspace");
      } else {
        expect(request.message).toContain(
          `live Teaching Workspace: ${teachingViewUrl}`
        );
        expect(request.message).toContain("Verify flow or Reject flow");
      }
      yield* offer(id, request.url).pipe(
        Effect.provideService(McpSchema.McpServerClient, client)
      );
      expect(calls).toBe(1);
      yield* offer(AgentSessionId.make("agent-stateless"), request.url);
      yield* offer(AgentSessionId.make("agent-unsupported"), request.url).pipe(
        Effect.provideService(McpSchema.McpServerClient, {
          ...client,
          clientCapabilities: {},
        })
      );
      expect(calls).toBe(1);
    })
);
