import { expect, test } from "vitest";

import { teachingAgentPrompt } from "@/components/agent/teaching-recording-state";

test("points the learning agent at Contingency's own authoring skills", () => {
  const prompt = teachingAgentPrompt("set-delivery-area", "recording-7");

  expect(prompt).toContain("recording-7");
  expect(prompt).toContain('"set-delivery-area"');
  for (const uri of [
    "contingency://skill/writing-for-agents",
    "contingency://skill/writing-for-agents/SKILL-MECHANICS.md",
    "contingency://skill/technical-writing",
    "contingency://skill/unslop",
  ]) {
    expect(prompt).toContain(uri);
  }
  // Availability is Contingency's job, so the prompt does not hedge, and it
  // never sends the agent to the skill it must not use.
  expect(prompt).not.toContain("if available");
  expect(prompt).toContain("Do not use skill-creator");
});
