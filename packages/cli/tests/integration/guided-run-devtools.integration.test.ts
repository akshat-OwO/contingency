import { FlowSkillName, OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  agentProcessLayer,
  agentViewport,
  runTool,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const operation = OperationId.make;

it.live(
  "learns Guided Run state and delegation, reproduces it, and flags extra Dry Run state without capping the Assessment",
  () =>
    Effect.gen(function* requiredStateJourney() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "guided-devtools-",
      });
      const fixture = yield* fixtureServer;
      yield* Effect.gen(function* learnAndRehearse() {
        const sessions = yield* AgentSession;
        yield* Effect.addFinalizer(() => sessions.closeAll());
        const started = yield* sessionTool("agent_guided_run_start", {
          name: FlowSkillName.make("guided-state"),
          operationId: operation("start"),
          url: fixture.url("devtools.html"),
          viewport: agentViewport,
        });
        if (started.recordingId === null) {
          return yield* Effect.die("Missing recording");
        }
        const { recordingId } = started;
        const cookie = {
          action: "cookie_set",
          cookie: {
            domain: "127.0.0.1",
            httpOnly: false,
            name: "qa",
            path: "/",
            secure: false,
            value: "fixture",
          },
          operationId: "setup-cookie",
        } as const;
        yield* sessions.devtools(started.id, cookie);
        yield* sessions.devtools(started.id, {
          action: "headers_set",
          headers: { "x-discarded": "yes" },
          operationId: "discarded",
        });
        yield* sessions.devtools(started.id, {
          action: "modification_remove",
          id: "modification-discarded",
          operationId: "discard",
        });
        yield* sessionTool("agent_teaching_setup_handoff", {
          operationId: operation("handoff"),
          sessionId: started.id,
        });
        yield* sessions.startTeachingRecording(started.id, operation("record"));
        const route = {
          action: "route_add",
          operationId: "capture-mock",
          pattern: "**/required-mock",
          response: {
            action: "mock",
            body: "learned response",
            contentType: "text/plain",
            status: 200,
          },
        } as const;
        yield* sessions.devtools(started.id, route);
        yield* sessions.devtools(started.id, {
          action: "emulation_set",
          operationId: "capture-scale",
          textScale: 150,
        });
        yield* sessions.recordPursuit(
          started.id,
          {
            actions: [],
            doneWhen: "The fixture is visible",
            endedAt: new Date().toISOString(),
            ending: "done",
            goal: "Inspect fixture",
            operationId: operation("pursue"),
            reason: "The observed fixture is visible",
            step: 1,
          },
          operation("record-pursuit")
        );
        yield* sessions.stopTeachingRecording(started.id, operation("stop"));
        const claimOperationId = operation("claim");
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId,
        });
        const timeline = yield* teachingRecordingTool(
          "agent_teaching_timeline_get",
          { claimOperationId, recordingId }
        );
        expect(
          timeline.entries.filter(
            (entry) => entry._tag === "browser-modification"
          )
        ).toHaveLength(3);
        expect(timeline.entries).toContainEqual(
          expect.objectContaining({
            _tag: "pursuit",
            actor: "agent",
            delegated: true,
          })
        );
        expect(JSON.stringify(timeline)).not.toContain("x-discarded");
        const saved = yield* teachingRecordingTool("agent_flow_skill_save", {
          claimOperationId,
          files: [
            {
              content:
                "---\nname: guided-state\ndescription: Inspect the QA fixture when testing saved browser state.\ninputs:\n---\n\n1. Apply the recorded state and inspect the fixture. Done when: the required mock responds with learned response.\n",
              path: "SKILL.md",
            },
          ],
          operationId: operation("save"),
          recordingId,
        });
        expect(saved.files).toContain("references/browser-state.json");
        const skill = yield* fs.readFileString(`${root}/guided-state/SKILL.md`);
        expect(skill).toContain("Delegated: Inspect fixture");
        expect(skill).toContain("references/browser-state.json");
        // Emulation at Start remains the baseline; the capture change is a command.
        expect(skill).not.toContain("textScale: 150");
        const required = yield* fs.readFileString(
          `${root}/guided-state/references/browser-state.json`
        );
        expect(required).toContain("capture-mock");
        const dry = yield* teachingRecordingTool(
          "agent_flow_skill_dry_run_start",
          {
            inputs: [],
            operationId: operation("dry"),
            recordingId,
            url: fixture.url("devtools.html"),
          }
        );
        const snapshot = yield* sessionTool("agent_browser_snapshot", {
          sessionId: dry.session.id,
        });
        const assessment = {
          evidence: [{ id: snapshot.snapshotId, kind: "snapshot" as const }],
          explanation: "The required response was observed",
          outcome: "working" as const,
          outcomeComplete: true,
          sessionId: dry.session.id,
        };
        expect(
          yield* Effect.flip(
            runTool("agent_run_assess", {
              ...assessment,
              operationId: operation("missing-state"),
            })
          )
        ).toMatchObject({
          message: expect.stringContaining("every saved Browser Modification"),
        });
        yield* sessions.devtools(dry.session.id, {
          ...cookie,
          operationId: "dry-cookie",
        });
        yield* sessions.devtools(dry.session.id, {
          ...route,
          operationId: "dry-route",
        });
        yield* sessions.devtools(dry.session.id, {
          action: "emulation_set",
          operationId: "dry-scale",
          textScale: 150,
        });
        const browser = yield* CreateBrowser;
        const ids = yield* browser.list();
        const browserId = ids.at(-1);
        if (browserId === undefined) {
          return yield* Effect.die("Missing Dry Run browser");
        }
        const { page, context } = yield* browser.activeTarget(browserId);
        expect(
          yield* Effect.tryPromise(() =>
            page.evaluate(async () => {
              const response = await fetch("/required-mock");
              return response.text();
            })
          )
        ).toBe("learned response");
        expect(
          yield* Effect.tryPromise(() => context.cookies())
        ).toContainEqual(
          expect.objectContaining({ name: "qa", value: "fixture" })
        );
        yield* sessions.devtools(dry.session.id, {
          action: "headers_set",
          headers: { "x-agent": "extra" },
          operationId: "extra",
        });
        const assessed = yield* runTool("agent_run_assess", {
          ...assessment,
          operationId: operation("assess"),
        });
        expect(assessed.run).toMatchObject({
          assessment: { outcome: "working" },
        });
        const summary = yield* runTool("agent_run_complete", {
          operationId: operation("complete"),
          sessionId: dry.session.id,
        });
        expect(summary).toMatchObject({
          assessment: { outcome: "working" },
          browserModifications: [
            expect.objectContaining({ kind: "cookie", source: "saved" }),
            expect.objectContaining({ kind: "route", source: "saved" }),
            expect.objectContaining({ kind: "emulation", source: "saved" }),
            expect.objectContaining({
              kind: "headers",
              source: "agent-initiated",
            }),
          ],
        });
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
