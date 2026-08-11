import type {
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  SessionId,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
import type { HighlightTokenClass } from "@tanstack/highlight";
import { createHighlighter } from "@tanstack/highlight/core";
import { html } from "@tanstack/highlight/languages/html";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CircleAlertIcon,
  CircleXIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { browserNetworkRequestMutation } from "@/lib/rpc";
import { cn } from "@/lib/utils";

type DevtoolsTab = "console" | "network";
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

interface BrowserDevtoolsProps {
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  readonly networkRequests: readonly BrowserNetworkRequest[];
  readonly onClearConsole: () => void;
  readonly onClearNetwork: () => void;
  readonly onClose: () => void;
  readonly onRefreshNetwork: () => void;
  readonly refreshingNetwork: boolean;
  readonly sessionId: SessionId;
  readonly tabId: string;
  readonly tabTitle: string;
}

const detailTabs: readonly NetworkDetailTab[] = [
  "headers",
  "payload",
  "response",
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

const statusClassName = (status: number | undefined): string => {
  if (status === undefined) {
    return "text-muted-foreground";
  }
  if (status >= 400) {
    return "text-destructive";
  }
  if (status >= 300) {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-emerald-600 dark:text-emerald-400";
};

const renderConsoleIcon = (entry: BrowserConsoleEntry) => {
  if (entry.type === "page_error" || entry.level === "error") {
    return <CircleXIcon className="text-destructive mt-0.5 size-3.5" />;
  }
  if (entry.level === "warning" || entry.level === "warn") {
    return (
      <CircleAlertIcon className="mt-0.5 size-3.5 text-amber-600 dark:text-amber-400" />
    );
  }
  return <span className="text-muted-foreground mt-0.5 w-3.5">›</span>;
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

const recordEntries = (
  value: unknown
): readonly (readonly [string, string])[] => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).map(([key, entry]) => [key, String(entry)]);
};

const prettyText = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
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

const tokenClassName = (className: HighlightTokenClass | undefined): string => {
  switch (className) {
    case "comment":
    case "meta": {
      return "text-muted-foreground";
    }
    case "deleted":
    case "keyword":
    case "tag": {
      return "text-red-600 dark:text-red-400";
    }
    case "inserted":
    case "selector": {
      return "text-emerald-600 dark:text-emerald-400";
    }
    case "number":
    case "literal":
    case "property": {
      return "text-blue-600 dark:text-blue-400";
    }
    case "string":
    case "link": {
      return "text-cyan-700 dark:text-cyan-300";
    }
    case "function":
    case "operator":
    case "command": {
      return "text-violet-600 dark:text-violet-400";
    }
    case "attr":
    case "type":
    case "variable": {
      return "text-amber-600 dark:text-amber-400";
    }
    default: {
      return "";
    }
  }
};

const renderHighlightedText = (
  language: "html" | "js" | "json" | "plaintext",
  value: string
) => {
  const { tokens } = highlighter.tokenize(value, { lang: language });
  return (
    <div className="size-full min-h-0 min-w-0 overflow-auto">
      <pre className="min-w-0 p-3 font-mono text-xs break-words whitespace-pre-wrap">
        <code>
          {tokens.map((token, index) => (
            <span
              className={tokenClassName(token.className)}
              key={`${index}-${token.value.slice(0, 8)}`}
            >
              {token.value}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
};

const renderHeaderSection = (label: string, value: unknown) => {
  const entries = recordEntries(value);
  return (
    <section className="border-b p-3">
      <h3 className="mb-2 text-xs font-semibold">{label}</h3>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">No headers recorded.</p>
      ) : (
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-1 font-mono text-xs">
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
        <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
        Loading request details…
      </div>
    );
  }

  const resolved = detail ?? request;
  if (detailTab === "headers") {
    return (
      <div className="size-full overflow-auto">
        <section className="border-b p-3">
          <h3 className="mb-2 text-xs font-semibold">General</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <dt className="text-muted-foreground">Request URL</dt>
            <dd className="break-all">{resolved.url}</dd>
            <dt className="text-muted-foreground">Request Method</dt>
            <dd>{resolved.method}</dd>
            <dt className="text-muted-foreground">Status Code</dt>
            <dd className={statusClassName(resolved.status)}>
              {resolved.status ?? "Pending"}
            </dd>
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

  if (detailTab === "response") {
    const body = prettyText(detail?.responseBody);
    return body.length === 0 ? (
      <div className="text-muted-foreground grid size-full place-items-center px-4 text-center text-xs">
        The response body is unavailable. It may have been evicted by Chromium
        or belong to a previous tab target.
      </div>
    ) : (
      renderHighlightedText(responseLanguage(resolved.mimeType, body), body)
    );
  }

  return null;
};

interface DevtoolsHeaderOptions {
  readonly consoleCount: number;
  readonly networkCount: number;
  readonly onClear: () => void;
  readonly onClose: () => void;
  readonly onRefreshNetwork: () => void;
  readonly refreshingNetwork: boolean;
  readonly tab: DevtoolsTab;
  readonly tabTitle: string;
}

const renderDevtoolsHeader = ({
  consoleCount,
  networkCount,
  onClear,
  onClose,
  onRefreshNetwork,
  refreshingNetwork,
  tab,
  tabTitle,
}: DevtoolsHeaderOptions) => (
  <div className="flex h-9 shrink-0 items-center border-b px-2">
    <TabsList className="h-8 p-0" variant="line">
      <TabsTrigger value="console">
        Console
        <span className="text-muted-foreground tabular-nums">
          {consoleCount}
        </span>
      </TabsTrigger>
      <TabsTrigger value="network">
        Network
        <span className="text-muted-foreground tabular-nums">
          {networkCount}
        </span>
      </TabsTrigger>
    </TabsList>
    <span className="text-muted-foreground ml-2 min-w-0 truncate text-[11px]">
      {tabTitle}
    </span>
    <div className="ml-auto flex items-center gap-0.5">
      <Button
        aria-label={`Clear ${tab} for ${tabTitle}`}
        onClick={onClear}
        size="icon-sm"
        variant="ghost"
      >
        <Trash2Icon />
      </Button>
      {tab === "network" ? (
        <Button
          aria-label="Refresh network requests"
          disabled={refreshingNetwork}
          onClick={onRefreshNetwork}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshCwIcon
            className={refreshingNetwork ? "animate-spin" : undefined}
          />
        </Button>
      ) : null}
      <Button
        aria-label="Close DevTools"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  </div>
);

export const BrowserDevtools = ({
  consoleEntries,
  networkRequests,
  onClearConsole,
  onClearNetwork,
  onClose,
  onRefreshNetwork,
  refreshingNetwork,
  sessionId,
  tabTitle,
}: BrowserDevtoolsProps) => {
  const consoleScrollRef = useRef<HTMLDivElement>(null);
  const networkScrollRef = useRef<HTMLDivElement>(null);
  const getNetworkRequest = useAtomSet(browserNetworkRequestMutation, {
    mode: "promise",
  });
  const [detail, setDetail] = useState<BrowserNetworkRequestDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<NetworkDetailTab>("headers");
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>("all");
  const [networkQuery, setNetworkQuery] = useState("");
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [tab, setTab] = useState<DevtoolsTab>("console");
  const normalizedQuery = networkQuery.trim().toLocaleLowerCase();
  const visibleRequests = useMemo(
    () =>
      networkRequests.filter(
        (request) =>
          requestMatchesFilter(request, networkFilter) &&
          (normalizedQuery.length === 0 ||
            request.url.toLocaleLowerCase().includes(normalizedQuery) ||
            request.method.toLocaleLowerCase().includes(normalizedQuery) ||
            request.resourceType.toLocaleLowerCase().includes(normalizedQuery))
      ),
    [networkFilter, networkRequests, normalizedQuery]
  );
  const selectedRequest = networkRequests.find(
    ({ requestId }) => requestId === selectedRequestId
  );
  const consoleVirtualizer = useVirtualizer({
    count: consoleEntries.length,
    estimateSize: () => 34,
    getScrollElement: () => consoleScrollRef.current,
    overscan: 12,
  });
  const networkVirtualizer = useVirtualizer({
    count: visibleRequests.length,
    estimateSize: () => 30,
    getScrollElement: () => networkScrollRef.current,
    overscan: 16,
  });

  useEffect(() => {
    const frame = globalThis.requestAnimationFrame(() => {
      if (tab === "network") {
        networkVirtualizer.measure();
      } else {
        consoleVirtualizer.measure();
      }
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [consoleVirtualizer, networkVirtualizer, tab]);

  const selectRequest = async (request: BrowserNetworkRequest) => {
    setSelectedRequestId(request.requestId);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      const result = await getNetworkRequest({
        payload: {
          data: { requestId: request.requestId, sessionId },
          type: "browser.network.request.get",
        },
      });
      setDetail(result.data.request);
    } catch {
      setDetail(undefined);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <Tabs
      className="bg-background size-full min-h-0 gap-0"
      onValueChange={(value) => setTab(value as DevtoolsTab)}
      value={tab}
    >
      {renderDevtoolsHeader({
        consoleCount: consoleEntries.length,
        networkCount: networkRequests.length,
        onClear: tab === "console" ? onClearConsole : onClearNetwork,
        onClose,
        onRefreshNetwork,
        refreshingNetwork,
        tab,
        tabTitle,
      })}

      <TabsContent className="min-h-0" value="console">
        <div className="size-full overflow-auto" ref={consoleScrollRef}>
          {consoleEntries.length === 0 ? (
            <div className="text-muted-foreground grid h-28 place-items-center text-xs">
              Console messages for this tab will appear here.
            </div>
          ) : (
            <div
              className="relative w-full font-mono text-xs"
              style={{ height: consoleVirtualizer.getTotalSize() }}
            >
              {consoleVirtualizer.getVirtualItems().map((virtualRow) => {
                const entry = consoleEntries[virtualRow.index];
                if (entry === undefined) {
                  return null;
                }
                return (
                  <div
                    className="absolute top-0 left-0 grid w-full grid-cols-[auto_1fr_auto] gap-2 border-b px-2 py-1.5"
                    data-index={virtualRow.index}
                    key={virtualRow.key}
                    ref={consoleVirtualizer.measureElement}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {renderConsoleIcon(entry)}
                    <pre className="font-inherit min-w-0 overflow-x-auto break-words whitespace-pre-wrap">
                      {entry.text}
                    </pre>
                    <time className="text-muted-foreground tabular-nums">
                      {formatTime(entry.timestamp)}
                    </time>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </TabsContent>

      <TabsContent className="flex min-h-0 flex-col" value="network">
        <div className="shrink-0 border-b p-1.5">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <Input
              aria-label="Filter network requests"
              className="h-7 pl-7 text-xs"
              onChange={(event) => setNetworkQuery(event.target.value)}
              placeholder="Filter by URL, method, or type"
              value={networkQuery}
            />
          </div>
          <div className="mt-1.5 flex gap-1 overflow-x-auto" role="group">
            {networkFilters.map((filter) => (
              <Button
                aria-pressed={networkFilter === filter.value}
                className="h-6 rounded-full px-2 text-[11px]"
                key={filter.value}
                onClick={() => setNetworkFilter(filter.value)}
                size="sm"
                variant={networkFilter === filter.value ? "secondary" : "ghost"}
              >
                {filter.label}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "flex min-w-0 flex-col",
              selectedRequest === undefined ? "flex-1" : "w-1/2 border-r"
            )}
          >
            <div className="text-muted-foreground grid shrink-0 grid-cols-[3.5rem_3.5rem_minmax(10rem,1fr)_5rem] border-b px-2 py-1 text-[11px] font-medium">
              <span>Status</span>
              <span>Method</span>
              <span>Name</span>
              <span>Type</span>
            </div>
            <div
              className="min-h-0 flex-1 overflow-auto"
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
                  className="relative w-full font-mono text-xs"
                  style={{ height: networkVirtualizer.getTotalSize() }}
                >
                  {networkVirtualizer.getVirtualItems().map((virtualRow) => {
                    const request = visibleRequests[virtualRow.index];
                    if (request === undefined) {
                      return null;
                    }
                    return (
                      <button
                        className={cn(
                          "hover:bg-muted/50 absolute top-0 left-0 grid h-[30px] w-full grid-cols-[3.5rem_3.5rem_minmax(10rem,1fr)_5rem] items-center px-2 text-left",
                          selectedRequestId === request.requestId && "bg-muted"
                        )}
                        key={virtualRow.key}
                        onClick={() => {
                          void selectRequest(request);
                        }}
                        style={{
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                        title={request.url}
                        type="button"
                      >
                        <span className={statusClassName(request.status)}>
                          {request.status ?? "—"}
                        </span>
                        <span>{request.method}</span>
                        <span className="truncate">
                          {requestName(request.url)}
                        </span>
                        <span className="text-muted-foreground truncate">
                          {request.resourceType}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          {selectedRequest === undefined ? null : (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b px-1">
                {detailTabs.map((detailTabValue) => (
                  <Button
                    className="h-7 rounded-none px-2 text-[11px] capitalize"
                    key={detailTabValue}
                    onClick={() => setDetailTab(detailTabValue)}
                    size="sm"
                    variant={
                      detailTab === detailTabValue ? "secondary" : "ghost"
                    }
                  >
                    {detailTabValue}
                  </Button>
                ))}
                <Button
                  aria-label="Close request details"
                  className="ml-auto"
                  onClick={() => setSelectedRequestId(undefined)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {renderRequestDetails(
                  detail,
                  detailTab,
                  detailLoading,
                  selectedRequest
                )}
              </div>
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
};
