# @contingency/cli

The CLI drives Chromium through `playwright-core` in process. The browser is not bundled: the first Run or Create session downloads Contingency's pinned Chromium build once, printing progress as it goes. To install it ahead of time instead:

```
npx playwright-core install chromium
```

Linux users may also need the browser's system libraries; `npx playwright-core install --with-deps chromium` installs them when the package manager allows.

Start Create View with `contingency web`. It serves the production web app from the CLI build, or connects the development app to the CLI's `/ws` endpoint. Pass `--no-browser` to keep it from opening the interface automatically.

Set `CONTINGENCY_STATE_DIR` to override the state directory that holds Run artifacts.

Every Run keeps a Playwright Trace by default. Pass `--no-trace` to discard it. `--video` additionally generates a WebM slideshow from the Trace's per-Step screenshots, including the final settled state. Traces and videos are sensitive. Exact secret values are scrubbed from readable Trace entries where possible, but the scrub is best effort and does not make an artifact safe to share.
