# Contingency

Contingency lets companies author and re-run website Flows for functional sanity, performance, and accessibility, surface Findings, and feed agent-driven fixes.

## Language

**Flow**: Contingency's primary durable artifact: a native JSON document declaring ordered Steps, conditional Pre-steps, Variables, and Emulation ([ADR 0011](./docs/adr/0011-flow-is-a-native-format.md)). _Avoid_: Workflow, recording (as the saved artifact), Chrome Recorder JSON, contingency project

**Suite**: A named, ordered manifest of Approved Agent Flows that defines the required sanity coverage for one business area. The first version runs members sequentially; after a member fails, the agent pauses and asks the user whether to retry it, continue, or stop. An agent may suggest changes to a Suite, but it may not infer that an unlisted Agent Flow is required or claim complete coverage without running every listed Agent Flow. _Avoid_: vertical (as the persisted artifact), inferred coverage, test bucket

**Teaching**: The mixed-control authoring process in which a user demonstrates a journey, directs the agent to act, or marks an action for private user input. Teaching produces a Demonstration; it does not itself produce an approved artifact. _Avoid_: Replay, autonomous Run, Recording (when no agent is being taught)

**Demonstration**: The captured actions, user instructions, and full Trace produced during Teaching. It is sensitive compilation input for an Agent Flow, not reusable automation. _Avoid_: Flow, Agent Flow, screen recording

**Teaching Feed**: The bounded, best-effort-redacted view of a Demonstration available to the external agent: user instructions, captured actions, Browser Snapshots, URL transitions, references to masked screenshots, and Variable references in place of known secret values. It is bounded in size as well as in content: screenshot bytes are stored once under their content address and fetched one at a time by reference, never embedded ([ADR 0032](./docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)). The full Trace, video, cookies, authorization headers, and network bodies remain local. _Avoid_: Trace, raw browser export, guaranteed-redacted artifact

**Agent Flow**: A schema-validated, versioned package the agent compiles from a Demonstration. Its stable identity spans immutable revisions; its title, short description, Domain Scope, Emulation, Variables, ordered Agent Steps, Confirmation Step markers, and Evidence Slice references describe one reusable sanity journey ([ADR 0025](./docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md), [ADR 0033](./docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)). _Avoid_: Flow, generated to-do list, raw Trace

**Agent Step**: One meaningful objective within an Agent Flow, backed by the demonstrated actions and Evidence Slices that achieved it. Agent Steps execute in declared order and may not be silently skipped; only `working` proceeds to the next Step. After `not-working`, `inconclusive`, `blocked`, or `timed-out`, later Steps remain unexecuted and coverage is incomplete. An agent may decompose each Step into several to-do items and browser actions during a Run. _Avoid_: captured action, click transcript, generated to-do item

**Confirmation Step**: An Agent Step the user marks as requiring confirmation because it can cause an irreversible or high-impact effect. Confirmation authorizes one specific irreversible browser action attempt; retrying it requires fresh confirmation. A new objective outside the approved Agent Steps pauses in the same way. _Avoid_: ordinary click confirmation, Gate, model warning

**Evidence Slice**: An immutable, bounded extract Contingency derives from the demonstrated action span assigned to one Agent Step. It contains the user instruction, actor, captured actions, before and after Browser Snapshots, references to masked screenshots stored once in the Agent Flow package, URL transitions, and timing; the full Trace remains separate and is not an Agent Flow dependency. _Avoid_: agent-authored evidence, Trace path, full Trace, Run video, embedded screenshot bytes

**Approved Agent Flow**: An Agent Flow a user has authorized for future reuse through a direct Agent View approval after a successful Verification Run. The agent may request approval but cannot grant it. A new or materially changed Agent Flow requires verification and approval again. _Avoid_: ready-for-agent Flow, trusted recording, published Run

**Verification Run**: The first Run of a new or materially changed Agent Flow, performed in a fresh browser context with its declared Emulation and Variables supplied again. It opens on the page Agent View was showing when the user authorized it, so verification does not repeat navigation Teaching already did; only that URL crosses over, never Teaching's cookies or storage. The user authorizes one Verification Run from Agent View after reviewing and, when needed, correcting the agent's proposed Step boundaries, names, descriptions, Variables, Domain Scope, and Confirmation Steps. Every Confirmation Step still requires fresh confirmation. A failed verification may inform another draft, but each changed draft requires a new user authorization; a successful Verification Run is required before user approval. _Avoid_: Teaching continuation, same-context retry, Replay

**Agent Flow Revision**: One immutable, schema-versioned version of an Agent Flow. Editing an Approved Agent Flow creates a draft revision and leaves the approved revision usable until the draft passes verification and receives approval. Explicit non-destructive migrations preserve older revisions. _Avoid_: in-place edit, autosave over approval, Run version

**Catalog Root**: The explicitly selected directory that bounds Agent Flow discovery and storage. It defaults to the current workspace's `.contingency` directory; an agent never searches a user-global catalog implicitly. _Avoid_: global catalog, home directory scan, issue repository

