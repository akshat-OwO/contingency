import { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Schema } from "effect";

import { agentViewport } from "./agent-process.ts";
import { fixtureServer } from "./harness.ts";
import {
  act,
  awaitSession,
  call,
  journey,
  replayTranscript,
  scriptedProcess,
} from "./scripted-agent.ts";
import { User } from "./scripted-user.ts";
import {
  bindEnvironment,
  makeRecorder,
  makeScript,
  readTranscript,
  Script,
  substitute,
  Transcript,
} from "./transcript.ts";

/** A short journey: open a page, click by role and name, and meet a refusal. */
const addAnAnvil = Effect.gen(function* addAnAnvilJourney() {
  const fixtures = yield* fixtureServer;
  yield* bindEnvironment("fixtureOrigin", new URL(fixtures.url("")).origin);
  const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "contingency-scripted-agent-",
  });
  yield* Effect.gen(function* driveTheCart() {
    const started = yield* call("agent_session_start", {
      clientName: "scripted-agent",
      clientVersion: "1.0.0",
      url: fixtures.url("task-session.html"),
      viewport: agentViewport,
    });
    const added = yield* act(
      started.id,
      { name: "Add anvil", role: "button" },
      { type: "click" }
    );
    expect(
      added.snapshot.nodes?.some((node) => node.name.includes("Cart has 1"))
    ).toBe(true);
    const refused = yield* Effect.flip(
      call("agent_session_get", {
        sessionId: AgentSessionId.make("agent-missing"),
      })
    );
    expect(refused.code).toBe("agent_session_not_found");
    expect(refused.message).toContain("agent-missing");
    expect(refused.failureReference).toBeUndefined();
    yield* call("agent_session_close", { sessionId: started.id });
  }).pipe(Effect.provide(scriptedProcess(root)), Effect.scoped);
});

journey(
  "resolves a control by role and name and decodes a refusal",
  { singleTool: true },
  addAnAnvil
);

journey(
  "waits on Session Events until the state the next assertion reads",
  { singleTool: true },
  Effect.gen(function* awaitTakeoverJourney() {
    const fixtures = yield* fixtureServer;
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "contingency-scripted-agent-",
    });
    yield* Effect.gen(function* awaitTheUser() {
      const started = yield* call("agent_session_start", {
        clientName: "scripted-agent",
        clientVersion: "1.0.0",
        url: fixtures.url("task-session.html"),
        viewport: agentViewport,
      });
      // The user takes over only after the first read, so the wait must
      // observe the takeover through a Session Event.
      const firstRead = yield* Deferred.make<boolean>();
      const waiting = yield* awaitSession(started.id, (session) => {
        Deferred.doneUnsafe(firstRead, Effect.succeed(true));
        return session.controller === "user";
      }).pipe(Effect.forkChild);
      yield* Deferred.await(firstRead);
      yield* User.takeover(started.id, "The user checks the cart.");
      const session = yield* Fiber.join(waiting);
      expect(session.controller).toBe("user");
      yield* User.returnControl(started.id);
      yield* call("agent_session_close", { sessionId: started.id });
    }).pipe(Effect.provide(scriptedProcess(root)), Effect.scoped);
  })
);

it("binds each supplied value to its own token and restores it literally", () => {
  const recorder = makeRecorder();
  recorder.process();
  for (const value of ["first$$value", "second $& value"]) {
    recorder.user({
      _tag: "supply-variable",
      name: "DELIVERY_AREA",
      sessionId: "agent-session",
      value,
    });
  }
  // A later step that repeats a supplied value is redacted too.
  recorder.user({
    _tag: "type",
    sessionId: "agent-session",
    text: "first$$value",
  });
  const program = recorder.tokenize({ text: "second $& value" });
  expect(program).toEqual({ text: "{{supplied2}}" });
  const { bindings, steps } = recorder.transcript("supplied");
  const supplied = steps.flatMap((step) =>
    step._tag === "user" && step.action._tag === "supply-variable"
      ? [step.action.value]
      : []
  );
  expect(supplied).toEqual(["{{supplied1}}", "{{supplied2}}"]);
  const typed = steps.flatMap((step) =>
    step._tag === "user" && step.action._tag === "type"
      ? [step.action.text]
      : []
  );
  expect(typed).toEqual(["{{supplied1}}"]);
  expect(JSON.stringify(steps)).not.toContain("first");
  expect(JSON.stringify(steps)).not.toContain("second");
  expect(bindings.map(({ token }) => token)).toEqual([
    "{{supplied1}}",
    "{{supplied2}}",
  ]);
  const values = new Map([
    ["{{supplied1}}", "first$$value"],
    ["{{supplied2}}", "second $& value"],
  ]);
  expect(supplied.map((token) => substitute(token, values))).toEqual([
    "first$$value",
    "second $& value",
  ]);
  // A replay that supplies other values sends them in every step.
  const replayed = new Map([
    ["{{supplied1}}", "Bandra"],
    ["{{supplied2}}", "Juhu"],
  ]);
  expect(
    [...supplied, ...typed, String(program["text"])].map((token) =>
      substitute(token, replayed)
    )
  ).toEqual(["Bandra", "Juhu", "Bandra", "Juhu"]);
});

