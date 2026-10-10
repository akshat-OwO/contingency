import { ContingencyRpcs, OperationId } from "@contingency/protocol";
import type { AgentSessionId, KeyboardInput } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { RpcTest } from "effect/rpc";
import { vi } from "vitest";

import type {
  AgentBrowser,
  AgentBrowserFactory,
} from "../../src/services/agent-browser-contract.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import { makeChromiumAgentBrowser } from "../../src/services/chromium-agent-browser.ts";
import {
  agentProcessLayer,
  agentViewport,
  awaitSession,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

/** Where the user's pointer lands on the fixture's fixed fields. */
const MOBILE_FIELD = { x: 120, y: 116 } as const;
const SEARCH_FIELD = { x: 120, y: 176 } as const;

const key = (sessionId: AgentSessionId, input: Omit<KeyboardInput, "type">) =>
  AgentSession.pipe(
    Effect.flatMap((service) =>
      service.sendInput(sessionId, { ...input, type: "input_keyboard" })
    )
  );

/** One key the way the Workspace canvas sends it. */
const press = (sessionId: AgentSessionId, name: string, text: string) =>
  Effect.gen(function* pressKey() {
    yield* key(sessionId, { eventType: "keyDown", key: name, text });
    yield* key(sessionId, { eventType: "keyUp", key: name });
  });

const click = (
  sessionId: AgentSessionId,
  at: { readonly x: number; readonly y: number }
) =>
  Effect.gen(function* clickAsUser() {
    const service = yield* AgentSession;
    for (const eventType of ["mousePressed", "mouseReleased"] as const) {
      yield* service.sendInput(sessionId, {
        button: "left",
        clickCount: 1,
        eventType,
        type: "input_mouse",
        ...at,
      });
    }
  });

const startRecording = (name: string) =>
  Effect.gen(function* startTeachingRecording() {
    const fixtures = yield* fixtureServer;
    const started = yield* startUserTeaching({
      activity: "teaching",
      clientName: "integration-recorder",
      clientVersion: "1.0.0",
      name,
      operationId: OperationId.make(`${name}-start-session`),
      url: fixtures.url("typing-burst.html"),
      viewport: agentViewport,
    });
    const { recordingId } = started;
    if (recordingId === null) {
      return yield* Effect.die("Teaching did not allocate a recording.");
    }
    const service = yield* AgentSession;
    yield* service.startTeachingRecording(
      started.id,
      OperationId.make(`${name}-start-recording`)
    );
    return { recordingId, sessionId: started.id };
  });

const recordedEntries = (
  name: string,
  sessionId: AgentSessionId,
  recordingId: Parameters<
    typeof teachingRecordingTool<"agent_teaching_recording_claim">
  >[1]["recordingId"]
) =>
  Effect.gen(function* readRecordedEntries() {
    const service = yield* AgentSession;
    yield* service.stopTeachingRecording(
      sessionId,
      OperationId.make(`${name}-stop-recording`)
    );
    const claimOperationId = OperationId.make(`${name}-claim`);
    yield* teachingRecordingTool("agent_teaching_recording_claim", {
      action: "take",
      operationId: claimOperationId,
      recordingId,
    });
    const timeline = yield* teachingRecordingTool(
      "agent_teaching_timeline_get",
      { claimOperationId, recordingId }
    );
    return timeline.entries;
  });

const actionsOf = (
  entries: Effect.Success<ReturnType<typeof recordedEntries>>
) => entries.flatMap((entry) => (entry._tag === "action" ? [entry] : []));

it.live(
  "sends each key typed into a field without waiting on a Browser Snapshot",
  () =>
    Effect.gen(function* typeWithoutWaiting() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-typing-burst-",
      });

      // The Browser the recording opens, so the test can observe its Snapshots.
      const browsers: AgentBrowser[] = [];
      const agentBrowserFactory: AgentBrowserFactory = (input) =>
        makeChromiumAgentBrowser(input).pipe(
          Effect.tap((created) => Effect.sync(() => browsers.push(created)))
        );
      yield* Effect.gen(function* typeAMobileNumber() {
        const { recordingId, sessionId } =
          yield* startRecording("typing-burst");
        const [browser] = browsers;
        if (browser === undefined) {
          return yield* Effect.die("Teaching did not open a browser.");
        }
        const page = yield* browser.active();
        yield* click(sessionId, MOBILE_FIELD);
        // The first digit observes the field; later digits reuse that evidence.
        yield* press(sessionId, "9", "9");
        const snapshots = vi.spyOn(page, "snapshot");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => snapshots.mockRestore())
        );
        for (const digit of "876543210") {
          yield* press(sessionId, digit, digit);
        }
        // Typing after the first digit goes straight to the Page: no Browser
        // Snapshot between the first digit and the last.
        expect(snapshots).not.toHaveBeenCalled();

        // The tenth digit moved focus on to Search, and the number stays
        // what was typed into Mobile number.
        const actions = actionsOf(
          yield* recordedEntries("typing-burst", sessionId, recordingId)
        );
        expect(actions.map((action) => action.kind)).toEqual(["click", "fill"]);
        const [, fill] = actions;
        expect(fill?.description).toBe(
          'Fill textbox "Mobile number" with "9876543210"'
        );
        expect(fill?.target?.value).toBe("9876543210");
        expect(fill?.before.nodeCount).toBeGreaterThan(0);
        expect(fill?.after.nodeCount).toBeGreaterThan(0);
      }).pipe(
        Effect.scoped,
        Effect.provide(agentProcessLayer(root, { agentBrowserFactory }))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "records typing once it pauses, ahead of the Enter that submits it",
  () =>
    Effect.gen(function* recordTypingThenSubmit() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-typing-pause-",
      });

      yield* Effect.gen(function* searchAndSubmit() {
        const { recordingId, sessionId } =
          yield* startRecording("typing-pause");
        yield* click(sessionId, SEARCH_FIELD);
        for (const character of "tablets") {
          yield* press(sessionId, character, character);
        }
        // The idle timer starts the flush; its snapshot and keyframe still
        // have to finish. Observe the Fill without sending more browser input.
        const client = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        const session = yield* awaitSession(client, sessionId, (current) =>
          current.timeline.some(
            (entry) =>
              entry.description === 'Fill textbox "Search" with "tablets"'
          )
        );
        expect(session.timeline.map((entry) => entry.description)).toContain(
          'Fill textbox "Search" with "tablets"'
        );

        yield* key(sessionId, {
          code: "Enter",
          eventType: "keyDown",
          key: "Enter",
          text: "\r",
          windowsVirtualKeyCode: 13,
        });
        yield* key(sessionId, {
          code: "Enter",
          eventType: "keyUp",
          key: "Enter",
        });
        const actions = actionsOf(
          yield* recordedEntries("typing-pause", sessionId, recordingId)
        );
        expect(actions.map((action) => action.kind)).toEqual([
          "click",
          "fill",
          "input",
        ]);
        const [, fill, enter] = actions;
        expect(fill?.description).toBe('Fill textbox "Search" with "tablets"');
        expect(enter?.description).toContain("keyDown");
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
