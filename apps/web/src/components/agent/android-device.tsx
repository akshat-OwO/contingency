import type { AgentSessionId } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronLeftIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
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
export const DeviceFrame = ({
  children,
  frame,
}: {
  readonly children: React.ReactNode;
  readonly frame: AndroidStreamFrame;
}) => (
  // The frame fits whichever of the stage's width or height runs out first,
  // so a phone-width stage never pushes it past the edge.
  <div
    className="grid size-full min-h-0 min-w-0 place-items-center"
    style={{ containerType: "size" }}
  >
    <div
      className="relative"
      style={{
        width: `min(100cqw, calc((100cqh - 24px) * ${frame.width} / ${frame.height} + 24px))`,
      }}
    >
      <span
        aria-hidden="true"
        className="absolute top-[22%] -right-[3px] h-[9%] w-[3px] rounded-r bg-neutral-500"
      />
      <span
        aria-hidden="true"
        className="absolute top-[35%] -right-[3px] h-[14%] w-[3px] rounded-r bg-neutral-500"
      />
      <div className="w-full rounded-[2.75rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl">
        <div className="w-full rounded-[2.6rem] bg-neutral-950 p-[9px]">
          <div
            className="relative w-full overflow-hidden rounded-[2.1rem] bg-neutral-950"
            style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  </div>
);

/**
 * Back is the one key the Android runtime sends. Home and Recents leave
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
    className="material-float flex shrink-0 flex-col items-center gap-1 rounded-2xl p-1.5 shadow-sm"
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
 * A session with no device to show: before preparation, or after it released
 * the device. A full-height black frame would say nothing more than this
 * line, so the stage gives the space back.
 */
export const DeviceUnavailable = ({
  message,
}: {
  readonly message: string;
}) => (
  <div className="grid h-full min-h-0 place-items-center">
    <div className="material-panel flex max-w-xs items-center gap-3 rounded-xl px-4 py-3 shadow-sm">
      <SmartphoneIcon
        aria-hidden="true"
        className="text-muted-foreground size-5 shrink-0"
      />
      <p className="text-muted-foreground text-sm text-pretty">{message}</p>
    </div>
  </div>
);

/**
 * The live device: the frame with the stream filling its glass and its keys
 * on the left. A click goes to
 * `onPick` as a point on the frame; nothing here sends a coordinate to the
 * device.
 */
export const AndroidDevice = ({
  canAct,
  ended = false,
  live,
  onBack,
  onPick,
  paused,
  pending,
  sessionId,
  secure,
  unavailable,
}: {
  readonly canAct: boolean;
  /** The session released its device for good; nothing will stream again. */
  readonly ended?: boolean;
  /** Whether the session holds a prepared device to stream. */
  readonly live: boolean;
  readonly onBack: () => void;
  readonly onPick: (
    point: AndroidStreamPoint,
    frame: AndroidStreamFrame
  ) => void;
  readonly paused: boolean;
  readonly pending: boolean;
  readonly sessionId: AgentSessionId;
  readonly secure: boolean;
  /** What the glass says while there is no stream. */
  readonly unavailable: string;
}) => {
  const [frameAtom] = useState(() => Atom.make(DEFAULT_FRAME));
  const [frame, setFrame] = useAtom(frameAtom);
  const displayUnavailable = secure ? "" : unavailable;
  if (ended) {
    return <DeviceUnavailable message={displayUnavailable} />;
  }
  return (
    <div className="relative flex h-full min-h-0 items-center justify-center gap-3 lg:gap-5">
      {/*
        The side columns balance the frame on a wide stage; a narrow one
        keeps only the keys beside it. Why a click sent nothing is said in the
        dock, so nothing ever covers the glass.
      */}
      <div className="flex shrink-0 justify-end lg:w-56">
        <DeviceToolbar canAct={canAct && !pending} onBack={onBack} />
      </div>
      <div
        aria-busy={pending}
        className={cn(
          "h-full min-h-0 min-w-0 flex-1 lg:flex-none lg:basis-[min(100%,28rem)]",
          pending && "cursor-progress"
        )}
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
      <div aria-hidden="true" className="hidden lg:block lg:w-56 lg:shrink-0" />
    </div>
  );
};
