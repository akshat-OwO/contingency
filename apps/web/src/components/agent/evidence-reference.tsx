import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
  // Success clears after a moment, so the next copy is announced again.
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied, setCopied]);
  const copy = async () => {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return { copied, copy, failed, text };
};

/** What a copy button announces, and its visible failure line. */
export const CopyFeedback = ({
  copied,
  failed,
  text,
}: {
  readonly copied: boolean;
  readonly failed: boolean;
  readonly text: string;
}) => (
  <>
    <span aria-live="polite" className="sr-only" role="status">
      {copied ? "Copied" : ""}
    </span>
    {failed ? (
      <span className="basis-full space-y-0.5 text-xs">
        <span className="text-destructive block" role="alert">
          Copy failed; select the id below instead.
        </span>
        <span className="bg-muted block rounded px-1.5 py-1 font-mono wrap-anywhere select-all">
          {text}
        </span>
      </span>
    ) : null}
  </>
);

/**
 * A long id keeps its start and its end, where two ids differ; the full id
 * stays in the button's name and title.
 */
const shortId = (id: string) =>
  id.length > 28 ? `${id.slice(0, 16)}…${id.slice(-8)}` : id;

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
  const { copied, copy, failed, text } = useCopy(id);
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <Button
        aria-label={`Copy ${kind} ${id}`}
        className="max-w-full font-normal"
        onClick={copy}
        size="xs"
        title={`${kind}: ${id}. Copy it for your agent to open the evidence.`}
        type="button"
        variant="outline"
      >
        {copied ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        <span className="text-muted-foreground">{kind}:</span>{" "}
        <span className="max-w-80 truncate font-mono">{shortId(id)}</span>
      </Button>
      <CopyFeedback copied={copied} failed={failed} text={text} />
    </span>
  );
};

/**
 * The evidence an assessment cites, with the one sentence that says how to
 * use it: evidence is opened by an agent from its id, not viewed here.
 */
export const EvidenceList = ({
  evidence,
}: {
  readonly evidence: readonly { readonly id: string; readonly kind: string }[];
}) => (
  <div className="space-y-1">
    <ul aria-label="Browser evidence" className="flex flex-wrap gap-1">
      {evidence.map((reference) => (
        <li className="max-w-full" key={`${reference.kind}:${reference.id}`}>
          <EvidenceReference id={reference.id} kind={reference.kind} />
        </li>
      ))}
    </ul>
    {evidence.length === 0 ? null : (
      <p className="text-muted-foreground text-xs">
        Copy an id for your agent to open that evidence.
      </p>
    )}
  </div>
);
