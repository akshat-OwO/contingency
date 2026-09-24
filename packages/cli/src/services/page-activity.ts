import type { Page, Request } from "playwright-core";

/**
 * A request still open after this long is a long-lived connection, such as a
 * long poll, rather than the Page loading. Counting it would keep every later
 * read waiting out its bound for a Page that has finished.
 */
const LONG_LIVED_REQUEST_MS = 10_000;

/** Streams the Page holds open on purpose; none of them is the Page loading. */
const STREAMING_RESOURCES = new Set(["eventsource", "websocket"]);

interface PageNetwork {
  /** Requests the Page is still waiting on, with when each started. */
  readonly inFlight: Map<Request, number>;
  /** When a request last started or finished. */
  lastChangeAt: number;
}

const networks = new WeakMap<Page, PageNetwork>();

/**
 * Follow the requests a Page has open. Idempotent, and attached when the Page
 * is created, so a request an action starts is always in view.
 */
export const trackPageNetwork = (page: Page): PageNetwork => {
  const existing = networks.get(page);
  if (existing !== undefined) {
    return existing;
  }
  const network: PageNetwork = { inFlight: new Map(), lastChangeAt: 0 };
  networks.set(page, network);
  const finish = (request: Request): void => {
    if (network.inFlight.delete(request)) {
      network.lastChangeAt = Date.now();
    }
  };
  page.on("request", (request: Request) => {
    if (STREAMING_RESOURCES.has(request.resourceType())) {
      return;
    }
    const at = Date.now();
    network.inFlight.set(request, at);
    network.lastChangeAt = at;
  });
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  return network;
};

/**
 * How long the Page's network has been quiet, measured from no earlier than
 * `since`, or zero while a request the Page is loading is still open.
 */
export const networkQuietFor = (page: Page, since: number): number => {
  const network = trackPageNetwork(page);
  const at = Date.now();
  for (const [request, startedAt] of network.inFlight) {
    if (at - startedAt < LONG_LIVED_REQUEST_MS) {
      return 0;
    }
    // Past the bound it is a connection, not loading; stop counting it.
    network.inFlight.delete(request);
  }
  return at - Math.max(network.lastChangeAt, since);
};
