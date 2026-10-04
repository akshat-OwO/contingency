import {
  CircleCheckIcon,
  ListChecksIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRef } from "react";

import { RailBadge, RailButton } from "@/components/browser/inspector-rail";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

import {
  ElementButton,
  ElementChip,
  ExpectCookieForm,
  PerformanceChoices,
  RequirementEditor,
  ScanIcon,
} from "./chips";
import { ComposerShell, ComposerTextarea } from "./composer-shell";
import {
  addStandalone,
  checkFor,
  conditionRequiring,
  describe,
  evidenceOf,
  evidenceTitle,
  expectedCookie,
  fieldCheck,
  lastStepId,
  openTimespan,
  removeCondition,
  setDraft,
  updateCondition,
} from "./model";
import type { Condition, PrototypeState, ScanPick } from "./model";
import { MockBadge, StepSelect } from "./parts";
import { ProtoDevtools } from "./proto-devtools";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

type Update = (change: (current: PrototypeState) => PrototypeState) => void;

const isCheck = (condition: Condition) =>
  condition.checks.length > 0 || condition.scan !== undefined;

const scanOf = (
  state: PrototypeState,
  scan: Omit<ScanPick, "id">
): ScanPick => {
  const open = openTimespan(state.conditions);
  return {
    ...scan,
    id:
      scan.phase === "stop" && open !== undefined
        ? open.id
        : `scan-${state.nextId}`,
  };
};

const RequireButton = ({
  label,
  onPress,
  pressed = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly pressed?: boolean;
}) => (
  <Button
    aria-label={label}
    aria-pressed={pressed}
    className="aria-pressed:text-blue-600 dark:aria-pressed:text-blue-400"
    onClick={onPress}
    size="xs"
    title={label}
    variant="ghost"
  >
    <CircleCheckIcon aria-hidden="true" />
    {pressed ? "Required" : "Require"}
  </Button>
);

const CheckItem = ({
  condition,
  editing,
  update,
}: {
  readonly condition: Condition;
  readonly editing: boolean;
  readonly update: Update;
}) => {
  const [check] = condition.checks;
  const evidence = check === undefined ? undefined : evidenceOf(check);
  return (
    <li className="bg-muted/40 flex flex-col gap-2 rounded-xl border p-2.5">
      <div className="flex items-start gap-2">
        {condition.scan === undefined ? (
          <CircleCheckIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
          />
        ) : (
          <ScanIcon
            className="mt-0.5 size-3.5 shrink-0 text-violet-600 dark:text-violet-400"
            mode={condition.scan.mode}
          />
        )}
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-pretty">
          {describe(condition).text}
        </p>
        {check === undefined ? null : (
          <Button
            aria-expanded={editing}
            onClick={() =>
              update((current) => ({
                ...current,
                surface: editing ? undefined : `edit:${condition.id}`,
              }))
            }
            size="xs"
            variant="ghost"
          >
            {editing ? "Done" : "Edit"}
          </Button>
        )}
        <Button
          aria-label="Remove check"
          onClick={() =>
            update((current) => removeCondition(current, condition.id))
          }
          size="icon-xs"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>
      {editing && check !== undefined && evidence !== undefined ? (
        <div className="bg-background flex flex-col gap-2 rounded-lg border p-2">
          <StepSelect
            onChange={(stepId) =>
              update((current) =>
                updateCondition(current, condition.id, { stepId })
              )
            }
            value={condition.stepId}
          />
          <RequirementEditor
            allowContext={false}
            check={check}
            evidence={evidence}
            onChange={(next) =>
              update((current) =>
                updateCondition(current, condition.id, { checks: [next] })
              )
            }
            onRequire={() => {
              // Checks made here are always requirements.
            }}
            stepId={condition.stepId}
          />
          <label className="text-muted-foreground flex flex-col gap-1 text-xs">
            Note for the agent (optional)
            <textarea
              className="bg-background text-foreground focus-visible:ring-ring/50 field-sizing-content min-h-8 resize-none rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
              onChange={(event) =>
                update((current) =>
                  updateCondition(current, condition.id, {
                    note: event.target.value,
                  })
                )
              }
              value={condition.note}
            />
          </label>
        </div>
      ) : null}
    </li>
  );
};

/** Every check and scan taught so far, editable in place. */
const ChecksPanel = ({
  state,
  update,
}: {
  readonly state: PrototypeState;
  readonly update: Update;
}) => {
  const checks = state.conditions.filter(isCheck);
  const openSpan = openTimespan(state.conditions);
  const addScan = (scan: Omit<ScanPick, "id">) =>
    update((current) => ({
      ...addStandalone(current, { checks: [], scan: scanOf(current, scan) }),
      surface: undefined,
    }));
  return (
    <section
      aria-label="Checks"
      className="bg-background flex size-full min-h-0 flex-col"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
        <h2 className="shrink-0 text-sm font-medium">Checks</h2>
        <span className="text-muted-foreground ml-1 text-xs">
          verified on later Runs
        </span>
        <MockBadge className="ml-1" />
        <Button
          aria-label="Close checks"
          className="ml-auto"
          onClick={() =>
            update((current) => ({ ...current, devtools: undefined }))
          }
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
        <span className="text-muted-foreground mr-1 text-xs">Add a scan</span>
        <Popover
          onOpenChange={(open) =>
            update((current) => ({
              ...current,
              surface: open ? "scan" : undefined,
            }))
          }
          open={state.surface === "scan"}
        >
          <PopoverTrigger
            render={<Button size="xs" type="button" variant="outline" />}
          >
            <ScanIcon mode="reload" />
            Performance
          </PopoverTrigger>
          <PopoverContent align="start" positionerClassName="z-[60]">
            <PopoverTitle>Measure performance on later Runs</PopoverTitle>
            <PerformanceChoices onSelect={addScan} openSpan={openSpan} />
          </PopoverContent>
        </Popover>
        <Button
          disabled={openSpan !== undefined}
          onClick={() => addScan({ mode: "accessibility", phase: "start" })}
          size="xs"
          variant="outline"
        >
          <ScanIcon mode="accessibility" />
          Accessibility
        </Button>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-2">
        {checks.length === 0 ? (
          <li className="text-muted-foreground px-3 py-8 text-center text-xs text-pretty">
            Press Require on a request, a response field, or a cookie in
            DevTools.
          </li>
        ) : null}
        {checks.map((condition) => (
          <CheckItem
            condition={condition}
            editing={state.surface === `edit:${condition.id}`}
            key={condition.id}
            update={update}
          />
        ))}
      </ul>
    </section>
  );
};

