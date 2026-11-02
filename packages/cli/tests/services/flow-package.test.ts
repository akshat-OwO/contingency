import type { FlowFile } from "@contingency/protocol";
import { Result } from "effect";
import { expect, test } from "vitest";

import {
  flowProcedureSteps,
  readFlowFrontmatter,
  stampFlowProvenance,
  stampFlowVerification,
  flowVerificationDigests,
  validateFlowPackage,
} from "../../src/services/flow-package.ts";
import { browserRequirements } from "../../src/services/platform-requirements.ts";

const FLOW_FLOW_NAME = "set-delivery-area";

/**
 * The package a learning agent produces from the delivery-location recording,
 * written the way the packaged writing guidance teaches. Every mutation below
 * changes exactly one property of this package, so each test fails if its own
 * check is deleted from the validator.
 */
const GOLDEN_FLOW = `---
name: ${FLOW_FLOW_NAME}
description: Set the shop's delivery city and area and confirm the status names both. Use when an order must reach a named delivery area.
inputs:
  - city
  - delivery_area
---

# Set the delivery area

Read [the accessibility targets](targets.md) when a control is hard to find.

1. Choose the button named "Choose delivery area". Done when: a heading named "Delivery area" is on the page.
2. Choose the button named "Select manually". Done when: a textbox named "Search for your delivery area" is on the page.
3. Fill the textbox named "City" with {{city}}. Done when: the textbox holds {{city}}.
4. Fill the textbox named "Search for your delivery area" with {{delivery_area}}. Done when: the textbox holds {{delivery_area}}.
5. Choose the button named "Confirm delivery area". Done when: the status reads "Delivering to {{delivery_area}}, {{city}}".
`;

const GOLDEN_ACCESSIBILITY = `# Accessibility targets

- role=button name="Choose delivery area" context="Delivery"
- role=button name="Select manually" context="Delivery area"
- role=textbox name="City" context="Delivery area"
- role=textbox name="Search for your delivery area" context="Delivery area"
- role=button name="Confirm delivery area" context="Delivery area"

## Why these targets are stable

Every control keeps its visible label across renders, and the delivery section
re-renders in place, so the enclosing heading separates a repeated name from
the same name elsewhere on the page.
`;

export const goldenFlowFiles = (): readonly FlowFile[] => [
  { content: GOLDEN_FLOW, path: "flow.md" },
  { content: GOLDEN_ACCESSIBILITY, path: "targets.md" },
];

const withFlow = (content: string): readonly FlowFile[] => [
  { content, path: "flow.md" },
  { content: GOLDEN_ACCESSIBILITY, path: "targets.md" },
];

const withAccessibility = (content: string): readonly FlowFile[] => [
  { content: GOLDEN_FLOW, path: "flow.md" },
  { content, path: "targets.md" },
];

const codesFor = (files: readonly FlowFile[]): readonly string[] => {
  const outcome = validateFlowPackage(FLOW_FLOW_NAME, files);
  return Result.isFailure(outcome)
    ? outcome.failure.map((diagnostic) => diagnostic.code)
    : [];
};

const pathFor = (
  files: readonly FlowFile[],
  code: string
): readonly string[] => {
  const outcome = validateFlowPackage(FLOW_FLOW_NAME, files);
  if (Result.isSuccess(outcome)) {
    return [];
  }
  return (
    outcome.failure.find((diagnostic) => diagnostic.code === code)?.path ?? []
  );
};

test("accepts a parameterized package and returns the submitted bytes unchanged", () => {
  const files = goldenFlowFiles();
  const outcome = validateFlowPackage(FLOW_FLOW_NAME, files);
  expect(Result.isSuccess(outcome)).toBe(true);
  if (Result.isSuccess(outcome)) {
    expect(outcome.success).toEqual(files);
  }
});

test("refuses a package with no flow.md", () => {
  expect(
    codesFor([{ content: GOLDEN_ACCESSIBILITY, path: "targets.md" }])
  ).toEqual(["flow_missing_flow_file"]);
});

