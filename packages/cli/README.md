# @contingency/cli

The CLI drives Chromium through `playwright-core` in process. The browser is not bundled: the first Run or Create session downloads Contingency's pinned Chromium build once, printing progress as it goes. To install it ahead of time instead:

```
nubx playwright-core install chromium
```

Linux users may also need the browser's system libraries; `nubx playwright-core install --with-deps chromium` installs them when the package manager allows.

Start Create View with `contingency web`. It serves the production web app from the CLI build, or connects the development app to the CLI's `/ws` endpoint. Pass `--no-browser` to keep it from opening the interface automatically.

Set `CONTINGENCY_STATE_DIR` to override the state directory that holds Run artifacts.

`--video` records a Run to WebM through Playwright's own capture, one file per attempt. Recordings are not redacted: a Flow that declares secret Variables warns when video is on, because the recording shows their values in plaintext while `run.json` does not.
