import { AgentElementRef, AgentSnapshotId } from "@contingency/protocol";
import { expect, test } from "vitest";

import { redactAgentSnapshot } from "../../src/services/agent-browser.ts";

test("redacts private values from repeated-item context before compact formatting", () => {
  const snapshot = redactAgentSnapshot(
    {
      capturedAt: "2026-10-02T00:00:00Z",
      nodes: [
        {
          context: "Account private-account",
          depth: 0,
          name: "Continue private-account",
          ref: AgentElementRef.make("e1"),
          role: "button",
        },
      ],
      snapshotId: AgentSnapshotId.make("snapshot-redaction"),
      title: "Cart private-account",
      url: "https://example.test/cart",
    },
    ["private-account"]
  );
  expect(JSON.stringify(snapshot)).not.toContain("private-account");
  expect(snapshot.nodes[0]?.context).toContain("Account");
});
