# @contingencyhq/cli

Monitor whether your product's features still work. Teach a journey once by demonstrating it in a real browser, let an agent learn a reusable Flow Skill from the recording, and run that Flow Skill whenever you want to know the journey still holds.

## Install

```sh
npm install -g @contingencyhq/cli
contingency --help
```

The binary is `contingency`, whatever the package name says. To try it without installing:

```sh
npx @contingencyhq/cli start
```

Node 24 or newer is required.

## Start with your coding agent

```sh
npx @contingencyhq/cli start
npx @contingencyhq/cli start --agent claude
npx @contingencyhq/cli start --agent codex
```

Install and sign in to Claude Code or Codex first. `start` launches the one installed agent or offers a picker when both are installed. It connects Contingency for that session and prints the current project's `.contingency` Catalog Root. Each launch owns a separate Workspace and browser on available local ports.

The agent offers bundled Examples on Ridgeline Hardware, a local demo store. Watch an Example, teach your own variation, and let the agent learn it and automatically start a fresh Dry Run. After a passing result, choose **Verify flow** in Workspace. Examples are read-only and remain separate from your saved Flow Skills. Demo skills retain their demo label when you return to the project.

Supply private demo passwords in Workspace. During a return Teaching recording, click the store's Password field, then use **Demo password** and **Enter demo password**. The recording retains `DEMO_PASSWORD` in place of its value.

After verification, you can keep the session-only connection or register Contingency for ordinary agent sessions:

```sh
contingency register --agent claude --scope project
contingency register --agent codex --scope user
```

Project registration applies to the current project. User registration applies across projects, with a separate `.contingency` catalog in each project. Equivalent entries stay unchanged. A different entry is reported without changes; use `--replace` only after choosing replacement. If an agent cannot report a usable project directory, Contingency names and uses the original onboarding directory as its fallback.

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

Once verified, the agent runs the Flow Skill within an Execution Boundary: it may only visit the hosts you demonstrated on, and an irreversible browser action waits for your confirmation every time. The Run also reopens the browser under the Emulation you taught it, so a journey demonstrated on a phone runs as a phone. Scheduling stays outside Contingency — have CI or cron invoke MCP when you want a sanity check.

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
