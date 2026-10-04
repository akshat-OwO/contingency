/**
 * Every dock prototype renders the same plain model, so a scenario reads the
 * same in each layout and only the layout changes between them. The strings
 * are the ones `runDockPresentation` and `teachingRecordingPresentation`
 * produce for these states, with the longest real inputs we have seen.
 */

export type DockTone = "default" | "failed" | "recording";

export interface DockStep {
  readonly doneWhen: string;
  readonly label: string;
  readonly name: string;
}

export interface DockTask {
  readonly instructions: readonly string[];
  readonly kind: "Dry Run" | "Interactive Run";
  readonly requestedTask: string;
  readonly title: string;
}

export interface DockPrimary {
  readonly icon?: "record" | "stop";
  readonly label: string;
  readonly variant: "default" | "destructive" | "outline";
}

export interface DockModel {
  readonly activity: "run" | "teaching";
  readonly badge: string;
  readonly comments?: number;
  readonly coverage?: string;
  /** How long a Teaching recording has run, as the timer would print it. */
  readonly elapsed?: string;
  readonly error?: string;
  readonly idle?: string;
  readonly primary?: DockPrimary;
  readonly provenance?: "Demo store" | "Example";
  readonly secondaries: readonly string[];
  readonly sentence: string;
  readonly sessionLabel: string;
  readonly sessions: readonly string[];
  readonly step?: DockStep;
  readonly task?: DockTask;
  readonly tone: DockTone;
}

const LONG_INSTRUCTION =
  "Open the storefront, add the Linen Overshirt in size M to the cart, apply the coupon SPRING25, check out as a guest with the shipping address from the setup variables, and confirm the order summary shows the discounted total before stopping at the payment step without submitting the order.";

const OTHER_SESSIONS = [
  "Guest checkout with coupon · Dry Run",
  "Newsletter sign-up",
  "Return an order from the account page · Interactive Run",
];

export const scenarios = {
  "dry-run": {
    activity: "run",
    badge: "Live",
    idle: "Agent idle for 12 min",
    primary: { label: "Take control", variant: "default" },
    provenance: "Demo store",
    secondaries: [],
    sentence: `Rehearsing the flow skill Guest checkout with coupon. Changed inputs: email, coupon, shippingAddress. ${LONG_INSTRUCTION} The agent has control.`,
    sessionLabel: "Guest checkout with coupon · Dry Run",
    sessions: OTHER_SESSIONS,
    task: {
      instructions: ["Load the demo store home page.", LONG_INSTRUCTION],
      kind: "Dry Run",
      requestedTask:
        "Rehearse guest checkout with a different email, coupon, and shipping address.",
      title: "Guest checkout with coupon",
    },
    tone: "default",
  },
  "interactive-run": {
    activity: "run",
    badge: "Waiting for your control",
    coverage: "3 of 6 Agent Steps executed",
    primary: { label: "Take control", variant: "default" },
    provenance: "Example",
    secondaries: [],
    sentence:
      "Running the flow skill Return an order from the account page. Agent Step 4 of 6. The agent is waiting for you. The agent asked for help: the store shows a one-time verification code sent to the account email, and the agent cannot read that inbox.",
    sessionLabel: "Return an order from the account page · Interactive Run",
    sessions: OTHER_SESSIONS,
    step: {
      doneWhen:
        "The returns page lists the order placed in the setup step, the Linen Overshirt is selected for return with the reason 'Too large', and the page shows a return label ready to download.",
      label: "Agent Step 4 of 6",
      name: "Select the item and reason for return",
    },
    tone: "default",
  },
  "run-failed": {
    activity: "run",
    badge: "Failed",
    coverage: "2 of 6 Agent Steps executed",
    error:
      "Control could not change: the browser session closed before the request reached it.",
    primary: { label: "Take control", variant: "default" },
    secondaries: [],
    sentence:
      "Running the flow skill Return an order from the account page. An Agent Step was not working, so the run ended early. The agent has control.",
    sessionLabel: "Return an order from the account page · Interactive Run",
    sessions: OTHER_SESSIONS,
    tone: "failed",
  },
  teaching: {
    activity: "teaching",
    badge: "Recording",
    comments: 3,
    elapsed: "04:37",
    primary: { icon: "stop", label: "Stop", variant: "destructive" },
    secondaries: [],
    sentence:
      "Demonstrate the journey in the browser. Comment on any element to tell the agent what matters, then stop when the journey is done.",
    sessionLabel: "Guest checkout with coupon",
    sessions: OTHER_SESSIONS,
    tone: "recording",
  },
  "teaching-dry-run-passed": {
    activity: "teaching",
    badge: "Dry run passed",
    comments: 3,
    primary: { label: "Verify flow", variant: "default" },
    secondaries: ["Reject flow"],
    sentence:
      "The flow skill rehearsed every changed input and every pass check held. Verify it to keep the flow skill and delete the temporary recording, or reject it to teach again.",
    sessionLabel: "Guest checkout with coupon",
    sessions: OTHER_SESSIONS,
    tone: "default",
  },
} as const satisfies Record<string, DockModel>;

export type ScenarioId = keyof typeof scenarios;

export const scenarioLabels: Record<ScenarioId, string> = {
  "dry-run": "Dry Run · long agent description",
  "interactive-run": "Interactive Run · agent asked for help",
  "run-failed": "Interactive Run · failed with control error",
  teaching: "Teaching · recording",
  "teaching-dry-run-passed": "Teaching · dry run passed",
};
