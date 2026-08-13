import { randomUUID } from "node:crypto";
import path from "node:path";

import { makeBrowserRpcError } from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { AgentBrowser } from "./agent-browser";
import type {
  RecorderCapture,
  RecorderCaptureEvent,
  RecorderCaptureStartOptions,
} from "./recording";
import { makeRecordingService, Recording } from "./recording";

const MAX_BINDING_PAYLOAD_BYTES = 64 * 1024;
const MAX_EVENTS_PER_SECOND = 200;
const MAX_SELECTOR_ALTERNATIVES = 8;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_SHADOW_SEGMENTS = 16;
const MAX_VALUE_LENGTH = 16 * 1024;
const RECORDER_CLEANUP_EXPRESSION =
  "globalThis.__contingencyRecorderCleanup?.()";

const BoundedString = Schema.String.check(
  Schema.isMaxLength(MAX_SELECTOR_LENGTH)
);
const BoundedSelector = Schema.Array(
  Schema.Union([
    BoundedString,
    Schema.Array(BoundedString).check(Schema.isMaxLength(MAX_SHADOW_SEGMENTS)),
  ])
).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SELECTOR_ALTERNATIVES));

const SelectorTargetFields = {
  selectors: BoundedSelector,
};

const ClickCapture = Schema.Struct({
  ...SelectorTargetFields,
  button: Schema.optional(BoundedString),
  offsetX: Schema.Finite,
  offsetY: Schema.Finite,
  type: Schema.Literal("click"),
});

const ChangeCapture = Schema.Struct({
  secretVariable: Schema.optional(Schema.String),
  selectors: BoundedSelector,
  type: Schema.Literal("change"),
  value: Schema.String.check(Schema.isMaxLength(MAX_VALUE_LENGTH)),
});

const KeyCapture = Schema.Struct({
  ...SelectorTargetFields,
  key: Schema.String.check(Schema.isMaxLength(64)),
  type: Schema.Literals(["keyDown", "keyUp"]),
});

const BindingCapture = Schema.Struct({
  event: Schema.Union([
    ClickCapture,
    ChangeCapture,
    KeyCapture,
    Schema.Struct({ type: Schema.Literal("beforeUnload") }),
    Schema.Struct({
      reason: Schema.String.check(Schema.isMaxLength(512)),
      type: Schema.Literal("unsupported"),
    }),
  ]),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
});

interface CdpEvent {
  readonly method: string;
  readonly params?: unknown;
  readonly sessionId?: string;
}

interface CdpResponse {
  readonly error?: { readonly message?: string } | undefined;
  readonly id: number;
  readonly result?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const recorderError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("recording_unavailable", message);

export const selectRecorderTarget = (
  targetInfos: readonly unknown[],
  requestedTabId: string,
  isFocused: (targetId: string) => Effect.Effect<boolean, BrowserRpcErrorType>
): Effect.Effect<string, BrowserRpcErrorType> =>
  Effect.gen(function* resolveRecorderTarget() {
    const pageTargetIds = targetInfos.flatMap((target) =>
      isRecord(target) &&
      target.type === "page" &&
      typeof target.targetId === "string"
        ? [target.targetId]
        : []
    );
    if (pageTargetIds.includes(requestedTabId)) {
      return requestedTabId;
    }

    const focusedTargetIds: string[] = [];
    for (const targetId of pageTargetIds) {
      if (yield* isFocused(targetId)) {
        focusedTargetIds.push(targetId);
      }
    }
    const [focusedTargetId] = focusedTargetIds;
    if (focusedTargetIds.length === 1 && focusedTargetId !== undefined) {
      return focusedTargetId;
    }
    return yield* Effect.fail(
      recorderError(
        focusedTargetIds.length === 0
          ? "The active browser tab could not be resolved."
          : "Multiple browser tabs reported themselves as active."
      )
    );
  });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const recorderAssetPath = (): string => {
  const moduleDirectory = import.meta.dirname;
  const packageDirectory =
    path.basename(moduleDirectory) === "dist"
      ? path.dirname(moduleDirectory)
      : path.resolve(moduleDirectory, "../..");
  return path.join(packageDirectory, "assets", "recorder", "injected.js");
};

const openWebSocket = (
  url: string
): Effect.Effect<WebSocket, BrowserRpcErrorType> =>
  Effect.callback((resume) => {
    const socket = new WebSocket(url);
    const handleOpen = () => {
      // oxlint-disable-next-line eslint/no-use-before-define
      cleanup();
      resume(Effect.succeed(socket));
    };
    const handleError = () => {
      // oxlint-disable-next-line eslint/no-use-before-define
      cleanup();
      socket.close();
      resume(
        Effect.fail(
          recorderError("Unable to connect to the browser recorder endpoint.")
        )
      );
    };
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
    };
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    return Effect.sync(() => {
      cleanup();
      socket.close();
    });
  });

