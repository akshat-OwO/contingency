import type { AgentSessionId } from "@contingency/protocol";
import { Effect, Option } from "effect";
import { McpSchema } from "effect/ai";
import { Atom, AtomRegistry } from "effect/reactivity";

/** One offer per completed passing Dry Run, including replayed completions. */
export const makeVerificationElicitation = () => {
  const registry = AtomRegistry.make();
  const offered = Atom.make<ReadonlySet<AgentSessionId>>(
    new Set<AgentSessionId>()
  ).pipe(Atom.keepAlive);
  return (sessionId: AgentSessionId, viewUrl: string) =>
    Effect.gen(function* offerWorkspaceVerification() {
      // Effect only provides McpServerClient for a stateful negotiated revision.
      // Stateless 2026-07-28 calls have no reverse client.
      const connected = yield* Effect.serviceOption(McpSchema.McpServerClient);
      if (
        Option.isNone(connected) ||
        connected.value.clientCapabilities.elicitation?.url === undefined
      ) {
        return;
      }
      const client = connected.value;
      const first = yield* Effect.sync(() => {
        const previous = registry.get(offered);
        if (previous.has(sessionId)) {
          return false;
        }
        registry.set(offered, new Set(previous).add(sessionId));
        return true;
      });
      if (!first) {
        return;
      }
      // The offer cannot block completion. Closing/disconnecting the client or
      // declining it leaves the persisted Dry Run result untouched.
      yield* Effect.gen(function* elicitVerificationUrl() {
        const reverse = yield* client.getClient;
        yield* reverse.elicit(
          new McpSchema.ElicitRequestURLParams({
            elicitationId: `verify-${sessionId}`,
            message:
              "The Dry Run passed. Verify or reject the Flow Skill in Workspace.",
            mode: "url",
            url: viewUrl,
          })
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption("50 seconds"),
        Effect.ignore,
        Effect.forkDetach
      );
    });
};
