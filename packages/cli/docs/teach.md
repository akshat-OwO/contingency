# Teach a journey

Prepare a Teaching session for the user to demonstrate a journey.

## Prepare and hand off

1. Agree on the starting URL and observable result. Start Teaching with `agent_session_start` and share its Workspace link.
2. Prepare the page and prerequisites. For private inputs, call `agent_variable_request`, ask the user to supply the value in Workspace, and enter it with `agent_variable_enter`.
3. Call `agent_teaching_setup_handoff`. Ask the user to choose **Start recording**, perform the journey, and choose **Stop**.
4. Explain that **Comment** adds Instructions. Observe and wait until the Teaching Recording is ready, then read `contingency://prompt/learn-flow`.

## Setup permissions

Teaching setup allows Emulation and cookie and storage writes. Routes, headers, and mutating evaluation are not allowed. During recording, the user drives and the agent observes.
