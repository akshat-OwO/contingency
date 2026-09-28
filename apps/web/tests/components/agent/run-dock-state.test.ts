import { expect, test } from "vitest";

import {
  AGENT_IDLE_NOTICE_MS,
  agentIdleNotice,
} from "@/components/agent/run-dock-state";

const lastActivity = Date.parse("2026-09-28T12:00:00.000Z");

const sessionWith = (
  overrides: {
    readonly controller?: "agent" | "user";
    readonly outcome?: "completed" | null;
    readonly phase?: "running" | "takeover";
  } = {}
) => ({
  controller: overrides.controller ?? "agent",
  phase: overrides.phase ?? "running",
  run: {
    lastAgentActivityAt: new Date(lastActivity).toISOString(),
    outcome: overrides.outcome ?? null,
  },
});

test("says nothing until the agent has been quiet for ten minutes", () => {
  expect(AGENT_IDLE_NOTICE_MS).toBe(10 * 60_000);
  expect(
    agentIdleNotice(sessionWith(), lastActivity + AGENT_IDLE_NOTICE_MS - 1)
  ).toBeUndefined();
  expect(
    agentIdleNotice(sessionWith(), lastActivity + AGENT_IDLE_NOTICE_MS)
  ).toBe("Agent idle for 10 min");
  expect(agentIdleNotice(sessionWith(), lastActivity + 47.5 * 60_000)).toBe(
    "Agent idle for 47 min"
  );
});

test("takes an injected threshold", () => {
  expect(agentIdleNotice(sessionWith(), lastActivity + 60_000, 60_000)).toBe(
    "Agent idle for 1 min"
  );
});

test("an agent waiting on the user is not idle", () => {
  expect(
    agentIdleNotice(
      sessionWith({ controller: "user" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});

test("an agent that asked for a Takeover is waiting, not idle", () => {
  expect(
    agentIdleNotice(
      sessionWith({ phase: "takeover" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});

test("an ended Run has no idle agent", () => {
  expect(
    agentIdleNotice(
      sessionWith({ outcome: "completed" }),
      lastActivity + 60 * 60_000
    )
  ).toBeUndefined();
});
