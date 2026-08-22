/**
 * Core Web Vitals travel as two page scripts.
 *
 * {@link VITALS_RECORDER} is registered before the first navigation — as a
 * Playwright init script on the Run's browser context, so every Page it opens
 * records its own metrics from the start and no page is ever measured by
 * asking it to do something again. {@link VITALS_COLLECTOR} is evaluated in
 * the page at the last moment the Run is on it, when paint and interaction
 * have had their chance to land.
 */

/** Where the page keeps what it has recorded, for the reader to collect. */
export const VITALS_GLOBAL = "__contingencyVitals";

/**
 * Interactions shorter than this are not reported as `event` entries at all,
 * which is the metric's own floor rather than a choice made here.
 */
const EVENT_DURATION_THRESHOLD_MS = 16;

/**
 * Registered as a context init script, so it runs before any page script. The
 * opening guard makes arming idempotent: re-running without the guard would
 * replace the state mid-page and lose every interaction already observed.
 */
export const VITALS_RECORDER = `window[${JSON.stringify(VITALS_GLOBAL)}] || (() => {
  const state = { firstInput: null, interactions: {}, lcp: null, shifts: [] };
  window[${JSON.stringify(VITALS_GLOBAL)}] = state;
  const observe = (type, handler, options) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { handler(entry); }
      });
      observer.observe(Object.assign({ buffered: true, type }, options || {}));
    } catch (cause) { /* the browser does not report this metric */ }
  };
  observe("largest-contentful-paint", (entry) => { state.lcp = entry.startTime; });
  observe("layout-shift", (entry) => {
    if (!entry.hadRecentInput) {
      state.shifts.push({ startTime: entry.startTime, value: entry.value });
    }
  });
  observe("event", (entry) => {
    if (!entry.interactionId) { return; }
    const worst = state.interactions[entry.interactionId] || 0;
    if (entry.duration > worst) { state.interactions[entry.interactionId] = entry.duration; }
  }, { durationThreshold: ${EVENT_DURATION_THRESHOLD_MS} });
  // An interaction faster than the threshold above produces no \`event\` entry,
  // so without this a very responsive page reports no INP and reads exactly
  // like a page nobody interacted with. \`first-input\` is reported whatever
  // its duration.
  observe("first-input", (entry) => {
    state.firstInput = { duration: entry.duration, startTime: entry.startTime };
  });
})();`;

/**
 * How long to wait for the page to paint at all before giving up on paint
 * metrics.
 *
 * A headless browser paints only when it has reason to, so a page can finish
 * navigating with no paint entry yet — verified against the previous runtime:
 * a Run that navigates and stops recorded no FCP and no LCP, while the same
 * page reported both as soon as anything forced a render. Waiting for the
 * paint rather than a fixed delay costs nothing on a page that has already
 * painted.
 */
const PAINT_DEADLINE_MS = 2000;

/** How often to look for the paint, while waiting for it. */
const PAINT_POLL_MS = 50;

/** Let the recorder's observers deliver what the page just did. */
const SETTLE_MS = 100;

/**
 * A CLS session window ends when a shift lands this long after the previous
 * one, per the metric's definition. Without it, two unrelated shifts a couple
 * of seconds apart are added together and the score is overstated.
 */
const CLS_GAP_MS = 1000;

/** A CLS session window also ends this long after its first shift. */
const CLS_WINDOW_MS = 5000;

/**
 * INP is the 98th percentile of interactions, which for the handful a Flow
 * performs is the worst one. Expressed as the web-vitals rule so a longer Flow
 * keeps reporting the same metric everyone else means by INP.
 */
const INP_PERCENTILE_DIVISOR = 50;

/**
 * One expression, evaluated in the page, resolving to the measurements as an
 * ordinary object that crosses back through `page.evaluate` structured.
 * Written as a single expression because that is what evaluate takes.
 */
export const VITALS_COLLECTOR = `(async () => {
  const state = window[${JSON.stringify(VITALS_GLOBAL)}];
  if (!state) {
    throw new Error("This page recorded no Core Web Vitals.");
  }
  const painted = () => performance.getEntriesByName("first-contentful-paint").length > 0;
  let waited = 0;
  while (!painted() && waited < ${PAINT_DEADLINE_MS}) {
    await new Promise((done) => setTimeout(done, ${PAINT_POLL_MS}));
    waited += ${PAINT_POLL_MS};
  }
  // Let the recorder's observers deliver what the page just did.
  await new Promise((done) => setTimeout(done, ${SETTLE_MS}));
  // The score is the worst session window, not the sum of every shift.
    let cls = 0;
    let windowValue = 0;
    let windowStart = 0;
    let previous = 0;
    for (const shift of state.shifts) {
      const continues = windowValue !== 0 &&
        shift.startTime - previous < ${CLS_GAP_MS} &&
        shift.startTime - windowStart < ${CLS_WINDOW_MS};
      if (!continues) { windowValue = 0; windowStart = shift.startTime; }
      windowValue += shift.value;
      previous = shift.startTime;
      if (windowValue > cls) { cls = windowValue; }
    }
    const durations = Object.keys(state.interactions)
      .map((id) => state.interactions[id])
      .sort((a, b) => b - a);
    let inp = null;
    if (durations.length > 0) {
      const rank = Math.min(Math.floor(durations.length / ${INP_PERCENTILE_DIVISOR}), durations.length - 1);
      inp = durations[rank];
    } else if (state.firstInput) {
      // Too fast to be reported as an interaction, but an interaction all the
      // same: reporting nothing would read as a page nobody touched.
      inp = state.firstInput.duration;
    }
    const navigation = performance.getEntriesByType("navigation")[0];
    const paint = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      cls: cls,
      fcp: paint ? paint.startTime : null,
      inp: inp,
      lcp: state.lcp,
      ttfb: navigation ? navigation.responseStart : null,
    };
})()`;
