import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  DatabaseIcon,
  FingerprintIcon,
  GlobeIcon,
  LockKeyholeIcon,
  PanelBottomIcon,
  RotateCwIcon,
  SparklesIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";

import { WorkspaceWithRunSummary } from "@/components/agent/run-summary-sidebar";
import { RailBadge, RailButton } from "@/components/browser/inspector-rail";
import { ModeToggle } from "@/components/mode-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

import type { DockModel } from "./fixtures";
import type { DockVariant } from "./variants";

export type LayoutId =
  | "devtools-bottom"
  | "devtools-right"
  | "none"
  | "summary"
  | "summary-devtools"
  | "summary-devtools-right";

export const layoutLabels: Record<LayoutId, string> = {
  "devtools-bottom": "Devtools docked bottom",
  "devtools-right": "Devtools docked right",
  none: "Browser only",
  summary: "Dry Run Summary open",
  "summary-devtools": "Summary + devtools (auto: bottom)",
  "summary-devtools-right": "Summary + devtools forced right",
};

/** The same sizes `WorkspaceBrowserStage` defaults to. */
const RIGHT_WIDTH = 576;
const BOTTOM_HEIGHT = 320;

/** A copy of `AgentBrowserToolbar`'s markup, without its gestures. */
const Toolbar = () => (
  <div className="bg-background flex h-11 shrink-0 items-center gap-1.5 border-b px-2">
    <div aria-label="Browser navigation" className="flex gap-0.5" role="group">
      <Button aria-label="Go back" disabled size="icon-sm" variant="ghost">
        <ArrowLeftIcon />
      </Button>
      <Button aria-label="Go forward" disabled size="icon-sm" variant="ghost">
        <ArrowRightIcon />
      </Button>
      <Button aria-label="Reload page" disabled size="icon-sm" variant="ghost">
        <RotateCwIcon />
      </Button>
    </div>
    <div className="min-w-0 flex-1">
      <InputGroup className="bg-muted/40 h-8">
        <InputGroupAddon align="inline-start">
          <LockKeyholeIcon aria-hidden="true" className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Browser address"
          disabled
          readOnly
          value="http://127.0.0.1:4173/checkout"
        />
      </InputGroup>
    </div>
    <ModeToggle />
  </div>
);

/** A stand-in for the screencast: a page is always light, like a real one. */
const FakePage = () => (
  <div className="flex size-full max-w-[1100px] flex-col overflow-hidden rounded-md border bg-white text-neutral-900 shadow-sm">
    <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-3">
      <span className="font-semibold">Linen &amp; Loom</span>
      <span className="text-sm text-neutral-500">Cart (1)</span>
    </div>
    <div className="grid flex-1 gap-6 p-6 md:grid-cols-[1fr_18rem]">
      <div className="space-y-3">
        <p className="text-lg font-semibold">Checkout</p>
        {["Email", "Full name", "Address", "City", "Postcode"].map((field) => (
          <div className="space-y-1" key={field}>
            <p className="text-xs text-neutral-500">{field}</p>
            <div className="h-8 rounded border border-neutral-300" />
          </div>
        ))}
      </div>
      <div className="hidden space-y-2 rounded border border-neutral-200 p-4 text-sm md:block">
        <p className="font-medium">Order summary</p>
        <p className="flex justify-between">
          <span>Linen Overshirt · M</span>
          <span>$84.00</span>
        </p>
        <p className="flex justify-between text-emerald-700">
          <span>SPRING25</span>
          <span>−$21.00</span>
        </p>
        <p className="flex justify-between border-t border-neutral-200 pt-2 font-medium">
          <span>Total</span>
          <span>$63.00</span>
        </p>
      </div>
    </div>
  </div>
);

const CONSOLE_LINES = [
  ["info", "[vite] connected."],
  ["log", "cart: hydrated 1 item from localStorage"],
  ["warn", "Coupon SPRING25 applied after price recalculation"],
  ["error", "Failed to load resource: /api/recommendations 404"],
  ["log", "checkout: step=shipping"],
] as const;

/** A stand-in for `BrowserDevtools`: same surface, header, and density. */
const DevtoolsPanel = ({ side }: { readonly side: "bottom" | "right" }) => (
  <section
    aria-label="Console"
    className="bg-background flex size-full min-h-0 flex-col"
  >
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
      <TerminalIcon
        aria-hidden="true"
        className="text-muted-foreground size-3.5"
      />
      <span className="text-sm font-medium">Console</span>
      <span className="text-muted-foreground truncate text-xs">
        Checkout · 127.0.0.1:4173
      </span>
      <div className="flex-1" />
      <Button aria-label="Move devtools" size="icon-xs" variant="ghost">
        <PanelBottomIcon
          className={cn(side === "bottom" && "rotate-[-90deg]")}
        />
      </Button>
      <Button aria-label="Close devtools" size="icon-xs" variant="ghost">
        <XIcon />
      </Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
      {CONSOLE_LINES.map(([level, text]) => (
        <p
          className={cn(
            "border-b px-3 py-1.5",
            level === "warn" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            level === "error" && "bg-destructive/10 text-destructive"
          )}
          key={text}
        >
          {text}
        </p>
      ))}
    </div>
  </section>
);

