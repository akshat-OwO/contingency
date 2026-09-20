import type { FlowSkillFile } from "@contingency/protocol";
import { Result } from "effect";
import { expect, test } from "vitest";

import {
  readFlowSkillFrontmatter,
  stampFlowSkillProvenance,
  validateFlowSkillPackage,
} from "../../src/services/flow-skill-package.ts";

const FLOW_SKILL_NAME = "set-delivery-area";

/**
 * The package a learning agent produces from the delivery-location recording,
 * written the way the vendored authoring skills teach. Every mutation below
 * changes exactly one property of this package, so each test fails if its own
 * check is deleted from the validator.
 */
const GOLDEN_SKILL = `---
name: ${FLOW_SKILL_NAME}
description: Set the shop's delivery city and area and confirm the status names both. Use when an order must reach a named delivery area.
inputs:
  - city
  - delivery_area
---

# Set the delivery area

Read [the accessibility targets](references/accessibility.md) when a control is hard to find.

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

export const goldenFlowSkillFiles = (): readonly FlowSkillFile[] => [
  { content: GOLDEN_SKILL, path: "SKILL.md" },
  { content: GOLDEN_ACCESSIBILITY, path: "references/accessibility.md" },
];

const withSkill = (content: string): readonly FlowSkillFile[] => [
  { content, path: "SKILL.md" },
  { content: GOLDEN_ACCESSIBILITY, path: "references/accessibility.md" },
];

const withAccessibility = (content: string): readonly FlowSkillFile[] => [
  { content: GOLDEN_SKILL, path: "SKILL.md" },
  { content, path: "references/accessibility.md" },
];

const codesFor = (files: readonly FlowSkillFile[]): readonly string[] => {
  const outcome = validateFlowSkillPackage(FLOW_SKILL_NAME, files);
  return Result.isFailure(outcome)
    ? outcome.failure.map((diagnostic) => diagnostic.code)
    : [];
};

const pathFor = (
  files: readonly FlowSkillFile[],
  code: string
): readonly string[] => {
  const outcome = validateFlowSkillPackage(FLOW_SKILL_NAME, files);
  if (Result.isSuccess(outcome)) {
    return [];
  }
  return (
    outcome.failure.find((diagnostic) => diagnostic.code === code)?.path ?? []
  );
};

test("accepts a parameterized package and returns the submitted bytes unchanged", () => {
  const files = goldenFlowSkillFiles();
  const outcome = validateFlowSkillPackage(FLOW_SKILL_NAME, files);
  expect(Result.isSuccess(outcome)).toBe(true);
  if (Result.isSuccess(outcome)) {
    expect(outcome.success).toEqual(files);
  }
});

test("refuses a package with no SKILL.md", () => {
  expect(
    codesFor([
      { content: GOLDEN_ACCESSIBILITY, path: "references/accessibility.md" },
    ])
  ).toEqual(["flow_skill_missing_skill_file"]);
});

test("refuses SKILL.md without frontmatter", () => {
  const files = withSkill(GOLDEN_SKILL.slice(GOLDEN_SKILL.indexOf("\n# ")));
  expect(codesFor(files)).toContain("flow_skill_missing_frontmatter");
  expect(pathFor(files, "flow_skill_missing_frontmatter")).toEqual([
    "SKILL.md",
    "frontmatter",
  ]);
});

test("refuses a frontmatter name that is not the Flow Skill directory", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(`name: ${FLOW_SKILL_NAME}`, "name: set_delivery_area")
  );
  expect(codesFor(files)).toContain("flow_skill_name_mismatch");
  expect(pathFor(files, "flow_skill_name_mismatch")).toEqual([
    "SKILL.md",
    "frontmatter",
    "name",
  ]);
});

test("refuses a package with no description to trigger on", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(/^description: .*$/mu, "description:")
  );
  expect(codesFor(files)).toContain("flow_skill_missing_description");
  expect(pathFor(files, "flow_skill_missing_description")).toEqual([
    "SKILL.md",
    "frontmatter",
    "description",
  ]);
});

test("refuses a placeholder that no declared input covers", () => {
  const files = withSkill(GOLDEN_SKILL.replace("  - delivery_area\n", ""));
  expect(codesFor(files)).toContain("flow_skill_undeclared_input");
  expect(pathFor(files, "flow_skill_undeclared_input")).toEqual([
    "SKILL.md",
    "frontmatter",
    "inputs",
    "delivery_area",
  ]);
});

test("refuses an undeclared placeholder that only a reference file uses", () => {
  const files = withAccessibility(
    `${GOLDEN_ACCESSIBILITY}\nAsk for {{postcode}} when the area is ambiguous.\n`
  );
  expect(codesFor(files)).toContain("flow_skill_undeclared_input");
  expect(pathFor(files, "flow_skill_undeclared_input")).toEqual([
    "references/accessibility.md",
    "inputs",
    "postcode",
  ]);
});

test("refuses an undeclared placeholder that only the description uses", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(
      "description: Set the shop's",
      "description: Set {{region}} for the shop's"
    )
  );
  expect(codesFor(files)).toContain("flow_skill_undeclared_input");
  expect(pathFor(files, "flow_skill_undeclared_input")).toEqual([
    "SKILL.md",
    "frontmatter",
    "inputs",
    "region",
  ]);
});

test("refuses a SKILL.md that carries no numbered procedure", () => {
  const files = withSkill(
    `${GOLDEN_SKILL.slice(0, GOLDEN_SKILL.indexOf("1. "))}Open the delivery chooser and confirm the area.\n`
  );
  expect(codesFor(files)).toContain("flow_skill_missing_steps");
});

test("refuses a step with no completion condition", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(
      '2. Choose the button named "Select manually". Done when: a textbox named "Search for your delivery area" is on the page.',
      '2. Choose the button named "Select manually".'
    )
  );
  expect(codesFor(files)).toContain("flow_skill_missing_completion_condition");
  expect(pathFor(files, "flow_skill_missing_completion_condition")).toEqual([
    "SKILL.md",
    "steps",
    "2",
  ]);
});

test("refuses a short-lived element reference", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(
      'the button named "Select manually"',
      "the element e17"
    )
  );
  expect(codesFor(files)).toContain("flow_skill_element_ref");
});

test("refuses a generated selector", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace(
      'the button named "Confirm delivery area"',
      "the button #confirm-area"
    )
  );
  expect(codesFor(files)).toContain("flow_skill_generated_selector");
});

test("refuses recording artifacts the Flow Skill outlives", () => {
  const files = withSkill(
    `${GOLDEN_SKILL}\nReplay trace.zip when a step is unclear.\n`
  );
  expect(codesFor(files)).toContain("flow_skill_recording_residue");
});

test("refuses an embedded screenshot", () => {
  const files = withSkill(
    `${GOLDEN_SKILL}\n![The delivery panel](references/delivery.png)\n`
  );
  expect(codesFor(files)).toContain("flow_skill_embedded_image");
});

test("refuses private model reasoning", () => {
  const files = withAccessibility(
    `${GOLDEN_ACCESSIBILITY}\nI think the status line is the most stable target.\n`
  );
  expect(codesFor(files)).toContain("flow_skill_private_reasoning");
});

test("refuses a captured credential literal", () => {
  const files = withSkill(
    GOLDEN_SKILL.replace("inputs:", "inputs:\n  - password\n").replace(
      "# Set the delivery area",
      "# Set the delivery area\n\nSign in with password: hunter2-from-the-demo"
    )
  );
  expect(codesFor(files)).toContain("flow_skill_secret_literal");
});

test("refuses a link to a reference file the package does not carry", () => {
  const files = [
    {
      content: GOLDEN_SKILL.replace(
        "references/accessibility.md",
        "references/targets.md"
      ),
      path: "SKILL.md",
    },
    { content: GOLDEN_ACCESSIBILITY, path: "references/accessibility.md" },
  ];
  expect(codesFor(files)).toContain("flow_skill_missing_reference");
  expect(pathFor(files, "flow_skill_missing_reference")).toEqual([
    "SKILL.md",
    "references/targets.md",
  ]);
});

test("refuses an accessibility reference with no stability rationale", () => {
  const files = withAccessibility(
    GOLDEN_ACCESSIBILITY.slice(
      0,
      GOLDEN_ACCESSIBILITY.indexOf("## Why these targets are stable")
    )
  );
  expect(codesFor(files)).toContain("flow_skill_missing_stability_rationale");
});

test("refuses an accessibility target without nearby context", () => {
  const files = withAccessibility(
    GOLDEN_ACCESSIBILITY.replace(
      '- role=button name="Select manually" context="Delivery area"',
      '- role=button name="Select manually"'
    )
  );
  expect(codesFor(files)).toContain("flow_skill_incomplete_target");
});

test("refuses an accessibility reference that lists no target at all", () => {
  const files = withAccessibility(
    "# Accessibility targets\n\n## Why these targets are stable\n\nThe labels are visible.\n"
  );
  expect(codesFor(files)).toContain("flow_skill_missing_target");
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
  const stamped = stampFlowSkillProvenance(authored, {
    emulation: {
      colorScheme: "dark",
      locale: "de-DE",
      timezone: "Europe/Berlin",
      userAgentProfile: "chrome-iphone",
      viewport: { deviceScaleFactor: 3, height: 844, width: 390 },
    },
    hosts: ["127.0.0.1", "shop.example.com"],
  });
  const frontmatter = readFlowSkillFrontmatter(stamped);
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
  expect(frontmatter?.emulation?.locale).toBe("de-DE");
  expect(frontmatter?.emulation?.timezone).toBe("Europe/Berlin");
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
  const frontmatter = readFlowSkillFrontmatter(
    "---\nname: set-delivery-area\ndescription: Set it.\ninputs:\n  - city\n---\n\n1. Go. Done when: done.\n"
  );
  expect(frontmatter?.hosts).toEqual([]);
  expect(frontmatter?.emulation).toBeUndefined();
});

test("ignores a viewport scalar it cannot read back", () => {
  const frontmatter = readFlowSkillFrontmatter(
    "---\nname: x\nemulation:\n  viewport: wide\n---\n\nbody\n"
  );
  expect(frontmatter?.emulation?.viewport).toBeUndefined();
});

test("reads an input declared as a mapping with a description", () => {
  const frontmatter = readFlowSkillFrontmatter(
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
  // An input's own description never becomes the Flow Skill's.
  expect(frontmatter?.description).toBe("Add an anvil to the cart.");
});

test("accepts a package whose inputs use the mapping shape", () => {
  const mapped = GOLDEN_SKILL.replace(
    "inputs:\n  - city\n  - delivery_area",
    [
      "inputs:",
      "  - name: city",
      "    description: The city the shop delivers to.",
      "  - name: delivery_area",
    ].join("\n")
  );
  expect(codesFor(withSkill(mapped))).toEqual([]);
});

test("names the shape when an inputs entry is neither form", () => {
  const broken = GOLDEN_SKILL.replace("  - city\n", "  - label: city\n");
  const codes = codesFor(withSkill(broken));
  expect(codes).toContain("flow_skill_invalid_input");
  // The undeclared-input check still fires for the placeholder that now has
  // no declaration, but the shape problem is reported beside it.
  expect(codes).toContain("flow_skill_undeclared_input");
});

test("still refuses a placeholder no accepted shape declares", () => {
  const undeclared = GOLDEN_SKILL.replace("  - delivery_area\n", "");
  const codes = codesFor(withSkill(undeclared));
  expect(codes).toEqual(["flow_skill_undeclared_input"]);
});
