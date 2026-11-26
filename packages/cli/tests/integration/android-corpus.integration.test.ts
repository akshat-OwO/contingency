import {
  AgentSessionId,
  AndroidWorkspaceSnapshot,
  FlowName,
  OperationId,
} from "@contingency/protocol";
import type { NativeInput } from "@contingency/protocol";
import { expect } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import {
  ANDROID_WIDGET_APP,
  ANDROID_WIDGET_SCRIPT,
  corpusAndroidSelection,
  makeCorpusAndroidWorkspaceLayer,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";
import { call, journey, scriptedProcess } from "./scripted-agent.ts";

const op = OperationId.make;

const decodeAndroidSnapshot = Schema.decodeUnknownSync(
  AndroidWorkspaceSnapshot
);

const tap = (at: {
  readonly x: number;
  readonly y: number;
}): readonly [NativeInput, ...NativeInput[]] => [
  { _tag: "touch", action: "down", at: 0, x: at.x, y: at.y },
  { _tag: "touch", action: "up", at: 50, x: at.x, y: at.y },
];

const findAndroidNode = (
  snapshot: typeof AndroidWorkspaceSnapshot.Type,
  role: string,
  name: string
) => {
  const node = snapshot.observation?.nodes.find(
    (candidate) => candidate.role === role && candidate.name === name
  );
  if (node === undefined) {
    throw new Error(`Android observation had no ${role} named "${name}".`);
  }
  return node;
};

journey(
  "teaches an Android flow via Forwarded Input, runs a corpus-backed Dry Run, and verifies it",
  { singleTool: true },
  Effect.gen(function* androidBottomSheetJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-android-corpus-",
    });
    const selection = corpusAndroidSelection({
      conditions: [{ name: "SHOW BOTTOM SHEET", role: "button" }],
      outcomes: [{ name: "SHOW BOTTOM SHEET", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: selection.device,
      platform: "android",
      script: ANDROID_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("android-bottom-sheet");

    yield* Effect.gen(function* runAndroidJourney() {
      const workspace = yield* AndroidWorkspace;

      // 1. User opens and prepares a Teaching session, records Forwarded Input
      //    taps across the real widget corpus screens, and stops recording.
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("teach-record-start"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      // Forwarded Input tap on SHOW BOTTOM SHEET transitions controls -> bottom-sheet.
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "SHOW BOTTOM SHEET",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const onSheet = yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: started.id },
        "user"
      );
      expect(
        onSheet.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "CLOSE SHEET"
        )
      ).toBe(true);

      // Forwarded Input tap on CLOSE SHEET transitions bottom-sheet -> controls.
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("bottom-sheet", {
              name: "CLOSE SHEET",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("teach-record-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      // 2. Agent claims the recording, reads the timeline, and saves the Flow.
      const claimOp = op("android-claim");
      yield* call("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOp,
        recordingId,
      });
      const timeline = yield* call("agent_teaching_timeline_get", {
        claimOperationId: claimOp,
        recordingId,
      });
      const actions = timeline.entries
        .filter((entry) => entry._tag === "action")
        .map((entry) => entry.description);
      expect(actions).toContain("Activate button SHOW BOTTOM SHEET");
      expect(actions).toContain("Activate button CLOSE SHEET");

      yield* call("agent_flow_save", {
        claimOperationId: claimOp,
        files: [
          {
            content: [
              "---",
              `name: ${flowName}`,
              "description: Open the bottom sheet and close it again.",
              "inputs:",
              "---",
              "",
              "# Bottom sheet round trip",
              "",
              "1. Activate button SHOW BOTTOM SHEET. Done when: CLOSE SHEET is visible.",
              "2. Activate button CLOSE SHEET. Done when: SHOW BOTTOM SHEET is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "SHOW BOTTOM SHEET", role: "button" }],
          starting: [{ name: "SHOW BOTTOM SHEET", role: "button" }],
        },
        recordingId,
      });

      // 3. Agent starts a Dry Run through `agent_device_workspace`, which
      //    pauses for the user to prepare the device.
      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("dry-start"),
            recordingId,
            selection,
          },
          platform: "android",
        })
      );
      expect(startIntervention.code).toBe("intervention");
      expect(startIntervention.intervention?.reasons).toContain(
        "device_preparation"
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );

      // User prepares the device; fake device resets to `controls`.
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      // 4. Agent reads the initial screen, taps SHOW BOTTOM SHEET -> bottom-sheet,
      //    taps CLOSE SHEET -> controls, completes Dry Run, and verifies Flow.
      const initial = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "android",
        })
      );
      const openButton = findAndroidNode(
        initial,
        "button",
        "SHOW BOTTOM SHEET"
      );
      const opened = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: openButton.target },
            observationId: initial.observation?.id ?? "",
            operationId: op("dry-open-sheet"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      const closeButton = findAndroidNode(opened, "button", "CLOSE SHEET");
      const closed = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: closeButton.target },
            observationId: opened.observation?.id ?? "",
            operationId: op("dry-close-sheet"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(
        closed.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "SHOW BOTTOM SHEET"
        )
      ).toBe(true);

      const completed = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "Opened the bottom sheet and closed it.",
              observationId: closed.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(completed.assessment?.outcome).toBe("working");
      expect(completed.phase).toBe("completed");

      const verified = yield* call("agent_flow_decide", {
        decision: "verify",
        recordingId,
      });
      expect(verified.lifecycle).toBe("verified");
    }).pipe(
      Effect.provide(
        scriptedProcess(root, {
          androidWorkspace: makeCorpusAndroidWorkspaceLayer({
            device,
            root: () => root,
          }),
        })
      ),
      Effect.scoped
    );
  })
);

