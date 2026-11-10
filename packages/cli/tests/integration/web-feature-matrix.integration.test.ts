// Web feature matrix: one Teaching recording clicks one target per
// web-platform pattern real sites use (shadow roots, frames, ARIA widgets,
// overlays, canvas) and checks that each click reaches the Teaching Timeline
// named by the control the user saw. See fixtures/web-matrix.html.
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

const viewport = { deviceScaleFactor: 1, height: 560, width: 920 } as const;

/** The center of slot n in web-matrix.html's three-column grid. */
const slot = (index: number) => ({
  x: 10 + 300 * (index % 3) + 140,
  y: 10 + 80 * Math.floor(index / 3) + 30,
});
/** The overlay controls sit in the row below the grid. */
const CONSENT_ACCEPT = { x: 450, y: 440 };
const DIALOG_CONFIRM = { x: 750, y: 440 };

/** Why a Browser Snapshot cannot name these controls yet. */
const LABEL_GAP =
  "a control's hit area excludes the label that activates it (#654)";
const UNNAMED_GAP =
  "a click no Snapshot control contains is dropped, not recorded as unidentified (#653)";

/**
 * Each click and the name its Timeline description must carry. `null` marks
 * a target with no accessible name: its click must say it is unidentified
 * rather than borrow a neighbour's name. A `gap` pins a known limitation: the
 * click is expected to be missing from the Timeline, so fixing the gap fails
 * this test until its row drops the `gap`.
 */
const WEB_MATRIX: readonly {
  readonly pattern: string;
  readonly point: { readonly x: number; readonly y: number };
  readonly name: string | null;
  readonly gap?: string;
}[] = [
  { name: "Place order", pattern: "native button", point: slot(0) },
  {
    name: "Open shadow save",
    pattern: "open shadow root",
    point: slot(1),
  },
  {
    name: "Closed shadow save",
    pattern: "closed shadow root",
    point: slot(2),
  },
  {
    name: "Same-frame save",
    pattern: "same-origin iframe",
    point: slot(3),
  },
  {
    name: "Cross-frame save",
    pattern: "cross-origin iframe",
    point: slot(4),
  },
  { name: "Save draft", pattern: "div role=button", point: slot(5) },
  { name: "Add to wishlist", pattern: "icon-only button", point: slot(6) },
  { name: "Express shipping", pattern: "listbox option", point: slot(7) },
  {
    gap: LABEL_GAP,
    name: "Gift wrap",
    pattern: "checkbox via its label",
    point: slot(8),
  },
  { name: "Shipping details", pattern: "details summary", point: slot(9) },
  { name: "Order history", pattern: "pushState link", point: slot(10) },
  {
    gap: UNNAMED_GAP,
    name: null,
    pattern: "canvas-drawn control",
    point: slot(11),
  },
  { name: "Apply coupon", pattern: "re-rendered on press", point: slot(12) },
  { name: "Show consent", pattern: "overlay opener", point: slot(13) },
  {
    name: "Accept all cookies",
    pattern: "fixed overlay",
    point: CONSENT_ACCEPT,
  },
  { name: "Show dialog", pattern: "dialog opener", point: slot(14) },
  { name: "Confirm order", pattern: "modal dialog", point: DIALOG_CONFIRM },
];

