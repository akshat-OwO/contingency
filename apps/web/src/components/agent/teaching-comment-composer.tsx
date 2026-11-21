import { openTeachingTimespan } from "@contingency/protocol";
import type {
  TeachingScan,
  TeachingBrowserAttachment,
  ScanMode,
  TeachingInstruction,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ActivityIcon,
  DatabaseIcon,
  MousePointer2Icon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { CommentCard, CommentChip } from "@/components/agent/comment-card";
import type {
  CommentShortcut,
  ShortcutPlatform,
} from "@/components/agent/teaching-comment-shortcuts";
import { shortcutKeys } from "@/components/agent/teaching-comment-shortcuts";
import type { InspectState } from "@/components/agent/teaching-inspect-state";
import { elapsedClock } from "@/components/agent/teaching-recording-state";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "@/components/ui/popover";

import {
  attachmentMime,
  readAttachment,
  storageAttachment,
} from "./browser-check-attachments";
import {
  BrowserAttachmentChip,
  BrowserAttachmentEditor,
} from "./browser-check-authoring";

const scanLabels: Record<ScanMode, string> = {
  accessibility: "Accessibility scan",
  navigation: "Measure the next navigation",
  reload: "Reload at this point",
  timespan: "Interaction timespan",
};

/** A shortcut's keys, one `Kbd` each, so `⌘ ⇧ K` reads as three keys. */
export const ShortcutKbd = ({
  className,
  platform,
  scope,
  shortcut,
}: {
  readonly className?: string | undefined;
  readonly platform: ShortcutPlatform;
  readonly scope: "bare" | "chord";
  readonly shortcut: CommentShortcut;
}) => (
  <KbdGroup aria-hidden="true" className={className}>
    {shortcutKeys(shortcut, scope, platform).map((key) => (
      <Kbd key={key}>{key}</Kbd>
    ))}
  </KbdGroup>
);

const scanName = (scan: TeachingScan) =>
  scan.phase === "stop" ? "End interaction timespan" : scanLabels[scan.mode];

const ScanTools = ({
  open,
  onOpenChange,
  openTimespan,
  pending,
  selectScan,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly openTimespan: TeachingScan | undefined;
  readonly pending: boolean;
  readonly selectScan: (mode: ScanMode, stop?: boolean) => void;
}) => (
  <>
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            aria-label="Performance scan"
            title="Performance scan"
            disabled={pending}
            size="island-icon"
            type="button"
          />
        }
      >
        <ActivityIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="bg-island-solid shadow-island ring-island-border w-56 gap-0.5 rounded-[14px] p-[5px]"
        positionerClassName="z-[60]"
        side="top"
        sideOffset={10}
      >
        <PopoverTitle className="text-muted-foreground px-2.5 pt-1.5 pb-1 text-xs font-medium">
          Teach a scan for later Runs
        </PopoverTitle>
        {openTimespan === undefined ? (
          (["reload", "navigation", "timespan"] as const).map((mode) => (
            <Button
              size="md"
              className="justify-start"
              key={mode}
              onClick={() => selectScan(mode)}
              type="button"
            >
              {scanLabels[mode]}
            </Button>
          ))
        ) : (
          <Button
            size="md"
            className="justify-start"
            onClick={() => selectScan("timespan", true)}
            type="button"
          >
            <SquareIcon />
            End timespan
          </Button>
        )}
      </PopoverContent>
    </Popover>
    <Button
      aria-label="Accessibility scan"
      title="Accessibility scan"
      disabled={pending || openTimespan !== undefined}
      onClick={() => selectScan("accessibility")}
      size="island-icon"
      type="button"
    >
      <SparklesIcon aria-hidden="true" />
    </Button>
  </>
);

/**
 * The Web Teaching comment card. A comment is written here whether or not it
 * names an element: without one it is a page comment; with one, inspect has
 * attached the element as a chip. Requests and cookies dragged from DevTools
 * attach as browser checks, each edited in a card beside this one.
 */
