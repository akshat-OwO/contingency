import {
  CookieIcon,
  CrosshairIcon,
  DatabaseIcon,
  EyeOffIcon,
  FlaskConicalIcon,
  PencilIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

import {
  describe,
  evidenceOf,
  evidenceTitle,
  findStep,
  isStale,
  lastStepId,
  requests,
  steps,
  storageChangeLabels,
  storageItems,
} from "./model";
import type {
  Check,
  Condition,
  Draft,
  Evidence,
  MockRequest,
  MockStorage,
  StorageChange,
  ResponseValue,
} from "./model";

/** Marks anything mocked so it is never mistaken for a live observation. */
export const MockBadge = ({ className }: { readonly className?: string }) => (
  <span
    className={cn(
      "inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-amber-500/60 bg-amber-500/10 px-1.5 py-px text-[0.625rem] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300",
      className
    )}
  >
    <FlaskConicalIcon aria-hidden="true" className="size-3" />
    Mock
  </span>
);

const statusTone = (status: number) => {
  if (status >= 400) {
    return "bg-destructive/10 text-destructive";
  }
  if (status >= 300) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
};

/** The status pill the browser devtools Network panel uses. */
export const StatusPill = ({ status }: { readonly status: number }) => (
  <span
    className={cn(
      "inline-block rounded px-1.5 py-px font-mono text-xs font-medium tabular-nums",
      statusTone(status)
    )}
  >
    {status}
  </span>
);

const stepAt = (stepId: string) => findStep(stepId)?.at ?? "";

/** One request, laid out like a row of the devtools Network panel. */
export const RequestRow = ({ request }: { readonly request: MockRequest }) => (
  <span className="grid w-full grid-cols-[3.5rem_minmax(8rem,1fr)_3rem_3rem] items-center gap-2 text-xs">
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
    <span className="text-muted-foreground truncate">{request.type}</span>
    <span className="text-muted-foreground text-right tabular-nums">
      {stepAt(request.stepId)}
    </span>
  </span>
);

const storageChangeTone: Record<MockStorage["change"], string> = {
  changed: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  created: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  unchanged: "bg-muted text-muted-foreground",
};

const areaLabels: Record<MockStorage["area"], string> = {
  cookie: "cookie",
  local: "local storage",
  session: "session storage",
};

const storageChangeText: Record<MockStorage["change"], string> = {
  changed: "changed",
  created: "new",
  unchanged: "already there",
};

export const StorageIcon = ({ item }: { readonly item: MockStorage }) =>
  item.area === "cookie" ? (
    <CookieIcon aria-hidden="true" className="size-3.5 shrink-0" />
  ) : (
    <DatabaseIcon aria-hidden="true" className="size-3.5 shrink-0" />
  );

/** One stored key. Never its value. */
export const StorageRow = ({ item }: { readonly item: MockStorage }) => (
  <span className="grid w-full grid-cols-[1rem_minmax(6rem,1fr)_auto_3rem] items-center gap-2 text-xs">
    <span className="text-muted-foreground">
      <StorageIcon item={item} />
    </span>
    <span className="truncate font-mono">{item.key}</span>
    <span
      className={cn(
        "rounded px-1.5 py-px text-[0.6875rem] font-medium",
        storageChangeTone[item.change]
      )}
    >
      {areaLabels[item.area]} ·{" "}
      {item.observed === false
        ? "not observed"
        : storageChangeText[item.change]}
    </span>
    <span className="text-muted-foreground text-right tabular-nums">
      {stepAt(item.stepId)}
    </span>
  </span>
);

export const EvidenceRow = ({ evidence }: { readonly evidence: Evidence }) =>
  evidence.kind === "request" ? (
    <RequestRow request={evidence} />
  ) : (
    <StorageRow item={evidence} />
  );

const lastStep = findStep(lastStepId);

/**
 * A searchable list of what the page did, split at the last step: anything
 * from before it cannot show what that step caused.
 */
export const EvidencePicker = ({
  autoFocus = true,
  kind,
  onPick,
  pickedIds,
  onNewCookie,
}: {
  readonly autoFocus?: boolean;
  readonly kind: "all" | "request" | "storage";
  readonly onPick: (evidence: Evidence) => void;
  readonly pickedIds: ReadonlySet<string>;
  readonly onNewCookie?: ((name: string) => void) | undefined;
}) => {
  const cookieName = useRef<HTMLInputElement>(null);
  const items: readonly Evidence[] = [
    ...(kind === "storage" ? [] : requests),
    ...(kind === "request" ? [] : storageItems),
  ];
  const renderItem = (item: Evidence) => (
    <CommandItem
      data-checked={pickedIds.has(item.id)}
      key={item.id}
      onSelect={() => onPick(item)}
      value={`${item.id} ${evidenceTitle(item)}`}
    >
      <EvidenceRow evidence={item} />
    </CommandItem>
  );
  let placeholder = "Search requests and storage";
  if (kind === "request") {
    placeholder = "Search requests";
  } else if (kind === "storage") {
    placeholder = "Search cookies and storage";
  }
  return (
    <div>
      <Command className="rounded-lg! p-0">
        <CommandInput autoFocus={autoFocus} placeholder={placeholder} />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup
            heading={`Since your last step · ${lastStep?.label ?? ""}`}
          >
            {items.flatMap((item) =>
              item.stepId === lastStepId ? [renderItem(item)] : []
            )}
          </CommandGroup>
          <CommandGroup heading="Earlier in the recording">
            {items.flatMap((item) =>
              item.stepId === lastStepId ? [] : [renderItem(item)]
            )}
          </CommandGroup>
        </CommandList>
      </Command>
      {onNewCookie === undefined ? null : (
        <div className="mt-2 flex flex-col gap-2 border-t px-2 pt-3 pb-2">
          <p className="text-muted-foreground text-xs">
            Expect a cookie you haven’t seen yet? Attach its name. This does not
            create a cookie.
          </p>
          <label className="flex flex-col gap-1 text-xs">
            Cookie name
            <input
              className="bg-background h-8 rounded-md border px-2 font-mono"
              ref={cookieName}
              placeholder="e.g. checkout-complete"
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const name = cookieName.current?.value.trim();
              if (name !== undefined && name !== "") {
                onNewCookie(name);
              } else {
                cookieName.current?.focus();
              }
            }}
          >
            Attach cookie name
          </Button>
        </div>
      )}
    </div>
  );
};

