import assert from "node:assert/strict";

import { iosRpc } from "./ios-workspace-rpc.mjs";

const waitReply = async (page, before) => {
  await page.waitForFunction(
    (index) =>
      globalThis.__workspaceCommandReplies
        .slice(index)
        .some((reply) => reply.tag === "ios.workspace.command"),
    before,
    { timeout: 180_000 }
  );
  const replies = await page.evaluate(
    (index) => globalThis.__workspaceCommandReplies.slice(index),
    before
  );
  const reply = replies.find((entry) => entry.tag === "ios.workspace.command");
  assert.equal(
    reply?.success,
    true,
    `Workspace command refused; inspect the captured UI. ${reply?.cause ?? ""}`
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('main[aria-label="iOS Workspace"]')
        ?.getAttribute("aria-busy") === "false"
  );
};
export const clickIos = async (page, name) => {
  const before = await page.evaluate(
    () => globalThis.__workspaceCommandReplies.length
  );
  await page.getByRole("button", { exact: true, name }).click();
  const clickedAt = new Date().toISOString();
  await waitReply(page, before);
  return { action: name, clickedAt };
};
/** Aim the real mouse from observation evidence; only Workspace resolves and sends input. */
export const pickIos = async (page, flags) => {
  const sessionId = flags["session-id"];
  assert.equal(new URL(page.url()).searchParams.get("ios"), sessionId);
  const observed = await iosRpc(page.url(), "ios.workspace.command", {
    command: { _tag: "observe", image: false, sessionId },
    source: "user",
  });
  const nodes =
    observed.observation?.nodes.filter(
      (node) =>
        node.name === flags.name &&
        node.role === flags.role &&
        node.bounds &&
        !node.covered
    ) ?? [];
  assert.equal(nodes.length, 1, "Choose one visible semantic iOS element.");
  const [{ bounds }] = nodes;
  const fx = (bounds.x + bounds.width / 2) / observed.observation.width;
  const fy = (bounds.y + bounds.height / 2) / observed.observation.height;
  const display = page.locator('canvas[aria-label="Live iOS viewport"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      'canvas[aria-label="Live iOS viewport"]'
    );
    return canvas && canvas.width > 0 && canvas.height > 0;
  });
  await page.waitForFunction(
    (id) =>
      document.querySelector('canvas[aria-label="Live iOS viewport"]')?.dataset
        .observationId === id,
    observed.observation.id
  );
  const box = await display.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const before = await page.evaluate(
    () => globalThis.__workspaceCommandReplies.length
  );
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  await waitReply(page, before);
  return { fx, fy, name: flags.name, role: flags.role, sessionId };
};

export const swipeIos = async (page) => {
  const canvas = page.getByRole("img", { name: "Live iOS viewport" });
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 20 && box.height > 20);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "iOS swipes, including edge swipes, are unsupported. No input was sent.",
    })
    .waitFor();
  return { inputSent: false, refused: "capability_missing" };
};
