# @contingencyhq/cli

Monitor whether your product's features still work. Teach a journey once by demonstrating it in a real browser, let an agent compile it into an Approved Agent Flow, and run that Flow whenever you want to know the journey still holds.

## Install

```sh
npm install -g @contingencyhq/cli
contingency --help
```

The binary is `contingency`, whatever the package name says. To try it without installing:

```sh
npx @contingencyhq/cli mcp
```

Node 24 or newer is required.

## Chromium

The browser is not bundled. The first Agent Session downloads Contingency's pinned Chromium build once and prints progress while it works. To fetch it ahead of time:

```sh
npx playwright-core install chromium
```

On Linux you may also need the browser's system libraries. `npx playwright-core install --with-deps chromium` installs them when your package manager allows it.

## Teach and run a journey

```sh
contingency mcp
```

This runs one local MCP server and serves the Workspace, the interface where you teach a journey by demonstrating it and then watch an agent re-run it. Point your MCP client at the endpoint the command prints.

During Teaching you drive the browser exclusively while the agent observes; the Workspace also exposes browser setup tooling — Emulation, storage inspection, devtools — so you can configure the environment before you demonstrate. When Teaching ends, Contingency derives a PlayByPlay from the recording, and the agent compiles an Agent Flow draft from it. You confirm the inferred Agent Step boundaries during the Verification Run before approving.

Once approved, the agent works within an Execution Boundary you approved: it may only visit hosts in the Agent Flow's Domain Scope, and any Step you marked as a Confirmation Step waits for you every time. Scheduling stays outside Contingency — have CI or cron invoke MCP when you want a sanity check.

## Workspace without MCP

```sh
contingency web
```

This serves the Workspace alone. Teaching and Interactive Runs need `contingency mcp`, which owns Agent Sessions; `contingency web` is for inspecting finished Runs. `--no-browser` starts the server without opening a browser window, which is what you want over SSH.

## Artifacts

A Teaching session keeps a local video and Playwright Trace, and a Run keeps its own evidence. These are unredacted and therefore sensitive: Contingency scrubs exact secret values from readable Trace entries where it can, but the scrub is best effort and does not make an artifact safe to share. Nothing leaves your machine without your confirmation — the Teaching Feed the external agent reads carries prose, bounded actions, and screenshot references, never the raw video or Trace.

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