/** Native disclosure controls keep nested fields keyboard accessible. */
export const ResponseFieldTree = ({
  fields,
  depth = 0,
  selected,
  onPick,
}: {
  readonly fields: readonly ResponseValue[];
  readonly depth?: number;
  readonly selected: string;
  readonly onPick: (field: ResponseValue) => void;
}) => {
  const groups = new Map<string, ResponseValue[]>();
  for (const field of fields) {
    const segment = (field.segments ?? [field.key])[depth];
    if (segment === undefined) {
      continue;
    }
    const group = groups.get(segment) ?? [];
    group.push(field);
    groups.set(segment, group);
  }
  return (
    <div className="flex flex-col gap-1">
      {[...groups].map(([segment, children]) => {
        const [first] = children;
        if (first === undefined) {
          return null;
        }
        const label = segment;
        const leaf = (first.segments ?? [first.key]).length === depth + 1;
        return leaf ? (
          <button
            aria-label={`Select response field ${first.key}`}
            aria-pressed={selected === first.key}
            className={cn(
              "hover:bg-muted flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs",
              selected === first.key && "bg-muted ring-1 ring-blue-500/40"
            )}
            key={segment}
            onClick={() => onPick(first)}
            type="button"
          >
            <span className="font-mono">{label}</span>
            <span className="text-muted-foreground truncate">
              {first.value}
            </span>
          </button>
        ) : (
          <details key={segment} open>
            <summary className="cursor-pointer rounded px-2 py-1 font-mono text-xs">
              {label}
            </summary>
            <div className="ml-3 border-l pl-2">
              <ResponseFieldTree
                depth={depth + 1}
                fields={children}
                onPick={onPick}
                selected={selected}
              />
            </div>
          </details>
        );
      })}
    </div>
  );
};

/** The step that should cause the condition, or none to check right now. */
export const StepSelect = ({
  onChange,
  value,
}: {
  readonly onChange: (stepId: string | undefined) => void;
  readonly value: string | undefined;
}) => (
  <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
    <span className="shrink-0">After this action</span>
    <select
      className="bg-background text-foreground focus-visible:ring-ring/50 h-7 min-w-0 rounded-md border px-1.5 text-xs outline-none focus-visible:ring-2"
      onChange={(event) =>
        onChange(event.target.value === "" ? undefined : event.target.value)
      }
      value={value ?? ""}
    >
      {steps.toReversed().map((step) => (
        <option key={step.id} value={step.id}>
          {step.label} · {step.at}
          {step.id === lastStepId ? " (your last step)" : ""}
        </option>
      ))}
      <option value="">Check current state</option>
    </select>
  </label>
);

