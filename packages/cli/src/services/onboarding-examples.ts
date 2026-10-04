import path from "node:path";

import { FlowSkillName } from "@contingency/protocol";
import { Effect } from "effect";

import { DEMO_HOST, DEMO_SITE_NAME } from "./demo-site.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";

/**
 * The bundled Example Flow Skills that onboarding runs on Ridgeline Hardware
 * (ADR 0050).
 *
 * They are read-only packages shipped with the CLI, outside every Catalog
 * Root. They are resolved only by name through this registry, they carry no
 * verification record, and their taught host is the demo store alone. The
 * user's own variation is an ordinary drafted Flow Skill in their catalog.
 */

export interface OnboardingExample {
  /** Whether a learned variation can be rerun against the cart fault. */
  readonly appliesToCartFault: boolean;
  readonly flowSkillName: FlowSkillName;
  readonly recommended: boolean;
  /** What the user can check when the journey works. */
  readonly result: string;
  /** Ordinary inputs the prepared Example Run uses. */
  readonly sampleInputs: Readonly<Record<string, string>>;
  /** Path on the demo origin where the Example Run starts. */
  readonly startPath: string;
  readonly title: string;
  /** A variation the user may teach. */
  readonly variation: string;
  /** What the user watches during the prepared Example Run. */
  readonly watch: string;
}

/** The URL switch that breaks Add to cart in one browser context. */
export const CART_FAULT_PATH = "/?fault=add-to-cart";

export const ONBOARDING_EXAMPLES: readonly OnboardingExample[] = [
  {
    appliesToCartFault: true,
    flowSkillName: FlowSkillName.make("example-delivery-cart"),
    recommended: true,
    result: "The cart names the chosen product and delivery location.",
    sampleInputs: {
      area: "Pearl Street",
      city: "Boulder",
      product: "Trail Hammer",
    },
    startPath: "/",
    title: "Add a product for delivery",
    variation: "Another product, city, or area.",
    watch:
      "The agent chooses a product and delivery area, then opens the cart.",
  },
  {
    appliesToCartFault: false,
    flowSkillName: FlowSkillName.make("example-signed-in-return"),
    recommended: false,
    result:
      "The return confirmation identifies the selected order. The Flow Skill declares its private input.",
    sampleInputs: { order: "RH-1042", reason: "Wrong item" },
    startPath: "/signin.html",
    title: "Complete a signed-in task",
    variation: "Another demo order or return reason.",
    watch:
      "The agent requests a synthetic password through Workspace, signs in, and starts a return.",
  },
  {
    appliesToCartFault: true,
    flowSkillName: FlowSkillName.make("example-cart-scan"),
    recommended: false,
    result:
      "The Run includes a completed Scan Report. The documented low-contrast note can remain while the journey passes.",
    sampleInputs: { product: "Garden Trowel" },
    startPath: "/",
    title: "Check a journey with a scan",
    variation:
      "A different cart journey with a scan required at the chosen outcome. A performance scan is an optional variant.",
    watch:
      "The agent runs the cart journey and performs the required accessibility scan.",
  },
  {
    appliesToCartFault: true,
    flowSkillName: FlowSkillName.make("example-broken-cart"),
    recommended: false,
    result:
      "The failure report cites the empty cart. The learned variation passes on the healthy store.",
    sampleInputs: { product: "Cedar Pull Saw" },
    startPath: CART_FAULT_PATH,
    title: "Identify a broken journey",
    variation: "The healthy cart journey after reset.",
    watch:
      "A deliberate Add to cart fault leaves the cart unchanged. The agent reports the failed outcome with browser evidence, then restores the store.",
  },
];

export const EXAMPLE_FLOW_SKILL_NAMES = ONBOARDING_EXAMPLES.map(
  (example) => example.flowSkillName
);

export const findOnboardingExample = (
  name: string
): OnboardingExample | undefined =>
  ONBOARDING_EXAMPLES.find((example) => example.flowSkillName === name);

/** Built output keeps examples under `dist/examples`; a source checkout reads the package. */
export const resolveExampleRoot = (moduleDirectory: string): string =>
  path.basename(moduleDirectory) === "dist"
    ? path.join(moduleDirectory, "examples")
    : path.resolve(moduleDirectory, "../../examples");

