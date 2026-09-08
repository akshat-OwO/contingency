import { AgentElementRef, describeAgentAction } from "@contingency/protocol";
import { expect, test } from "vitest";

const ref = AgentElementRef.make("e60");

/**
 * An element reference names nothing outside the Browser Snapshot that minted
 * it, so a timeline read minutes later has to say what was acted on rather
 * than which reference the agent happened to use.
 */
test("an action reads as the role and accessible name it acted on", () => {
  expect(
    describeAgentAction(
      { ref, type: "click" },
      { subject: { name: "Select manually", role: "button" } }
    )
  ).toBe('Click button "Select manually"');
  expect(
    describeAgentAction(
      { ref, text: "sector 14", type: "fill" },
      { subject: { name: "Search for your delivery area", role: "textbox" } }
    )
  ).toBe('Fill textbox "Search for your delivery area" with "sector 14"');
});

/** The agent said why it acted, and that reads better than any derived label. */
test("a stated objective is the description for that attempt", () => {
  expect(
    describeAgentAction(
      { ref, type: "click" },
      {
        objective: "Open the delivery address picker",
        subject: { name: "Select manually", role: "button" },
      }
    )
  ).toBe("Open the delivery address picker");
});

/**
 * The reference stays on the action payload as the join back to its Snapshot,
 * so a description with nothing better to say falls back to it rather than
 * describing an element it cannot see.
 */
test("an unresolvable reference still describes the attempt", () => {
  expect(describeAgentAction({ ref, type: "click" })).toBe("Click e60");
  expect(describeAgentAction({ key: "Enter", type: "press" })).toBe(
    "Press Enter"
  );
});

/**
 * Redacted fill text is already its own sentence. Quoting it would read as
 * though the literal placeholder had been typed into the field, and the value
 * behind it must never reach the timeline at all.
 */
test("a sensitive fill describes the control without its value", () => {
  expect(
    describeAgentAction(
      { ref, text: "[sensitive input]", type: "fill" },
      { subject: { name: "Password", role: "textbox" } }
    )
  ).toBe('Fill textbox "Password" with [sensitive input]');
});

/** One timeline line stays legible even when a control carries a paragraph. */
test("a long accessible name is truncated", () => {
  const described = describeAgentAction(
    { ref, type: "click" },
    { subject: { name: "a".repeat(200), role: "button" } }
  );
  expect(described.length).toBeLessThan(80);
  expect(described.endsWith('…"')).toBe(true);
});
