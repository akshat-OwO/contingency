import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { splitFailureReference } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const FailureReferenceDetail = ({
  failureReference,
}: {
  readonly failureReference: string;
}) => {
  const { failureDetailAtom } = useRpcDependencies();
  const result = useAtomValue(failureDetailAtom(failureReference));
  const [open, setOpen] = useState(false);
  const detail = result._tag === "Success" ? result.value.detail : null;
  return (
    <div className="text-muted-foreground space-y-1 text-xs">
      <p>
        Failure Reference{" "}
        <code className="text-foreground font-mono select-all">
          {failureReference}
        </code>
      </p>
      {detail === null ? null : (
        <Collapsible onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger
            className="hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded outline-none focus-visible:ring-2"
            type="button"
          >
            {open ? (
              <ChevronDownIcon aria-hidden="true" className="size-3" />
            ) : (
              <ChevronRightIcon aria-hidden="true" className="size-3" />
            )}
            Cause
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};

/**
 * Names the recorded cause of a failure, so a user can report it. Under
 * `--debug` the server also returns the cause, shown collapsed beside the
 * reference (ADR 0089).
 */
export const FailureReferenceNote = ({
  failureReference,
}: {
  readonly failureReference: string | null | undefined;
}) =>
  failureReference === null || failureReference === undefined ? null : (
    <FailureReferenceDetail failureReference={failureReference} />
  );

/**
 * A paused native session's Failure Reference, for its status details. It
 * renders nothing otherwise, and the details panel hides when empty.
 */
export const PausedFailureReference = ({
  session,
}: {
  readonly session: {
    readonly failureReference?: string | null | undefined;
    readonly phase: string;
  };
}) => (
  <FailureReferenceNote
    failureReference={
      session.phase === "paused" ? session.failureReference : undefined
    }
  />
);

/**
 * A failure sentence as a notice shows it: the sentence, then its Failure
 * Reference with the cause under debug, when the sentence names one.
 */
export const FailureText = ({ text }: { readonly text: string }) => {
  const { failureReference, sentence } = splitFailureReference(text);
  return failureReference === undefined ? (
    text
  ) : (
    <>
      <span>{sentence}</span>
      <FailureReferenceNote failureReference={failureReference} />
    </>
  );
};
