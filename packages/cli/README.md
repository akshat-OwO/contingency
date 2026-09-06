# @contingencyhq/cli

Author website Flows, re-run them, and report accessibility and performance Findings. Contingency runs the browser itself, so a Flow you record in the web interface is the same Flow your CI runs headlessly.

## Install

```sh
npm install -g @contingencyhq/cli
contingency --help
```

The binary is `contingency`, whatever the package name says. To try it without installing:

```sh
npx @contingencyhq/cli web
```

Node 24 or newer is required.

## Chromium

The browser is not bundled. The first Run or Create session downloads Contingency's pinned Chromium build once and prints progress while it works. To fetch it ahead of time:

```sh
npx playwright-core install chromium
```

On Linux you may also need the browser's system libraries. `npx playwright-core install --with-deps chromium` installs them when your package manager allows it.

## Author a Flow

```sh
contingency web
```

This opens Create View, where you drive a live browser on a canvas and record Steps as you go. Add Audits where you want checks to run, and Pre-steps to clear popups and cross-sells that would otherwise interfere. Saving produces a Flow, a JSON file you commit alongside your code.

Pass a Flow to open Audit View over it instead, where you start a Run and step through the timeline afterwards to inspect what each Step did:

```sh
contingency web checkout.flow.json
```

`--no-browser` starts the server without opening a browser window, which is what you want over SSH.

## Run a Flow

```sh
contingency run checkout.flow.json
```

The Run executes headlessly and writes its artifacts to the Contingency state directory. Useful flags:

```sh
# Supply the Variables a Flow declares but does not contain, reading each one
# from CONTINGENCY_SECRET_<NAME>. Prefer this everywhere, and in CI especially.
contingency run checkout.flow.json --secret LOGIN_EMAIL --secret TOTP

# Or pass a value inline, which leaves it in your shell history and in the
# process list where other users on the machine can read it.
contingency run checkout.flow.json --secret STORE_URL=https://staging.example.com

# Retry a flaky Flow, each attempt in a fresh browser session.
# Leave this at 0 for a Flow with real side effects, such as placing an order.
contingency run checkout.flow.json --retry 2

# Fail the exit code on specific accessibility rules, ignoring the Flow's own Gate.
contingency run checkout.flow.json --gate image-alt --gate label

# Stop the whole Run, retries included, after 90 seconds.
contingency run checkout.flow.json --timeout 90
```

`--output` writes Runs somewhere other than the state directory. `--ignore-gate` holds the Run to no Gate at all.

## Exit codes

A Run reports every Finding it produces. Whether a Finding fails your build is a separate decision, which the Flow's Gate makes.

| Code | Meaning |
| --- | --- |
| 0 | The Run completed and breached no Gate. |
| 1 | The Run did not complete. Something broke. |
| 2 | The Run completed and breached its Gate. The site missed a bar its author chose. |

Exit code 2 is the interesting one. The Run itself executed fine, so it stays eligible as a Baseline for later comparison, and your pipeline still fails.

## Use it from an agent

```sh
contingency mcp
```

This runs one local MCP server and serves Agent View, the interface where you teach a journey by demonstrating it and then watch an agent re-run it. Point your MCP client at the endpoint the command prints. The agent works within an Execution Boundary you approve: it may only visit hosts in the Agent Flow's Domain Scope, and any Step you marked as a Confirmation Step waits for you every time.

## Artifacts

Every Run keeps a Playwright Trace, which is how you inspect a finished Run. `--no-trace` discards it. `--video` additionally renders a WebM from the Trace's per-Step screenshots, including the final settled state.

Traces and videos are sensitive. Contingency scrubs exact secret values from readable Trace entries where it can, but the scrub is best effort and does not make an artifact safe to share.

Set `CONTINGENCY_STATE_DIR` to move the state directory that holds all of this.

## Agent Flow artifact retention

Approving an Agent Flow revision deletes that Teaching session's full Trace and video by default. Evidence Slices and verification evidence stay in the catalog.

To keep the full Teaching artifacts for a fixed period, add `agent-flow-catalog.json` at the Catalog Root:

```json
{
  "approvalArtifactRetention": {
    "days": 30,
    "mode": "retain-for-days"
  },
  "schemaVersion": 1
}
```

Contingency records the resulting `deleteAfter` timestamp in the Teaching artifact metadata, and catalog startup removes expired Trace and video files, so the schedule survives process exits. This policy covers sensitive Teaching artifacts only. It never deletes Agent Flow revisions or Evidence Slices.
