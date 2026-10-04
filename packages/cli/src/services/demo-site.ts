import type { DemoSiteId, TaskAgentRunState } from "@contingency/protocol";
import { Context } from "effect";

/**
 * Ridgeline Hardware, the demo store bundled for onboarding (ADR 0050).
 *
 * The store is served under its own loopback hostname so Domain Scope, which
 * compares hostnames rather than ports, keeps demo authority apart from every
 * other local application, including this process's Workspace. Each process
 * binds an available port, and saved demo work resolves the current origin
 * rather than a port a previous launch held. All store state lives in browser
 * storage, so a fresh browser context is a clean store and a deliberate fault
 * never leaves the context that switched it on.
 */

export const DEMO_SITE_ID: DemoSiteId = "ridgeline";
export const DEMO_SITE_NAME = "Ridgeline Hardware";
export const DEMO_HOST = "ridgeline.localhost";

/** Whether a Flow Skill's taught hosts all belong to the demo store. */
export const isDemoHosts = (hosts: readonly string[]): boolean =>
  hosts.length > 0 && hosts.every((host) => host === DEMO_HOST);

export interface DemoSiteService {
  /** `http://ridgeline.localhost:<port>`, for the port this process acquired. */
  readonly origin: string;
}

export const DemoSite = Context.Service<DemoSiteService>(
  "@contingency/DemoSite"
);

/**
 * Label a Run as demo work when its Domain Scope is the demo store, so demo
 * evidence in the user's catalog never reads as a real website's.
 */
export const markDemoWork = (
  hosts: readonly string[],
  run: TaskAgentRunState
): TaskAgentRunState =>
  isDemoHosts(hosts) ? { ...run, demoSite: DEMO_SITE_ID } : run;
