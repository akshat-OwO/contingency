import { useAtomValue } from "@effect/atom-react";
import { LoaderCircleIcon } from "lucide-react";

import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";

/**
 * A finished Run's video. It is condensed after the Run ends — Idle Gaps
 * fast-forwarded, the agent's cursor drawn in — so until it is ready the
 * Workspace says so instead of offering a player with nothing to play
 * ([ADR 0046](../../../../../docs/adr/0046-run-video-condenses-idle-gaps-and-composites-the-agent-cursor.md)).
 * A video that could not be condensed plays in real time, with the reason.
 */
export const RunVideo = ({
  className,
  src,
}: {
  readonly className?: string;
  readonly src: string;
}) => {
  const { runVideoStatusAtom } = useRpcDependencies();
  const result = useAtomValue(runVideoStatusAtom(src));
  const status = result._tag === "Success" ? result.value : undefined;
  if (result._tag === "Initial" || status?.state === "preparing") {
    return (
      <div
        aria-live="polite"
        className={cn(
          "text-muted-foreground flex aspect-video w-full items-center justify-center gap-2 rounded-lg border text-xs",
          className
        )}
        role="status"
      >
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3.5 animate-spin"
        />
        Preparing video…
      </div>
    );
  }
  if (status?.state === "unavailable") {
    return (
      <p className="text-muted-foreground text-xs">
        This Run&apos;s video is no longer available.
      </p>
    );
  }
  // A status that could not be read leaves the player to try the file.
  return (
    <>
      <video
        aria-label="Recorded Run video"
        className={cn("w-full rounded-lg border", className)}
        controls
        preload="metadata"
        src={src}
      >
        <track kind="captions" />
      </video>
      {status?.state === "ready" && !status.condensed ? (
        <p className="text-muted-foreground text-xs">
          Playing in real time. {status.reason}
        </p>
      ) : null}
    </>
  );
};
