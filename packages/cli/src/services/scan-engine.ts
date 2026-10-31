import type { ScanMode } from "@contingency/protocol";
import axe from "axe-core";
import { Effect, Schema } from "effect";
import { startFlow } from "lighthouse";
import type { CliFlags, Flags } from "lighthouse";
import type { Page } from "playwright-core";
import { connect } from "puppeteer-core";

import {
  LIGHTHOUSE_FCP_WAIT_MS,
  LIGHTHOUSE_LOAD_WAIT_MS,
  SCAN_RELOAD_COMMIT_WAIT_MS,
} from "./scan-budgets.ts";

export type ScanEngineReport =
  | Awaited<
      ReturnType<Awaited<ReturnType<typeof startFlow>>["createFlowResult"]>
    >
  | {
      readonly engine: "axe-core";
      readonly engineVersion: string;
      readonly coverage: string;
      readonly results: {
        readonly violations: readonly unknown[];
        readonly incomplete: readonly unknown[];
      };
    };

export type ScanPhase =
  | "scanner setup"
  | "accessibility audit"
  | "Lighthouse instrumentation"
  | "navigation/load"
  | "Lighthouse navigation/load and trace collection"
  | "Lighthouse trace collection"
  | "Lighthouse audit/trace processing";

export interface ScanCollection {
  readonly phase?: () => ScanPhase;
  readonly finish: () => Promise<{
    readonly report: ScanEngineReport;
    readonly summary: string;
    readonly status?: "failed";
  }>;
  readonly cancel: () => Promise<void>;
}

/** Attach to the exact Run target, never navigate a new browser or copy its storage. */
const connectTarget = async (page: Page, browserWSEndpoint: string) => {
  const owner = page.context().browser();
  if (owner === null) {
    throw new Error("Performance scans require the owned Chromium browser.");
  }
  const pageSession = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const browser = await connect({
      browserWSEndpoint,
      defaultViewport: null,
    });
    try {
      const pages = await browser.pages();
      const candidates = await Promise.all(
        pages.map(async (candidate) => {
          const session = await candidate.createCDPSession();
          try {
            const info = await session.send("Target.getTargetInfo");
            return { candidate, id: info.targetInfo.targetId };
          } finally {
            await session.detach();
          }
        })
      );
      const matched = candidates.find(
        (candidate) => candidate.id === targetInfo.targetId
      );
      if (matched !== undefined) {
        return { browser, page: matched.candidate };
      }
      throw new Error("The measured Run tab is no longer available.");
    } catch (error) {
      await browser.disconnect();
      throw error;
    }
  } finally {
    await pageSession.detach();
  }
};