export const CommentComposer = ({
  onEdit,
  origin,
  onAttachmentsChange,
  onAttach,
  instructions,
  onCancelPick,
  onDetach,
  onDraftChange,
  onHighlight,
  onOpenChange,
  onPick,
  onSubmit,
  onScanChange,
  onScanMenuChange,
  pending,
  platform,
  startedAt,
  state,
}: {
  readonly origin: string;
  readonly onAttachmentsChange: (
    attachments: readonly TeachingBrowserAttachment[]
  ) => void;
  readonly onAttach: (attachment: TeachingBrowserAttachment) => void;
  readonly onEdit: (instruction: TeachingInstruction) => void;
  /** Every instruction on this recording, oldest first. */
  readonly instructions: readonly TeachingInstruction[];
  readonly onCancelPick: () => void;
  readonly onDetach: () => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onHighlight: (index?: number) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: () => void;
  readonly onSubmit: () => void;
  readonly onScanChange: (scan?: TeachingScan) => void;
  readonly onScanMenuChange: (open: boolean) => void;
  /** A save is in flight, so the composer is read-only until it answers. */
  readonly pending: boolean;
  readonly platform: ShortcutPlatform;
  readonly startedAt: string;
  readonly state: InspectState;
}) => {
  const field = useRef<HTMLTextAreaElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [openCheckAtom] = useState(() => Atom.make<string | null>(null));
  const [openCheckId, setOpenCheckId] = useAtom(openCheckAtom);
  const attached = state.frozen;
  const attachments = state.attachments ?? [];
  const openCheck = attachments.find(
    (attachment) => attachment.id === openCheckId
  );
  const openTimespan = openTeachingTimespan(instructions);
  const focusField = () => field.current?.focus();
  // A pick lands while the card stays open, after the press on the Page took
  // focus. Writing about the element is next, so the field takes it back.
  useEffect(() => {
    if (attached !== undefined) {
      field.current?.focus();
    }
  }, [attached]);
  const selectScan = (mode: ScanMode, stop = false) => {
    onScanChange({
      id:
        stop && openTimespan !== undefined
          ? openTimespan.id
          : globalThis.crypto.randomUUID(),
      mode,
      phase: stop ? "stop" : "start",
    });
    if (
      state.draft.trim() === "" ||
      /^@(?:performance|a11y)$/u.test(state.draft.trim())
    ) {
      onDraftChange(
        stop
          ? "Stop the timespan performance scan here."
          : `Run ${scanLabels[mode].toLowerCase()} here.`
      );
    }
    onScanMenuChange(false);
    focusField();
  };
  // Removing a chip unmounts the button that held focus. A non-modal dialog
  // takes Escape only while focus is inside it, so focus goes to the field.
  const removeThen = (remove: () => void) => () => {
    remove();
    focusField();
  };
  const removeAttachment = (id: string) => {
    onAttachmentsChange(attachments.filter((existing) => existing.id !== id));
    if (openCheckId === id) {
      setOpenCheckId(null);
    }
    focusField();
  };
  const attach = (attachment: TeachingBrowserAttachment) => {
    onAttach(attachment);
    setOpenCheckId(attachment.id);
  };
  const submit = () => {
    const inputs = popup.current?.querySelectorAll<HTMLInputElement>(
      "input, textarea, select"
    );
    for (const input of inputs ?? []) {
      if (!input.reportValidity()) {
        return;
      }
    }
    setOpenCheckId(null);
    onSubmit();
  };
  const pinned = new Set(state.comments.map((comment) => comment.index));
  return (
    <CommentCard
      aside={
        openCheck === undefined ? undefined : (
          <BrowserAttachmentEditor
            attachment={openCheck}
            className="max-h-full"
            key={openCheck.id}
            onChange={(updated) =>
              onAttachmentsChange(
                attachments.map((existing) =>
                  existing.id === updated.id ? updated : existing
                )
              )
            }
            onClose={() => {
              setOpenCheckId(null);
              focusField();
            }}
            onRemove={() => removeAttachment(openCheck.id)}
          />
        )
      }
      attach={{
        attached: attached !== undefined,
        disabled: pending,
        onCancel: onCancelPick,
        onPick,
        picking: state.open,
        shortcut: shortcutKeys("inspect", "chord", platform).join(
          platform === "mac" ? "" : "+"
        ),
      }}
      canSubmit={!pending && state.draft.trim() !== ""}
      chips={
        <>
          {attached === undefined ? null : (
            <CommentChip
              disabled={pending}
              icon={<MousePointer2Icon aria-hidden="true" />}
              onRemove={removeThen(onDetach)}
              removeLabel="Remove attached element"
              tone="element"
            >
              <span className="truncate">{attached.description}</span>
            </CommentChip>
          )}
          {state.scan === undefined ? null : (
            <CommentChip
              disabled={pending}
              icon={<ActivityIcon aria-hidden="true" />}
              onRemove={removeThen(() => onScanChange())}
              removeLabel="Remove scan"
              tone="scan"
            >
              <span className="truncate">{scanName(state.scan)}</span>
            </CommentChip>
          )}
          {attachments.map((attachment) => (
            <BrowserAttachmentChip
              attachment={attachment}
              disabled={pending}
              key={attachment.id}
              onOpen={() =>
                setOpenCheckId(
                  openCheckId === attachment.id ? null : attachment.id
                )
              }
              onRemove={() => removeAttachment(attachment.id)}
              open={openCheckId === attachment.id}
            />
          ))}
        </>
      }
      draft={state.draft}
      earlier={instructions.map((instruction, position) => ({
        details:
          instruction.scan === undefined ? [] : [scanName(instruction.scan)],
        id: instruction.id,
        index: position + 1,
        pinned: pinned.has(position + 1),
        target: instruction.target ?? undefined,
        text: instruction.text,
        time: elapsedClock(startedAt, Date.parse(instruction.at)),
      }))}
      editingId={state.editingInstructionId}
      error={state.error}
      fieldRef={field}
      note={
        openTimespan === undefined || state.scan !== undefined ? null : (
          <p className="text-muted-foreground text-xs">
            A timespan is open. Later Runs collect it until you end it.
          </p>
        )
      }
      onBackspaceEmpty={attached === undefined ? undefined : onDetach}
      onCloseAside={() => setOpenCheckId(null)}
      onDraftChange={onDraftChange}
      onDragOver={(event) => {
        if (!pending && event.dataTransfer.types.includes(attachmentMime)) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (pending) {
          return;
        }
        const attachment = readAttachment(event);
        if (attachment !== undefined) {
          event.preventDefault();
          attach(attachment);
        }
      }}
      onEdit={(id) => {
        const instruction = instructions.find((each) => each.id === id);
        if (instruction !== undefined) {
          onEdit(instruction);
          focusField();
        }
      }}
      onHighlight={onHighlight}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      open={state.composing}
      pending={pending}
      placeholder={
        attached === undefined
          ? "What should the agent know about this moment?"
          : "What should change here?"
      }
      popupRef={popup}
      startedAt={startedAt}
      tools={
        <>
          <ScanTools
            open={state.scanMenu ?? false}
            onOpenChange={onScanMenuChange}
            openTimespan={openTimespan}
            pending={pending}
            selectScan={selectScan}
          />
          <Button
            aria-label="Require an unseen cookie"
            title="Require an unseen cookie"
            disabled={pending || attachments.length >= 50}
            onClick={() => {
              const context = storageAttachment(
                origin,
                "cookie-name",
                "cookie"
              );
              attach({ ...context, requirement: context.candidate });
            }}
            size="island-icon"
            type="button"
          >
            <DatabaseIcon aria-hidden="true" />
          </Button>
        </>
      }
    />
  );
};
