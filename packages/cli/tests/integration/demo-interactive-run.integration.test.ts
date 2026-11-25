import { FlowName } from "@contingency/protocol";
import { expect } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { act, call, journey, scriptedProcess } from "./scripted-agent.ts";

const PRODUCT = "Cedar Pull Saw";
const CITY = "Denver";
const AREA = "Highlands";

/**
 * The demo onboarding's prepared Interactive Run, as an agent carries it out
 * on the bundled demo store. Its transcript is the script the emulated model
 * plays behind a real Claude Code
 * ([ADR 0090](../../../../docs/adr/0090-verification-may-emulate-the-model-behind-a-real-agent-harness.md)).
 */
journey(
  "completes the delivery-and-cart Example on the demo store",
  { demo: true, timeout: 180_000, transcript: "demo-interactive-run" },
  Effect.gen(function* demoInteractiveRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-demo-run-",
    });
    yield* Effect.gen(function* driveExample() {
      yield* call("agent_catalog_get", {});
      const started = yield* call("agent_example_run_start", {
        example: FlowName.make("example-delivery-cart"),
        inputs: [
          { name: "product", value: PRODUCT },
          { name: "city", value: CITY },
          { name: "area", value: AREA },
        ],
      });
      const sessionId = started.id;
      expect(started.currentUrl).toMatch(
        /^http:\/\/ridgeline\.localhost:\d+\//u
      );
      yield* act(
        sessionId,
        { name: "City", role: "combobox" },
        { type: "select", values: [CITY] }
      );
      yield* act(
        sessionId,
        { name: "Area", role: "combobox" },
        { type: "select", values: [AREA] }
      );
      yield* act(
        sessionId,
        { name: "Save location", role: "button" },
        { type: "click" }
      );
      yield* act(
        sessionId,
        { name: `Add ${PRODUCT} to cart`, role: "button" },
        { type: "click" }
      );
      yield* act(sessionId, { name: "Cart", role: "link" }, { type: "click" });
      const cart = yield* call("agent_browser_snapshot", { sessionId });
      const text = (cart.nodes ?? []).map((node) => node.name).join("\n");
      expect(text).toContain(PRODUCT);
      expect(text).toContain(`${AREA}, ${CITY}`);
      yield* call("agent_run_assess", {
        evidence: [{ id: cart.snapshotId, kind: "snapshot" }],
        explanation: `The cart lists ${PRODUCT} for delivery to ${AREA}, ${CITY}.`,
        outcome: "working",
        outcomeComplete: true,
        sessionId,
      });
      yield* call("agent_run_complete", { sessionId });
    }).pipe(Effect.provide(scriptedProcess(root, { demo: true })));
  })
);
