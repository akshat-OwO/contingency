import type { AndroidWorkspaceSnapshot } from "@contingency/protocol";
import { CircleAlertIcon } from "lucide-react";

import { androidDeviceLabel } from "./android-workspace-state";
import { EvidenceReference } from "./evidence-reference";

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

/** A capture gap code, said as words: `secure_window` reads "Secure window". */
const gapLabel = (code: string) => {
  const words = code.replaceAll(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type SummarySession = Pick<
  AndroidWorkspaceSnapshot,
  | "assessment"
  | "captureGaps"
  | "cleanup"
  | "error"
  | "kind"
  | "takeoverOccurred"
>;

/**
 * An ended device session's Run Summary, in the browser summary's place.
 * What went wrong leads when the agent never assessed the Run; the device and
 * Target App identity sit under it as reference.
 */
export const DeviceRunSummary = ({
  device,
  session,
  targetApp,
}: {
  readonly device: string;
  readonly session: SummarySession;
  readonly targetApp: string;
}) => (
  <div className="space-y-5 text-sm">
    {session.error === null ? null : (
      <section
        aria-label="Error"
        className="border-destructive/30 bg-destructive/5 flex gap-2.5 rounded-lg border p-3"
      >
        <CircleAlertIcon
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <div className="space-y-1">
          <h3 className="font-medium">The session ended with an error</h3>
          <p className="text-muted-foreground text-pretty">{session.error}</p>
        </div>
      </section>
    )}
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
        <>
          <p className="text-muted-foreground text-pretty">
            {session.assessment.explanation}
          </p>
          <EvidenceReference
            id={session.assessment.observationId}
            kind="observation"
          />
        </>
      )}
    </section>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t pt-4 text-xs">
      <dt className="text-muted-foreground">Session</dt>
      <dd>{KIND[session.kind]}</dd>
      <dt className="text-muted-foreground">Device</dt>
      <dd className="wrap-anywhere">{device}</dd>
      <dt className="text-muted-foreground">Target App</dt>
      <dd className="wrap-anywhere">{targetApp}</dd>
      <dt className="text-muted-foreground">Takeover</dt>
      <dd>
        {session.takeoverOccurred ? "Occurred; a Dry Run cannot pass" : "None"}
      </dd>
      <dt className="text-muted-foreground">Capture gaps</dt>
      <dd>{session.captureGaps.map(gapLabel).join(", ") || "None"}</dd>
      <dt className="text-muted-foreground">Cleanup</dt>
      <dd className="text-pretty">
        {session.cleanup?._tag === "purged"
          ? "Recording deleted. Verified Flow retained."
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

/** An ended Android session's Run Summary. */
export const AndroidRunSummary = ({
  session,
}: {
  readonly session: AndroidWorkspaceSnapshot;
}) => (
  <DeviceRunSummary
    device={`${androidDeviceLabel(session.selection.device)} · ${session.selection.device.serial}`}
    session={session}
    targetApp={`${session.selection.environment.appId} · build ${session.selection.environment.appBuild}`}
  />
);
