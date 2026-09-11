import { AgentElementRef, AgentSessionId } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";

const at = (second: number) =>
  new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();

const sessionId = AgentSessionId.make("agent-teaching");

const capture = () => makeDemonstrationCapture("https://shop.example.com/");

const playByPlay = (
  demonstration: ReturnType<typeof makeDemonstrationCapture>
) => demonstration.feed(sessionId, false).playByPlay;

describe("the stub PlayByPlay", () => {
  it("names the starting URL before anything is captured", () => {
    const lines = playByPlay(capture()).split("\n");
    expect(lines[0]).toContain("Provisional PlayByPlay");
    expect(lines[1]).toBe("Teaching started on https://shop.example.com/.");
    expect(lines[2]).toBe("Nothing has been captured yet.");
  });

  it("narrates actions, user navigations, and instructions in order", () => {
    const demonstration = capture();
    demonstration.recordInstruction("Skip the upsell popup.", at(1));
    demonstration.recordAction({
      action: { ref: AgentElementRef.make("e1"), type: "click" },
      actor: "user",
      at: at(2),
      description: "clicked Add to cart",
      id: "a1",
      outcome: "completed",
      snapshotAfter: null,
      snapshotBefore: null,
      urlAfter: "https://shop.example.com/cart",
      urlBefore: "https://shop.example.com/",
    });
    demonstration.recordAction({
      action: { ref: AgentElementRef.make("e2"), type: "click" },
      actor: "agent",
      at: at(3),
      description: "clicked Checkout",
      id: "a2",
      outcome: "failed",
      snapshotAfter: null,
      snapshotBefore: null,
      urlAfter: "https://shop.example.com/cart",
      urlBefore: "https://shop.example.com/cart",
    });
    demonstration.recordUrl("https://shop.example.com/thanks", at(4));

    expect(playByPlay(demonstration).split("\n").slice(1)).toEqual([
      "Teaching started on https://shop.example.com/.",
      'The user said: "Skip the upsell popup.".',
      "The user clicked Add to cart, taking the Page to https://shop.example.com/cart.",
      "The agent clicked Checkout, which failed.",
      "The Page moved from https://shop.example.com/cart to https://shop.example.com/thanks without a captured action.",
    ]);
  });
});
