import { createHash } from "node:crypto";
import path from "node:path";

import { ContentHash } from "@contingency/protocol";
import type {
  TeachingEvent,
  TeachingRecordingArtifact,
  TeachingRecordingId,
  OperationId,
  PlatformRequirements,
} from "@contingency/protocol";
import { Effect, Result } from "effect";
import type { FileSystem } from "effect";

import type { PlatformObservation } from "./platform-runtime.ts";
import type { TeachingRecordingStoreService } from "./teaching-recording-store.ts";

type EventPayload<E = TeachingEvent> = E extends TeachingEvent
  ? Omit<E, "at" | "seq">
  : never;

export interface NativeAppCaptureState {
  readonly recording: boolean;
  readonly sequence: number;
  readonly artifacts: readonly TeachingRecordingArtifact[];
  readonly bytes: number;
  readonly summary: {
    readonly recordingId: TeachingRecordingId | null;
    readonly requirements: PlatformRequirements;
  };
}

const now = () => new Date().toISOString();
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Retention is session-owned and closes before durable Stop finalization. */
export const makeNativeAppTeachingCapture = <
  CaptureSession,
  State extends NativeAppCaptureState,
  CaptureError,
>(input: {
  readonly fs: Pick<
    FileSystem.FileSystem,
    "makeDirectory" | "writeFile" | "writeFileString" | "readFile"
  >;
  readonly store: Pick<TeachingRecordingStoreService, "stop">;
  readonly state: (session: CaptureSession) => State;
  readonly update: (
    session: CaptureSession,
    change: (current: State) => State
  ) => void;
  readonly directory: (session: CaptureSession) => string;
  readonly io: <A, E>(
    effect: Effect.Effect<A, E>
  ) => Effect.Effect<A, CaptureError>;
  readonly error: (code: string, message: string) => CaptureError;
  readonly eventArtifactId: string;
  readonly stopSources?: (
    session: CaptureSession
  ) => Effect.Effect<void, CaptureError>;
  readonly messages: { readonly limit: string; readonly sizeLimit: string };
}) => {
  const { fs, store } = input;
  const emit = (session: CaptureSession, event: EventPayload) =>
    Effect.gen(function* appendEvent() {
      const current = input.state(session);
      const encoded = `${JSON.stringify({ ...event, at: now(), seq: current.sequence })}\n`;
      if (
        current.bytes + Buffer.byteLength(encoded) > 64 * 1024 * 1024 ||
        current.sequence >= 10_000
      ) {
        return yield* Effect.fail(
          input.error("capture_incomplete", input.messages.limit)
        );
      }
      yield* input.io(
        fs.writeFileString(
          path.join(input.directory(session), "events.jsonl"),
          encoded,
          { flag: "a", mode: 0o600 }
        )
      );
      input.update(session, (value) => ({
        ...value,
        bytes: value.bytes + Buffer.byteLength(encoded),
        sequence: value.sequence + 1,
      }));
    });
  const keyframe = (
    session: CaptureSession,
    observation: PlatformObservation,
    actionId: string | null
  ) =>
    Effect.gen(function* retainKeyframe() {
      const bytes = Buffer.from(observation.screenshot.image, "base64");
      const current = input.state(session);
      if (current.bytes + bytes.length > 64 * 1024 * 1024) {
        return yield* Effect.fail(
          input.error("capture_incomplete", input.messages.sizeLimit)
        );
      }
      const digest = ContentHash.make(`sha256-${hash(bytes)}`);
      const relative = `keyframes/${digest}.png`;
      yield* input.io(
        fs.makeDirectory(path.join(input.directory(session), "keyframes"), {
          recursive: true,
        })
      );
      yield* input.io(
        fs.writeFile(path.join(input.directory(session), relative), bytes, {
          mode: 0o600,
        })
      );
      input.update(session, (value) => ({
        ...value,
        artifacts: [
          ...value.artifacts,
          {
            capturedAt: now(),
            hash: digest,
            id: observation.id,
            kind: "keyframe",
            path: relative,
          },
        ],
        bytes: value.bytes + bytes.length,
      }));
      yield* emit(session, {
        _tag: "keyframe",
        actionId,
        hash: digest,
        path: relative,
      });
    });
  const finishRecording = (
    session: CaptureSession,
    operationId: OperationId,
    failure?: string
  ) =>
    Effect.gen(function* stopRetainedSources() {
      const current = input.state(session);
      if (!current.recording || current.summary.recordingId === null) {
        return;
      }
      // Close the retention interval before any durable finalization can fail.
      input.update(session, (value) => ({ ...value, recording: false }));
      const sources = yield* Effect.result(
        input.stopSources?.(session) ?? Effect.void
      );
      const sourceFailure =
        failure ??
        (Result.isFailure(sources)
          ? "Capture transport finalization lost retained evidence."
          : undefined);
      const emitted = yield* Effect.result(
        emit(session, {
          _tag: "stopped",
          detail: sourceFailure ?? null,
          reason: sourceFailure === undefined ? "user" : "capture-failed",
        })
      );
      const contents = yield* Effect.result(
        input.io(
          fs.readFile(path.join(input.directory(session), "events.jsonl"))
        )
      );
      const eventArtifacts: TeachingRecordingArtifact[] = Result.isSuccess(
        contents
      )
        ? [
            {
              capturedAt: now(),
              hash: ContentHash.make(`sha256-${hash(contents.success)}`),
              id: input.eventArtifactId,
              kind: "events",
              path: "events.jsonl",
            },
          ]
        : [];
      yield* store.stop({
        artifacts: [...input.state(session).artifacts, ...eventArtifacts],
        failure:
          sourceFailure ??
          (Result.isFailure(contents) || Result.isFailure(emitted)
            ? "Capture finalization lost retained evidence."
            : undefined),
        operationId,
        recordingId: current.summary.recordingId,
        runtime: current.summary.requirements,
      });
    });
  return { emit, finishRecording, keyframe };
};
