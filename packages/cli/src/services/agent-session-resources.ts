import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, FileSystem, Option, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

/** Exact prefix for temporary ownership directories created by MCP. */
export const AGENT_OWNER_MARKER_PREFIX = "contingency-agent-session-owner-";
const ownerMarkerPattern =
  /^contingency-agent-session-owner-(?<pid>[1-9]\d*)$/u;

export const defaultAgentResourceDirectory = (): string =>
  path.join(tmpdir(), "contingency-agent-sessions");

export const agentOwnerMarker = (pid: number): string => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("An Agent Session owner pid must be a positive integer.");
  }
  return `${AGENT_OWNER_MARKER_PREFIX}${pid}`;
};

export type ProcessIsAlive = (pid: number) => boolean;

const ProcessError = Schema.Struct({ code: Schema.String });

const hostProcessIsAlive: ProcessIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process is not allowed to signal
    // it. Treating it as alive avoids deleting another user's live resources.
    return Schema.decodeUnknownOption(ProcessError)(error).pipe(
      Option.exists(({ code }) => code === "EPERM")
    );
  }
};

const staleOwnerPid = (name: string): number | undefined => {
  const match = ownerMarkerPattern.exec(name);
  if (match === null) {
    return undefined;
  }
  const pid = Number(match.groups?.pid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Remove only direct child directories with the exact owner marker format and
 * whose owner process is dead. Durable Run/catalog paths cannot match this
 * prefix and are never traversed.
 */
export const scavengeStaleAgentResources = (
  directory: string,
  isAlive: ProcessIsAlive = hostProcessIsAlive
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* scavenge() {
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem.readDirectory(directory);
    yield* Effect.forEach(
      entries,
      (entry) => {
        const pid = staleOwnerPid(entry);
        if (pid === undefined || isAlive(pid)) {
          return Effect.void;
        }
        const target = path.join(directory, entry);
        return fileSystem
          .stat(target)
          .pipe(
            Effect.flatMap((info) =>
              info.type === "Directory"
                ? fileSystem.remove(target, { recursive: true })
                : Effect.void
            )
          );
      },
      { discard: true }
    );
  });

/** Create this process's exact ownership marker after scavenging old ones. */
export const prepareAgentResourceDirectory = (
  directory: string,
  pid = process.pid,
  isAlive: ProcessIsAlive = hostProcessIsAlive
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* prepare() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* scavengeStaleAgentResources(directory, isAlive);
    const marker = path.join(directory, agentOwnerMarker(pid));
    yield* fileSystem.makeDirectory(marker, { recursive: true });
    return marker;
  });
