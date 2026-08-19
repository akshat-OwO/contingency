/**
 * Collect Core Web Vitals from the page the Flow already loaded.
 *
 * The browser tool ships a `vitals` command, and ADR 0008 chose it on the
 * understanding that it measures in place. It does not: verified against the
 * bundled binary, it reloads the page — `navigationType` goes from `navigate`
 * to `reload`, and everything the Flow built up in the page is gone. On a page
 * reached by clicking through a funnel that measures a load no user performed,
 * and it discards the state that made the page reachable.
 *
 * So the metrics are read from the timeline of the navigation the Flow itself
 * performed, at the last moment the Run is on that page — which is also the
 * only point where the page has an INP to report, since a navigation nobody
 * has interacted with yet never does. LCP, CLS, and INP are not kept in the main performance timeline —
 * verified: `getEntriesByType` returns nothing for them — so each is read
 * through a buffered `PerformanceObserver`, which replays what the page already
 * recorded rather than asking it to happen again.
 */

/**
 * How long to let the buffered observers deliver once the page has painted.
 *
 * This waits only for delivery of what the page already recorded, not for
 * anything further to happen: the Runner reads the timeline at the last moment
 * it is on the page, so the history is complete before this runs. Verified
 * against the bundled binary — a shift 250ms into the load is replayed in full
 * through a 100ms window when read afterwards.
 */
const SETTLE_MS = 100;

/**
 * How long to wait for the page to paint at all before giving up on paint
 * metrics.
 *
 * A headless browser paints only when it has reason to, so a page can finish
 * navigating with no paint entry yet — verified against the bundled binary: a
 * Run that navigates and stops recorded no FCP and no LCP, while the same page
 * reported both as soon as anything forced a render. Waiting for the paint
 * rather than a fixed delay costs nothing on a page that has already painted.
 */
const PAINT_DEADLINE_MS = 2000;

/** How often to look for the paint, while waiting for it. */
const PAINT_POLL_MS = 50;

/**
 * A CLS session window closes after this long, per the metric's definition.
 * The score is the worst window, not the sum of every shift.
 */
const CLS_WINDOW_MS = 5000;

/**
 * INP is the 98th percentile of interactions, which for the handful a Flow
 * performs is the worst one. Expressed as the web-vitals rule so a longer Flow
 * keeps reporting the same metric everyone else means by INP.
 */
const INP_PERCENTILE_DIVISOR = 50;

/** Ignore interactions too brief to matter, matching the metric's own floor. */
const EVENT_DURATION_THRESHOLD_MS = 16;

/**
 * One expression, evaluated in the page, resolving to the measurements as
 * JSON. Written as a single expression because that is what `eval` takes.
 */
export const VITALS_COLLECTOR = `new Promise((resolve) => {
  const shifts = [];
  const interactions = new Map();
  let lcp = null;
  const observe = (type, handler, options) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { handler(entry); }
      });
      observer.observe(Object.assign({ buffered: true, type }, options || {}));
    } catch (cause) { /* the browser does not report this metric */ }
  };
  observe("largest-contentful-paint", (entry) => { lcp = entry.startTime; });
  observe("layout-shift", (entry) => {
    if (!entry.hadRecentInput) { shifts.push(entry); }
  });
  observe("event", (entry) => {
    if (!entry.interactionId) { return; }
    const worst = interactions.get(entry.interactionId) || 0;
    if (entry.duration > worst) { interactions.set(entry.interactionId, entry.duration); }
  }, { durationThreshold: ${EVENT_DURATION_THRESHOLD_MS} });
  const painted = () => performance.getEntriesByName("first-contentful-paint").length > 0;
  const deadline = performance.now() + ${PAINT_DEADLINE_MS};
  const whenPainted = (proceed) => {
    if (painted() || performance.now() > deadline) { proceed(); return; }
    setTimeout(() => whenPainted(proceed), ${PAINT_POLL_MS});
  };
  whenPainted(() => setTimeout(() => {
    let cls = 0;
    let windowStart = 0;
    let windowValue = 0;
    for (const shift of shifts) {
      if (windowValue !== 0 && shift.startTime - windowStart > ${CLS_WINDOW_MS}) { windowValue = 0; }
      if (windowValue === 0) { windowStart = shift.startTime; }
      windowValue += shift.value;
      if (windowValue > cls) { cls = windowValue; }
    }
    let inp = null;
    const durations = Array.from(interactions.values()).sort((a, b) => b - a);
    if (durations.length > 0) {
      const rank = Math.min(Math.floor(durations.length / ${INP_PERCENTILE_DIVISOR}), durations.length - 1);
      inp = durations[rank];
    }
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    resolve(JSON.stringify({
      cls: cls,
      fcp: paint ? paint.startTime : null,
      inp: inp,
      lcp: lcp,
      ttfb: navigation ? navigation.responseStart : null,
    }));
  }, ${SETTLE_MS}));
})`;
