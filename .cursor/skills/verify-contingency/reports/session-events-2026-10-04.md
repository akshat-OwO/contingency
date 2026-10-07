# Session Events proof, 2026-10-04

The isolated production Workspace and real MCP client completed Teaching, Flow Skill learning, a fresh passing Dry Run, and Workspace Verify. A separate Interactive Run proved Takeover and return. Each user action had a cursor wait pending. Replaying its starting cursor preserved the returned events; verification replay also included the later Cleanup event.

| Workspace event        | Event timestamp to client receipt |
| ---------------------- | --------------------------------- |
| `variable-supplied`    | 16 ms                             |
| `teaching-started`     | 26 ms                             |
| `instruction-recorded` | 14 ms                             |
| `teaching-stopped`     | 11 ms                             |
| `flow-skill-verified`  | 16 ms                             |
| `takeover-started`     | 15 ms                             |
| `takeover-returned`    | 21 ms                             |

These times use the event timestamp, rather than an external click timestamp. The verification reference persisted, and a second catalog read confirmed that Cleanup removed the Teaching Recording. `control-contingency cleanup` stopped the isolated processes; `doctor` then reported no instance.

The command journal recorded 50 MCP calls and 67,953 response bytes, including a failed first Dry Run and intentional replay checks. `agent_session_get` returned 30,672 bytes over 26 calls, averaging 1180 bytes. The published [ADR 0045 task proof](./mcp-efficiency-2026-10-01.md) averaged 4,504 bytes per session get. This run averaged 73.8% fewer bytes. The scenarios differ, so this comparison measures response size rather than task success or token use.

Artifacts remain under `artifacts/session-events/`: each MCP call, event response and replay assertion, `metrics.json`, `catalog-reread.json`, and `result.json`. The [Session Events recipe](../features/workspace.md#session-events) reproduces the drive.

Capture limitation: collaborative Preview navigation, clicks, typing, and evaluation worked, but repeated `preview_snapshot` attempts failed with a generic automation error. Full Workspace screenshot and ARIA proof remain unverified. `teaching-canvas.jpg` and `verify-dom.txt` retain the available canvas and DOM evidence.

Validation: production CLI and embedded Workspace build, repository quality checks, all package type checks, 68 focused unit tests, and the transport, onboarding, setup Variables, Dry Run prerequisites, Teaching learning, and task Run integration suites passed.
