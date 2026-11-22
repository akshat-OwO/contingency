import { CheckIcon, CopyIcon } from "lucide-react";

import {
  CopyButton,
  CopyButtonFallback,
  CopyButtonStatus,
  CopyButtonTrigger,
} from "@/components/ui/copy-button";

/**
 * `<kind>-<uuid>` or `<kind>-<32 hex>`, the shapes Contingency gives the ids
 * it mints, dashed or not.
 */
const MINTED_ID =
  /^(?<prefix>[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-)?(?<head>[0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/iu;

/**
 * An id as a reader tells it apart: a minted id keeps its kind and its first
 * eight hex digits, `agentrun-b6e400b2`; any other long id keeps its start
 * and its end, where two ids differ. The full id stays in the button's name
 * and its description, and it is what the button copies.
 */
const shortId = (id: string): string => {
  const minted = MINTED_ID.exec(id)?.groups;
  if (minted?.head !== undefined) {
    return `${minted.prefix ?? ""}${minted.head}`;
  }
  return id.length > 28 ? `${id.slice(0, 16)}…${id.slice(-8)}` : id;
};

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
}) => (
  <CopyButton
    className="inline-flex max-w-full flex-wrap items-center gap-1.5"
    value={id}
  >
    <CopyButtonTrigger
      aria-label={`Copy ${kind} ${id}`}
      className="max-w-full font-normal"
      size="xs"
      title={`${kind}: ${id}. Copy it for your agent to open the evidence.`}
      variant="outline"
    >
      {({ copied }) => (
        <>
          {copied ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <CopyIcon aria-hidden="true" />
          )}
          <span className="text-muted-foreground">{kind}:</span>{" "}
          <span className="max-w-80 min-w-0 truncate font-mono">
            {shortId(id)}
          </span>
        </>
      )}
    </CopyButtonTrigger>
    <CopyButtonStatus />
    <CopyButtonFallback message="Copy failed; select the id below instead." />
  </CopyButton>
);

/**
 * The evidence an assessment cites, with the one sentence that says how to
 * use it: evidence is opened by an agent from its id, not viewed here.
 */
export const EvidenceList = ({
  evidence,
  hint = false,
}: {
  readonly evidence: readonly { readonly id: string; readonly kind: string }[];
  /** Say how evidence is used; once per summary is enough. */
  readonly hint?: boolean;
}) => (
  <div className="space-y-1">
    <ul aria-label="Browser evidence" className="flex flex-wrap gap-1">
      {evidence.map((reference) => (
        <li className="max-w-full" key={`${reference.kind}:${reference.id}`}>
          <EvidenceReference id={reference.id} kind={reference.kind} />
        </li>
      ))}
    </ul>
    {!hint || evidence.length === 0 ? null : (
      <p className="text-muted-foreground text-xs">
        Copy an id for your agent to open that evidence.
      </p>
    )}
  </div>
);
