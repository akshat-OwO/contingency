import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { CircleAlertIcon, CircleIcon, ShieldAlertIcon } from "lucide-react";

import {
  RequestHeader,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { androidDockPresentation } from "./presentation";

/**
 * Marks Android as experimental without a banner: one badge beside the state
 * badge, and its title says what to expect.
 */
export const ExperimentalBadge = () => (
  <Badge
    title="Android is experimental. Expect fewer features than the browser Workspace."
    variant="outline"
  >
    Experimental
  </Badge>
);

const BADGE_VARIANT = {
  default: "secondary",
  failed: "destructive",
  recording: "default",
} as const;

/** The state badge the shipped dock shows, plus the Experimental badge. */
export const StateBadges = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const presentation = androidDockPresentation(session);
  return (
    <>
      <Badge variant={BADGE_VARIANT[presentation.tone]}>
        {presentation.tone === "recording" ? (
          <CircleIcon
            aria-hidden="true"
            className="fill-current text-red-500"
          />
        ) : null}
        {presentation.tone === "failed" ? (
          <CircleAlertIcon aria-hidden="true" />
        ) : null}
        {presentation.badge}
      </Badge>
      <ExperimentalBadge />
    </>
  );
};

/**
 * A phone frame around a recorded capture. `overlay` sits over the screen,
 * `below` replaces the navigation bar's content.
 */
export const PhoneFrame = ({
  below,
  className,
  dimmed = false,
  image,
  overlay,
}: {
  readonly below?: React.ReactNode;
  readonly className?: string;
  readonly dimmed?: boolean;
  readonly image: string | null | undefined;
  readonly overlay?: React.ReactNode;
}) => (
  <div
    className={cn(
      "relative flex h-full shrink-0 flex-col overflow-hidden rounded-[2rem] border-[6px] border-neutral-900 bg-neutral-950 shadow-xl dark:border-neutral-700",
      className
    )}
    style={{ aspectRatio: "401 / 940" }}
  >
    <div className="relative min-h-0 flex-1 bg-white">
      {image ? (
        <img
          alt="Mirrored Android screen"
          className={cn(
            "absolute inset-0 size-full object-contain object-top",
            dimmed && "opacity-40 grayscale"
          )}
          src={`data:image/png;base64,${image}`}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-neutral-950 p-6 text-center text-sm text-neutral-400">
          {overlay === undefined
            ? "The screen appears here once the emulator is prepared."
            : null}
        </div>
      )}
      {overlay}
    </div>
    <div className="flex h-10 shrink-0 items-center justify-center bg-neutral-900 text-neutral-300">
      {below}
    </div>
  </div>
);

const OUTCOME = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
} as const;

/** A compact Run Summary every prototype places in its own way. */
export const PrototypeSummary = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => (
  <div className="space-y-4 p-4 text-sm">
    <section className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium">
        Agent Assessment
      </h3>
      <p className="font-medium">
        {session.assessment === null
          ? "Not submitted"
          : OUTCOME[session.assessment.outcome]}
      </p>
      <p className="text-muted-foreground">{session.assessment?.explanation}</p>
    </section>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Takeover</dt>
      <dd>{session.takeoverOccurred ? "Occurred" : "None"}</dd>
      <dt className="text-muted-foreground">Capture gaps</dt>
      <dd>{session.captureGaps.join(", ") || "None"}</dd>
      <dt className="text-muted-foreground">Cleanup</dt>
      <dd>
        {session.cleanup?._tag === "purged"
          ? "Recording deleted. Verified Flow Skill retained."
          : "Recording kept until the flow is verified."}
      </dd>
    </dl>
  </div>
);

/** A Run Environment Permission in the dock's request tier. */
export const Permission = ({
  onDecide,
  session,
}: {
  readonly onDecide: (decisionId: string, allow: boolean) => void;
  readonly session: AndroidWorkspaceSnapshot;
}) =>
  session.preparation.pending.length === 0 ? null : (
    <div className="bg-muted/50 space-y-1.5 border-b px-3 py-2.5">
      {session.preparation.pending.map((decision) => (
        <section aria-label="Run Environment Permission" key={decision.id}>
          <RequestHeader
            action={
              <>
                <Button
                  onClick={() => onDecide(decision.id, false)}
                  size="xs"
                  variant="outline"
                >
                  Refuse
                </Button>
                <Button onClick={() => onDecide(decision.id, true)} size="xs">
                  Allow
                </Button>
              </>
            }
            icon={
              <ShieldAlertIcon
                aria-hidden="true"
                className={requestIconClassName}
              />
            }
            title="Run Environment Permission"
          />
          <p className="text-muted-foreground text-xs">
            The agent wants to run on {decision.targetApp}{" "}
            {session.preparation.differences
              .map(
                (difference) =>
                  `${difference.field} ${difference.selected} (taught on ${difference.taught})`
              )
              .join(", ")}
            .
          </p>
        </section>
      ))}
    </div>
  );
