# Capabilities

This topic describes what Contingency can do and where each capability stops. Every limit below is a refusal or a pause, never a silent fallback.

## Platform Runtimes and the Support Matrix

A Platform Runtime is the environment an Agent Session uses for Teaching and Runs. Contingency supports two:

- **Browser.** Contingency drives its own pinned Chromium build through Playwright. The first Agent Session downloads it.
- **Android.** Contingency drives one emulator or physical device through `adb`. Android is supported only within its Support Matrix: API levels 30 through 36, proven on API 30 and 36 emulators and one API 36 phone.

What it can't do:

- Run in Firefox, WebKit, or a browser you already have open. Runs are Chromium only.
- Operate Android below API 30. Selection refuses the device before any device command.
- Bind more than one Android device to one live session.
- Act on raw screen coordinates on Android. Every action targets a semantic element.
- Act on system dialogs, secure windows, or other apps on Android. A Run pauses when one takes the foreground.
- Set Android permission decisions below API 31.

## Teaching

In Teaching, you perform a journey in the Workspace while Contingency records it. The agent may prepare the browser during setup, then hands control to you before **Start recording**. During recording, the agent only observes. You can relay Instructions, such as why to skip an optional popup, and attach a request, response, cookie, or storage value to an Instruction. Teaching produces a Teaching Recording. The agent then learns a Flow Skill from it.

What it can't do:

- Share control during recording. The user drives the browser from Start to Stop, and Takeover is not available.
- Capture anything before **Start recording** or after **Stop**.
- Keep the recording. Verifying the learned Flow Skill deletes its video, Trace, events, and keyframes.
- Hide sensitive data completely. Videos and Traces are unredacted. Contingency scrubs known secret values where it can, but the scrub is best effort.

## Guided Run

The external agent can follow your Source Document in a browser with `agent_guided_run_start`, producing a Teaching Recording for one named Flow Skill. For a document containing several journeys, the agent proposes a split and you pick one before starting. Start one Guided Run per Flow Skill. Only the external agent reads the document. Contingency neither receives, parses, stores, nor links it, and a saved Flow Skill has no `source:` frontmatter.

Setup works like Teaching, including Setup Variables. The agent prepares prerequisites, then calls `agent_teaching_setup_handoff`. You can finish setup in Workspace and press **Start recording**. Setup actions stay outside the evidence. Start returns browser control to the agent, and its existing action tools record actor-marked actions. Workspace labels the session **Guided Run**. Stop in Workspace, or close the session, to finalize a partial or complete recording with its stop reason. Capture limits and failures also finalize it. Claim and learn the recording, save the Flow Skill, and perform the mandatory fresh Dry Run before user verification and Cleanup.

During capture, you can click **Take control**, or the agent can request Takeover. Only you return control with **Return control**. Capture continues with `actor: "user"` actions. Use the private Variable input to enter secrets, which appear as `{{name}}` references with their declarations. Agent action tools are disabled during Takeover. A dispatched action may already have happened; `interruptedAction` discloses that attempt. Your Takeover actions and answers outrank the agent's reading of the Source Document wherever they disagree. A question stays open if you Takeover instead of answering. A later fresh Dry Run can pass even though the Guided Run had a Takeover.

During capture, the agent asks through `agent_guided_run_question_ask`. The **Guided Run questions** region keeps the question visible until you answer with **Send answer**, then reads back the pair. You can also answer in the agent conversation. The agent relays your words through `agent_teaching_instruction_record` with the question's `questionId`. A fresh second answer is refused. Replaying the same operation returns the first result.

The Teaching Timeline keeps both Instructions in capture order. Each carries an `id` and `actor`; `dialogue._tag` identifies a question or answer, and an answer's `dialogue.questionId` links it to the question. A user answer has `actor: "user"`; an answer relayed by the agent has `actor: "agent"`. Older Instructions omit this metadata and remain user Instructions. A question with no linked answer remains unanswered evidence after Stop. `agent_session_get` with `afterCursor` waits for `question-answered`; its `name` is the question id. Up to 50 questions are retained per recording.

The agent proposes a document check through the question tool's `proposal`, naming the outcome in `text` and giving a short `reason`. Review its scan mode or typed Browser Check in Workspace, then choose **Confirm check** or **Reject check**. The agent can relay your explicit choice with `agent_teaching_instruction_record`, `questionId`, and `decision: "confirm"` or `"reject"`. Confirmation creates the same scan or Browser Attachment requirement as Teaching. Rejected and unanswered proposals create no requirement. After Stop, pending proposals read **Unconfirmed when recording stopped**. The learned Flow Skill preserves only confirmed checks; a later Run tracks their scan and Browser Check results. Confirmation does not establish that a Browser Check was observed. Unobserved expectations stay Not demonstrated.

