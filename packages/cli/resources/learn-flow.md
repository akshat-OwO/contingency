# Learn flow

Learn one Contingency Teaching Recording and write its Flow Skill.

1. Read contingency://reference/writing from this server for technical writing, natural prose, and agent instructions.

2. Claim the recording with agent_teaching_recording_claim, action "take".

3. Page the semantic timeline with agent_teaching_timeline_get until nextCursor is null. Fetch a keyframe with agent_teaching_keyframe_get only when the timeline is not enough.

   - Navigation observations and keyframes marked capture:transitional do not prove that the destination rendered.
   - Each keyframe URL describes its own capture instant.
   - Missing capture metadata is not proof of readiness.
   - Use later evidence to establish destination content, and give the Flow Skill an observable completion condition beyond the URL.

4. Write SKILL.md: YAML frontmatter with name equal to the Flow Skill name, a description that states the task and its trigger, and an inputs list naming every value a later run may change.

   Declare each input either as a bare name (`- sku`) or as a mapping that opens with `- name: sku` and carries an indented `description:` line saying what the value is. Use {{placeholder}} for each declared input and end every numbered step with a "Done when:" line.

   - Declare Variables needed later in the journey, including OTPs, under inputs before starting the Dry Run.
   - Their names are known at startup; their values can be supplied when needed.
   - Preserve required setup in a Preconditions section before the numbered steps: state the observable prepared state and, for each user-requested verified setup skill, its exact name and required inputs.
   - Keep setup actions outside the recorded procedure.
   - A Dry Run's prerequisites are execution settings; they are not automatically added to the saved skill.
   - Ask the user to authorize a named setup skill when it is needed in a later Run.

5. Put conditional target detail in references/accessibility.md, as `- role=<role> name="<name>" context="<context>"` entries, plus a "Why these targets are stable" heading. Link every reference file from SKILL.md.

   Browser Checks and Guided Run proposals:

   - For a Guided Run, dialogue.proposal is unconfirmed intent, never a requirement.
   - Copy checks only from confirmed answer Instructions carrying scan or attachments; rejected and unanswered proposals contribute no checks.
   - When Teaching instructions carry attachments, copy every attachment.requirement exactly into references/browser-checks.json as {"schemaVersion":1,"requirements":[...]}, keeping its ID, storage format, types, predicates, request pattern, timing, timeout, and demonstrated flag.
   - Context attachments have no requirement and do not constrain Runs.
   - Link the file and check IDs at the triggering procedure points.
   - Browser Checks survive Recording Cleanup.
   - Use agent_browser_act checkIds:[{flowSkillName,id}] with the triggering action, or agent_browser_snapshot checkIds for current-state storage checks.
   - Each grouped itemPath wildcard selects one unordered item satisfying every predicate; numeric path segments select explicit indices.
   - Storage paths require format "json".
   - Keep Not demonstrated expectations for the fresh Dry Run.
   - Every required check must pass before working or verification.
   - After a failed or inconclusive check, stop dependent actions, retain its evidence, and investigate without repeating the click.
   - Private expectations use declared Variable references.

   Scan Requirements:

   - When instructions carry scan settings, preserve each start ID and mode in references/scans.json: {"schemaVersion":1,"requirements":[{"id":"<taught-id>","mode":"accessibility|reload|navigation|timespan","when":"<observable journey condition>","endWhen":"<timespan stop condition>","expectedUrl":"<navigation destination>"}]}.
   - Only timespans have endWhen; navigation requires expectedUrl.
   - Infer conditions from ordered comments, targets, and recording evidence, and ask for clarification if ambiguous.
   - Link the file and IDs at the relevant procedure points.
   - An unmatched timespan may remain a draft without endWhen, but must be repaired before a Dry Run.
   - During Runs use agent_run_scan start/stop for these required scans, and inspect scan coverage before completion.

   Browser Modification state:

   - Guided Run browser-modification events are required state.
   - Preserve their order, journey outcomes, and removals in the procedure.
   - Active setup state is anchored at Start.
   - Saving stamps references/browser-state.json and its link from the recording.
   - Apply these commands at their named outcomes in the Dry Run, with fresh operation IDs and current removal IDs.
   - A failed or omitted saved command prevents a pass.
   - The Dry Run may also make agent-initiated modifications; these are flagged beside the Assessment and do not cap it.

   Pursuits:

   - Mark Pursuits as Delegated in the learned procedure with the sub-goal, Done when condition, and recorded ending.
   - A later agent may perform that work itself when System One is unavailable.

6. Save with agent_flow_skill_save. A refusal returns one diagnostic per broken property; fix those exact paths and save again.

7. Ask for ordinary inputs again and change at least one demonstrated input when the task permits it. Start a fresh-context Dry Run with agent_flow_skill_dry_run_start.

   For an on-demand input omit its value; ask the user to supply it in the returned Workspace, then use its uppercase Variable name with agent_variable_enter. Follow the saved skill outcome under its Teaching hosts and Emulation; you may explore, recover, or choose another route.

   - Request a declared on-demand Variable of the tested skill when needed with agent_variable_request, using its uppercase Variable name.
   - The existing Dry Run Variables field in Workspace accepts the value; this request returns no Pending Decision.
   - Set replace:true to invalidate a previous value and reopen that field without restarting the browser.
   - A new input declaration requires revising the package and starting a fresh Dry Run.

   - If setup requires user-requested verified Flow Skills, pass their names in prerequisites and all their ordinary inputs in prerequisiteInputs, scoped by flowSkillName and name.
   - This set is fixed at startup; changes require a fresh Dry Run.
   - The start result includes their procedures.
   - Request prerequisite on-demand inputs on demand with agent_variable_request, have the user supply or refuse them in Workspace, and enter them with agent_variable_enter using their declaring flowSkillName.
   - Set replace:true to request a fresh value for a retry.
   - Prerequisites share the tested skill's fresh context, Teaching hosts, and Emulation; they do not replace its complete outcome or widen Domain Scope.

8. Report your model judgment of the complete skill outcome with agent_run_assess: outcome, explanation, evidence as Snapshot or attempt references produced by this Dry Run, and outcomeComplete explicitly true or false. Findings and assessments leave the browser open.

   A partial attempt or any user Takeover cannot pass. When finished, call agent_run_complete to seal the report, close the browser, and persist the Dry Run result.

   Completion is required for a passing report too.

9. A failed report keeps the Teaching Recording and this claim. Fix the package and call agent_flow_skill_save with the same claim operation id, then start another Dry Run.

10. After a pass, show the result and link the Workspace. The user may verify or reject there, or tell you.

    Wait with agent_session_get, afterCursor:eventCursor, waitMs:45000 for the Workspace event. Relay a conversation choice with agent_flow_skill_decide.

    A pass retains the Teaching Recording until explicit verification.
