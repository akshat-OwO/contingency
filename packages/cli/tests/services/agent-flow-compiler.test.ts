import {
  AgentElementRef,
  AgentSnapshotId,
  ScreenshotHash,
} from "@contingency/protocol";
import type {
  AgentBrowserSnapshot,
  AgentFlowDraftProposal,
  AgentStepProposal,
  CapturedAction,
  TeachingScreenshot,
} from "@contingency/protocol";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  compileAgentFlowDraft,
  domainScopeCovers,
  isDomainScopeEntry,
  observedHosts,
} from "../../src/services/agent-flow-compiler.ts";
import type { Demonstration } from "../../src/services/agent-flow-compiler.ts";

const at = (second: number) =>
  new Date(Date.UTC(2026, 8, 1, 0, 0, second)).toISOString();

const snapshot = (id: string, url: string): AgentBrowserSnapshot => ({
  capturedAt: at(0),
  nodes: [
    { depth: 0, name: "Shop", ref: AgentElementRef.make("e1"), role: "link" },
  ],
  snapshotId: AgentSnapshotId.make(id),
  title: "Shop",
  url,
});

const action = (
  id: string,
  second: number,
  urlBefore: string,
  urlAfter: string,
  outcome: CapturedAction["outcome"] = "completed"
): CapturedAction => ({
  action: { type: "navigate", url: urlAfter },
  actor: "agent",
  at: at(second),
  description: `Navigate to ${urlAfter}`,
  id,
  outcome,
  snapshotAfter:
    outcome === "completed" ? AgentSnapshotId.make(`s-${id}`) : null,
  snapshotBefore: null,
  urlAfter,
  urlBefore,
});

const shop = "https://shop.example.com/";
const cart = "https://shop.example.com/cart";
const pay = "https://pay.example.net/checkout";

const contentHash = ScreenshotHash.make(`sha256-${"a".repeat(64)}`);

const screenshot: TeachingScreenshot = {
  capturedAt: at(1),
  contentHash,
  format: "png",
  id: "screenshot-1",
  url: shop,
};

const demonstration: Demonstration = {
  actions: [
    action("a1", 1, "about:blank", shop),
    action("a2", 2, shop, cart),
    action("a3", 3, cart, cart, "failed"),
    action("a4", 4, cart, pay),
  ],
  instructions: [
    { at: at(0), id: "i0", text: "Open the shop" },
    { at: at(3), id: "i3", text: "Now pay for it" },
  ],
  playByPlay: "The user demonstrated the journey.",
  screenshotContents: new Map([
    [
      contentHash,
      { ...screenshot, encoding: "base64", image: "masked-image" } as const,
    ],
  ]),
  screenshots: [screenshot],
  snapshots: new Map([
    [AgentSnapshotId.make("s-a1"), snapshot("s-a1", shop)],
    [AgentSnapshotId.make("s-a2"), snapshot("s-a2", cart)],
    [AgentSnapshotId.make("s-a4"), snapshot("s-a4", pay)],
  ]),
  urlTransitions: [
    { actionId: null, at: at(0), from: "about:blank", to: shop },
    { actionId: "a2", at: at(2), from: shop, to: cart },
    { actionId: "a4", at: at(4), from: cart, to: pay },
  ],
  variables: [],
};

const fillTheCart: AgentStepProposal = {
  confirmation: false,
  description: "Open the shop and add the item to the cart.",
  firstActionId: "a1",
  lastActionId: "a2",
  name: "Fill the cart",
};

const goToCheckout: AgentStepProposal = {
  confirmation: true,
  description: "Reach the payment page.",
  firstActionId: "a3",
  lastActionId: "a4",
  name: "Go to checkout",
};

const proposal: AgentFlowDraftProposal = {
  description: "Browse the shop and reach checkout.",
  domainScope: { hosts: ["shop.example.com", "pay.example.net"] },
  schemaVersion: 1,
  steps: [fillTheCart, goToCheckout],
  tags: ["shop", "checkout"],
  title: "Shop checkout",
};

const failureCodes = (
  compiled: ReturnType<typeof compileAgentFlowDraft>
): string[] =>
  Result.isFailure(compiled)
    ? compiled.failure.map(({ code }) => code)
    : ["<success>"];

