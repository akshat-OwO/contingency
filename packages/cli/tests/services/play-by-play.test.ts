import { AgentElementRef, AgentSessionId } from "@contingency/protocol";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  analyzePlayByPlay,
  playByPlayFromAnalysis,
} from "../../src/services/play-by-play.ts";
import { makeDemonstrationCapture } from "../../src/services/teaching-capture.ts";

const at = (second: number) =>
  new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();

const sessionId = AgentSessionId.make("agent-teaching");

const capture = () => makeDemonstrationCapture("https://shop.example.com/");

const finalize = (
  demonstration: ReturnType<typeof makeDemonstrationCapture>
): string => {
  const playByPlay = playByPlayFromAnalysis(demonstration.current(), {
    sampledFrames: 8,
    visualChanges: 3,
  });
  demonstration.finalizePlayByPlay(playByPlay);
  const feed = demonstration.feed(sessionId, false);
  if (feed === undefined) {
    throw new Error("The analyzed Teaching Feed was unavailable.");
  }
  return feed.playByPlay;
};

describe("the finalized PlayByPlay", () => {
  it("is unavailable before analysis and describes an empty video", () => {
    const demonstration = capture();
    expect(demonstration.feed(sessionId, false)).toBeUndefined();
    expect(finalize(demonstration).split("\n")).toEqual([
      "Contingency analyzed 8 moments from the local Teaching video and found 3 visually distinct changes. The timeline was cross-checked against 0 captured actions, 0 URL transitions, and 0 Browser Snapshots.",
      "The user ended Teaching without a captured browser action.",
    ]);
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

    expect(finalize(demonstration).split("\n").slice(1)).toEqual([
      "The user said: “Skip the upsell popup.”",
      "The user clicked Add to cart, taking the Page to https://shop.example.com/cart.",
      "The agent clicked Checkout, which failed.",
      "The Page moved from https://shop.example.com/cart to https://shop.example.com/thanks without a captured action.",
    ]);
  });

  it("does not disclose a local video path when decoding fails", async () => {
    const videoFile = "/private/catalog/teaching/sensitive.webm";
    const result = await Effect.runPromise(
      Effect.result(
        analyzePlayByPlay({
          demonstration: capture().current(),
          videoFile,
        })
      )
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toBe(
        "The local Teaching video could not be decoded."
      );
      expect(result.failure.message).not.toContain(videoFile);
    }
  });
});
