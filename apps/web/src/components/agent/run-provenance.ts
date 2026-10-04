import type {
  AgentSessionSnapshot,
  DemoSiteId,
  TaskAgentRunState,
  TaskAgentRunSummary,
} from "@contingency/protocol";

/** The bundled demo sites, by the id a Run or Flow Skill records. */
const DEMO_SITE_NAMES: Readonly<Record<DemoSiteId, string>> = {
  ridgeline: "Ridgeline Hardware",
};

export const hasDemoTeachingPassword = (
  session: AgentSessionSnapshot
): boolean =>
  session.activity === "teaching" &&
  session.captureState._tag === "recording" &&
  /^http:\/\/ridgeline\.localhost:\d+\/signin\.html(?:\?|$)/u.test(
    session.currentUrl
  );

/**
 * Where a Run's authority comes from, so the Workspace never shows demo work
 * as a real website's journey (ADR 0050). An Example Run runs a bundled,
 * read-only Example Flow Skill; demo work is any Run scoped to the demo store,
 * including the user's own learned variations.
 */
export interface RunProvenance {
  readonly demoSiteName: string | undefined;
  readonly example: boolean;
}

export const runProvenance = (
  run: TaskAgentRunState | TaskAgentRunSummary
): RunProvenance => ({
  demoSiteName:
    run.demoSite === undefined ? undefined : DEMO_SITE_NAMES[run.demoSite],
  example: run.referencedSkills.some((skill) => skill.origin === "example"),
});

/** The task Run a session holds, when it holds one. */
export const sessionTaskRun = (
  session: AgentSessionSnapshot
): TaskAgentRunState | undefined =>
  session.run !== null && "schemaVersion" in session.run
    ? session.run
    : undefined;

/** Whether a live Interactive Run takes private inputs in Workspace. */
export const takesExampleVariables = (session: AgentSessionSnapshot) =>
  session.dryRun === null &&
  (sessionTaskRun(session)?.referencedSkills.some(
    (skill) => skill.origin === "example"
  ) ??
    false);
