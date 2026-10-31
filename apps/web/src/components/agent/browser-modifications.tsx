import { browserModificationSummary } from "@contingency/protocol";
import type { BrowserModification } from "@contingency/protocol";

import { Badge } from "@/components/ui/badge";

export const BrowserModificationBadge = ({
  modifications,
}: {
  readonly modifications: readonly BrowserModification[];
}) => {
  const summary = browserModificationSummary(modifications);
  return summary ? (
    <details className="relative">
      <summary className="cursor-pointer list-none">
        <Badge aria-label="Active Browser Modifications" variant="secondary">
          {summary}
        </Badge>
      </summary>
      <div className="bg-popover text-popover-foreground absolute bottom-full left-0 z-50 mb-2 max-h-80 w-80 overflow-auto rounded-md border p-3 shadow-md">
        <BrowserModifications modifications={modifications} />
      </div>
    </details>
  ) : null;
};

export const BrowserModifications = ({
  modifications,
}: {
  readonly modifications: readonly BrowserModification[];
}) =>
  modifications.length === 0 ? null : (
    <section aria-label="Browser Modifications" className="space-y-2">
      <h3 className="text-sm leading-5 font-semibold">Browser Modifications</h3>
      <ol
        aria-label="Browser Modification activity"
        className="space-y-1 text-sm"
      >
        {modifications.map((modification) => (
          <li className="wrap-anywhere" key={modification.id}>
            <time dateTime={modification.at}>{modification.at}</time>
            {" · "}
            {modification.description}
            {" · Agent · "}
            {modification.source === "saved" ? "Saved" : "Agent-initiated"}
            {modification.removedAt === undefined ? null : (
              <>
                {" "}
                · Removed{" "}
                <time dateTime={modification.removedAt}>
                  {modification.removedAt}
                </time>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