it("redacts supplied values in payload fields and never in structural ones", () => {
  const recorder = makeRecorder();
  recorder.process();
  recorder.user({
    _tag: "supply-variable",
    name: "type",
    sessionId: "agent-session",
    value: "type",
  });
  recorder.user({
    _tag: "supply-variable",
    name: "AREA",
    sessionId: "agent-session",
    value: "agent",
  });
  recorder.user({ _tag: "type", sessionId: "agent-session", text: "type" });
  const program = recorder.tokenize({
    action: { text: "agent", type: "type" },
    operationId: "agent-type",
    sessionId: "agent-session",
  });
  // An observed label is payload, even in a field called `name`.
  const saved = recorder.tokenize({
    name: "delivery",
    nativeConditions: {
      outcomes: [{ name: "Delivering to agent", role: "text" }],
    },
  });
  const { steps } = recorder.transcript("structural");
  const actions = steps.flatMap((step) =>
    step._tag === "user" ? [step.action] : []
  );
  expect(actions).toEqual([
    {
      _tag: "supply-variable",
      name: "type",
      sessionId: "agent-session",
      value: "{{supplied1}}",
    },
    {
      _tag: "supply-variable",
      name: "AREA",
      sessionId: "agent-session",
      value: "{{supplied2}}",
    },
    { _tag: "type", sessionId: "agent-session", text: "{{supplied1}}" },
  ]);
  expect(program).toEqual({
    action: { text: "{{supplied2}}", type: "type" },
    operationId: "agent-type",
    sessionId: "agent-session",
  });
  expect(saved).toEqual({
    name: "delivery",
    nativeConditions: {
      outcomes: [{ name: "Delivering to {{supplied2}}", role: "text" }],
    },
  });
  expect(
    substitute(JSON.stringify(saved), new Map([["{{supplied2}}", "Juhu"]]))
  ).toContain('"name":"Delivering to Juhu"');
});

it.live("records a journey's programs and replays them over HTTP", () =>
  Effect.gen(function* recordThenReplay() {
    const script = makeScript("http");
    yield* addAnAnvil.pipe(Effect.provideService(Script, script));
    const recorded = Schema.decodeUnknownSync(Transcript)(
      Schema.encodeSync(Transcript)(script.recorder.transcript("add-an-anvil"))
    );
    const programs = recorded.steps.flatMap((step) =>
      step._tag === "program" ? [step] : []
    );
    expect(programs.map(({ outcome }) => outcome.status)).toEqual([
      "completed",
      "completed",
      "program_failed",
      "completed",
    ]);
    expect(programs[2]?.outcome.failureCode).toBe("agent_session_not_found");
    // The session the start minted, and the fixture's port, are tokens.
    expect(programs[0]?.code).toContain("{{fixtureOrigin}}/task-session.html");
    expect(programs[1]?.code).toContain('"sessionId":"{{b1}}"');
    expect(recorded.bindings).toContainEqual({
      from: { _tag: "step", path: ["value", "id"], step: 1 },
      token: "{{b1}}",
    });

    const fixtures = yield* fixtureServer;
    yield* replayTranscript(recorded, {
      environment: { fixtureOrigin: new URL(fixtures.url("")).origin },
      root: yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped(),
    });
  }).pipe(Effect.provide(NodeServices.layer))
);

// The committed transcript #824's emulated model replays. A change that makes
// it stale fails here; re-record it with RECORD_TRANSCRIPTS=1.
it.live(
  "replays the recorded flow-delivery transcript over HTTP @single-tool",
  () =>
    Effect.gen(function* replayFlowDelivery() {
      const fixtures = yield* fixtureServer;
      yield* replayTranscript(yield* readTranscript("flow-delivery"), {
        environment: {
          fixtureOrigin: new URL(fixtures.url("")).origin,
          supplied1: "Bandra",
        },
        root: yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "contingency-replay-",
        }),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  480_000
);
