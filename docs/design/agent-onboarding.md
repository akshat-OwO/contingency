# Agent onboarding

Status: accepted. The user confirmed the product design and implementation approach. Implementation has not started.

Contingency needs a command that detects installed coding agents, lets the user choose one, and starts that agent with Contingency connected through MCP. The first message introduces Contingency and guides the user through their first Flow Skill.

## Agreed scope

The first version requires an installed, signed-in coding agent. Agent installation and sign-in are outside onboarding. Missing prerequisites need actionable recovery instructions.

Onboarding ends when the user teaches a variation of a bundled example, the agent learns a Flow Skill, a fresh Dry Run passes, and the user explicitly verifies the Flow Skill. An MCP connection alone does not complete onboarding. The agent then invites the user to apply the same kind of task to their own website; that journey is optional. Teaching, Dry Run, and verification retain their existing meanings in [GLOSSARY.md](../../GLOSSARY.md).

The initial launch supplies session-only MCP configuration. After the first Flow Skill is verified, the agent asks whether the user wants permanent registration for ordinary agent sessions. Users may choose the current project or all projects.

The command uses the user's current directory. Its Catalog Root is that directory's `.contingency` folder, and the command shows the resolved path before launching the agent.

New users see bundled examples that show what Contingency can do before they need to invent a journey on their own website. The examples provide concrete tasks and observable outcomes so users can connect those capabilities to their own work. This replaces the earlier requirement to begin on the user's website.

The user first watches the agent run a prepared example, then teaches a variation of that example. The prepared Run demonstrates a useful result before the user learns the recording process. It does not count as the user's own Teaching or verification.

The agent prepares the browser before recording. It may navigate and request private inputs through Workspace Variables, then hands control to the user. The user starts and stops recording; the agent learns from the resulting Teaching Recording.

Users launch onboarding with `npx @contingencyhq/cli start --demo`. The first version supports Claude Code and Codex. The existing `mcp` command remains available for direct server use.

Without `--demo`, `start` is the everyday session-only entry point. The agent follows the bundled work prompt (`contingency://start/work-prompt`) on the user's own website, and the server runs `mcp` without `--demo`, so neither the demo store nor its Example tools exist in that session. The agent does not offer permanent registration; it tells the user that running `start` again reconnects Contingency.

The demo surface is off by default everywhere. `contingency mcp`, and the registrations that run it, serve the demo store, its Examples, and the onboarding prompt only with `--demo`, which `start --demo` passes.

When only one supported agent is installed, the command launches it directly. When both are installed, it shows a picker. An explicit `--agent` option selects the agent without a picker.

On return visits, the agent inspects the current catalog and offers to continue unfinished work, run a saved Flow Skill, or teach another journey. It does not repeat first-journey onboarding for a catalog that already contains work.

Each launch creates an independent Agent Session with its own browser and Workspace on an available port. Separate launches may use the same Catalog Root, but they do not share browser control.

After saving the first drafted Flow Skill, the agent starts its Dry Run automatically. This does not waive the existing Execution Boundary or Confirmation requirements. The user still explicitly verifies the Flow Skill after a passing Dry Run.

If recording evidence shows that a failed Dry Run followed incorrect Flow Skill instructions, the agent repairs the skill and retries. If the website itself is broken, the agent reports evidence and asks what the user wants before changing application code.

Permanent registration checks any existing entry. It keeps an equivalent registration and asks before replacing a different one.

For registration across projects, later sessions use their current project's Catalog Root. A new project without `.contingency` gets its own catalog. A session falls back to the original onboarding directory only when no usable current project directory is available. The agent names that directory before using it. See [ADR 0049](../adr/0049-permanent-mcp-registration-keeps-project-local-catalogs.md).

## Launch configuration

