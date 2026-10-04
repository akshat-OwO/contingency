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

/** A paused Execution Boundary, shaped like `AgentExecutionBoundary`. */
export interface DockBoundary {
  readonly action: Readonly<Record<string, string>>;
  readonly description: string;
  readonly operationId: string;
  readonly pendingDecisionId?: string;
  readonly reason: "confirmation" | "domain" | "objective";
  readonly requested: string;
}

/**
 * One private input the agent asked for. `form` inputs are supplied here;
 * `relay` inputs are answered in the agent conversation and only mirrored.
 */
export interface DockVariable {
  readonly flowSkillName?: string;
  readonly name: string;
  readonly pendingDecisionId?: string;
  readonly purpose?: string;
  readonly status: "refused" | "requested" | "supplied";
}

export interface DockInputs {
  readonly mode: "form" | "relay";
  readonly title: string;
  readonly variables: readonly DockVariable[];
}

export interface DockModel {
  readonly activity: "run" | "teaching";
  readonly badge: string;
  readonly boundary?: DockBoundary;
  readonly inputs?: DockInputs;
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
  boundary: {
    activity: "run",
    badge: "Waiting for confirmation",
    boundary: {
      action: { ref: "e55", type: "click" },
      description: "Submit the demo return for RH-1042 with reason Wrong item",
      operationId: "example-return-submit",
      pendingDecisionId: "pending-2ca483b9-83b0-442f-8461-46aaf28c12e2",
      reason: "confirmation",
      requested: "Submit the demo return for RH-1042 with reason Wrong item",
    },
    coverage: "5 of 6 Agent Steps executed",
    primary: { label: "Take control", variant: "default" },
    provenance: "Example",
    secondaries: [],
    sentence:
      "Running the flow skill Return an order from the account page. Agent Step 6 of 6. The agent is waiting for confirmation before it submits the return.",
    sessionLabel: "Return an order from the account page · Interactive Run",
    sessions: OTHER_SESSIONS,
    step: {
      doneWhen:
        "The return for RH-1042 is submitted and the page shows a return number.",
      label: "Agent Step 6 of 6",
      name: "Submit the return",
    },
    tone: "default",
  },
  "boundary-domain": {
    activity: "run",
    badge: "Waiting for confirmation",
    boundary: {
      action: {
        type: "navigate",
        url: "https://payments.stripe-demo.test/checkout/c_31f",
      },
      description:
        "The checkout hands off to a payment page on a host outside the saved Domain Scope.",
      operationId: "navigate-payment-handoff",
      pendingDecisionId: "pending-9be1c0d4-5a7e-4b19-9c2f-0e1d3f6a8b72",
      reason: "domain",
      requested: "Open payments.stripe-demo.test",
    },
    primary: { label: "Take control", variant: "default" },
    provenance: "Demo store",
    secondaries: [],
    sentence:
      "Rehearsing the flow skill Guest checkout with coupon. Changed inputs: email, coupon. The agent is waiting for confirmation.",
    sessionLabel: "Guest checkout with coupon · Dry Run",
    sessions: OTHER_SESSIONS,
    tone: "default",
  },
  "dry-run-inputs": {
    activity: "run",
    badge: "Waiting for inputs",
    inputs: {
      mode: "form",
      title: "Inputs needed",
      variables: [
        {
          flowSkillName: "guest-checkout",
          name: "email",
          purpose: "The guest email the order confirmation is sent to.",
          status: "supplied",
        },
        {
          flowSkillName: "guest-checkout",
          name: "couponCode",
          pendingDecisionId: "pending-41aa",
          purpose: "A coupon the demo store accepts at checkout.",
          status: "requested",
        },
        {
          flowSkillName: "guest-checkout",
          name: "cardNumber",
          pendingDecisionId: "pending-41ab",
          purpose: "A test card number for the payment step.",
          status: "requested",
        },
      ],
    },
    primary: { label: "Take control", variant: "default" },
    provenance: "Demo store",
    secondaries: [],
    sentence:
      "Rehearsing the flow skill Guest checkout with coupon. Changed inputs: email, coupon. The agent is waiting for two private inputs before it continues.",
    sessionLabel: "Guest checkout with coupon · Dry Run",
    sessions: OTHER_SESSIONS,
    tone: "default",
  },
  "relay-inputs": {
    activity: "run",
    badge: "Waiting for inputs",
    inputs: {
      mode: "relay",
      title: "Inputs needed",
      variables: [
        {
          flowSkillName: "account-returns",
          name: "accountPassword",
          pendingDecisionId: "pending-7f3e0b21-1c4d-4e8a-9b6f-2d5a7c9e0f13",
          purpose: "Only for the account at returns.demo.test, this Run.",
          status: "requested",
        },
      ],
    },
    primary: { label: "Take control", variant: "default" },
    secondaries: [],
    sentence:
      "Running the flow skill Return an order from the account page. Agent Step 1 of 6. The agent has control.",
    sessionLabel: "Return an order from the account page · Interactive Run",
    sessions: OTHER_SESSIONS,
    tone: "default",
  },
  "setup-inputs": {
    activity: "teaching",
    badge: "Agent preparing",
    inputs: {
      mode: "form",
      title: "Setup Variables",
      variables: [
        {
          name: "storePassword",
          purpose: "Signs in to the demo store before the journey starts.",
          status: "requested",
        },
      ],
    },
    secondaries: ["Rename flow"],
    sentence:
      "The agent is preparing the browser. Start recording becomes available when it hands the browser to you.",
    sessionLabel: "Guest checkout with coupon",
    sessions: OTHER_SESSIONS,
    tone: "default",
  },
} as const satisfies Record<string, DockModel>;

export type ScenarioId = keyof typeof scenarios;

export const scenarioLabels: Record<ScenarioId, string> = {
  boundary: "Execution Boundary · confirmation",
  "boundary-domain": "Execution Boundary · new domain",
  "dry-run-inputs": "Dry Run · inputs to supply",
  "relay-inputs": "Interactive Run · inputs in conversation",
  "setup-inputs": "Teaching setup · setup variable",
  "dry-run": "Dry Run · long agent description",
  "interactive-run": "Interactive Run · agent asked for help",
  "run-failed": "Interactive Run · failed with control error",
  teaching: "Teaching · recording",
  "teaching-dry-run-passed": "Teaching · dry run passed",
};