it.live("names every web-matrix click by the control the user saw", () =>
  Effect.gen(function* teachTheMatrix() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-web-matrix-",
    });
    const fixtures = yield* fixtureServer;

    yield* Effect.gen(function* demonstrate() {
      // Both frames have loaded once the cross-origin child is requested;
      // register before navigation so the request cannot be missed.
      const crossFrame = yield* fixtures.awaitRequest((url) =>
        url.includes("label=Cross-frame")
      );
      const started = yield* startUserTeaching({
        activity: "teaching",
        clientName: "integration-recorder",
        clientVersion: "1.0.0",
        group: "",
        name: "web-matrix",
        operationId: OperationId.make("web-matrix-start-session"),
        url: fixtures.url("web-matrix.html"),
        viewport,
      });
      const { recordingId } = started;
      if (recordingId === null) {
        return yield* Effect.die("Teaching did not allocate a recording.");
      }
      // One hang guard: a frame that never loads fails here by name.
      yield* Deferred.await(crossFrame).pipe(Effect.timeout("30 seconds"));
      const service = yield* AgentSession;
      yield* service.startTeachingRecording(
        started.id,
        OperationId.make("web-matrix-start-recording")
      );
      for (const { point } of WEB_MATRIX) {
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
        OperationId.make("web-matrix-stop-recording")
      );

      const claimOperationId = OperationId.make("web-matrix-claim");
      yield* teachingRecordingTool("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOperationId,
        recordingId,
      });
      const timeline = yield* teachingRecordingTool(
        "agent_teaching_timeline_get",
        { claimOperationId, recordingId }
      );
      const clicks = timeline.entries.flatMap((entry) =>
        entry._tag === "action" && entry.kind === "click"
          ? [entry.description]
          : []
      );

      // Each pattern claims the first unclaimed click that names it, so a
      // lost click reports the pattern it belonged to.
      const unclaimed = [...clicks];
      const recorded = WEB_MATRIX.map(({ name, pattern }) => {
        const index = unclaimed.findIndex((description) =>
          name === null
            ? description === UNRESOLVED_CLICK_DESCRIPTION
            : description.includes(`"${name}"`)
        );
        const [description] =
          index === -1 ? [null] : unclaimed.splice(index, 1);
        return { pattern, recorded: description !== null };
      });
      expect({ recorded, unclaimed }).toEqual({
        recorded: WEB_MATRIX.map(({ gap, pattern }) => ({
          pattern,
          recorded: gap === undefined,
        })),
        unclaimed: [],
      });
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("records typing into a field inside a cross-origin frame", () =>
  Effect.gen(function* teachTheEmbeddedField() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-frame-typing-",
    });
    const fixtures = yield* fixtureServer;

    yield* Effect.gen(function* demonstrate() {
      const paymentFrame = yield* fixtures.awaitRequest((url) =>
        url.includes("field=Card")
      );
      const started = yield* startUserTeaching({
        activity: "teaching",
        clientName: "integration-recorder",
        clientVersion: "1.0.0",
        group: "",
        name: "frame-typing",
        operationId: OperationId.make("frame-typing-start-session"),
        url: fixtures.url("frame-typing.html"),
        viewport,
      });
      const { recordingId } = started;
      if (recordingId === null) {
        return yield* Effect.die("Teaching did not allocate a recording.");
      }
      yield* Deferred.await(paymentFrame).pipe(Effect.timeout("30 seconds"));
      const service = yield* AgentSession;
      yield* service.startTeachingRecording(
        started.id,
        OperationId.make("frame-typing-start-recording")
      );
      for (const eventType of ["mousePressed", "mouseReleased"] as const) {
        yield* service.sendInput(started.id, {
          button: "left",
          clickCount: 1,
          eventType,
          type: "input_mouse",
          x: 160,
          y: 50,
        });
      }
      for (const character of "4242") {
        yield* service.sendInput(started.id, {
          eventType: "keyDown",
          key: character,
          text: character,
          type: "input_keyboard",
        });
        yield* service.sendInput(started.id, {
          eventType: "keyUp",
          key: character,
          type: "input_keyboard",
        });
      }
      yield* service.stopTeachingRecording(
        started.id,
        OperationId.make("frame-typing-stop-recording")
      );

      const claimOperationId = OperationId.make("frame-typing-claim");
      yield* teachingRecordingTool("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOperationId,
        recordingId,
      });
      const timeline = yield* teachingRecordingTool(
        "agent_teaching_timeline_get",
        { claimOperationId, recordingId }
      );
      const host = new URL(fixtures.url("frame-typing.html")).port;
      const actions = timeline.entries.flatMap((entry) =>
        entry._tag === "action" ? [`${entry.kind}: ${entry.description}`] : []
      );
      // The field is named by its own label and by the frame that holds it,
      // whichever host the payment provider serves it from.
      expect(actions).toEqual([
        `click: Click textbox "Card number" in frame localhost:${host}`,
        `fill: Fill textbox "Card number" in frame localhost:${host} with "4242"`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