test("refuses flow.md without frontmatter", () => {
  const files = withFlow(GOLDEN_FLOW.slice(GOLDEN_FLOW.indexOf("\n# ")));
  expect(codesFor(files)).toContain("flow_missing_frontmatter");
  expect(pathFor(files, "flow_missing_frontmatter")).toEqual([
    "flow.md",
    "frontmatter",
  ]);
});

test("refuses a frontmatter name that is not the Flow directory", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace(`name: ${FLOW_FLOW_NAME}`, "name: set_delivery_area")
  );
  expect(codesFor(files)).toContain("flow_name_mismatch");
  expect(pathFor(files, "flow_name_mismatch")).toEqual([
    "flow.md",
    "frontmatter",
    "name",
  ]);
});

test("refuses a package with no description to trigger on", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace(/^description: .*$/mu, "description:")
  );
  expect(codesFor(files)).toContain("flow_missing_description");
  expect(pathFor(files, "flow_missing_description")).toEqual([
    "flow.md",
    "frontmatter",
    "description",
  ]);
});

test("refuses a placeholder that no declared input covers", () => {
  const files = withFlow(GOLDEN_FLOW.replace("  - delivery_area\n", ""));
  expect(codesFor(files)).toContain("flow_undeclared_input");
  expect(pathFor(files, "flow_undeclared_input")).toEqual([
    "flow.md",
    "frontmatter",
    "inputs",
    "delivery_area",
  ]);
});

test("refuses an undeclared placeholder that only a reference file uses", () => {
  const files = withAccessibility(
    `${GOLDEN_ACCESSIBILITY}\nAsk for {{postcode}} when the area is ambiguous.\n`
  );
  expect(codesFor(files)).toContain("flow_undeclared_input");
  expect(pathFor(files, "flow_undeclared_input")).toEqual([
    "targets.md",
    "inputs",
    "postcode",
  ]);
});

test("refuses an undeclared placeholder that only the description uses", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace(
      "description: Set the shop's",
      "description: Set {{region}} for the shop's"
    )
  );
  expect(codesFor(files)).toContain("flow_undeclared_input");
  expect(pathFor(files, "flow_undeclared_input")).toEqual([
    "flow.md",
    "frontmatter",
    "inputs",
    "region",
  ]);
});

test("refuses a flow.md that carries no numbered procedure", () => {
  const files = withFlow(
    `${GOLDEN_FLOW.slice(0, GOLDEN_FLOW.indexOf("1. "))}Open the delivery chooser and confirm the area.\n`
  );
  expect(codesFor(files)).toContain("flow_missing_steps");
});

test("refuses a step with no completion condition", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace(
      '2. Choose the button named "Select manually". Done when: a textbox named "Search for your delivery area" is on the page.',
      '2. Choose the button named "Select manually".'
    )
  );
  expect(codesFor(files)).toContain("flow_missing_completion_condition");
  expect(pathFor(files, "flow_missing_completion_condition")).toEqual([
    "flow.md",
    "steps",
    "2",
  ]);
});

test("refuses a short-lived element reference", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace('the button named "Select manually"', "the element e17")
  );
  expect(codesFor(files)).toContain("flow_element_ref");
});

test("refuses a generated selector", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace(
      'the button named "Confirm delivery area"',
      "the button #confirm-area"
    )
  );
  expect(codesFor(files)).toContain("flow_generated_selector");
});

test("refuses recording artifacts the Flow outlives", () => {
  const files = withFlow(
    `${GOLDEN_FLOW}\nReplay trace.zip when a step is unclear.\n`
  );
  expect(codesFor(files)).toContain("flow_recording_residue");
});

test("refuses an embedded screenshot", () => {
  const files = withFlow(
    `${GOLDEN_FLOW}\n![The delivery panel](references/delivery.png)\n`
  );
  expect(codesFor(files)).toContain("flow_embedded_image");
});

