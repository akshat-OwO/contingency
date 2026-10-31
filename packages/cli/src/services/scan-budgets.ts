// Lighthouse's 45s default races our guard; allow 20s for load and 20s for trace processing and audits.
export const SCAN_GUARD_MS = 45_000;
export const LIGHTHOUSE_LOAD_WAIT_MS = 20_000;
export const LIGHTHOUSE_FCP_WAIT_MS = 15_000;
export const LIGHTHOUSE_PROCESSING_ALLOWANCE_MS = 20_000;
export const SCAN_RELOAD_COMMIT_WAIT_MS = 20_000;
