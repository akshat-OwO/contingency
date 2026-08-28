import { AlertTriangleIcon, CheckIcon, CircleSlashIcon } from "lucide-react";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";

const vitalUnits: Record<string, string> = {
  cls: "",
  fcp: "ms",
  inp: "ms",
  lcp: "ms",
  ttfb: "ms",
};

export const StepDetail = ({
  step,
}: {
  readonly step: TimelineStep | undefined;
}) => {
  if (step === undefined) {
    return null;
  }
  const { result } = step;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-5 p-5">
        <div>
          <p className="text-muted-foreground font-mono text-xs">
            Step {step.index} · {step.type}
          </p>
          <h2 className="text-lg font-semibold">{step.label}</h2>
          {result?.error !== undefined && (
            <p className="mt-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {result.error}
            </p>
          )}
        </div>

        {step.state === "pending" && (
          <p className="text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
            Not reached yet.
          </p>
        )}

        {step.state === "running" && (
          <p className="flex items-center gap-2 text-sm text-sky-600">
            <Spinner className="size-3.5" /> Executing…
          </p>
        )}

        {result?.selector !== undefined && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Selector diagnostics</h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Strategy</th>
                    <th className="px-3 py-1.5 font-medium">Looked for</th>
                    <th className="px-3 py-1.5 font-medium">Miss</th>
                  </tr>
                </thead>
                <tbody>
                  {result.selector.candidates.map((candidate) => (
                    <tr className="border-t" key={candidate.strategy}>
                      <td className="px-3 py-1.5 font-mono">
                        {candidate.strategy}
                      </td>
                      <td className="px-3 py-1.5 font-mono">
                        {candidate.lookedFor}
                        {candidate.detail !== undefined && (
                          <span className="text-muted-foreground block">
                            {candidate.detail}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant="outline">{candidate.miss}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.selector.nearest !== undefined && (
              <div className="mt-3">
                <p className="text-muted-foreground mb-1 text-xs">
                  Nearest elements the page actually had
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {result.selector.nearest.map((element) => (
                    <li key={`${element.role}-${element.name}`}>
                      <Badge variant="secondary">
                        <span className="font-mono">{element.role}</span> ·{" "}
                        {element.name}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {result?.preSteps !== undefined && result.preSteps.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Pre-steps</h3>
            <ul className="space-y-1">
              {result.preSteps.map((preStep) => (
                <li
                  className="flex items-center gap-2 text-xs"
                  key={preStep.preStepId}
                >
                  {preStep.outcome === "completed" && (
                    <CheckIcon className="size-3.5 text-emerald-600" />
                  )}
                  {preStep.outcome === "skipped" && (
                    <CircleSlashIcon className="text-muted-foreground size-3.5" />
                  )}
                  {preStep.outcome === "failed" && (
                    <AlertTriangleIcon className="size-3.5 text-red-600" />
                  )}
                  <span className="font-mono">{preStep.preStepId}</span>
                  <Badge variant="outline">{preStep.scope}</Badge>
                  <span className="text-muted-foreground">
                    {preStep.error ?? preStep.outcome}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {result?.vitals !== undefined && (
          <section>
            <h3 className="mb-2 text-sm font-medium">Core Web Vitals</h3>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {Object.entries(result.vitals).map(([key, value]) => (
                <div className="rounded-md border p-2" key={key}>
                  <dt className="text-muted-foreground text-[10px] uppercase">
                    {key}
                  </dt>
                  <dd className="font-mono text-sm tabular-nums">
                    {value}
                    {vitalUnits[key] ?? ""}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground mt-1.5 text-[11px]">
              Unthrottled: these describe the host machine as much as the site.
            </p>
          </section>
        )}
      </div>
    </ScrollArea>
  );
};