/**
 * Direction B — require it where you see it. The comment composer only takes
 * words and an element. Every Network row, response field, and cookie has a
 * Require button; one press records the check for the last step. Checks and
 * scans then live in their own rail panel, where they are edited or removed.
 */
export const PointApproach = () => {
  const [state, update] = useApproach("point");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const checks = state.conditions.filter(isCheck);
  const added = state.surface?.startsWith("added:")
    ? state.conditions.find((item) => `added:${item.id}` === state.surface)
    : undefined;
  return (
    <PrototypeWorkspace
      devtools={
        state.devtools === "checks" ? (
          <ChecksPanel state={state} update={update} />
        ) : (
          <ProtoDevtools
            draggable={false}
            fieldAction={(request, value) => (
              <RequireButton
                label={`Require ${value.key} = ${value.value}`}
                onPress={() =>
                  update((current) =>
                    addStandalone(current, {
                      checks: [fieldCheck(request, value)],
                    })
                  )
                }
              />
            )}
            footer={
              <>
                {added === undefined ? null : (
                  <div
                    aria-live="polite"
                    className="flex items-center gap-2 border-t bg-blue-500/5 px-3 py-2 text-xs"
                  >
                    <CircleCheckIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {describe(added).text}
                    </span>
                    <Button
                      onClick={() =>
                        update((current) => ({
                          ...current,
                          devtools: "checks",
                          surface: `edit:${added.id}`,
                        }))
                      }
                      size="xs"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    <Button
                      onClick={() =>
                        update((current) => ({
                          ...removeCondition(current, added.id),
                          surface: undefined,
                        }))
                      }
                      size="xs"
                      variant="ghost"
                    >
                      Undo
                    </Button>
                  </div>
                )}
                {state.devtools === "storage" ? (
                  <div className="border-t p-3">
                    <ExpectCookieForm
                      onExpect={(name) =>
                        update((current) =>
                          addStandalone(current, {
                            checks: [
                              checkFor(expectedCookie(name, lastStepId)),
                            ],
                          })
                        )
                      }
                    />
                  </div>
                ) : null}
              </>
            }
            markOf={(id) =>
              conditionRequiring(state.conditions, id) === undefined
                ? undefined
                : "check"
            }
            rowAction={(item) => {
              const existing = conditionRequiring(state.conditions, item.id);
              return (
                <RequireButton
                  label={
                    existing === undefined
                      ? `Require ${evidenceTitle(item)}`
                      : `Edit the check on ${evidenceTitle(item)}`
                  }
                  onPress={() =>
                    update((current) =>
                      existing === undefined
                        ? addStandalone(current, { checks: [checkFor(item)] })
                        : {
                            ...current,
                            devtools: "checks",
                            surface: `edit:${existing.id}`,
                          }
                    )
                  }
                  pressed={existing !== undefined}
                />
              );
            }}
            state={state}
            update={update}
          />
        )
      }
      rail={
        <>
          <span aria-hidden="true" className="bg-border my-1 h-px w-5" />
          <RailButton
            active={state.devtools === "checks"}
            badge={
              checks.length === 0 ? null : (
                <RailBadge tone="info">{checks.length}</RailBadge>
              )
            }
            description={`${checks.length} checks`}
            icon={<ListChecksIcon />}
            label="Checks"
            onClick={() =>
              update((current) => ({
                ...current,
                devtools: current.devtools === "checks" ? undefined : "checks",
              }))
            }
          />
        </>
      }
      state={state}
      update={update}
    >
      <ComposerShell
        description="Tell the agent about this moment. Checks are added from DevTools."
        footerHints={
          <span className="inline-flex items-center gap-1.5">
            <CircleCheckIcon aria-hidden="true" className="size-3.5" />
            require things from DevTools
          </span>
        }
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <ElementButton
            element={draft.element}
            onPick={(element) =>
              update((current) => setDraft(current, { element }))
            }
          />
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          {draft.element === undefined ? null : (
            <ElementChip
              element={draft.element}
              onRemove={() =>
                update((current) => setDraft(current, { element: undefined }))
              }
            />
          )}
          <ComposerTextarea
            field={field}
            onChange={(note) =>
              update((current) => setDraft(current, { note }))
            }
            placeholder="What should the agent know about this moment?"
            value={draft.note}
          />
        </div>
      </ComposerShell>
    </PrototypeWorkspace>
  );
};
