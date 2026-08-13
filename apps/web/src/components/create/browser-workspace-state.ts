import type {
  BrowserTab,
  BrowserTabId,
  SessionId,
} from "@contingency/protocol";
import { Effect } from "effect";

export const browserAddressFromUrlEvent = (
  currentAddress: string,
  editing: boolean,
  nextUrl: string
): string => {
  if (editing) {
    return currentAddress;
  }
  return nextUrl === "about:blank" ? "" : nextUrl;
};

export type BrowserAddressEditEvent = "blur" | "change" | "focus" | "submit";

export const browserAddressEditingAfter = (
  event: BrowserAddressEditEvent
): boolean => event === "change" || event === "focus";

export interface ActiveTabReconciliation {
  readonly activeTabChanged: boolean;
  readonly activeTabId: BrowserTabId | null;
  readonly address: string;
}

export const hasActiveTabChanged = (
  tabs: readonly BrowserTab[],
  previousActiveTabId: BrowserTabId | null
): boolean => {
  const activeTab = tabs.find(({ active }) => active);
  return activeTab !== undefined && previousActiveTabId !== activeTab.tabId;
};

export const browserStreamIdentity = (
  sessionId: SessionId | undefined,
  activeTabId: BrowserTabId | undefined
): string => `${sessionId ?? ""}:${activeTabId ?? ""}`;

export const browserNetworkRefreshEffect = <A, E, R>(
  refresh: () => Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => Effect.suspend(refresh);

export const preserveBrowserTabMetadata = (
  incomingTabs: readonly BrowserTab[],
  enrichedTabs: readonly BrowserTab[]
): readonly BrowserTab[] =>
  incomingTabs.map((incomingTab) => {
    const enrichedTab = enrichedTabs.find(
      ({ tabId }) => tabId === incomingTab.tabId
    );
    if (enrichedTab === undefined || enrichedTab.url !== incomingTab.url) {
      return incomingTab;
    }
    return { ...incomingTab, title: enrichedTab.title };
  });

export const replacePendingBrowserFrame = <Frame>(
  pendingFrame: Frame | null,
  nextFrame: Frame,
  releaseFrame: (frame: Frame) => void
): Frame => {
  if (pendingFrame !== null) {
    releaseFrame(pendingFrame);
  }
  return nextFrame;
};

export const browserTabSynchronizationEffect = <A, E, R, B, E2, R2>(
  initial: () => Effect.Effect<A, E, R>,
  recurring: () => Effect.Effect<B, E2, R2>
): Effect.Effect<B, E | E2, R | R2> =>
  Effect.suspend(initial).pipe(Effect.andThen(Effect.suspend(recurring)));

export const reconcileActiveTab = (
  tabs: readonly BrowserTab[],
  previousActiveTabId: BrowserTabId | null,
  currentAddress: string,
  editing: boolean
): ActiveTabReconciliation => {
  const activeTab = tabs.find(({ active }) => active);
  if (activeTab === undefined) {
    return {
      activeTabChanged: false,
      activeTabId: previousActiveTabId,
      address: currentAddress,
    };
  }

  const activeTabChanged = hasActiveTabChanged(tabs, previousActiveTabId);
  return {
    activeTabChanged,
    activeTabId: activeTab.tabId,
    address: browserAddressFromUrlEvent(
      currentAddress,
      !activeTabChanged && editing,
      activeTab.url
    ),
  };
};
