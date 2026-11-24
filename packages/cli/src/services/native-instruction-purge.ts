import path from "node:path";

import { Effect } from "effect";
import type { FileSystem } from "effect";

interface CommentedSummary {
  readonly instructions?: readonly unknown[] | undefined;
  readonly recordingId: string | null;
}

/**
 * A native session's summary lists its recording's comments, with their text
 * and element, outside the recording's folder. Cleanup deletes the recording's
 * Teaching events (ADR 0039), so a purged recording keeps no copy here either.
 */
export const withoutPurgedInstructions = <
  Summary extends { readonly instructions?: readonly unknown[] | undefined },
>(
  summary: Summary,
  cleanup: { readonly _tag: string } | null
): Summary =>
  cleanup?._tag === "purged" && (summary.instructions?.length ?? 0) > 0
    ? { ...summary, instructions: [] }
    : summary;

/**
 * Removes the comments of purged recordings from the persisted summaries in
 * one folder, whichever process wrote them. It runs after a purge and when
 * the workspace starts, so a purge another process made, or a Cleanup retry
 * that finished later, leaves no comment behind. A summary that does not
 * decode is left as it is.
 */
export const scrubPurgedInstructions = <
  Summary extends CommentedSummary,
>(input: {
  /** Reads one persisted summary, as the workspace does. */
  readonly decode: (contents: string) => Effect.Effect<Summary, unknown>;
  readonly directory: string;
  readonly fs: FileSystem.FileSystem;
  /** Whether Cleanup purged this recording. */
  readonly purged: (recordingId: string) => Effect.Effect<boolean>;
  /** Only this recording's summaries, when known. */
  readonly recordingId?: string | undefined;
}): Effect.Effect<void> =>
  Effect.gen(function* scrubSummaries() {
    const { directory, fs } = input;
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): readonly string[] => []));
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".keyframes.json")) {
        continue;
      }
      const file = path.join(directory, name);
      const summary = yield* fs.readFileString(file).pipe(
        Effect.flatMap(input.decode),
        Effect.orElseSucceed(() => null)
      );
      if (
        summary === null ||
        summary.recordingId === null ||
        (input.recordingId !== undefined &&
          summary.recordingId !== input.recordingId) ||
        (summary.instructions?.length ?? 0) === 0 ||
        !(yield* input.purged(summary.recordingId))
      ) {
        continue;
      }
      const temporary = `${file}.tmp`;
      yield* fs
        .writeFileString(
          temporary,
          JSON.stringify({ ...summary, instructions: [] }, null, 2),
          { mode: 0o600 }
        )
        .pipe(
          Effect.andThen(fs.rename(temporary, file)),
          Effect.ignore({
            log: "Debug",
            message: "Could not purge native instructions",
          })
        );
    }
  });
