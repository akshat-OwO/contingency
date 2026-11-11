// Teaching clicks on native labels: a click on a label that activates a
// native control is recorded as that control, and only where the browser
// itself would carry the click to it. See fixtures/label-clicks.html.
import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem } from "effect";

import {
  AgentSession,
  UNRESOLVED_CLICK_DESCRIPTION,
} from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  startUserTeaching,
  teachingRecordingTool,
} from "./agent-harness.ts";
import { fixtureServer } from "./harness.ts";

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 } as const;

/** Each click, in order, and what the Teaching Timeline says it was. */
const LABEL_CLICKS: readonly {
  readonly pattern: string;
  readonly point: { readonly x: number; readonly y: number };
  /** `null` for a click no label carries to a control. */
  readonly description: string | null;
}[] = [
  {
    description: 'Click radio "Standard shipping"',
    pattern: "label wrapping a radio",
    point: { x: 200, y: 30 },
  },
  {
    description: 'Click checkbox "Promo emails"',
    pattern: "for label of a display:none checkbox",
    point: { x: 475, y: 30 },
  },
  {
    description: 'Click checkbox "Newsletter"',
    pattern: "for label apart from its checkbox",
    point: { x: 200, y: 80 },
  },
  {
    description: null,
    pattern: "space between a checkbox and its label",
    point: { x: 60, y: 80 },
  },
  {
    description: 'Click radio "Store pickup"',
    pattern: "label wrapping a radio drawn at no size",
    point: { x: 475, y: 80 },
  },
  {
    description: 'Click checkbox "Accept terms"',
    pattern: "first of two labels",
    point: { x: 100, y: 130 },
  },
  {
    description: 'Click checkbox "Accept terms"',
    pattern: "second of two labels",
    point: { x: 240, y: 130 },
  },
  {
    description: null,
    pattern: "details disclosure inside a label",
    point: { x: 570, y: 130 },
  },
  {
    description: 'Click checkbox "Gift note"',
    pattern: "uncovered part of a label",
    point: { x: 100, y: 180 },
  },
  {
    description: null,
    pattern: "layer covering a label",
    point: { x: 235, y: 180 },
  },
  {
    // The link takes the click for itself; it is named by the label around
    // it, as every control inside a label is.
    description: 'Click link "Agree to policy"',
    pattern: "link inside a label",
    point: { x: 570, y: 180 },
  },
  {
    description: 'Click checkbox "Shadow consent"',
    pattern: "for label inside an open shadow root",
    point: { x: 200, y: 230 },
  },
  {
    description: 'Click checkbox "Frame updates" in frame',
    pattern: "label inside an Embedded Frame",
    point: { x: 475, y: 240 },
  },
  {
    description: 'Click checkbox "Closed consent"',
    pattern: "label inside a closed shadow root",
    point: { x: 150, y: 300 },
  },
];

it.live("records a click on a native label as the control it activates", () =>
  Effect.gen(function* teachLabelClicks() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-label-clicks-",
    });
    const fixtures = yield* fixtureServer;

    yield* Effect.gen(function* demonstrate() {
      // Register before navigation so the frame's load cannot be missed.
      const frameLoaded = yield* fixtures.awaitRequest((url) =>
        url.includes("/label-frame-loaded")
      );
      const started = yield* startUserTeaching({
        activity: "teaching",
        clientName: "integration-recorder",
        clientVersion: "1.0.0",
        group: "",
        name: "label-clicks",
        operationId: OperationId.make("label-clicks-start-session"),
        url: fixtures.url("label-clicks.html"),
        viewport,
      });
      const { recordingId } = started;
      if (recordingId === null) {
        return yield* Effect.die("Teaching did not allocate a recording.");
      }
      yield* Deferred.await(frameLoaded).pipe(Effect.timeout("30 seconds"));
      const service = yield* AgentSession;
      yield* service.startTeachingRecording(
        started.id,
        OperationId.make("label-clicks-start-recording")
      );
      for (const { point } of LABEL_CLICKS) {
        for (const eventType of ["mousePressed", "mouseReleased"] as const) {
          yield* service.sendInput(started.id, {
            button: "left",
            clickCount: 1,
            eventType,
            type: "input_mouse",
            ...point,
          });
        }
      }
      yield* service.stopTeachingRecording(
        started.id,
        OperationId.make("label-clicks-stop-recording")
      );

      const claimOperationId = OperationId.make("label-clicks-claim");
      yield* teachingRecordingTool("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOperationId,
        recordingId,
      });
      const timeline = yield* teachingRecordingTool(
        "agent_teaching_timeline_get",
        { claimOperationId, recordingId }
      );
      const actions = timeline.entries.flatMap((entry) =>
        entry._tag === "action"
          ? [{ description: entry.description, kind: entry.kind }]
          : []
      );
      // One action per click, in order: a label click is never recorded as
      // the control and again as something else.
      expect(
        actions.map(({ description, kind }, index) => ({
          kind,
          pattern: LABEL_CLICKS[index]?.pattern,
          recorded: description,
        }))
      ).toEqual(
        LABEL_CLICKS.map(({ description, pattern }) => ({
          kind: "click",
          pattern,
          recorded:
            description === null
              ? UNRESOLVED_CLICK_DESCRIPTION
              : expect.stringContaining(description),
        }))
      );
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
