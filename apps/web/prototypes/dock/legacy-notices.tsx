import { DockNotices } from "@/components/agent/workspace-dock";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { DockModel } from "./fixtures";

/**
 * What ships today for a paused Execution Boundary and for input requests:
 * cards floating at the top of the stage through the real `DockNotices`. The
 * markup copies `ExecutionBoundary`, `RuntimeVariables`, `SetupVariables`,
 * and `DryRunPrerequisiteVariables`, which take a live session snapshot.
 */
export const LegacyNotices = ({ model }: { readonly model: DockModel }) => {
  const { boundary, inputs } = model;
  if (boundary === undefined && inputs === undefined) {
    return null;
  }
  return (
    <DockNotices>
      {boundary === undefined ? null : (
        <section
          aria-label="Execution Boundary"
          className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
        >
          <h2 className="font-semibold">Waiting for confirmation</h2>
          <p>Reason: {boundary.reason}</p>
          <p className="break-words">Requested: {boundary.requested}</p>
          <p>{boundary.description}</p>
          <p className="break-words">Action attempt: {boundary.operationId}</p>
          <pre className="overflow-auto text-xs">
            {JSON.stringify(boundary.action, null, 2)}
          </pre>
          <p>
            {boundary.reason === "domain"
              ? "Allowing this exact host covers this Run. The saved Domain Scope stays unchanged."
              : "Allowing permits this exact action attempt once. A retry with a new operation id needs another decision."}
          </p>
          <p>
            Reply "allow" or "refuse" in your agent conversation. The agent will
            relay your choice to Contingency.
            {boundary.pendingDecisionId === undefined ? null : (
              <code className="ml-1 wrap-anywhere">
                {boundary.pendingDecisionId}
              </code>
            )}
          </p>
          <p>
            Take control remains available. Return control before allowing an
            agent attempt.
          </p>
        </section>
      )}
      {inputs === undefined ? null : (
        <section
          aria-label={inputs.title}
          className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
        >
          <h2 className="font-semibold">{inputs.title}</h2>
          {inputs.variables.map((variable) => {
            const label =
              variable.flowSkillName === undefined
                ? variable.name
                : `${variable.flowSkillName}/${variable.name}`;
            if (variable.status !== "requested") {
              return (
                <p key={label}>
                  {label} {variable.status}
                </p>
              );
            }
            if (inputs.mode === "relay") {
              return (
                <div className="space-y-1" key={label}>
                  <p>{label}</p>
                  <p>{variable.purpose}</p>
                  <code className="text-xs wrap-anywhere">
                    {variable.pendingDecisionId}
                  </code>
                </div>
              );
            }
            return (
              <div className="space-y-2" key={label}>
                <label className="grid gap-1" htmlFor={`legacy-${label}`}>
                  <span>{label}</span>
                  <Input id={`legacy-${label}`} type="password" />
                </label>
                <p className="text-muted-foreground">{variable.purpose}</p>
                <div className="flex gap-2">
                  <Button disabled type="submit">
                    Supply {label}
                  </Button>
                  <Button type="button" variant="outline">
                    Refuse {label}
                  </Button>
                </div>
              </div>
            );
          })}
          {inputs.mode === "relay" ? (
            <p>Supply or refuse these inputs in your agent conversation.</p>
          ) : null}
        </section>
      )}
    </DockNotices>
  );
};
