/**
 * The demo and catalog scenarios the System One benchmarks drive, each with
 * an outcome checked in code, and the Flow Skill steps they turn into cues.
 */
import path from "node:path";

import type { AgentBrowserSnapshot } from "@contingency/protocol";
import { Config, Effect } from "effect";

import { flowSkillProcedureSteps } from "../../src/services/flow-skill-package.ts";
import type { Cue } from "../../src/services/system-one-request.ts";

export interface Scenario {
  readonly inputs: Readonly<Record<string, string>>;
  readonly label: string;
  readonly skill:
    | {
        readonly example: "example-broken-cart" | "example-delivery-cart";
        readonly kind: "example";
      }
    | {
        readonly directory: string;
        readonly kind: "catalog";
        readonly url: string;
      };
  /** Independent proof read from every page the run saw. */
  readonly verify: (pages: readonly string[], final: string) => boolean;
}

export const deliveryCart = (
  product: string,
  city: string,
  area: string
): Scenario => ({
  inputs: { area, city, product },
  label: "example-delivery-cart",
  skill: { example: "example-delivery-cart", kind: "example" },
  verify: (_pages, final) =>
    final.includes("Your cart") &&
    final.includes(product) &&
    final.includes(`${area}, ${city}`),
});

export const DEMO_SCENARIOS: readonly Scenario[] = [
  deliveryCart("Cedar Pull Saw", "Denver", "Highlands"),
  deliveryCart("Trail Hammer", "Boulder", "Pearl Street"),
  deliveryCart("Garden Trowel", "Golden", "Pleasant View"),
  {
    inputs: { product: "Cedar Pull Saw" },
    label: "example-broken-cart",
    skill: { example: "example-broken-cart", kind: "example" },
    verify: (pages, final) =>
      pages.some((page) => page.includes("Your cart is empty")) &&
      !final.includes("Demo fault"),
  },
];

export const parsePairs = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split(";")
      .map((pair) => pair.split("="))
      .flatMap(([name, ...value]) =>
        name === undefined || name.trim() === ""
          ? []
          : [[name.trim(), value.join("=").trim()]]
      )
  );

/** A verified Flow Skill from a real catalog, described by the environment. */
export const catalogScenario = Effect.gen(function* readCatalogScenario() {
  const directory = yield* Config.String("JEV_SKILL_DIR");
  const url = yield* Config.String("JEV_SKILL_URL");
  const inputs = parsePairs(
    yield* Config.String("JEV_SKILL_INPUTS").pipe(Config.withDefault(""))
  );
  const expected = (yield* Config.String("JEV_SKILL_EXPECT").pipe(
    Config.withDefault("")
  ))
    .split(";")
    .map((phrase) => phrase.split("|").map((option) => option.trim()))
    .filter((options) => options.some((option) => option !== ""));
  return {
    inputs,
    label: path.basename(directory),
    skill: { directory: path.resolve(directory), kind: "catalog", url },
    verify: (_pages, final) =>
      expected.every((options) =>
        options.some((option) => final.includes(option))
      ),
  } satisfies Scenario;
});

/** Placeholders name inputs case-insensitively, as `{{city}}` names `CITY`. */
export const fillPlaceholders = (
  template: string,
  inputs: Readonly<Record<string, string>>
) => {
  const byName = new Map(
    Object.entries(inputs).map(([name, value]) => [name.toLowerCase(), value])
  );
  return template.replaceAll(
    /\{\{(?<name>[^}]+)\}\}/gu,
    (whole, name: string) => byName.get(name.trim().toLowerCase()) ?? whole
  );
};

export const cuesFor = (
  skill: string,
  inputs: Readonly<Record<string, string>>
): readonly Cue[] =>
  flowSkillProcedureSteps(skill).map((step) => ({
    doneWhen: fillPlaceholders(step.doneWhen, inputs),
    inputs,
    instruction: fillPlaceholders(
      step.description.replace(/Done when:[\s\S]*$/u, "").trim(),
      inputs
    ),
    step: step.index + 1,
  }));

export const pageText = (snapshot: AgentBrowserSnapshot) =>
  snapshot.nodes
    .map((node) => `${node.role} ${node.name} ${node.value ?? ""}`)
    .join("\n");

export const percentile = (values: readonly number[], fraction: number) => {
  const sorted = values.toSorted((left, right) => left - right);
  const at = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[Math.min(at, sorted.length - 1)] ?? 0);
};
export const elapsedSince = (start: number) =>
  Effect.sync(() => Math.round(performance.now() - start));
export const now = Effect.sync(() => performance.now());