Both agents support MCP configuration for a single launch without editing the user's configuration files. Claude Code accepts JSON through `--mcp-config`. Codex accepts TOML overrides through `-c`, including nested `mcp_servers` values. Both accept a positional initial prompt. These options preserve the agent's normal authentication configuration. See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex configuration documentation](https://developers.openai.com/codex/config-advanced/).

Research on 2026-10-03 checked Claude Code 2.1.288 and Codex 0.160.0. A read-only Codex configuration lookup resolved an injected MCP server. The same lookup without the override found no server. This establishes configuration injection, not a working connection. The oldest compatible versions and restoration of launch-only configuration through ordinary agent resume commands remain unverified.

Permanent registration differs by agent. [Claude Code MCP scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes) include private project registration, shared project configuration, and user-wide registration. [Codex MCP configuration](https://developers.openai.com/codex/mcp) supports user and project configuration, but `codex mcp add` writes only user configuration. Project configuration takes effect when the project is trusted.

Claude rejects an existing server name in the same scope. Codex 0.160.0 replaces a same-name user entry, including its extra options, in [the registration implementation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cli/src/mcp_cmd.rs). Registration must inspect an existing entry before changing it. Neither agent's registration command exposes a subprocess working-directory option. Catalog selection needs an explicit policy rather than relying on an absolute executable path to determine the data directory.

[T3 triage](https://github.com/pingdotgg/t3code/blob/0080e80c00a3e333e3dcafd85b2615d56f84e3b8/apps/server/src/cli/triage.ts) detects Claude Code and Codex on PATH. It launches the selected agent with a short instruction to read a generated prompt file. It does not inject MCP configuration. A live check with released `t3@0.0.44` reached Claude Code's directory trust prompt and stopped there.

## Existing Contingency contracts

The [MCP command](../../packages/cli/src/cmds/mcp.ts) owns the Workspace and serves stdio and HTTP from one process. Non-terminal stdin automatically receives an available Workspace port, including headless HTTP launches; terminal stdin defaults to 7777. Headless HTTP callers needing a fixed endpoint must explicitly set `CONTINGENCY_MCP_PORT`, which overrides either default. If an explicitly selected port is occupied, a spawned stdio process keeps its tools available but cannot serve its Workspace.

The [Catalog Root](../../packages/cli/src/services/flow-skill-catalog.ts) defaults to `.contingency` under the process's current directory. The launch directory determines where Flow Skills and local evidence live.

The server already supplies [authoring resources and the learning prompt](../../packages/cli/src/services/mcp-authoring-skills.ts). These include writing-for-agents, technical-writing, unslop, and `learn-flow-skill`. The starter prompt can introduce the task and refer to the learning procedure without maintaining another copy of it.

## Proposed implementation approach

The agent starts Contingency as a stdio MCP child process using session-only configuration. That process owns its Workspace and browser, following [ADR 0026](../adr/0026-external-agents-control-agent-flows-through-mcp.md). The agent keeps its normal authentication, model, and permission settings. Contingency does not embed another agent loop.

The Workspace binds an available loopback port and advertises the port it actually acquired. Port selection must happen during the bind; checking a port and releasing it before startup introduces a race. The server reports ready only when its tools and Workspace are available. The existing occupied-port behavior remains separate from this launch path.

The release bundles the starter prompt and supplies a short initial message pointing to its local prompt and launch context. The context identifies the current directory, Catalog Root, selected agent, and original directory for fallback. The prompt stays matched to the installed server version. Teaching and Run details remain in the server's tool contracts and learning prompt.

Registration uses a Contingency-owned command that checks the requested scope, existing configuration, and catalog policy before writing. The agent invokes that command after the user chooses a scope. It preserves unrelated configuration and uses supported agent configuration formats. Permanent registration starts a fresh server for each agent client, with an available Workspace port; it does not save an expiring HTTP endpoint from onboarding.

Directory discovery identifies the selected agent explicitly. For Claude, the MCP child reads the documented `CLAUDE_PROJECT_DIR` environment variable. For Codex, registration leaves `cwd` unset so the child inherits the current MCP runtime directory. The Codex CLI workspace mapping needs end-to-end verification; this research does not establish desktop or shared-daemon behavior. An inherited Claude variable must not redirect a Codex registration. See [Claude's stdio environment](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server) and the [Codex subprocess launcher](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/stdio_server_launcher.rs).

Directory discovery and catalog access are separate operations. Missing `.contingency` initializes a catalog in the selected directory. A permission failure reports an error there; it does not silently switch to the fallback.

The learning procedure must be readable by both agents without requiring a user to invoke an MCP prompt manually. If a client cannot retrieve `learn-flow-skill`, expose the same text through an MCP resource or focused read-only tool. Keep one authoritative procedure behind those access methods.

Shutdown closes process-owned resources and preserves durable Flow Skills, ready Teaching Recordings, and Run evidence under their existing lifecycle contracts. A return visit reads persisted state rather than pretending to resume a live browser that has closed. Failures identify the operation and recovery action. Configuration injection alone never counts as a working connection.

The [starter prompt draft](./agent-onboarding-prompt.md) applies writing-for-agents, technical-writing, and unslop. It describes the agreed product behavior. Directory discovery, example hosting, and the final registration command are implementation details to verify before shipping.

## Bundled examples

The CLI ships one coherent demo website and serves it locally. The site has a core journey and optional examples for private inputs, accessibility or performance scans, and identifying a broken journey. Users choose an example rather than completing every capability. Each attempt starts with a clean browser context.

The user watches the agent run the chosen prepared example, then teaches a variation. Verifying that variation completes onboarding. The agent invites the user to apply the demonstrated pattern to their own website afterward. A demo Flow Skill retains its taught hosts; applying the pattern to another website means teaching a new journey there.

The [verification shop](../../.agents/skills/verify-contingency/fixtures/ecommerce/shop.html) and [cart](../../.agents/skills/verify-contingency/fixtures/ecommerce/cart.html) support product selection and delivery location inputs. They are developer fixtures outside the published CLI package. Some controls are inert and other pages deliberately expose synthetic secrets for redaction tests. Reusing this material requires runnable examples designed for users, with clear outcomes and reset behavior. The existing fixture server resets browser storage only through a fresh browser context.

The demo is Ridgeline Hardware. Delivery-and-cart is the default example; signed-in returns, scans, and a deliberately broken cart are optional examples. Failure examples need a deliberate, labeled fault and a reset path before Teaching and Dry Run; an unexplained broken page would look like failed setup.

Each capability has a bundled read-only Example Flow Skill, labeled Example and restricted to the demo site. These skills remain separate from the user's catalog and never claim user verification. The runtime explicitly supports their bundled origin, following [ADR 0050](../adr/0050-bundled-example-skills-have-distinct-authority.md).

The user's learned variations and demo Run evidence stay in the current catalog and are clearly identified as demo work. They use the normal draft, Dry Run, verification, and evidence lifecycle. A catalog containing only demo work still counts as existing work on return visits; the agent offers that work, another example, or Teaching on the user's website.

After verifying a healthy demo variation, the agent offers an optional Run of that same skill against an applicable deliberate fault. It reports evidence of the failure and restores the demo to healthy. This is a later Interactive Run, not another Dry Run or a reversal of user verification. The agent offers it only when the available fault affects the learned journey.

The [example design](./agent-onboarding-examples.md) describes the tasks and runtime constraints discovered during Claude Opus 5.5's design review.

## Verification requirements

- Exercise Claude Code and Codex with one installed agent, both installed agents, and explicit `--agent` selection.
- Prove a live MCP call and usable Workspace through each supported launch path.
- Launch two clients concurrently and confirm separate browsers and Workspace ports.
- Teach, learn, automatically Dry Run, and explicitly verify a Flow Skill on a local fixture.
- Run the shipped examples through the watch, teach-a-variation, and verification path. Confirm that browser state resets between attempts and a deliberate failure can return to the healthy state.
- Accept and decline the optional failure rerun. When accepted, confirm that the user's verified skill reports the observed failure, the demo returns to healthy, and onboarding remains complete.
- Recover from incorrect Flow Skill instructions without editing website code.
- Test project and user registration, equivalent entries, differing entries, and preservation of unrelated configuration.
- Confirm a fresh project gets its own catalog and directory discovery uses the fallback only when no current project is available.
- Exit during setup, recording, and a Dry Run; verify persisted results and return-visit choices against the existing lifecycle contracts.
