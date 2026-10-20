# Limits

These are the fixed limits Contingency enforces. No Setting changes them.

## Sessions

| Limit | Value |
| --- | --- |
| Active Teaching or Run activities in one Agent Session | 1 |
| Android devices bound to one live session | 1 |
| Run wall-clock limit | None |
| Agent Session lifetime | The MCP server process that owns it |

## Teaching Recordings

A Teaching Recording stops capturing when it reaches any of these limits.

| Limit                | Value      |
| -------------------- | ---------- |
| Recording duration   | 60 minutes |
| Recorded events      | 10,000     |
| Event stream size    | 16 MiB     |
| Video size           | 1 GiB      |
| Keyframes            | 400        |
| Captured actions     | 2,000      |
| Relayed Instructions | 200        |

## Browser observation

| Limit | Value |
| --- | --- |
| Elements in one Browser Snapshot | 300 |
| Characters of an accessible name before truncation | 160 |
| Element references kept alive per session | 1,000; the oldest are released first |
| Network requests kept per session | 500 |
| Console messages kept per session | 500 |
| Response body returned to the agent | 64 KiB |
| Response body or JSON storage value a Browser Check reads | 64 KiB |

## Programs in `agent_code_execute`

The single-tool interface runs each program in a fresh interpreter process.

| Limit                              | Value                                   |
| ---------------------------------- | --------------------------------------- |
| Program source                     | 16,384 characters                       |
| Timeout                            | 1 to 120 seconds; 30 seconds by default |
| Operation calls per program        | 50                                      |
| Value and logs returned inline     | 16 KiB                                  |
| Largest value a program may return | 1 MiB                                   |
| Interpreter memory                 | 320 MiB resident                        |

A value larger than the inline limit comes back as a `valueResource`. Read its URI with `resources/read` within 30 minutes. The server keeps at most 32 such values, 32 MiB in total, and discards the oldest first.
