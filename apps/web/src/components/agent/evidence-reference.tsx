import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies `text` and remembers how it went, so a copy button can say so: a
 * polite status on success, and a visible line when the clipboard refused.
 */
export const useCopy = (text: string) => {
  const [copiedAtom] = useState(() => Atom.make(false));
  const [copied, setCopied] = useAtom(copiedAtom);
  const [failedAtom] = useState(() => Atom.make(false));
  const [failed, setFailed] = useAtom(failedAtom);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };
  return { copied, copy, failed };
};

/** What a copy button announces, and its visible failure line. */
export const CopyFeedback = ({
  copied,
  failed,
}: {
  readonly copied: boolean;
  readonly failed: boolean;
}) => (
  <>
    <span aria-live="polite" className="sr-only" role="status">
      {copied ? "Copied" : ""}
    </span>
    {failed ? (
      <span className="text-destructive text-xs" role="alert">
        Copy failed; select the id instead.
      </span>
    ) : null}
  </>
);

/**
 * One evidence reference the agent cited. Evidence lives in the Run's own
 * record rather than in a viewer here, so the reference copies its full id
 * for an agent or a teammate to look up, and says so.
 */
export const EvidenceReference = ({
  id,
  kind,
}: {
  readonly id: string;
  readonly kind: string;
}) => {
  const { copied, copy, failed } = useCopy(id);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <Button
        aria-label={`Copy ${kind} ${id}`}
        className="max-w-full font-normal"
        onClick={copy}
        size="xs"
        title={`${kind}: ${id}`}
        type="button"
        variant="outline"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        <span className="text-muted-foreground">{kind}:</span>{" "}
        <span className="max-w-48 truncate font-mono">{id}</span>
      </Button>
      <CopyFeedback copied={copied} failed={failed} />
    </span>
  );
};
