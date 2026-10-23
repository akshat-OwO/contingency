# Set up a Local System One

System One chooses browser actions for a Pursuit. The external agent still owns the plan and verifies the outcome.

Run `contingency system-one setup` in your terminal to install Nev and Kev. Setup supports Apple Silicon macOS and Linux with an NVIDIA GPU. Install uv and a system Python 3.12 or 3.13 yourself first. Setup reports download and disk sizes and asks before downloading. `--yes` skips that prompt. Linux sizes are estimates; the Apple Silicon sizes are measured.

Contingency downloads the release's tested Kev commit and Nev revision. It checks Kev's SHA-256, creates its Python environment, fetches the model, and makes a real smoke request before promoting the installation. Python is never downloaded. The owned directory is `~/Library/Application Support/contingency/system-one` on macOS, or `$XDG_DATA_HOME/contingency/system-one` on Linux, with `~/.local/share` as the default data home. It contains all environments, caches, models, state, and logs.

Start `contingency mcp` after setup. It lists `agent_browser_pursue` immediately and starts the shared local server in the background. The first Pursuit waits for readiness within its own time budget. Requests use an OS-assigned loopback forwarder and the installed model revision. Local requests never carry the hosted API key.

A configured `CONTINGENCY_SYSTEM_ONE_URL`, or `systemOne.url` in `~/.contingency/config.json`, takes precedence. For hosted Jev, use `https://api.typesafe.ai` and supply `CONTINGENCY_SYSTEM_ONE_API_KEY` in the environment. Set `systemOne.local` to `false` in config.json to disable automatic local use. With no configured endpoint or eligible installation, Pursuits are absent from the catalog.

Use `contingency system-one status` to inspect revisions, readiness, PID, port, memory, and idle time. `start` and `stop` control the server manually. It exits after 15 minutes without a request. Automatic startup skips memory pressure. A Pursuit can restart a crashed server once; a second crash requires `start`. Inspect `server.log` in the owned directory for failures.

Run `contingency system-one update` in an interactive terminal to list newer Kev commits and Nev revisions separately. Each choice says whether this release tested it. You can stay on the current version. An untested Kev tarball's SHA-256 is computed and recorded after download; this records its content and does not authenticate it against a release pin. A selected version installs beside the current version and becomes current only after its smoke request passes. One previous version remains. `update --rollback` smoke-checks and swaps back to it. Update notices use a cached check; MCP refreshes it in the background at most once a day and never waits on the network during startup.

Run `contingency system-one remove` to stop the server and delete its owned directory. Setup and update are terminal commands. Agents cannot invoke them through MCP or `agent_code_execute`.
