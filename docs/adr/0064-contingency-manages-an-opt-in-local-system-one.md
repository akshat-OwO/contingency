---
status: accepted
---

# Contingency manages an opt-in Local System One

Running Nev today means cloning Kev, syncing its Python environment, starting its server on a port, and exporting `CONTINGENCY_SYSTEM_ONE_URL` by hand. `contingency system-one` will set up, run, update, and remove a Local System One on request. [ADR 0057](./0057-system-one-pursues-delegated-sub-goals.md) rejected bundling Nev because Contingency would own a Python and MLX runtime and a large download. That objection still holds for the package, so the package ships no model, no Python, and no Kev. What changes is that the user can ask Contingency to fetch and run them in a directory it owns and can delete.

## Rules

- **Opt-in and removable.** Nothing downloads until the user runs `contingency system-one setup` in a terminal. It shows the measured total size, including Kev's Python environment, and asks for confirmation; `--yes` skips the prompt. The external agent cannot run setup or update: downloading and running new code on the machine is the user's consent to give. `remove` deletes the whole owned directory.
- **Kev serves the model.** Contingency runs Kev's own `/v1/systemone` server rather than a port of it, so Nev's probabilities stay exactly those its calibration and the Pursuit thresholds assume. Kev arrives as the GitHub tarball of a pinned commit, checked against its SHA-256, so git is not required.
- **uv and Python are requirements, never installs.** Setup needs uv and a system Python 3.12 or 3.13, and fails naming whichever is missing. It sets `UV_PYTHON_DOWNLOADS=never`, so uv does not fetch an interpreter on Contingency's behalf.
- **Supported platforms.** Apple Silicon macOS (MLX) and Linux with an NVIDIA GPU (CUDA). Elsewhere setup refuses before downloading and points to a hosted System One, because a CPU fallback would lose the latency that makes a Pursuit worth delegating.
- **One owned directory.** Kev, its environment, the model, `HF_HOME`, the uv caches, the state file, and the server log live in the platform data directory (`~/Library/Application Support/contingency/system-one` on macOS, `$XDG_DATA_HOME/contingency/system-one` on Linux), never in a Catalog Root.
- **Models come from a list.** `setup --model` chooses from a list Contingency maintains. It holds only `nev`, the default. The state file records the installed model so the list can grow without migration.
- **One shared server.** A lock and a pidfile allow one server per machine. It listens on an OS-assigned loopback port recorded in the state file. `contingency mcp` starts it in the background when a Local System One is installed and not running, and never fails or waits on it. The server exits after 15 minutes without a request. `start` and `stop` control it by hand. Auto-start is skipped under memory pressure, and the Pursuit that needed it says so.
- **Discovery.** `CONTINGENCY_SYSTEM_ONE_URL` wins when set. Otherwise an installed Local System One is used, and `agent_browser_pursue` is listed as soon as one is installed, even before the server is warm. Installing it was the consent ADR 0057 asks for, and requests never leave the machine. A non-secret Setting, `systemOne.local: false`, turns this off once [ADR 0063](./0063-settings-live-in-a-strict-catalog-root-config.md) lands.
- **Warm-up and crashes.** A Pursuit that arrives during warm-up waits for readiness within its own time budget, then fails with an error saying the Local System One is still starting. After a crash the next Pursuit restarts the server once. A second crash fails with the log's path, and nothing restarts it until `start`.
- **The user chooses updates.** Each Contingency release names the Kev commit and Nev revision it was tested against. `update` lists newer Kev commits and Nev revisions separately, each marked tested or untested by this release, and the user picks or stays. Nothing updates automatically; `status` and `contingency mcp` startup mention a newer version in one line at most. The new version installs beside the current one and becomes current only after a smoke request passes. One previous version is kept for `update --rollback`.
- **Status.** `contingency system-one`, alone or as `status`, shows the model and Kev revisions, whether the server runs, its port, PID, memory, and idle time.
- **Agent discovery costs nothing.** With no Local System One installed, the catalog and server instructions are unchanged, as [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md) requires. A `docs_get` topic from ADR 0063 tells an agent that searches for System One how the user can set one up.

## Considered options

- **A native TypeScript server on `node-llama-cpp`.** llama.cpp supports Qwen3.5, and the pointer head and encoder are small, so this would remove uv and Python. Rejected for now: Contingency would maintain a port that must follow Kev's encoding, and kernel differences shift probabilities against thresholds that assume Nev's calibration.
- **Installing uv, or letting uv fetch Python.** Rejected: setup would change the user's toolchain or PATH. Naming the requirement leaves that choice to the user.
- **A process per `contingency mcp`.** Rejected: each agent harness would hold its own copy of the model in memory and pay the load time at every launch.
- **An OS service.** Rejected: always-on memory use and launchd and systemd code for a feature the user may use once a day.
- **The shared Hugging Face and uv caches.** Rejected: they would reuse a Qwen base the user already has, but `remove` could not reclaim the space.
- **A fixed port 8009.** Rejected: it collides with a Kev server the user runs by hand, and MCP reads the port from the state file anyway.
- **Pinned versions only, or always the latest.** Rejected: pins hide upstream fixes, and tracking upstream silently changes Pursuit behavior. Labeled choice gives the user both.
