// Lighthouse's own 45s load wait raced our 45s guard (#589). Lighthouse gives up
// on load at LIGHTHOUSE_LOAD_WAIT_MS and returns a partial result, leaving
// LIGHTHOUSE_PROCESSING_ALLOWANCE_MS for traces and audits inside the guard.
// The FCP wait must outlast the load wait plus Lighthouse's mandatory 5.25s
// post-FCP pause, so a page that has painted is never failed with NO_FCP.
export const SCAN_GUARD_MS = 45_000;
export const LIGHTHOUSE_LOAD_WAIT_MS = 20_000;
export const LIGHTHOUSE_FCP_WAIT_MS = 30_000;
export const LIGHTHOUSE_PROCESSING_ALLOWANCE_MS = 20_000;
export const SCAN_RELOAD_COMMIT_WAIT_MS = 20_000;
