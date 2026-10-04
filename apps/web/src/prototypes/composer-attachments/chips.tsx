import type { ScanMode } from "@contingency/protocol";
import {
  AccessibilityIcon,
  CircleCheckIcon,
  CookieIcon,
  CrosshairIcon,
  DatabaseIcon,
  GaugeIcon,
  GlobeIcon,
  MousePointerClickIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ShortcutKbd } from "@/components/agent/teaching-comment-composer";
import { SegmentedControl } from "@/components/browser/segmented-control";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import {
  checkSummary,
  evidenceTitle,
  isStale,
  mockElements,
  scanLabels,
  scanTitle,
} from "./model";
import type { Check, ElementRef, Evidence, ScanPick } from "./model";
import { RequestChoices, StorageChoices } from "./parts";

/** The icon a request or a stored item is drawn with everywhere. */
export const EvidenceIcon = ({
  className,
  evidence,
}: {
  readonly className?: string;
  readonly evidence: Evidence;
}) => {
  if (evidence.kind === "request") {
    return <GlobeIcon aria-hidden="true" className={className} />;
  }
  return evidence.area === "cookie" ? (
    <CookieIcon aria-hidden="true" className={className} />
  ) : (
    <DatabaseIcon aria-hidden="true" className={className} />
  );
};

/**
 * Whether a piece of evidence is context or a requirement, and what the
 * requirement asks. The same editor sits behind every chip.
 */
export const RequirementEditor = ({
  allowContext = true,
  check,
  evidence,
  onChange,
  onRequire,
  stepId,
}: {
  readonly allowContext?: boolean;
  readonly check: Check | undefined;
  readonly evidence: Evidence;
  readonly onChange: (check: Check) => void;
  readonly onRequire: (required: boolean) => void;
  readonly stepId: string | undefined;
}) => (
  <div className="flex flex-col gap-2">
    {allowContext ? (
      <SegmentedControl<"context" | "check">
        label="Use as"
        onChange={(value) => onRequire(value === "check")}
        options={[
          { label: "Context for the agent", value: "context" },
          { label: "Must happen", value: "check" },
        ]}
        size="xs"
        value={check === undefined ? "context" : "check"}
      />
    ) : null}
    {check === undefined ? (
      <p className="text-muted-foreground text-xs text-pretty">
        The agent sees this as context. Later Runs don’t fail if it changes.
      </p>
    ) : null}
    {check?.kind === "request" && evidence.kind === "request" ? (
      <RequestChoices check={check} onChange={onChange} request={evidence} />
    ) : null}
    {check?.kind === "storage" && evidence.kind === "storage" ? (
      <StorageChoices check={check} item={evidence} onChange={onChange} />
    ) : null}
    {check !== undefined && isStale(check, stepId) ? (
      <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-3 shrink-0"
        />
        This happened before your last step. Later Runs will wait for a new one.
      </p>
    ) : null}
  </div>
);

/**
 * One attached request or stored item as a chip. Pressing it opens the
 * requirement editor, so the composer itself stays one line tall.
 */
