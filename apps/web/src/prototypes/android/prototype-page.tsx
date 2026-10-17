import { useAtomSet } from "@effect/atom-react";
import { useEffect } from "react";

import { workspaceChromeAtom } from "@/components/agent/agent-workspace-state";

import { AgentLedPrototype } from "./agent-led";
import { DirectPrototype } from "./direct";
import { DockSwitchPrototype } from "./dock-switch";
import { PROTOTYPE_STATES, PROTOTYPE_VARIANTS, STATE_LABEL } from "./fixtures";
import type { PrototypeState, PrototypeVariant } from "./fixtures";
import { PickerSheetPrototype } from "./picker-sheet";

const VARIANT_LABEL: Record<PrototypeVariant, string> = {
  "agent-led": "A · Agent-led, confirm in dock",
  direct: "D · Direct device (chosen)",
  "dock-switch": "B · Platform switch, step rail",
  "picker-sheet": "C · Unified picker, setup sheet",
};

const VARIANT = {
  "agent-led": AgentLedPrototype,
  direct: DirectPrototype,
  "dock-switch": DockSwitchPrototype,
  "picker-sheet": PickerSheetPrototype,
} satisfies Record<
  PrototypeVariant,
  (props: { readonly state: PrototypeState }) => React.ReactNode
>;

/**
 * The #479 prototype picker. Each variant runs on recorded fixture data, so no
 * emulator is needed, and none of them changes the shipped Workspace.
 */
export const AndroidPrototypePage = ({
  chrome,
  onChange,
  state,
  variant,
}: {
  readonly chrome: boolean;
  readonly onChange: (variant: PrototypeVariant, state: PrototypeState) => void;
  readonly state: PrototypeState;
  readonly variant: PrototypeVariant;
}) => {
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => {
      setChrome(false);
    };
  }, [setChrome]);
  const Prototype = VARIANT[variant];
  return (
    <>
      <Prototype key={`${variant}-${state}`} state={state} />
      {chrome ? (
        <nav
          aria-label="Prototype"
          className="material-float fixed top-3 left-3 z-50 flex gap-2 rounded-lg p-2 text-xs shadow-lg"
        >
          <select
            aria-label="Prototype variant"
            className="bg-transparent"
            onChange={(event) => {
              const next = PROTOTYPE_VARIANTS.find(
                (value) => value === event.target.value
              );
              if (next !== undefined) {
                onChange(next, state);
              }
            }}
            value={variant}
          >
            {PROTOTYPE_VARIANTS.map((value) => (
              <option key={value} value={value}>
                {VARIANT_LABEL[value]}
              </option>
            ))}
          </select>
          <select
            aria-label="Prototype state"
            className="bg-transparent"
            onChange={(event) => {
              const next = PROTOTYPE_STATES.find(
                (value) => value === event.target.value
              );
              if (next !== undefined) {
                onChange(variant, next);
              }
            }}
            value={state}
          >
            {PROTOTYPE_STATES.map((value) => (
              <option key={value} value={value}>
                {STATE_LABEL[value]}
              </option>
            ))}
          </select>
        </nav>
      ) : null}
    </>
  );
};