journey(
  "repairs an Android Capture Gap automatically and still passes the Dry Run (ADR 0084)",
  { singleTool: true },
  Effect.gen(function* androidCaptureGapJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-android-gap-",
    });
    const selection = corpusAndroidSelection({
      conditions: [{ name: "SHOW ALERT", role: "button" }],
      outcomes: [{ name: "REMOVE", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: selection.device,
      platform: "android",
      script: ANDROID_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("android-alert");

    yield* Effect.gen(function* runCaptureGapJourney() {
      const workspace = yield* AndroidWorkspace;

      // Teach controls -> SHOW ALERT -> alert via Forwarded Input.
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("gap-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("gap-teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("gap-teach-record"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "SHOW ALERT",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("gap-teach-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("gap-teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      const claimOp = op("gap-claim");
      yield* call("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOp,
        recordingId,
      });
      yield* call("agent_flow_save", {
        claimOperationId: claimOp,
        files: [
          {
            content: [
              "---",
              `name: ${flowName}`,
              "description: Open the remove confirmation alert.",
              "inputs:",
              "---",
              "",
              "# Open alert",
              "",
              "1. Activate button SHOW ALERT. Done when: REMOVE is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "REMOVE", role: "button" }],
          starting: [{ name: "SHOW ALERT", role: "button" }],
        },
        recordingId,
      });

      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("gap-dry-start"),
            recordingId,
            selection,
          },
          platform: "android",
        })
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("gap-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      const initial = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "android",
        })
      );
      const showAlert = findAndroidNode(initial, "button", "SHOW ALERT");

      // Fail captures with capture_incomplete until automatic recovery runs.
      device.failCapturesUntilRecover();
      const afterAlert = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: showAlert.target },
            observationId: initial.observation?.id ?? "",
            operationId: op("gap-dry-alert"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(device.recoveries()).toBe(1);
      expect(afterAlert.phase).toBe("running");
      expect(afterAlert.captureGaps).toEqual(["capture_incomplete"]);
      expect(afterAlert.captureRepairs).toMatchObject([
        { by: "automatic", code: "capture_incomplete" },
      ]);
      expect(
        afterAlert.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "REMOVE"
        )
      ).toBe(true);

      // A repaired Capture Gap does not stop the Dry Run passing (ADR 0084).
      const completed = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "The alert opened after automatic capture repair.",
              observationId: afterAlert.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("gap-dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(completed.assessment?.outcome).toBe("working");
      expect(completed.phase).toBe("completed");

      const listed = yield* call("agent_teaching_recordings_list", {
        recordingId,
      });
      expect(listed.recordings[0]?.lifecycle).toBe("dry-run-passed");

      const verified = yield* call("agent_flow_decide", {
        decision: "verify",
        recordingId,
      });
      expect(verified.lifecycle).toBe("verified");
    }).pipe(
      Effect.provide(
        scriptedProcess(root, {
          androidWorkspace: makeCorpusAndroidWorkspaceLayer({
            device,
            root: () => root,
          }),
        })
      ),
      Effect.scoped
    );
  })
);

