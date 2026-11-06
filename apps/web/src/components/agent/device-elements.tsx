import type { AndroidWorkspaceObservation } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ListIcon,
  MousePointerClickIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ObservedNode = AndroidWorkspaceObservation["nodes"][number];

/** A pick at an element's centre, as the device mirror would send it. */
export interface ElementPick {
  readonly frame: { readonly height: number; readonly width: number };
  readonly point: { readonly x: number; readonly y: number };
}

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "slider",
  "switch",
  "tab",
]);

const ELEMENT_GROUPS = [
  { id: "fields", title: "Fields" },
  { id: "controls", title: "Controls" },
  { id: "other", title: "Other elements" },
] as const;

/** Which part of the list an element belongs in. */
const elementGroup = (
  node: ObservedNode
): (typeof ELEMENT_GROUPS)[number]["id"] => {
  if (node.editable) {
    return "fields";
  }
  return CONTROL_ROLES.has(node.role.toLowerCase()) ? "controls" : "other";
};

/**
 * Fields and controls lead; text, images, and the system bar follow, so the
 * app's own inputs are at the top. Text or a container that repeats a label
 * already listed, such as a button's own text, is left out.
 */
const groupElements = (
  labelled: readonly { readonly label: string; readonly node: ObservedNode }[]
) => {
  const listed = new Set<string>();
  return ELEMENT_GROUPS.map((group) => {
    const entries = labelled.filter((entry) => {
      if (
        elementGroup(entry.node) !== group.id ||
        (group.id === "other" && listed.has(entry.label))
      ) {
        return false;
      }
      listed.add(entry.label);
      return true;
    });
    return { ...group, entries };
  }).filter((group) => group.entries.length > 0);
};

const ROLE_WORDS = new Map([
  ["application", "app"],
  ["other", "element"],
  ["secure-text-field", "secure field"],
  ["text-field", "field"],
]);

/** A role as a short word a person reads, not the platform's identifier. */
const roleWord = (role: string) =>
  ROLE_WORDS.get(role.toLowerCase()) ?? role.toLowerCase().replaceAll("-", " ");

/**
 * The system status bar (clock, signal, battery) sits in a screen's top few
 * percent on both platforms; it is not the app, so the list leaves out its
 * text and images. A field or control there is kept: it may be the app's.
 */
const STATUS_BAR_FRACTION = 0.07;
const inStatusBar = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
) =>
  node.bounds !== undefined &&
  elementGroup(node) === "other" &&
  node.bounds.y + node.bounds.height <=
    observation.height * STATUS_BAR_FRACTION;

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
  const trigger = useRef<HTMLButtonElement>(null);
  const [showOtherAtom] = useState(() => Atom.make(false));
  const [showOther, setShowOther] = useAtom(showOtherAtom);
  const nodes =
    observation === null
      ? []
      : observation.nodes.filter(
          (node) =>
            !node.covered &&
            !inStatusBar(observation, node) &&
            elementPick(observation, node) !== undefined
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
    return { label: `Unnamed ${roleWord(node.role)} ${count}`, node };
  });
  const groups = groupElements(labelled);
  // Clocks, signal bars, and plain text follow the app's own fields and
  // controls; they stay one click away rather than filling the list.
  const collapsible = (id: string) => id === "other" && groups.length > 1;
  const dockOf = () =>
    trigger.current?.closest('[aria-label="Workspace dock"]') ??
    trigger.current;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                // Icon-only on a 48rem dock, where a label pushes the primary
                // action out; the wider dock on a wide stage spells it, like
                // Comment. The tooltip names it on hover and keyboard focus.
                <Button
                  aria-label="Screen elements"
                  className="@6xl:w-auto @6xl:px-2"
                  ref={trigger}
                  disabled={disabled || nodes.length === 0}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <ListIcon />
          <span className="hidden @6xl:inline">Elements</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          Screen elements: pick an element by name
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="center"
        // Above the whole dock, never over its requests or status: a list
        // over a Variable form hides what the person is answering.
        anchor={dockOf}
        aria-label="Screen elements"
        className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1"
        side="top"
        sideOffset={8}
      >
        <PopoverTitle className="text-muted-foreground px-1.5 py-1 text-xs">
          Screen elements
        </PopoverTitle>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {groups.map((group) => (
            <section
              aria-labelledby={`device-elements-${group.id}`}
              key={group.id}
            >
              <h3
                className="text-muted-foreground px-1.5 pt-1 text-xs font-medium"
                id={`device-elements-${group.id}`}
              >
                {collapsible(group.id) ? (
                  <button
                    aria-expanded={showOther}
                    className="hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded outline-none focus-visible:ring-2"
                    onClick={() => setShowOther((current) => !current)}
                    type="button"
                  >
                    {showOther ? (
                      <ChevronDownIcon aria-hidden="true" className="size-3" />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" className="size-3" />
                    )}
                    {group.title}
                  </button>
                ) : (
                  group.title
                )}
              </h3>
              {collapsible(group.id) && !showOther ? null : (
                <ul>
                  {group.entries.map(({ label, node }) => {
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
                          <Icon
                            aria-hidden="true"
                            className="text-muted-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {label}
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {roleWord(node.role)}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
