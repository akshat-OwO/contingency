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
  IOS_WIDGET_APP,
  IOS_WIDGET_PERMISSION_ALERT,
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
  "reads a system permission alert after observeOnly raises OBSERVATION_UNAVAILABLE, keeping the widget app in front through iosWindowViewport, refusal, and confirmation",
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

      // Teach controls -> Continue -> permission alert over the widget app -> Allow Once -> controls.
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
      expect(device.observeOnlyAlertRefusals()).toBeGreaterThan(0);
      expect(onAlert.observation?.width).toBe(402);
      expect(onAlert.observation?.height).toBe(874);
      const teachingAllowOnce = findIosNode(onAlert, "button", "Allow Once");
      expect(teachingAllowOnce.covered).toBe(false);
      expect(teachingAllowOnce.bounds).toBeDefined();
      expect(
        findIosNode(onAlert, "button", "Allow While Using App").covered
      ).toBe(false);
      expect(findIosNode(onAlert, "button", "Don’t Allow").covered).toBe(false);
      yield* workspace.forward(
        {
          inputs: tap(
            device.controlCenter(IOS_WIDGET_PERMISSION_ALERT, {
              name: "Allow Once",
              role: "button",
            })
          ),
          sessionId: started.id,
        },
        "user"
      );
      const afterAllowTap = yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: started.id },
        "user"
      );
      expect(device.currentCapture()).toBe("controls");
      expect(
        afterAllowTap.observation?.nodes.some(
          (node) => node.role === "button" && node.name === "Continue"
        )
      ).toBe(true);
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
      const timeline = yield* call("agent_teaching_timeline_get", {
        claimOperationId: claimOp,
        recordingId,
      });
      const actions = timeline.entries.filter(
        (entry) => entry._tag === "action"
      );
      expect(actions.map((entry) => entry.description)).toEqual(
        expect.arrayContaining([
          "Activate button Continue",
          "Activate button Allow Once",
        ])
      );
      // iOS presents the alert inside the app that asked, so every observation
      // while it is up still names the widget app as the app in front.
      const openedAlert = actions.find(
        (entry) => entry.description === "Activate button Continue"
      );
      expect(openedAlert?.after.title).toBe(IOS_WIDGET_APP);
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
      const allowOnce = findIosNode(alertScreen, "button", "Allow Once");
      const allowWhileUsing = findIosNode(
        alertScreen,
        "button",
        "Allow While Using App"
      );

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
      expect(device.currentCapture()).toBe(IOS_WIDGET_PERMISSION_ALERT);
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
      expect(device.currentCapture()).toBe(IOS_WIDGET_PERMISSION_ALERT);

      // A fresh irreversible attempt on Allow Once pauses, and approval
      // presses Allow Once by exact label and observed prompt message.
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
              explanation:
                "Answered the system permission alert with Allow Once.",
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

