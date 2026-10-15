/* oxlint-disable eslint/no-await-in-loop -- Security probes run in order on one owned server. */
import assert from "node:assert/strict";

const digestFrame = async () => {
  const canvas = document.querySelector(
    'canvas[aria-label="Selected device live display"]'
  );
  if (!canvas || canvas.classList.contains("invisible")) {
    return null;
  }
  const pixels = canvas
    .getContext("2d")
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const hash = await crypto.subtle.digest("SHA-256", pixels);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

/** Read the actual viewer request; never persist its capability or screen pixels. */
export const checkAndroidStream = async (page, flags) => {
  const id = flags["session-id"];
  assert.match(id, /^agent-[\w-]+$/u);
  const { origin } = new URL(page.url());
  const route = `/android/stream/${id}`;
  let authorization;
  const capture = (request) => {
    if (request.url() === `${origin}${route}`) {
      ({ authorization } = request.headers());
    }
  };
  page.on("request", capture);
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (button) =>
            button.textContent === "Start recording" && !button.disabled
        ),
      undefined,
      { timeout: 60_000 }
    );
    await page.goto(`${origin}/?android=${encodeURIComponent(id)}`, {
      waitUntil: "load",
    });
    await page
      .getByRole("status")
      .filter({ hasText: "Live device display" })
      .waitFor({ timeout: 60_000 });
    assert.ok(authorization?.startsWith("Bearer "));
    const headers = { authorization, origin };
    const refused = {};
    for (const [name, path, options, expected] of [
      ["unauthenticated", route, { headers: { origin } }, 401],
      [
        "wrongCredential",
        route,
        { headers: { authorization: "Bearer invalid", origin } },
        401,
      ],
      ["differentSession", "/android/stream/agent-other", { headers }, 401],
      ["differentSerial", `${route}?device=other`, { headers }, 404],
      ["input", `${route}/api/input/tap`, { headers, method: "POST" }, 404],
      [
        "install",
        `${route}/api/apps/install`,
        { headers, method: "POST" },
        404,
      ],
      [
        "recording",
        `${route}/api/session/recording`,
        { headers, method: "POST" },
        404,
      ],
      [
        "replay",
        `${route}/api/session/replay`,
        { headers, method: "POST" },
        404,
      ],
      [
        "upgrade",
        route,
        {
          headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
        },
        404,
      ],
    ]) {
      const response = await page.request.fetch(`${origin}${path}`, options);
      refused[name] = response.status();
      assert.equal(response.status(), expected, name);
    }
    const previous = flags["previous-frame"];
    if (previous !== undefined) {
      assert.match(previous, /^[\da-f]{64}$/u);
      await page.waitForFunction(
        async (prior) => {
          const canvas = document.querySelector(
            'canvas[aria-label="Selected device live display"]'
          );
          if (!canvas || canvas.classList.contains("invisible")) {
            return false;
          }
          const pixels = canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height).data;
          const hash = await crypto.subtle.digest("SHA-256", pixels);
          return (
            Array.from(new Uint8Array(hash), (byte) =>
              byte.toString(16).padStart(2, "0")
            ).join("") !== prior
          );
        },
        previous,
        { timeout: 60_000 }
      );
    }
    return { frame: await page.evaluate(digestFrame), live: true, refused };
  } finally {
    page.off("request", capture);
  }
};