**Agent Flow Catalog**: The searchable collection under a Catalog Root containing Agent Flows, stable identities, approval metadata, Suites, and evidence packages. It supports deterministic filters and local full-text search over titles, descriptions, tags, and Agent Step descriptions. It is separate from the GitHub issue tracker and its `ready-for-agent` label. _Avoid_: issue queue, vector database, Run history, Flow picker

**Execution Boundary**: The Runner-enforced domain scope and user-confirmation requirement for irreversible browser actions during an Interactive Run. The external agent controls its plan within this boundary; Contingency does not require its to-do list or browser actions to replay the Demonstration's action path. _Avoid_: generated to-do list, model prompt, Agent Assessment

**Domain Scope**: The exact hosts and explicit wildcard patterns an Agent Flow may visit. Teaching proposes the observed domains, the user approves them, and an unapproved top-level navigation during a Run pauses for intervention. It bounds where the session travels, so a subframe the page embeds is outside it ([ADR 0035](./docs/adr/0035-domain-scope-governs-top-level-documents.md)). _Avoid_: every linked domain, implicit redirect permission, global allowlist, embedded frame policy

**Takeover**: The exclusive interval in Teaching or an Interactive Run when the user controls the browser and agent action tools are disabled. User initiation interrupts the in-flight agent action and takes priority, though an action already dispatched to the browser cannot be undone. Recording continues, sensitive inputs become Variable references rather than literals, and the user explicitly returns control to the agent. _Avoid_: concurrent control, paused Recording, session transfer

**Browser Snapshot**: A compact accessibility representation of the current Page with short-lived element references for agent actions. References expire after navigation or meaningful page mutation; screenshots remain a separate visual observation. _Avoid_: screenshot, Trace, Baseline, DOM dump

**Interactive Run**: An agent-controlled Run connected to a live MCP conversation so the agent may pause and request user intervention. Agent View need not remain open while the agent works; the agent can return its local link again when the user wants to watch or Takeover is needed. The Run does not continue past required intervention without the user. _Avoid_: live Recording, autonomous Run, permanently attended browser tab

**Suite Setup**: The optional Agent Flow a Suite runs once to establish browser storage such as an authenticated session. Each Suite member then receives that state in a fresh isolated browser context, and the in-memory state is discarded when the Suite Run ends. A failed or inconclusive Suite Setup stops member execution and leaves Suite coverage incomplete. _Avoid_: shared Suite browser, persisted login profile, Suite member

**Agent View**: The local web interface for Teaching and agent-controlled Runs. It shows the live browser beside Agent Step summaries and results reported through MCP, lets the user take control with priority over the agent, and lets the agent request Takeover. It is separate from Audit View ([ADR 0030](./docs/adr/0030-agent-view-is-separate-from-audit-view.md)). _Avoid_: Audit View, Create View, agent conversation

**Agent Session**: The ephemeral coordination envelope owned by one MCP server process that binds one Agent View, browser, and external agent to at most one active Teaching or Run activity. It is not reusable automation and is not persisted as a Run. _Avoid_: Run, Agent Flow, browser profile

**Agent Assessment**: The agent's evidence-backed conclusion about one Agent Step during a Run: `working`, `not-working`, `inconclusive`, or `blocked`. The Agent Flow result is derived from its Agent Step assessments. Assessment history remains available for inspection but does not produce automatic Regressions or Alerts because model judgments are not deterministic ([ADR 0034](./docs/adr/0034-agent-assessments-do-not-create-regressions.md)). _Avoid_: assertion, verified result, Finding

**Run Summary**: The local Agent View report of an Interactive Run's Agent Assessments, unexecuted Steps, execution outcomes, and evidence. It reports assessment counts separately from coverage as `complete` or `incomplete`, because a Run may find a broken Step and still lack coverage for later Steps. It embeds the full Run video automatically; transmitting that sensitive video outside Contingency requires user confirmation. The external agent owns its generated to-do list and progress in its conversation. _Avoid_: agent plan, Trace, Handoff, uploaded report

**Artifact Retention**: The Catalog Root policy governing how long sensitive Teaching and Run artifacts remain. By default, approval deletes the full Demonstration Trace and video while preserving the Agent Flow's Evidence Slices and verification evidence; a Catalog Root may configure another duration. _Avoid_: Agent Flow deletion, catalog archival, Variable lifetime

**Create View**: The authoring mode over a Flow: live browser on a canvas, record Steps, add Audits, and author Pre-steps. _Avoid_: Create product, editor (as the product name)

**Audit View**: The execution and inspection mode over a Flow: start a Run, watch it execute, and step through the Run timeline to inspect a Step's actions and Findings. It starts and observes Runs through the Contingency-owned Runner; it does not implement execution ([ADR 0023](./docs/adr/0023-audit-view-starts-runs.md), [ADR 0029](./docs/adr/0029-contingency-owns-the-sole-runner.md)). Watching a live Run and inspecting a finished one through its Trace are distinct: a live Run has no frames to step yet, and stepping back never rewinds browser state or forks the Run. _Avoid_: calling this mode itself "an Audit"

