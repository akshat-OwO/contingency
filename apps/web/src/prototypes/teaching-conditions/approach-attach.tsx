import { CookieIcon, GlobeIcon, XIcon } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { ComposerFrame, ComposerTextarea } from "./composer-frame";
import {
  addCheck,
  checkFor,
  evidenceId,
  evidenceOf,
  evidenceTitle,
  replaceCheck,
  setDraft,
  storageItems,
} from "./model";
import {
  CheckCard,
  EvidenceRow,
  EvidencePicker,
  SentencePreview,
  StepSelect,
} from "./parts";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

/**
 * Approach 1 — today's composer, with two more things to attach. A request
 * or a stored item is attached the way an element is, and its card asks one
 * plain question about it.
 */
export const AttachApproach = () => {
  const [state, update] = useApproach("attach");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const attachmentIds = [
    ...new Set([
      ...(draft.attachments ?? []).map((item) => item.id),
      ...draft.checks.map(evidenceId),
    ]),
  ];
  const picked = new Set(attachmentIds);
  const picker = (kind: "request" | "storage") => (
    <Popover
      onOpenChange={(open) =>
        update((current) => ({
          ...current,
          surface: open ? kind : undefined,
        }))
      }
      open={state.surface === kind}
    >
      <PopoverTrigger
        render={<Button size="sm" type="button" variant="ghost" />}
      >
        {kind === "request" ? (
          <GlobeIcon aria-hidden="true" />
        ) : (
          <CookieIcon aria-hidden="true" />
        )}
        {kind === "request" ? "Attach request" : "Attach storage"}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[28rem] p-1.5"
        positionerClassName="z-[60]"
      >
        <EvidencePicker
          onNewCookie={
            kind === "storage"
              ? (name) => {
                  const existing = [
                    ...storageItems,
                    ...(draft.attachments ?? []),
                  ].find(
                    (item) =>
                      item.kind === "storage" &&
                      item.area === "cookie" &&
                      item.key === name
                  );
                  const evidence = existing ?? {
                    area: "cookie" as const,
                    change: "created" as const,
                    id: `cookie:${name}`,
                    key: name,
                    kind: "storage" as const,
                    observed: false,
                    stepId: draft.stepId ?? "",
                    value: "",
                  };
                  update((current) => ({
                    ...setDraft(current, {
                      attachments: [
                        ...(current.draft.attachments ?? []).filter(
                          (item) => item.id !== evidence.id
                        ),
                        evidence,
                      ],
                    }),
                    surface: undefined,
                  }));
                }
              : undefined
          }
          kind={kind}
          onPick={(evidence) => {
            update((current) => ({
              ...setDraft(current, {
                attachments: [
                  ...(current.draft.attachments ?? []).filter(
                    (item) => item.id !== evidence.id
                  ),
                  evidence,
                ],
              }),
              surface: undefined,
            }));
            field.current?.focus();
          }}
          pickedIds={picked}
        />
      </PopoverContent>
    </Popover>
  );
  return (
    <PrototypeWorkspace state={state} update={update}>
      <ComposerFrame
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <>
            {picker("request")}
            {picker("storage")}
          </>
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          {attachmentIds.map((id) => {
            const checkedEvidence = draft.checks.find(
              (item) => evidenceId(item) === id
            );
            const evidence =
              draft.attachments?.find((item) => item.id === id) ??
              (checkedEvidence === undefined
                ? undefined
                : evidenceOf(checkedEvidence));
            if (evidence === undefined) {
              return null;
            }
            const checkIndex = draft.checks.findIndex(
              (check) => evidenceId(check) === id
            );
            const check = draft.checks[checkIndex];
            const detach = () =>
              update((current) =>
                setDraft(current, {
                  attachments: (current.draft.attachments ?? []).filter(
                    (item) => item.id !== id
                  ),
                  checks: current.draft.checks.filter(
                    (item) => evidenceId(item) !== id
                  ),
                })
              );
            return (
              <div className="flex flex-col gap-1" key={id}>
                {check === undefined ? (
                  <div className="bg-muted/40 flex flex-col gap-2 rounded-xl border p-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <EvidenceRow evidence={evidence} />
                      </span>
                      <Button
                        aria-label={`Remove attachment ${evidenceTitle(evidence)}`}
                        onClick={detach}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs">
                        Attached for context
                      </span>
                      <Button
                        onClick={() =>
                          update((current) =>
                            addCheck(current, checkFor(evidence))
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Add check
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <CheckCard
                      check={check}
                      onChange={(next) =>
                        update((current) =>
                          replaceCheck(current, checkIndex, next)
                        )
                      }
                      onRemove={detach}
                      stepId={draft.stepId}
                    />
                    <Button
                      className="self-start"
                      onClick={() =>
                        update((current) =>
                          setDraft(current, {
                            attachments: [
                              ...(current.draft.attachments ?? []).filter(
                                (item) => item.id !== id
                              ),
                              evidence,
                            ],
                            checks: current.draft.checks.filter(
                              (item) => evidenceId(item) !== id
                            ),
                          })
                        )
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Remove check, keep attachment
                    </Button>
                  </>
                )}
              </div>
            );
          })}
          <ComposerTextarea
            field={field}
            onChange={(note) =>
              update((current) => setDraft(current, { note }))
            }
            placeholder={
              draft.checks.length === 0
                ? "What should the agent know about this moment?"
                : "Add a comment (optional)"
            }
            value={draft.note}
          />
          {draft.checks.length > 0 ? (
            <>
              <StepSelect
                onChange={(stepId) =>
                  update((current) => setDraft(current, { stepId }))
                }
                value={draft.stepId}
              />
              <SentencePreview draft={draft} />
            </>
          ) : null}
        </div>
      </ComposerFrame>
    </PrototypeWorkspace>
  );
};
