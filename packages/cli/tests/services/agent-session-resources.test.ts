import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  AGENT_OWNER_MARKER_PREFIX,
  agentOwnerMarker,
  prepareAgentResourceDirectory,
  scavengeStaleAgentResources,
} from "../../src/services/agent-session-resources.ts";

it.live(
  "scavenges only exact dead owner markers and preserves durable-looking siblings",
  () =>
    Effect.gen(function* staleOwnerScavenging() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const stale = path.join(root, agentOwnerMarker(40_101));
      const live = path.join(root, agentOwnerMarker(40_102));
      const nearMatch = path.join(
        root,
        `${AGENT_OWNER_MARKER_PREFIX}40101-extra`
      );
      const durable = path.join(root, "runs");
      yield* fileSystem.makeDirectory(stale, { recursive: true });
      yield* fileSystem.makeDirectory(live, { recursive: true });
      yield* fileSystem.makeDirectory(nearMatch, { recursive: true });
      yield* fileSystem.makeDirectory(durable, { recursive: true });

      yield* scavengeStaleAgentResources(root, (pid) => pid === 40_102);

      expect(yield* fileSystem.exists(stale)).toBe(false);
      expect(yield* fileSystem.exists(live)).toBe(true);
      expect(yield* fileSystem.exists(nearMatch)).toBe(true);
      expect(yield* fileSystem.exists(durable)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("creates this process marker after stale cleanup", () =>
  Effect.gen(function* createsOwnerMarker() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const stale = path.join(root, agentOwnerMarker(40_103));
    yield* fileSystem.makeDirectory(stale, { recursive: true });

    const marker = yield* prepareAgentResourceDirectory(
      root,
      40_104,
      () => false
    );

    expect(marker).toBe(path.join(root, agentOwnerMarker(40_104)));
    expect(yield* fileSystem.exists(stale)).toBe(false);
    expect(yield* fileSystem.exists(marker)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
