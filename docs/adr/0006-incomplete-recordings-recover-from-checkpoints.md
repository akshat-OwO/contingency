# Incomplete Recordings recover from capture-connection checkpoints

An incomplete Recording remains blocked from Finish and download. Reload & Resume is available only when capture stopped because the recorder connection or sidecar was lost, and the pinned browser session and tab still exist. Recovery switches back to the pinned tab, reloads it, restarts the CLI-owned capture sidecar, and appends a navigation checkpoint before returning the Recording to active; actions performed after capture integrity was lost are never retained.

Integrity failures stay terminal. Those include an unsupported additional tab or popup, navigation while paused, a closed pinned session, an unaddressable selector, event-limit or sequence overflow, and malformed page-derived recorder data.

## Consequences

- Fail-closed detection remains authoritative: an interruption is never silently ignored or treated as continuous capture.
- Connection loss can be resumed without pretending the missing interval was recorded.
- The resulting Flow makes a recovered discontinuity replayable through an ordinary navigation Step instead of hiding browser state drift.
- Recovery cannot migrate a Recording to another session or tab, and cannot make a multi-tab, popup, or other integrity-failed Recording downloadable. If the pinned target no longer exists, the author must discard the Recording.