const Choice = ({
  checked,
  children,
  name,
  onSelect,
}: {
  readonly checked: boolean;
  readonly children: React.ReactNode;
  readonly name: string;
  readonly onSelect: () => void;
}) => (
  <label className="hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm">
    <input
      checked={checked}
      className="accent-primary"
      name={name}
      onChange={onSelect}
      type="radio"
    />
    {children}
  </label>
);

export const RequestChoices = ({
  check,
  onChange,
  request,
}: {
  readonly check: Extract<Check, { kind: "request" }>;
  readonly onChange: (check: Check) => void;
  readonly request: MockRequest;
}) => {
  const name = `expect-${request.id}`;
  return (
    <fieldset className="flex flex-col">
      <legend className="sr-only">What should it return?</legend>
      <Choice
        checked={check.expect.kind === "succeeds"}
        name={name}
        onSelect={() => onChange({ ...check, expect: { kind: "succeeds" } })}
      >
        It succeeds
      </Choice>
      {request.values.length > 0 ? (
        <Choice
          checked={check.expect.kind === "value"}
          name={name}
          onSelect={() => {
            const [first] = request.values;
            if (first !== undefined) {
              onChange({ ...check, expect: { ...first, kind: "value" } });
            }
          }}
        >
          Check a response field
        </Choice>
      ) : null}
      {check.expect.kind === "value" ? (
        <div className="ml-6 flex flex-col gap-2 py-2">
          <span className="text-xs">Select a response field</span>
          <div className="bg-background max-h-48 overflow-auto rounded-md border p-1">
            <ResponseFieldTree
              fields={request.values}
              selected={check.expect.key}
              onPick={(field) =>
                onChange({ ...check, expect: { ...field, kind: "value" } })
              }
            />
          </div>
          <p className="text-xs">
            Selected path:{" "}
            <span className="font-mono break-all">{check.expect.key}</span>
          </p>
          <p className="text-muted-foreground text-xs">
            Observed:{" "}
            <span className="font-mono">
              {
                request.values.find(
                  (item) =>
                    item.key ===
                    (check.expect.kind === "value" ? check.expect.key : "")
                )?.value
              }
            </span>
          </p>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              Match
              <select
                className="bg-background h-8 rounded-md border px-2"
                value={check.expect.operator ?? "equals"}
                onChange={(event) => {
                  if (check.expect.kind === "value") {
                    onChange({
                      ...check,
                      expect: {
                        ...check.expect,
                        operator:
                          event.target.value === "contains"
                            ? "contains"
                            : "equals",
                      },
                    });
                  }
                }}
              >
                <option value="equals">Equals</option>
                <option value="contains">Contains</option>
              </select>
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              Expected value
              <input
                className="bg-background h-8 min-w-0 rounded-md border px-2 font-mono"
                value={check.expect.value}
                onChange={(event) => {
                  if (check.expect.kind === "value") {
                    onChange({
                      ...check,
                      expect: { ...check.expect, value: event.target.value },
                    });
                  }
                }}
              />
            </label>
          </div>
        </div>
      ) : null}
      {request.hiddenCount === 0 ? null : (
        <p className="text-muted-foreground flex items-center gap-1.5 px-1.5 pt-1 text-xs">
          <EyeOffIcon aria-hidden="true" className="size-3" />
          {request.hiddenCount} sensitive values are withheld from this preview.
        </p>
      )}
    </fieldset>
  );
};

export const StorageChoices = ({
  check,
  item,
  onChange,
}: {
  readonly check: Extract<Check, { kind: "storage" }>;
  readonly item: MockStorage;
  readonly onChange: (check: Check) => void;
}) => (
  <fieldset className="flex flex-col">
    <legend className="sr-only">What should happen to it?</legend>
    {(["created", "changed", "removed", "present"] as const).map(
      (change: StorageChange) => (
        <Choice
          checked={check.change === change}
          key={change}
          name={`change-${item.id}`}
          onSelect={() => onChange({ ...check, change })}
        >
          {storageChangeLabels[change]}
        </Choice>
      )
    )}
    {item.area === "cookie" ? (
      <p className="text-muted-foreground flex items-center gap-1.5 px-1.5 pt-1 text-xs">
        <EyeOffIcon aria-hidden="true" className="size-3" />
        This check uses the cookie name without exposing its value.
      </p>
    ) : null}
  </fieldset>
);

