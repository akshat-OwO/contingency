import { VITALS_GLOBAL } from "./vitals-recorder";

/**
 * Read the Core Web Vitals the page has recorded for the navigation the Flow
 * itself performed.
 *
 * The browser tool ships a `vitals` command, and ADR 0008 chose it on the
 * understanding that it measures in place. It does not: verified against the
 * bundled binary, it reloads the page — `navigationType` goes from `navigate`
 * to `reload`, and everything the Flow built up in the page is gone. On a page
 * reached by clicking through a funnel that measures a load no user performed,
 * and it discards the state that made the page reachable.
 *
 * So the numbers come from what the page recorded itself, through the
 * companion init script, which the Runner reads at the last moment it is on
 * that page — also the only point where the page has an INP to report, since a
 * navigation nobody has interacted with yet never does.
 */

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
 * One expression, evaluated in the page, resolving to the measurements as
 * JSON. Written as a single expression because that is what `eval` takes.
 */
export const VITALS_COLLECTOR = `new Promise((resolve, reject) => {
  const state = window[${JSON.stringify(VITALS_GLOBAL)}];
  if (!state) {
    reject(new Error("This page recorded no Core Web Vitals."));
    return;
  }
  const painted = () => performance.getEntriesByName("first-contentful-paint").length > 0;
  const deadline = performance.now() + ${PAINT_DEADLINE_MS};
  const whenPainted = (proceed) => {
    if (painted() || performance.now() > deadline) { proceed(); return; }
    setTimeout(() => whenPainted(proceed), ${PAINT_POLL_MS});
  };
  whenPainted(() => setTimeout(() => {
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
    resolve(JSON.stringify({
      cls: cls,
      fcp: paint ? paint.startTime : null,
      inp: inp,
      lcp: state.lcp,
      ttfb: navigation ? navigation.responseStart : null,
    }));
  }, ${SETTLE_MS}));
})`;
