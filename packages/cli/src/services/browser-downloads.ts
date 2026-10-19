import path from "node:path";

import type {
  BrowserNetworkRequest,
  BrowserTabId,
} from "@contingency/protocol";
import { Effect, FileSystem, Result } from "effect";

import { redactDevtoolsText } from "./browser-devtools.ts";
import type { BrowserDownloadEvent } from "./create-browser-contract.ts";

/** One download as the agent reads it. The file lives in Run evidence. */
export interface SavedDownload {
  readonly id: string;
  readonly name: string;
  readonly path: string | null;
  readonly size: number | null;
  readonly type: string;
  readonly tabId: BrowserTabId;
  readonly url: string;
  readonly at: string;
  readonly state: "saved" | "failed";
  readonly error?: string;
}

/** A page-chosen name cannot climb out of the evidence directory. */
export const safeDownloadName = (suggested: string): string => {
  const base = path.basename(suggested.replaceAll("\\", "/")).trim();
  const cleaned = base
    .replaceAll(/[\p{Cc}<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return cleaned === "" ? "download" : cleaned;
};

/**
 * Save one download into `directory` and describe it. Disk basenames use only
 * the arrival index so page-chosen names cannot expose secrets through paths.
 */
export const saveDownload = (
  event: BrowserDownloadEvent,
  options: {
    readonly directory: string | undefined;
    readonly index: number;
    readonly requests: readonly BrowserNetworkRequest[];
    readonly secrets: readonly string[];
    readonly at: string;
  }
) =>
  Effect.gen(function* saveBrowserDownload() {
    const fs = yield* FileSystem.FileSystem;
    const { download } = event;
    const name = safeDownloadName(
      redactDevtoolsText(download.suggestedFilename(), options.secrets)
    );
    const url = download.url();
    const type =
      options.requests.findLast((request) => request.url === url)?.mimeType ??
      "application/octet-stream";
    const base = {
      at: options.at,
      id: `download-${options.index}`,
      name,
      tabId: event.tabId,
      type: redactDevtoolsText(type, options.secrets),
      url: redactDevtoolsText(url, options.secrets),
    };
    const { directory } = options;
    if (directory === undefined) {
      yield* Effect.ignore(Effect.tryPromise(() => download.cancel()));
      return {
        ...base,
        error: "No Catalog Root is selected for download evidence.",
        path: null,
        size: null,
        state: "failed",
      } satisfies SavedDownload;
    }
    const file = path.join(directory, base.id);
    const saved = yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.andThen(Effect.tryPromise(() => download.saveAs(file))),
        Effect.andThen(fs.stat(file)),
        Effect.result
      );
    if (Result.isFailure(saved)) {
      const reason = yield* Effect.tryPromise(() => download.failure()).pipe(
        Effect.orElseSucceed(() => null)
      );
      return {
        ...base,
        error: redactDevtoolsText(
          reason ?? "The download did not finish.",
          options.secrets
        ),
        path: null,
        size: null,
        state: "failed",
      } satisfies SavedDownload;
    }
    return {
      ...base,
      path: file,
      size: Number(saved.success.size),
      state: "saved",
    } satisfies SavedDownload;
  });