const exampleRoot = resolveExampleRoot(import.meta.dirname);

const exampleError = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});

/**
 * Read bundled Example Flow Skills by registry name. The catalog's package
 * reader parses them, but from the bundled root: a user's catalog skill with
 * the same name is never consulted, and nothing is copied into the catalog.
 */
export const readExampleSkills = (
  names: readonly string[],
  root: string = exampleRoot
) =>
  Effect.gen(function* readExamples() {
    const catalog = yield* FlowSkillCatalog;
    const skills = [];
    for (const name of new Set(names)) {
      if (findOnboardingExample(name) === undefined) {
        return yield* Effect.fail(
          exampleError(`${name} is not a bundled Example Flow Skill.`)
        );
      }
      const skill = yield* catalog
        .read(name, root)
        .pipe(
          Effect.mapError((cause) =>
            exampleError(
              `The bundled Example ${name} could not be read: ${cause.message}`
            )
          )
        );
      if (skill.hosts.length !== 1 || skill.hosts[0] !== DEMO_HOST) {
        return yield* Effect.fail(
          exampleError(
            `The bundled Example ${name} must be limited to ${DEMO_HOST}.`
          )
        );
      }
      skills.push(skill);
    }
    return skills;
  });

const inputLine = (name: string, value: string) => `${name}=${value}`;

/**
 * The examples as an agent reads them, with this process's demo origin. The
 * origin changes with every launch, so this text is generated per request
 * rather than shipped.
 */
export const describeOnboardingExamples = (origin: string): string =>
  [
    `# ${DEMO_SITE_NAME} examples`,
    "",
    `${DEMO_SITE_NAME} is the demo store bundled with Contingency. In this MCP process it is served at ${origin}/. The host is ${DEMO_HOST}; the port belongs to this launch only.`,
    "",
    "Run a prepared example with agent_example_run_start. It opens a clean browser context, is labeled Example, and can visit only the demo store. It is a demonstration: it is neither the user's Teaching nor a verification.",
    "",
    ...ONBOARDING_EXAMPLES.flatMap((example) => [
      `## ${example.title}${example.recommended ? " (recommended first example)" : ""}`,
      "",
      `- Example Flow Skill: ${example.flowSkillName}`,
      `- Starts at: ${origin}${example.startPath}`,
      `- The user watches: ${example.watch}`,
      `- Variation to teach: ${example.variation}`,
      `- Observable result: ${example.result}`,
      `- Sample inputs: ${Object.entries(example.sampleInputs)
        .map(([name, value]) => inputLine(name, value))
        .join(", ")}`,
      `- Failure rerun applies: ${example.appliesToCartFault ? "yes, the cart fault affects this journey" : "no"}`,
      "",
    ]),
    "## Demo conditions",
    "",
    `- Deliberate fault: open ${origin}${CART_FAULT_PATH} to break Add to cart in that browser context only. A banner named "Demo fault" labels it; prove failure from the cart, not the banner.`,
    `- Healthy reset: select "Restore healthy store" in the banner, or open ${origin}/?fault=off. Teaching and Dry Runs start in fresh browser contexts, which are always healthy.`,
    `- Clear all demo state in one context: ${origin}/?reset=all.`,
    "- Demo account: demo@ridgeline.test with any password of at least 8 characters. The password is a private input; the user supplies it in Workspace.",
    "",
    "## Demo work in the user's catalog",
    "",
    `- A Flow Skill learned on the store keeps the taught host ${DEMO_HOST}. The catalog lists it with demo: ridgeline, and its Runs carry demoSite: ridgeline.`,
    '- Start the description with "Demo:" so people reading the catalog can tell it apart from a real website\'s journey.',
    `- The port changes between launches. Declare an ordinary input named demo_origin, write store URLs as {{demo_origin}}/path, and supply ${origin} as its value. Pass a url on ${origin} to Dry Runs and Runs.`,
    `- To rerun a verified demo skill against the fault, start agent_run_start with that skill and url ${origin}${CART_FAULT_PATH}. Report the observed failure, then restore the healthy store before agent_run_complete.`,
  ].join("\n");
