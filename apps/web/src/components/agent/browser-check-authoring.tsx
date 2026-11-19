import type {
  TeachingBrowserAttachment,
  BrowserCheck,
  BrowserPredicate,
} from "@contingency/protocol";
import { Schema } from "effect";
import {
  ActivityIcon,
  ChevronRightIcon,
  DatabaseIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const operators = [
  "exists",
  "equals",
  "contains",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;
const rawOperators = ["exists", "equals", "contains"] as const;
/** Responses and JSON storage are typed values; cookies and raw storage are one root string. */
const readsFields = (check: BrowserCheck) =>
  check.kind === "response" || check.format === "json";
const asRawString = (check: BrowserCheck): BrowserCheck => ({
  ...check,
  demonstrated: false,
  expectation: {
    itemPath: [],
    // Fresh ids remount each predicate so its uncontrolled inputs show the converted value.
    predicates: check.expectation.predicates.map((predicate) => {
      const { expected, ...rest } = predicate;
      const id = globalThis.crypto.randomUUID();
      if (predicate.operator === "exists") {
        return { ...rest, id, path: [] };
      }
      return {
        ...rest,
        expected: expected === undefined ? "" : String(expected),
        id,
        operator: predicate.operator === "contains" ? "contains" : "equals",
        path: [],
      };
    }),
  },
});

const updateExpected = (
  input: HTMLInputElement,
  change: (expected: Exclude<BrowserPredicate["expected"], undefined>) => void
) => {
  try {
    const parsed = Schema.decodeUnknownSync(
      Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
    )(JSON.parse(input.value));
    change(parsed);
    input.setCustomValidity("");
  } catch {
    input.setCustomValidity(
      'Enter a typed JSON value, for example "ready", 42, true, or null.'
    );
    input.reportValidity();
  }
};
const pathValue = (
  input: HTMLInputElement
): readonly (string | number)[] | undefined => {
  try {
    const path = Schema.decodeUnknownSync(
      Schema.Array(Schema.Union([Schema.String, Schema.Int]))
    )(JSON.parse(input.value));
    input.setCustomValidity("");
    return path;
  } catch {
    input.setCustomValidity(
      "Enter a path as an array of field names and indices."
    );
    input.reportValidity();
  }
};

const inputClassName = "h-8 rounded-[10px] px-2.5 font-mono text-xs md:text-xs";

const fieldClassName =
  "text-muted-foreground grid min-w-0 gap-1 text-xs font-medium";

/** A field's visible name above its input, as the check card lays them out. */
const Field = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the control is the label's child
  <label className={fieldClassName}>
    <span>{label}</span>
    {children}
  </label>
);

/**
 * A Select's visible name. Not a `<label>`: the Select's list renders in
 * place, and a press on an option inside a label would reopen the trigger.
 * The trigger carries its own accessible name.
 */
const SelectField = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) => (
  <div className={fieldClassName}>
    <span aria-hidden="true">{label}</span>
    {children}
  </div>
);

const SectionHeading = ({ children }: { readonly children: ReactNode }) => (
  <h3 className="text-muted-foreground/80 mt-1.5 -mb-0.5 text-xs font-semibold tracking-[0.04em] uppercase">
    {children}
  </h3>
);

