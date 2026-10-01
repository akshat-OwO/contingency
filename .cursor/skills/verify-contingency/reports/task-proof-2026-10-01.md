# Task Run proof, 2026-10-01

The combined isolated drive completed its task, authority, input, Dry Run, cleanup, summary, and catalog discovery assertions against the source after #329 with the catalog response fix. The overall result is **passed**, with exit code 0 and no blockers. The first drive found [#330](https://github.com/akshat-OwO/contingency/issues/330): valid inputs without descriptions could not be returned over MCP. Catalog responses now omit absent descriptions, and the unchanged fixture declarations pass after restart. This completes the combined proof requested by #325.

Run the [combined task recipe](../features/workspace.md#combined-task-proof) to reproduce it. The maintained helper is `bin/task-proof.mjs`. It uses the production CLI, real Chromium, the isolated ecommerce site, MCP, and Workspace controls without mocks.

| Path | Observed result | Retained evidence under `artifacts/task-proof/` |
| --- | --- | --- |
| Startup without skills | Version 3 task, no Steps, coverage, or missing-input decisions | `zero-skill.*`, MCP start response |
| Partial flow1 followed by flow2 | Same session, Run, two tab IDs, cookie, localStorage, sessionStorage cart, and starting Emulation | `continuity-before.json`, `continuity-after.json`, `composed*` |
| Mid-Run redirection and recovery | Original task retained beside changed instruction; negative assessment and finding leave browser usable for later input and working assessment | Task update, finding, assessment, action responses; `persisted-task-summary.json` |
| Skill-scoped inputs | Separate area values and PASSWORD identities for both skills; refusal, retry, supply replay, and entry; UNUSED remains unsupplied | Input MCP responses, `flow1-pending.*`, `flow1-refused.*`, `scoped-supplied.*` |
| Domain and objective boundaries | Starting-host scope, later requested skill admits localhost, unrelated host and objective pause | Boundary MCP responses, `domain-paused.*` |
| Confirmation and priority Takeover | Agent action and allow refused under user control; observation works; confirmed attempt executes once and a new attempt pauses | `takeover.*`, `returned.*`, `confirmation*`, replay responses |
| Explicit task completion | Identical completion replay and persisted task record with finding, assessment, and video/Trace references | Completion responses, persisted reread, `task-summary.*` |
| User closure and process exit | Original closure outcomes retained without an invented assessment | `unassessed-closed.*`, `process-exit-summary.json` |
| Partial, failed, and Takeover Dry Runs | Failed lifecycle, retained Teaching artifacts, no Verify flow | `dry-outcomes.json`, three failed summary captures and retention rereads |
| Complete Dry Run and user choice | Complete report offers Verify and Reject; rejection retains evidence; verification authorizes cleanup | `dry-complete-summary.*`, `dry-rejected.*`, `dry-verification-390.*` |
| Interrupted cleanup | Verified purge-pending after a deliberate isolated filesystem failure; restart removes recording after permissions are restored | `cleanup-pending.json`, `cleanup-pending.*`, filesystem reread |
| Restarted task and historical summaries | Exact records reopen; local videos answer range requests with 206 and 1024 bytes | `task-reopened.*`, `historical-reopened.*`, corresponding video-response JSON |
| Catalog discovery after restart | Successful listing includes verified `dry-proof` with its bare input declaration | Numbered `agent_flow_skills_list` response; `result.json` has no blockers |

The historical report is an explicitly synthetic version 2 fixture, not a claim that an old production Run was recreated. It preserves a working Step assessment, a timed-out Step, an unexecuted Step, original ceilings, and incomplete coverage. Its video and Trace come from this isolated drive and stay inside isolated state. `open_run` returns the same record after restart.

`commands.json` records exact MCP parameters and Workspace commands. Numbered responses include stdout, stderr, and exit code. The helper checks responses, persisted rereads, and ARIA for both disposable secret literals. Screenshots show composition, intervention, verification, narrow layouts, and reopened summaries. Raw video and Trace are not copied into proof artifacts.

Validation: forced production build, repository quality checks, all package type checks, unit tests, and all five task-run integration tests passed. The MCP HTTP regression test failed with the original internal server error before the fix and passes for bare, mapping-without-description, and described inputs after it. A rerun without the required MCP process recorded `status:"failed"` and archived previous evidence. The final combined live proof recorded `status:"passed"` with no blockers. Cleanup removed the owned processes and isolated state while retaining these proof artifacts.
