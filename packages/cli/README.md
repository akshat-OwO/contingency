# @contingencyhq/cli

Monitor whether your product's features still work. Teach a journey once by demonstrating it in a real browser, let an agent learn a reusable Flow Skill from the recording, and run that Flow Skill whenever you want to know the journey still holds.

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

During Teaching you drive the browser exclusively while the agent observes; the Workspace also exposes browser setup tooling — Emulation, storage inspection, devtools — so you can configure the environment before you demonstrate. When you stop recording, Contingency keeps a Teaching Recording on disk. The agent reads its timeline and keyframes, writes a Flow Skill to `.contingency/<flow-name>/SKILL.md`, and proves the skill with a Dry Run in a fresh browser context. You verify the Flow Skill in the Workspace, and Contingency then deletes the recording's video, Trace, events, and keyframes.

Once verified, the agent runs the Flow Skill within an Execution Boundary: it may only visit hosts in the session's Domain Scope, and an irreversible browser action waits for your confirmation every time. Scheduling stays outside Contingency — have CI or cron invoke MCP when you want a sanity check.

## Workspace without MCP

```sh
contingency web
```

This serves the Workspace over the local Catalog Root, so you can teach a journey and inspect a finished Run and its video without starting an MCP client. It owns Teaching only: an agent still needs `contingency mcp` to learn a recording, Dry Run it, or start an Interactive Run. `--no-browser` starts the server without opening a browser window, which is what you want over SSH.

## Artifacts

A Teaching session keeps a local video and Playwright Trace, and a Run keeps its own evidence. These are unredacted and therefore sensitive: Contingency scrubs exact secret values from readable Trace entries where it can, but the scrub is best effort and does not make an artifact safe to share. Nothing leaves your machine without your confirmation — the Teaching Timeline the external agent reads carries bounded actions, Instructions, URL transitions, and keyframe references, never the raw video or Trace.

## Teaching Recording cleanup

A Teaching Recording is temporary evidence, not the artifact you keep. Verifying the Flow Skill learned from it deletes its video, Trace, events, and keyframes; the Flow Skill directory and its `references/` are all that remain.

Cleanup is idempotent and resumes at startup. If a file cannot be deleted, the verified Flow Skill stands and the Workspace names the retained sensitive files and offers a retry. Rejecting a drafted Flow Skill keeps every Teaching artifact so the agent can try again.
