import type {
  BrowserCookieWrite,
  BrowserInput,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserRpcErrorType,
  BrowserStorageSnapshot,
  BrowserStreamEvent,
  BrowserStreamId,
  BrowserTab,
  BrowserTabId,
  FrameSequence,
  SessionId,
  StorageKind,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import type { Effect, Stream } from "effect";
import { Context } from "effect";
import type { BrowserContext, Page } from "playwright-core";

/**
 * What the Recorder attaches to: the pinned session's context, the Page the
 * Recording starts on, and that Page's identity in Create View. A Recording
 * spans the Pages this context opens and never migrates to another one.
 */
export interface RecorderTarget {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly tabId: BrowserTabId;
}

export type BrowserStorageSetInput =
  | {
      readonly cookie: BrowserCookieWrite;
      readonly kind: "cookies";
    }
  | {
      readonly key: string;
      readonly kind: "local" | "session";
      readonly value: string;
    };

export type BrowserStorageDeleteInput =
  | {
      readonly domain: string;
      readonly kind: "cookies";
      readonly name: string;
      readonly path: string;
    }
  | { readonly key: string; readonly kind: "local" | "session" };

export interface CreateBrowserService {
  readonly acknowledgeFrame: (
    sessionId: SessionId,
    sequence: FrameSequence,
    streamId: BrowserStreamId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly clearStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly close: (
    sessionId: SessionId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly closeTab: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly create: (
    name: string,
    viewport: Viewport
  ) => Effect.Effect<SessionId, BrowserRpcErrorType>;
  readonly currentUrl: (
    sessionId: SessionId
  ) => Effect.Effect<string, BrowserRpcErrorType>;
  readonly deleteStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    input: BrowserStorageDeleteInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly getNetworkRequest: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    requestId: string
  ) => Effect.Effect<BrowserNetworkRequestDetail, BrowserRpcErrorType>;
  readonly getNetworkRequests: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<readonly BrowserNetworkRequest[], BrowserRpcErrorType>;
  readonly getStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Effect.Effect<BrowserStorageSnapshot, BrowserRpcErrorType>;
  readonly getTabs: (
    sessionId: SessionId
  ) => Effect.Effect<readonly BrowserTab[], BrowserRpcErrorType>;
  readonly list: () => Effect.Effect<readonly SessionId[]>;
  readonly navigate: (
    sessionId: SessionId,
    action: "back" | "forward" | "reload"
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly newTab: (
    sessionId: SessionId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly open: (
    sessionId: SessionId | undefined,
    url: string,
    viewport: Viewport,
    userAgentProfile: UserAgentProfileId
  ) => Effect.Effect<
    { readonly sessionId: SessionId; readonly url: string },
    BrowserRpcErrorType
  >;
  readonly recorderTarget: (
    sessionId: SessionId
  ) => Effect.Effect<RecorderTarget, BrowserRpcErrorType>;
  readonly sendInput: (
    sessionId: SessionId,
    input: BrowserInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly setStorage: (
    sessionId: SessionId,
    tabId: BrowserTabId,
    input: BrowserStorageSetInput
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly setUserAgent: (
    sessionId: SessionId,
    url: string,
    viewport: Viewport,
    profile: UserAgentProfileId
  ) => Effect.Effect<{ readonly url: string }, BrowserRpcErrorType>;
  readonly setViewport: (
    sessionId: SessionId,
    viewport: Viewport
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly stream: (
    sessionId: SessionId
  ) => Stream.Stream<BrowserStreamEvent, BrowserRpcErrorType>;
  readonly switchTab: (
    sessionId: SessionId,
    tabId: BrowserTabId
  ) => Effect.Effect<void, BrowserRpcErrorType>;
}

export const CreateBrowser = Context.Service<CreateBrowserService>(
  "@contingency/CreateBrowser"
);
