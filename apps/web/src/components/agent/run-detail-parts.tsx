import { useRouter } from "@tanstack/react-router";
import { CircleCheckIcon, CircleMinusIcon, CircleXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useContext } from "react";

import { cn } from "@/lib/utils";

import { clockTime, DetailHeadingLevel } from "./run-detail-state";

/**
 * The parts every Run details section is built from (#778): an eyebrow
 * heading with its count on the right, then one outlined list of rows. The
 * Run dock's Task details and the Run Summary's tabs share them.
 */

export const detailEyebrowClassName =
  "text-muted-foreground/80 text-xs font-medium tracking-[0.06em] uppercase";

export const DetailSection = ({
  children,
  heading,
  label,
  meta,
  metaTone,
}: {
  readonly children: ReactNode;
  /** The visible heading, when it says more than the region's name. */
  readonly heading?: string;
  readonly label: string;
  /** A count or coverage, beside the heading. */
  readonly meta?: ReactNode | undefined;
  readonly metaTone?: "failed" | undefined;
}) => {
  const Heading = useContext(DetailHeadingLevel) === 4 ? "h4" : "h3";
  return (
    <section aria-label={label} className="grid min-w-0 gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <Heading className={detailEyebrowClassName}>{heading ?? label}</Heading>
        {meta === undefined ? null : (
          <span
            className={cn(
              "text-muted-foreground text-xs tabular-nums",
              metaTone === "failed" && "text-destructive font-medium"
            )}
          >
            {meta}
          </span>
        )}
      </div>
      {children}
    </section>
  );
};

/** One line where a section that always shows has nothing yet. */
export const DetailEmpty = ({ children }: { readonly children: ReactNode }) => (
  <p className="text-muted-foreground text-[13px]">{children}</p>
);

const rowsClassName =
  "border-island-border grid min-w-0 rounded-[14px] shadow-[inset_0_0_0_1px_var(--island-border)] [&>li+li]:border-t";

export const DetailRows = ({
  children,
  label,
  ordered = false,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly ordered?: boolean;
}) =>
  ordered ? (
    <ol aria-label={label} className={rowsClassName}>
      {children}
    </ol>
  ) : (
    <ul aria-label={label} className={rowsClassName}>
      {children}
    </ul>
  );

export const DetailRow = ({
  children,
  lead,
  muted = false,
}: {
  readonly children: ReactNode;
  /** A mark or a time, in the row's first column. */
  readonly lead: ReactNode;
  readonly muted?: boolean;
}) => (
  <li
    className={cn(
      "border-island-border grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 px-3 py-2 text-[13px] wrap-anywhere",
      muted && "text-muted-foreground"
    )}
  >
    {lead}
    <div className="grid min-w-0 gap-0.5">{children}</div>
  </li>
);

export type DetailTone = "passed" | "failed" | "open";

/** A row's title, with its status word on the right in the row's tone. */
export const DetailRowTitle = ({
  children,
  status,
  tone,
}: {
  readonly children: ReactNode;
  readonly status?: string;
  readonly tone?: DetailTone;
}) => (
  <div className="flex items-baseline justify-between gap-2 font-medium">
    <span className="min-w-0">{children}</span>
    {status === undefined ? null : (
      <span
        className={cn(
          "text-muted-foreground shrink-0 text-xs font-medium",
          tone === "passed" && "text-status-ready",
          tone === "failed" && "text-destructive"
        )}
      >
        {status}
      </span>
    )}
  </div>
);

export const DetailRowText = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <p
    className={cn("text-muted-foreground text-[12.5px] text-pretty", className)}
  >
    {children}
  </p>
);

/** The row's smallest line: where it came from and when. */
export const DetailRowFoot = ({
  children,
}: {
  readonly children: ReactNode;
}) => (
  <p className="text-muted-foreground/80 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
    {children}
  </p>
);

/** A pass, fail or open mark, named for a screen reader. */
export const DetailMark = ({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: DetailTone;
}) => {
  if (tone === "passed") {
    return (
      <CircleCheckIcon
        aria-label={label}
        className="text-status-ready mt-px size-4 shrink-0"
        role="img"
      />
    );
  }
  if (tone === "failed") {
    return (
      <CircleXIcon
        aria-label={label}
        className="text-destructive mt-px size-4 shrink-0"
        role="img"
      />
    );
  }
  return (
    <CircleMinusIcon
      aria-label={label}
      className="text-muted-foreground/70 mt-px size-4 shrink-0"
      role="img"
    />
  );
};

/** A time in a row's first column. */
export const DetailTime = ({ at }: { readonly at: string }) => (
  <time
    className="text-muted-foreground min-w-14 font-mono text-xs leading-5 tabular-nums"
    dateTime={at}
    title={at}
  >
    {clockTime(at)}
  </time>
);

/** Facts as a two-column list: term on the left, value on the right. */
export const DetailFacts = ({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label?: string;
}) => (
  <dl
    aria-label={label}
    className="[&_dt]:text-muted-foreground grid grid-cols-[minmax(5.5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px] [&_dd]:wrap-anywhere"
  >
    {children}
  </dl>
);

const flowPillClassName =
  "bg-island-hover ring-island-border inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-lg px-2.5 font-mono text-xs font-medium ring-1 ring-inset";

/**
 * A Flow the Run referenced, as a pill to it on the Flows page. Inside the
 * router it opens there without reloading the Workspace. A bundled Example
 * lives outside every Catalog Root, so the Flows page has no entry for it and
 * its pill is not a link.
 */
export const FlowPill = ({
  example,
  name,
}: {
  readonly example: boolean;
  readonly name: string;
}) => {
  // SAFETY: with `warn: false`, useRouter returns the context value as is,
  // which is null outside a RouterProvider, as in component tests.
  const router = useRouter({ warn: false }) as ReturnType<
    typeof useRouter
  > | null;
  if (example) {
    return (
      <span className={flowPillClassName}>
        <span className="truncate">{name}</span>{" "}
        <span className="rounded-md bg-[color-mix(in_oklch,var(--island-brand)_22%,transparent)] px-1.5 py-px font-sans text-xs font-semibold text-(--status-needs-you)">
          Example
        </span>
      </span>
    );
  }
  return (
    // oxlint-disable-next-line react-doctor/no-prevent-default -- Inside the router the page opens without a reload.
    <a
      className={cn(flowPillClassName, "hover:ring-island-brand")}
      href={`/flow?flow=${encodeURIComponent(name)}`}
      onClick={(event) => {
        if (
          router === null ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        void router.navigate({ search: { flow: name }, to: "/flow" });
      }}
    >
      <span className="truncate">{name}</span>
    </a>
  );
};
