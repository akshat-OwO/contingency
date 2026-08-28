import type { RunVariablePrompt } from "@contingency/protocol";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface VariablePromptProps {
  readonly busy: boolean;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly prompt: RunVariablePrompt | null;
  /** Retries this Run may still make, so a single-use code can be warned about. */
  readonly retries: boolean;
  /**
   * The Step that asked, named. A `runtime` Variable is asked for by the Step
   * that references it, so saying which one places the question in the Run.
   */
  readonly step?: string | undefined;
}

/**
 * The Runner's prompt seam, answered in the browser. A web server is never an
 * interactive terminal, so without this a Flow declaring a `runtime` Variable
 * would fail before its first Step (ADR 0023). The Run is blocked while this
 * is open, so it cannot be dismissed.
 */
export const VariablePrompt = ({
  busy,
  draft,
  onDraftChange,
  onSubmit,
  prompt,
  retries,
  step,
}: VariablePromptProps) => (
  <Dialog open={prompt !== null}>
    <DialogContent showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Value for Variable {prompt?.name}</DialogTitle>
        <DialogDescription>
          {step === undefined
            ? "This Run is waiting on a runtime Variable."
            : `${step} is waiting on a runtime Variable.`}{" "}
          It is never written to the Run.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Label className="sr-only" htmlFor="audit-variable">
          {prompt?.name}
        </Label>
        <Input
          autoComplete="off"
          autoFocus
          id="audit-variable"
          onChange={(event) => onDraftChange(event.target.value)}
          type={prompt?.secret === true ? "password" : "text"}
          value={draft}
        />
        {prompt?.secret === true && retries && (
          <p className="text-muted-foreground mt-2 text-xs">
            A Variable that is both secret and runtime is usually a single-use
            code. A retry cannot reuse it, and will ask again.
          </p>
        )}
        <DialogFooter className="mt-4">
          <Button disabled={busy || draft.length === 0} type="submit">
            Continue the Run
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
);
