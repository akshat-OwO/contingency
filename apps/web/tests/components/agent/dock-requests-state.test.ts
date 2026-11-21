import { AgentSessionSnapshot } from "@contingency/protocol";
import { Schema } from "effect";
import { expect, test } from "vitest";

import {
  dockRequests,
  requestQueue,
  setAsideAfter,
  shortDecisionId,
  splitWaiting,
  staysCollapsed,
} from "@/components/agent/dock-requests-state";
import type { DockRequest } from "@/components/agent/dock-requests-state";

const at = "2026-09-02T00:00:00.000Z";

const decodeSnapshot = Schema.decodeUnknownSync(AgentSessionSnapshot);

/**
 * A live Run session, decoded through the protocol schema so every fixture is
 * a snapshot the Workspace could really receive.
 */
const snapshot = (overrides: Readonly<Record<string, Schema.Json>>) =>
  decodeSnapshot({
    activity: "run",
    boundary: null,
    captureState: null,
    clientName: "Test agent",
    clientVersion: "1.0",
    controller: "agent",
    createdAt: at,
    currentUrl: "https://shop.example.com/",
    dryRun: null,
    flowName: "checkout",
    id: "agent-one",
    interruptedAction: null,
    ownerProcessId: "mcp-test",
    pendingDecisions: [],
    phase: "running",
    recordingId: "recording-checkout",
    run: null,
    takeover: null,
    teaching: null,
    timeline: [],
    updatedAt: at,
    viewUrl: "http://127.0.0.1:7777/?session=agent-one",
    ...overrides,
  });

const boundary = (reason: string, id = "boundary-1") => ({
  action: { ref: "e1", type: "click" },
  description: "Open the payment page",
  id,
  operationId: "op-1",
  reason,
  requested: "Open payments.example.test",
});

test("asks what a Boundary would let the agent do", () => {
  expect(
    dockRequests(snapshot({ boundary: boundary("confirmation") }))
  ).toEqual([
    {
      key: "boundary:boundary-1",
      kind: "boundary",
      summary: "Open payments.example.test",
      title: "Allow the agent to take this action?",
      waiting: true,
    },
  ]);
  expect(
    dockRequests(snapshot({ boundary: boundary("domain") })).at(0)?.title
  ).toBe("Allow the agent to visit a new host?");
});

test("keeps a Boundary in the dock while the user holds the browser", () => {
  expect(
    dockRequests(
      snapshot({ boundary: boundary("confirmation"), controller: "user" })
    )
  ).toEqual(dockRequests(snapshot({ boundary: boundary("confirmation") })));
});

test("counts setup Variables still waiting during agent-held setup only", () => {
  const setupVariables = [
    { name: "A", purpose: "a", requestId: "r1", status: "requested" },
    { name: "B", purpose: "b", requestId: "r2", status: "supplied" },
  ];
  const teaching = {
    activity: "teaching",
    captureState: { _tag: "setup", requestedAt: at },
    setupVariables,
    teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
  };
  expect(dockRequests(snapshot(teaching))).toEqual([
    {
      key: "setup:r1",
      kind: "setup-variables",
      summary: "1 of 2 needed",
      title: "Setup Variables",
      waiting: true,
    },
  ]);
  expect(dockRequests(snapshot({ ...teaching, controller: "user" }))).toEqual(
    []
  );
});

test("counts Dry Run secrets still to supply", () => {
  const request = dockRequests(
    snapshot({
      dryRun: {
        flowName: "checkout",
        inputs: [],
        recordingId: "recording-checkout",
        startedAt: at,
        variables: [
          { name: "CARD", runtime: false, secret: true, supplied: false },
          { name: "PIN", runtime: false, secret: true, supplied: true },
        ],
      },
    })
  ).find(({ kind }) => kind === "dry-run-secrets");
  expect(request).toEqual({
    key: "secrets:CARD",
    kind: "dry-run-secrets",
    summary: "1 of 2 needed",
    title: "Dry Run Variables",
    waiting: true,
  });
});

test("keeps a folded tier folded only while nothing new is asked", () => {
  const first = dockRequests(snapshot({ boundary: boundary("confirmation") }));
  const folded = new Set(first.map(({ key }) => key));
  expect(staysCollapsed(first, folded)).toBe(true);
  const next = dockRequests(
    snapshot({ boundary: boundary("confirmation", "boundary-2") })
  );
  expect(staysCollapsed(next, folded)).toBe(false);
});

