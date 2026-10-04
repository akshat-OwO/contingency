import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { ComposerFrame, ComposerTextarea } from "./composer-frame";
import {
  canAdd,
  checkFor,
  evidenceOf,
  evidenceTitle,
  findRequest,
  findStep,
  lastStepId,
  setDraft,
  steps,
  storageChangeLabels,
} from "./model";
import type { Check, PrototypeState, StorageChange } from "./model";
import { EvidencePicker, SentencePreview } from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

type Kind = NonNullable<PrototypeState["sentenceKind"]>;
type Update = (change: (current: PrototypeState) => PrototypeState) => void;

const kindLabels: Record<Kind, string> = {
  request: "the app must call the server",
  storage: "the app must update a cookie or storage",
  words: "something I’ll describe",
};

const NOW = "now";

/** One blank in the sentence: a token that opens its choices. */
const Slot = ({
  children,
  empty,
  label,
  name,
  state,
  token,
  update,
  wide = false,
}: {
  readonly children: ReactNode;
  readonly empty: boolean;
  readonly label: string;
  readonly name: string;
  readonly state: PrototypeState;
  readonly token: string;
  readonly update: Update;
  readonly wide?: boolean;
}) => (
  <Popover
    onOpenChange={(open) =>
      update((current) => ({ ...current, surface: open ? name : undefined }))
    }
    open={state.surface === name}
  >
    <PopoverTrigger
      aria-label={`${label}: ${token}`}
      className={cn(
        "focus-visible:ring-ring/50 mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 align-baseline font-medium outline-none focus-visible:ring-2",
        empty
          ? "text-muted-foreground border border-dashed"
          : "bg-blue-500/10 text-blue-700 hover:bg-blue-500/15 dark:text-blue-300"
      )}
    >
      <span className="truncate">{token}</span>
      <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
    </PopoverTrigger>
    <PopoverContent
      align="start"
      className={cn("p-1.5", wide ? "w-[28rem]" : "w-80")}
      positionerClassName="z-[60]"
    >
      {children}
    </PopoverContent>
  </Popover>
);

