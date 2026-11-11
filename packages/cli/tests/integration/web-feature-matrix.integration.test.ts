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
/** Below the overlays: patterns whose geometry misleads a box search. */
const COVERED_LINK = { x: 450, y: 520 };
const MENU_TOGGLE = { x: 750, y: 520 };

/**
 * Each click and the name its Timeline description must carry. `null` marks
 * a target with no accessible name: its click must say it is unidentified
 * rather than borrow a neighbour's name. A `gap` pins a known limitation: the
 * click is expected to reach the Timeline unidentified rather than by its
 * name, so fixing the gap fails this test until its row drops the `gap`.
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
  { name: "Gift wrap", pattern: "checkbox via its label", point: slot(8) },
  { name: "Shipping details", pattern: "details summary", point: slot(9) },
  { name: "Order history", pattern: "pushState link", point: slot(10) },
  { name: null, pattern: "canvas-drawn control", point: slot(11) },
  { name: "Apply coupon", pattern: "re-rendered on press", point: slot(12) },
  { name: "Show consent", pattern: "overlay opener", point: slot(13) },
  {
    name: "Accept all cookies",
    pattern: "fixed overlay",
    point: CONSENT_ACCEPT,
  },
  { name: "Show dialog", pattern: "dialog opener", point: slot(14) },
  { name: "Confirm order", pattern: "modal dialog", point: DIALOG_CONFIRM },
  {
    name: "Storefront home",
    pattern: "link drawn over a smaller covered link",
    point: COVERED_LINK,
  },
  {
    name: "Main menu",
    pattern: "transparent checkbox in a landmark",
    point: MENU_TOGGLE,
  },
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

      // Each pattern claims the first unclaimed click that names it, or else
      // the first unidentified one, so a lost or misnamed click reports the
      // pattern it belonged to.
      const unclaimed = [...clicks];
      const claim = (matches: (description: string) => boolean) => {
        const index = unclaimed.findIndex(matches);
        return index !== -1 && unclaimed.splice(index, 1).length === 1;
      };
      const recorded = WEB_MATRIX.map(({ name, pattern }) => {
        if (name !== null && claim((text) => text.includes(`"${name}"`))) {
          return { pattern, recorded: "named" };
        }
        return {
          pattern,
          recorded: claim((text) => text === UNRESOLVED_CLICK_DESCRIPTION)
            ? "unidentified"
            : "missing",
        };
      });
      expect({ recorded, unclaimed }).toEqual({
        recorded: WEB_MATRIX.map(({ gap, name, pattern }) => ({
          pattern,
          recorded:
            name === null || gap !== undefined ? "unidentified" : "named",
        })),
        unclaimed: [],
      });
    }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

/** Below the overlay row: no control, only the Page itself. */
const BLANK_PAGE = { x: 900, y: 540 };

