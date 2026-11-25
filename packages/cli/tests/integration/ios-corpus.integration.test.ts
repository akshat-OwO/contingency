import {
  AgentSessionId,
  FlowName,
  IosWorkspaceSnapshot,
  OperationId,
} from "@contingency/protocol";
import type { NativeInput } from "@contingency/protocol";
import { expect } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import {
  IOS_WIDGET_SCRIPT,
  corpusIosSelection,
  corpusIosSimulator,
  makeCorpusIosWorkspaceLayer,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";
import { call, journey, scriptedProcess } from "./scripted-agent.ts";

const op = OperationId.make;

const decodeIosSnapshot = Schema.decodeUnknownSync(IosWorkspaceSnapshot);

const tap = (at: {
  readonly x: number;
  readonly y: number;
}): readonly [NativeInput, ...NativeInput[]] => [
  { _tag: "touch", action: "down", at: 0, x: at.x, y: at.y },
  { _tag: "touch", action: "up", at: 50, x: at.x, y: at.y },
];

const findIosNode = (
  snapshot: typeof IosWorkspaceSnapshot.Type,
  role: string,
  name: string
) => {
  const node = snapshot.observation?.nodes.find(
    (candidate) => candidate.role === role && candidate.name === name
  );
  if (node === undefined) {
    throw new Error(`iOS observation had no ${role} named "${name}".`);
  }
  return node;
};

const observationIdOf = (snapshot: typeof IosWorkspaceSnapshot.Type) => {
  const id = snapshot.observation?.id;
  if (id === undefined) {
    throw new Error("Expected an observation on the iOS workspace snapshot.");
  }
  return id;
};

const pendingDecisionIdOf = (snapshot: typeof IosWorkspaceSnapshot.Type) => {
  const id = snapshot.pendingDecision?.pendingDecisionId;
  if (id === undefined) {
    throw new Error(
      "Expected a pendingDecision on the iOS workspace snapshot."
    );
  }
  return id;
};

journey(
  "teaches an iOS flow via Forwarded Input, runs a corpus-backed Dry Run, and verifies it",
  { singleTool: true },
  Effect.gen(function* iosActionSheetJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-ios-corpus-",
    });
    const selection = corpusIosSelection({
      conditions: [{ name: "Show action sheet", role: "button" }],
      outcomes: [{ name: "Show action sheet", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: corpusIosSimulator,
      platform: "ios",
      script: IOS_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("ios-action-sheet");

    yield* Effect.gen(function* runIosJourney() {
      const workspace = yield* IosWorkspace;

      // 1. User opens and prepares Teaching, taps Show action sheet -> Cancel
      //    through Forwarded Input, and stops recording.
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("ios-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("ios-teach-record-start"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "Show action sheet",
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
          (node) => node.role === "button" && node.name === "Copy link"
        )
      ).toBe(true);

      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("action-sheet", {
              name: "Cancel",
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
          operationId: op("ios-teach-record-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("ios-teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      // 2. Agent claims the recording, reads the timeline, and saves the Flow.
      const claimOp = op("ios-claim");
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
      expect(actions).toContain("Activate button Show action sheet");
      expect(actions).toContain("Activate button Cancel");

      yield* call("agent_flow_save", {
        claimOperationId: claimOp,
        files: [
          {
            content: [
              "---",
              `name: ${flowName}`,
              "description: Open the action sheet and cancel it.",
              "inputs:",
              "---",
              "",
              "# Action sheet round trip",
              "",
              "1. Activate button Show action sheet. Done when: Copy link is visible.",
              "2. Activate button Cancel. Done when: Show action sheet is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "Show action sheet", role: "button" }],
          starting: [{ name: "Show action sheet", role: "button" }],
        },
        recordingId,
      });

      // 3. Agent starts a Dry Run via `agent_device_workspace`, pausing for
      //    user preparation.
      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("ios-dry-start"),
            recordingId,
            selection,
          },
          platform: "ios",
        })
      );
      expect(startIntervention.code).toBe("intervention");
      expect(startIntervention.intervention?.reasons).toContain(
        "device_preparation"
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );

      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      // 4. Agent taps Show action sheet -> Cancel, completes Dry Run, verifies.
      const initial = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "ios",
        })
      );
      const openSheet = findIosNode(initial, "button", "Show action sheet");
      const opened = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: openSheet.target },
            observationId: initial.observation?.id ?? "",
            operationId: op("ios-dry-open-sheet"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      const cancelSheet = findIosNode(opened, "button", "Cancel");
      const closed = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: cancelSheet.target },
            observationId: opened.observation?.id ?? "",
            operationId: op("ios-dry-cancel-sheet"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(
        closed.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "Show action sheet"
        )
      ).toBe(true);

      const completed = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "Opened the action sheet and cancelled it.",
              observationId: closed.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("ios-dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
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
          iosWorkspace: makeCorpusIosWorkspaceLayer({
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
  "repairs an iOS Capture Gap automatically and still passes the Dry Run (ADR 0084)",
  { singleTool: true },
  Effect.gen(function* iosCaptureGapJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-ios-gap-",
    });
    const selection = corpusIosSelection({
      conditions: [{ name: "Show alert", role: "button" }],
      outcomes: [{ name: "Remove", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: corpusIosSimulator,
      platform: "ios",
      script: IOS_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("ios-alert");

    yield* Effect.gen(function* runIosGapJourney() {
      const workspace = yield* IosWorkspace;

      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("ios-gap-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-gap-teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("ios-gap-teach-record"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "Show alert",
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
          operationId: op("ios-gap-teach-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("ios-gap-teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      const claimOp = op("ios-gap-claim");
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
              "description: Open the remove confirmation alert on iOS.",
              "inputs:",
              "---",
              "",
              "# Open alert",
              "",
              "1. Activate button Show alert. Done when: Remove is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "Remove", role: "button" }],
          starting: [{ name: "Show alert", role: "button" }],
        },
        recordingId,
      });

      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("ios-gap-dry-start"),
            recordingId,
            selection,
          },
          platform: "ios",
        })
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-gap-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      const initial = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "ios",
        })
      );
      const showAlert = findIosNode(initial, "button", "Show alert");

      device.failCapturesUntilRecover();
      const afterAlert = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: showAlert.target },
            observationId: initial.observation?.id ?? "",
            operationId: op("ios-gap-dry-alert"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
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
          (node) => node.role === "button" && node.name === "Remove"
        )
      ).toBe(true);

      const completed = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "The iOS alert opened after automatic repair.",
              observationId: afterAlert.observation?.id ?? "",
              outcome: "working",
            },
            operationId: op("ios-gap-dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
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
          iosWorkspace: makeCorpusIosWorkspaceLayer({
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
  "handles an iOS system permission alert through iosWindowViewport, refusal, and confirmation",
  { singleTool: true },
  Effect.gen(function* iosSystemPermissionAlertJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-ios-permission-",
    });
    const selection = corpusIosSelection({
      conditions: [{ name: "Continue", role: "button" }],
      outcomes: [{ name: "Continue", role: "button" }],
    });
    const device = makeCorpusNativeBackend({
      device: corpusIosSimulator,
      platform: "ios",
      script: IOS_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("ios-permission-alert");

    yield* Effect.gen(function* runPermissionJourney() {
      const workspace = yield* IosWorkspace;

      // Teach controls -> Continue -> system-permission-alert -> Allow Once -> controls.
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("perm-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("perm-teach-prepare"),
          sessionId: started.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("perm-teach-record"),
          sessionId: started.id,
          start: true,
        },
        "user"
      );
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter("controls", {
              name: "Continue",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const onAlert = yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: started.id },
        "user"
      );
      expect(onAlert.observation?.width).toBe(402);
      expect(onAlert.observation?.height).toBe(874);
      const allowOnceNode = findIosNode(onAlert, "button", "Allow Once");
      if (allowOnceNode.bounds === undefined) {
        return yield* Effect.die("Expected bounds on Allow Once.");
      }
      yield* workspace.forward(
        {
          inputs: tap({
            x: (allowOnceNode.bounds.x + allowOnceNode.bounds.width / 2) / 402,
            y: (allowOnceNode.bounds.y + allowOnceNode.bounds.height / 2) / 874,
          }),
          sessionId: started.id,
        },
        "user"
      );
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("perm-teach-stop"),
          sessionId: started.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("perm-teach-close"),
          sessionId: started.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }

      const claimOp = op("perm-claim");
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
              "description: Continue past the location permission alert.",
              "inputs:",
              "---",
              "",
              "# Permission alert",
              "",
              "1. Activate button Continue. Done when: the location permission alert appears.",
              "2. Confirm and activate button Allow Once. Done when: Continue is visible.",
              "",
            ].join("\n"),
            path: "flow.md",
          },
        ],
        nativeConditions: {
          outcomes: [{ name: "Continue", role: "button" }],
          starting: [{ name: "Continue", role: "button" }],
        },
        recordingId,
      });

      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            flowName,
            kind: "dry-run",
            operationId: op("perm-dry-start"),
            recordingId,
            selection,
          },
          platform: "ios",
        })
      );
      const dryRunSessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("perm-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );

      const initial = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: { _tag: "read", sessionId: dryRunSessionId },
          platform: "ios",
        })
      );
      const continueBtn = findIosNode(initial, "button", "Continue");
      const alertScreen = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: continueBtn.target },
            observationId: observationIdOf(initial),
            operationId: op("perm-dry-open-alert"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      // The real iosWindowViewport keeps the 402x874 window around the 320x326 system alert.
      expect(alertScreen.observation?.width).toBe(402);
      expect(alertScreen.observation?.height).toBe(874);
      const alertObservationId = observationIdOf(alertScreen);
      const allowWhileUsing = findIosNode(
        alertScreen,
        "button",
        "Allow While Using App"
      );
      const allowOnce = findIosNode(alertScreen, "button", "Allow Once");

      // Action policy refuses filling a non-editable permission button.
      const refusedFill = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: {
              _tag: "fill",
              target: allowOnce.target,
              text: "not-editable",
            },
            observationId: alertObservationId,
            operationId: op("perm-dry-refuse-fill"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(refusedFill.code).toBe("ios_workspace_refused");

      // Irreversible permission grant pauses at the confirmation boundary.
      const pausedForConfirm = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: allowWhileUsing.target },
            irreversible: true,
            observationId: alertObservationId,
            operationId: op("perm-dry-grant-while-using"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(device.currentCapture()).toBe("system-permission-alert");
      const refusedDecisionId = pendingDecisionIdOf(pausedForConfirm);

      // Refusing the confirmation leaves the permission alert on screen.
      const afterRefuse = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "decide",
            allow: false,
            decisionId: refusedDecisionId,
            operationId: op("perm-dry-refuse-decision"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(afterRefuse.pendingDecision).toBeNull();
      expect(device.currentCapture()).toBe("system-permission-alert");

      // A fresh irreversible attempt on Allow Once pauses, and approval dismisses the alert.
      const pausedAllowOnce = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: allowOnce.target },
            irreversible: true,
            observationId: alertObservationId,
            operationId: op("perm-dry-allow-once"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      const approveDecisionId = pendingDecisionIdOf(pausedAllowOnce);

      const afterApprove = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "decide",
            allow: true,
            decisionId: approveDecisionId,
            operationId: op("perm-dry-approve-decision"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(afterApprove.pendingDecision).toBeNull();
      expect(device.currentCapture()).toBe("controls");
      expect(
        afterApprove.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "Continue"
        )
      ).toBe(true);

      const completed = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "complete",
            assessment: {
              explanation: "Dismissed the system permission alert cleanly.",
              observationId: observationIdOf(afterApprove),
              outcome: "working",
            },
            operationId: op("perm-dry-complete"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(completed.assessment?.outcome).toBe("working");
      expect(completed.phase).toBe("completed");
      const listed = yield* call("agent_teaching_recordings_list", {
        recordingId,
      });
      expect(listed.recordings[0]?.lifecycle).toBe("dry-run-passed");
    }).pipe(
      Effect.provide(
        scriptedProcess(root, {
          iosWorkspace: makeCorpusIosWorkspaceLayer({
            device,
            root: () => root,
          }),
        })
      ),
      Effect.scoped
    );
  })
);