**Audit**: A pluggable check represented as an ordered custom Step in a Flow. Running it produces Findings at that point in the Flow. The v1 check kind is accessibility. Performance is not an Audit: it is a toggle on a navigating Step, measured by the Runner at that navigation ([ADR 0008](./docs/adr/0008-performance-is-a-navigation-step-toggle.md)). _Avoid_: Audit View, axe (that is the implementation), performance audit

**Step**: One ordered unit in a Flow: either a browser action (navigate, click, change, hover, scroll, and so on) or an Audit Step. A Step names its target through an ordered list of alternative locator descriptors and, when a Flow spans Pages, the Page it acts on. A Scroll Step may omit its target only to mean the document itself; an element scroll names that container explicitly. _Avoid_: semantic step, page, checkpoint (as synonyms for Step)

**Pre-step**: A browser-action-shaped Step that may run before a target Step to clear interference such as ads, popups, or cross-sells. Uses an explicit Contingency condition (for example when a selector is visible). Flow Pre-steps run before every Step after the initial navigation; per-Step Pre-steps run only before their target. Pre-steps do not carry Audits or nested Pre-steps. _Avoid_: hook, middleware, guard (as product terms)

**Recording**: The in-progress capture session in Create View that produces or updates a Flow when finished. A Recording follows popups and new tabs as further Pages; losing capture integrity ends it. _Avoid_: Flow, Chrome JSON file (as synonyms for the session)

**Variable**: A named value a Flow or Agent Flow declares but does not contain, supplied when it is executed. Two independent properties: `secret` means the value is redacted from persisted data where redaction is possible; `runtime` means the user may be prompted for it when no value was supplied and the Run is interactive. A 2FA code is both; a target environment URL is neither. _Avoid_: Secret Variable (superseded), environment variable, captured secret, redacted value

**Finding**: One addressable issue produced by an Audit (rule, severity, target, message, and related metadata). Reporting a Finding is separate from failing on one: a Run reports every Finding and fails only where a Gate says so. _Avoid_: report, violation (as the umbrella term), issue blob

**Gate**: The rule ids a Flow declares must produce no Finding. Breaching a Gate makes the CLI exit non-zero without making the Run fail — the site missed the bar, the Run executed fine — so a breaching Run stays eligible as a Baseline. Absolute against a fixed rule list, where a Regression is relative to a Baseline ([ADR 0018](./docs/adr/0018-a-gate-fails-the-exit-code-not-the-run.md)). _Avoid_: threshold, budget, assertion, policy (as the domain term)

**Replay**: Re-executing a Flow's Steps against a live browser. Snapshots are not the replay engine; a Trace records a Replay but never drives one. _Avoid_: restore, snapshot replay (as the execution engine)

**Regression**: A Finding that is new or worsened relative to a chosen baseline run. _Avoid_: failure, flaky (as synonyms for Regression)

**Handoff**: The structured payload Contingency emits so an external agent can attempt a fix (Flow context, Step, Findings / Regressions). Contingency does not apply fixes itself. _Avoid_: agent run, autofix (as Contingency-owned concepts)

**Runner**: The CLI-owned engine that executes Flows into Runs. Audit View and headless invocations use this engine; they do not ship a second player. _Avoid_: player, executor (as product terms)

**Run**: One execution of a Flow that produces Findings (and Regressions when a baseline is in effect). Create View recordings are not Runs; Audit View, headless CLI, and monitoring all produce Runs via the Runner. _Avoid_: session, job (as synonyms for Run)

**Baseline**: The Run a Flow compares against to detect Regressions. Defaults to the previous Run; may be explicitly pinned to a known-good Run. _Avoid_: golden file, snapshot (as synonyms for Baseline)

**Page**: One browser page a Flow acts on, identified by the order it opened. A Flow begins on Page 0 and may open others — a popup or a new tab — which later Steps name explicitly. _Avoid_: tab, target, window (as the domain term)

**Emulation**: The coherent browser device and environment a Flow declares and every Run reproduces. Create View applies it as one configuration before navigation; a mobile identity includes mobile browser signals and behaviour, not only a user-agent string. It covers viewport, browser identity, geolocation, website permission decisions, locale, timezone, and color scheme. Coordinates and permission are independent: a site receives the emulated location only when the Flow grants it access, and observes denial when the Flow denies it. _Avoid_: device profile, override, spoofing

**Trace**: The default per-Run artifact recording each action's before and after state, DOM snapshot, timing, network, and console. It is how a finished Run is inspected, and the source the Run's video is derived from. Unredacted, and therefore sensitive ([ADR 0014](./docs/adr/0014-artifacts-are-run-properties.md)). _Avoid_: log, replay (as a synonym for Trace), recording (as a synonym for the video)

**Alert**: A delivered notification about one or more Regressions (channel plus payload), typically emitted from a Run. Distinct from detecting a Regression and from emitting a Handoff. Scheduling when Runs happen (cron, CI) lives outside Contingency — there is no Monitor entity. _Avoid_: monitor, schedule, subscription (as Contingency domain objects)
