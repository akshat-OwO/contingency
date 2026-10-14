import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  CameraIcon,
  ChevronLeftIcon,
  CornerDownLeftIcon,
  HouseIcon,
  Maximize2Icon,
  RotateCwIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { BOUNDS } from "./fixtures";
import type { Bounds } from "./fixtures";
import { actionableNodes } from "./presentation";

type InputAction = Extract<
  AndroidWorkspaceCommand,
  { readonly _tag: "input" }
>["action"];

/** Where a capture-space rectangle sits on the scaled screen, in percent. */
const place = (bounds: Bounds, width: number, height: number) => ({
  height: `${(bounds.height / height) * 100}%`,
  left: `${(bounds.x / width) * 100}%`,
  top: `${(bounds.y / height) * 100}%`,
  width: `${(bounds.width / width) * 100}%`,
});

/**
 * The mirror is the control. Each element the session may act on is a real
 * button laid over its own pixels, so a tap on the screen sends the same
 * semantic action the element list used to. A field opens a text box where
 * it sits. Nothing is sent as a coordinate.
 */
const TapLayer = ({
  agentTarget,
  canAct,
  onInput,
  session,
}: {
  readonly agentTarget: string | undefined;
  readonly canAct: boolean;
  readonly onInput: (action: InputAction) => void;
  readonly session: AndroidWorkspaceSnapshot;
}) => {
  const [editingAtom] = useState(() => Atom.make<string | null>(null));
  const [editing, setEditing] = useAtom(editingAtom);
  const [draftAtom] = useState(() => Atom.make(""));
  const [draft, setDraft] = useAtom(draftAtom);
  const { observation } = session;
  if (observation === null) {
    return null;
  }
  const actionable = new Set(
    actionableNodes(session).map((node) => node.target)
  );
  return (
    <div className="absolute inset-0">
      {observation.nodes.map((node) => {
        const bounds = BOUNDS.get(node.target);
        if (bounds === undefined) {
          return null;
        }
        const style = place(bounds, observation.width, observation.height);
        if (node.target === agentTarget) {
          return (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute animate-pulse rounded-lg ring-4 ring-amber-400/80"
              key={node.target}
              style={style}
            />
          );
        }
        if (!canAct) {
          return null;
        }
        if (!actionable.has(node.target)) {
          return node.role === "button" ? (
            <span
              className="absolute cursor-not-allowed rounded-lg hover:outline-2 hover:outline-neutral-400 hover:outline-dashed"
              key={node.target}
              style={style}
              title="Not declared reversible for this session"
            />
          ) : null;
        }
        return (
          <div className="absolute" key={node.target} style={style}>
            <button
              aria-label={
                node.editable
                  ? `Enter public text in ${node.role} ${node.name}`
                  : `Activate ${node.role} ${node.name}`
              }
              className="size-full cursor-pointer rounded-lg transition hover:bg-sky-500/10 hover:outline-2 hover:outline-sky-500 focus-visible:outline-2 focus-visible:outline-sky-500"
              onClick={() => {
                if (node.editable) {
                  setEditing(node.target);
                  return;
                }
                onInput({ _tag: "activate", target: node.target });
              }}
              type="button"
            />
            {editing === node.target ? (
              <form
                className="bg-background absolute inset-x-0 top-full z-10 mt-1 flex gap-1 rounded-lg border p-1 shadow-lg"
                onSubmit={(event) => {
                  event.preventDefault();
                  onInput({ _tag: "fill", target: node.target, text: draft });
                  setEditing(null);
                  setDraft("");
                }}
              >
                <Input
                  aria-label={`Public text for ${node.role} ${node.name}`}
                  autoFocus
                  className="h-7 text-xs"
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Public text"
                  value={draft}
                />
                <Button aria-label="Enter" size="icon-sm" type="submit">
                  <CornerDownLeftIcon />
                </Button>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/**
 * A device frame like the one T3 Code draws: a thin metal rim, a punch-hole
 * camera, and the side keys. The capture fills the glass edge to edge,
 * status bar and gesture handle included.
 */
export const DeviceFrame = ({
  children,
  className,
  dimmed = false,
  image,
  placeholder = false,
}: {
  readonly children?: React.ReactNode;
  readonly className?: string;
  readonly dimmed?: boolean;
  readonly image: string | null | undefined;
  /** Says how to get a picture while there is none yet. */
  readonly placeholder?: boolean;
}) => (
  <div
    className={cn("relative h-full shrink-0", className)}
    style={{ aspectRatio: "401 / 900" }}
  >
    <span
      aria-hidden="true"
      className="absolute top-[22%] -right-[3px] h-[9%] w-[3px] rounded-r bg-neutral-500"
    />
    <span
      aria-hidden="true"
      className="absolute top-[35%] -right-[3px] h-[14%] w-[3px] rounded-r bg-neutral-500"
    />
    <div className="size-full rounded-[3rem] bg-gradient-to-b from-neutral-500 via-neutral-700 to-neutral-600 p-[3px] shadow-2xl">
      <div className="size-full rounded-[2.85rem] bg-neutral-950 p-[9px]">
        <div className="relative size-full overflow-hidden rounded-[2.35rem] bg-white">
          {image ? (
            <img
              alt="Mirrored Android screen"
              className={cn(
                "absolute inset-0 size-full object-cover object-top",
                dimmed && "opacity-40 grayscale"
              )}
              src={`data:image/png;base64,${image}`}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-neutral-950 p-8 text-center text-sm text-neutral-400">
              {placeholder
                ? "Prepare the emulator to mirror its screen here."
                : null}
            </div>
          )}
          <span
            aria-hidden="true"
            className="absolute top-[1.4%] left-1/2 aspect-square w-[6%] -translate-x-1/2 rounded-full bg-neutral-950"
          />
          {children}
        </div>
      </div>
    </div>
  </div>
);

const ToolbarButton = ({
  children,
  disabled = false,
  label,
  onClick,
}: {
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick?: () => void;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={(props) => (
        <Button
          {...props}
          aria-label={label}
          className="size-10 rounded-xl"
          disabled={disabled}
          onClick={onClick}
          size="icon"
          variant="ghost"
        >
          {children}
        </Button>
      )}
    />
    <TooltipContent side="left">{label}</TooltipContent>
  </Tooltip>
);

/**
 * The device's own keys, beside it. Back is the one navigation the
 * experimental runtime allows; Home, Recents, and rotation leave or reshape
 * the Target App, so they stay visible but unavailable.
 */
export const DeviceToolbar = ({
  canAct,
  onBack,
}: {
  readonly canAct: boolean;
  readonly onBack: () => void;
}) => (
  <nav
    aria-label="Device controls"
    className="bg-background/80 flex shrink-0 flex-col items-center gap-1 self-center rounded-2xl border p-1.5 shadow-sm backdrop-blur"
  >
    <ToolbarButton disabled label="Home leaves the Target App (unavailable)">
      <HouseIcon />
    </ToolbarButton>
    <ToolbarButton disabled={!canAct} label="Android Back" onClick={onBack}>
      <ChevronLeftIcon />
    </ToolbarButton>
    <ToolbarButton disabled label="Recents leaves the Target App (unavailable)">
      <SquareIcon />
    </ToolbarButton>
    <ToolbarButton disabled label="Rotate (unavailable)">
      <RotateCwIcon />
    </ToolbarButton>
    <span className="bg-border my-1 h-px w-6" />
    <ToolbarButton label="Save screenshot">
      <CameraIcon />
    </ToolbarButton>
    <ToolbarButton label="Fit to window">
      <Maximize2Icon />
    </ToolbarButton>
  </nav>
);

/** The live device: frame, tap layer, and the keys beside it. */
export const Device = ({
  agentTarget,
  canAct,
  className,
  dimmed = false,
  onInput,
  overlay,
  session,
}: {
  readonly agentTarget?: string | undefined;
  readonly canAct: boolean;
  readonly className?: string;
  readonly dimmed?: boolean;
  readonly onInput: (action: InputAction) => void;
  readonly overlay?: React.ReactNode;
  readonly session: AndroidWorkspaceSnapshot;
}) => (
  <div className={cn("flex h-full min-h-0 items-center gap-5", className)}>
    <DeviceFrame
      dimmed={dimmed}
      image={session.observation?.image}
      placeholder={overlay === undefined || overlay === null}
    >
      <TapLayer
        agentTarget={agentTarget}
        canAct={canAct}
        onInput={onInput}
        session={session}
      />
      {overlay}
    </DeviceFrame>
    <DeviceToolbar canAct={canAct} onBack={() => onInput({ _tag: "back" })} />
  </div>
);
