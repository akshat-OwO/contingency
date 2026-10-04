import {
  CircleAlertIcon,
  CircleIcon,
  EllipsisIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  SquareIcon,
  TimerIcon,
} from "lucide-react";

import { ShortcutKbd } from "@/components/agent/teaching-comment-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { DockModel } from "./fixtures";

/**
 * The dock's pieces, built from the same `ui/` primitives and with the same
 * classes the shipped docks use. Every prototype composes these, so the
 * prototypes differ only in layout, never in what a badge or button looks
 * like.
 */

export const StateBadge = ({ model }: { readonly model: DockModel }) => (
  <Badge
    variant={
      model.tone === "failed"
        ? "destructive"
        : model.tone === "recording"
          ? "default"
          : "secondary"
    }
  >
    {model.tone === "recording" ? (
      <CircleIcon aria-hidden="true" className="fill-current text-red-500" />
    ) : null}
    {model.tone === "failed" ? <CircleAlertIcon aria-hidden="true" /> : null}
    {model.badge}
  </Badge>
);

export const ProvenanceBadge = ({ model }: { readonly model: DockModel }) =>
  model.provenance === undefined ? null : (
    <Badge variant="outline">{model.provenance}</Badge>
  );

const orderedSessions = (model: DockModel) => [
  model.sessionLabel,
  ...model.sessions.filter((session) => session !== model.sessionLabel),
];

/** The shipped `DockSessionSelect`: a native select, kept for the baseline. */
export const NativeSessionSelect = ({
  className,
  model,
}: {
  readonly className?: string;
  readonly model: DockModel;
}) => (
  <select
    aria-label="Agent Session"
    className={cn(
      "bg-background focus-visible:ring-ring h-8 max-w-[12rem] min-w-0 rounded-md border px-2 text-sm outline-none focus-visible:ring-2",
      className
    )}
    defaultValue={model.sessionLabel}
  >
    {orderedSessions(model).map((session) => (
      <option key={session} value={session}>
        {session}
      </option>
    ))}
  </select>
);

/**
 * A session label reads `Flow Skill · Activity`, or the bare Flow Skill name
 * while teaching. The name is what a person picks by; the activity is a quiet
 * second column so two sessions of one Flow Skill still tell apart.
 */
const SessionName = ({ label }: { readonly label: string }) => {
  const [name, activity] = label.split(" · ");
  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-3">
      <span className="truncate">{name}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {activity ?? "Teaching"}
      </span>
    </span>
  );
};

