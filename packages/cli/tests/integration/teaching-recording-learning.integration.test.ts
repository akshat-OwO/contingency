import path from "node:path";

import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

it.live(
  "learns a bounded Flow Skill from a recording created in another process lifetime",
  () =>
    Effect.gen(function* learnPersistedTeachingRecording() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-recording-learning-",
      });
      const fixtures = yield* fixtureServer;
      const privateQueryValue = "known-private-query-token";
      const privateFieldValue = "known-private-field-token";
      const url = `${fixtures.url("agent-login.html")}?token=${privateQueryValue}`;

      const recordingId = yield* Effect.scoped(
        Effect.gen(function* recordInFirstProcess() {
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "learn-anvil",
            operationId: OperationId.make("learning-start-session"),
            url,
            viewport: agentViewport,
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          const session = yield* AgentSession;
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          const password = findNode(observed.nodes, "textbox", "Password");
          yield* session.startTeachingRecording(
            started.id,
            OperationId.make("learning-start-recording")
          );
          yield* session.enterUserVariable(
            started.id,
            {
              ref: password.ref,
              value: privateFieldValue,
              variable: { name: "PASSWORD", runtime: true, secret: true },
            },
            OperationId.make("learning-enter-private-value")
          );
          yield* sessionTool("agent_browser_screenshot", {
            sessionId: started.id,
          });
          yield* session.stopTeachingRecording(
            started.id,
            OperationId.make("learning-stop-recording")
          );
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      yield* Effect.scoped(
        Effect.gen(function* learnInLaterProcess() {
          const listed = yield* teachingRecordingTool(
            "agent_teaching_recordings_list",
            {}
          );
          expect(
            listed.recordings.map((recording) => recording.recordingId)
          ).toContain(recordingId);
          const waited = yield* teachingRecordingTool(
            "agent_teaching_recording_wait",
            { recordingId, timeoutMs: 1000 }
          );
          expect(waited.lifecycle).toBe("ready");

          const claimOperationId = OperationId.make("learning-claim");
          const claimed = yield* teachingRecordingTool(
            "agent_teaching_recording_claim",
            { operationId: claimOperationId, recordingId }
          );
          expect(claimed.flowSkillName).toBe("learn-anvil");

          const timeline = yield* teachingRecordingTool(
            "agent_teaching_timeline_get",
            { claimOperationId, recordingId }
          );
          expect(timeline.nextCursor).toBeNull();
          const serialized = JSON.stringify(timeline);
          expect(serialized).not.toContain(privateQueryValue);
          expect(serialized).not.toContain(privateFieldValue);
          expect(serialized).not.toContain(root);
          expect(serialized).not.toContain("trace.zip");
          expect(serialized).not.toContain("recording.webm");
          expect(serialized).not.toContain('"path"');
          const keyframe = timeline.entries.find(
            (entry) => entry._tag === "keyframe"
          );
          if (keyframe?._tag !== "keyframe") {
            return yield* Effect.die("The timeline referenced no keyframe.");
          }
          const image = yield* teachingRecordingTool(
            "agent_teaching_keyframe_get",
            {
              claimOperationId,
              keyframeId: keyframe.id,
              recordingId,
            }
          );
          expect(image.image.length).toBeGreaterThan(0);

          const skillDirectory = path.join(root, "learn-anvil");
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(skillDirectory, "SKILL.md"),
            "# Previous package\n"
          );
          const refusedSave = yield* Effect.flip(
            teachingRecordingTool("agent_flow_skill_save", {
              claimOperationId,
              files: [{ content: "escape", path: "../outside.md" }],
              operationId: OperationId.make("learning-save-invalid"),
              recordingId,
            })
          );
          expect(refusedSave.code).toBe("teaching_recording_invalid");
          expect(
            yield* fileSystem.readFileString(
              path.join(skillDirectory, "SKILL.md")
            )
          ).toBe("# Previous package\n");

          const saveInput = {
            claimOperationId,
            files: [
              {
                content:
                  "# Learn anvil\n\nOpen the shop and confirm the Anvil Works page is visible.\n",
                path: "SKILL.md",
              },
              {
                content: "Use the button named Add to cart.\n",
                path: "references/accessibility.md",
              },
            ],
            operationId: OperationId.make("learning-save-skill"),
            recordingId,
          } as const;
          const saved = yield* teachingRecordingTool(
            "agent_flow_skill_save",
            saveInput
          );
          expect(saved.files).toEqual([
            "SKILL.md",
            "references/accessibility.md",
          ]);
          expect(
            yield* fileSystem.readFileString(
              path.join(root, "learn-anvil", "SKILL.md")
            )
          ).toContain("# Learn anvil");
          expect(
            yield* teachingRecordingTool("agent_flow_skill_save", saveInput)
          ).toEqual(saved);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