/** One attached request or stored key and what it should do. */
export const CheckCard = ({
  check,
  onChange,
  onRemove,
  stepId,
}: {
  readonly check: Check;
  readonly onChange: (check: Check) => void;
  readonly onRemove: () => void;
  readonly stepId: string | undefined;
}) => {
  const evidence = evidenceOf(check);
  if (evidence === undefined) {
    return null;
  }
  return (
    <div className="bg-muted/40 flex flex-col gap-1 rounded-xl p-2 ring-1 ring-blue-500/20">
      <div className="flex items-center gap-2 pl-1.5">
        <span className="min-w-0 flex-1">
          <EvidenceRow evidence={evidence} />
        </span>
        <Button
          aria-label={`Remove ${evidenceTitle(evidence)}`}
          onClick={onRemove}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {check.kind === "request" && evidence.kind === "request" ? (
        <RequestChoices check={check} onChange={onChange} request={evidence} />
      ) : null}
      {check.kind === "storage" && evidence.kind === "storage" ? (
        <StorageChoices check={check} item={evidence} onChange={onChange} />
      ) : null}
      {isStale(check, stepId) ? (
        <p className="flex items-start gap-1.5 px-1.5 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-3 shrink-0"
          />
          This happened before that step, so it can’t show what the step did.
          Later Runs will wait for a new one.
        </p>
      ) : null}
    </div>
  );
};

/** The sentence later Runs will check, read back before adding. */
export const SentencePreview = ({
  draft,
}: {
  readonly draft: Pick<Draft, "checks" | "note" | "scan" | "stepId">;
}) => {
  const sentence = describe(draft);
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-0.5 border-l-2 border-blue-500/50 pl-3"
    >
      <span className="text-muted-foreground text-xs font-medium">
        Later Runs will check
      </span>
      <p className="text-sm text-pretty">{sentence.text}</p>
      {sentence.guard === undefined ? null : (
        <p className="text-muted-foreground text-xs text-pretty">
          {sentence.guard}
        </p>
      )}
    </div>
  );
};

/** Earlier in this recording: the comment history, with edit and remove. */
export const ConditionHistory = ({
  conditions,
  editingId,
  onEdit,
  onRemove,
}: {
  readonly conditions: readonly Condition[];
  readonly editingId: string | undefined;
  readonly onEdit: (condition: Condition) => void;
  readonly onRemove: (id: string) => void;
}) => {
  if (conditions.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-6 text-center text-sm">
        No comments yet.
      </p>
    );
  }
  return (
    <ul
      aria-label="Earlier comments"
      className="flex max-h-48 flex-col gap-0.5 overflow-y-auto overscroll-contain"
    >
      {conditions
        .map((condition, position) => ({ condition, index: position + 1 }))
        .toReversed()
        .map(({ condition, index }) => (
          <li
            className={cn(
              "hover:bg-muted flex gap-3 rounded-lg px-2.5 py-2 transition-colors",
              condition.id === editingId && "bg-muted"
            )}
            key={condition.id}
          >
            <span
              aria-hidden="true"
              className="bg-primary text-primary-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums"
            >
              {index}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm leading-snug text-pretty">
                {describe(condition).text ||
                  (condition.element === undefined
                    ? "Attached context"
                    : `About the ${condition.element.description}`)}
              </span>
              {condition.element === undefined ? null : (
                <span className="inline-flex min-w-0 items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                  <CrosshairIcon
                    aria-hidden="true"
                    className="size-3 shrink-0"
                  />
                  <span className="truncate">
                    {condition.element.description}
                  </span>
                </span>
              )}
              {condition.attachments?.map((evidence) => (
                <span
                  className="text-muted-foreground text-xs"
                  key={evidence.id}
                >
                  Attachment: {evidenceTitle(evidence)}
                </span>
              ))}
              <span className="text-muted-foreground font-mono text-xs tabular-nums">
                {findStep(condition.stepId)?.at ?? "now"}
              </span>
            </span>
            <span className="flex shrink-0 gap-0.5">
              <Button
                aria-label={`Edit comment ${index}`}
                onClick={() => onEdit(condition)}
                size="icon-xs"
                variant="ghost"
              >
                <PencilIcon />
              </Button>
              <Button
                aria-label={`Remove comment ${index}`}
                onClick={() => onRemove(condition.id)}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </span>
          </li>
        ))}
    </ul>
  );
};
