# Interface evaluation round 2 blocker

Checked 2026-10-16 on `feat/461-interface-evaluation` at `a6184c27`. The amended plan remains unchanged. No product code changed.

## The paired benchmark cannot use one session

The amended plan requires 20 paired calls each of `agent_session_get` and `agent_browser_act`, comparing a native call with a one-operation program on one session. The production server cannot expose both paths to that session:

- `CONTINGENCY_MCP_INTERFACE=native` registers 37 tools, including the native operations, but excludes `agent_code_execute`.
- `CONTINGENCY_MCP_INTERFACE=single-tool` registers only `agent_code_execute`. Calling `agent_session_get` directly fails.
- The interface is selected at process startup. Agent Sessions belong to that process. Restarting with the other interface cannot retain the live session.
- `control-contingency` translates a native-shaped call to a one-operation program under single-tool. Timing that helper against an explicit program would compare two programs, not native dispatch against a program.
- The older opt-in `agent_code_run` uses a different runtime and permits only reads. It cannot supply the action half of this benchmark.

The owning modules are `packages/cli/src/services/mcp-http.ts`, `packages/cli/src/cmds/mcp.ts`, and `packages/cli/src/services/mcp-code-mode.ts`. The broker translation is in `.cursor/skills/verify-contingency/bin/control-contingency`.

The production build completed successfully with:

```sh
nub exec turbo run build --filter=@contingencyhq/cli --force
```

Two sequential disposable production MCP processes confirmed the catalog restriction. Each used a fresh temporary cwd, HOME, Catalog Root and global Catalog Root, with `CONTINGENCY_MCP_PORT=0` and `NODE_ENV=production`. After initialization and `tools/list`, each received one unavailable-tool probe:

| Interface   | Tools | Probe                | JSON-RPC result          |
| ----------- | ----- | -------------------- | ------------------------ |
| native      | 37    | `agent_code_execute` | `-32602`, tool not found |
| single-tool | 1     | `agent_session_get`  | `-32602`, tool not found |

Raw catalogs, refusal replies, memory checks, process IDs, start/stop times, and exit results are retained in the gitignored `artifacts/interface-eval/contract-check/` directory relative to this skill. These are contract probes, not model evaluation runs or incorrect choices by a model. They are not added to `runs.jsonl`.

The brief requires stopping when the contract cannot be implemented. No model, calibration, or overhead runs were started. No smoke measurements, catalog token costs, or overhead medians/p90s are available. No harness was partially implemented.

To unblock, either amend the benchmark to permit matched fresh sessions in separate production processes, or authorize a benchmark entry point that offers both native dispatch and interpreter dispatch over one session registry. Neither change has been made.

## Driver findings

Installed versions are Claude Code `2.1.301` and Codex CLI `0.163.0`. No driver isolation configuration has been proved by a model run.

Claude's local help documents `--safe-mode` as disabling CLAUDE.md, skills, plugins, hooks, and other customizations, with managed policy still applying. It also documents `--setting-sources ""`, `--strict-mcp-config`, and `--tools ""`. The required explicit MCP configuration must be checked under the chosen isolation mode before collecting results. `--bare` skips CLAUDE.md discovery but also disables OAuth and keychain authentication, so it cannot be assumed to work with the user's existing login.

Codex supports the required isolated `CODEX_HOME`, read-only sandbox, `--skip-git-repo-check`, and `--ignore-rules`. Auth was not read or copied.

The [Codex 0.163.0 event schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/exec/src/exec_events.rs) reports aggregate usage in `turn.completed`, without per-request usage. That event alone cannot establish peak context for a task with multiple model requests. Record it as missing, as the brief requires, unless another driver-owned per-request usage source is explicitly permitted. Do not use the aggregate input as peak context.

## Remaining implementation

- `cart`: create the runner, proxy, isolated drivers, shared prompts, task module, final cart and reported-total checks, incorrect-choice classifier, usage parser, raw results, calibration, and the agreed overhead benchmark. The current shop has SKUs and cart state but no prices or monetary total; a fixture extension is needed for a monetary-total task.
- `checkout`: supply a private Variable through Workspace only after the model requests it, allow the purchase Confirmation, count orders, and assert the private literal is absent from every model-visible message.
- `refuse`: refuse that Confirmation, assert no order and no dispatch after refusal, and check the model's refusal report.
- `learn`: seed a Teaching Recording, inspect the saved Flow Skill contract, and verify parameterization.
- `dry-run`: seed a Flow Skill, change its inputs, verify through Workspace, and inspect the complete verified Summary.
- `takeover`: script Workspace Takeover, edit the cart, return control, retain the user timeline, and check rereading and the final cart.
- `android`: seed the checkout fixture on the selected device and inspect submitted values. No emulator was started this round.

## Cleanup

The build finished in exec session `68812`. The two MCP processes were PIDs `32654` and `32702`, listening on ports `63249` and `63250`. Each received SIGTERM and was awaited to exit, reporting exit code 130. Both PIDs were absent and both ports had no listener afterward. Their temporary directories were removed. No fixture server, Chromium, interpreter, or model driver was started. Swap was zero before both probes and after cleanup.
