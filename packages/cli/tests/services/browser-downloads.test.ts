import { writeFile } from "node:fs/promises";
import path from "node:path";

import { BrowserRequestId, BrowserTabId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import type { Download } from "playwright-core";
import { vi } from "vitest";

import { saveDownload } from "../../src/services/browser-downloads.ts";

const secret = "synthetic-download-token";
const url = `https://example.test/${secret}`;
const tabId = BrowserTabId.make("tab");
const contents = "downloaded bytes";
const options = {
  at: "2026-10-18T00:00:00.000Z",
  index: 1,
  requests: [
    {
      headers: {},
      method: "GET",
      mimeType: `application/${secret}`,
      requestId: BrowserRequestId.make("request"),
      resourceType: "document",
      tabId,
      timestamp: 0,
      url,
    },
  ],
  secrets: [secret],
};

const makeDownload = () =>
  ({
    cancel: vi.fn<Download["cancel"]>(() => Promise.resolve()),
    createReadStream: vi.fn<Download["createReadStream"]>(),
    delete: vi.fn<Download["delete"]>(),
    failure: vi.fn<Download["failure"]>(),
    page: vi.fn<Download["page"]>(),
    path: vi.fn<Download["path"]>(),
    saveAs: vi.fn<Download["saveAs"]>((file) => writeFile(file, contents)),
    suggestedFilename: () => `report-${secret}.csv`,
    url: () => url,
  }) satisfies Download;

it.effect("saves to an opaque, usable path and redacts returned metadata", () =>
  Effect.gen(function* savedDownloadProjection() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-download-test-",
    });
    const directory = path.join(root, "downloads");
    const download = makeDownload();
    const event = { download, startedAt: 0, tabId };
    const saved = yield* saveDownload(event, { ...options, directory });

    expect(saved.state).toBe("saved");
    expect(saved.path).not.toBeNull();
    const file = saved.path ?? "";
    expect(file).not.toContain(secret);
    expect(path.dirname(file)).toBe(directory);
    expect(download.saveAs).toHaveBeenCalledWith(file);
    expect(yield* fs.readFileString(file)).toBe(contents);
    expect(saved.size).toBe(Buffer.byteLength(contents));
    expect(saved.name).toBe("report-[sensitive input].csv");
    expect(saved.type).toBe("application/[sensitive input]");
    expect(saved.url).toBe("https://example.test/[sensitive input]");
    expect(JSON.stringify(saved)).not.toContain(secret);

    const second = yield* saveDownload(event, {
      ...options,
      directory,
      index: 2,
    });
    expect(second.state).toBe("saved");
    expect(second.path).not.toBe(file);
    expect(yield* fs.readFileString(second.path ?? "")).toBe(contents);
    expect(yield* fs.readDirectory(directory)).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("redacts download failures and their metadata", () =>
  Effect.gen(function* failedDownloadProjection() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "contingency-download-test-",
    });
    const download = makeDownload();
    download.saveAs.mockRejectedValue(new Error("Synthetic save failure"));
    download.failure.mockResolvedValue(`Server rejected ${secret}`);

    const saved = yield* saveDownload(
      { download, startedAt: 0, tabId },
      { ...options, directory }
    );

    expect(saved.state).toBe("failed");
    expect(saved.path).toBeNull();
    expect(saved.size).toBeNull();
    expect(saved).toHaveProperty("error", "Server rejected [sensitive input]");
    expect(saved.type).toBe("application/[sensitive input]");
    expect(JSON.stringify(saved)).not.toContain(secret);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "redacts names before filename sanitization changes secret values",
  () =>
    Effect.gen(function* sanitizedDownloadName() {
      const download = makeDownload();
      download.suggestedFilename = () => "report-private:token.csv";
      const saved = yield* saveDownload(
        { download, startedAt: 0, tabId },
        { ...options, directory: undefined, secrets: ["private:token"] }
      );

      expect(saved.name).toBe("report-[sensitive input].csv");
      expect(download.cancel).toHaveBeenCalledOnce();
      expect(saved.state).toBe("failed");
      expect(saved.path).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer))
);