export const beginScanCollection = async (
  page: Page,
  mode: ScanMode,
  signal: AbortSignal,
  performanceEndpoint?: string,
  onPhase?: (phase: ScanPhase) => void
): Promise<ScanCollection> => {
  let phase: ScanPhase = "scanner setup";
  const setPhase = (next: ScanPhase) => {
    phase = next;
    onPhase?.(next);
  };
  if (mode === "accessibility") {
    // Evaluate in an isolated CDP world so page scripts cannot replace axe or its result.
    const session = await page.context().newCDPSession(page);
    const cancel = () => {
      Effect.runFork(
        Effect.promise(() => session.detach()).pipe(Effect.ignore)
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const { frameTree } = await session.send("Page.getFrameTree");
      const { executionContextId } = await session.send(
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: "contingency-axe" }
      );
      const injected = await session.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: axe.source,
      });
      if (injected.exceptionDetails !== undefined) {
        throw new Error("Could not initialize axe in this page.");
      }
      return {
        cancel: () => {
          signal.removeEventListener("abort", cancel);
          return session.detach();
        },
        finish: async () => {
          setPhase("accessibility audit");
          const response = await session.send("Runtime.evaluate", {
            awaitPromise: true,
            contextId: executionContextId,
            expression: `axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']}})`,
            returnByValue: true,
          });
          if (response.exceptionDetails !== undefined) {
            throw new Error("axe could not finish scanning this page.");
          }
          const results = Schema.decodeUnknownSync(
            Schema.StructWithRest(
              Schema.Struct({
                incomplete: Schema.Array(Schema.Unknown),
                violations: Schema.Array(Schema.Unknown),
              }),
              [Schema.Record(Schema.String, Schema.Unknown)]
            )
          )(response.result.value);
          return {
            report: {
              coverage:
                "Whole top-level document. Cross-origin frames and closed shadow roots may be inaccessible; incomplete results require human review.",
              engine: "axe-core",
              engineVersion: axe.version,
              results,
            },
            summary: `${results.violations.length} rule violations; ${results.incomplete.length} rules need review. Frame and closed-shadow coverage may be incomplete.`,
          };
        },
        phase: () => phase,
      };
    } catch (error) {
      await session.detach();
      throw error;
    }
  }
  if (performanceEndpoint === undefined) {
    throw new Error("Performance scans require the owned Chromium endpoint.");
  }
  const target = await connectTarget(page, performanceEndpoint);
  const disconnect = () => {
    void target.browser.disconnect();
  };
  signal.addEventListener("abort", disconnect, { once: true });
  try {
    signal.throwIfAborted();
    const mobile = await page.evaluate(() =>
      /Mobile|Android/u.test(navigator.userAgent)
    );
    // Lighthouse types error reporting on CliFlags, though its delegate reads
    // the same flags object. Keep reporting explicitly disabled in this host.
    const flags: Flags & Pick<CliFlags, "enableErrorReporting"> = {
      disableStorageReset: true,
      emulatedUserAgent: false,
      enableErrorReporting: false,
      formFactor: mobile ? "mobile" : "desktop",
      locale: "en-US",
      logLevel: "silent",
      maxWaitForFcp: LIGHTHOUSE_FCP_WAIT_MS,
      maxWaitForLoad: LIGHTHOUSE_LOAD_WAIT_MS,
      onlyCategories: ["performance"],
      screenEmulation: { disabled: true },
      throttlingMethod: "provided",
    };
    const flow = await startFlow(target.page, {
      flags,
      name: "Contingency agent-driven scan",
    });
    const cancel = () => {
      flow.dispose();
      void target.browser.disconnect();
    };
    signal.addEventListener("abort", cancel, { once: true });
    signal.throwIfAborted();
    setPhase("Lighthouse instrumentation");
    if (mode === "timespan") {
      await flow.startTimespan();
    } else {
      await flow.startNavigation();
      if (mode === "reload") {
        setPhase("navigation/load");
        await page.reload({
          timeout: SCAN_RELOAD_COMMIT_WAIT_MS,
          waitUntil: "commit",
        });
      }
    }
    return {
      cancel: async () => {
        signal.removeEventListener("abort", cancel);
        signal.removeEventListener("abort", disconnect);
        flow.dispose();
        await target.browser.disconnect();
      },
      finish: async () => {
        setPhase(
          mode === "timespan"
            ? "Lighthouse trace collection"
            : "Lighthouse navigation/load and trace collection"
        );
        await (mode === "timespan" ? flow.endTimespan() : flow.endNavigation());
        setPhase("Lighthouse audit/trace processing");
        const report = await flow.createFlowResult();
        const lhr = report.steps[0]?.lhr;
        const warnings = (lhr?.runWarnings ?? []).join(" ");
        if (lhr?.runtimeError !== undefined) {
          return {
            report,
            status: "failed",
            summary:
              `Lighthouse runtime error ${lhr.runtimeError.code}: ${lhr.runtimeError.message} ${warnings}`.trim(),
          };
        }
        const score = lhr?.categories.performance?.score;
        return {
          report,
          summary: `${
            score === null || score === undefined
              ? "Performance metrics collected. This mode has no aggregate score."
              : `Performance score ${Math.round(score * 100)}. Measured with the Run's settings and no extra throttling.`
          } ${warnings}`.trim(),
        };
      },
      phase: () => phase,
    };
  } catch (error) {
    signal.removeEventListener("abort", disconnect);
    await target.browser.disconnect();
    throw error;
  }
};
