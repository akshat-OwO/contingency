import { ChevronRightIcon, CircleAlertIcon, XIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { PlatformIcon } from "./platform-icons";
import { homePlatformName } from "./workspace-home-state";
import type { HomePlatform } from "./workspace-home-state";

/** A platform's icon on a dark rounded square, as the tiles and cards show it. */
export const TileIcon = ({
  platform,
  small = false,
}: {
  readonly platform: HomePlatform;
  readonly small?: boolean;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "bg-foreground text-background grid shrink-0 place-items-center shadow-[0_8px_18px_-8px_oklch(0_0_0/0.45)]",
      small ? "size-11 rounded-[14px]" : "size-[52px] rounded-2xl"
    )}
  >
    <PlatformIcon
      className={small ? "size-[22px]" : "size-[26px]"}
      platform={platform}
    />
  </span>
);

export const SectionNumber = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "bg-island-hover text-muted-foreground inline-grid size-[22px] shrink-0 place-items-center rounded-[7px] font-mono text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--island-border)]",
      className
    )}
  >
    {children}
  </span>
);

/** One numbered section of a start card: 1 the Flow, 2 what it opens. */
export const StartSection = ({
  children,
  label,
  number,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly number: number;
}) => (
  <section
    aria-label={label}
    className="border-island-border relative grid min-w-0 grid-cols-1 gap-3 border-t py-3.5 pl-9"
  >
    <SectionNumber className="absolute top-3.5 left-0">{number}</SectionNumber>
    {children}
  </section>
);

/**
 * The Flow name every start card asks for first. The home holds the value, so
 * it carries over when the card swaps platform or closes and reopens.
 */
export const FlowNameField = ({
  name,
  onChange,
  problem,
}: {
  readonly name: string;
  readonly onChange: (name: string) => void;
  /** Why the name cannot be a Flow name, or null when it can. */
  readonly problem: string | null;
}) => {
  const ids = useId();
  return (
    <div className="grid gap-1.5">
      <Label className="text-[13px]" htmlFor={`${ids}-name`}>
        Flow name
      </Label>
      <Input
        aria-describedby={problem === null ? undefined : `${ids}-problem`}
        aria-invalid={problem !== null}
        autoComplete="off"
        autoFocus
        className="font-mono"
        id={`${ids}-name`}
        onChange={(event) => onChange(event.target.value)}
        required
        spellCheck={false}
        value={name}
        variant="island"
      />
      {problem === null ? null : (
        <p className="text-destructive text-xs" id={`${ids}-problem`}>
          {problem}
        </p>
      )}
    </div>
  );
};

/** Section 3 of every start card: Setup, collapsed until asked for. */
export const StartSetup = ({
  children,
  summary,
}: {
  readonly children: ReactNode;
  /** What Setup holds, said beside its name. */
  readonly summary: string;
}) => (
  <Collapsible className="border-island-border border-t">
    <CollapsibleTrigger className="group/setup flex w-full items-center gap-3.5 py-3.5 text-left">
      <SectionNumber>3</SectionNumber>
      <span className="text-sm font-medium">Setup</span>
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {summary}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 transition-transform duration-300 group-data-open/setup:rotate-90 motion-reduce:transition-none"
      />
    </CollapsibleTrigger>
    <CollapsibleContent className="pb-4 pl-9">{children}</CollapsibleContent>
  </Collapsible>
);

/**
 * The start card every platform shares: a form named "Teach on <platform>"
 * with the platform's tile icon, its numbered sections, Start teaching, why
 * the last start failed, and pills that swap to another platform in place.
 * Escape and Back to platforms fold it back into the tiles. `outside` renders
 * beside the form, so a dialog it opens keeps its own Escape.
 */
export const StartCard = ({
  children,
  error,
  footer,
  formRef,
  onClose,
  onOtherPlatform,
  onSubmit,
  outside,
  platform,
  platforms,
  submitDescribedBy,
  submitDisabled,
}: {
  readonly children: ReactNode;
  readonly error: string | undefined;
  /** What sits under Start teaching, such as why it is waiting. */
  readonly footer?: ReactNode;
  readonly formRef?: Ref<HTMLFormElement>;
  readonly onClose: () => void;
  readonly onOtherPlatform: (platform: HomePlatform) => void;
  readonly onSubmit: (form: HTMLFormElement) => void;
  readonly outside?: ReactNode;
  readonly platform: HomePlatform;
  readonly platforms: readonly HomePlatform[];
  readonly submitDescribedBy?: string | undefined;
  readonly submitDisabled: boolean;
}) => {
  const ids = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      // An open list, or a combobox whose list is open, closes first.
      (event.target instanceof Element &&
        event.target.closest(
          '[role="listbox"], [role="combobox"][aria-expanded="true"]'
        ) !== null)
    ) {
      return;
    }
    event.preventDefault();
    onClose();
  };
  return (
    <div className="grid w-full justify-items-center gap-3.5">
      <form
        aria-labelledby={`${ids}-title`}
        className="island shadow-island-lift grid w-full max-w-[540px] grid-cols-1 gap-1 p-5 [--island-radius:28px]"
        data-vt="start-card"
        noValidate
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitDisabled) {
            onSubmit(event.currentTarget);
          }
        }}
        ref={formRef}
      >
        <header className="mb-3 flex items-center gap-3">
          <TileIcon platform={platform} small />
          <div className="min-w-0 flex-1">
            <h2
              className="text-[17px] font-semibold tracking-[-0.02em]"
              id={`${ids}-title`}
            >
              Teach on {homePlatformName(platform)}
            </h2>
            <p className="text-muted-foreground text-[13px]">
              Name the Flow, choose where it runs and what it opens.
            </p>
          </div>
          <Button
            aria-label="Back to platforms"
            onClick={onClose}
            size="island-icon"
            title="Back to platforms"
            variant="island"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </header>
        {children}
        <Button
          aria-describedby={submitDescribedBy}
          className="mt-1.5 w-full"
          disabled={submitDisabled}
          size="island-lg"
          type="submit"
        >
          Start teaching
        </Button>
        {footer}
        {error === undefined ? null : (
          <Alert className="mt-3 text-left" variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>The session did not open</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </form>
      {outside}
      {platforms.length === 0 ? null : (
        <div aria-label="Other platforms" className="flex gap-2" role="group">
          {platforms.map((other) => (
            <Button
              key={other}
              onClick={() => onOtherPlatform(other)}
              size="island"
              variant="floating"
            >
              <PlatformIcon platform={other} />
              {homePlatformName(other)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
};
