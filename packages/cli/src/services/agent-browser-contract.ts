import type {
  BrowserAgentPointer,
  AgentActionEffect,
  AgentActionSubject,
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentElementRef,
  AgentScreenshot,
  AgentSnapshotOptions,
  BrowserRpcErrorType,
  SessionId,
} from "@contingency/protocol";
import type { Effect, Scope } from "effect";

import type { CreateBrowserService } from "./create-browser-contract.ts";

/**
 * Where one private Variable is entered. `selector` names the controls the
 * value is typed into: one field, or every box of a split input such as six
 * OTP boxes. `spread` names associated controls in the same widget, which
 * the page may distribute the value across. It is read as evidence that the
 * page accepted the value and is never typed into.
 */
export interface PrivateInputTarget {
  readonly selector: string;
  readonly spread: string | undefined;
}

/** One element the Snapshot located, with the box it occupied in the viewport. */
export interface AgentElementBounds {
  readonly rectangle: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly ref: AgentElementRef;
}

/** Where the agent's cursor lands, reported before the action it precedes. */
export type AgentPointerSink = (
  pointer: Pick<BrowserAgentPointer, "action" | "x" | "y">
) => Effect.Effect<void, BrowserRpcErrorType>;

/** An action's observation is bound to its document, including across Takeover. */
export interface AgentBrowserObservation {
  readonly observe: () => Effect.Effect<
    {
      readonly effect: AgentActionEffect | null;
      readonly snapshot: AgentBrowserSnapshot;
    },
    BrowserRpcErrorType
  >;
}

/** Opaque tab identity retained by typing and scroll bursts. No browser objects escape. */
export interface AgentBrowserTab {
  readonly url: () => string;
  readonly snapshot: (
    options?: AgentSnapshotOptions
  ) => Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType>;
  readonly settledSnapshot: (
    options?: AgentSnapshotOptions
  ) => Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType>;
  readonly snapshotAfter: (
    urlBefore: string
  ) => Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType>;
  readonly inspect: (
    x: number,
    y: number
  ) => Effect.Effect<AgentElementBounds, BrowserRpcErrorType>;
  readonly beginObservation: (
    action: AgentBrowserAction
  ) => Effect.Effect<AgentBrowserObservation>;
  readonly perform: (
    action: AgentBrowserAction,
    pointer?: AgentPointerSink
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly enterPrivate: (
    target: PrivateInputTarget,
    value: string,
    pointer?: AgentPointerSink
  ) => Effect.Effect<string, BrowserRpcErrorType>;
  readonly screenshot: (
    maskSensitive: boolean,
    privateValues: readonly string[],
    privateSelectors: readonly string[]
  ) => Effect.Effect<AgentScreenshot, BrowserRpcErrorType>;
}

export interface AgentNavigationPolicy {
  readonly allows: (url: string) => boolean;
  readonly refuse: (url: string) => Effect.Effect<void, unknown>;
  readonly dispose: () => void;
}

/** One session owns refs, observations, action settling, privacy and navigation enforcement. */
export interface AgentBrowser {
  readonly active: () => Effect.Effect<AgentBrowserTab, BrowserRpcErrorType>;
  readonly enforceNavigation: (
    policy: AgentNavigationPolicy
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly describe: (ref: string) => AgentActionSubject | undefined;
  readonly isSensitive: (
    ref: string
  ) => Effect.Effect<boolean, BrowserRpcErrorType>;
  readonly privateSelector: (
    ref: string,
    segmentCount?: number
  ) => Effect.Effect<PrivateInputTarget, BrowserRpcErrorType>;
  readonly pointRef: (
    x: number,
    y: number
  ) => Effect.Effect<AgentElementRef, BrowserRpcErrorType>;
  readonly hasFocus: (ref: string) => Effect.Effect<boolean>;
  readonly currentRef: (
    ref: string
  ) => Effect.Effect<AgentElementRef, BrowserRpcErrorType>;
  readonly focusedRef: () => Effect.Effect<
    AgentElementRef,
    BrowserRpcErrorType
  >;
  readonly sameElement: (left: string, right: string) => Effect.Effect<boolean>;
  readonly valueDigest: (
    ref: string
  ) => Effect.Effect<string, BrowserRpcErrorType>;
}

export type AgentBrowserFactory = (input: {
  readonly browser: CreateBrowserService;
  readonly sessionId: SessionId;
  readonly scope: Scope.Scope;
  readonly now: () => Date;
}) => Effect.Effect<AgentBrowser>;
