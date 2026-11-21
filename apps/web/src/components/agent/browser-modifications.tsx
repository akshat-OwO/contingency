import { browserModificationSummary } from "@contingency/protocol";
import type { BrowserModification } from "@contingency/protocol";

import {
  DetailRow,
  DetailRowText,
  DetailRows,
  DetailSection,
  DetailTime,
} from "./run-detail-parts";
import { clockTime } from "./run-detail-state";
import { dockFactClassName } from "./workspace-dock";

/**
 * A Browser Modification's sentence. Records written before an empty mock
 * body was described in words end on a dangling comma; it is dropped so the
 * row still reads as a finished sentence.
 */
const modificationSentence = (description: string): string =>
  description.replace(/,\s*$/u, "");

export const BrowserModifications = ({
  modifications,
}: {
  readonly modifications: readonly BrowserModification[];
}) =>
  modifications.length === 0 ? null : (
    <DetailSection
      label="Browser Modifications"
      meta={`${modifications.filter((m) => m.removedAt === undefined).length} active`}
    >
      <DetailRows label="Browser Modification activity" ordered>
        {modifications.map((modification) => (
          <DetailRow
            key={modification.id}
            lead={<DetailTime at={modification.at} />}
            muted={modification.removedAt !== undefined}
          >
            <p className="text-pretty">
              {modificationSentence(modification.description)}
            </p>
            <DetailRowText>
              {modification.source === "saved"
                ? "Saved with the Flow"
                : "Added by the agent"}
              {modification.removedAt === undefined ? null : (
                <>
                  {" · Removed "}
                  <time
                    dateTime={modification.removedAt}
                    title={modification.removedAt}
                  >
                    {clockTime(modification.removedAt)}
                  </time>
                </>
              )}
            </DetailRowText>
          </DetailRow>
        ))}
      </DetailRows>
    </DetailSection>
  );

export const BrowserModificationBadge = ({
  modifications,
}: {
  readonly modifications: readonly BrowserModification[];
}) => {
  const summary = browserModificationSummary(modifications);
  return summary ? (
    // A long summary truncates within the card; the list behind it has all of it.
    <details className="relative max-w-full min-w-0">
      <summary className="cursor-pointer list-none">
        <span
          aria-label="Active Browser Modifications"
          className={dockFactClassName}
          title={summary}
        >
          {summary}
        </span>
      </summary>
      <div className="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-80 w-80 overflow-auto rounded-md border p-3 shadow-md">
        <BrowserModifications modifications={modifications} />
      </div>
    </details>
  ) : null;
};
