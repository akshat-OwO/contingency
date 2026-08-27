# @contingency/cli

The CLI drives Chromium through `playwright-core` in process. On first use, install the browser it runs:

```
npx playwright-core install chromium
```

Linux users may also need the browser's system libraries; `npx playwright-core install --with-deps chromium` installs them when the package manager allows.

Set `CONTINGENCY_STATE_DIR` to override the state directory that holds Run artifacts.

`--video` records a Run to WebM through Playwright's own capture, one file per attempt. Recordings are not redacted: a Flow that declares secret Variables warns when video is on, because the recording shows their values in plaintext while `run.json` does not.
