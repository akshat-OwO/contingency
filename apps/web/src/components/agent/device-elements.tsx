import type {
  AndroidWorkspaceObservation,
  NativeInput,
} from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CrosshairIcon,
  MousePointerClickIcon,
  SearchIcon,
  TextCursorInputIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  elementBox,
  elementTap,
  groupElements,
  listedNodes,
  roleWord,
} from "./screen-elements";
import type { ObservedNode, ScreenBox } from "./screen-elements";

/**
 * The device's screen as a list of the elements on it, for anyone who does
 * not point at the mirror: each one sends the same tap a click at its centre
 * would, so a keyboard reaches everything a pointer does and nothing more.
 * Hovering or focusing one outlines it on the screen through `onHover`.
 */
export const ScreenElements = ({
  disabled,
  observation,
  onActivate,
  onAttach,
  onHover,
}: {
  readonly disabled: boolean;
  readonly observation: AndroidWorkspaceObservation | null;
  readonly onActivate: (inputs: readonly NativeInput[]) => void;
  /**
   * While a comment picks its element, choosing one attaches it instead of
   * tapping it, so a keyboard attaches whatever a pointer can.
   */
  readonly onAttach?: ((node: ObservedNode) => void) | undefined;
  readonly onHover: (box: ScreenBox | null) => void;
}) => {
  const [showOtherAtom] = useState(() => Atom.make(false));
  const [showOther, setShowOther] = useAtom(showOtherAtom);
  const [queryAtom] = useState(() => Atom.make(""));
  const [query, setQuery] = useAtom(queryAtom);
  const nodes = listedNodes(observation);
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
  const needle = query.trim().toLowerCase();
  const groups = groupElements(
    needle === ""
      ? labelled
      : labelled.filter(({ label, node }) =>
          `${label} ${roleWord(node.role)}`.toLowerCase().includes(needle)
        )
  );
  // Clocks, signal bars, and plain text follow the app's own fields and
  // controls; they stay one click away rather than filling the list. A
  // search shows every match.
  const collapsible = (id: string) =>
    id === "other" && groups.length > 1 && needle === "";
  const hover = (node: ObservedNode | null) =>
    onHover(
      node === null || observation === null
        ? null
        : (elementBox(observation, node) ?? null)
    );
  return (
    <div className="space-y-2">
      <label className="bg-island-hover focus-within:ring-ring flex h-8 items-center gap-2 rounded-xl px-2.5 focus-within:ring-2">
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <Input
          aria-label="Filter screen elements"
          className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter by name or role"
          value={query}
        />
      </label>
      {nodes.length === 0 ? (
        <p className="text-muted-foreground px-1.5 py-2 text-xs">
          Nothing on this screen reports an element yet.
        </p>
      ) : null}
      {nodes.length > 0 && groups.length === 0 ? (
        <p className="text-muted-foreground px-1.5 py-2 text-xs">
          Nothing on screen matches “{query.trim()}”.
        </p>
      ) : null}
      {groups.map((group) => (
        <section aria-labelledby={`device-elements-${group.id}`} key={group.id}>
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
                let Icon = node.editable
                  ? TextCursorInputIcon
                  : MousePointerClickIcon;
                if (onAttach !== undefined) {
                  Icon = CrosshairIcon;
                }
                let verb = node.editable ? "Select" : "Activate";
                if (onAttach !== undefined) {
                  verb = "Attach";
                }
                return (
                  <li key={node.target}>
                    <Button
                      aria-label={`${verb} ${label}`}
                      className="w-full justify-start gap-2 px-1.5 font-normal"
                      disabled={disabled}
                      onBlur={() => hover(null)}
                      onClick={() => {
                        if (observation === null) {
                          return;
                        }
                        if (onAttach !== undefined) {
                          hover(null);
                          onAttach(node);
                          return;
                        }
                        const tap = elementTap(observation, node);
                        if (tap !== undefined) {
                          hover(null);
                          onActivate(tap);
                        }
                      }}
                      onFocus={() => hover(node)}
                      onPointerEnter={() => hover(node)}
                      onPointerLeave={() => hover(null)}
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
  );
};
