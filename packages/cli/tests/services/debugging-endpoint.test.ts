import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readDebuggingEndpoint } from "../../src/services/debugging-endpoint.ts";

const ROUTE = "/devtools/browser/0b7f6c2e-5d1a-4f3e-9c8b-1a2b3c4d5e6f";

describe("readDebuggingEndpoint", () => {
  let directory = "";
  let file = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "contingency-endpoint-"));
    file = path.join(directory, "DevToolsActivePort");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("reads a published endpoint", async () => {
    await writeFile(file, `9222\n${ROUTE}`);
    await expect(readDebuggingEndpoint(file)).resolves.toBe(
      `ws://127.0.0.1:9222${ROUTE}`
    );
  });

  it("waits for a file Chromium writes after launch", async () => {
    const endpoint = readDebuggingEndpoint(file);
    await delay(100);
    await writeFile(file, `9222\n${ROUTE}\n`);
    await expect(endpoint).resolves.toBe(`ws://127.0.0.1:9222${ROUTE}`);
  });

  it("waits for a partly written file to complete", async () => {
    await writeFile(file, "9222\n/devtools/");
    const endpoint = readDebuggingEndpoint(file);
    await delay(100);
    await writeFile(file, `9222\n${ROUTE}`);
    await expect(endpoint).resolves.toBe(`ws://127.0.0.1:9222${ROUTE}`);
  });

  it("waits for a browser id cut off mid-write", async () => {
    await writeFile(file, `9222\n${ROUTE.slice(0, -8)}`);
    const endpoint = readDebuggingEndpoint(file);
    await delay(100);
    await writeFile(file, `9222\n${ROUTE}`);
    await expect(endpoint).resolves.toBe(`ws://127.0.0.1:9222${ROUTE}`);
  });

  it("fails at once on a browser id that is not a UUID", async () => {
    await writeFile(file, "9222\n/devtools/browser/not-a-uuid");
    await expect(readDebuggingEndpoint(file)).rejects.toThrow(
      "Chromium published an invalid debugging endpoint."
    );
  });

  it("fails at once on contents that can never be an endpoint", async () => {
    await writeFile(file, "not-a-port\n/elsewhere");
    const started = Date.now();
    await expect(readDebuggingEndpoint(file)).rejects.toThrow(
      "Chromium published an invalid debugging endpoint."
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("reports a file that never appears", async () => {
    await expect(readDebuggingEndpoint(file, 100)).rejects.toThrow(
      "Chromium did not publish its debugging endpoint."
    );
  });

  it("reports a file that never completes", async () => {
    await writeFile(file, "9222\n");
    await expect(readDebuggingEndpoint(file, 100)).rejects.toThrow(
      "Chromium published an incomplete debugging endpoint."
    );
  });
});
