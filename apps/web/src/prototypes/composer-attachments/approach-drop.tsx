import {
  CircleCheckIcon,
  GlobeIcon,
  GripVerticalIcon,
  PaperclipIcon,
} from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";

import {
  ElementButton,
  ElementChip,
  EvidenceChip,
  ExpectCookieForm,
  ScanButtons,
  ScanChip,
} from "./chips";
import { ComposerShell, ComposerTextarea } from "./composer-shell";
import {
  applyDrop,
  attach,
  detach,
  draftEvidence,
  evidenceId,
  evidenceTitle,
  expectedCookie,
  lastStepId,
  openTimespan,
  pickScan,
  setDraft,
  setRequired,
  updateCheck,
} from "./model";
import { ProtoDevtools } from "./proto-devtools";
import { useApproach } from "./use-approach";
import { PrototypeWorkspace } from "./workspace";

/**
 * Direction A — drag from DevTools. The composer stays production's: words,
 * an element, and the two scan buttons. Requests, response fields, and
 * cookies arrive by dragging them out of the devtools (or with each row's
 * attach button), and land as small chips. A dropped row is context; a
 * dropped response field is already a check. Any chip opens its editor.
 */
export const DropApproach = () => {
  const [state, update] = useApproach("drop");
  const field = useRef<HTMLTextAreaElement>(null);
  const { draft } = state;
  const evidence = draftEvidence(draft);
  const checkOf = (id: string) =>
    draft.checks.find((check) => evidenceId(check) === id);
  return (
    <PrototypeWorkspace
      devtools={
        <ProtoDevtools
          draggable
          fieldAction={(request, value) => (
            <Button
              aria-label={`Require ${value.key} = ${value.value}`}
              onClick={() =>
                update((current) => ({
                  ...applyDrop(current, {
                    key: value.key,
                    kind: "field",
                    requestId: request.id,
                  }),
                  composing: true,
                }))
              }
              size="icon-xs"
              title="Require this value"
              variant="ghost"
            >
              <CircleCheckIcon />
            </Button>
          )}
          footer={
            state.devtools === "storage" ? (
              <div className="border-t p-3">
                <ExpectCookieForm
                  onExpect={(name) =>
                    update((current) => ({
                      ...setRequired(
                        current,
                        expectedCookie(name, lastStepId),
                        true
                      ),
                      composing: true,
                    }))
                  }
                />
              </div>
            ) : (
              <p className="text-muted-foreground flex items-center gap-1.5 border-t px-3 py-2 text-xs">
                <GripVerticalIcon aria-hidden="true" className="size-3.5" />
                Drag a request or a response field onto the comment.
              </p>
            )
          }
          markOf={(id) => {
            if (checkOf(id) !== undefined) {
              return "check";
            }
            return (draft.attachments ?? []).some((item) => item.id === id)
              ? "context"
              : undefined;
          }}
          rowAction={(item) => (
            <Button
              aria-label={`Attach ${evidenceTitle(item)} to the comment`}
              onClick={() =>
                update((current) => ({
                  ...attach(current, item),
                  composing: true,
                }))
              }
              size="icon-xs"
              title="Attach to comment"
              variant="ghost"
            >
              <PaperclipIcon />
            </Button>
          )}
          state={state}
          update={update}
        />
      }
      state={state}
      update={update}
    >
      <ComposerShell
        acceptsDrops
        description="Tell the agent about this moment. Drag requests, response fields, or cookies from DevTools to attach them."
        footerHints={
          <span className="inline-flex items-center gap-1.5">
            <GripVerticalIcon aria-hidden="true" className="size-3.5" />
            drag from DevTools to attach
          </span>
        }
        initialFocus={field}
        onEditStart={() => field.current?.focus()}
        state={state}
        toolbar={
          <>
            <ElementButton
              element={draft.element}
              onPick={(element) =>
                update((current) => setDraft(current, { element }))
              }
            />
            <ScanButtons
              onOpenChange={(open) =>
                update((current) => ({
                  ...current,
                  surface: open ? "scan" : undefined,
                }))
              }
              onSelect={(scan) => update((current) => pickScan(current, scan))}
              open={state.surface === "scan"}
              openSpan={openTimespan(state.conditions)}
              trailing={
                state.devtools === "network" ? null : (
                  <Button
                    aria-label="Open Network to drag a request"
                    onClick={() =>
                      update((current) => ({
                        ...current,
                        devtools: "network",
                      }))
                    }
                    size="icon-sm"
                    title="Open Network to drag a request"
                    type="button"
                    variant="ghost"
                  >
                    <GlobeIcon aria-hidden="true" />
                  </Button>
                )
              }
            />
          </>
        }
        update={update}
      >
        <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
          {draft.element === undefined &&
          draft.scan === undefined &&
          evidence.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-1.5">
              {draft.element === undefined ? null : (
                <ElementChip
                  element={draft.element}
                  onRemove={() =>
                    update((current) =>
                      setDraft(current, { element: undefined })
                    )
                  }
                />
              )}
              {evidence.map((item) => (
                <EvidenceChip
                  check={checkOf(item.id)}
                  evidence={item}
                  key={item.id}
                  onChange={(check) =>
                    update((current) => updateCheck(current, check))
                  }
                  onOpenChange={(open) =>
                    update((current) => ({
                      ...current,
                      surface: open ? `chip:${item.id}` : undefined,
                    }))
                  }
                  onRemove={() => update((current) => detach(current, item.id))}
                  onRequire={(required) =>
                    update((current) => setRequired(current, item, required))
                  }
                  open={state.surface === `chip:${item.id}`}
                  stepId={draft.stepId}
                />
              ))}
              {draft.scan === undefined ? null : (
                <ScanChip
                  onRemove={() =>
                    update((current) => setDraft(current, { scan: undefined }))
                  }
                  scan={draft.scan}
                />
              )}
            </div>
          )}
          <ComposerTextarea
            field={field}
            onChange={(note) =>
              update((current) => setDraft(current, { note }))
            }
            placeholder="What should the agent know about this moment?"
            value={draft.note}
          />
          {evidence.length === 0 && state.devtools !== undefined ? (
            <p className="text-muted-foreground text-xs">
              Drag a request, a response field, or a cookie from DevTools onto
              this comment.
            </p>
          ) : null}
        </div>
      </ComposerShell>
    </PrototypeWorkspace>
  );
};