/** The session picker on the shadcn `Select`, as the device bar uses it. */
export const SessionSelect = ({
  className,
  model,
}: {
  readonly className?: string;
  readonly model: DockModel;
}) => (
  <Select defaultValue={model.sessionLabel}>
    <SelectTrigger
      aria-label="Agent Session"
      className={cn("max-w-[14rem] min-w-0", className)}
      size="default"
    >
      <SelectValue>
        {(value: string | null) => (
          <span className="truncate">{(value ?? "").split(" · ")[0]}</span>
        )}
      </SelectValue>
    </SelectTrigger>
    <SelectContent
      align="start"
      alignItemWithTrigger={false}
      className="w-96 max-w-[calc(100vw-2rem)]"
      side="top"
    >
      <SelectGroup>
        <SelectLabel>Agent Sessions</SelectLabel>
        {orderedSessions(model).map((session) => (
          <SelectItem
            className="*:first:min-w-0 *:first:shrink"
            key={session}
            value={session}
          >
            <SessionName label={session} />
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  </Select>
);

export const Elapsed = ({ model }: { readonly model: DockModel }) =>
  model.elapsed === undefined ? null : (
    <span
      aria-label={`Recording for ${model.elapsed}`}
      className="shrink-0 font-mono text-sm tabular-nums"
      role="timer"
    >
      {model.elapsed}
    </span>
  );

export const Idle = ({
  compact = false,
  model,
}: {
  readonly compact?: boolean;
  readonly model: DockModel;
}) =>
  model.idle === undefined ? null : (
    <span
      className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-xs tabular-nums"
      title={model.idle}
    >
      <TimerIcon aria-hidden="true" className="size-3.5" />
      {compact ? model.idle.replace("Agent idle for ", "") : model.idle}
    </span>
  );

/** The coverage counter, opening the active Agent Step like `RunCoverage`. */
export const Coverage = ({
  compact = false,
  model,
}: {
  readonly compact?: boolean;
  readonly model: DockModel;
}) => {
  if (model.coverage === undefined) {
    return null;
  }
  const label = compact
    ? model.coverage.replace(" Agent Steps executed", "")
    : model.coverage;
  if (model.step === undefined) {
    return (
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {label}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            aria-label={`${model.coverage}. ${model.step?.label}.`}
            size="sm"
            variant="ghost"
          >
            {compact ? <ListChecksIcon aria-hidden="true" /> : null}
            <span className="tabular-nums">{label}</span>
          </Button>
        )}
      />
      <PopoverContent align="end" side="top">
        <StepDetails model={model} />
      </PopoverContent>
    </Popover>
  );
};

export const StepDetails = ({ model }: { readonly model: DockModel }) =>
  model.step === undefined ? null : (
    <div className="space-y-1">
      <p className="font-heading text-sm font-medium">{model.step.label}</p>
      <p className="text-sm">{model.step.name}</p>
      <p className="text-muted-foreground max-h-64 overflow-y-auto text-xs">
        Done when: {model.step.doneWhen}
      </p>
    </div>
  );

export const TaskDetailsBody = ({ model }: { readonly model: DockModel }) =>
  model.task === undefined ? null : (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Requested task</p>
        <p>{model.task.requestedTask}</p>
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Instructions</p>
        <ol className="list-decimal space-y-1 pl-4">
          {model.task.instructions.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>
      </div>
    </div>
  );

export const TaskDetails = ({
  icon = false,
  model,
}: {
  readonly icon?: boolean;
  readonly model: DockModel;
}) =>
  model.task === undefined ? null : (
    <Popover>
      <PopoverTrigger
        render={(props) =>
          icon ? (
            <Button
              {...props}
              aria-label="Task details"
              size="icon-sm"
              variant="ghost"
            >
              <ListChecksIcon />
            </Button>
          ) : (
            <Button {...props} size="sm" variant="ghost">
              Task details
            </Button>
          )
        }
      />
      <PopoverContent
        align="end"
        className="max-h-[60svh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
        side="top"
      >
        <PopoverTitle>{model.task.kind}</PopoverTitle>
        <TaskDetailsBody model={model} />
      </PopoverContent>
    </Popover>
  );

export const CommentButton = ({
  compact = false,
  model,
}: {
  readonly compact?: boolean;
  readonly model: DockModel;
}) =>
  model.comments === undefined ? null : (
    <Button
      aria-label={`Comment, ${model.comments} comments so far`}
      size={compact ? "icon-sm" : "sm"}
      type="button"
      variant="ghost"
    >
      <MessageSquareTextIcon aria-hidden="true" />
      {compact ? null : "Comment"}
      {compact ? null : (
        <span className="text-muted-foreground tabular-nums">
          {model.comments}
        </span>
      )}
      {compact ? null : (
        <ShortcutKbd platform="mac" scope="bare" shortcut="compose" />
      )}
    </Button>
  );

export const PrimaryAction = ({ model }: { readonly model: DockModel }) => {
  const { primary } = model;
  if (primary === undefined) {
    return null;
  }
  return (
    <Button type="button" variant={primary.variant}>
      {primary.icon === "stop" ? (
        <SquareIcon aria-hidden="true" className="fill-current" />
      ) : null}
      {primary.icon === "record" ? (
        <CircleIcon aria-hidden="true" className="fill-current" />
      ) : null}
      {primary.label}
    </Button>
  );
};

export const Secondaries = ({ model }: { readonly model: DockModel }) =>
  model.secondaries.map((secondary) => (
    <Button key={secondary} size="sm" type="button" variant="outline">
      {secondary}
    </Button>
  ));

/**
 * Everything a narrow dock cannot seat, in one menu. Items keep their own
 * labels so the menu reads as the same actions, not a second vocabulary. Each
 * variant renders one menu per width band, so nothing in it duplicates a
 * control that is still on screen.
 */
export const OverflowMenu = ({
  className,
  model,
  withCoverage = false,
  withSessions = false,
  withTask = false,
}: {
  readonly className?: string;
  readonly model: DockModel;
  readonly withCoverage?: boolean;
  readonly withSessions?: boolean;
  readonly withTask?: boolean;
}) => {
  const hasTask = withTask && model.task !== undefined;
  const status = withCoverage
    ? [model.coverage, model.idle].filter((line) => line !== undefined)
    : [];
  if (
    model.secondaries.length === 0 &&
    !hasTask &&
    status.length === 0 &&
    !withSessions
  ) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button
            {...props}
            aria-label="More actions"
            className={className}
            size="icon-sm"
            variant="ghost"
          >
            <EllipsisIcon />
          </Button>
        )}
      />
      <DropdownMenuContent align="end" className="w-64" side="top">
        {status.length === 0 ? null : (
          <>
            <DropdownMenuGroup>
              {status.map((line) => (
                <DropdownMenuLabel className="tabular-nums" key={line}>
                  {line}
                </DropdownMenuLabel>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        {withSessions ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Switch session</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72">
              <DropdownMenuRadioGroup value={model.sessionLabel}>
                {[
                  model.sessionLabel,
                  ...model.sessions.filter(
                    (session) => session !== model.sessionLabel
                  ),
                ].map((session) => (
                  <DropdownMenuRadioItem key={session} value={session}>
                    <span className="truncate">{session}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {hasTask || model.secondaries.length > 0 ? (
          <DropdownMenuGroup>
            {hasTask ? <DropdownMenuItem>Task details</DropdownMenuItem> : null}
            {model.secondaries.map((secondary) => (
              <DropdownMenuItem key={secondary}>{secondary}</DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ControlError = ({ model }: { readonly model: DockModel }) =>
  model.error === undefined ? null : (
    <p className="text-destructive text-xs">{model.error}</p>
  );
