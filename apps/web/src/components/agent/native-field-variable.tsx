import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon, LockIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;

export interface FieldVariableEntry {
  readonly name: string;
  readonly status: string;
}

/**
 * A password field on the device takes a named Variable, never typed text,
 * on Android and iOS alike. The card sits beside the frame, never over it,
 * so the screen keeps every touch (ADR 0076).
 */
export const FieldVariableCard = ({
  disabled,
  field,
  onEnter,
  onRequest,
  onStop,
  variables,
}: {
  readonly disabled: boolean;
  /** The field's name, or its role when it has none. */
  readonly field: string;
  readonly onEnter: (name: string) => void;
  readonly onRequest: (name: string) => void;
  readonly onStop: () => void;
  readonly variables: readonly FieldVariableEntry[];
}) => {
  const [nameAtom] = useState(() => Atom.make("PASSWORD"));
  const [name, setName] = useAtom(nameAtom);
  const supplied = variables.filter(
    (variable) => variable.status === "supplied"
  );
  const waiting = variables.filter(
    (variable) => variable.status !== "supplied"
  );
  return (
    <form
      aria-label="Field Variable"
      className="island bg-island-solid pointer-events-auto flex w-72 flex-col overflow-hidden rounded-[18px]"
      onSubmit={(event) => {
        event.preventDefault();
        if (VARIABLE_NAME.test(name)) {
          onRequest(name);
        }
      }}
    >
      <header className="border-island-border flex min-h-11 shrink-0 items-center gap-2 border-b py-1.5 pr-1.5 pl-4">
        <LockIcon
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <h2 className="min-w-0 flex-1 text-sm font-medium">
          Enter a Variable into {field}
        </h2>
        <Button
          aria-label="Stop typing"
          onClick={onStop}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>
      <div className="space-y-3 p-4">
        <p className="text-muted-foreground text-xs text-pretty">
          A password field never takes typed text. The Flow keeps a Variable
          here, and each Run supplies its own value.
        </p>
        {supplied.length > 0 ? (
          <div className="grid gap-1.5">
            {supplied.map((variable) => (
              <Button
                className="justify-start"
                disabled={disabled}
                key={variable.name}
                onClick={() => onEnter(variable.name)}
                size="sm"
                type="button"
                variant="secondary"
              >
                <KeyRoundIcon />
                Enter {variable.name}
              </Button>
            ))}
          </div>
        ) : null}
        {waiting.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Waiting for {waiting.map((variable) => variable.name).join(", ")} to
            be supplied.
          </p>
        ) : null}
        <div className="grid gap-1.5">
          <Input
            variant="compact"
            aria-label="Variable name"
            className="h-8 font-mono"
            maxLength={128}
            onChange={(event) =>
              setName(event.currentTarget.value.toUpperCase())
            }
            placeholder="NAME"
            value={name}
          />
          <Button
            variant="primary"
            disabled={disabled || !VARIABLE_NAME.test(name)}
            size="sm"
            type="submit"
          >
            Request Variable
          </Button>
        </div>
      </div>
    </form>
  );
};