export const EvidenceChip = ({
  check,
  evidence,
  onChange,
  onOpenChange,
  onRemove,
  onRequire,
  open,
  stepId,
}: {
  readonly check: Check | undefined;
  readonly evidence: Evidence;
  readonly onChange: (check: Check) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemove: () => void;
  readonly onRequire: (required: boolean) => void;
  readonly open: boolean;
  readonly stepId: string | undefined;
}) => {
  const title = evidenceTitle(evidence);
  let description = check === undefined ? "Context" : checkSummary(check);
  if (evidence.kind === "storage" && evidence.observed === false) {
    description = `${description} · not seen yet`;
  }
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <Attachment
        className={cn(
          "max-w-64 min-w-0",
          check !== undefined &&
            "border-blue-500/40 bg-blue-500/5 dark:bg-blue-500/10"
        )}
        size="xs"
      >
        <AttachmentMedia
          className={cn(
            check !== undefined &&
              "bg-blue-500/15 text-blue-700 dark:text-blue-300"
          )}
        >
          {check === undefined ? (
            <EvidenceIcon evidence={evidence} />
          ) : (
            <CircleCheckIcon aria-hidden="true" />
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle className="font-mono">{title}</AttachmentTitle>
          <AttachmentDescription>{description}</AttachmentDescription>
        </AttachmentContent>
        <PopoverTrigger
          render={
            <AttachmentTrigger
              aria-label={`${title}: ${description}. Edit`}
              className="rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          }
        />
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${title}`} onClick={onRemove}>
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      </Attachment>
      <PopoverContent
        align="start"
        className="w-[26rem]"
        positionerClassName="z-[60]"
      >
        <PopoverTitle className="flex items-center gap-1.5 font-mono text-xs">
          <EvidenceIcon className="size-3.5" evidence={evidence} />
          {title}
        </PopoverTitle>
        <RequirementEditor
          check={check}
          evidence={evidence}
          onChange={onChange}
          onRequire={onRequire}
          stepId={stepId}
        />
      </PopoverContent>
    </Popover>
  );
};

/** Production's attached-element chip. */
export const ElementChip = ({
  element,
  onRemove,
}: {
  readonly element: ElementRef;
  readonly onRemove: () => void;
}) => (
  <span className="inline-flex max-w-full items-center gap-1 self-start rounded-md bg-blue-500/10 py-0.5 pr-0.5 pl-1.5 text-sm font-medium text-blue-600 dark:text-blue-400">
    <CrosshairIcon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="truncate">{element.description}</span>
    <Button
      aria-label="Remove attached element"
      className="hover:bg-blue-500/15"
      onClick={onRemove}
      size="icon-xs"
      type="button"
      variant="ghost"
    >
      <XIcon />
    </Button>
  </span>
);

export const ScanIcon = ({
  className,
  mode,
}: {
  readonly className?: string;
  readonly mode: ScanMode;
}) =>
  mode === "accessibility" ? (
    <AccessibilityIcon aria-hidden="true" className={className} />
  ) : (
    <GaugeIcon aria-hidden="true" className={className} />
  );

/** A taught scan as a chip beside the other attachments. */
export const ScanChip = ({
  onRemove,
  scan,
}: {
  readonly onRemove: () => void;
  readonly scan: ScanPick;
}) => (
  <Attachment
    className="max-w-64 min-w-0 border-violet-500/40 bg-violet-500/5 dark:bg-violet-500/10"
    size="xs"
  >
    <AttachmentMedia className="bg-violet-500/15 text-violet-700 dark:text-violet-300">
      <ScanIcon mode={scan.mode} />
    </AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>{scanTitle(scan)}</AttachmentTitle>
      <AttachmentDescription>
        {scan.mode === "accessibility" ? "Accessibility" : "Performance"} ·
        later Runs
      </AttachmentDescription>
    </AttachmentContent>
    <AttachmentActions>
      <AttachmentAction aria-label="Remove scan" onClick={onRemove}>
        <XIcon />
      </AttachmentAction>
    </AttachmentActions>
  </Attachment>
);

/** The element picker. Inspect works as it does today; here it is mocked. */
export const ElementButton = ({
  element,
  label = true,
  onPick,
}: {
  readonly element: ElementRef | undefined;
  readonly label?: boolean;
  readonly onPick: (element: ElementRef) => void;
}) => {
  const next =
    mockElements.find((item) => item.id !== element?.id) ?? mockElements[0];
  const text = element === undefined ? "Attach element" : "Change element";
  return (
    <Button
      aria-label={label ? undefined : text}
      onClick={() => {
        if (next !== undefined) {
          onPick(next);
        }
      }}
      size={label ? "sm" : "icon-sm"}
      title={label ? undefined : text}
      type="button"
      variant="ghost"
    >
      <MousePointerClickIcon aria-hidden="true" />
      {label ? (
        <>
          {text}
          <ShortcutKbd
            className="hidden sm:inline-flex"
            platform="mac"
            scope="chord"
            shortcut="inspect"
          />
        </>
      ) : null}
    </Button>
  );
};

/** The performance choices production offers, with an open timespan's end. */
export const PerformanceChoices = ({
  onSelect,
  openSpan,
}: {
  readonly onSelect: (scan: Omit<ScanPick, "id">) => void;
  readonly openSpan: ScanPick | undefined;
}) =>
  openSpan === undefined ? (
    (["reload", "navigation", "timespan"] as const).map((mode) => (
      <Button
        className="justify-start"
        key={mode}
        onClick={() => onSelect({ mode, phase: "start" })}
        variant="ghost"
      >
        <GaugeIcon aria-hidden="true" />
        {scanLabels[mode]}
      </Button>
    ))
  ) : (
    <Button
      className="justify-start"
      onClick={() => onSelect({ mode: "timespan", phase: "stop" })}
      variant="ghost"
    >
      <SquareIcon aria-hidden="true" />
      End timespan
    </Button>
  );

/** Production's two scan buttons: a performance menu and accessibility. */
export const ScanButtons = ({
  onOpenChange,
  onSelect,
  open,
  openSpan,
  trailing,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (scan: Omit<ScanPick, "id">) => void;
  readonly open: boolean;
  readonly openSpan: ScanPick | undefined;
  readonly trailing?: ReactNode;
}) => (
  <>
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label="Performance scan"
            size="icon-sm"
            title="Performance scan"
            type="button"
            variant="ghost"
          />
        }
      >
        <GaugeIcon aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" positionerClassName="z-[60]">
        <PopoverTitle>Teach a scan for later Runs</PopoverTitle>
        <PerformanceChoices
          onSelect={(scan) => {
            onSelect(scan);
            onOpenChange(false);
          }}
          openSpan={openSpan}
        />
        <p className="text-muted-foreground px-2 text-xs">
          The agent will propose when to scan for your review. Reload may
          discard transient page state.
        </p>
      </PopoverContent>
    </Popover>
    <Button
      aria-label="Accessibility scan"
      disabled={openSpan !== undefined}
      onClick={() => onSelect({ mode: "accessibility", phase: "start" })}
      size="icon-sm"
      title="Accessibility scan"
      type="button"
      variant="ghost"
    >
      <AccessibilityIcon aria-hidden="true" />
    </Button>
    {trailing}
  </>
);

/** An observed effect offered as a one-press requirement. */
export const SuggestionChip = ({
  description,
  icon,
  onPress,
  title,
}: {
  readonly description: string;
  readonly icon: ReactNode;
  readonly onPress: () => void;
  readonly title: string;
}) => (
  <Attachment className="max-w-64 min-w-0" size="xs" state="idle">
    <AttachmentMedia className="bg-transparent">{icon}</AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle className="font-mono">{title}</AttachmentTitle>
      <AttachmentDescription>{description}</AttachmentDescription>
    </AttachmentContent>
    <AttachmentTrigger
      aria-label={`Require ${title}: ${description}`}
      className="rounded-lg focus-visible:ring-2 focus-visible:ring-blue-500/40"
      onClick={onPress}
    />
  </Attachment>
);

/** Names a cookie the page has not set yet. Naming never creates it. */
export const ExpectCookieForm = ({
  onExpect,
}: {
  readonly onExpect: (name: string) => void;
}) => (
  <form
    className="flex items-end gap-2"
    onSubmit={(event) => {
      // Portaled popovers still bubble through React's tree; keep this
      // submit from also adding the comment around it.
      event.preventDefault();
      event.stopPropagation();
      const input = event.currentTarget.elements.namedItem("cookie");
      if (input instanceof HTMLInputElement && input.value.trim() !== "") {
        onExpect(input.value.trim());
        input.value = "";
      }
    }}
  >
    <label className="text-muted-foreground flex min-w-0 flex-1 flex-col gap-1 text-xs">
      Expect a cookie that isn’t here yet
      <Input
        className="h-7 font-mono text-xs"
        name="cookie"
        placeholder="e.g. checkout-complete"
      />
    </label>
    <Button size="sm" type="submit" variant="outline">
      Expect
    </Button>
  </form>
);