it.live(
  "records a click no Snapshot control contains as unidentified, with a keyframe",
  () =>
    Effect.gen(function* teachUnidentifiedClicks() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-unidentified-click-",
      });
      const fixtures = yield* fixtureServer;

      yield* Effect.gen(function* demonstrate() {
        const started = yield* startUserTeaching({
          activity: "teaching",
          clientName: "integration-recorder",
          clientVersion: "1.0.0",
          group: "",
          name: "unidentified-click",
          operationId: OperationId.make("unidentified-click-start-session"),
          url: fixtures.url("web-matrix.html"),
          viewport,
        });
        const { recordingId } = started;
        if (recordingId === null) {
          return yield* Effect.die("Teaching did not allocate a recording.");
        }
        const service = yield* AgentSession;
        const press = (
          eventType: "mousePressed" | "mouseReleased",
          point: { readonly x: number; readonly y: number }
        ) =>
          service.sendInput(started.id, {
            button: "left",
            clickCount: 1,
            eventType,
            type: "input_mouse",
            ...point,
          });
        const click = (point: { readonly x: number; readonly y: number }) =>
          Effect.andThen(
            press("mousePressed", point),
            press("mouseReleased", point)
          );
        // Setup sits outside the recording boundary, so it leaves no evidence.
        yield* click(slot(11));
        yield* service.startTeachingRecording(
          started.id,
          OperationId.make("unidentified-click-start-recording")
        );
        yield* service.sendInput(started.id, {
          eventType: "mouseMoved",
          type: "input_mouse",
          ...BLANK_PAGE,
        });
        yield* click(slot(11));
        yield* click(BLANK_PAGE);
        yield* click(slot(0));
        // A press is no click until the pointer comes back up.
        yield* press("mousePressed", BLANK_PAGE);
        yield* service.stopTeachingRecording(
          started.id,
          OperationId.make("unidentified-click-stop-recording")
        );

        const claimOperationId = OperationId.make("unidentified-click-claim");
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
          entry._tag === "action" ? [entry] : []
        );
        expect(
          actions.map(({ description, kind, target }) => ({
            description,
            kind,
            target: target === null ? null : "named",
          }))
        ).toEqual([
          {
            description: UNRESOLVED_CLICK_DESCRIPTION,
            kind: "click",
            target: null,
          },
          {
            description: UNRESOLVED_CLICK_DESCRIPTION,
            kind: "click",
            target: null,
          },
          {
            description: expect.stringContaining('"Place order"'),
            kind: "click",
            target: "named",
          },
        ]);
        for (const action of actions) {
          const keyframe = timeline.entries.find(
            (entry) => entry._tag === "keyframe" && entry.actionId === action.id
          );
          if (keyframe?._tag !== "keyframe") {
            return yield* Effect.die(
              `The click "${action.description}" retained no keyframe.`
            );
          }
          const image = yield* teachingRecordingTool(
            "agent_teaching_keyframe_get",
            { claimOperationId, keyframeId: keyframe.id, recordingId }
          );
          expect((yield* fileSystem.readFile(image.path)).byteLength).toBe(
            image.bytes
          );
        }
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

/** Controls in control-budget.html, after more controls than one Snapshot reads. */
const BUDGETED_CHECKOUT = { x: 110, y: 420 };
const BUDGETED_FRAME_CHECKOUT = { x: 400, y: 430 };

it.live(
  "records clicks on controls the full Snapshot budget leaves out, with their targets",
  () =>
    Effect.gen(function* teachBudgetedControl() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-control-budget-",
      });
      const fixtures = yield* fixtureServer;

      yield* Effect.gen(function* demonstrate() {
        const framed = yield* fixtures.awaitRequest((url) =>
          url.includes("label=Framed")
        );
        const started = yield* startUserTeaching({
          activity: "teaching",
          clientName: "integration-recorder",
          clientVersion: "1.0.0",
          group: "",
          name: "control-budget",
          operationId: OperationId.make("control-budget-start-session"),
          url: fixtures.url("control-budget.html"),
          viewport,
        });
        const { recordingId } = started;
        if (recordingId === null) {
          return yield* Effect.die("Teaching did not allocate a recording.");
        }
        // One hang guard: a frame that never loads fails here by name.
        yield* Deferred.await(framed).pipe(Effect.timeout("30 seconds"));
        const service = yield* AgentSession;
        const points = [BUDGETED_CHECKOUT, BUDGETED_FRAME_CHECKOUT];
        const inspected = yield* Effect.all(
          points.map(({ x, y }) =>
            service
              .inspectPoint(started.id, x, y)
              .pipe(Effect.map(({ description }) => description))
          )
        );
        expect(inspected).toEqual([
          "button: Checkout",
          "button: Framed checkout",
        ]);
        yield* service.startTeachingRecording(
          started.id,
          OperationId.make("control-budget-start-recording")
        );
        for (const point of points) {
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
          OperationId.make("control-budget-stop-recording")
        );
        const claimOperationId = OperationId.make("control-budget-claim");
        yield* teachingRecordingTool("agent_teaching_recording_claim", {
          action: "take",
          operationId: claimOperationId,
          recordingId,
        });
        const timeline = yield* teachingRecordingTool(
          "agent_teaching_timeline_get",
          { claimOperationId, recordingId }
        );
        // The target is read back from the tree recorded before the click, so
        // a named target proves that tree holds the control.
        expect(
          timeline.entries.flatMap((entry) =>
            entry._tag === "action"
              ? [
                  {
                    description: entry.description,
                    target:
                      entry.target === null
                        ? null
                        : { name: entry.target.name, role: entry.target.role },
                  },
                ]
              : []
          )
        ).toEqual([
          {
            description: 'Click button "Checkout"',
            target: { name: "Checkout", role: "button" },
          },
          {
            description: expect.stringMatching(
              /^Click button "Framed checkout" in frame /u
            ),
            target: { name: "Framed checkout", role: "button" },
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