test("shortens a pending decision id to the characters a person matches", () => {
  expect(shortDecisionId("pending-2ca483b9-83b0-442f-8461-46aaf28c12e2")).toBe(
    "pending-2ca4…12e2"
  );
  expect(shortDecisionId("pending-41aa")).toBe("pending-41aa");
});

test("splits inputs into waiting and answered in their original order", () => {
  expect(splitWaiting([1, 2, 3, 4], (value) => value % 2 === 0)).toEqual([
    [2, 4],
    [1, 3],
  ]);
});

test("drops Dry Run secrets from the dock once every one is supplied", () => {
  expect(
    dockRequests(
      snapshot({
        dryRun: {
          flowName: "checkout",
          inputs: [],
          recordingId: "recording-checkout",
          startedAt: at,
          variables: [
            { name: "CARD", runtime: false, secret: true, supplied: true },
          ],
        },
      })
    )
  ).toEqual([]);
});

test("a new Guided Run question opens a folded tier and answered pairs remain readable", () => {
  const question = {
    actor: "agent",
    at,
    dialogue: { _tag: "question" },
    id: "question-one",
    target: null,
    text: "Which item?",
  };
  const guided = {
    activity: "teaching",
    captureState: { _tag: "recording", startedAt: at },
    flowName: "cart",
    origin: "guided-run",
    recordingId: "recording-cart",
    teaching: { actionCount: 0, instructionCount: 1, instructions: [question] },
  };
  const requests = dockRequests(snapshot(guided));
  expect(requests).toEqual([
    {
      key: "questions:question-one",
      kind: "guided-run-questions",
      summary: "1 of 1 needed",
      title: "Guided Run questions",
      waiting: true,
    },
  ]);
  const folded = new Set(requests.map(({ key }) => key));
  const answered = {
    ...guided,
    teaching: {
      actionCount: 0,
      instructionCount: 2,
      instructions: [
        question,
        {
          actor: "user",
          at,
          dialogue: { _tag: "answer", questionId: "question-one" },
          id: "answer-one",
          target: null,
          text: "Anvil",
        },
      ],
    },
  };
  expect(dockRequests(snapshot(answered))[0]).toMatchObject({
    summary: "All answered",
    waiting: false,
  });
  const next = {
    ...guided,
    teaching: {
      actionCount: 0,
      instructionCount: 2,
      instructions: [question, { ...question, id: "question-two" }],
    },
  };
  expect(staysCollapsed(dockRequests(snapshot(next)), folded)).toBe(false);
});

const request = (key: string, waiting = true): DockRequest => ({
  key,
  kind: "boundary",
  summary: key,
  title: key,
  waiting,
});

test("shows open requests before settled ones, each in the order asked", () => {
  const requests = [request("answered", false), request("a"), request("b")];
  expect(requestQueue(requests, []).map(({ key }) => key)).toEqual([
    "a",
    "b",
    "answered",
  ]);
});

test("stepping past a request reaches every one and comes back round", () => {
  const requests = [request("a"), request("b"), request("c", false)];
  let setAside: readonly string[] = [];
  const shown: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    const [first] = requestQueue(requests, setAside);
    if (first === undefined) {
      throw new Error("The queue is empty");
    }
    shown.push(first.key);
    setAside = setAsideAfter(requests, setAside, first);
  }
  expect(shown).toEqual(["a", "b", "c", "a"]);
  // A request no longer asked leaves the set-aside list.
  expect(setAsideAfter([request("b")], ["a", "c"], request("b"))).toEqual([
    "b",
  ]);
});

test("counts runtime Variables still needed against those answered", () => {
  const decision = (name: string) => ({
    boundaryId: null,
    createdAt: at,
    kind: "supply_variable",
    pendingDecisionId: `pending-${name}`,
    scopeSummary: `Supply Variable login/${name}.`,
    sessionId: "agent-one",
    variable: { flowName: "login", name },
  });
  const [runtime] = dockRequests(
    snapshot({ pendingDecisions: [decision("PASSWORD"), decision("OTP")] })
  );
  expect(runtime).toMatchObject({
    kind: "runtime-variables",
    summary: "2 of 2 needed",
    waiting: true,
  });
});
