import { agentPointerTravelMs } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

describe("agentPointerTravelMs", () => {
  it("does not wait for a cursor already on its target", () => {
    expect(agentPointerTravelMs(0)).toBe(0);
  });

  it("takes longer for a longer reach, within bounds", () => {
    const short = agentPointerTravelMs(20);
    const long = agentPointerTravelMs(1200);
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(160);
    expect(agentPointerTravelMs(100_000)).toBe(420);
  });
});
