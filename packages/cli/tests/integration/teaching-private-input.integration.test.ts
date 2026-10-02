import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  sessionTool,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Where the user's pointer lands on the fixture's fixed Remove button. */
const REMOVE_BACKUP = { x: 480, y: 35 } as const;
const OTP = "482915";
const OTP_VARIABLE = { name: "OTP", runtime: true, secret: true } as const;

const clickAsUser = (
  sessionId: AgentSessionId,
  at: { readonly x: number; readonly y: number }
) =>
  Effect.gen(function* clickAsTheUser() {
    const service = yield* AgentSession;
    for (const eventType of ["mousePressed", "mouseReleased"] as const) {
      yield* service.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        x: at.x,
        y: at.y,
      });
    }
  });

it.live(
  "accepts a private Variable the page spread across one-character boxes",
  () =>
    Effect.gen(function* enterSpreadCode() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-private-input-",
      });
      const fixtures = yield* fixtureServer;

      yield* Effect.scoped(
        Effect.gen(function* demonstrateCodeEntry() {
          const started = yield* startUserTeaching({
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "spread-otp",
            operationId: OperationId.make("spread-start-session"),
            url: fixtures.url("spread-otp.html"),
            viewport: agentViewport,
          });
          const session = yield* AgentSession;
          yield* session.startTeachingRecording(
            started.id,
            OperationId.make("spread-start-recording")
          );
          const observed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          const firstBox = findNode(
            observed.nodes,
            "textbox",
            "otp-input 1 of 6"
          );
          const rejected = findNode(observed.nodes, "textbox", "Rejected code");
          const backup = findNode(observed.nodes, "textbox", "Backup code");

          // The boxes differ in markup, so the value is typed into the first
          // one alone and the page moves the rest into the boxes after it.
          const entered = yield* session.enterUserVariable(
            started.id,
            { ref: firstBox.ref, value: OTP, variable: OTP_VARIABLE },
            OperationId.make("spread-enter-otp")
          );
          expect(entered.entry.outcome).toBe("completed");
          expect(
            entered.snapshot.nodes.filter(
              (node) =>
                node.role === "textbox" && node.name.startsWith("otp-input")
            )
          ).toHaveLength(6);
          findNode(entered.snapshot.nodes, "button", "Continue");
          expect(JSON.stringify(entered)).not.toContain(OTP);

          const refused = yield* Effect.flip(
            session.enterUserVariable(
              started.id,
              {
                ref: rejected.ref,
                value: "731904",
                variable: { name: "REJECTED", runtime: true, secret: true },
              },
              OperationId.make("spread-enter-rejected")
            )
          );
          expect(refused.message).toBe(
            "Could not enter the private Variable (value_mismatch)."
          );

          yield* clickAsUser(started.id, REMOVE_BACKUP);
          const detached = yield* Effect.flip(
            session.enterUserVariable(
              started.id,
              {
                ref: backup.ref,
                value: "550127",
                variable: { name: "BACKUP", runtime: true, secret: true },
              },
              OperationId.make("spread-enter-backup")
            )
          );
          expect(detached.message).toBe(
            "Could not enter the private Variable (detached)."
          );
          expect(JSON.stringify([refused, detached])).not.toMatch(
            /731904|550127/u
          );

          const timeline = yield* sessionTool("agent_session_get", {
            sessionId: started.id,
          });
          const serialized = JSON.stringify(timeline);
          expect(serialized).not.toContain(OTP);
          expect(serialized).not.toMatch(/731904|550127/u);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

for (const variant of [
  "baseline",
  "missing-length",
  "delayed",
  "partial",
  "wrong",
  "non-settling",
  "hidden",
  "disabled",
  "separate",
  "unrelated",
] as const) {
  it.live(`verifies private segmented entry in a ${variant} Dry Run`, () =>
    Effect.gen(function* verifyDryRunEntry() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "private-spread-dry-",
      });
      const fixtures = yield* fixtureServer;
      yield* Effect.scoped(
        Effect.gen(function* driveEntry() {
          const session = yield* AgentSession;
          const started = yield* startUserTeaching({
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "spread-code",
            operationId: OperationId.make("seed-start"),
            url: fixtures.url("spread-otp.html"),
            viewport: agentViewport,
          });
          yield* session.startTeachingRecording(started.id, "seed-record");
          const seed = yield* sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          yield* session.enterUserVariable(
            started.id,
            {
              ref: findNode(seed.nodes, "textbox", "otp-input 1 of 6").ref,
              value: OTP,
              variable: OTP_VARIABLE,
            },
            "seed-fill"
          );
          yield* session.stopTeachingRecording(started.id, "seed-stop");
          const { recordingId } = started;
          if (recordingId === null) {
            return yield* Effect.die("Expected a Teaching Recording.");
          }
          const claimOperationId = OperationId.make("seed-claim");
          yield* teachingRecordingTool("agent_teaching_recording_claim", {
            action: "take",
            operationId: claimOperationId,
            recordingId,
          });
          const captured = yield* teachingRecordingTool(
            "agent_teaching_timeline_get",
            { claimOperationId, recordingId }
          );
          expect(JSON.stringify(captured)).toContain("{{OTP}}");
          expect(JSON.stringify(captured)).not.toContain(OTP);
          yield* teachingRecordingTool("agent_flow_skill_save", {
            claimOperationId,
            files: [
              {
                content:
                  "---\nname: spread-code\ndescription: Enter the verification code.\ninputs:\n  - otp\n---\n\n1. Enter {{otp}} in the first code box.\n   Done when: Continue appears.\n",
                path: "SKILL.md",
              },
            ],
            operationId: OperationId.make("seed-save"),
            recordingId,
          });
          const dry = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            {
              inputs: [{ changed: true, name: "otp", secret: true }],
              operationId: OperationId.make("dry-start"),
              recordingId,
              url: `${fixtures.url("spread-otp.html")}?variant=${variant}`,
            }
          );
          const sessionId = dry.session.id;
          yield* session.supplyDryRunVariable(sessionId, "OTP", OTP);
          const before = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const { ref } = findNode(
            before.nodes,
            "textbox",
            variant === "unrelated" ? "OTP" : "otp-input 1 of 6"
          );
          const enter = () =>
            session.enterSuppliedVariable(
              sessionId,
              "OTP",
              ref,
              OperationId.make("dry-enter")
            );
          const succeeds = ["baseline", "missing-length", "delayed"].includes(
            variant
          );
          const dispatchedAt = Date.now();
          const first = yield* Effect.result(enter());
          expect(Date.now() - dispatchedAt).toBeLessThan(13_000);
          expect(Result.isSuccess(first)).toBe(succeeds);
          if (Result.isSuccess(first)) {
            expect(first.success.entry.outcome).toBe("completed");
            expect(first.success.entry.effect).toBeDefined();
          } else {
            expect(first.failure.message).toContain("value_mismatch");
          }
          const replay = yield* Effect.result(enter());
          expect(replay).toEqual(first);
          const after = yield* sessionTool("agent_browser_snapshot", {
            sessionId,
          });
          const history = yield* sessionTool("agent_session_get", {
            sessionId,
          });
          expect(history.timeline.at(-1)?.outcome).toBe(
            succeeds ? "completed" : "failed"
          );
          expect(history.timeline).toHaveLength(1);
          if (Result.isSuccess(first)) {
            expect(history.timeline.at(-1)?.id).toBe(first.success.entry.id);
            expect(
              after.nodes.filter(
                (node) =>
                  node.name.startsWith("otp-input") && node.valueWithheld
              )
            ).toHaveLength(6);
          }
          for (const node of after.nodes.filter(
            (control) =>
              control.role === "textbox" &&
              control.value !== undefined &&
              control.value !== ""
          )) {
            expect(node.valueWithheld).toBe(true);
          }
          expect(JSON.stringify([first, replay, after, history])).not.toContain(
            OTP
          );
          if (succeeds) {
            const submitted = yield* sessionTool("agent_browser_act", {
              action: {
                ref: findNode(after.nodes, "button", "Continue").ref,
                type: "click",
              },
              operationId: OperationId.make("dry-submit"),
              sessionId,
            });
            findNode(submitted.snapshot.nodes, "output", "Signed in");
          }
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
}