interface CdpConnection {
  readonly close: Effect.Effect<void>;
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string
  ) => Effect.Effect<unknown, BrowserRpcErrorType>;
}

export const makeCdpConnection = (
  socket: WebSocket,
  onEvent: (event: CdpEvent) => void,
  onClose: () => void
): CdpConnection => {
  let nextId = 1;
  const pending = new Map<number, (response: CdpResponse) => void>();

  const handleMessage = (message: MessageEvent) => {
    if (typeof message.data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    if (typeof parsed.id === "number") {
      const parsedError = parsed.error;
      const parsedErrorMessage = isRecord(parsedError)
        ? asString(parsedError.message)
        : undefined;
      const response: CdpResponse = {
        ...(isRecord(parsedError)
          ? {
              error:
                parsedErrorMessage === undefined
                  ? {}
                  : { message: parsedErrorMessage },
            }
          : {}),
        id: parsed.id,
        ...(Object.hasOwn(parsed, "result") ? { result: parsed.result } : {}),
      };
      const complete = pending.get(response.id);
      pending.delete(response.id);
      complete?.(response);
      return;
    }
    if (typeof parsed.method === "string") {
      const sessionId = asString(parsed.sessionId);
      onEvent({
        method: parsed.method,
        ...(isRecord(parsed.params) ? { params: parsed.params } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
  };
  const failPending = () => {
    for (const [id, complete] of pending) {
      complete({ error: { message: "Recorder connection closed." }, id });
    }
    pending.clear();
  };
  const handleClose = () => {
    failPending();
    onClose();
  };
  socket.addEventListener("message", handleMessage);
  socket.addEventListener("close", handleClose);

  const send: CdpConnection["send"] = (method, params, sessionId) =>
    Effect.callback((resume) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, (response) => {
        if (response.error !== undefined) {
          resume(
            Effect.fail(
              recorderError(
                response.error.message ?? `CDP command ${method} failed.`
              )
            )
          );
          return;
        }
        resume(Effect.succeed(response.result));
      });
      try {
        socket.send(
          JSON.stringify({
            id,
            method,
            params: params ?? {},
            ...(sessionId === undefined ? {} : { sessionId }),
          })
        );
      } catch (error) {
        pending.delete(id);
        resume(Effect.fail(recorderError(errorMessage(error))));
      }
      return Effect.sync(() => {
        pending.delete(id);
      });
    });

  return {
    close: Effect.sync(() => {
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
      failPending();
      socket.close();
    }),
    send,
  };
};

const responseField = (
  value: unknown,
  field: string
): Record<string, unknown> | undefined => {
  if (!isRecord(value) || !isRecord(value[field])) {
    return undefined;
  }
  return value[field];
};

interface FrameEntry {
  readonly frameId: string;
  readonly path: readonly number[];
}

const frameEntries = (frameTree: unknown): readonly FrameEntry[] => {
  const result: FrameEntry[] = [];
  const visit = (value: unknown, framePath: readonly number[]) => {
    if (!isRecord(value)) {
      return;
    }
    const { frame } = value;
    if (isRecord(frame)) {
      const frameId = asString(frame.id);
      if (frameId !== undefined) {
        result.push({ frameId, path: framePath });
      }
    }
    const children = value.childFrames;
    if (Array.isArray(children)) {
      for (const [index, child] of children.entries()) {
        visit(child, [...framePath, index]);
      }
    }
  };
  visit(frameTree, []);
  return result;
};

const buildInjectedSource = (source: string, bindingName: string): string =>
  source.replace("__CONTINGENCY_BINDING__", bindingName);

const makeCdpCapture = Effect.gen(function* makeCdpCapture() {
  const agentBrowser = yield* AgentBrowser;
  const fileSystem = yield* FileSystem.FileSystem;
  const injectedTemplate = yield* fileSystem
    .readFileString(recorderAssetPath())
    .pipe(
      Effect.mapError((cause) =>
        recorderError(`Unable to load recorder bundle: ${errorMessage(cause)}`)
      )
    );

  const start = Effect.fn("CdpRecorder.start")(function* startCapture(
    options: RecorderCaptureStartOptions
  ) {
    const cdpUrl = yield* agentBrowser.cdpUrl(options.sessionId);
    const socket = yield* openWebSocket(cdpUrl);
    const worldName = `contingency-recorder-${randomUUID()}`;
    const bindingName = `__contingency_${randomUUID().replaceAll("-", "")}`;
    const injectedSource = buildInjectedSource(injectedTemplate, bindingName);
    const contextFrames = new Map<
      string,
      { readonly frameId: string; readonly path: readonly number[] }
    >();
    const framePaths = new Map<string, readonly number[]>();
    const lastActionAtByFrame = new Map<string, number>();
    const nextSequence = new Map<string, number>();
    const recorderSessions = new Set<string>();
    const rootFrameIds = new Set<string>();
    // Assigned after target discovery; event handlers close over the pinned id.
    // oxlint-disable-next-line eslint/prefer-const
    let pinnedTargetId: string | undefined;
    // Assigned after the root page target has attached.
    // oxlint-disable-next-line eslint/prefer-const
    let primarySessionId: string | undefined;
    let resolvingTarget = true;
    let closing = false;
    let eventWindowStart = Date.now();
    let eventCount = 0;

    const runEvent = (event: RecorderCaptureEvent) => {
      const now = Date.now();
      if (now - eventWindowStart >= 1000) {
        eventWindowStart = now;
        eventCount = 0;
      }
      eventCount += 1;
      if (eventCount > MAX_EVENTS_PER_SECOND) {
        Effect.runFork(
          options.onFailure("The page exceeded the recorder event limit.")
        );
        return;
      }
      Effect.runFork(
        options.onEvent(event).pipe(
          // Effect error recovery is callback-based by design.
          // oxlint-disable-next-line promise/prefer-await-to-callbacks
          Effect.tapError((error) => options.onFailure(error.message)),
          Effect.ignore
        )
      );
    };

    // The CDP callback is installed before target setup completes and closes
    // over this connection for future attached iframe targets.
    // oxlint-disable-next-line eslint/prefer-const
    let connection: CdpConnection;
    // CDP methods are intentionally dispatched here so every event passes
    // through the same context, sequence, and payload validation boundary.
    // oxlint-disable-next-line eslint/complexity
    const handleCdpEvent = (event: CdpEvent) => {
      const { params } = event;
      if (!isRecord(params)) {
        return;
      }
      if (event.method === "Runtime.executionContextCreated") {
        if (event.sessionId === undefined) {
          return;
        }
        const { context } = params;
        if (!isRecord(context) || context.name !== worldName) {
          return;
        }
        const id = typeof context.id === "number" ? context.id : undefined;
        const { auxData } = context;
        const frameId = isRecord(auxData)
          ? asString(auxData.frameId)
          : undefined;
        if (id !== undefined && frameId !== undefined) {
          const contextKey = `${event.sessionId}:${id}`;
          contextFrames.set(contextKey, {
            frameId,
            path: framePaths.get(frameId) ?? [],
          });
          nextSequence.set(contextKey, 1);
        }
        return;
      }
      if (event.method === "Runtime.bindingCalled") {
        if (params.name !== bindingName || typeof params.payload !== "string") {
          return;
        }
        const contextId =
          typeof params.executionContextId === "number"
            ? params.executionContextId
            : undefined;
        if (
          contextId === undefined ||
          event.sessionId === undefined ||
          new TextEncoder().encode(params.payload).byteLength >
            MAX_BINDING_PAYLOAD_BYTES
        ) {
          runEvent({
            reason: "The page sent an invalid recorder event.",
            type: "unsupported",
          });
          return;
        }
        const contextKey = `${event.sessionId}:${contextId}`;
        if (!contextFrames.has(contextKey)) {
          runEvent({
            reason: "The page sent an invalid recorder event.",
            type: "unsupported",
          });
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(params.payload) as unknown;
        } catch {
          runEvent({
            reason: "The page sent malformed recorder data.",
            type: "unsupported",
          });
          return;
        }
        const result = Schema.decodeUnknownResult(BindingCapture)(decoded);
        if (result._tag === "Failure") {
          runEvent({
            reason: "The page sent unsupported recorder data.",
            type: "unsupported",
          });
          return;
        }
        const expectedSequence = nextSequence.get(contextKey);
        if (
          expectedSequence === undefined ||
          result.success.sequence !== expectedSequence
        ) {
          runEvent({
            reason: "The page recorder event sequence was interrupted.",
            type: "unsupported",
          });
          return;
        }
        nextSequence.set(contextKey, expectedSequence + 1);
        const captureEvent = result.success.event;
        const context = contextFrames.get(contextKey);
        if (
          context !== undefined &&
          (captureEvent.type === "click" ||
            captureEvent.type === "change" ||
            captureEvent.type === "keyDown" ||
            captureEvent.type === "keyUp")
        ) {
          lastActionAtByFrame.set(context.frameId, Date.now());
        }
        if (
          context !== undefined &&
          context.path.length > 0 &&
          (captureEvent.type === "click" ||
            captureEvent.type === "change" ||
            captureEvent.type === "keyDown" ||
            captureEvent.type === "keyUp")
        ) {
          runEvent({ ...captureEvent, frame: context.path });
          return;
        }
        runEvent(captureEvent);
        return;
      }
      if (event.method === "Page.frameNavigated") {
        if (event.sessionId !== primarySessionId) {
          return;
        }
        const { frame } = params;
        if (!isRecord(frame) || frame.parentId !== undefined) {
          return;
        }
        const url = asString(frame.url);
        if (url !== undefined && url.startsWith("http")) {
          runEvent({
            title: asString(frame.name),
            type: "navigation",
            url,
          });
        }
        return;
      }
      if (event.method === "Page.navigatedWithinDocument") {
        if (event.sessionId !== primarySessionId) {
          return;
        }
        const frameId = asString(params.frameId);
        const url = asString(params.url);
        if (
          frameId !== undefined &&
          rootFrameIds.has(frameId) &&
          url !== undefined &&
          url.startsWith("http")
        ) {
          const lastActionAt = lastActionAtByFrame.get(frameId);
          runEvent({
            ...(lastActionAt !== undefined && Date.now() - lastActionAt <= 1000
              ? { causedByAction: true }
              : {}),
            type: "navigation",
            url,
          });
        }
        return;
      }
      if (event.method === "Target.attachedToTarget") {
        const sessionId = asString(params.sessionId);
        const { targetInfo } = params;
        const targetType = isRecord(targetInfo)
          ? asString(targetInfo.type)
          : undefined;
        const targetId = isRecord(targetInfo)
          ? asString(targetInfo.targetId)
          : undefined;
        if (resolvingTarget && targetType === "page") {
          return;
        }
        if (
          targetType === "page" &&
          pinnedTargetId !== undefined &&
          targetId !== pinnedTargetId
        ) {
          Effect.runFork(
            options.onFailure(
              "The Recording opened or activated an unsupported additional tab."
            )
          );
          return;
        }
        if (
          sessionId !== undefined &&
          (targetType === "page" || targetType === "iframe")
        ) {
          Effect.runFork(
            // setupSession is initialized before any target can emit after
            // the initial attachment command.
            // oxlint-disable-next-line eslint/no-use-before-define
            setupSession(connection, sessionId).pipe(
              // Effect error recovery is callback-based by design.
              // oxlint-disable-next-line promise/prefer-await-to-callbacks
              Effect.tapError((error) => options.onFailure(error.message)),
              Effect.ignore
            )
          );
        }
      }
    };

    connection = makeCdpConnection(socket, handleCdpEvent, () => {
      if (!closing) {
        Effect.runFork(
          options.onFailure("The browser recorder connection was lost.")
        );
      }
    });

    const setupSession = (
      activeConnection: CdpConnection,
      sessionId: string
    ): Effect.Effect<void, BrowserRpcErrorType> =>
      Effect.gen(function* configureTarget() {
        if (recorderSessions.has(sessionId)) {
          return;
        }
        recorderSessions.add(sessionId);
        yield* activeConnection.send("Runtime.enable", {}, sessionId);
        yield* activeConnection.send("Page.enable", {}, sessionId);
        yield* activeConnection.send(
          "Runtime.addBinding",
          { executionContextName: worldName, name: bindingName },
          sessionId
        );
        yield* activeConnection.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: injectedSource, worldName },
          sessionId
        );
        yield* activeConnection.send(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            flatten: true,
            waitForDebuggerOnStart: false,
          },
          sessionId
        );
        const treeResult = yield* activeConnection.send(
          "Page.getFrameTree",
          {},
          sessionId
        );
        const tree = responseField(treeResult, "frameTree");
        const entries = frameEntries(tree);
        for (const entry of entries) {
          framePaths.set(entry.frameId, entry.path);
          if (entry.path.length === 0) {
            rootFrameIds.add(entry.frameId);
          }
        }
        for (const { frameId, path: framePath } of entries) {
          const worldResult = yield* activeConnection.send(
            "Page.createIsolatedWorld",
            {
              frameId,
              grantUniveralAccess: false,
              worldName,
            },
            sessionId
          );
          const executionContextId = isRecord(worldResult)
            ? worldResult.executionContextId
            : undefined;
          if (typeof executionContextId === "number") {
            const contextKey = `${sessionId}:${executionContextId}`;
            contextFrames.set(contextKey, {
              frameId,
              path: framePath,
            });
            nextSequence.set(contextKey, 1);
            yield* activeConnection.send(
              "Runtime.evaluate",
              {
                awaitPromise: false,
                contextId: executionContextId,
                expression: injectedSource,
                returnByValue: false,
              },
              sessionId
            );
          }
        }
      });

    return yield* Effect.gen(function* initializeRecorder() {
      const targetsResult = yield* connection.send("Target.getTargets");
      const targetInfos =
        isRecord(targetsResult) && Array.isArray(targetsResult.targetInfos)
          ? targetsResult.targetInfos
          : [];
      const selectedTargetId = yield* selectRecorderTarget(
        targetInfos,
        options.tabId,
        (targetId) =>
          Effect.gen(function* probePageFocus() {
            const attachResult = yield* connection.send(
              "Target.attachToTarget",
              { flatten: true, targetId }
            );
            const sessionId = isRecord(attachResult)
              ? asString(attachResult.sessionId)
              : undefined;
            if (sessionId === undefined) {
              return false;
            }
            return yield* connection
              .send(
                "Runtime.evaluate",
                {
                  expression: "document.hasFocus()",
                  returnByValue: true,
                },
                sessionId
              )
              .pipe(
                Effect.map((evaluation) => {
                  const result = responseField(evaluation, "result");
                  return result?.value === true;
                }),
                Effect.ensuring(
                  connection
                    .send("Target.detachFromTarget", { sessionId })
                    .pipe(Effect.ignore)
                )
              );
          })
      );
      resolvingTarget = false;
      pinnedTargetId = selectedTargetId;
      const attachResult = yield* connection.send("Target.attachToTarget", {
        flatten: true,
        targetId: selectedTargetId,
      });
      const sessionId = isRecord(attachResult)
        ? asString(attachResult.sessionId)
        : undefined;
      if (sessionId === undefined) {
        return yield* Effect.fail(
          recorderError("The browser did not create a recorder session.")
        );
      }
      primarySessionId = sessionId;
      yield* setupSession(connection, sessionId);

      return Effect.gen(function* stopRecorder() {
        closing = true;
        for (const recorderSessionId of recorderSessions) {
          yield* connection
            .send(
              "Runtime.evaluate",
              {
                expression: RECORDER_CLEANUP_EXPRESSION,
                returnByValue: false,
              },
              recorderSessionId
            )
            .pipe(Effect.ignore);
        }
        yield* connection.close;
      });
    }).pipe(
      // Effect cleanup is expressed with typed error callbacks.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      Effect.tapError(() => connection.close)
    );
  });

  return { start } satisfies RecorderCapture;
});

export const makeCdpRecorderCapture = makeCdpCapture;

export const RecordingLive = Layer.effect(
  Recording,
  makeCdpRecorderCapture.pipe(Effect.flatMap(makeRecordingService))
);
