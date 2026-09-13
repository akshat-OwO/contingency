// Throwaway prototype for issue #185. Not production code.

/**
 * One row per Teaching state. The renderer reads this table and branches on
 * nothing, so a missing next step or a missing primary action is visible here
 * instead of hidden in a component.
 */
export const FLOW_NAME = "Reorder pantry staples";

export const STATES = [
  {
    id: "no-session",
    stateName: "no session",
    sessionLabel: "No session",
    sessionHint: "contingency web",
    capture: { text: "Nothing captured", tone: "quiet" },
    status: {
      headline: "No browser session yet",
      next: "Open a session to set the browser up, then start recording when the journey begins.",
    },
    // The empty canvas owns the invitation, so the top bar offers no primary.
    primary: undefined,
    secondary: [{ label: "View saved flows" }],
    stage: { kind: "empty" },
  },
  {
    capture: { text: "Not recording", tone: "quiet" },
    id: "setup",
    primary: { label: "Start recording", tone: "default" },
    secondary: [{ label: "Rename flow" }],
    sessionHint: "Teaching, not recording",
    sessionLabel: FLOW_NAME,
    stage: { kind: "live", url: "shop.local/account/login" },
    stateName: "setup",
    status: {
      headline: "Setup is private",
      next: "Sign in, pick emulation, and edit storage. Nothing is captured until you start recording.",
    },
  },
  {
    agent: { text: "12 actions captured", tone: "quiet" },
    capture: { text: "Recording", tone: "recording" },
    id: "recording",
    primary: { label: "Stop", tone: "destructive" },
    secondary: [{ label: "Add instruction" }],
    sessionHint: "Recording",
    sessionLabel: FLOW_NAME,
    stage: { kind: "live", url: "shop.local/cart" },
    stateName: "recording",
    status: {
      headline: "Recording the journey",
      next: "Do the journey once. Press stop on the page that proves it worked.",
    },
    timer: "02:14",
  },
  {
    id: "finalizing",
    stateName: "finalizing",
    sessionLabel: FLOW_NAME,
    sessionHint: "Saving recording",
    capture: { text: "Saving", tone: "busy" },
    status: {
      headline: "Saving the recording",
      next: "Writing video, trace, and actions. This takes a few seconds.",
    },
    // Nothing to press while the recording is being written.
    primary: undefined,
    secondary: [],
    stage: { kind: "live", url: "shop.local/orders/48219" },
    progress: { label: "Saving recording", value: 62 },
  },
  {
    agent: { text: "No agent attached", tone: "quiet" },
    capture: { text: "Recording saved", tone: "ok" },
    id: "ready",
    primary: { label: "Learn flow", tone: "default" },
    secondary: [{ label: "Copy agent prompt" }, { label: "Delete recording" }],
    sessionHint: "Ready to learn",
    sessionLabel: FLOW_NAME,
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "ready",
    status: {
      headline: "Recording ready to learn",
      next: "Ask an agent to learn this recording, or start learning here.",
    },
  },
  {
    agent: { text: "claude reading the timeline", tone: "busy" },
    capture: { text: "Recording saved", tone: "ok" },
    id: "learning",
    primary: { label: "Cancel learning", tone: "outline" },
    progress: {
      label: "Step 3 of 7, reading accessibility targets",
      value: 43,
    },
    secondary: [],
    sessionHint: "Agent learning",
    sessionLabel: FLOW_NAME,
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "learning",
    status: {
      headline: "Agent is writing the flow skill",
      next: "Keep using the browser. The flow skill appears here when it is drafted.",
    },
  },
  {
    capture: { text: "Recording kept until verified", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "skill-drafted",
    primary: { label: "Dry run", tone: "default" },
    secondary: [{ label: "Read flow skill" }, { label: "Learn again" }],
    sessionHint: "Flow skill drafted",
    sessionLabel: FLOW_NAME,
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "skill-drafted",
    status: {
      headline: "Flow skill drafted",
      next: "Dry-run it with different inputs to see whether it reuses the journey.",
    },
  },
  {
    capture: { text: "Recording kept until verified", tone: "ok" },
    id: "dry-running",
    primary: { label: "Stop dry run", tone: "outline" },
    progress: { label: "Step 4 of 6, place order", value: 66 },
    secondary: [],
    sessionHint: "Dry run in progress",
    sessionLabel: FLOW_NAME,
    stage: { dryRun: true, kind: "live", url: "shop.local/cart" },
    stateName: "dry-running",
    status: {
      headline: "Dry run in progress",
      next: "The flow skill is running in a fresh browser with a changed quantity.",
    },
  },
  {
    capture: { text: "Recording kept until verified", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "dry-run-passed",
    primary: { label: "Verify flow", tone: "default" },
    secondary: [{ label: "Reject flow" }, { label: "Read flow skill" }],
    sessionHint: "Dry run passed",
    sessionLabel: FLOW_NAME,
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "dry-run-passed",
    status: {
      headline: "Dry run passed with a changed quantity",
      next: "Verify the flow to keep it and delete the recording. Reject to keep the recording and try again.",
    },
  },
  {
    capture: { text: "Recording deleted", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "verified",
    primary: { label: "Run flow", tone: "default" },
    secondary: [{ label: "Read flow skill" }, { label: "Record another flow" }],
    sessionHint: "Verified",
    sessionLabel: FLOW_NAME,
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "verified",
    status: {
      headline: "Flow verified and recording deleted",
      next: "The flow skill and its references are all that is left. Run it any time.",
    },
  },
  {
    capture: { text: "Video and trace still on disk", tone: "alert" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "cleanup-failed",
    primary: { label: "Retry cleanup", tone: "destructive" },
    secondary: [{ label: "Show retained files" }],
    sessionHint: "Cleanup failed",
    sessionLabel: FLOW_NAME,
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "failed (cleanup)",
    status: {
      headline: "The flow is verified. Deleting the recording failed",
      next: "recording.webm and trace.zip are still in .contingency/.recordings/r-48219. Retry the deletion.",
    },
  },
];

export const STATE_BY_ID = new Map(STATES.map((state) => [state.id, state]));

export const VARIANTS = [
  {
    id: "bar",
    name: "Status bar",
    note: "One top bar carries the primary action. A thin strip under it carries status and agent progress.",
  },
  {
    id: "dock",
    name: "Action dock",
    note: "The top bar stays as drawn. Status, progress, and the primary action ride a dock over the browser.",
  },
  {
    id: "rail",
    name: "Detail rail",
    note: "The top bar keeps the primary action. A collapsible right rail carries status, progress, and files.",
  },
];
