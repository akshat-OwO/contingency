import type {
  TeachingBrowserAttachment,
  BrowserConsoleEntry,
  BrowserNetworkRequest,
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
  ArrowLeftIcon,
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
import { HighlightedCode } from "@/components/browser/highlighted-code";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  readonly networkRequests: readonly BrowserNetworkRequest[];
  readonly onClearConsole: () => void;
  readonly onClearNetwork: () => void;
  readonly onClose: () => void;
  readonly onError: (message: string) => void;
  readonly onRefreshNetwork: () => void;
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
  request: BrowserNetworkRequest,
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

type NetworkHeaders = BrowserNetworkRequest["headers"] | null | undefined;

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
      aria-label={label}
      className="bg-muted/40 h-7 border-transparent pl-7 text-xs shadow-none"
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
  loading: boolean,
  request: BrowserNetworkRequest
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

  const resolved = detail ?? request;
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
        {renderHeaderSection("Response Headers", resolved.responseHeaders)}
        {renderHeaderSection("Request Headers", resolved.headers)}
      </div>
    );
  }

  if (detailTab === "payload") {
    const payload = prettyText(resolved.postData);
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
        <SegmentedControl
          label="Console level"
          onChange={(consoleFilter) => onUpdateUiState({ consoleFilter })}
          options={[
            { count: consoleEntries.length, label: "All", value: "all" },
            { count: errors, label: "Errors", value: "error" },
            { count: warnings, label: "Warnings", value: "warning" },
            { label: "Logs", value: "log" },
          ]}
          value={filter}
        />
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

const RequestDetailView = ({
  onAttach,
  detail,
  detailLoading,
  detailTab,
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
  readonly request: BrowserNetworkRequest;
}) => (
  <div className="animate-in fade-in-0 slide-in-from-right-2 flex size-full min-h-0 flex-col duration-150">
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
      <Button
        aria-label="Close request details"
        onClick={() => onUpdateUiState({ selectedRequestId: undefined })}
        size="icon-xs"
        variant="ghost"
      >
        <ArrowLeftIcon />
      </Button>
      <StatusPill status={request.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {request.method} {requestName(request.url)}
      </span>
      <SegmentedControl
        label="Request detail"
        onChange={(value) => onUpdateUiState({ detailTab: value })}
        options={detailTabs}
        size="xs"
        value={detailTab}
      />
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
        renderRequestDetails(detail, detailTab, detailLoading, request)
      )}
    </div>
  </div>
);

