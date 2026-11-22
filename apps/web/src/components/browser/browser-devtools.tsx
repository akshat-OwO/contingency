import type {
  TeachingBrowserAttachment,
  BrowserConsoleEntry,
  BrowserNetworkRequestSummary,
  BrowserNetworkRequestDetail,
  BrowserRequestId,
  BrowserTabId,
  StorageKind,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { createHighlighter } from "@tanstack/highlight/core";
import { html } from "@tanstack/highlight/languages/html";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleXIcon,
  LoaderCircleIcon,
  PanelBottomIcon,
  PanelRightIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  dragAttachment,
  requestAttachment,
} from "@/components/agent/browser-check-attachments";
import {
  consoleErrorCount,
  devtoolsPanelTitles,
  isConsoleError,
  isConsoleWarning,
} from "@/components/browser/browser-devtools-panels";
import type {
  DevtoolsDockSide,
  DevtoolsPanel,
} from "@/components/browser/browser-devtools-panels";
import { BrowserStoragePanel } from "@/components/browser/browser-storage-panel";
import type { StoragePanelUiState } from "@/components/browser/browser-storage-panel";
import {
  initialStoragePanelUiState,
  isStorageDraftDirty,
} from "@/components/browser/browser-storage-state";
import type {
  StorageDraft,
  StorageSelection,
  StorageSnapshots,
} from "@/components/browser/browser-storage-state";
import type { BrowserTooling } from "@/components/browser/browser-tooling";
import { devtoolsFieldClassName } from "@/components/browser/devtools-field";
import { HighlightedCode } from "@/components/browser/highlighted-code";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";
import type { ResizableLayoutChangeDetails } from "@/components/ui/resizable";
import { pixelShare, shareSize } from "@/components/ui/resizable-size";
import {
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Toggle, ToggleGroup } from "@/components/ui/toggle";
import { useElementSize } from "@/hooks/use-element-size";
import { usePresence } from "@/hooks/use-presence";
import { cn } from "@/lib/utils";

import { BrowserResponseFields } from "./browser-response-fields";

type ConsoleFilter = "all" | "error" | "log" | "warning";
type NetworkDetailTab = "headers" | "payload" | "response";
type NetworkFilter =
  | "all"
  | "fetch-xhr"
  | "document"
  | "css"
  | "js"
  | "font"
  | "image"
  | "media"
  | "websocket"
  | "other";

export interface BrowserDevtoolsProps {
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  readonly dockSide: DevtoolsDockSide;
  readonly mutationsLocked: boolean;
  readonly networkRequests: readonly BrowserNetworkRequestSummary[];
  readonly onClearConsole: () => void;
  readonly onClearNetwork: () => void;
  readonly onClose: () => void;
  readonly onError: (message: string) => void;
  readonly onRefreshNetwork: () => void;
  /** Switches the docked inspector to another panel from its header. */
  readonly onSelectPanel: (panel: DevtoolsPanel) => void;
  readonly onToggleDockSide: () => void;
  readonly panel: DevtoolsPanel;
  readonly refreshingNetwork: boolean;
  readonly tooling: BrowserTooling;
  readonly tabId: BrowserTabId;
  readonly tabTitle: string;
  readonly tabUrl: string;
}

const detailTabs: readonly {
  readonly label: string;
  readonly value: NetworkDetailTab;
}[] = [
  { label: "Headers", value: "headers" },
  { label: "Payload", value: "payload" },
  { label: "Response", value: "response" },
];

const networkFilters: readonly {
  readonly label: string;
  readonly value: NetworkFilter;
}[] = [
  { label: "All", value: "all" },
  { label: "Fetch/XHR", value: "fetch-xhr" },
  { label: "Doc", value: "document" },
  { label: "CSS", value: "css" },
  { label: "JS", value: "js" },
  { label: "Font", value: "font" },
  { label: "Img", value: "image" },
  { label: "Media", value: "media" },
  { label: "WS", value: "websocket" },
  { label: "Other", value: "other" },
];

interface DevtoolsUiState {
  readonly consoleFilter: ConsoleFilter;
  readonly consoleQuery: string;
  readonly detail: BrowserNetworkRequestDetail | undefined;
  readonly detailLoading: boolean;
  readonly detailTab: NetworkDetailTab;
  readonly networkFilter: NetworkFilter;
  readonly networkQuery: string;
  readonly selectedRequestId: BrowserRequestId | undefined;
  readonly storageDraft: StorageDraft | undefined;
  readonly storageFocused: boolean;
  readonly storageKind: StorageKind;
  readonly storageMutateError: string | undefined;
  readonly storageRefreshNonce: number;
  readonly storageSearch: string;
  readonly storageSelection: StorageSelection | undefined;
  readonly storageSnapshots: StorageSnapshots;
}

