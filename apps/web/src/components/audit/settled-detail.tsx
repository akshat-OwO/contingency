import type { RunOutcome } from "@contingency/protocol";

import { ScrollArea } from "@/components/ui/scroll-area";

export interface SettledDetailProps {
  readonly diagnostic?: string;
  readonly finishedAt: string;
  readonly outcome: RunOutcome;
}

/**
 * What the terminal `Run settled` frame shows instead of Step detail. It is
 * the attempt's ending, not another Step, so it never carries a Step index.
 */
export const SettledDetail = ({
  diagnostic,
  finishedAt,
  outcome,
}: SettledDetailProps) => (
  <ScrollArea className="min-h-0 flex-1">
    <div className="space-y-5 p-5">
      <div>
        <p className="text-muted-foreground font-mono text-xs">Terminal</p>
        <h2 className="text-lg font-semibold">Run settled</h2>
      </div>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs">Attempt outcome</dt>
          <dd className="font-mono">{outcome}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Finished</dt>
          <dd className="font-mono">{finishedAt}</dd>
        </div>
      </dl>
      {diagnostic !== undefined && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          {diagnostic}
        </p>
      )}
    </div>
  </ScrollArea>
);
