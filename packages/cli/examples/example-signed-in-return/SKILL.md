---
name: example-signed-in-return
description: Example. Sign in to the Ridgeline Hardware demo account with a private password, start a return for one order, and confirm the return names that order. Use to show a private input supplied in Workspace.
inputs:
  - name: order
    description: A demo order number from Your orders, such as RH-1042.
  - name: reason
    description: A return reason from the store's list, such as Wrong item.
  - name: DEMO_PASSWORD
    description: Private. Any password of at least 8 characters for the demo account. The user supplies it in Workspace.
hosts:
  - ridgeline.localhost
emulation:
  userAgentProfile: default
  viewport: 1280x800@1
---

# Start a signed-in return

This is a bundled Example Flow Skill for the Ridgeline Hardware demo store. It is read-only, it is not user-verified, and its authority ends at the demo store. Targets are listed in [references/accessibility.md](references/accessibility.md).

DEMO_PASSWORD is private. Request it with agent_run_variable_request, ask the user to supply it in Workspace, then type it with agent_variable_enter. Never ask for its value in the conversation.

1. Open the store's Sign in page, where the Run starts.

   Done when: the page shows the "Sign in" heading with Email and Password fields.

2. Enter demo@ridgeline.test in Email and {{DEMO_PASSWORD}} in Password, then select "Sign in".

   Done when: the "Your orders" page lists orders RH-1042, RH-1057, and RH-1063.

3. Select "Start a return for {{order}}".

   Done when: the page heading reads "Return order {{order}}".

4. Choose {{reason}} in "Return reason", then select "Submit return". Submitting starts a return, so mark the action irreversible and obtain the user's Confirmation first.

   Done when: the "Return started" section names order {{order}} and the reason {{reason}}.
