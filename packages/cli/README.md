# @contingency/cli

The CLI bundles the native `agent-browser` executables in `assets/agent-browser`. On the first run, Contingency invokes the bundled executable's `install` command to download Chrome for Testing. Successful initialization is recorded in the user's state directory, so later runs start without repeating the check.

Set `CONTINGENCY_STATE_DIR` to override the state directory used for this marker. Linux users are still responsible for the browser's system libraries; `agent-browser install --with-deps` can install them when required.

Chrome for Testing does not publish Linux ARM64 builds. On that platform, install Chromium with the system package manager and set `AGENT_BROWSER_EXECUTABLE_PATH` to its executable; Contingency skips the unsupported download while retaining the bundled ARM64 agent-browser CLI.