test("refuses private model reasoning", () => {
  const files = withAccessibility(
    `${GOLDEN_ACCESSIBILITY}\nI think the status line is the most stable target.\n`
  );
  expect(codesFor(files)).toContain("flow_private_reasoning");
});

test("refuses a captured credential literal", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace("inputs:", "inputs:\n  - password\n").replace(
      "# Set the delivery area",
      "# Set the delivery area\n\nSign in with password: hunter2-from-the-demo"
    )
  );
  expect(codesFor(files)).toContain("flow_secret_literal");
});

test("refuses a link to a reference file the package does not carry", () => {
  const files = [
    {
      content: GOLDEN_FLOW.replace("targets.md", "missing-targets.md"),
      path: "flow.md",
    },
    { content: GOLDEN_ACCESSIBILITY, path: "targets.md" },
  ];
  expect(codesFor(files)).toContain("flow_missing_reference");
  expect(pathFor(files, "flow_missing_reference")).toEqual([
    "flow.md",
    "missing-targets.md",
  ]);
});

test("refuses an accessibility reference with no stability rationale", () => {
  const files = withAccessibility(
    GOLDEN_ACCESSIBILITY.slice(
      0,
      GOLDEN_ACCESSIBILITY.indexOf("## Why these targets are stable")
    )
  );
  expect(codesFor(files)).toContain("flow_missing_stability_rationale");
});

test("refuses an accessibility target without nearby context", () => {
  const files = withAccessibility(
    GOLDEN_ACCESSIBILITY.replace(
      '- role=button name="Select manually" context="Delivery area"',
      '- role=button name="Select manually"'
    )
  );
  expect(codesFor(files)).toContain("flow_incomplete_target");
});

test("refuses an accessibility reference that lists no target at all", () => {
  const files = withAccessibility(
    "# Accessibility targets\n\n## Why these targets are stable\n\nThe labels are visible.\n"
  );
  expect(codesFor(files)).toContain("flow_missing_target");
});

test("stamps the demonstrated hosts and Emulation over whatever the agent wrote", () => {
  const authored = [
    "---",
    "name: set-delivery-area",
    "description: Set the delivery area.",
    "inputs:",
    "  - city",
    "hosts:",
    "  - claimed.example.com",
    "emulation:",
    "  viewport: 320x480@1",
    "---",
    "",
    "1. Do the thing. Done when: it is done.",
  ].join("\n");
  const stamped = stampFlowProvenance(authored, {
    emulation: {
      colorScheme: "dark",
      geolocation: { accuracy: 50, latitude: 28.4718, longitude: 77.0456 },
      locale: "de-DE",
      pageZoom: 400,
      permissions: [
        {
          origin: "https://shop.example.com",
          permission: "geolocation",
          state: "granted",
        },
        { origin: undefined, permission: "notifications", state: "denied" },
      ],
      textScale: 200,
      timezone: "Europe/Berlin",
      userAgentProfile: "chrome-iphone",
      viewport: { deviceScaleFactor: 3, height: 844, width: 390 },
    },
    hosts: ["127.0.0.1", "shop.example.com"],
  });
  const frontmatter = readFlowFrontmatter(stamped);
  // The agent's asserted host is replaced, not merged: only what the recording
  // observed may widen a Run's ceiling.
  expect(frontmatter?.hosts).toEqual(["127.0.0.1", "shop.example.com"]);
  expect(frontmatter?.emulation?.viewport).toEqual({
    deviceScaleFactor: 3,
    height: 844,
    width: 390,
  });
  expect(frontmatter?.emulation?.userAgentProfile).toBe("chrome-iphone");
  expect(frontmatter?.emulation?.colorScheme).toBe("dark");
  expect(frontmatter).toMatchObject({
    emulation: { pageZoom: 400, textScale: 200 },
  });
  expect(frontmatter?.emulation?.locale).toBe("de-DE");
  expect(frontmatter?.emulation?.timezone).toBe("Europe/Berlin");
  // A flow that only works from one place says so, rather than reading as
  // portable (#241).
  expect(frontmatter?.emulation?.geolocation).toEqual({
    accuracy: 50,
    latitude: 28.4718,
    longitude: 77.0456,
  });
  expect(frontmatter?.emulation?.permissions).toEqual([
    {
      origin: "https://shop.example.com",
      permission: "geolocation",
      state: "granted",
    },
    { origin: undefined, permission: "notifications", state: "denied" },
  ]);
  // The keys Contingency does not own survive untouched.
  expect(frontmatter?.name).toBe("set-delivery-area");
  expect(frontmatter?.inputs).toEqual([
    { description: undefined, name: "city" },
  ]);
  expect(frontmatter?.body.trim()).toBe(
    "1. Do the thing. Done when: it is done."
  );
});