const devtoolsUiStateAtoms = Atom.family(() =>
  Atom.make<DevtoolsUiState>({
    consoleFilter: "all",
    consoleQuery: "",
    detail: undefined,
    detailLoading: false,
    detailTab: "headers",
    networkFilter: "all",
    networkQuery: "",
    selectedRequestId: undefined,
    storageRefreshNonce: 0,
    ...initialStoragePanelUiState,
  })
);

const storageSlice = (state: DevtoolsUiState): StoragePanelUiState => ({
  storageDraft: state.storageDraft,
  storageFocused: state.storageFocused,
  storageKind: state.storageKind,
  storageMutateError: state.storageMutateError,
  storageSearch: state.storageSearch,
  storageSelection: state.storageSelection,
  storageSnapshots: state.storageSnapshots,
});

const highlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: [html, js, json, plaintext],
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const formatTime = (timestamp: number): string =>
  timeFormatter.format(timestamp);

/** How long a request took, as a duration; a pending one has none yet. */
const formatDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined) {
    return "…";
  }
  return durationMs < 1000
    ? `${Math.round(durationMs)} ms`
    : `${(durationMs / 1000).toFixed(2)} s`;
};

const requestCount = (count: number): string =>
  count === 1 ? "1 request" : `${count} requests`;

/** Path, Status, Type, Time, and the attach button when the card takes one. */
const networkColumns = (attachable: boolean): string =>
  attachable
    ? "grid-cols-[minmax(8rem,1fr)_3rem_4.5rem_4rem_1.5rem]"
    : "grid-cols-[minmax(8rem,1fr)_3rem_4.5rem_4rem]";

const consoleMatchesFilter = (
  entry: BrowserConsoleEntry,
  filter: ConsoleFilter
): boolean => {
  if (filter === "error") {
    return isConsoleError(entry);
  }
  if (filter === "warning") {
    return isConsoleWarning(entry);
  }
  if (filter === "log") {
    return !isConsoleError(entry) && !isConsoleWarning(entry);
  }
  return true;
};

const statusTone = (status: number | undefined): string => {
  if (status === undefined) {
    return "bg-muted text-muted-foreground";
  }
  if (status >= 400) {
    return "bg-destructive/10 text-destructive";
  }
  if (status >= 300) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
};

const StatusPill = ({ status }: { readonly status: number | undefined }) => (
  <span
    className={cn(
      "inline-block rounded px-1.5 py-px font-mono text-xs font-medium tabular-nums",
      statusTone(status)
    )}
  >
    {status ?? "…"}
  </span>
);

const renderConsoleIcon = (entry: BrowserConsoleEntry) => {
  if (isConsoleError(entry)) {
    return <CircleXIcon className="text-destructive mt-0.5 size-3.5" />;
  }
  if (isConsoleWarning(entry)) {
    return <CircleAlertIcon className="mt-0.5 size-3.5 text-amber-500" />;
  }
  return <span className="text-muted-foreground/60 mt-px w-3.5">›</span>;
};

const consoleRowTone = (entry: BrowserConsoleEntry): string | undefined => {
  if (isConsoleError(entry)) {
    return "bg-destructive/[0.06] text-destructive dark:bg-destructive/10";
  }
  if (isConsoleWarning(entry)) {
    return "bg-amber-500/[0.07] text-amber-800 dark:text-amber-300";
  }
  return undefined;
};

const requestName = (url: string): string => {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.split("/").findLast((segment) => segment.length > 0) ??
      parsed.hostname
    );
  } catch {
    return url;
  }
};

const requestMatchesFilter = (
  request: BrowserNetworkRequestSummary,
  filter: NetworkFilter
): boolean => {
  if (filter === "all") {
    return true;
  }
  const type = request.resourceType.toLocaleLowerCase();
  if (filter === "fetch-xhr") {
    return type === "fetch" || type === "xhr";
  }
  if (filter === "js") {
    return type === "script";
  }
  if (filter === "image") {
    return type === "image";
  }
  if (filter === "websocket") {
    return type === "websocket";
  }
  return type === filter;
};

type NetworkHeaders = BrowserNetworkRequestDetail["headers"] | null | undefined;

const recordEntries = (
  value: NetworkHeaders
): readonly (readonly [string, string])[] =>
  value === null || value === undefined ? [] : Object.entries(value);

