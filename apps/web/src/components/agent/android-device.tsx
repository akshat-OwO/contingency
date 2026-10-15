import type { AgentSessionId } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronLeftIcon,
  CircleSlashIcon,
  ShieldAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { AndroidLiveStream } from "./android-live-stream";
import type {
  AndroidStreamFrame,
  AndroidStreamPoint,
} from "./android-stream-point";

/** Most phones are about 9 by 20; the frame takes the real ratio once decoded. */
const DEFAULT_FRAME: AndroidStreamFrame = { height: 2400, width: 1080 };

/**
 * A device frame like the one T3 Code draws: a thin metal rim and the side
 * keys. The glass is exactly the frame's aspect, so a click's position on it
 * is its position on the device and the live display is never letterboxed.
 */
const DeviceFrame = ({
  children,
  frame,
}: {
  readonly children: React.ReactNode;
  readonly frame: AndroidStreamFrame;
}) => (
  <div className="relative h-full w-fit shrink-0">
    <span
      aria-hidden="true"
      className="absolute top-[22%] -right-[3px] h-[9%] w-[3px] rounded-r bg-neutral-500"
    />
    <span
      aria-hidden="true"
      className="absolute top-[35%] -right-[3px] h-[14%] w-[3px] rounded-r bg-neutral-500"
    />
    <div className="h-full w-fit rounded-[2.75rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl">
      <div className="h-full w-fit rounded-[2.6rem] bg-neutral-950 p-[9px]">
        <div
          className="relative h-full overflow-hidden rounded-[2.1rem] bg-neutral-950"
          style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
        >
          {children}
        </div>
      </div>
    </div>
  </div>
);

/**
 * Back is the one key the experimental runtime sends. Home and Recents leave
 * the Target App, so the toolbar offers nothing it would refuse.
 */
const DeviceToolbar = ({
  canAct,
  onBack,
}: {
  readonly canAct: boolean;
  readonly onBack: () => void;
}) => (
  <nav
    aria-label="Device controls"
    className="bg-background/80 flex shrink-0 flex-col items-center gap-1 rounded-2xl border p-1.5 shadow-sm backdrop-blur"
  >
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <Button
            {...props}
            aria-label="Android Back"
            className="size-10 rounded-xl"
            disabled={!canAct}
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ChevronLeftIcon />
          </Button>
        )}
      />
      <TooltipContent side="right">Back</TooltipContent>
    </Tooltip>
  </nav>
);

/**
 * Why the last click sent nothing. It sits beside the device rather than on
 * it, so the stream only ever shows what the device shows.
 */
const Refusal = ({ message }: { readonly message: string | null }) => (
  <div aria-live="polite" className="w-56 shrink-0" role="status">
    {message === null ? null : (
      <p className="bg-background flex items-start gap-2 rounded-xl border px-3 py-2 text-xs shadow-sm">
        <CircleSlashIcon
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
        />
        <span>{message}</span>
      </p>
    )}
  </div>
);

/**
 * The live device: the frame with the stream filling its glass, its keys on
 * the left, and on the right why the last click was refused. A click goes to
 * `onPick` as a point on the frame; nothing here sends a coordinate to the
 * device.
 */
export const AndroidDevice = ({
  canAct,
  live,
  onBack,
  onPick,
  paused,
  pending,
  refusal,
  sessionId,
  secure,
  unavailable,
}: {
  readonly canAct: boolean;
  /** Whether the session holds a prepared device to stream. */
  readonly live: boolean;
  readonly onBack: () => void;
  readonly onPick: (
    point: AndroidStreamPoint,
    frame: AndroidStreamFrame
  ) => void;
  readonly paused: boolean;
  readonly pending: boolean;
  readonly refusal: string | null;
  readonly sessionId: AgentSessionId;
  readonly secure: boolean;
  /** What the glass says while there is no stream. */
  readonly unavailable: string;
}) => {
  const [frameAtom] = useState(() => Atom.make(DEFAULT_FRAME));
  const [frame, setFrame] = useAtom(frameAtom);
  const displayUnavailable = secure ? "" : unavailable;
  return (
    <div className="flex h-full min-h-0 items-center justify-center gap-5">
      <div className="flex w-56 shrink-0 justify-end">
        <DeviceToolbar canAct={canAct && !pending} onBack={onBack} />
      </div>
      <div
        aria-busy={pending}
        className={cn("h-full min-h-0", pending && "cursor-progress")}
      >
        <DeviceFrame frame={frame}>
          {live && !secure ? (
            <AndroidLiveStream
              dimmed={paused}
              onFrame={setFrame}
              onPick={canAct && !pending ? onPick : undefined}
              sessionId={sessionId}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center p-8 text-center text-sm text-neutral-400">
              {displayUnavailable}
            </div>
          )}
          {paused ? (
            <div className="absolute inset-0 grid place-items-center p-6 text-center">
              <div className="bg-background space-y-1 rounded-2xl border p-4 shadow-lg">
                {secure ? (
                  <ShieldAlertIcon className="mx-auto size-6 text-amber-600" />
                ) : (
                  <UnplugIcon className="mx-auto size-6 text-amber-600" />
                )}
                <p className="text-sm font-medium">
                  {secure
                    ? "Secure window, not visible"
                    : "Device disconnected"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {secure
                    ? "This window cannot provide outcome evidence. The outcome is inconclusive."
                    : "Recover the same device from the dock."}
                </p>
              </div>
            </div>
          ) : null}
        </DeviceFrame>
      </div>
      <Refusal message={refusal} />
    </div>
  );
};
