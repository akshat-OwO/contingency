/**
 * Record Core Web Vitals from the moment each page starts, so the Runner can
 * read them later.
 *
 * Reading a page's metrics after the fact does not work. Verified against the
 * bundled binary: an observer registered after an interaction sees nothing for
 * it, while the same observer armed beforehand records the click with its
 * duration and interaction id. Layout shifts replay through `buffered: true`
 * but interactions do not reliably, so a genuinely responsive page reported no
 * INP at all — indistinguishable from a page nobody touched.
 *
 * The browser tool registers this before the first navigation and re-runs it on
 * every navigation after, so each document records its own metrics from the
 * start and no page is ever measured by asking it to do something again.
 *
 * The opening guard makes arming idempotent: a Run captured to video registers
 * this by evaluating it into each page it arrives at, because no init script
 * can reach a recording context (see {@link VITALS_COLLECTOR}'s sibling
 * arming path in the browser service). Re-running without the guard would
 * replace the state mid-page and lose every interaction already observed.
 */

/** Where the page keeps what it has recorded, for the reader to collect. */
export const VITALS_GLOBAL = "__contingencyVitals";

/**
 * Interactions shorter than this are not reported as `event` entries at all,
 * which is the metric's own floor rather than a choice made here.
 */
const EVENT_DURATION_THRESHOLD_MS = 16;

/** Registered as a page init script, so it runs before any page script. */
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
