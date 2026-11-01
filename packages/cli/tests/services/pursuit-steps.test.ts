import {
  AgentElementRef,
  AgentSnapshotId,
  FlowSkillName,
} from "@contingency/protocol";
import type { AgentSnapshotNode } from "@contingency/protocol";
import { expect, it } from "vitest";

import { preparePursuitSteps } from "../../src/services/mcp-pursuit.ts";
import type { ScopeInput } from "../../src/services/mcp-pursuit.ts";
import { actionSpace } from "../../src/services/system-one-request.ts";

const skill = FlowSkillName.make("1mg mweb adding a sku to cart");
const other = FlowSkillName.make("1mg mweb manual location");

const scope = (...inputs: readonly ScopeInput[]) =>
  new Map(inputs.map((input) => [input.name, input]));
const value = (name: string, text: string, owner = skill): ScopeInput => ({
  flowSkillName: owner,
  kind: "value",
  name,
  value: text,
});
const variable = (name: string): ScopeInput => ({
  flowSkillName: skill,
  kind: "variable",
  name,
  supplied: true,
});

it("accepts Flow Skill steps and fills their input placeholders", () => {
  const { problems, steps } = preparePursuitSteps(
    [
      {
        doneWhen: 'The search page shows "Search medicines & health products".',
        goal: "  Select the homepage search control.  ",
      },
      {
        doneWhen: 'Results show "{{search_query}}" products with "ADD".',
        goal: "Fill {{ search_query }} in the search textbox.",
      },
    ],
    scope(value("search_query", "eno"))
  );
  expect(problems).toEqual([]);
  expect(steps).toEqual([
    {
      doneWhen: 'The search page shows "Search medicines & health products".',
      goal: "Select the homepage search control.",
    },
    {
      doneWhen: 'Results show "eno" products with "ADD".',
      goal: "Fill eno in the search textbox.",
    },
  ]);
});

it("accepts a doneWhen that asks for a popup to be gone", () => {
  expect(
    preparePursuitSteps(
      [{ doneWhen: "No popup covers the page.", goal: "Close the popup." }],
      scope()
    ).problems
  ).toEqual([]);
});

it("refuses a doneWhen that code cannot read on the Page", () => {
  const { problems } = preparePursuitSteps(
    [
      {
        doneWhen:
          "The home page is displayed with Sector 14 selected as delivery location.",
        goal: "Select Sector 14 Gurugram delivery location and proceed to home page.",
      },
      {
        doneWhen: 'No "Cart" or "Login" is shown.',
        goal: "Open the menu.",
      },
    ],
    scope()
  );
  expect(problems).toEqual([
    expect.stringMatching(/^steps\[1\]\.doneWhen quotes no text/u),
    expect.stringMatching(/^steps\[2\]\.doneWhen puts a negation/u),
  ]);
});

it("refuses element references, unknown placeholders, and repeats", () => {
  const { problems } = preparePursuitSteps(
    [
      { doneWhen: 'The page shows "Cart".', goal: "Click @e94." },
      { doneWhen: 'The page shows "{{city}}".', goal: "Choose {{city}}." },
      { doneWhen: 'The page shows "Cart".', goal: "Click @E94" },
      { doneWhen: "   ", goal: 'The page shows "Cart".' },
    ],
    scope(value("search_query", "eno"))
  );
  expect(problems).toEqual([
    expect.stringMatching(/^steps\[1\]\.goal names an element reference/u),
    expect.stringMatching(
      /^steps\[2\]\.goal uses \{\{city\}\}, which names no input/u
    ),
    expect.stringMatching(/^steps\[2\]\.doneWhen uses \{\{city\}\}/u),
    "steps[3].goal repeats steps[1].goal",
    "steps[4].doneWhen is blank",
  ]);
});

it("refuses a goal that only repeats its doneWhen or an earlier goal", () => {
  const { problems } = preparePursuitSteps(
    [
      { doneWhen: 'The page shows "Cart".', goal: 'The page shows "Cart"' },
      { doneWhen: 'The page shows "Login".', goal: "Open the menu." },
      { doneWhen: 'The page shows "Help".', goal: "open the  menu" },
    ],
    scope()
  );
  expect(problems).toEqual([
    expect.stringMatching(/^steps\[1\]\.goal repeats doneWhen/u),
    "steps[3].goal repeats steps[2].goal",
  ]);
});

it("names a Variable rather than quoting it, and needs flowSkillName for shared names", () => {
  const named = preparePursuitSteps(
    [
      {
        doneWhen: 'The "Password" field holds {{password}}.',
        goal: "Enter {{password}} in Password.",
      },
    ],
    scope(variable("password"))
  );
  expect(named.problems).toEqual([]);
  expect(named.steps[0]?.goal).toBe("Enter the Variable password in Password.");

  const quoted = preparePursuitSteps(
    [{ doneWhen: 'The field reads "{{password}}".', goal: "Enter it." }],
    scope(variable("password"))
  );
  expect(quoted.problems).toEqual([
    expect.stringMatching(/^steps\[1\]\.doneWhen quotes Variable/u),
  ]);

  const shared = preparePursuitSteps(
    [{ doneWhen: 'The page shows "{{city}}".', goal: "Choose the city." }],
    new Map([
      ["1mg mweb adding a sku to cart/city", value("city", "Gurugram")],
      ["1mg mweb manual location/city", value("city", "Delhi", other)],
    ])
  );
  expect(shared.problems).toEqual([
    expect.stringMatching(
      /several referenced Flow Skills declare; pass flowSkillName/u
    ),
  ]);
});

const node = (
  ref: string,
  fields: Partial<AgentSnapshotNode> & Pick<AgentSnapshotNode, "role">
): AgentSnapshotNode => ({
  depth: 0,
  interactive: true,
  name: "",
  ref: AgentElementRef.make(ref),
  ...fields,
});

it("offers System One no anonymous or arealess controls", () => {
  const space = actionSpace(
    {
      browserCheckResults: [],
      capturedAt: "2026-11-01T05:10:37.788Z",
      nodes: [
        // 1mg's location dialog: a zero-height wrapper, a full-screen
        // backdrop, and the two real choices.
        node("e1", {
          bounds: { height: 0, width: 448, x: 0, y: 956 },
          clickable: true,
          role: "generic",
        }),
        node("e2", {
          bounds: { height: 956, width: 448, x: 0, y: 0 },
          clickable: true,
          role: "generic",
        }),
        node("e4", { name: "Enable location", role: "button" }),
        node("e5", { name: "Select manually", role: "button" }),
        // An icon button keeps its place: its role says what it is.
        node("e6", { role: "button" }),
        node("e7", {
          clickable: true,
          name: "Search for 'medicines'",
          role: "generic",
        }),
      ],
      snapshotId: AgentSnapshotId.make("snapshot-anonymous"),
      title: "1mg",
      url: "https://www.1mg.com/",
    },
    { visibleOnly: true }
  );
  expect(
    [...(space.targets.get("CLICK")?.values() ?? [])].map(
      (candidate) => candidate.describe
    )
  ).toEqual([
    '[1] button "Enable location"',
    '[2] button "Select manually"',
    '[3] button ""',
    "[4] generic \"Search for 'medicines'\"",
  ]);
});