const DevtoolsNetworkPanel = ({
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
  readonly onAttach:
    | ((attachment: TeachingBrowserAttachment) => void)
    | undefined;
  readonly detail: BrowserNetworkRequestDetail | undefined;
  readonly detailLoading: boolean;
  readonly detailTab: NetworkDetailTab;
  readonly networkFilter: NetworkFilter;
  readonly networkQuery: string;
  readonly networkRequests: readonly BrowserNetworkRequest[];
  readonly onSelectRequest: (request: BrowserNetworkRequest) => void;
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

  if (selectedRequest !== undefined) {
    return (
      <RequestDetailView
        onAttach={onAttach}
        detail={detail}
        detailLoading={detailLoading}
        detailTab={detailTab}
        onUpdateUiState={onUpdateUiState}
        request={selectedRequest}
      />
    );
  }

  const failed = networkRequests.filter(
    ({ status }) => status !== undefined && status >= 400
  ).length;

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 px-3 py-2">
        <SearchField
          label="Filter network requests"
          onChange={(value) => onUpdateUiState({ networkQuery: value })}
          placeholder="Filter by URL, method, or type"
          value={networkQuery}
        />
        <div className="overflow-x-auto">
          <SegmentedControl
            label="Request type"
            onChange={(value) => onUpdateUiState({ networkFilter: value })}
            options={networkFilters}
            size="xs"
            value={networkFilter}
          />
        </div>
      </div>
      <div className="text-muted-foreground grid shrink-0 grid-cols-[3.5rem_minmax(8rem,1fr)_4.5rem_4.5rem] gap-2 px-4 py-1 text-xs font-medium">
        <span>Status</span>
        <span>Name</span>
        <span>Type</span>
        <span className="text-right">Time</span>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-1.5"
        ref={networkScrollRef}
      >
        {visibleRequests.length === 0 ? (
          <div className="text-muted-foreground grid h-24 place-items-center px-4 text-center text-xs">
            {networkRequests.length === 0
              ? "Network requests for this tab will appear here."
              : "No requests match this filter."}
          </div>
        ) : (
          <div
            className="relative w-full text-xs"
            style={{ height: networkVirtualizer.getTotalSize() }}
          >
            {networkVirtualizer.getVirtualItems().map((virtualRow) => {
              const request = visibleRequests[virtualRow.index];
              if (request === undefined) {
                return null;
              }
              const failedRequest =
                request.status !== undefined && request.status >= 400;
              return (
                <div
                  className={cn(
                    "hover:bg-muted/60 absolute top-0 left-0 grid h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left",
                    onAttach === undefined
                      ? "grid-cols-[minmax(8rem,1fr)_4.5rem]"
                      : "grid-cols-[minmax(8rem,1fr)_2rem]"
                  )}
                  key={virtualRow.key}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                  draggable={onAttach !== undefined}
                  onDragStart={(event) =>
                    dragAttachment(
                      event,
                      requestAttachment(request, { purpose: "context" })
                    )
                  }
                  title={request.url}
                >
                  <button
                    className="grid min-w-0 grid-cols-[3.5rem_minmax(8rem,1fr)_4.5rem] items-center gap-2 text-left"
                    onClick={() => onSelectRequest(request)}
                    type="button"
                  >
                    <span>
                      <StatusPill status={request.status} />
                    </span>
                    <span className="truncate">
                      <span className="text-muted-foreground mr-1.5 font-mono">
                        {request.method}
                      </span>
                      <span className={cn(failedRequest && "text-destructive")}>
                        {requestName(request.url)}
                      </span>
                    </span>
                    <span className="text-muted-foreground truncate">
                      {request.resourceType}
                    </span>
                  </button>
                  {onAttach === undefined ? (
                    <time className="text-muted-foreground tabular-nums">
                      {formatTime(request.timestamp)}
                    </time>
                  ) : (
                    <Button
                      aria-label={`Attach ${request.method} ${requestName(request.url)}`}
                      size="icon-xs"
                      variant="ghost"
                      onClick={() =>
                        onAttach(
                          requestAttachment(request, { purpose: "context" })
                        )
                      }
                    >
                      <PaperclipIcon />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <footer className="text-muted-foreground flex shrink-0 gap-3 border-t px-3 py-1.5 text-xs tabular-nums">
        <span>
          {visibleRequests.length === networkRequests.length
            ? `${networkRequests.length} requests`
            : `${visibleRequests.length} of ${networkRequests.length} requests`}
        </span>
        {failed === 0 ? null : (
          <span className="text-destructive">{failed} failed</span>
        )}
      </footer>
    </div>
  );
};

interface DevtoolsHeaderOptions {
  readonly dockSide: DevtoolsDockSide;
  readonly onClear: (() => void) | undefined;
  readonly onClose: () => void;
  readonly onRefresh: (() => void) | undefined;
  readonly onToggleDockSide: () => void;
  readonly panel: DevtoolsPanel;
  readonly refreshDisabled: boolean;
  readonly refreshing: boolean;
  readonly tabTitle: string;
}

const renderDevtoolsHeader = ({
  dockSide,
  onClear,
  onClose,
  onRefresh,
  onToggleDockSide,
  panel,
  refreshDisabled,
  refreshing,
  tabTitle,
}: DevtoolsHeaderOptions) => (
  <header className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
    <h2 className="shrink-0 text-sm font-medium">
      {devtoolsPanelTitles[panel]}
    </h2>
    <span className="text-muted-foreground ml-1 min-w-0 truncate text-xs">
      {tabTitle}
    </span>
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
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

  const selectRequest = (request: BrowserNetworkRequest) => {
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
          Effect.sync(() => updateUiState({ detail: requestDetail }))
        ),
        Effect.catchCause(() =>
          Effect.sync(() => updateUiState({ detail: undefined }))
        ),
        Effect.ensuring(
          Effect.sync(() => updateUiState({ detailLoading: false }))
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
      className="bg-background flex size-full min-h-0 flex-col"
    >
      {renderDevtoolsHeader({
        dockSide,
        onClear: clearAction(),
        onClose,
        onRefresh: refreshAction(),
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