test("reads a package saved before Contingency stamped provenance", () => {
  const frontmatter = readFlowFrontmatter(
    "---\nname: set-delivery-area\ndescription: Set it.\ninputs:\n  - city\n---\n\n1. Go. Done when: done.\n"
  );
  expect(frontmatter?.hosts).toEqual([]);
  expect(frontmatter?.emulation).toBeUndefined();
});

test("reads a permission entry written without a state as granted", () => {
  const frontmatter = readFlowFrontmatter(
    "---\nname: x\nemulation:\n  permissions:\n    - geolocation\n  locale: en-IN\n---\n\nbody\n"
  );
  expect(frontmatter?.emulation?.permissions).toEqual([
    { origin: undefined, permission: "geolocation", state: "granted" },
  ]);
  // The sequence ends where the next indented key begins.
  expect(frontmatter?.emulation?.locale).toBe("en-IN");
});

test("ignores a geolocation scalar it cannot read back", () => {
  const frontmatter = readFlowFrontmatter(
    "---\nname: x\nemulation:\n  geolocation: 128.0,77.0\n---\n\nbody\n"
  );
  expect(frontmatter?.emulation?.geolocation).toBeUndefined();
});

test("ignores a viewport scalar it cannot read back", () => {
  const frontmatter = readFlowFrontmatter(
    "---\nname: x\nemulation:\n  viewport: wide\n---\n\nbody\n"
  );
  expect(frontmatter?.emulation?.viewport).toBeUndefined();
});

test("reads an input declared as a mapping with a description", () => {
  const frontmatter = readFlowFrontmatter(
    [
      "---",
      "name: add-anvil",
      "description: Add an anvil to the cart.",
      "inputs:",
      "  - name: sku",
      "    description: The product SKU added to the cart.",
      "  - quantity",
      "---",
      "",
      "1. Go. Done when: done.",
    ].join("\n")
  );
  expect(frontmatter?.inputs).toEqual([
    { description: "The product SKU added to the cart.", name: "sku" },
    { description: undefined, name: "quantity" },
  ]);
  // An input's own description never becomes the Flow's.
  expect(frontmatter?.description).toBe("Add an anvil to the cart.");
});

test("accepts a package whose inputs use the mapping shape", () => {
  const mapped = GOLDEN_FLOW.replace(
    "inputs:\n  - city\n  - delivery_area",
    [
      "inputs:",
      "  - name: city",
      "    description: The city the shop delivers to.",
      "  - name: delivery_area",
    ].join("\n")
  );
  expect(codesFor(withFlow(mapped))).toEqual([]);
});

test("names the shape when an inputs entry is neither form", () => {
  const broken = GOLDEN_FLOW.replace("  - city\n", "  - label: city\n");
  const codes = codesFor(withFlow(broken));
  expect(codes).toContain("flow_invalid_input");
  // The undeclared-input check still fires for the placeholder that now has
  // no declaration, but the shape problem is reported beside it.
  expect(codes).toContain("flow_undeclared_input");
});

test("still refuses a placeholder no accepted shape declares", () => {
  const undeclared = GOLDEN_FLOW.replace("  - delivery_area\n", "");
  const codes = codesFor(withFlow(undeclared));
  expect(codes).toEqual(["flow_undeclared_input"]);
});

