import path from "node:path";

import { FlowSkillName, OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { readFlowSkillFrontmatter } from "../../src/services/flow-skill-package.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  runTool,
  sessionTool,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** The demonstrated pair. A learned Flow Skill must reach a different one. */
const DEMONSTRATED_CITY = "Gurugram";
const DEMONSTRATED_AREA = "Sector 14";

/** Where the user's pointer lands on each fixed control of the fixture. */
const CHOOSE_DELIVERY = { x: 120, y: 116 } as const;
const SELECT_MANUALLY = { x: 120, y: 176 } as const;
const CITY_FIELD = { x: 120, y: 116 } as const;
const AREA_FIELD = { x: 120, y: 196 } as const;
const CONFIRM_AREA = { x: 120, y: 256 } as const;

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

const typeAsUser = (sessionId: AgentSessionId, text: string) =>
  Effect.gen(function* typeAsTheUser() {
    const service = yield* AgentSession;
    for (const character of text) {
      yield* service.sendInput(sessionId, {
        eventType: "keyDown",
        key: character,
        text: character,
        type: "input_keyboard",
      });
      yield* service.sendInput(sessionId, {
        eventType: "keyUp",
        key: character,
        type: "input_keyboard",
      });
    }
  });

const driveDeliveryAsAgent = (
  sessionId: AgentSessionId,
  city: string,
  area: string,
  operationPrefix: string
) =>
  Effect.gen(function* driveDeliveryFlowSkill() {
    const first = yield* sessionTool("agent_browser_snapshot", { sessionId });
    const choose = findNode(first.nodes, "button", "Choose delivery area");
    const choosing = yield* sessionTool("agent_browser_act", {
      action: { ref: choose.ref, type: "click" },
      operationId: OperationId.make(`${operationPrefix}-choose`),
      sessionId,
    });
    const manually = findNode(
      choosing.snapshot.nodes,
      "button",
      "Select manually"
    );
    const picking = yield* sessionTool("agent_browser_act", {
      action: { ref: manually.ref, type: "click" },
      operationId: OperationId.make(`${operationPrefix}-manual`),
      sessionId,
    });
    const cityField = findNode(picking.snapshot.nodes, "textbox", "City");
    const cityFilled = yield* sessionTool("agent_browser_act", {
      action: { ref: cityField.ref, text: city, type: "fill" },
      operationId: OperationId.make(`${operationPrefix}-city`),
      sessionId,
    });
    const areaField = findNode(
      cityFilled.snapshot.nodes,
      "textbox",
      "Search for your delivery area"
    );
    const areaFilled = yield* sessionTool("agent_browser_act", {
      action: { ref: areaField.ref, text: area, type: "fill" },
      operationId: OperationId.make(`${operationPrefix}-area`),
      sessionId,
    });
    const confirm = findNode(
      areaFilled.snapshot.nodes,
      "button",
      "Confirm delivery area"
    );
    const confirmed = yield* sessionTool("agent_browser_act", {
      action: { ref: confirm.ref, type: "click" },
      operationId: OperationId.make(`${operationPrefix}-confirm`),
      sessionId,
    });
    expect(
      confirmed.snapshot.nodes.some((node) =>
        node.name.includes(`Delivering to ${area}, ${city}`)
      )
    ).toBe(true);
  });

/**
 * The package the learning agent writes from this recording. It names the city
 * and the delivery area as inputs rather than repeating the demonstrated pair,
 * so a later Dry Run can change either one without the recording.
 */
const DELIVERY_SKILL = `---
name: set-delivery-area
description: Set the shop's delivery city and area and confirm the status names both. Use when an order must reach a named delivery area.
inputs:
  - city
  - delivery_area
---

# Set the delivery area

Read [the accessibility targets](references/accessibility.md) when a control is hard to find.

1. Choose the button named "Choose delivery area". Done when: a heading named "Delivery area" is on the page.
2. Choose the button named "Select manually". Done when: a textbox named "Search for your delivery area" is on the page.
3. Fill the textbox named "City" with {{city}}. Done when: the textbox holds {{city}}.
4. Fill the textbox named "Search for your delivery area" with {{delivery_area}}. Done when: the textbox holds {{delivery_area}}.
5. Choose the button named "Confirm delivery area". Done when: the status reads "Delivering to {{delivery_area}}, {{city}}".
`;

const DELIVERY_ACCESSIBILITY = `# Accessibility targets

- role=button name="Choose delivery area" context="Delivery"
- role=button name="Select manually" context="Delivery area"
- role=textbox name="City" context="Delivery area"
- role=textbox name="Search for your delivery area" context="Delivery area"
- role=button name="Confirm delivery area" context="Delivery area"

## Why these targets are stable

The delivery section re-renders in place and every control keeps its visible
label, so the enclosing heading separates one stage of the picker from the
next without relying on position.
`;

it.live(
  "learns a parameterized delivery-location Flow Skill from a user-led recording",
  () =>
    Effect.gen(function* learnDeliveryLocationFlowSkill() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-delivery-learning-",
      });
      const fixtures = yield* fixtureServer;

      const demonstration = yield* Effect.scoped(
        Effect.gen(function* demonstrateDeliveryJourney() {
          const started = yield* sessionTool("agent_session_start", {
            activity: "teaching",
            clientName: "integration-recorder",
            clientVersion: "1.0.0",
            name: "set-delivery-area",
            operationId: OperationId.make("delivery-start-session"),
            url: fixtures.url("delivery.html"),
            viewport: agentViewport,
          });
          if (started.recordingId === null) {
            return yield* Effect.die("Teaching did not allocate a recording.");
          }
          const service = yield* AgentSession;
          yield* service.startTeachingRecording(
            started.id,
            OperationId.make("delivery-start-recording")
          );
          const settle = sessionTool("agent_browser_snapshot", {
            sessionId: started.id,
          });
          yield* clickAsUser(started.id, CHOOSE_DELIVERY);
          const choosing = yield* settle;
          findNode(choosing.nodes, "button", "Select manually");
          yield* clickAsUser(started.id, SELECT_MANUALLY);
          const picking = yield* settle;
          findNode(picking.nodes, "textbox", "Search for your delivery area");
          yield* clickAsUser(started.id, CITY_FIELD);
          yield* typeAsUser(started.id, DEMONSTRATED_CITY);
          yield* clickAsUser(started.id, AREA_FIELD);
          yield* typeAsUser(started.id, DEMONSTRATED_AREA);
          yield* clickAsUser(started.id, CONFIRM_AREA);
          const confirmed = yield* settle;
          expect(
            confirmed.nodes.some((node) =>
              node.name.includes(
                `Delivering to ${DEMONSTRATED_AREA}, ${DEMONSTRATED_CITY}`
              )
            )
          ).toBe(true);
          yield* sessionTool("agent_browser_screenshot", {
            sessionId: started.id,
          });
          yield* service.stopTeachingRecording(
            started.id,
            OperationId.make("delivery-stop-recording")
          );
          return {
            recordingId: started.recordingId,
            teachingSessionId: started.id,
          };
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
      const { recordingId, teachingSessionId } = demonstration;

      yield* Effect.scoped(
        Effect.gen(function* learnInLaterProcess() {
          const claimOperationId = OperationId.make("delivery-claim");
          const claimed = yield* teachingRecordingTool(
            "agent_teaching_recording_claim",
            { operationId: claimOperationId, recordingId }
          );
          expect(claimed.flowSkillName).toBe("set-delivery-area");
          const timeline = yield* teachingRecordingTool(
            "agent_teaching_timeline_get",
            { claimOperationId, recordingId }
          );
          const serialized = JSON.stringify(timeline);
          expect(serialized).toContain("Confirm delivery area");
          expect(serialized).toContain(DEMONSTRATED_AREA);

          const saved = yield* teachingRecordingTool("agent_flow_skill_save", {
            claimOperationId,
            files: [
              { content: DELIVERY_SKILL, path: "SKILL.md" },
              {
                content: DELIVERY_ACCESSIBILITY,
                path: "references/accessibility.md",
              },
            ],
            operationId: OperationId.make("delivery-save"),
            recordingId,
          });
          expect(saved.flowSkillName).toBe("set-delivery-area");

          const skillDirectory = path.join(root, "set-delivery-area");
          const skill = yield* fileSystem.readFileString(
            path.join(skillDirectory, "SKILL.md")
          );
          const accessibility = yield* fileSystem.readFileString(
            path.join(skillDirectory, "references", "accessibility.md")
          );
          // The package must be followable once the recording is deleted: it
          // carries no element reference, no artifact path, and no demonstrated
          // literal standing in for an input.
          for (const content of [skill, accessibility]) {
            expect(content).not.toMatch(/(?<![\w-])e\d+(?![\w-])/u);
            expect(content).not.toContain("trace.zip");
            expect(content).not.toContain("recording.webm");
            expect(content).not.toContain(root);
          }
          expect(skill).not.toContain(DEMONSTRATED_CITY);
          expect(skill).not.toContain(DEMONSTRATED_AREA);
          expect(skill).toContain("{{city}}");
          expect(skill).toContain("{{delivery_area}}");
          // Contingency stamps the demonstrated ceiling and device into the
          // package, because the recording that proves them is deleted once
          // the user verifies.
          const stamped = readFlowSkillFrontmatter(skill);
          expect(stamped?.hosts).toContain("127.0.0.1");
          expect(stamped?.emulation?.viewport).toEqual(agentViewport);

          const recordingDirectory = path.join(
            root,
            ".recordings",
            recordingId
          );
          const failedRun = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            {
              inputs: [
                {
                  changed: true,
                  name: "city",
                  secret: false,
                  value: "Pune",
                },
                {
                  changed: true,
                  name: "delivery_area",
                  secret: false,
                  value: "Baner",
                },
              ],
              operationId: OperationId.make("delivery-dry-failed-start"),
              recordingId,
              url: fixtures.url("delivery.html"),
            }
          );
          // A Dry Run proves the Flow Skill in a context the demonstration
          // never touched, so it must not reuse the Teaching session.
          expect(failedRun.session.id).not.toBe(teachingSessionId);
          expect(failedRun.session.activity).toBe("run");
          expect(failedRun.files.map((file) => file.path)).toContain(
            "SKILL.md"
          );
          yield* teachingRecordingTool("agent_flow_skill_dry_run_report", {
            observableOutcome: "The delivery status did not match.",
            operationId: OperationId.make("delivery-dry-failed-report"),
            outcome: "failed",
            recordingId,
          });
          expect(yield* fileSystem.exists(recordingDirectory)).toBe(true);

          const passedRun = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            {
              inputs: [
                {
                  changed: true,
                  name: "city",
                  secret: false,
                  value: "Mumbai",
                },
                {
                  changed: true,
                  name: "delivery_area",
                  secret: false,
                  value: "Bandra",
                },
              ],
              operationId: OperationId.make("delivery-dry-passed-start"),
              recordingId,
              url: fixtures.url("delivery.html"),
            }
          );
          yield* driveDeliveryAsAgent(
            passedRun.session.id,
            "Mumbai",
            "Bandra",
            "delivery-dry-passed"
          );
          yield* teachingRecordingTool("agent_flow_skill_dry_run_report", {
            observableOutcome: "Delivering to Bandra, Mumbai.",
            operationId: OperationId.make("delivery-dry-passed-report"),
            outcome: "passed",
            recordingId,
          });
          expect(yield* fileSystem.exists(recordingDirectory)).toBe(true);
          const rejected = yield* teachingRecordingTool(
            "agent_flow_skill_reject",
            {
              operationId: OperationId.make("delivery-reject"),
              recordingId,
            }
          );
          expect(rejected.lifecycle).toBe("skill-drafted");
          expect(yield* fileSystem.exists(recordingDirectory)).toBe(true);

          const finalRun = yield* teachingRecordingTool(
            "agent_flow_skill_dry_run_start",
            {
              inputs: [
                {
                  changed: true,
                  name: "city",
                  secret: false,
                  value: "Pune",
                },
                {
                  changed: true,
                  name: "delivery_area",
                  secret: false,
                  value: "Koregaon Park",
                },
              ],
              operationId: OperationId.make("delivery-dry-final-start"),
              recordingId,
              url: fixtures.url("delivery.html"),
            }
          );
          yield* driveDeliveryAsAgent(
            finalRun.session.id,
            "Pune",
            "Koregaon Park",
            "delivery-dry-final"
          );
          yield* teachingRecordingTool("agent_flow_skill_dry_run_report", {
            observableOutcome: "Delivering to Koregaon Park, Pune.",
            operationId: OperationId.make("delivery-dry-final-report"),
            outcome: "passed",
            recordingId,
          });
          const verified = yield* teachingRecordingTool(
            "agent_flow_skill_verify",
            {
              operationId: OperationId.make("delivery-verify"),
              recordingId,
            }
          );
          expect(verified.cleanup._tag).toBe("purged");
          expect(yield* fileSystem.exists(recordingDirectory)).toBe(false);
          expect(
            yield* fileSystem.exists(path.join(skillDirectory, "SKILL.md"))
          ).toBe(true);
          expect(
            yield* fileSystem.exists(
              path.join(skillDirectory, "references", "verification.md")
            )
          ).toBe(true);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

      yield* Effect.scoped(
        Effect.gen(function* runVerifiedSkillAfterRestart() {
          const restarted = yield* sessionTool("agent_session_start", {
            clientName: "integration-restart",
            clientVersion: "1.0.0",
            operationId: OperationId.make("delivery-restart-run"),
            url: fixtures.url("delivery.html"),
            viewport: agentViewport,
          });
          yield* driveDeliveryAsAgent(
            restarted.id,
            "Pune",
            "Kalyani Nagar",
            "delivery-restart"
          );

          // A Run may only open where the journey was demonstrated: the
          // stamped ceiling is what the user actually showed, so a foreign
          // start URL is refused rather than silently becoming the new scope.
          const foreign = yield* Effect.result(
            runTool("agent_flow_skill_run_start", {
              clientName: "integration-restart",
              clientVersion: "1.0.0",
              flowSkillName: FlowSkillName.make("set-delivery-area"),
              inputs: [
                { name: "city", value: "Pune" },
                { name: "delivery_area", value: "Baner" },
              ],
              operationId: OperationId.make("delivery-run-foreign"),
              url: "http://localhost:1/delivery.html",
            })
          );
          expect(Result.isFailure(foreign)).toBe(true);
          if (Result.isFailure(foreign)) {
            expect(JSON.stringify(foreign.failure)).toContain(
              "flow_skill_invalid"
            );
            expect(JSON.stringify(foreign.failure)).toContain("localhost");
          }

          const run = yield* runTool("agent_flow_skill_run_start", {
            clientName: "integration-restart",
            clientVersion: "1.0.0",
            flowSkillName: FlowSkillName.make("set-delivery-area"),
            inputs: [
              { name: "city", value: "Pune" },
              { name: "delivery_area", value: "Baner" },
            ],
            operationId: OperationId.make("delivery-run-start"),
            url: fixtures.url("delivery.html"),
          });
          expect(run.run?.steps.length).toBeGreaterThan(0);
          // The Run reproduces the device the journey was demonstrated on, so
          // read the Emulation the browser actually applied rather than any
          // value the start call echoed back.
          const session = yield* AgentSession;
          const applied = yield* session.emulation(run.id);
          expect(applied.emulation.viewport).toEqual(agentViewport);
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