const Rail = ({ open }: { readonly open: boolean }) => (
  <nav
    aria-label="Browser tools"
    className="bg-background flex w-12 shrink-0 flex-col items-center gap-1 border-l py-2"
  >
    <RailButton
      active={false}
      icon={<FingerprintIcon />}
      label="User agent"
      onClick={() => undefined}
    />
    <RailButton
      active={false}
      icon={<SparklesIcon />}
      label="Emulation"
      onClick={() => undefined}
    />
    <span aria-hidden="true" className="bg-border my-1 h-px w-5" />
    <RailButton
      active={open}
      badge={<RailBadge tone="danger">1</RailBadge>}
      icon={<TerminalIcon />}
      label="Console"
      onClick={() => undefined}
    />
    <RailButton
      active={false}
      badge={<RailBadge tone="neutral">24</RailBadge>}
      icon={<GlobeIcon />}
      label="Network"
      onClick={() => undefined}
    />
    <RailButton
      active={false}
      icon={<DatabaseIcon />}
      label="Storage"
      onClick={() => undefined}
    />
  </nav>
);

/** A stand-in for `DryRunSummaryView`, at its real docked width. */
const Summary = () => (
  <div className="space-y-4 text-sm">
    <div className="flex items-center gap-2">
      <Badge variant="secondary">
        <CircleCheckIcon aria-hidden="true" />
        Passed
      </Badge>
      <span className="text-muted-foreground text-xs">
        Guest checkout with coupon
      </span>
    </div>
    <div className="bg-muted aspect-video rounded-lg" />
    <div className="space-y-2">
      <p className="font-medium">Pass checks</p>
      {[
        "Cart shows the Linen Overshirt in size M",
        "Coupon SPRING25 reduces the total",
        "Shipping address matches the setup variables",
        "Checkout stops before the payment is submitted",
      ].map((check) => (
        <p className="flex items-start gap-2" key={check}>
          <CircleCheckIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-emerald-600"
          />
          {check}
        </p>
      ))}
    </div>
  </div>
);

export const WorkspaceFrame = ({
  layout,
  model,
  variant,
}: {
  readonly layout: LayoutId;
  readonly model: DockModel;
  readonly variant: DockVariant;
}) => {
  const devtools =
    layout === "devtools-bottom" || layout === "summary-devtools"
      ? "bottom"
      : layout === "devtools-right" || layout === "summary-devtools-right"
        ? "right"
        : undefined;
  const summary = layout.startsWith("summary");
  const { Dock } = variant;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <WorkspaceWithRunSummary
        label="Dry Run Summary"
        summary={summary ? <Summary /> : null}
      >
        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <Toolbar />
          <div className="relative flex min-h-0 flex-1">
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                devtools === "right" ? "flex-row" : "flex-col"
              )}
            >
              <section
                aria-label="Browser stage"
                className="bg-muted/40 relative flex min-h-0 min-w-0 flex-1 flex-col bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px]"
              >
                <div className="flex shrink-0 justify-center px-2 pt-2">
                  <div className="bg-background text-muted-foreground flex h-8 items-center gap-2 rounded-lg border px-3 text-xs shadow-xs">
                    Responsive · 1280 × 800
                  </div>
                </div>
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div
                    className={cn(
                      "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3",
                      model.tone === "recording" &&
                        "ring-2 ring-red-500 ring-inset"
                    )}
                    style={{ paddingBottom: variant.reserve }}
                  >
                    <FakePage />
                  </div>
                  <Dock key={model.sessionLabel + model.badge} model={model} />
                </div>
              </section>
              {devtools === undefined ? null : (
                <>
                  <div
                    className={cn(
                      "bg-border shrink-0",
                      devtools === "right" ? "w-px" : "h-px"
                    )}
                  />
                  <div
                    className="flex min-h-0 min-w-0 shrink-0 flex-col"
                    style={
                      devtools === "right"
                        ? {
                            width:
                              layout === "summary-devtools-right"
                                ? "min(576px, 60%)"
                                : RIGHT_WIDTH,
                          }
                        : { height: BOTTOM_HEIGHT }
                    }
                  >
                    <DevtoolsPanel side={devtools} />
                  </div>
                </>
              )}
            </div>
            <Rail open={devtools !== undefined} />
          </div>
        </main>
      </WorkspaceWithRunSummary>
    </div>
  );
};
