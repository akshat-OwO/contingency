import { makeBrowserRpcError } from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect } from "effect";

/**
 * Shared Chrome DevTools Protocol plumbing. The browser tool covers most of
 * what Contingency needs, but a few capabilities have no CLI surface — setting
 * a user agent on a live page, and dispatching a key press as a separate down
 * and up. Both reach for the same socket, so it lives here rather than in
 * either caller.
 */

const cdpError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("agent_browser_failed", message);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const openWebSocket = (
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
        Effect.fail(cdpError("Unable to connect to the browser CDP endpoint."))
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

export interface CdpEvent {
  readonly method: string;
  readonly params?: unknown;
  readonly sessionId?: string;
}

export interface CdpResponse {
  readonly error?: { readonly message?: string } | undefined;
  readonly id: number;
  readonly result?: unknown;
}

export interface CdpConnection {
  readonly close: Effect.Effect<void>;
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string
  ) => Effect.Effect<unknown, BrowserRpcErrorType>;
}

export const makeCdpConnection = (
  socket: WebSocket,
  onEvent: (event: CdpEvent) => void
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
      complete({ error: { message: "CDP connection closed." }, id });
    }
    pending.clear();
  };
  const handleClose = () => {
    failPending();
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
              cdpError(
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
        resume(
          Effect.fail(
            cdpError(error instanceof Error ? error.message : String(error))
          )
        );
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

export const pageTargetIds = (
  targetInfos: readonly unknown[]
): readonly string[] =>
  targetInfos.flatMap((target) =>
    isRecord(target) &&
    target.type === "page" &&
    typeof target.targetId === "string"
      ? [target.targetId]
      : []
  );

/**
 * Which page target an out-of-band CDP command should act on. A session can
 * hold several page targets — a leftover `about:blank`, a second tab — so the
 * focused one is probed rather than assumed, falling back to the first HTTP
 * page. Guessing here sends key events to a page nobody is looking at.
 */
export const selectPageTarget = (
  connection: CdpConnection,
  targetInfos: readonly unknown[],
  requestedTabId: string | undefined
): Effect.Effect<string, BrowserRpcErrorType> =>
  Effect.gen(function* resolvePageTarget() {
    const ids = pageTargetIds(targetInfos);
    if (requestedTabId !== undefined && ids.includes(requestedTabId)) {
      return requestedTabId;
    }

    const focusedTargetIds: string[] = [];
    for (const targetId of ids) {
      const attachResult = yield* connection.send("Target.attachToTarget", {
        flatten: true,
        targetId,
      });
      const probeSessionId = isRecord(attachResult)
        ? asString(attachResult.sessionId)
        : undefined;
      if (probeSessionId === undefined) {
        continue;
      }
      const focused = yield* connection
        .send(
          "Runtime.evaluate",
          {
            expression: "document.hasFocus()",
            returnByValue: true,
          },
          probeSessionId
        )
        .pipe(
          Effect.map((evaluation) => {
            const result = isRecord(evaluation) ? evaluation.result : undefined;
            return (
              isRecord(result) &&
              Object.hasOwn(result, "value") &&
              result.value === true
            );
          }),
          Effect.ensuring(
            connection
              .send("Target.detachFromTarget", { sessionId: probeSessionId })
              .pipe(Effect.ignore)
          )
        );
      if (focused) {
        focusedTargetIds.push(targetId);
      }
    }
    if (
      requestedTabId !== undefined &&
      focusedTargetIds.length === 1 &&
      focusedTargetIds[0] !== undefined
    ) {
      return focusedTargetIds[0];
    }

    const httpPage = targetInfos.find(
      (target) =>
        isRecord(target) &&
        target.type === "page" &&
        typeof target.targetId === "string" &&
        typeof target.url === "string" &&
        (target.url.startsWith("http://") || target.url.startsWith("https://"))
    );
    if (isRecord(httpPage) && typeof httpPage.targetId === "string") {
      return httpPage.targetId;
    }

    const [firstPage] = ids;
    if (firstPage !== undefined) {
      return firstPage;
    }

    return yield* Effect.fail(
      cdpError("The active browser tab could not be resolved.")
    );
  });