const prettyText = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const responseLanguage = (
  mimeType: string | undefined,
  value: string
): "html" | "js" | "json" | "plaintext" => {
  const mime = mimeType?.toLocaleLowerCase() ?? "";
  if (mime.includes("json")) {
    return "json";
  }
  if (mime.includes("html") || value.trimStart().startsWith("<")) {
    return "html";
  }
  if (mime.includes("javascript")) {
    return "js";
  }
  return "plaintext";
};

const renderHighlightedText = (
  language: "html" | "js" | "json" | "plaintext",
  value: string
) => {
  const { tokens } = highlighter.tokenize(value, { lang: language });
  return <HighlightedCode tokens={tokens} />;
};

const SectionLabel = ({ children }: { readonly children: string }) => (
  <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
    {children}
  </h3>
);

const SearchField = ({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly value: string;
}) => (
  <div className="relative min-w-0 flex-1">
    <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
    <Input
      variant="compact"
      aria-label={label}
      className={cn(devtoolsFieldClassName, "pl-7")}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      value={value}
    />
  </div>
);

const renderHeaderSection = (label: string, value: NetworkHeaders) => {
  const entries = recordEntries(value);
  return (
    <section>
      <SectionLabel>{label}</SectionLabel>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">No headers recorded.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 font-mono text-xs">
          {entries.map(([key, entry]) => (
            <div className="contents" key={key}>
              <dt className="text-muted-foreground break-all">{key}</dt>
              <dd className="break-all">{entry}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
};

const renderRequestDetails = (
  detail: BrowserNetworkRequestDetail | undefined,
  detailTab: NetworkDetailTab,
  loading: boolean
) => {
  if (loading) {
    return (
      <div className="text-muted-foreground grid size-full place-items-center text-xs">
        <span className="flex items-center gap-2">
          <LoaderCircleIcon className="size-4 animate-spin" />
          Loading request details…
        </span>
      </div>
    );
  }

  if (detail === undefined) {
    return (
      <p role="alert" className="text-destructive p-3 text-xs">
        Could not load request details. Close this view and select the request
        to retry.
      </p>
    );
  }
  const resolved = detail;
  if (detailTab === "headers") {
    return (
      <div className="size-full space-y-4 overflow-auto p-3">
        <section>
          <SectionLabel>General</SectionLabel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">Request URL</dt>
            <dd className="break-all">{resolved.url}</dd>
            <dt className="text-muted-foreground">Request Method</dt>
            <dd>{resolved.method}</dd>
            <dt className="text-muted-foreground">Status Code</dt>
            <dd>{resolved.status ?? "Pending"}</dd>
          </dl>
        </section>
        {renderHeaderSection("Response Headers", detail?.responseHeaders)}
        {renderHeaderSection("Request Headers", detail?.headers)}
      </div>
    );
  }

  if (detailTab === "payload") {
    const payload = prettyText(detail?.postData);
    return payload.length === 0 ? (
      <div className="text-muted-foreground grid size-full place-items-center text-xs">
        This request has no payload.
      </div>
    ) : (
      renderHighlightedText(
        responseLanguage(resolved.mimeType, payload),
        payload
      )
    );
  }

  const body = prettyText(detail?.responseBody);
  return body.length === 0 ? (
    <div className="text-muted-foreground grid size-full place-items-center px-4 text-center text-xs">
      The response body is unavailable. It may have been evicted by Chromium or
      belong to a previous tab target.
    </div>
  ) : (
    renderHighlightedText(responseLanguage(resolved.mimeType, body), body)
  );
};

const DevtoolsConsolePanel = ({
  consoleEntries,
  filter,
  onUpdateUiState,
  query,
}: {
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  readonly filter: ConsoleFilter;
  readonly onUpdateUiState: (update: Partial<DevtoolsUiState>) => void;
  readonly query: string;
}) => {
  const consoleScrollRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = consoleEntries.filter(
    (entry) =>
      consoleMatchesFilter(entry, filter) &&
      (normalizedQuery.length === 0 ||
        entry.text.toLocaleLowerCase().includes(normalizedQuery))
  );
  const errors = consoleErrorCount(consoleEntries);
  const warnings = consoleEntries.filter(isConsoleWarning).length;
  const consoleVirtualizer = useVirtualizer({
    count: visibleEntries.length,
    estimateSize: () => 30,
    getScrollElement: () => consoleScrollRef.current,
    overscan: 12,
  });

  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      consoleVirtualizer.measure();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [consoleVirtualizer]);

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        <SegmentedControl<ConsoleFilter>
          aria-label="Console level"
          onValueChange={(consoleFilter) => {
            if (consoleFilter !== null) {
              onUpdateUiState({ consoleFilter });
            }
          }}
          size="sm"
          value={filter}
        >
          <SegmentedControlItem value="all">
            All
            <SegmentedControlCount>
              {consoleEntries.length}
            </SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="error">
            Errors
            <SegmentedControlCount>{errors}</SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="warning">
            Warnings
            <SegmentedControlCount>{warnings}</SegmentedControlCount>
          </SegmentedControlItem>
          <SegmentedControlItem value="log">Logs</SegmentedControlItem>
        </SegmentedControl>
        <SearchField
          label="Filter console messages"
          onChange={(consoleQuery) => onUpdateUiState({ consoleQuery })}
          placeholder="Filter messages"
          value={query}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-1.5 pb-1.5"
        ref={consoleScrollRef}
      >
        {visibleEntries.length === 0 ? (
          <div className="text-muted-foreground grid h-28 place-items-center text-xs">
            {consoleEntries.length === 0
              ? "Console messages for this tab will appear here."
              : "No messages match this filter."}
          </div>
        ) : (
          <div
            className="relative w-full font-mono text-xs"
            style={{ height: consoleVirtualizer.getTotalSize() }}
          >
            {consoleVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = visibleEntries[virtualRow.index];
              if (entry === undefined) {
                return null;
              }
              return (
                <div
                  className="absolute top-0 left-0 w-full pb-px"
                  data-index={virtualRow.index}
                  key={virtualRow.key}
                  ref={consoleVirtualizer.measureElement}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <div
                    className={cn(
                      "grid grid-cols-[auto_1fr_auto] gap-2 rounded-md px-2 py-1.5",
                      consoleRowTone(entry)
                    )}
                  >
                    {renderConsoleIcon(entry)}
                    <pre className="min-w-0 font-[inherit] break-words whitespace-pre-wrap">
                      {entry.text}
                    </pre>
                    <time className="text-muted-foreground tabular-nums">
                      {formatTime(entry.timestamp)}
                    </time>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const DETAIL_STEP = 16;
const SPLIT_HANDLE = 6;

/**
 * The room each pane keeps. Beside the list, the detail needs its header's
 * status, tabs and close button, and the list its four columns.
 */
const splitBounds = {
  beside: { detail: 320, list: 400 },
  under: { detail: 140, list: 120 },
} as const;

/**
 * The request list and its detail as a Resizable sized in pixels. A DevTools
 * island docked under the page is wide, so the detail sits beside the list;
 * docked beside the page, it sits under the list. Each side keeps its own
 * size.
 */
const useRequestDetailSplit = (dockSide: DevtoolsDockSide) => {
  const side = dockSide === "bottom" ? "beside" : "under";
  const [split, setSplit] = useState({ beside: 360, under: 240 });
  const { ref, size } = useElementSize<HTMLDivElement>();
  const room = side === "beside" ? size.width : size.height;
  const bounds = splitBounds[side];
  // The room the list and detail share, without the handle between them.
  const shared = room - SPLIT_HANDLE;
  // Before the panel is measured there is no bound to hold the detail to.
  const maxDetail =
    room === 0 ? Number.POSITIVE_INFINITY : shared - bounds.list;
  const detailSize = Math.round(
    Math.min(split[side], Math.max(maxDetail, bounds.detail))
  );
  const detailShare = pixelShare(detailSize, shared);
  return {
    bounds,
    layout: (open: boolean): number[] =>
      open ? [100 - detailShare, detailShare] : [100],
    onLayoutChange: (
      layout: readonly number[],
      { reason }: ResizableLayoutChangeDetails
    ) => {
      const [, share] = layout;
      // Only a person's drag or key moves the split; the group fitting its
      // panels to a new size leaves the size they chose. When the list and
      // the detail can't both keep their room, the detail keeps its minimum
      // and the size they chose waits for a wider split.
      if (
        share === undefined ||
        (reason !== "drag" && reason !== "step-key") ||
        maxDetail < bounds.detail
      ) {
        return;
      }
      setSplit((current) => ({
        ...current,
        [side]: Math.round(
          Math.min(Math.max(shareSize(share, shared), bounds.detail), maxDetail)
        ),
      }));
    },
    ref,
    side,
    step: shared > 0 ? pixelShare(DETAIL_STEP, shared) : 1,
  };
};

const RequestDetailView = ({
  onAttach,
  detail,
  detailLoading,
  detailRef,
  detailTab,
  leaving = false,
  onUpdateUiState,
  request,
}: {
  readonly onAttach:
    | ((attachment: TeachingBrowserAttachment) => void)
    | undefined;
  readonly detail: BrowserNetworkRequestDetail | undefined;
  readonly detailLoading: boolean;
  readonly detailTab: NetworkDetailTab;
  readonly onUpdateUiState: (update: Partial<DevtoolsUiState>) => void;
  readonly request: BrowserNetworkRequestSummary;
  readonly detailRef?: (element: HTMLElement | null) => void;
  readonly leaving?: boolean;
}) => (
  <div
    className="flex size-full min-h-0 min-w-0 flex-col"
    inert={leaving}
    ref={detailRef}
  >
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1.5">
      <StatusPill status={request.status} />
      <span className="min-w-24 flex-1 truncate font-mono text-xs">
        {request.method} {requestName(request.url)}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SegmentedControl<NetworkDetailTab>
          aria-label="Request detail"
          onValueChange={(next) => {
            if (next !== null) {
              onUpdateUiState({ detailTab: next });
            }
          }}
          size="xs"
          value={detailTab}
        >
          {detailTabs.map((tab) => (
            <SegmentedControlItem key={tab.value} value={tab.value}>
              {tab.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <Button
          aria-label="Close request details"
          onClick={() => onUpdateUiState({ selectedRequestId: undefined })}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
      {detailTab === "response" &&
      detail?.responseBody !== undefined &&
      onAttach !== undefined ? (
        <BrowserResponseFields
          attach={onAttach}
          body={detail.responseBody}
          request={request}
        />
      ) : (
        renderRequestDetails(detail, detailTab, detailLoading)
      )}
    </div>
  </div>
);

const DevtoolsNetworkPanel = ({
  dockSide,
  onAttach,
  detail,
  detailLoading,
  detailTab,
  networkFilter,
  networkQuery,
  networkRequests,
  onSelectRequest,
  onUpdateUiState,
  selectedRequestId,
}: {
  readonly dockSide: DevtoolsDockSide;
  readonly onAttach:
    | ((attachment: TeachingBrowserAttachment) => void)
    | undefined;
  readonly detail: BrowserNetworkRequestDetail | undefined;
  readonly detailLoading: boolean;
  readonly detailTab: NetworkDetailTab;
  readonly networkFilter: NetworkFilter;
  readonly networkQuery: string;
  readonly networkRequests: readonly BrowserNetworkRequestSummary[];
  readonly onSelectRequest: (request: BrowserNetworkRequestSummary) => void;
  readonly onUpdateUiState: (update: Partial<DevtoolsUiState>) => void;
  readonly selectedRequestId: BrowserRequestId | undefined;
}) => {
  const networkScrollRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = networkQuery.trim().toLocaleLowerCase();
  const visibleRequests = networkRequests.filter(
    (request) =>
      requestMatchesFilter(request, networkFilter) &&
      (normalizedQuery.length === 0 ||
        request.url.toLocaleLowerCase().includes(normalizedQuery) ||
        request.method.toLocaleLowerCase().includes(normalizedQuery) ||
        request.resourceType.toLocaleLowerCase().includes(normalizedQuery))
  );
  const selectedRequest = networkRequests.find(
    ({ requestId }) => requestId === selectedRequestId
  );
  const networkVirtualizer = useVirtualizer({
    count: visibleRequests.length,
    estimateSize: () => 30,
    getScrollElement: () => networkScrollRef.current,
    overscan: 16,
  });

  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      networkVirtualizer.measure();
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [networkVirtualizer]);

  const split = useRequestDetailSplit(dockSide);
  const { bounds, side } = split;
  const detailPresence = usePresence(selectedRequest, {
    durationMs: 180,
    hidden: { opacity: 0 },
    shown: { opacity: 1 },
  });
  // Going back clears only the selection, so the loaded detail stays drawn
  // while the view slides away.
  const shownRequest = detailPresence.rendered;

  const failed = networkRequests.filter(
    ({ status }) => status !== undefined && status >= 400
  ).length;

  return (
    <Resizable
      className="relative size-full"
      layout={split.layout(shownRequest !== undefined)}
      onLayoutChange={split.onLayoutChange}
      orientation={side === "beside" ? "horizontal" : "vertical"}
      ref={split.ref}
      step={split.step}
    >
      <ResizablePanel
        className="flex flex-col overflow-hidden"
        minSize={`${bounds.list}px`}
      >
        <div className="shrink-0 space-y-2 px-3 py-2">
          <SearchField
            label="Filter network requests"
            onChange={(value) => onUpdateUiState({ networkQuery: value })}
            placeholder="Filter by URL, method, or type"
            value={networkQuery}
          />
          <div className="overflow-x-auto">
            <SegmentedControl<NetworkFilter>
              aria-label="Request type"
              onValueChange={(next) => {
                if (next !== null) {
                  onUpdateUiState({ networkFilter: next });
                }
              }}
              size="xs"
              value={networkFilter}
            >
              {networkFilters.map((option) => (
                <SegmentedControlItem key={option.value} value={option.value}>
                  {option.label}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>
        </div>
        <div
          aria-label="Network requests"
          aria-rowcount={visibleRequests.length + 1}
          className="flex min-h-0 flex-1 flex-col text-xs"
          role="table"
        >
          <div role="rowgroup">
            <div
              aria-rowindex={1}
              className={cn(
                "text-muted-foreground grid shrink-0 items-center gap-2 px-4 py-1.5 font-medium",
                networkColumns(onAttach !== undefined)
              )}
              role="row"
            >
              <span role="columnheader">Path</span>{" "}
              <span role="columnheader">Status</span>{" "}
              <span role="columnheader">Type</span>{" "}
              <span className="text-right" role="columnheader">
                Time
              </span>
              {onAttach === undefined ? null : (
                <span className="sr-only" role="columnheader">
                  Attach
                </span>
              )}
            </div>
          </div>
          <div
            className="min-h-0 flex-1 overflow-auto px-1.5"
            ref={networkScrollRef}
          >
            {visibleRequests.length === 0 ? (
              <div role="rowgroup">
                <div role="row">
                  <div
                    className="text-muted-foreground grid h-24 place-items-center px-4 text-center"
                    role="cell"
                  >
                    {networkRequests.length === 0
                      ? "Network requests for this tab will appear here."
                      : "No requests match this filter."}
                  </div>
                </div>
              </div>
            ) : (
              <div
                className="relative w-full"
                role="rowgroup"
                style={{ height: networkVirtualizer.getTotalSize() }}
              >
                {networkVirtualizer.getVirtualItems().map((virtualRow) => {
                  const request = visibleRequests[virtualRow.index];
                  if (request === undefined) {
                    return null;
                  }
                  const failedRequest =
                    request.status !== undefined && request.status >= 400;
                  const selected = request.requestId === selectedRequestId;
                  return (
                    <div
                      aria-rowindex={virtualRow.index + 2}
                      className={cn(
                        "border-island-border absolute top-0 left-0 grid h-[30px] w-full items-center gap-2 border-t px-2.5 text-left",
                        networkColumns(onAttach !== undefined),
                        selected ? "bg-brand/12" : "hover:bg-island-hover",
                        failedRequest && "text-destructive"
                      )}
                      draggable={onAttach !== undefined}
                      key={virtualRow.key}
                      onDragStart={(event) =>
                        dragAttachment(
                          event,
                          requestAttachment(request, { purpose: "context" })
                        )
                      }
                      role="row"
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                      title={request.url}
                    >
                      <div className="min-w-0" role="cell">
                        <button
                          aria-pressed={selected}
                          className="focus-visible:ring-ring block w-full truncate rounded-sm text-left font-mono outline-none focus-visible:ring-2"
                          onClick={() => onSelectRequest(request)}
                          type="button"
                        >
                          <span
                            className={cn(
                              !failedRequest && "text-muted-foreground"
                            )}
                          >
                            {request.method}
                          </span>{" "}
                          {requestName(request.url)}
                        </button>
                      </div>{" "}
                      <div className="font-mono tabular-nums" role="cell">
                        {request.status ?? "…"}
                      </div>{" "}
                      <div
                        className={cn(
                          "truncate",
                          !failedRequest && "text-muted-foreground"
                        )}
                        role="cell"
                      >
                        {request.resourceType}
                      </div>{" "}
                      <div
                        className="text-right font-mono tabular-nums"
                        role="cell"
                      >
                        {formatDuration(request.durationMs)}
                      </div>
                      {onAttach === undefined ? null : (
                        <div className="flex justify-end" role="cell">
                          <Button
                            aria-label={`Attach ${request.method} ${requestName(request.url)}`}
                            onClick={() =>
                              onAttach(
                                requestAttachment(request, {
                                  purpose: "context",
                                })
                              )
                            }
                            size="icon-xs"
                            variant="ghost"
                          >
                            <PaperclipIcon />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <footer className="text-muted-foreground flex shrink-0 gap-3 border-t px-3 py-1.5 text-xs tabular-nums">
          <span>
            {visibleRequests.length === networkRequests.length
              ? requestCount(networkRequests.length)
              : `${visibleRequests.length} of ${requestCount(networkRequests.length)}`}
          </span>
          {failed === 0 ? null : (
            <span className="text-destructive">{failed} failed</span>
          )}
        </footer>
      </ResizablePanel>
      {shownRequest === undefined ? null : (
        <ResizableHandle
          aria-label="Resize request details"
          className={side === "beside" ? "w-1.5" : "h-1.5"}
        />
      )}
      {shownRequest === undefined ? null : (
        <ResizablePanel minSize={`${bounds.detail}px`}>
          <RequestDetailView
            onAttach={onAttach}
            detail={detail}
            detailLoading={detailLoading}
            detailRef={detailPresence.ref}
            detailTab={detailTab}
            leaving={detailPresence.leaving}
            onUpdateUiState={onUpdateUiState}
            request={shownRequest}
          />
        </ResizablePanel>
      )}
    </Resizable>
  );
};

interface DevtoolsHeaderOptions {
  readonly dockSide: DevtoolsDockSide;
  readonly onClear: (() => void) | undefined;
  readonly onClose: () => void;
  readonly onRefresh: (() => void) | undefined;
  readonly onSelectPanel: (panel: DevtoolsPanel) => void;
  readonly onToggleDockSide: () => void;
  readonly panel: DevtoolsPanel;
  readonly refreshDisabled: boolean;
  readonly refreshing: boolean;
  readonly tabTitle: string;
}

const devtoolsPanels: readonly DevtoolsPanel[] = [
  "console",
  "network",
  "storage",
];

const renderDevtoolsHeader = ({
  dockSide,
  onClear,
  onClose,
  onRefresh,
  onSelectPanel,
  onToggleDockSide,
  panel,
  refreshDisabled,
  refreshing,
  tabTitle,
}: DevtoolsHeaderOptions) => (
  <header className="flex h-12 shrink-0 items-center gap-1 pt-1 pr-1.5 pl-2">
    {/* The header switches panels, so the rail need not be reached again. */}
    <ToggleGroup
      aria-label="DevTools panels"
      className="shrink-0 gap-0.5"
      // Pressing the open panel asks to unpress it. The value stays the open
      // panel, so the panel stays pressed, and selecting it again dismisses
      // any card over the stage, as choosing a panel always does.
      onValueChange={([choice]) => onSelectPanel(choice ?? panel)}
      value={[panel]}
    >
      {devtoolsPanels.map((choice) => (
        <Toggle
          className="text-muted-foreground hover:bg-island-hover hover:text-foreground data-pressed:bg-island-hover data-pressed:text-foreground h-[30px] rounded-[10px] px-[11px] text-sm font-medium data-pressed:shadow-[inset_0_0_0_1px_var(--island-border)]"
          key={choice}
          size="sm"
          value={choice}
          variant="ghost"
        >
          {devtoolsPanelTitles[choice]}
        </Toggle>
      ))}
    </ToggleGroup>
    <span className="text-muted-foreground ml-1 min-w-0 flex-1 truncate text-right font-mono text-xs">
      {tabTitle}
    </span>
    <div className="flex shrink-0 items-center gap-0.5">
      {onClear === undefined ? null : (
        <Button
          aria-label={`Clear ${panel} for ${tabTitle}`}
          onClick={onClear}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      )}
      {onRefresh === undefined ? null : (
        <Button
          aria-label={
            panel === "storage" ? "Refresh storage" : "Refresh network requests"
          }
          disabled={refreshDisabled}
          onClick={onRefresh}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
        </Button>
      )}
      <Button
        aria-label={dockSide === "right" ? "Dock to bottom" : "Dock to right"}
        onClick={onToggleDockSide}
        size="icon-sm"
        variant="ghost"
      >
        {dockSide === "right" ? <PanelBottomIcon /> : <PanelRightIcon />}
      </Button>
      <Button
        aria-label="Close DevTools"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  </header>
);

export const BrowserDevtools = ({
  consoleEntries,
  dockSide,
  mutationsLocked,
  networkRequests,
  onClearConsole,
  onClearNetwork,
  onClose,
  onError,
  onRefreshNetwork,
  onSelectPanel,
  onToggleDockSide,
  panel,
  refreshingNetwork,
  tooling,
  tabId,
  tabTitle,
  tabUrl,
}: BrowserDevtoolsProps) => {
  const [refreshingStorage, setRefreshingStorage] = useState(false);
  const [uiState, setUiState] = useAtom(devtoolsUiStateAtoms(tabId));
  const {
    consoleFilter,
    consoleQuery,
    detail,
    detailLoading,
    detailTab,
    networkFilter,
    networkQuery,
    selectedRequestId,
    storageDraft,
    storageSnapshots,
  } = uiState;
  const storageDirty = isStorageDraftDirty(storageDraft, storageSnapshots);
  const updateUiState = (update: Partial<DevtoolsUiState>) => {
    setUiState((current) => ({ ...current, ...update }));
  };
  const updateStorageUiState = (
    update: (current: StoragePanelUiState) => StoragePanelUiState
  ) => {
    setUiState((current) => {
      const slice = storageSlice(current);
      const nextSlice = update(slice);
      if (nextSlice === slice) {
        return current;
      }
      return { ...current, ...nextSlice };
    });
  };

  const detailSelection = useRef<symbol | null>(null);
  useEffect(
    () => () => {
      detailSelection.current = null;
      // The tab atom survives a brief inspector unmount. Its pending fetch
      // cannot publish after invalidation, so retire that transient view too.
      setUiState((current) =>
        current.detailLoading
          ? {
              ...current,
              detail: undefined,
              detailLoading: false,
              selectedRequestId: undefined,
            }
          : current
      );
    },
    [setUiState]
  );
  const selectRequest = (request: BrowserNetworkRequestSummary) => {
    const selection = Symbol("request-detail");
    detailSelection.current = selection;
    const updateSelected = (update: Partial<DevtoolsUiState>) => {
      setUiState((current) =>
        detailSelection.current === selection &&
        current.selectedRequestId === request.requestId
          ? { ...current, ...update }
          : current
      );
    };
    updateUiState({
      detail: undefined,
      detailLoading: true,
      selectedRequestId: request.requestId,
    });
    Effect.runFork(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => tooling.getNetworkRequest(tabId, request.requestId),
      }).pipe(
        Effect.tap((requestDetail) =>
          Effect.sync(() => updateSelected({ detail: requestDetail }))
        ),
        Effect.catchCause(() =>
          Effect.sync(() => updateSelected({ detail: undefined }))
        ),
        Effect.ensuring(
          Effect.sync(() => updateSelected({ detailLoading: false }))
        )
      )
    );
  };

  const clearAction = () => {
    if (panel === "console") {
      return onClearConsole;
    }
    if (panel === "network") {
      return onClearNetwork;
    }
  };

  const refreshAction = () => {
    if (panel === "storage") {
      return () =>
        updateUiState({
          storageRefreshNonce: uiState.storageRefreshNonce + 1,
        });
    }
    if (panel === "network") {
      return onRefreshNetwork;
    }
  };

  return (
    <section
      aria-label={devtoolsPanelTitles[panel]}
      className="flex size-full min-h-0 flex-col"
    >
      {renderDevtoolsHeader({
        dockSide,
        onClear: clearAction(),
        onClose,
        onRefresh: refreshAction(),
        onSelectPanel,
        onToggleDockSide,
        panel,
        refreshDisabled:
          panel === "storage"
            ? refreshingStorage || storageDirty
            : refreshingNetwork,
        refreshing: panel === "storage" ? refreshingStorage : refreshingNetwork,
        tabTitle,
      })}

      <div className="flex min-h-0 flex-1 flex-col">
        {panel === "console" ? (
          <DevtoolsConsolePanel
            consoleEntries={consoleEntries}
            filter={consoleFilter}
            onUpdateUiState={updateUiState}
            query={consoleQuery}
          />
        ) : null}
        {panel === "network" ? (
          <DevtoolsNetworkPanel
            dockSide={dockSide}
            onAttach={tooling.attachBrowserContext}
            detail={detail}
            detailLoading={detailLoading}
            detailTab={detailTab}
            networkFilter={networkFilter}
            networkQuery={networkQuery}
            networkRequests={networkRequests}
            onSelectRequest={selectRequest}
            onUpdateUiState={updateUiState}
            selectedRequestId={selectedRequestId}
          />
        ) : null}
        {panel === "storage" ? (
          <BrowserStoragePanel
            mutationsLocked={mutationsLocked}
            onError={onError}
            onRefreshStateChange={setRefreshingStorage}
            refreshNonce={uiState.storageRefreshNonce}
            tooling={tooling}
            setUiState={updateStorageUiState}
            tabId={tabId}
            tabUrl={tabUrl}
            uiState={storageSlice(uiState)}
          />
        ) : null}
      </div>
    </section>
  );
};
