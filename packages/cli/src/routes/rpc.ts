import {
  ContingencyRpcs,
  makeBrowserRpcError,
  recordingLocksStorageMutations,
  recordingMakesBrowserInputReadOnly,
  STORAGE_LOCKED_MESSAGE,
} from "@contingency/protocol";
import type { RecordingSnapshot } from "@contingency/protocol";
import { Effect, Layer, Stream } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { AgentBrowser } from "../services/agent-browser";
import { Recording } from "../services/recording";

const toRecordingResult = (recording: RecordingSnapshot) => ({
  data: { recording },
  type: "recording.result" as const,
});

export const browserInputIsReadOnly = (
  snapshot: Pick<
    RecordingSnapshot,
    "captureMode" | "phase" | "sessionId"
  > | null,
  sessionId: string
): boolean =>
  snapshot?.sessionId === sessionId &&
  recordingMakesBrowserInputReadOnly(snapshot);

export const RpcHandlersLive = ContingencyRpcs.toLayer(
  Effect.gen(function* makeRpcHandlers() {
    const agentBrowser = yield* AgentBrowser;
    const recording = yield* Recording;

    const requireBrowserControl = (sessionId: string, control: string) =>
      recording
        .get()
        .pipe(
          Effect.flatMap((snapshot) =>
            snapshot !== null &&
            snapshot.sessionId === sessionId &&
            (snapshot.phase === "active" || snapshot.phase === "paused")
              ? Effect.fail(
                  makeBrowserRpcError(
                    "recording_conflict",
                    `${control} is locked while this Recording is in progress.`
                  )
                )
              : Effect.void
          )
        );

    const requireStorageMutation = (sessionId: string) =>
      recording
        .get()
        .pipe(
          Effect.flatMap((snapshot) =>
            recordingLocksStorageMutations(snapshot, sessionId)
              ? Effect.fail(
                  makeBrowserRpcError(
                    "recording_conflict",
                    STORAGE_LOCKED_MESSAGE
                  )
                )
              : Effect.void
          )
        );

    // Handlers stay grouped by browser and Recording lifecycle operations.
    // oxlint-disable-next-line eslint/sort-keys
    return {
      "browser.frame.ack": ({ data }) =>
        agentBrowser
          .acknowledgeFrame(data.sessionId, data.seq, data.streamId)
          .pipe(Effect.as({ data: {}, type: "browser.frame.acked" as const })),
      "browser.input.send": ({ data }) =>
        Effect.gen(function* sendBrowserInput() {
          const snapshot = yield* recording.get();
          if (browserInputIsReadOnly(snapshot, data.sessionId)) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "recording_conflict",
                snapshot?.phase === "incomplete"
                  ? "The browser canvas is read-only because this Recording is incomplete. Recover or discard it to continue."
                  : "The browser canvas is read-only while Recording is paused."
              )
            );
          }
          yield* agentBrowser.sendInput(data.sessionId, data.input);
          return { data: {}, type: "browser.input.sent" as const };
        }),
      "browser.navigation.run": ({ data }) =>
        Effect.gen(function* navigateBrowser() {
          yield* agentBrowser.navigate(data.sessionId, data.action);
          const snapshot = yield* recording.get();
          if (
            snapshot !== null &&
            snapshot.sessionId === data.sessionId &&
            snapshot.phase === "active"
          ) {
            const url = yield* agentBrowser.currentUrl(data.sessionId);
            yield* recording.recordNavigation(url);
          }
          return {
            data: {},
            type: "browser.navigation.completed" as const,
          };
        }),
      "browser.network.request.get": ({ data }) =>
        agentBrowser
          .getNetworkRequest(data.sessionId, data.tabId, data.requestId)
          .pipe(
            Effect.map((request) => ({
              data: { request },
              type: "browser.network.request.result" as const,
            }))
          ),
      "browser.network.requests.get": ({ data }) =>
        agentBrowser.getNetworkRequests(data.sessionId, data.tabId).pipe(
          Effect.map((requests) => ({
            data: { requests },
            type: "browser.network.requests.result" as const,
          }))
        ),
      "browser.storage.clear": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(
            agentBrowser.clearStorage(data.sessionId, data.tabId, data.kind)
          ),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.delete": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(
            agentBrowser.deleteStorage(data.sessionId, data.tabId, data)
          ),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.storage.get": ({ data }) =>
        agentBrowser.getStorage(data.sessionId, data.tabId, data.kind).pipe(
          Effect.map((snapshot) => ({
            data: { snapshot },
            type: "browser.storage.result" as const,
          }))
        ),
      "browser.storage.set": ({ data }) =>
        requireStorageMutation(data.sessionId).pipe(
          Effect.andThen(
            agentBrowser.setStorage(data.sessionId, data.tabId, data)
          ),
          Effect.as({ data: {}, type: "browser.storage.updated" as const })
        ),
      "browser.open": ({ data }) =>
        agentBrowser
          .open(data.sessionId, data.url, data.viewport, data.userAgentProfile)
          .pipe(
            Effect.tap(({ sessionId, url }) =>
              recording
                .get()
                .pipe(
                  Effect.flatMap((snapshot) =>
                    snapshot !== null &&
                    snapshot.sessionId === sessionId &&
                    snapshot.phase === "active"
                      ? recording.recordNavigation(url)
                      : Effect.void
                  )
                )
            ),
            Effect.map(({ sessionId, url }) => ({
              data: { sessionId, url },
              type: "browser.opened" as const,
            }))
          ),
      "browser.session.attach": ({ data }) =>
        agentBrowser.currentUrl(data.sessionId).pipe(
          Effect.map((url) => ({
            data: { sessionId: data.sessionId, url },
            type: "browser.session.attached" as const,
          }))
        ),
      "browser.session.close": ({ data }) =>
        Effect.gen(function* closeBrowserSession() {
          const snapshot = yield* recording.get();
          if (snapshot?.sessionId === data.sessionId) {
            yield* recording.fail("The pinned browser session was closed.");
          }
          yield* agentBrowser.close(data.sessionId);
          return { data: {}, type: "browser.session.closed" as const };
        }),
      "browser.session.create": ({ data }) =>
        agentBrowser.create(data.name, data.viewport).pipe(
          Effect.map((sessionId) => ({
            data: { sessionId },
            type: "browser.session.created" as const,
          }))
        ),
      "browser.sessions.get": () =>
        agentBrowser.list().pipe(
          Effect.map((sessions) => ({
            data: {
              sessions: sessions.map((id) => ({ id, selected: false })),
            },
            type: "browser.sessions.result" as const,
          }))
        ),
      "browser.stream.subscribe": ({ data }) =>
        Stream.unwrap(
          agentBrowser
            .attach(data.sessionId)
            .pipe(Effect.map(() => agentBrowser.stream(data.sessionId)))
        ),
      "browser.tab.close": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(agentBrowser.closeTab(data.sessionId, data.tabId)),
          Effect.as({ data: {}, type: "browser.tab.closed" as const })
        ),
      "browser.tab.new": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(agentBrowser.newTab(data.sessionId)),
          Effect.as({ data: {}, type: "browser.tab.created" as const })
        ),
      "browser.tab.switch": ({ data }) =>
        requireBrowserControl(data.sessionId, "Tab changes").pipe(
          Effect.andThen(agentBrowser.switchTab(data.sessionId, data.tabId)),
          Effect.as({ data: {}, type: "browser.tab.switched" as const })
        ),
      "browser.tabs.get": ({ data }) =>
        agentBrowser.getTabs(data.sessionId).pipe(
          Effect.map((tabs) => ({
            data: { tabs },
            type: "browser.tabs.result" as const,
          }))
        ),
      "browser.user-agent.set": ({ data }) =>
        requireBrowserControl(data.sessionId, "User agent changes").pipe(
          Effect.andThen(
            agentBrowser.setUserAgent(
              data.sessionId,
              data.url,
              data.viewport,
              data.userAgentProfile
            )
          ),
          Effect.map(({ url }) => ({
            data: { url, userAgentProfile: data.userAgentProfile },
            type: "browser.user-agent.updated" as const,
          }))
        ),
      "browser.viewport.set": ({ data }) =>
        requireBrowserControl(data.sessionId, "Viewport changes").pipe(
          Effect.andThen(
            agentBrowser.setViewport(data.sessionId, data.viewport)
          ),
          Effect.as({
            data: { viewport: data.viewport },
            type: "browser.viewport.updated" as const,
          })
        ),
      "recording.capture.cancel": () =>
        recording.cancelCaptureMode().pipe(Effect.map(toRecordingResult)),
      "recording.discard": () =>
        recording
          .discard()
          .pipe(Effect.as({ data: {}, type: "recording.discarded" as const })),
      "recording.finish": () =>
        recording.finish().pipe(Effect.map(toRecordingResult)),
      "recording.get": () =>
        recording.get().pipe(
          Effect.map((snapshot) => ({
            data: { recording: snapshot },
            type: "recording.result" as const,
          }))
        ),
      "recording.pause": () =>
        recording.pause().pipe(Effect.map(toRecordingResult)),
      "recording.pre-step.arm": ({ data }) =>
        recording
          .armPreStep(
            data.scope === "flow"
              ? { type: "flow" }
              : { stepId: data.stepId, type: "step" }
          )
          .pipe(Effect.map(toRecordingResult)),
      "recording.pre-step.condition.arm": ({ data }) =>
        recording
          .armPreStepCondition(
            data.scope === "flow"
              ? { index: data.index, type: "flow" }
              : {
                  index: data.index,
                  stepId: data.stepId,
                  type: "step",
                }
          )
          .pipe(Effect.map(toRecordingResult)),
      "recording.resume": () =>
        recording.resume().pipe(Effect.map(toRecordingResult)),
      "recording.recover": () =>
        Effect.gen(function* recoverRecording() {
          const snapshot = yield* recording.get();
          if (snapshot === null || snapshot.phase !== "incomplete") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "recording_invalid",
                "Only an incomplete Recording can be recovered."
              )
            );
          }
          const { sessionId } = snapshot;
          const tabs = yield* agentBrowser.getTabs(sessionId);
          const pinnedTab = tabs.find(({ tabId }) => tabId === snapshot.tabId);
          if (pinnedTab === undefined) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "recording_unavailable",
                "The pinned browser tab is no longer available."
              )
            );
          }
          if (!pinnedTab.active) {
            yield* agentBrowser.switchTab(sessionId, pinnedTab.tabId);
          }
          yield* agentBrowser.navigate(sessionId, "reload");
          const currentUrl = yield* agentBrowser.currentUrl(sessionId);
          const recovered = yield* recording.recover(currentUrl);
          return toRecordingResult(recovered);
        }),
      "recording.start": ({ data }) =>
        Effect.gen(function* startRecording() {
          const [initialUrl, tabs] = yield* Effect.all([
            agentBrowser.currentUrl(data.sessionId),
            agentBrowser.getTabs(data.sessionId),
          ]);
          const activeTab = tabs.find(({ active }) => active);
          if (activeTab === undefined) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "recording_unavailable",
                "The browser session has no active tab."
              )
            );
          }
          const snapshot = yield* recording.start({
            initialUrl,
            sessionId: data.sessionId,
            tabId: activeTab.tabId,
            title: data.title,
          });
          return toRecordingResult(snapshot);
        }),
      "recording.audit.add": ({ data }) =>
        recording.addAudit(data.audit).pipe(Effect.map(toRecordingResult)),
      "recording.step.secret.bind": ({ data }) =>
        recording
          .bindSecret(data.stepId, data.name)
          .pipe(Effect.map(toRecordingResult)),
      "recording.secret.rename": ({ data }) =>
        recording
          .renameSecret(data.from, data.name)
          .pipe(Effect.map(toRecordingResult)),
      "recording.step.delete": ({ data }) =>
        recording.deleteStep(data.stepId).pipe(Effect.map(toRecordingResult)),
      "recording.step.undo": () =>
        recording.undoDelete().pipe(Effect.map(toRecordingResult)),
      "recording.stream.subscribe": () => recording.stream(),
      "recording.title.update": ({ data }) =>
        recording.updateTitle(data.title).pipe(Effect.map(toRecordingResult)),
    };
  })
);

const makeOriginMiddleware = (allowedOrigins: ReadonlySet<string>) =>
  HttpRouter.middleware(
    Effect.succeed((httpEffect) =>
      Effect.gen(function* validateRpcOrigin() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { origin } = request.headers;

        return origin !== undefined && allowedOrigins.has(origin)
          ? yield* httpEffect
          : HttpServerResponse.empty({ status: 403 });
      })
    )
  ).layer;

export interface RpcRoutesOptions {
  readonly allowedOrigins: ReadonlySet<string>;
}

export const makeRpcRoutes = ({ allowedOrigins }: RpcRoutesOptions) =>
  RpcServer.layerHttp({
    group: ContingencyRpcs,
    path: "/ws",
  }).pipe(
    Layer.provide(RpcHandlersLive),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(makeOriginMiddleware(allowedOrigins))
  );