journey(
  "refuses a confirmed iOS permission button when a replacement prompt shares the same label",
  { singleTool: true },
  Effect.gen(function* replacedPermissionPromptJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-ios-replaced-prompt-",
    });
    const selection = corpusIosSelection({
      conditions: [{ name: "Continue", role: "button" }],
      outcomes: [{ name: "Continue", role: "button" }],
    });
    let swapOnNextActivate: string | null = null;
    let swapAfterInitialTitleCheck: string | null = null;
    const device = makeCorpusNativeBackend({
      beforeActivate: () =>
        Effect.sync(() => {
          if (swapOnNextActivate !== null) {
            device.setAlertMessageOverride(swapOnNextActivate);
            swapOnNextActivate = null;
          }
        }),
      device: corpusIosSimulator,
      onAlertPostCheck: () => {
        if (swapAfterInitialTitleCheck !== null) {
          device.setAlertMessageOverride(swapAfterInitialTitleCheck);
          swapAfterInitialTitleCheck = null;
        }
      },
      platform: "ios",
      script: IOS_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("ios-replaced-prompt");
    yield* Effect.gen(function* runReplacedPromptChecks() {
      const workspace = yield* IosWorkspace;

      const taught = yield* workspace.execute(
        {
          _tag: "start",
          flowName,
          kind: "teaching",
          operationId: op("rep-teach-start"),
          recordingId: null,
          selection,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("rep-teach-prepare"),
          sessionId: taught.id,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("rep-teach-record"),
          sessionId: taught.id,
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
          sessionId: taught.id,
        },
        "user"
      );
      yield* workspace.execute(
        { _tag: "observe", image: false, sessionId: taught.id },
        "user"
      );
      const stopped = yield* workspace.execute(
        {
          _tag: "record",
          operationId: op("rep-teach-stop"),
          sessionId: taught.id,
          start: false,
        },
        "user"
      );
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("rep-teach-close"),
          sessionId: taught.id,
        },
        "user"
      );
      const { recordingId } = stopped;
      if (recordingId === null) {
        return yield* Effect.die("Teaching must produce a recording.");
      }
      const claimOp = op("rep-claim");
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
              "description: Confirm permission prompt without answering a replacement prompt.",
              "inputs:",
              "---",
              "",
              "# Replaced prompt guard",
              "",
              "1. Activate button Continue. Done when: the permission alert appears.",
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
            operationId: op("rep-dry-start"),
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
          operationId: op("rep-dry-prepare"),
          sessionId: dryRunSessionId,
        },
        "user"
      );
      const prepared = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "observe",
            image: false,
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      const continueBtn = findIosNode(prepared, "button", "Continue");
      const promptA = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: continueBtn.target },
            observationId: observationIdOf(prepared),
            operationId: op("rep-dry-open-alert"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      const promptAAllowOnce = findIosNode(promptA, "button", "Allow Once");

      // Case 1: Prompt A is replaced by Prompt B (different message, same button
      // label "Allow Once") while waiting for Confirmation. Approval must refuse
      // with a retriable refusal and leave Prompt B untouched.
      const paused = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: promptAAllowOnce.target },
            irreversible: true,
            observationId: observationIdOf(promptA),
            operationId: op("rep-dry-confirm-prompt-a"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      const decisionId = pendingDecisionIdOf(paused);
      const promptBMessage =
        "“Contingency Widgets” Would Like to Access Your Photos";
      device.setAlertMessageOverride(promptBMessage);

      const refusedAcrossConfirm = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "decide",
            allow: true,
            decisionId,
            operationId: op("rep-dry-approve-stale-prompt"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(refusedAcrossConfirm.code).toBe("ios_workspace_refused");
      expect(device.currentCapture()).toBe(IOS_WIDGET_PERMISSION_ALERT);

      // Session stayed running (retriable), so the agent can observe Prompt B.
      const promptB = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "observe",
            image: false,
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(promptB.phase).toBe("running");
      expect(findIosNode(promptB, "alert", promptBMessage).name).toBe(
        promptBMessage
      );
      const promptBAllowOnce = findIosNode(promptB, "button", "Allow Once");

      // Case 2: Prompt B is replaced by Prompt C in the narrow window after
      // pre-dispatch observation and right before `alert press` runs. The
      // runner's expectedMessage guard refuses with ALERT_MISMATCH, surfaced
      // as a retriable refusal while keeping the session running.
      const promptCMessage =
        "“Contingency Widgets” Would Like to Access the Camera";
      swapOnNextActivate = promptCMessage;
      const refusedAtDispatch = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: promptBAllowOnce.target },
            observationId: observationIdOf(promptB),
            operationId: op("rep-dry-dispatch-stale-prompt"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(refusedAtDispatch.code).toBe("ios_workspace_refused");
      expect(device.currentCapture()).toBe(IOS_WIDGET_PERMISSION_ALERT);

      // Session is still running; observe Prompt C.
      const promptC = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "observe",
            image: false,
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(promptC.phase).toBe("running");
      expect(findIosNode(promptC, "alert", promptCMessage).name).toBe(
        promptCMessage
      );
      const promptCAllowOnce = findIosNode(promptC, "button", "Allow Once");

      // Case 3: Prompt C passes the runner's initial expectedMessage check, then
      // is replaced by Prompt D (same button label and frame) during the runner's
      // presentation capture / hittability wait before dispatch. Final pre-dispatch
      // revalidation refuses with ALERT_MISMATCH (dispatched: "no"), leaving the
      // session running and Prompt D untouched.
      const promptDMessage =
        "“Contingency Widgets” Would Like to Access Bluetooth";
      swapAfterInitialTitleCheck = promptDMessage;
      const refusedAtFinalRevalidation = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: promptCAllowOnce.target },
            observationId: observationIdOf(promptC),
            operationId: op("rep-dry-post-check-stale-prompt"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(refusedAtFinalRevalidation.code).toBe("ios_workspace_refused");
      expect(device.currentCapture()).toBe(IOS_WIDGET_PERMISSION_ALERT);

      // Session is still running; observing Prompt D and pressing Allow Once succeeds.
      const promptD = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "observe",
            image: false,
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(promptD.phase).toBe("running");
      expect(findIosNode(promptD, "alert", promptDMessage).name).toBe(
        promptDMessage
      );
      const promptDAllowOnce = findIosNode(promptD, "button", "Allow Once");
      const answered = decodeIosSnapshot(
        yield* call("agent_device_workspace", {
          command: {
            _tag: "input",
            action: { _tag: "activate", target: promptDAllowOnce.target },
            observationId: observationIdOf(promptD),
            operationId: op("rep-dry-answer-prompt-d"),
            sessionId: dryRunSessionId,
          },
          platform: "ios",
        })
      );
      expect(answered.phase).toBe("running");
      expect(device.currentCapture()).toBe("controls");
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
  "reports an unanswered iOS variable-request as an intervention on both Scripted Agent adapters",
  { singleTool: true },
  Effect.gen(function* iosVariableRequestInterventionJourney() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-ios-var-req-",
    });
    const selection = corpusIosSelection();
    const device = makeCorpusNativeBackend({
      device: corpusIosSimulator,
      platform: "ios",
      script: IOS_WIDGET_SCRIPT,
    });
    const flowName = FlowName.make("ios-var-req");

    yield* Effect.gen(function* runVariableRequestJourney() {
      const workspace = yield* IosWorkspace;
      const startIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "start",
            agentSetup: true,
            flowName,
            kind: "teaching",
            operationId: op("ios-var-start"),
            recordingId: null,
            selection,
          },
          platform: "ios",
        })
      );
      expect(startIntervention.code).toBe("intervention");
      const sessionId = AgentSessionId.make(
        startIntervention.intervention?.sessionId ?? ""
      );
      yield* workspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-var-prepare"),
          sessionId,
        },
        "user"
      );

      // An unanswered variable-request stays an intervention after retry on
      // both in-process and MCP HTTP adapters.
      const variableIntervention = yield* Effect.flip(
        call("agent_device_workspace", {
          command: {
            _tag: "variable-request",
            name: "PIN",
            operationId: op("ios-var-request"),
            purpose: "Sign in before Teaching starts.",
            replace: false,
            sessionId,
          },
          platform: "ios",
        })
      );
      expect(variableIntervention.code).toBe("intervention");
      expect(variableIntervention.intervention?.sessionId).toBe(sessionId);
      expect(variableIntervention.intervention?.reasons).toContain(
        "variable_requested"
      );

      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("ios-var-close"),
          sessionId,
        },
        "user"
      );
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
