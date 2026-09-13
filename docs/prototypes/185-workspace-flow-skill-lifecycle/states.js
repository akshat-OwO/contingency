// Throwaway prototype for issue #185. Not production code.

/**
 * One row per Teaching state. The renderer reads this table and branches on
 * nothing, so a missing next step or a missing primary action is visible here
 * instead of hidden in a component.
 */
export const FLOW_NAME = "Reorder pantry staples";

export const SESSIONS = [
  { id: "s-48219", name: FLOW_NAME },
  { id: "s-47903", name: "Refund a damaged order" },
  { id: "s-47660", name: "Export last month invoices" },
];

export const STATES = [
  {
    badge: { text: "No session", tone: "quiet" },
    id: "no-session",
    // The empty canvas owns the invitation, so the dock offers no primary.
    next: "Open a session to set the browser up, then start recording when the journey begins.",
    primary: undefined,
    secondary: [{ label: "View saved flows" }],
    stage: { kind: "empty" },
    stateName: "no session",
  },
  {
    badge: { text: "Not recording", tone: "quiet" },
    id: "setup",
    next: "Sign in, pick emulation, and edit storage. Nothing is captured until you start recording.",
    primary: { label: "Start recording", tone: "default" },
    secondary: [{ label: "Rename flow" }],
    stage: { kind: "live", url: "shop.local/account/login" },
    stateName: "setup",
  },
  {
    badge: { text: "Recording", tone: "recording" },
    counter: "12 actions",
    id: "recording",
    inspect: true,
    next: "Do the journey once. Press stop on the page that proves it worked.",
    primary: { label: "Stop", tone: "destructive" },
    secondary: [],
    stage: { kind: "live", url: "shop.local/cart" },
    stateName: "recording",
    timer: "02:14",
  },
  {
    badge: { text: "Saving", tone: "busy" },
    id: "finalizing",
    next: "Writing video, trace, and actions. This takes a few seconds.",
    // Nothing to press while the recording is being written.
    primary: undefined,
    progress: { label: "Saving recording", value: 62 },
    secondary: [],
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "finalizing",
  },
  {
    badge: { text: "Recording saved", tone: "ok" },
    id: "ready",
    next: "Ask an agent to learn this recording, or start learning here.",
    primary: { label: "Learn flow", tone: "default" },
    secondary: [{ label: "Copy agent prompt" }, { label: "Delete recording" }],
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "ready",
  },
  {
    badge: { text: "Learning", tone: "busy" },
    id: "learning",
    next: "Keep using the browser. The flow skill appears here when it is drafted.",
    primary: { label: "Cancel learning", tone: "outline" },
    progress: {
      label: "Step 3 of 7, reading accessibility targets",
      value: 43,
    },
    secondary: [],
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "learning",
  },
  {
    badge: { text: "Flow skill drafted", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "skill-drafted",
    inspect: true,
    next: "Dry-run it with different inputs to see whether it reuses the journey.",
    primary: { label: "Dry run", tone: "default" },
    secondary: [{ label: "Read flow skill" }, { label: "Learn again" }],
    stage: { kind: "live", url: "shop.local/orders/48219" },
    stateName: "skill-drafted",
  },
  {
    badge: { text: "Dry run", tone: "busy" },
    id: "dry-running",
    next: "The flow skill is running in a fresh browser with a changed quantity.",
    primary: { label: "Stop dry run", tone: "outline" },
    progress: { label: "Step 4 of 6, place order", value: 66 },
    secondary: [],
    stage: { dryRun: true, kind: "live", url: "shop.local/cart" },
    stateName: "dry-running",
  },
  {
    badge: { text: "Dry run failed", tone: "alert" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "dry-run-failed",
    inspect: true,
    next: "Step 4 could not find the place order button. Comment on the page, then learn again or dry-run once more.",
    primary: { label: "Dry run", tone: "default" },
    secondary: [{ label: "Read failure" }, { label: "Learn again" }],
    stage: { kind: "live", url: "shop.local/cart" },
    stateName: "dry-run-failed",
  },
  {
    badge: { text: "Dry run passed", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "dry-run-passed",
    inspect: true,
    next: "Verify the flow to keep it and delete the recording. Reject to keep the recording.",
    primary: { label: "Verify flow", tone: "default" },
    secondary: [{ label: "Reject flow" }, { label: "Read flow skill" }],
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "dry-run-passed",
  },
  {
    badge: { text: "Recording deleted", tone: "ok" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "verified",
    next: "The flow skill and its references are all that is left. Run it any time.",
    primary: { label: "Run flow", tone: "default" },
    secondary: [{ label: "Read flow skill" }, { label: "Record another flow" }],
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "verified",
  },
  {
    badge: { text: "Video and trace still on disk", tone: "alert" },
    files: [
      ".contingency/reorder-pantry-staples/SKILL.md",
      "references/targets.md",
    ],
    id: "cleanup-failed",
    next: "recording.webm and trace.zip are still in .contingency/.recordings/r-48219. Retry the deletion.",
    primary: { label: "Retry cleanup", tone: "destructive" },
    secondary: [{ label: "Show retained files" }],
    stage: {
      kind: "result",
      outcome: "Order 48307 confirmed, 3 cases of oat milk",
      url: "shop.local/orders/48307",
    },
    stateName: "failed (cleanup)",
  },
];

export const STATE_BY_ID = new Map(STATES.map((state) => [state.id, state]));
