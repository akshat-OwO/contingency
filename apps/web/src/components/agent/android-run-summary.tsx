import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";

import { androidDeviceLabel } from "./android-workspace-state";

const OUTCOME = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
} as const;

const KIND = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
} as const;

/** An ended Android session's Run Summary, in the browser summary's place. */
export const AndroidRunSummary = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => (
  <div className="space-y-5 p-4 text-sm">
    <section className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium">
        Agent Assessment
      </h3>
      <p className="font-medium">
        {session.assessment === null
          ? "Not submitted"
          : OUTCOME[session.assessment.outcome]}
      </p>
      {session.assessment === null ? null : (
        <p className="text-muted-foreground text-pretty">
          {session.assessment.explanation}
        </p>
      )}
    </section>
    {session.error === null ? null : (
      <section className="space-y-1">
        <h3 className="text-muted-foreground text-xs font-medium">Error</h3>
        <p className="text-pretty">{session.error}</p>
      </section>
    )}
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Session</dt>
      <dd>{KIND[session.kind]}</dd>
      <dt className="text-muted-foreground">Device</dt>
      <dd className="wrap-anywhere">
        {androidDeviceLabel(session.selection.device)} ·{" "}
        {session.selection.device.serial}
      </dd>
      <dt className="text-muted-foreground">Target App</dt>
      <dd className="wrap-anywhere">
        {session.selection.environment.appId} · build{" "}
        {session.selection.environment.appBuild}
      </dd>
      <dt className="text-muted-foreground">Takeover</dt>
      <dd>
        {session.takeoverOccurred ? "Occurred; a Dry Run cannot pass" : "None"}
      </dd>
      <dt className="text-muted-foreground">Capture gaps</dt>
      <dd>{session.captureGaps.join(", ") || "None"}</dd>
      <dt className="text-muted-foreground">Cleanup</dt>
      <dd className="text-pretty">
        {session.cleanup?._tag === "purged"
          ? "Recording deleted. Verified Flow Skill retained."
          : null}
        {session.cleanup?._tag === "purge-pending"
          ? `${session.cleanup.failure} Kept: ${session.cleanup.retainedFiles.join(", ")}.`
          : null}
        {session.cleanup === null || session.cleanup._tag === "pending"
          ? "Recording kept until the flow is verified."
          : null}
      </dd>
    </dl>
  </div>
);
