import assert from "node:assert/strict";

import { iosRpc } from "./ios-workspace-rpc.mjs";

const waitReply = async (page, before, tag = "ios.workspace.command") => {
  await page.waitForFunction(
    ([index, expected]) =>
      globalThis.__workspaceCommandReplies
        .slice(index)
        .some((reply) => reply.tag === expected),
    [before, tag],
    { timeout: 180_000 }
  );
  const replies = await page.evaluate(
    (index) => globalThis.__workspaceCommandReplies.slice(index),
    before
  );
  const reply = replies.find((entry) => entry.tag === tag);
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
/** Click a Workspace button; `region` scopes it, as each decision has its own Allow. */
export const clickIos = async (page, name, region) => {
  const before = await page.evaluate(
    () => globalThis.__workspaceCommandReplies.length
  );
  const scope =
    region === undefined
      ? page
      : page.getByRole("region", { exact: true, name: region });
  await scope.getByRole("button", { exact: true, name }).click();
  const clickedAt = new Date().toISOString();
  await waitReply(page, before);
  return { action: name, clickedAt };
};
/** Aim the real mouse from observation evidence; only Workspace resolves and sends input. */
export const pickIos = async (page, flags) => {
  const sessionId = flags["session-id"];
  assert.equal(new URL(page.url()).searchParams.get("ios"), sessionId);
  const display = page.locator('canvas[aria-label^="Live iOS viewport"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      'canvas[aria-label^="Live iOS viewport"]'
    );
    return canvas && canvas.width > 0 && canvas.height > 0;
  });
  // Aim only from the observation the display shows. Input such as typing can
  // settle into a newer observation after this one is read, so read again
  // until the display shows the one read.
  const readShown = async (attempts) => {
    const read = await iosRpc(page.url(), "ios.workspace.command", {
      command: { _tag: "observe", image: false, sessionId },
      source: "user",
    });
    const shown = await page
      .waitForFunction(
        (id) =>
          document.querySelector('canvas[aria-label^="Live iOS viewport"]')
            ?.dataset.observationId === id,
        read.observation?.id,
        { timeout: 5000 }
      )
      .then(
        () => true,
        () => false
      );
    if (shown || attempts <= 1) {
      return shown ? read : undefined;
    }
    return readShown(attempts - 1);
  };
  const observed = await readShown(6);
  assert.ok(observed, "The display never showed the observation read.");
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
  const box = await display.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const before = await page.evaluate(
    () => globalThis.__workspaceCommandReplies.length
  );
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
  // The click is Forwarded Input; its reply comes once the tap is sent.
  await waitReply(page, before, "ios.workspace.forward");
  return { fx, fy, name: flags.name, role: flags.role, sessionId };
};

/**
 * Drag across the display; the swipe is Forwarded Input sent to the simulator.
 * `up` scrolls content; `left` turns to the next Home Screen page.
 */
export const swipeIos = async (page, direction = "up") => {
  const canvas = page.locator('canvas[aria-label^="Live iOS viewport"]');
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 20 && box.height > 20);
  const before = await page.evaluate(
    () => globalThis.__workspaceCommandReplies.length
  );
  const [from, to] =
    direction === "left"
      ? [
          [0.85, 0.5],
          [0.15, 0.5],
        ]
      : [
          [0.5, 0.75],
          [0.5, 0.35],
        ];
  await page.mouse.move(
    box.x + box.width * from[0],
    box.y + box.height * from[1]
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {
    steps: 8,
  });
  await page.mouse.up();
  await waitReply(page, before, "ios.workspace.forward");
  return { inputSent: true };
};
