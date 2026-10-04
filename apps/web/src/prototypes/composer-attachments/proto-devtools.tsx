import {
  ArrowLeftIcon,
  CircleCheckIcon,
  EyeOffIcon,
  GripVerticalIcon,
  PaperclipIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import type { DragEvent, ReactNode } from "react";

import { devtoolsPanelTitles } from "@/components/browser/browser-devtools-panels";
import { SegmentedControl } from "@/components/browser/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  dragType,
  encodeDrag,
  findStep,
  requests,
  storageItems,
} from "./model";
import type {
  DragPayload,
  Evidence,
  MockRequest,
  PrototypeState,
  ResponseValue,
  StorageArea,
} from "./model";
import { MockBadge, StatusPill, StorageIcon } from "./parts";

type Update = (change: (current: PrototypeState) => PrototypeState) => void;

/** How a row reads when the draft already uses it. */
export type RowMark = "check" | "context" | undefined;

/** What a draggable row spreads onto itself. */
interface RowDragProps {
  readonly draggable?: boolean;
  readonly onDragEnd?: () => void;
  readonly onDragStart?: (event: DragEvent) => void;
}

type DragProps = (payload: DragPayload) => RowDragProps;

const SearchField = ({ placeholder }: { readonly placeholder: string }) => (
  <div className="relative min-w-0 flex-1">
    <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
    <Input
      aria-label={placeholder}
      className="bg-muted/40 h-7 border-transparent pl-7 text-xs shadow-none"
      placeholder={placeholder}
    />
  </div>
);

