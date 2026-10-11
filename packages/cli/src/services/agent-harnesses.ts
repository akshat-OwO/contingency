import { Effect, Layer } from "effect";

import { ClaudeHarness, ClaudeHarnessLive } from "./agent-harness-claude.ts";
import { CodexHarness, CodexHarnessLive } from "./agent-harness-codex.ts";
import { AgentHarnesses } from "./agent-harness.ts";
import type { AgentHarness, HarnessId } from "./agent-harness.ts";

/** Every supported Agent Harness, keyed by its id. */
export const AgentHarnessesLive = Layer.effect(
  AgentHarnesses,
  Effect.gen(function* collectHarnesses() {
    const harnesses: Readonly<Record<HarnessId, AgentHarness>> = {
      claude: yield* ClaudeHarness,
      codex: yield* CodexHarness,
    };
    return harnesses;
  })
).pipe(Layer.provide(Layer.mergeAll(ClaudeHarnessLive, CodexHarnessLive)));