const Choices = <Value extends string>({
  label,
  onPick,
  options,
  value,
}: {
  readonly label: string;
  readonly onPick: (value: Value) => void;
  readonly options: readonly {
    readonly label: string;
    readonly value: Value;
  }[];
  readonly value: Value | undefined;
}) => (
  <Command className="rounded-lg! p-0" label={label}>
    <CommandList>
      <CommandGroup>
        {options.map((option) => (
          <CommandItem
            data-checked={option.value === value}
            key={option.value}
            onSelect={() => onPick(option.value)}
            value={option.label}
          >
            {option.label}
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  </Command>
);

const expectToken = (check: Check) => {
  if (check.kind === "storage") {
    return storageChangeLabels[check.change].toLowerCase();
  }
  return check.expect.kind === "succeeds"
    ? "it must succeed"
    : `it must return ${check.expect.key}: “${check.expect.value}”`;
};

const ExpectSlot = ({
  check,
  state,
  update,
}: {
  readonly check: Check;
  readonly state: PrototypeState;
  readonly update: Update;
}) => {
  const setCheck = (next: Check) =>
    update((current) => ({
      ...setDraft(current, { checks: [next] }),
      surface: undefined,
    }));
  if (check.kind === "storage") {
    return (
      <Slot
        empty={false}
        label="What should happen to it"
        name="expect"
        state={state}
        token={expectToken(check)}
        update={update}
      >
        <Choices<StorageChange>
          label="What should happen to it"
          onPick={(change) => setCheck({ ...check, change })}
          options={(["created", "changed", "removed", "present"] as const).map(
            (value) => ({ label: storageChangeLabels[value], value })
          )}
          value={check.change}
        />
      </Slot>
    );
  }
  const request = findRequest(check.requestId);
  const valueKey =
    check.expect.kind === "value" ? check.expect.key : "succeeds";
  return (
    <Slot
      empty={false}
      label="What it should return"
      name="expect"
      state={state}
      token={expectToken(check)}
      update={update}
    >
      <Choices
        label="What it should return"
        onPick={(key) => {
          const item = request?.values.find((value) => value.key === key);
          setCheck({
            ...check,
            expect:
              item === undefined
                ? { kind: "succeeds" }
                : { ...item, kind: "value" },
          });
        }}
        options={[
          { label: "It must succeed", value: "succeeds" },
          ...(request?.values ?? []).map((item) => ({
            label: `It must return ${item.key}: “${item.value}”`,
            value: item.key,
          })),
        ]}
        value={valueKey}
      />
      {request === undefined || request.hiddenCount === 0 ? null : (
        <p className="text-muted-foreground px-2 pt-1 text-xs">
          {request.hiddenCount} private values, like tokens and ids, are never
          offered.
        </p>
      )}
    </Slot>
  );
};

/** The sentence: each answered blank reveals the next one. */
const SentenceLine = ({
  state,
  update,
}: {
  readonly state: PrototypeState;
  readonly update: Update;
}) => {
  const { draft } = state;
  const [check] = draft.checks;
  const kind: Kind | undefined = check?.kind ?? state.sentenceKind;
  const step = findStep(draft.stepId);
  const evidence = check === undefined ? undefined : evidenceOf(check);
  let evidenceToken = "pick one…";
  if (evidence !== undefined) {
    evidenceToken =
      evidence.kind === "request"
        ? evidenceTitle(evidence)
        : `${evidence.area === "cookie" ? "cookie" : "storage"} ${evidence.key}`;
  }
  return (
    <div className="text-lg leading-10 text-pretty">
      {step === undefined ? "Right now" : "When"}
      <Slot
        empty={false}
        label="Caused by"
        name="step"
        state={state}
        token={step === undefined ? "check right now" : step.when}
        update={update}
      >
        <Choices
          label="Caused by"
          onPick={(value) =>
            update((current) => ({
              ...setDraft(current, {
                stepId: value === NOW ? undefined : value,
              }),
              surface: undefined,
            }))
          }
          options={[
            ...steps.toReversed().map((item) => ({
              label: `${item.label} · ${item.at}${item.id === lastStepId ? " (your last step)" : ""}`,
              value: item.id,
            })),
            { label: "Nothing — just check it right now", value: NOW },
          ]}
          value={draft.stepId ?? NOW}
        />
      </Slot>
      ,
      <Slot
        empty={kind === undefined}
        label="What kind of thing"
        name="kind"
        state={state}
        token={kind === undefined ? "choose…" : kindLabels[kind]}
        update={update}
      >
        <Choices<Kind>
          label="What kind of thing"
          onPick={(value) =>
            update((current) => ({
              ...setDraft(current, {
                checks:
                  current.draft.checks[0]?.kind === value
                    ? current.draft.checks
                    : [],
              }),
              sentenceKind: value,
              surface: value === "words" ? undefined : "evidence",
            }))
          }
          options={(["request", "storage", "words"] as const).map((value) => ({
            label: kindLabels[value],
            value,
          }))}
          value={kind}
        />
      </Slot>
      {kind === "request" || kind === "storage" ? (
        <Slot
          empty={evidence === undefined}
          label={kind === "request" ? "Which request" : "Which item"}
          name="evidence"
          state={state}
          token={evidenceToken}
          update={update}
          wide
        >
          <EvidencePicker
            kind={kind}
            onPick={(item) =>
              update((current) => ({
                ...setDraft(current, { checks: [checkFor(item)] }),
                surface: "expect",
              }))
            }
            pickedIds={new Set(evidence === undefined ? [] : [evidence.id])}
          />
        </Slot>
      ) : null}
      {check === undefined ? null : (
        <>
          {check.kind === "request" ? " and" : " that"}
          <ExpectSlot check={check} state={state} update={update} />
        </>
      )}
      {kind === undefined || kind === "words" ? null : "."}
    </div>
  );
};

/**
 * Approach 4 — a guided sentence inside the composer. Every blank is a plain
 * choice, so the condition reads as English while it is being built.
 */
export const SentenceApproach = () => {
  const [state, update] = useApproach("sentence");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const kind = draft.checks[0]?.kind ?? state.sentenceKind;
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerFrame
        initialFocus={field}
        onEditStart={() =>
          update((current) => ({
            ...current,
            sentenceKind: current.draft.checks[0]?.kind ?? "words",
          }))
        }
        state={state}
        toolbar={null}
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          <SentenceLine state={state} update={update} />
          <label className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0 pt-1.5 text-sm">
              {kind === "words" ? "Describe it:" : "Then:"}
            </span>
            <ComposerTextarea
              className="min-h-9 border-b text-base leading-7"
              field={field}
              onChange={(note) =>
                update((current) => setDraft(current, { note }))
              }
              placeholder={
                kind === "words"
                  ? "the cart badge shows 0"
                  : "the order confirmation appears (optional)"
              }
              value={draft.note}
            />
          </label>
          {canAdd(draft) ? <SentencePreview draft={draft} /> : null}
        </div>
      </ComposerFrame>
    </PrototypeWorkspace>
  );
};
