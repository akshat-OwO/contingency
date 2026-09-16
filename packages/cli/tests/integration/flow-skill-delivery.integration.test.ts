import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
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

      const recordingId = yield* Effect.scoped(
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
          return started.recordingId;
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );

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
        }).pipe(Effect.provide(agentProcessLayer(root)))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