test("ends the last step at the section that follows the procedure", () => {
  const withSection = `${GOLDEN_FLOW}
## Reading the result

The status only appears once the shop accepts the area.
`;
  const steps = flowProcedureSteps(withSection);
  expect(steps).toHaveLength(5);
  expect(steps.at(-1)?.description).toBe(
    '5. Choose the button named "Confirm delivery area". Done when: the status reads "Delivering to {{delivery_area}}, {{city}}".'
  );
  // The prose after the steps is not part of the Run's last instruction.
  expect(steps.at(-1)?.description).not.toContain("Reading the result");
});

test("keeps a fenced comment inside the step that carries it", () => {
  const withFence = GOLDEN_FLOW.replace(
    '5. Choose the button named "Confirm delivery area". Done when: the status reads "Delivering to {{delivery_area}}, {{city}}".\n',
    [
      '5. Choose the button named "Confirm delivery area".',
      "",
      "   ```sh",
      "# not a heading",
      "   ```",
      "",
      '   Done when: the status reads "Delivering to {{delivery_area}}, {{city}}".',
      "",
    ].join("\n")
  );
  const steps = flowProcedureSteps(withFence);
  expect(steps).toHaveLength(5);
  expect(steps.at(-1)?.description).toContain("# not a heading");
  expect(steps.at(-1)?.doneWhen).toBe(
    'the status reads "Delivering to {{delivery_area}}, {{city}}".'
  );
});

test("refuses Source Document frontmatter in a learned Flow", () => {
  const files = withFlow(
    GOLDEN_FLOW.replace("inputs:", "source: private-runbook.md\ninputs:")
  );
  expect(codesFor(files)).toContain("flow_source_forbidden");
  expect(pathFor(files, "flow_source_forbidden")).toEqual([
    "flow.md",
    "frontmatter",
    "source",
  ]);
});

test("round-trips every Contingency stamp in flow.md and clears verification on save", () => {
  const stamped = stampFlowProvenance(GOLDEN_FLOW, {
    emulation: {
      colorScheme: "dark",
      geolocation: undefined,
      locale: "en-US",
      permissions: [],
      timezone: "UTC",
      userAgentProfile: "default",
      viewport: { deviceScaleFactor: 2, height: 844, width: 390 },
    },
    hosts: ["shop.example.com"],
    runtime: browserRequirements,
  });
  const verification = {
    completedAt: "2026-11-02",
    inputs: [{ changed: true, name: "city" }],
    observableOutcome: "Delivery confirmed",
    origin: "workspace" as const,
    outcome: "passed" as const,
    platform: "web" as const,
    verifiedAt: "2026-11-02",
  };
  const content = stampFlowVerification(stamped, verification);
  const read = readFlowFrontmatter(content);
  expect(read?.verification).toEqual({
    ...verification,
    digests: flowVerificationDigests(stamped),
  });
  expect(read?.hosts).toEqual(["shop.example.com"]);
  expect(read?.emulation?.viewport).toEqual({
    deviceScaleFactor: 2,
    height: 844,
    width: 390,
  });
  expect(read?.runtime.requirements.platform).toBe("web");
  expect(
    readFlowFrontmatter(
      stampFlowProvenance(content, { emulation: null, hosts: [] })
    )?.verification
  ).toBeUndefined();
});

test("resolves supporting links relative to their document, including references directories", () => {
  const files = [
    ...goldenFlowFiles(),
    {
      content: "Read [setup](../setup.md) and [notes](notes.md).",
      path: "references/index.md",
    },
    {
      content: "# Notes\nUse the visible labels.",
      path: "references/notes.md",
    },
    { content: "# Setup\nStart at the shop.", path: "setup.md" },
  ];
  expect(codesFor(files)).toEqual([]);
  expect(
    codesFor(
      files.map((file) =>
        file.path === "references/index.md"
          ? { ...file, content: "Read [setup](setup.md)." }
          : file
      )
    )
  ).toContain("flow_missing_reference");
});