journey(
  "pauses an irreversible Android activate at a Confirmation that a repeated program settles, then refuses and approves it",
  { singleTool: true },
  Effect.gen(function* androidConfirmationJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-android-confirm-",
    });
    const selection = corpusAndroidSelection({
      conditions: [{ name: "SHOW ALERT", role: "button" }],
      outcomes: [{ name: "REMOVE", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: selection.device,
      platform: "android",
      script: ANDROID_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("android-confirm-alert");

    yield* Effect.gen(function* runConfirmationJourney() {
      const workspace = yield* AndroidWorkspace;

      // Teach controls -> SHOW ALERT -> alert via Forwarded Input.
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("confirm-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("confirm-teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("confirm-teach-record"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "SHOW ALERT",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("confirm-teach-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("confirm-teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      const claimOp = op("confirm-claim");
      yield* call("agent_teaching_recording_claim", {
        action: "take",
        operationId: claimOp,
        recordingId,
      });
      yield* call("agent_flow_save", {
        claimOperationId: claimOp,
        files: [
          {
            content: [
              "---",
              `name: ${flowName}`,
              "description: Open the remove confirmation alert.",
              "inputs:",
              "---",
              "",
              "# Open alert",
              "",
              "1. Activate button SHOW ALERT. Done when: REMOVE is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "REMOVE", role: "button" }],
          starting: [{ name: "SHOW ALERT", role: "button" }],
        },
        recordingId,
      });

      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("confirm-dry-start"),
            recordingId,
            selection,
          },
          platform: "android",
        })
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("confirm-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      const initial = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "android",
        })
      );
      const showAlert = findAndroidNode(initial, "button", "SHOW ALERT");
      const activateShowAlert = (operationId: string) =>
        call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: showAlert.target },
            irreversible: true,
            observationId: initial.observation?.id ?? "",
            operationId: op(operationId),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        });
      const listedPending = Effect.map(
        workspace.list(),
        (sessions) =>
          sessions.find(({ id }) => id === dryRunSessionId)?.preparation.pending
      );

      // The first program ends at the new Confirmation. The agent's repeated
      // program settles only because list() carries that Confirmation in
      // preparation.pending, so it reads as one the agent has already seen.
      const pausedForRefusal = decodeAndroidSnapshot(
        yield* activateShowAlert("confirm-dry-refused")
      );
      const refusedDecisionId =
        pausedForRefusal.pendingDecision?.pendingDecisionId ?? "";
      expect(pausedForRefusal.boundary?.reason).toBe("confirmation");
      expect(device.currentCapture()).toBe("controls");
      expect(yield* listedPending).toEqual([
        {
          id: refusedDecisionId,
          kind: "confirmation",
          targetApp: ANDROID_WIDGET_APP,
        },
      ]);

      const afterRefuse = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "decide",
            allow: false,
            decisionId: refusedDecisionId,
            operationId: op("confirm-dry-refuse"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(afterRefuse.pendingDecision).toBeNull();
      expect(device.currentCapture()).toBe("controls");
      expect(yield* listedPending).toEqual([]);

      // A fresh attempt gets a fresh Confirmation; approving it runs the tap.
      const pausedForApproval = decodeAndroidSnapshot(
        yield* activateShowAlert("confirm-dry-approved")
      );
      const approvedDecisionId =
        pausedForApproval.pendingDecision?.pendingDecisionId ?? "";
      expect(approvedDecisionId).not.toBe(refusedDecisionId);
      expect(yield* listedPending).toEqual([
        {
          id: approvedDecisionId,
          kind: "confirmation",
          targetApp: ANDROID_WIDGET_APP,
        },
      ]);

      const afterApprove = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "decide",
            allow: true,
            decisionId: approvedDecisionId,
            operationId: op("confirm-dry-approve"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(afterApprove.pendingDecision).toBeNull();
      expect(device.currentCapture()).toBe("alert");
      expect(yield* listedPending).toEqual([]);

      const onAlert = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "android",
        })
      );
      findAndroidNode(onAlert, "button", "REMOVE");
      const completed = decodeAndroidSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "The confirmed tap opened the remove alert.",
              observationId: onAlert.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("confirm-dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "android",
        })
      );
      expect(completed.assessment?.outcome).toBe("working");
      expect(completed.phase).toBe("completed");
    }).pipe(
      Effect.provide(
        scriptedProcess(root, {
          androidWorkspace: makeCorpusAndroidWorkspaceLayer({
            device,
            root: () => root,
          }),
        })
      ),
      Effect.scoped
    );
  })
);
