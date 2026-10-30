import { OperationId, TeachingRecordingId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeNativeAppTeachingCapture } from "../../src/services/native-app-teaching-capture.ts";
import type { NativeAppCaptureState } from "../../src/services/native-app-teaching-capture.ts";
import type { TeachingRecordingStop } from "../../src/services/teaching-recording-store.ts";

const fixture = (failSource = false) => {
  let state: NativeAppCaptureState = {
    artifacts: [],
    bytes: 0,
    recording: true,
    sequence: 0,
    summary: {
      recordingId: TeachingRecordingId.make("recording-native"),
      requirements: {
        capabilities: [],
        environment: { engine: "chromium" },
        platform: "web",
      },
    },
  };
  const files = new Map<string, Uint8Array>();
  const stopped: TeachingRecordingStop[] = [];
  let retainedAtStop = true;
  const capture = makeNativeAppTeachingCapture({
    directory: () => "/capture",
    error: (code) => ({ code }),
    eventArtifactId: "native-events",
    fs: {
      makeDirectory: () => Effect.void,
      readFile: (file) => Effect.succeed(files.get(file) ?? new Uint8Array()),
      writeFile: (file, bytes) =>
        Effect.sync(() => {
          files.set(file, bytes);
        }),
      writeFileString: (file, text) =>
        Effect.sync(() => {
          const existing = files.get(file) ?? new Uint8Array();
          files.set(file, Buffer.concat([existing, Buffer.from(text)]));
        }),
    },
    io: <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError(() => ({ code: "io_failed" }))),
    messages: { limit: "Capture limit", sizeLimit: "Size limit" },
    state: (_session: string) => state,
    stopSources: () =>
      Effect.gen(function* stopOwnedCaptureSources() {
        if (state.recording) {
          return yield* Effect.die("Retention was still open");
        }
        if (failSource) {
          return yield* Effect.fail({ code: "manifest_failed" });
        }
      }),
    store: {
      stop: (request) =>
        Effect.sync(() => {
          retainedAtStop = state.recording;
          stopped.push(request);
        }).pipe(Effect.andThen(Effect.die("Finalization failed"))),
    },
    update: (_session, change) => {
      state = change(state);
    },
  });
  return {
    capture,
    files,
    retainedAtStop: () => retainedAtStop,
    setSequence: (sequence: number) => {
      state = { ...state, sequence };
    },
    state: () => state,
    stopped,
  };
};

it.effect(
  "Teaching retains bounded sequenced events and hashed keyframes",
  () =>
    Effect.gen(function* retainEvidence() {
      const { capture, files, state } = fixture();
      yield* capture.emit("session", {
        _tag: "stopped",
        detail: null,
        reason: "user",
      });
      yield* capture.keyframe(
        "session",
        {
          id: "observed",
          nodes: [],
          platform: "android",
          screenshot: {
            capturedAt: "2026-10-27",
            encoding: "base64",
            format: "png",
            image: Buffer.from("pixels").toString("base64"),
          },
        },
        null
      );
      const events: unknown[] = Buffer.from(
        files.get("/capture/events.jsonl") ?? []
      )
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toMatchObject([
        { _tag: "stopped", seq: 0 },
        { _tag: "keyframe", actionId: null, seq: 1 },
      ]);
      expect(state().artifacts).toMatchObject([
        {
          hash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/u),
          id: "observed",
          kind: "keyframe",
        },
      ]);
      expect(state().bytes).toBeGreaterThan(6);
    })
);

it.effect("Teaching refuses retention beyond the event bound", () =>
  Effect.gen(function* boundEvents() {
    const { capture, files, setSequence } = fixture();
    setSequence(10_000);
    expect(
      (yield* Effect.flip(
        capture.emit("session", {
          _tag: "stopped",
          detail: null,
          reason: "user",
        })
      )).code
    ).toBe("capture_incomplete");
    expect(files.size).toBe(0);
  })
);

it.effect(
  "Stop closes retention before failed finalization and cannot finalize twice",
  () =>
    Effect.gen(function* closeBeforeFinalization() {
      const { capture, stopped, state, retainedAtStop } = fixture();
      yield* Effect.exit(
        capture.finishRecording("session", OperationId.make("stop"))
      );
      expect(state().recording).toBe(false);
      expect(retainedAtStop()).toBe(false);
      expect(stopped).toMatchObject([
        { artifacts: [{ id: "native-events", kind: "events" }] },
      ]);
      yield* capture.finishRecording("session", OperationId.make("retry"));
      expect(stopped).toHaveLength(1);
    })
);

it.effect(
  "a failed transport manifest still closes retention and cannot pass finalization",
  () =>
    Effect.gen(function* failManifest() {
      const { capture, state, stopped } = fixture(true);
      yield* Effect.exit(
        capture.finishRecording("session", OperationId.make("stop"))
      );
      expect(state().recording).toBe(false);
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.failure).toBe(
        "Capture transport finalization lost retained evidence."
      );
      yield* capture.finishRecording("session", OperationId.make("retry"));
      expect(stopped).toHaveLength(1);
    })
);