describe("compileAgentFlowDraft", () => {
  it("derives one Evidence Slice per Step from the demonstrated spans", () => {
    const compiled = compileAgentFlowDraft(proposal, demonstration);
    expect(Result.isSuccess(compiled)).toBe(true);
    if (!Result.isSuccess(compiled)) {
      return;
    }
    const [first, second] = compiled.success;
    expect(first?.actions.map(({ id }) => id)).toEqual(["a1", "a2"]);
    expect(first?.before).toBeNull();
    expect(first?.after?.snapshotId).toBe("s-a2");
    // The slice names where the bytes live rather than carrying them.
    expect(first?.screenshots).toEqual([
      { ...screenshot, path: `screenshots/${contentHash}.png` },
    ]);
    // Instructions given before any action belong to the first Step.
    expect(first?.instructions.map(({ id }) => id)).toEqual(["i0"]);
    expect(first?.urlTransitions.map(({ actionId }) => actionId)).toEqual([
      null,
      "a2",
    ]);
    // The failed attempt stays in the evidence: it happened.
    expect(second?.actions.map(({ id }) => id)).toEqual(["a3", "a4"]);
    expect(second?.instructions.map(({ id }) => id)).toEqual(["i3"]);
    expect(second?.after?.url).toBe(pay);
    expect(second?.startedAt).toBe(at(3));
    expect(second?.endedAt).toBe(at(4));
  });

  it("refuses unknown, inverted, and overlapping spans", () => {
    const unknown = compileAgentFlowDraft(
      {
        ...proposal,
        steps: [{ ...fillTheCart, lastActionId: "a9" }],
      },
      demonstration
    );
    expect(failureCodes(unknown)).toEqual(["unknown_action"]);
    expect(Result.isFailure(unknown) && unknown.failure[0]?.path).toEqual([
      "steps",
      0,
      "lastActionId",
    ]);

    const inverted = compileAgentFlowDraft(
      {
        ...proposal,
        steps: [{ ...fillTheCart, firstActionId: "a2", lastActionId: "a1" }],
      },
      demonstration
    );
    expect(failureCodes(inverted)).toEqual(["inverted_span"]);

    const overlapping = compileAgentFlowDraft(
      {
        ...proposal,
        steps: [fillTheCart, { ...goToCheckout, firstActionId: "a2" }],
      },
      demonstration
    );
    expect(failureCodes(overlapping)).toEqual(["overlapping_span"]);
  });

  it("refuses a Step with no completed action to evidence it", () => {
    const compiled = compileAgentFlowDraft(
      {
        ...proposal,
        steps: [
          fillTheCart,
          { ...goToCheckout, firstActionId: "a3", lastActionId: "a3" },
        ],
      },
      demonstration
    );
    expect(failureCodes(compiled)).toEqual(["no_completed_action"]);
  });

  it("judges Domain Scope against the hosts the Steps visit", () => {
    const unobserved = compileAgentFlowDraft(
      {
        ...proposal,
        domainScope: {
          hosts: ["shop.example.com", "pay.example.net", "cdn.example.org"],
        },
      },
      demonstration
    );
    expect(failureCodes(unobserved)).toEqual(["unobserved_domain"]);

    const uncovered = compileAgentFlowDraft(
      { ...proposal, domainScope: { hosts: ["shop.example.com"] } },
      demonstration
    );
    expect(failureCodes(uncovered)).toEqual(["uncovered_host"]);

    const invalid = compileAgentFlowDraft(
      {
        ...proposal,
        domainScope: { hosts: ["https://shop.example.com", "pay.example.net"] },
      },
      demonstration
    );
    expect(failureCodes(invalid)).toEqual(["invalid_domain", "uncovered_host"]);

    // Exploration outside every span does not widen the scope.
    const narrowed = compileAgentFlowDraft(
      {
        ...proposal,
        domainScope: { hosts: ["shop.example.com"] },
        steps: [fillTheCart],
      },
      demonstration
    );
    expect(Result.isSuccess(narrowed)).toBe(true);

    const wildcard = compileAgentFlowDraft(
      {
        ...proposal,
        domainScope: { hosts: ["*.example.com", "pay.example.net"] },
      },
      demonstration
    );
    expect(Result.isSuccess(wildcard)).toBe(true);
  });

  it("refuses duplicate tags and Variables", () => {
    const compiled = compileAgentFlowDraft(
      {
        ...proposal,
        tags: ["shop", "Shop"],
        variables: [
          { name: "email", runtime: false, secret: false },
          { name: "email", runtime: true, secret: true },
        ],
      },
      demonstration
    );
    expect(failureCodes(compiled)).toEqual([
      "duplicate_tag",
      "duplicate_variable",
    ]);
  });

  it("requires every demonstrated private Variable in the draft", () => {
    const compiled = compileAgentFlowDraft(proposal, {
      ...demonstration,
      variables: [{ name: "PASSWORD", runtime: false, secret: true }],
    });
    expect(failureCodes(compiled)).toEqual(["missing_variable"]);
    expect(Result.isFailure(compiled) && compiled.failure[0]).toMatchObject({
      message:
        "The Demonstration uses Variable PASSWORD, but the draft does not declare it.",
      path: ["variables"],
    });

    const changed = compileAgentFlowDraft(
      {
        ...proposal,
        variables: [{ name: "PASSWORD", runtime: true, secret: false }],
      },
      {
        ...demonstration,
        variables: [{ name: "PASSWORD", runtime: false, secret: true }],
      }
    );
    expect(failureCodes(changed)).toEqual(["variable_mismatch"]);
  });
});

describe("Domain Scope entries", () => {
  it("accepts hostnames and one leading wildcard label", () => {
    expect(isDomainScopeEntry("shop.example.com")).toBe(true);
    expect(isDomainScopeEntry("*.example.com")).toBe(true);
    expect(isDomainScopeEntry("localhost")).toBe(true);
    expect(isDomainScopeEntry("*")).toBe(false);
    expect(isDomainScopeEntry("shop.*.com")).toBe(false);
    expect(isDomainScopeEntry("https://shop.example.com")).toBe(false);
    expect(isDomainScopeEntry("shop.example.com/cart")).toBe(false);
  });

  it("covers subdomains with a wildcard but not the apex", () => {
    expect(domainScopeCovers("*.example.com", "shop.example.com")).toBe(true);
    expect(domainScopeCovers("*.example.com", "a.b.example.com")).toBe(true);
    expect(domainScopeCovers("*.example.com", "example.com")).toBe(false);
    expect(domainScopeCovers("*.example.com", "evilexample.com")).toBe(false);
    expect(domainScopeCovers("example.com", "example.com")).toBe(true);
    expect(domainScopeCovers("example.com", "shop.example.com")).toBe(false);
  });

  it("lists the web hosts a Demonstration visited", () => {
    expect(observedHosts(demonstration)).toEqual([
      "pay.example.net",
      "shop.example.com",
    ]);
  });
});
