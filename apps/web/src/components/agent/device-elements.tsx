import type { AndroidWorkspaceObservation } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ListIcon,
  MousePointerClickIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

type ObservedNode = AndroidWorkspaceObservation["nodes"][number];

/** A pick at an element's centre, as the device mirror would send it. */
export interface ElementPick {
  readonly frame: { readonly height: number; readonly width: number };
  readonly point: { readonly x: number; readonly y: number };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Where a click on this element would land, or nothing without bounds. */
const elementPick = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
): ElementPick | undefined => {
  const { bounds } = node;
  if (
    bounds === undefined ||
    observation.width <= 0 ||
    observation.height <= 0
  ) {
    return undefined;
  }
  return {
    frame: { height: observation.height, width: observation.width },
    point: {
      x: clamp((bounds.x + bounds.width / 2) / observation.width),
      y: clamp((bounds.y + bounds.height / 2) / observation.height),
    },
  };
};

/**
 * The device's screen as a list of the elements on it, for anyone who does
 * not point at the mirror: each one sends the same pick a click at its centre
 * would, so a keyboard reaches everything a pointer does and nothing more.
 */
export const DeviceElements = ({
  disabled,
  observation,
  onPick,
}: {
  readonly disabled: boolean;
  readonly observation: AndroidWorkspaceObservation | null;
  readonly onPick: (pick: ElementPick) => void;
}) => {
  const [openAtom] = useState(() => Atom.make(false));
  const [open, setOpen] = useAtom(openAtom);
  const nodes =
    observation === null
      ? []
      : observation.nodes.filter(
          (node) =>
            !node.covered && elementPick(observation, node) !== undefined
        );
  // An element with no name still gets one a person can tell apart: its role
  // and where it falls among others of that role.
  const seen = new Map<string, number>();
  const labelled = nodes.map((node) => {
    const name = node.name.trim();
    if (name !== "") {
      return { label: name, node };
    }
    const count = (seen.get(node.role) ?? 0) + 1;
    seen.set(node.role, count);
    return { label: `Unnamed ${node.role} ${count}`, node };
  });
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          // Icon-only: the dock's controls row never wraps, and a label here
          // pushes the primary action out of a 48rem dock.
          <Button
            aria-label="Screen elements"
            disabled={disabled || nodes.length === 0}
            size="icon-sm"
            title="Screen elements"
            variant="ghost"
          />
        }
      >
        <ListIcon />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Screen elements"
        className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1"
        side="top"
      >
        <PopoverTitle className="text-muted-foreground px-1.5 py-1 text-xs">
          Screen elements
        </PopoverTitle>
        <ul className="max-h-72 overflow-y-auto">
          {labelled.map(({ label, node }) => {
            const Icon = node.editable
              ? TextCursorInputIcon
              : MousePointerClickIcon;
            return (
              <li key={node.target}>
                <Button
                  aria-label={`${node.editable ? "Select" : "Activate"} ${label}`}
                  className="w-full justify-start gap-2 px-1.5 font-normal"
                  onClick={() => {
                    if (observation === null) {
                      return;
                    }
                    const pick = elementPick(observation, node);
                    if (pick !== undefined) {
                      onPick(pick);
                      setOpen(false);
                    }
                  }}
                  variant="ghost"
                >
                  <Icon aria-hidden="true" className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {label}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {node.role}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
};
