### Demo onboarding

This session runs guided onboarding on the bundled demo store. Follow the Start steps above, then this procedure.

#### Establish the task

1. Check the Catalog Root from `agent_catalog_get` against the launch context. Select the expected root if needed. Mention it only when it differs from what the user expects or is a fallback.
2. Ask the user to keep Workspace open to watch the Example and Teaching. Each Example, Teaching session, and Dry Run then gets its own `viewUrl` link.
3. If the catalog has work, offer relevant unfinished work, saved flows, another example, or new Teaching. A catalog containing only `demo: ridgeline` work is not empty.
4. For an empty catalog, read `contingency://onboarding/examples`. Introduce Ridgeline Hardware and recommend delivery-and-cart; offer signed-in returns, scans, and a deliberately broken cart as alternatives. Explain each task and its observable result before asking the user to choose.

Explain that the user can watch a prepared journey, teach a variation, and verify it after a test, all on the demo store. For existing work, follow the appropriate guide; for demo work, read the examples resource for the current origin.

Permanent registrations use the current project's `contingency` catalog, created when work is first saved. When no usable current project directory exists, Contingency uses the original onboarding directory. If `agent_catalog_get` reports a `fallback`, name that directory before using the catalog.

#### Show and teach

1. Explain the chosen example's intended result and invite the user to watch. Start it with `agent_example_run_start` and its sample inputs. Identify it as a bundled Example limited to the demo store.
2. Carry out the Example in the session it returned; do not call `agent_run_start`. Use the Run guide for System One and evidence only.
   - For a private input, call `agent_variable_request` and have the user supply it in Workspace, not this conversation. Type it with `agent_variable_enter`.
   - For a required scan, start it with `agent_run_scan` when the taught condition is reached, and cite its Scan Report.
   - Mark an irreversible action as irreversible. Relay the boundary Pending Decision as getting-started describes.
   - For broken cart, identify the fault as a demo condition, prove failure from the cart rather than the banner, and restore the healthy store.
   - Report the result with `agent_run_assess`, then call `agent_run_complete`.
3. Explain the result and ask the user to choose a variation. The prepared Run is a demonstration, not their Teaching Recording.
4. Establish the starting page, journey, and observable result. Use the current demo origin for an example; for a broad website request, help choose a small journey. Ask about device or environment settings when relevant.
5. Follow `contingency://docs/teach` to prepare and record the variation. For a signed-in return, leave Sign in ready with an empty password and include sign-in in the recording so the fresh Dry Run can sign in.

For that sign-in, tell the user to enter demo@ridgeline.test, click the store's Password field, and use **Demo password** and **Enter demo password** in Workspace. This records DEMO_PASSWORD privately. Sign-in performed only during setup is outside the learned journey.

#### Learn, test, and verify

1. Read `contingency://prompt/learn-flow` and follow it to save the variation in the current catalog. For demo work, prefix the description with "Demo:" and declare the ordinary input `demo_origin` for store URLs as the examples resource describes.
2. Start the first Dry Run automatically and tell the user it tests the draft in a fresh browser context. Change a demonstrated input when the journey permits it. Follow the guide through the persisted result.
3. If recording evidence shows that the instructions caused a failure, repair and save the flow, then retry in a fresh Dry Run. If the website is broken, report evidence and ask before changing application code. Keep the Teaching Recording until verification.
4. After a passing Dry Run, show the result and ask for explicit verification or rejection in Workspace or the conversation. A passing Run alone is not user verification. Follow the learn flow to persist the user's choice.

#### Registration and next steps

After verification, offer session-only use, permanent project registration, or permanent user registration. For registration, run the launch context's command with `--scope project` or `--scope user`. Registered sessions omit the demo store, so demo Flows require `contingency start --demo`.

The command keeps an equivalent registration. If it reports a different registration, show the differences and ask whether to keep or replace it; use `--replace` only after the user chooses replacement. If another scope takes precedence, tell the user which registration their sessions will use.

Offer another example, a similar journey on the user's website, or an applicable failure rerun. A demo Flow belongs to the demo store; a real website needs its own Teaching.

Offer the failure rerun only if the deliberate cart fault affects the newly verified flow's journey. Follow `contingency://onboarding/examples` to run it interactively, report evidence, and restore the healthy store. Explain that detecting the fault shows the flow working as a check and does not undo verification or onboarding.

#### Optional Claude Code channels

After registration, Claude Code users can opt in to idle-agent wakeups by setting `CONTINGENCY_MCP_CHANNEL=true` on Contingency's stdio MCP registration. Channels are a research preview and require session opt-in and preview allowlisting.

For local development, start Claude with `--dangerously-load-development-channels server:contingency` and accept Claude's prompt; organization policy must allow channels too. This launch does not add those flags automatically. On a channel event, read `agent_session_get` with `meta.sessionId` and `afterCursor: meta.eventCursor`; otherwise use the Session Event wait path.

See the CLI README for setup details.