const CompactSelect = <T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: readonly (readonly [T, string])[];
  readonly value: T;
}) => (
  <Select
    onValueChange={(next) => {
      const option = options.find(([candidate]) => candidate === next);
      if (option !== undefined) {
        onChange(option[0]);
      }
    }}
    value={value}
  >
    <SelectTrigger
      aria-label={label}
      className="h-8 w-full min-w-0 rounded-[10px] text-xs"
      size="sm"
    >
      <SelectValue>
        {(current: string | null) =>
          options.find(([candidate]) => candidate === current)?.[1] ?? current
        }
      </SelectValue>
    </SelectTrigger>
    <SelectContent align="start" variant="island">
      {options.map(([option, text]) => (
        <SelectItem key={option} value={option}>
          {text}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const BrowserSourceEditor = ({
  check,
  update,
}: {
  readonly check: BrowserCheck;
  readonly update: (check: BrowserCheck) => void;
}) =>
  check.kind === "response" ? (
    <>
      <SectionHeading>Request</SectionHeading>
      <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
        <Field label="Method">
          <Input
            aria-label="Request method"
            className={inputClassName}
            value={check.request.method}
            onChange={(event) =>
              update({
                ...check,
                demonstrated: false,
                request: {
                  ...check.request,
                  method: event.currentTarget.value.toUpperCase(),
                },
              })
            }
          />
        </Field>
        <Field label="Path">
          <Input
            aria-label="Request path"
            className={inputClassName}
            placeholder="/api/orders/:id"
            title="Use :name for one variable path segment."
            value={check.request.path}
            onChange={(event) =>
              update({
                ...check,
                demonstrated: false,
                request: { ...check.request, path: event.currentTarget.value },
              })
            }
          />
        </Field>
      </div>
      <Field label="Origin">
        <Input
          aria-label="Request origin"
          className={inputClassName}
          value={check.request.origin}
          onChange={(event) =>
            update({
              ...check,
              demonstrated: false,
              request: { ...check.request, origin: event.currentTarget.value },
            })
          }
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Query constraints">
          <Input
            aria-label="Query constraints"
            className={inputClassName}
            defaultValue={JSON.stringify(check.request.query)}
            title="Query parameters are unconstrained unless listed here."
            onBlur={(event) => {
              try {
                const query = Schema.decodeUnknownSync(
                  Schema.Record(Schema.String, Schema.String)
                )(JSON.parse(event.currentTarget.value));
                update({
                  ...check,
                  demonstrated: false,
                  request: { ...check.request, query },
                });
                event.currentTarget.setCustomValidity("");
              } catch {
                event.currentTarget.setCustomValidity(
                  "Enter an object of query names and string values."
                );
                event.currentTarget.reportValidity();
              }
            }}
          />
        </Field>
        <SelectField label="Response">
          <CompactSelect
            label="Response timing"
            onChange={(response) => update({ ...check, response })}
            options={[
              ["matching", "Wait for a match"],
              ["first", "The first response"],
            ]}
            value={check.response}
          />
        </SelectField>
      </div>
    </>
  ) : (
    <>
      <SectionHeading>
        {check.kind === "cookie" ? "Cookie" : "Storage"}
      </SectionHeading>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <Input
            aria-label="Storage check name"
            className={inputClassName}
            value={check.name}
            onChange={(event) =>
              update({
                ...check,
                demonstrated: false,
                name: event.currentTarget.value,
              })
            }
          />
        </Field>
        <SelectField label="State">
          <CompactSelect
            label="Storage check change"
            onChange={(change) => update({ ...check, change })}
            options={[
              ["created", "Created after the action"],
              ["changed", "Changed after the action"],
              ["current", "Current state"],
            ]}
            value={check.change}
          />
        </SelectField>
      </div>
      <div
        className={cn(
          "grid gap-2",
          check.kind === "cookie" ? null : "grid-cols-[minmax(0,1fr)_8rem]"
        )}
      >
        <Field label="Origin">
          <Input
            aria-label="Storage check origin"
            className={inputClassName}
            value={check.origin}
            onChange={(event) =>
              update({
                ...check,
                demonstrated: false,
                origin: event.currentTarget.value,
              })
            }
          />
        </Field>
        {check.kind === "cookie" ? null : (
          <SelectField label="Format">
            <CompactSelect
              label="Storage format"
              onChange={(format) =>
                update(
                  format === "json"
                    ? { ...check, demonstrated: false, format: "json" }
                    : asRawString({ ...check, format: "raw" })
                )
              }
              options={[
                ["raw", "Raw string"],
                ["json", "JSON"],
              ]}
              value={check.format ?? "raw"}
            />
          </SelectField>
        )}
      </div>
    </>
  );

/**
 * An attached browser check in the comment card. Its label opens the check's
 * editor beside the card; the cross removes it, like every other chip.
 */
export const BrowserAttachmentChip = ({
  attachment,
  disabled,
  onOpen,
  onRemove,
  open,
}: {
  readonly attachment: TeachingBrowserAttachment;
  readonly disabled: boolean;
  readonly onOpen: () => void;
  readonly onRemove: () => void;
  readonly open: boolean;
}) => {
  const required = attachment.requirement !== undefined;
  const check = attachment.requirement ?? attachment.candidate;
  const Icon = check.kind === "response" ? ActivityIcon : DatabaseIcon;
  return (
    <span
      className={cn(
        "bg-island-hover inline-flex max-w-full items-center rounded-[10px] py-[3px] pr-1.5 pl-1 text-xs shadow-[inset_0_0_0_1px_var(--island-border)]",
        open && "shadow-[inset_0_0_0_1.5px_var(--brand)]"
      )}
    >
      <button
        aria-expanded={open}
        className="hover:bg-island-hover focus-visible:ring-ring/40 inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-[7px] pr-0.5 pl-1.5 outline-none focus-visible:ring-2 disabled:opacity-50"
        disabled={disabled}
        onClick={onOpen}
        type="button"
      >
        <Icon
          aria-hidden="true"
          className="text-muted-foreground size-[13px] shrink-0"
        />
        <span className="max-w-50 truncate font-mono text-xs">
          {attachment.label}
        </span>
        <span
          className={cn(
            "rounded-md px-1.5 py-px text-xs",
            required
              ? "bg-brand/18 text-foreground"
              : "bg-island-hover text-muted-foreground"
          )}
        >
          {required ? "Must happen" : "Context"}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="text-muted-foreground size-3 shrink-0"
        />
      </button>
      <Button
        aria-label={`Remove ${attachment.label}`}
        className="size-[22px] rounded-[7px]"
        disabled={disabled}
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="island"
      >
        <XIcon />
      </Button>
    </span>
  );
};

/**
 * The editor for one attached browser check: a card beside the comment card,
 * so the comment stays readable while the check is shaped.
 */
export const BrowserAttachmentEditor = ({
  attachment,
  className,
  onChange,
  onClose,
  onRemove,
}: {
  readonly attachment: TeachingBrowserAttachment;
  readonly className?: string;
  readonly onChange: (attachment: TeachingBrowserAttachment) => void;
  readonly onClose: () => void;
  readonly onRemove: () => void;
}) => {
  const check = attachment.requirement ?? attachment.candidate;
  const update = (next: BrowserCheck) =>
    onChange({
      ...attachment,
      candidate: next,
      label:
        next.kind === "response"
          ? `${next.request.method} ${next.request.path} · ${next.expectation.predicates[0]?.path.join(".") ?? "response"}`
          : `${next.kind} · ${next.name}`,
      requirement: attachment.requirement === undefined ? undefined : next,
    });
  const updatePredicate = (index: number, predicate: BrowserPredicate) =>
    update({
      ...check,
      demonstrated: false,
      expectation: {
        ...check.expectation,
        predicates: check.expectation.predicates.map((existing, position) =>
          position === index ? predicate : existing
        ),
      },
    });
  const Icon = check.kind === "response" ? ActivityIcon : DatabaseIcon;
  const fields = readsFields(check);
  return (
    <section
      aria-label={attachment.label}
      className={cn(
        "island bg-island-solid shadow-island-lift flex min-h-0 w-95 flex-col overflow-clip rounded-[18px] text-sm",
        className
      )}
    >
      <header className="border-island-border flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-4">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          <Icon
            aria-hidden="true"
            className="text-muted-foreground size-3.5 shrink-0"
          />
          <span className="truncate font-mono text-[12.5px]">
            {attachment.label}
          </span>
        </h2>
        <Button
          aria-label="Close check"
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="island"
        >
          <XIcon />
        </Button>
      </header>
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-2.5 overflow-y-auto overscroll-contain p-4">
        <SegmentedControl
          aria-label={`Purpose for ${attachment.label}`}
          className="flex"
          onValueChange={(purpose) => {
            if (purpose === "context") {
              const { requirement: _removed, ...context } = attachment;
              onChange(context);
            } else {
              onChange({ ...attachment, requirement: check });
            }
          }}
          value={attachment.requirement === undefined ? "context" : "required"}
        >
          <SegmentedControlItem className="flex-1" value="context">
            Context for the agent
          </SegmentedControlItem>
          <SegmentedControlItem className="flex-1" value="required">
            Must happen
          </SegmentedControlItem>
        </SegmentedControl>
        {attachment.requirement === undefined ? null : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="When">
                <Input
                  aria-label="Check timing"
                  className={cn(inputClassName, "font-sans")}
                  value={check.when}
                  onChange={(event) =>
                    update({ ...check, when: event.currentTarget.value })
                  }
                />
              </Field>
              <Field label="Timeout (ms)">
                <Input
                  aria-label="Check timeout"
                  className={inputClassName}
                  type="number"
                  min={1}
                  max={60_000}
                  value={String(check.timeoutMs)}
                  onChange={(event) => {
                    const timeoutMs = event.currentTarget.valueAsNumber;
                    if (
                      Number.isInteger(timeoutMs) &&
                      timeoutMs > 0 &&
                      timeoutMs <= 60_000
                    ) {
                      update({ ...check, timeoutMs });
                    }
                  }}
                />
              </Field>
            </div>
            <BrowserSourceEditor check={check} update={update} />
            <SectionHeading>Expect</SectionHeading>
            {fields ? (
              <Field label="Array item path">
                <Input
                  aria-label="Array item path"
                  className={inputClassName}
                  defaultValue={JSON.stringify(check.expectation.itemPath)}
                  title={
                    'Use "*" for an item anywhere in an array, or a number for an explicit index. Every predicate must match the same item.'
                  }
                  onBlur={(event) => {
                    const itemPath = pathValue(event.currentTarget);
                    if (itemPath !== undefined) {
                      update({
                        ...check,
                        demonstrated: false,
                        expectation: { ...check.expectation, itemPath },
                      });
                    }
                  }}
                />
              </Field>
            ) : null}
            <ol aria-label="Predicates" className="grid gap-1.5">
              {check.expectation.predicates.map((predicate, index) => (
                <li
                  className={cn(
                    "grid items-center gap-1.5",
                    fields
                      ? "grid-cols-[minmax(0,1.1fr)_5.75rem_minmax(0,1fr)_auto]"
                      : "grid-cols-[5.75rem_minmax(0,1fr)_auto]"
                  )}
                  key={predicate.id ?? JSON.stringify(predicate.path)}
                >
                  {fields ? (
                    <Input
                      aria-label={`Field path ${index + 1}`}
                      className={inputClassName}
                      defaultValue={JSON.stringify(predicate.path)}
                      onBlur={(event) => {
                        const path = pathValue(event.currentTarget);
                        if (path !== undefined) {
                          updatePredicate(index, { ...predicate, path });
                        }
                      }}
                    />
                  ) : null}
                  <CompactSelect
                    label={`Comparison ${index + 1}`}
                    onChange={(operator) => {
                      const { expected, ...withoutExpected } = predicate;
                      updatePredicate(
                        index,
                        operator === "exists"
                          ? { ...withoutExpected, operator }
                          : {
                              ...predicate,
                              expected: expected === undefined ? "" : expected,
                              operator,
                            }
                      );
                    }}
                    options={(fields ? operators : rawOperators).map(
                      (operator) => [operator, operator] as const
                    )}
                    value={predicate.operator}
                  />
                  {predicate.operator === "exists" ? (
                    <span />
                  ) : (
                    <Input
                      aria-label={`Expected value ${index + 1}`}
                      className={inputClassName}
                      defaultValue={JSON.stringify(predicate.expected)}
                      onBlur={(event) =>
                        updateExpected(event.currentTarget, (expected) =>
                          updatePredicate(index, { ...predicate, expected })
                        )
                      }
                    />
                  )}
                  {check.expectation.predicates.length < 2 ? (
                    <span />
                  ) : (
                    <Button
                      aria-label={`Remove predicate ${index + 1}`}
                      onClick={() =>
                        update({
                          ...check,
                          expectation: {
                            ...check.expectation,
                            predicates: check.expectation.predicates.filter(
                              (_, position) => position !== index
                            ),
                          },
                        })
                      }
                      size="icon-xs"
                      type="button"
                      variant="island"
                    >
                      <XIcon />
                    </Button>
                  )}
                </li>
              ))}
            </ol>
            <Button
              className="justify-self-start"
              disabled={check.expectation.predicates.length >= 20}
              onClick={() =>
                update({
                  ...check,
                  demonstrated: false,
                  expectation: {
                    ...check.expectation,
                    predicates: [
                      ...check.expectation.predicates,
                      { operator: "exists", path: [] },
                    ],
                  },
                })
              }
              size="sm"
              type="button"
              variant="island"
            >
              Add predicate to this item
            </Button>
            <p
              className={cn(
                "rounded-[10px] px-2.5 py-2 text-xs",
                check.demonstrated
                  ? "bg-status-ready/12 text-status-ready"
                  : "bg-brand/12 text-foreground"
              )}
            >
              {check.demonstrated
                ? "Observed during Teaching"
                : "Not demonstrated. A fresh Dry Run must pass this check."}
            </p>
          </>
        )}
      </div>
      <footer className="border-island-border border-t px-2.5 pt-2 pb-2.5">
        <Button
          className="hover:bg-destructive/10 hover:text-destructive"
          onClick={onRemove}
          size="sm"
          type="button"
          variant="island"
        >
          <Trash2Icon aria-hidden="true" />
          Remove attachment
        </Button>
      </footer>
    </section>
  );
};