const MarkDot = ({ mark }: { readonly mark: RowMark }) => {
  if (mark === undefined) {
    return <span aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  return mark === "check" ? (
    <CircleCheckIcon
      aria-label="Required"
      className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
    />
  ) : (
    <PaperclipIcon
      aria-label="Attached"
      className="text-muted-foreground size-3.5 shrink-0"
    />
  );
};

/** A row shell: grip, the row's own content, its mark, and one action. */
const Row = ({
  action,
  children,
  draggable,
  dragProps,
  label,
  mark,
}: {
  readonly action: ReactNode;
  readonly children: ReactNode;
  readonly draggable: boolean;
  readonly dragProps: RowDragProps;
  readonly label: string;
  readonly mark: RowMark;
}) => (
  <li
    aria-label={label}
    className={cn(
      "group/row hover:bg-muted/60 focus-within:bg-muted relative flex h-[30px] items-center gap-1 rounded-md pr-1 pl-0.5",
      draggable && "cursor-grab active:cursor-grabbing",
      mark === "check" && "bg-blue-500/5"
    )}
    {...dragProps}
  >
    <GripVerticalIcon
      aria-hidden="true"
      className={cn(
        "text-muted-foreground/60 size-3.5 shrink-0",
        draggable ? "opacity-0 group-hover/row:opacity-100" : "invisible"
      )}
    />
    {children}
    <MarkDot mark={mark} />
    <span className="bg-muted absolute top-1/2 right-1 -translate-y-1/2 rounded-md opacity-0 shadow-sm transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100">
      {action}
    </span>
  </li>
);

const NetworkList = ({
  dragProps,
  draggable,
  markOf,
  onOpen,
  rowAction,
}: {
  readonly dragProps: DragProps;
  readonly draggable: boolean;
  readonly markOf: (id: string) => RowMark;
  readonly onOpen: (request: MockRequest) => void;
  readonly rowAction: (evidence: Evidence) => ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 space-y-2 px-3 py-2">
      <SearchField placeholder="Filter by URL, method, or type" />
      <SegmentedControl
        label="Request type"
        onChange={() => {
          // The mock list has only fetch requests.
        }}
        options={[
          { label: "All", value: "all" },
          { label: "Fetch/XHR", value: "fetch-xhr" },
          { label: "Doc", value: "document" },
          { label: "JS", value: "js" },
        ]}
        size="xs"
        value="all"
      />
    </div>
    <div className="text-muted-foreground grid shrink-0 grid-cols-[3.5rem_minmax(6rem,1fr)_3rem] gap-2 py-1 pr-7 pl-[1.6rem] text-xs font-medium">
      <span>Status</span>
      <span>Name</span>
      <span className="text-right">Step</span>
    </div>
    <ul className="min-h-0 flex-1 overflow-auto px-1.5 text-xs">
      {requests.map((request) => (
        <Row
          action={rowAction(request)}
          dragProps={dragProps({ id: request.id, kind: "evidence" })}
          draggable={draggable}
          key={request.id}
          label={`${request.method} ${request.name}, ${request.status}`}
          mark={markOf(request.id)}
        >
          <button
            className="grid min-w-0 flex-1 grid-cols-[3.5rem_minmax(6rem,1fr)_3rem] items-center gap-2 text-left outline-none"
            onClick={() => onOpen(request)}
            title={request.url}
            type="button"
          >
            <span>
              <StatusPill status={request.status} />
            </span>
            <span className="truncate">
              <span className="text-muted-foreground mr-1.5 font-mono">
                {request.method}
              </span>
              <span className={cn(request.status >= 400 && "text-destructive")}>
                {request.name}
              </span>
            </span>
            <span className="text-muted-foreground text-right tabular-nums">
              {findStep(request.stepId)?.at}
            </span>
          </button>
        </Row>
      ))}
    </ul>
    <footer className="text-muted-foreground flex shrink-0 gap-3 border-t px-3 py-1.5 text-xs tabular-nums">
      <span>{requests.length} requests</span>
      <span className="text-destructive">1 failed</span>
    </footer>
  </div>
);

/** The Response tab, flattened to the fields a check can name. */
const ResponseView = ({
  dragProps,
  draggable,
  fieldAction,
  onBack,
  request,
}: {
  readonly dragProps: DragProps;
  readonly draggable: boolean;
  readonly fieldAction: (
    request: MockRequest,
    field: ResponseValue
  ) => ReactNode;
  readonly onBack: () => void;
  readonly request: MockRequest;
}) => (
  <div className="animate-in fade-in-0 slide-in-from-right-2 flex min-h-0 flex-1 flex-col duration-150">
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
      <Button
        aria-label="Close request details"
        onClick={onBack}
        size="icon-xs"
        variant="ghost"
      >
        <ArrowLeftIcon />
      </Button>
      <StatusPill status={request.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        {request.method} {request.name}
      </span>
      <SegmentedControl
        label="Request detail"
        onChange={() => {
          // Only the Response tab is mocked.
        }}
        options={[
          { label: "Headers", value: "headers" },
          { label: "Response", value: "response" },
        ]}
        size="xs"
        value="response"
      />
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-1.5">
      {request.values.length === 0 ? (
        <p className="text-muted-foreground px-3 py-6 text-center text-xs">
          This response has no fields to check. You can still require that the
          request succeeds.
        </p>
      ) : (
        <ul aria-label="Response fields" className="flex flex-col text-xs">
          {request.values.map((field) => (
            <Row
              action={fieldAction(request, field)}
              dragProps={dragProps({
                key: field.key,
                kind: "field",
                requestId: request.id,
              })}
              draggable={draggable}
              key={field.key}
              label={`${field.key}: ${field.value}`}
              mark={undefined}
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {field.key}
              </span>
              <span className="bg-muted max-w-[40%] truncate rounded px-1.5 py-px font-mono">
                {JSON.stringify(field.value)}
              </span>
            </Row>
          ))}
        </ul>
      )}
      {request.hiddenCount === 0 ? null : (
        <p className="text-muted-foreground flex items-center gap-1.5 px-2.5 pt-2 text-xs">
          <EyeOffIcon aria-hidden="true" className="size-3" />
          {request.hiddenCount} sensitive values are withheld.
        </p>
      )}
      {request.body === undefined ? null : (
        <pre className="bg-muted/40 mt-3 overflow-x-auto rounded-md p-2.5 font-mono text-[0.6875rem] leading-relaxed">
          {JSON.stringify(JSON.parse(request.body), null, 2)}
        </pre>
      )}
    </div>
  </div>
);

const changeText = {
  changed: "changed",
  created: "new",
  unchanged: "",
} as const;

const StorageList = ({
  area,
  dragProps,
  draggable,
  markOf,
  onArea,
  rowAction,
}: {
  readonly area: StorageArea;
  readonly dragProps: DragProps;
  readonly draggable: boolean;
  readonly markOf: (id: string) => RowMark;
  readonly onArea: (area: StorageArea) => void;
  readonly rowAction: (evidence: Evidence) => ReactNode;
}) => {
  const items = storageItems.filter((item) => item.area === area);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3 py-2">
        <SegmentedControl<StorageArea>
          label="Storage kind"
          onChange={onArea}
          options={[
            { label: "Cookies", value: "cookie" },
            { label: "Local", value: "local" },
            { label: "Session", value: "session" },
          ]}
          size="xs"
          value={area}
        />
        <SearchField placeholder="Filter by name" />
      </div>
      <ul className="min-h-0 flex-1 overflow-auto px-1.5 text-xs">
        {items.length === 0 ? (
          <li className="text-muted-foreground grid h-24 place-items-center">
            Nothing stored here.
          </li>
        ) : null}
        {items.map((item) => (
          <Row
            action={rowAction(item)}
            dragProps={dragProps({ id: item.id, kind: "evidence" })}
            draggable={draggable}
            key={item.id}
            label={`${item.key}`}
            mark={markOf(item.id)}
          >
            <span className="grid min-w-0 flex-1 grid-cols-[1rem_minmax(5rem,1fr)_minmax(3rem,0.7fr)_auto] items-center gap-2">
              <span className="text-muted-foreground">
                <StorageIcon item={item} />
              </span>
              <span className="truncate font-mono">{item.key}</span>
              <span className="text-muted-foreground truncate font-mono">
                {item.value}
              </span>
              <span
                className={cn(
                  "rounded px-1 text-[0.625rem] font-medium",
                  item.change === "created" &&
                    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  item.change === "changed" &&
                    "bg-sky-500/10 text-sky-700 dark:text-sky-300"
                )}
              >
                {changeText[item.change]}
              </span>
            </span>
          </Row>
        ))}
      </ul>
    </div>
  );
};

/**
 * PROTOTYPE devtools for the directions that act on rows. They mirror the
 * production Network and Storage panels' header, filter, and row layout,
 * and add what production does not have yet: dragging a row or a response
 * field, and one action button per row.
 */
export const ProtoDevtools = ({
  draggable,
  fieldAction,
  footer,
  markOf,
  rowAction,
  state,
  update,
}: {
  readonly draggable: boolean;
  readonly fieldAction: (
    request: MockRequest,
    field: ResponseValue
  ) => ReactNode;
  readonly footer?: ReactNode;
  readonly markOf: (id: string) => RowMark;
  readonly rowAction: (evidence: Evidence) => ReactNode;
  readonly state: PrototypeState;
  readonly update: Update;
}) => {
  const panel =
    state.devtools === undefined || state.devtools === "checks"
      ? "network"
      : state.devtools;
  const dragProps = (payload: DragPayload): RowDragProps =>
    draggable
      ? {
          draggable: true,
          onDragEnd: () =>
            update((current) => ({ ...current, dragging: undefined })),
          onDragStart: (event: DragEvent) => {
            event.dataTransfer.setData(dragType, encodeDrag(payload));
            event.dataTransfer.effectAllowed = "copy";
            // Starting a drag opens the composer, so there is always
            // somewhere to drop.
            update((current) => ({
              ...current,
              composing: true,
              dragging: payload.kind,
            }));
          },
        }
      : {};
  const detail = requests.find((request) => request.id === state.detailId);
  return (
    <section
      aria-label={devtoolsPanelTitles[panel]}
      className="bg-background flex size-full min-h-0 flex-col"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
        <h2 className="shrink-0 text-sm font-medium">
          {devtoolsPanelTitles[panel]}
        </h2>
        <span className="text-muted-foreground ml-1 min-w-0 truncate text-xs">
          Order received (mock)
        </span>
        <MockBadge className="ml-1" />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            aria-label="Close DevTools"
            onClick={() =>
              update((current) => ({ ...current, devtools: undefined }))
            }
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </header>
      {panel === "network" && detail !== undefined ? (
        <ResponseView
          dragProps={dragProps}
          draggable={draggable}
          fieldAction={fieldAction}
          onBack={() =>
            update((current) => ({ ...current, detailId: undefined }))
          }
          request={detail}
        />
      ) : null}
      {panel === "network" && detail === undefined ? (
        <NetworkList
          dragProps={dragProps}
          draggable={draggable}
          markOf={markOf}
          onOpen={(request) =>
            update((current) => ({ ...current, detailId: request.id }))
          }
          rowAction={rowAction}
        />
      ) : null}
      {panel === "storage" ? (
        <StorageList
          area={state.storageArea}
          dragProps={dragProps}
          draggable={draggable}
          markOf={markOf}
          onArea={(storageArea) =>
            update((current) => ({ ...current, storageArea }))
          }
          rowAction={rowAction}
        />
      ) : null}
      {panel === "console" ? (
        <p className="text-muted-foreground grid flex-1 place-items-center px-6 text-center text-xs">
          Console checks are out of scope in this version.
        </p>
      ) : null}
      {footer}
    </section>
  );
};