Domain Scope starts at the starting host. A new top-level host pauses for **Allow** or **Refuse** in Workspace, or a user decision relayed over MCP. Allow admits that exact host; the agent resumes the stored attempt with `agent_browser_resume`. The finalized recording retains the starting host and approved hosts, which Contingency stamps into the saved Flow Skill for its Dry Run. Embedded subframes do not grow this scope. Irreversible actions still require separate Confirmation.

Current limits:

- MCP starts Guided Runs; Workspace cannot start one. Android is refused.
- Browser Modifications and System One Pursuits are refused, including during setup.

## Dry Run

A Dry Run proves a drafted Flow Skill. The agent attempts the skill's complete outcome in a fresh browser context, under the Emulation it was taught with, with fresh inputs. The agent chooses its own route and reports an evidence-backed Agent Assessment. After a passing Dry Run, you verify or reject the Flow Skill in the Workspace or in the conversation.

What it can't do:

- Pass after a partial attempt or after any Takeover.
- Visit a host outside its stamped Domain Scope without a Pending Decision.
- Make a Browser Modification, such as a mocked route or an injected cookie.
- Change its prerequisites or ordinary inputs after it starts. Start a fresh Dry Run.
- Verify the Flow Skill itself. Only the user verifies.

## Interactive Run

An Interactive Run is an agent-controlled attempt at a task you ask for in a live MCP conversation. It can use several Verified Flow Skills in one browser context. You can redirect the task, and you can take over the browser in the Workspace. A failure leaves the browser open for investigation until the agent completes the Run, you close it, or the process exits.

What it can't do:

- Use a Flow Skill that is not verified, except a bundled Example on the demo store.
- Run on a schedule. Use CI or cron to invoke an agent connected to Contingency.
- Act while you hold control in a Takeover.
- End on a wall-clock limit. A Run ends only when the agent completes it, you close it, or the process exits.

## Scan Requirements

A Scan Requirement is a performance or accessibility scan you ask for during Teaching, at a named point in the journey. A later Run performs it when the agent reaches that point, and Contingency tracks whether it happened. The modes are:

- `accessibility`: one axe-core accessibility evaluation of the page as it is.
- `reload`: a Lighthouse performance report of a page reload.
- `navigation`: a Lighthouse report of a navigation to an expected URL. The agent starts and stops it.
- `timespan`: a Lighthouse report of an interaction span. The agent starts and stops it.

What it can't do:

- Monitor accessibility continuously. An accessibility scan is one point in time.
- Run more than one scan at once in one Run or tab. A failed scan retries automatically once; a further retry needs a newer user instruction.
- Skip a scan in a Dry Run. Only an Interactive Run on an explicitly partial journey can mark a scan out of scope.
- Count a partial Scan Report as fulfilling its requirement.

## Browser Checks

A Browser Check is a saved requirement about a network response or a storage value, with typed predicates, timing, and a deadline. You create one during Teaching by attaching browser evidence to an Instruction and choosing **Must happen**. A later Run evaluates the check at the action that triggers it.

What it can't do:

- Pass a Run as `working`, or a Dry Run, while a required check is missing, failed, inconclusive, or interrupted.
- Read more than 64 KiB of one response body or one JSON storage value. A larger value makes the check inconclusive.
- Infer a requirement from a comment. Only an attachment marked **Must happen** becomes a check.

## Emulation

Emulation is the browser device and environment one session runs under: viewport, browser identity, geolocation, website permission decisions, locale, timezone, color scheme, page zoom, and text scale. Teaching records it, and the Dry Run and later Runs reopen the browser under it, so a journey taught on a phone runs as a phone.

What it can't do:

- Change Emulation in the middle of a Dry Run. In an Interactive Run, a change to zoom or text scale is a recorded Browser Modification.
- Give a site the emulated location without permission. The site gets coordinates only when the session grants it access.
- Answer a permission prompt with `prompt`. A permission decision is `granted` or `denied`.

## Execution Boundary

The Execution Boundary limits what an agent may do in an Interactive Run, a Guided Run, or a Dry Run:

- **Domain Scope.** The agent may navigate only to the hosts in scope without pausing. A Dry Run's scope is its saved Flow Skill's stamped hosts. A Guided Run starts at its starting host and adds exact hosts you approve. An Interactive Run's scope is the hosts of the Flow Skills you asked for, or the starting host.
- **Confirmation.** An irreversible or high-impact browser action, such as placing an order, pauses for your approval every time.

A pause appears as a Pending Decision. You allow or refuse it in the Workspace or in the conversation. One approval permits one exact action attempt.

What it can't do:

- Let the agent visit a host outside Domain Scope without your approval.
- Reuse an approval for a retry. Each attempt needs fresh Confirmation.
- Govern embedded frames. Domain Scope applies to top-level navigation only.
- Require the agent to repeat the demonstrated clicks. The agent owns its plan inside the boundary.
