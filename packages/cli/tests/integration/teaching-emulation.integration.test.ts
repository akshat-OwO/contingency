import { OperationId, UserAgentProfileId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { TeachingRecordingStore } from "../../src/services/teaching-recording-store.ts";
import {
  agentProcessLayer,
  agentViewport,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const phoneIdentity = UserAgentProfileId.make("chrome-android-mobile");

it.live(
  "finishes an in-flight Emulation change before starting a Teaching Recording",
  () =>
    Effect.gen(function* configureWhileStarting() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-emulation-race-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* recordDuringSetupChange() {
          const service = yield* AgentSession;
          const store = yield* TeachingRecordingStore;
          const opened = yield* service.start({
            activity: "teaching",
            clientName: "contingency-web",
            clientVersion: "1.0.0",
            name: "concurrent-emulation",
            operationId: OperationId.make("concurrent-emulation-open"),
            url: fixtures.url("shop.html"),
            viewport: agentViewport,
          });
          // Identity changes reopen the page. Start can arrive while that
          // setup request is still applying the new browser environment.
          const [configured, started] = yield* Effect.all(
            [
              service.setEmulation(opened.id, {
                colorScheme: "dark",
                locale: "de-DE",
                timezoneId: "Europe/Berlin",
                userAgentProfile: phoneIdentity,
              }),
              service.startTeachingRecording(
                opened.id,
                OperationId.make("concurrent-emulation-start")
              ),
            ],
            { concurrency: "unbounded" }
          );
          if (started.activity !== "teaching") {
            return yield* Effect.die("Expected a Teaching Recording.");
          }
          expect(yield* service.emulation(opened.id)).toEqual(configured);
          yield* service.stopTeachingRecording(
            opened.id,
            OperationId.make("concurrent-emulation-stop")
          );
          const manifest = yield* store.read(started.recordingId);
          expect(manifest.emulation).toMatchObject({
            colorScheme: "dark",
            locale: "de-DE",
            timezoneId: "Europe/Berlin",
            userAgentProfile: phoneIdentity,
            viewport: configured.emulation.viewport,
          });
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "declares the Emulation a Workspace-only recording was demonstrated under",
  () =>
    Effect.gen(function* recordWithoutAnAgent() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-teaching-emulation-",
      });
      const fixtures = yield* fixtureServer;

      // The user opens Teaching from the Workspace, with no agent to hand the
      // browser over, and configures the device during setup.
      const { demonstrated, recordingId } = yield* Effect.scoped(
        Effect.gen(function* demonstrateUnderEmulation() {
          const service = yield* AgentSession;
          const opened = yield* service.start({
            activity: "teaching",
            clientName: "contingency-web",
            clientVersion: "1.0.0",
            name: "dark-checkout",
            operationId: OperationId.make("emulation-open"),
            url: fixtures.url("shop.html"),
            viewport: agentViewport,
          });
          if (opened.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          expect(opened.controller).toBe("user");
          yield* service.setEmulation(opened.id, {
            colorScheme: "dark",
            locale: "de-DE",
            timezoneId: "Europe/Berlin",
            userAgentProfile: phoneIdentity,
          });
          const configured = yield* service.emulation(opened.id);

          yield* service.startTeachingRecording(
            opened.id,
            OperationId.make("emulation-start-recording")
          );
          // The recording declares one Emulation, so the controls lock once
          // capture begins rather than changing the device mid-journey.
          const refused = yield* Effect.flip(
            service.setEmulation(opened.id, { colorScheme: "light" })
          );
          expect(refused.code).toBe("agent_session_conflict");
          expect(yield* service.emulation(opened.id)).toEqual(configured);

          yield* service.stopTeachingRecording(
            opened.id,
            OperationId.make("emulation-stop-recording")
          );
          return {
            demonstrated: configured,
            recordingId: opened.recordingId,
          };
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      // An agent in a later process finds the recording and learns its
      // Emulation before claiming it.
      yield* Effect.scoped(
        Effect.gen(function* findTheRecordingLater() {
          const listed = yield* teachingRecordingTool(
            "agent_teaching_recordings_list",
            {}
          );
          const summary = listed.recordings.find(
            (recording) => recording.recordingId === recordingId
          );
          expect(summary?.emulation).toMatchObject({
            colorScheme: "dark",
            locale: "de-DE",
            timezoneId: "Europe/Berlin",
            userAgentProfile: phoneIdentity,
            viewport: demonstrated.emulation.viewport,
          });
          const claimed = yield* teachingRecordingTool(
            "agent_teaching_recording_claim",
            {
              action: "take",
              operationId: OperationId.make("emulation-claim"),
              recordingId,
            }
          );
          expect(claimed.recording.emulation).toEqual(summary?.emulation);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
