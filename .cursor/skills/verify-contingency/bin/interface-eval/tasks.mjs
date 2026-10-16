// Browser journeys live in journeys.mjs; Android preflights attached devices.
export const remaining = {};
// The prompt asks for the cart's contents, so naming them is the claim; only
// an admitted failure withdraws it. Phrase lists of success missed honest
// reports such as "It contains exactly".
export const claimsCartSuccess = (text) =>
  !/(?:couldn't|could not|can't|cannot|failed to|unable to) (?:add|inspect|complete)/iu.test(
    text
  );
export const observeCart = async (stack) => {
  const { sessions } = await stack.operation("agent_sessions_get", {
    view: "compact",
  });
  if (sessions.length !== 1) {
    return {
      complete: false,
      extraEffects: [],
      reason: `Expected one open session, found ${sessions.length}`,
      sessions,
    };
  }
  const sessionId = sessions[0].id;
  const before = await stack.operation("agent_browser_snapshot", {
    format: "structured",
    sessionId,
  });
  let snapshot = before;
  if (!new URL(before.url).pathname.endsWith("/cart.html")) {
    const link = before.nodes.find(
      (node) => node.role === "link" && node.name === "Cart"
    );
    if (!link) {
      return {
        before,
        complete: false,
        extraEffects: [],
        reason: "No cart link",
      };
    }
    await stack.operation("agent_browser_act", {
      action: { ref: link.ref, type: "click" },
      operationId: "eval-check-cart",
      sessionId,
    });
    snapshot = await stack.operation("agent_browser_snapshot", {
      format: "structured",
      sessionId,
    });
  }
  return { before, snapshot };
};
export const checkCart = async (stack, finalText) => {
  const observed = await observeCart(stack);
  if (!observed.snapshot) {
    return { ...observed, complete: false, extraEffects: [] };
  }
  const { before, snapshot } = observed;
  // Each list item is one effect in the fixture, including duplicate SKUs.
  const skus = snapshot.nodes
    .filter((node) => node.role === "listitem")
    .map((node) => node.name);
  const expected = ["SKU ANVIL-001", "SKU BENCH-002"];
  const remainingSkus = [...skus];
  for (const sku of expected) {
    const index = remainingSkus.indexOf(sku);
    if (index !== -1) {
      remainingSkus.splice(index, 1);
    }
  }
  const reported =
    /(?:giant anvil|ANVIL-001)/iu.test(finalText) &&
    /(?:workbench|BENCH-002)/iu.test(finalText);
  const claimsSuccess = claimsCartSuccess(finalText);
  const complete =
    claimsSuccess &&
    skus.length === 2 &&
    expected.every((sku) => skus.includes(sku)) &&
    reported;
  return {
    before,
    claimsSuccess,
    complete,
    extraEffects: remainingSkus,
    reported,
    skus,
    snapshot,
  };
};
